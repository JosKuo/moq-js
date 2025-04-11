import * as Message from "./worker/message"

import { Connection } from "../transport/connection"
import * as Catalog from "../media/catalog"
import { asError } from "../common/error"

import Backend from "./backend"

import { Client } from "../transport/client"
import { SubgroupReader } from "../transport/objects"

export type Range = Message.Range
export type Timeline = Message.Timeline

export interface PlayerConfig {
	url: string
	namespace: string
	fingerprint?: string // URL to fetch TLS certificate fingerprint
	canvas: HTMLCanvasElement
}

// This class must be created on the main thread due to AudioContext.
export default class Player extends EventTarget {
	#backend: Backend

	// A periodically updated timeline
	//#timeline = new Watch<Timeline | undefined>(undefined)

	#connection: Connection
	#catalog: Catalog.Root
	#tracksByName: Map<string, Catalog.Track>
	#tracknum: number
	#audioTrackName: string
	#videoTrackName: string
	#muted: boolean
	#paused: boolean
	#liveStartTime: number = Date.now()

	//Latency settings
	#latencyTimer: number = 10000
	#testLatency : boolean = true
	#latencyDone: boolean = false
	
	//Probing settings
	#useProbing: boolean = false
    #probeInterval: number = 10000 //How often probe is run
    #probeSize: number = 1250000
    #probePriority: number = 254 
    #probeTimer: number = 3000 //loop controller that triggers runProbe on a regular schedule
    #probeTestResults: any[] = [] //Test result to download
	#latencyTestResults: any[] = [] //Test result to download
	#iterations_per_round = 5

	/*#useProbeTestData = true //Used for testing. 
    #probeTestData = {
        start:  1250000, //start probing at 10000 bytes
        stop: 125000, //stop probing att 300000 bytes
        increment: 0,
        iteration: 3, //Try each probesize 3 times. 
        lastIteration: 0 //Counter to track how many total probes have been run
    }*/

	// Running is a promise that resolves when the player is closed.
	// #close is called with no error, while #abort is called with an error.
	#running: Promise<void>
	#close!: () => void
	#abort!: (err: Error) => void
	#trackTasks: Map<string, Promise<void>> = new Map()
	#bitrates: Map<Catalog.Track, number | undefined>

	private constructor(connection: Connection, catalog: Catalog.Root, tracknum: number, canvas: OffscreenCanvas) {
		super()
		this.#connection = connection
		this.#catalog = catalog
		this.#tracksByName = new Map(catalog.tracks.map((track) => [track.name, track]))
		this.#bitrates = new Map(catalog.tracks.map((track) => [track, track.selectionParams.bitrate]))
		this.#tracknum = tracknum
		this.#audioTrackName = ""
		this.#videoTrackName = ""
		this.#muted = false
		this.#paused = false
		this.#backend = new Backend({ canvas, catalog }, this)
		
		 // Listen for latency events from the Backend
		 if(this.#latencyDone == false && this.#testLatency == true){
			this.addEventListener("latency", ((event: Event) => {
				const customEvent = event as CustomEvent;
				if(performance.now() < this.#latencyTimer && this.#latencyDone == false){
					this.#latencyTestResults.push(customEvent.detail);
					console.log(this.#latencyTestResults)
					
				}
				else if(performance.now() >= this.#latencyTimer && this.#latencyDone == false){
					this.#latencyDone = true,
					console.log(`Done with latency test after ${this.#latencyTimer/1000}s, download the results`)
					this.downloadLatencyStats()
				}
			}) as EventListener);
	}

		super.dispatchEvent(new CustomEvent("catalogupdated", { detail: catalog }))
		super.dispatchEvent(new CustomEvent("loadedmetadata", { detail: catalog }))

		const abort = new Promise<void>((resolve, reject) => {
			this.#close = resolve
			this.#abort = reject
		})

		// Async work
		this.#running = abort.catch(this.#close)

		this.#run().catch((err) => {
			console.error("Error in #run():", err)
			super.dispatchEvent(new CustomEvent("error", { detail: err }))
			this.#abort(err)
			
		})
		
		console.log("currentTrack: ", this.getCurrentTrack())
		if(this.#useProbing == true){
			this.parseProbeParametersAndRun()
		}

	}

	static async create(config: PlayerConfig, tracknum: number): Promise<Player> {
		const client = new Client({ url: config.url, fingerprint: config.fingerprint, role: "subscriber" })
		const connection = await client.connect()

		const catalog = await Catalog.fetch(connection, [config.namespace])
		console.log("catalog", catalog)

		const canvas = config.canvas.transferControlToOffscreen()

		return new Player(connection, catalog, tracknum, canvas)
	}

	async #run() {
		// Key is "/" serialized namespace for lookup ease
		// Value is Track.initTrack. @todo: type this properly
		const inits = new Set<[string, string]>()
		const tracks = new Array<Catalog.Track>()

		this.#catalog.tracks.forEach((track, index) => {

			if (index == this.#tracknum || Catalog.isAudioTrack(track)) {
				if (!track.namespace) throw new Error("track has no namespace")
				if (track.initTrack) inits.add([track.namespace.join("/"), track.initTrack])
				tracks.push(track)
			}
		})

		// Call #runInit on each unique init track
		// TODO do this in parallel with #runTrack to remove a round trip
		await Promise.all(Array.from(inits).map((init) => this.#runInit(...init)))

		// Call #runTrack on each track
		tracks.forEach((track) => {
			this.#runTrack(track)
		})
		this.#startEmittingTimeUpdate()
	}

	async #runInit(namespace: string, name: string) {

		const sub = await this.#connection.subscribe([namespace], name)

		try {
			const init = await Promise.race([sub.data(), this.#running])
			if (!init) throw new Error("no init data")

			// We don't care what type of reader we get, we just want the payload.
			const chunk = await init.read()
			if (!chunk) throw new Error("no init chunk")
			if (!(chunk.payload instanceof Uint8Array)) throw new Error("invalid init chunk")

			this.#backend.init({ data: chunk.payload, name })
		} finally {
			await sub.close()
		}
	}

	//PROBE THINGS
	
	getFromQueryString(key: string, defaultValue: string = ""): string {
        const re = new RegExp("[?&]" + key + "=([^&]+)")
        const m = re.exec(location.search)
        console.log("playback | getFromQueryString", re, m)
        if (m && m[1]) {
            return m[1]
        }
        return defaultValue
    }

	parseProbeParametersAndRun() {

		clearInterval(this.#probeTimer)
		this.#probeTimer = setInterval(this.runProbe, this.#probeInterval)
		console.log("playback | parseProbeParameters | probeSize: %d probePriority: %d probeInterval: %d", this.#probeSize, this.#probePriority, this.#probeInterval)

    }

	downloadProbeStats = () => {
        const link = document.createElement("a")
        document.body.appendChild(link)

        // download logs
        if (this.#probeTestResults.length > 0) {
            const headers = ["duration", "size", "bandwidth"]
            const csvContent = "data:application/vnd.ms-excel;charset=utf-8," + headers.join("\t") + "\n" + this.#probeTestResults.map((e) => Object.values(e).join("\t")).join("\n")
            const encodedUri = encodeURI(csvContent)
            link.setAttribute("href", encodedUri)
            link.setAttribute("download", "logs_" + Date.now() + ".xls")
            link.click()
        } else {
            console.warn("playback | downloadProbeStats | no logs")
        }

        link.remove()
    }

	downloadLatencyStats = () => {
        const link = document.createElement("a")
        document.body.appendChild(link)

        // download logs
        if (this.#latencyTestResults.length > 0) {
            const headers = ["NTP", "Latency"]
            const csvContent = "data:application/vnd.ms-excel;charset=utf-8," + headers.join("\t") + "\n" + this.#latencyTestResults.map((e) => e.join("\t")).join("\n"); // Properly format the list of lists

            const encodedUri = encodeURI(csvContent)
            link.setAttribute("href", encodedUri)
            link.setAttribute("download", "logs_" + Date.now() + ".xls")
            link.click()
        } else {
            console.warn("playback | downloadLatencyStats | no logs")
        }

        link.remove()
    }
	
	runProbe = async () => { //?probeSize=40000&probePriority=0&probeInterval=3000
		console.log("playback | runProbe")
		
		let bitrates : number[] = [4000000, 5000000, 6000000] //bps
		let bw_results: number[] = []
		/*if (this.#useProbeTestData && this.#probeTestData) {
			console.log("using probe test data")
			const totalProbeSizes = (this.#probeTestData.stop - this.#probeTestData.start) / this.#probeTestData.increment + 1
			totalIteration = totalProbeSizes * this.#probeTestData.iteration
			console.log("playback | probe | totalIteration", totalIteration)
			this.#probeSize = this.#probeTestData.start + Math.floor(this.#probeTestData.lastIteration / this.#probeTestData.iteration) * this.#probeTestData.increment
			++this.#probeTestData.lastIteration
		}*/
		for(this.#iterations_per_round; this.#iterations_per_round >0; --this.#iterations_per_round) {
			let sub: any
			try {
				const start = performance.now()
				const probeTrackName = ".probe:" + this.#probeSize*this.#probeTimer + ":" + this.#probePriority
				sub = await this.#connection.subscribe(["bbb"], probeTrackName)
		
				console.log("playback | probe sub", sub, probeTrackName)
				
				const result = await Promise.race([
					sub.data(),
					new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for probe data")), 3000))
				])
			
				let totalBufferSize = 0
		
				while (true) {

					const chunk = await result.read()

					if (!chunk) break
		
					// Skip status messages
					if (typeof chunk.payload === "number") continue
					totalBufferSize += chunk.payload.byteLength
				} 

				const end = performance.now()
				const duration = end - start
				const measuredBandwidth = (totalBufferSize * 8) / (duration / 1000) //bps
				
				console.log("playback | probe done | duration:", duration, "bytes:", totalBufferSize, "bandwidth:", measuredBandwidth.toFixed(2), "tc_bw:")
		
				this.dispatchEvent(new CustomEvent("stat", {
					detail: { type: "measuredBandwidth", value: measuredBandwidth }
				}))
				bw_results.push(measuredBandwidth)
				this.#probeTestResults.push([duration, totalBufferSize, measuredBandwidth.toFixed(2)])
		
			} catch (e) {
				console.error("playback | probe error", e)
			} finally {
				console.log("playback | probe closed")
				if (sub) await sub.close()
			}
		
			/*if (this.#useProbeTestData && this.#probeTestData.lastIteration === totalIteration) {
				this.downloadProbeStats()
				this.#probeTestData.lastIteration = 0
				clearInterval(this.#probeTimer)
			}*/
		}
		const average_bw = bw_results.length > 0 
			? bw_results.reduce((acc, e) => acc + e, 0) / bw_results.length 
			: 0; // Default to 0 if no results

		if (bw_results.length === 0) {
			console.warn("playback | runProbe | No bandwidth measurements were collected.");
		}

		const currentTrack = this.getCurrentTrack();
		console.log("playback | average_bw", average_bw);
		
		if (currentTrack && currentTrack.selectionParams?.bitrate) {
			const currentBitrate = currentTrack.selectionParams.bitrate; // in Mbps
			const nextTrack = this.#catalog.tracks
				.filter((track) => track.selectionParams?.bitrate && track.selectionParams.bitrate > currentBitrate)
				.sort((a, b) => (a.selectionParams.bitrate ?? 0) - (b.selectionParams.bitrate ?? 0))[0];
			
			
			if (nextTrack) {
				console.log(`Switching to higher bitrate track: ${nextTrack.name}`);
				//this.switchTrack(nextTrack.name);
			} else {
				console.log("No higher bitrate track available within the measured bandwidth.");
			}
			const nextBitrate = nextTrack.selectionParams.bitrate; // in Mbps
			const probeSize = (nextBitrate ?? 0 - currentBitrate) * 1_000_000 / 8; // in bytes
			this.#probeSize = probeSize; // Update probe size
		}
		
	}

	async #trackTask(track: Catalog.Track) {
		if (!track.namespace) throw new Error("track has no namespace")

		if (this.#paused) return

		const kind = Catalog.isVideoTrack(track) ? "video" : Catalog.isAudioTrack(track) ? "audio" : "unknown"
		if (kind == "audio" && this.#muted) return

		if (kind == "audio") {
			// Save ref to last audio track we subscribed to for unmuting
			this.#audioTrackName = track.name
		}
		if (kind == "video") {
			this.#videoTrackName = track.name
		}

		let eventOfFirstSegmentSent = false
		
		/*This is where the fetch happens atm. 
			Make this a separate function and call it from the #runTrack function?.
		
		const subprobe = this.#connection.fetch(track.namespace, track.name)*/
		console.log("TRYING TO SUBSCRIBE TO: ", track.name)
		const sub = await this.#connection.subscribe(track.namespace, track.name)
		try {
			for (;;) {
				const segment = await Promise.race([sub.data(), this.#running])
				if (!segment) continue

				if (!(segment instanceof SubgroupReader)) {
					throw new Error(`expected group reader for segment: ${track.name}`)
				}

				if (kind == "unknown") {
					throw new Error(`unknown track kind: ${track.name}`)
				}

				if (!track.initTrack) {
					throw new Error(`no init track for segment: ${track.name}`)
				}

				if (!eventOfFirstSegmentSent && kind == "video") {
					super.dispatchEvent(new Event("loadeddata"))
					eventOfFirstSegmentSent = true
				}

				console.log(`Data received for track: ${track.name}`); // Log incoming data

				const [buffer, stream] = segment.stream.release()

				this.#backend.segment({
					init: track.initTrack,
					kind,
					header: segment.header,
					buffer,
					stream,
				})
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("cancelled")) {
				console.log("Cancelled subscription to track: ", track.name)
			} else {
				console.error("Error in #runTrack:", error)
				super.dispatchEvent(new CustomEvent("error", { detail: error }))
			}
		} finally {
			await sub.close()
		}
	}
	#runTrack(track: Catalog.Track) {
		if (this.#trackTasks.has(track.name)) {
			console.warn(`Already exist a runTrack task for the track: ${track.name}`)
			return
		}
		const task = (async () => this.#trackTask(track))()

		this.#trackTasks.set(track.name, task)
		
		
		task.catch((err) => {
			console.error(`Error to subscribe to track ${track.name}`, err)
			super.dispatchEvent(new CustomEvent("error", { detail: err }))
		}).finally(() => {
			this.#trackTasks.delete(track.name)
		})

	}

	#startEmittingTimeUpdate() {
		setInterval(() => {
			this.dispatchEvent(new Event("timeupdate"))
		}, 1000) // Emit timeupdate every second
	}

	getCatalog() {
		return this.#catalog
	}

	getCurrentTrack() {
		if (this.#tracknum >= 0 && this.#tracknum < this.#catalog.tracks.length) {
			return this.#catalog.tracks[this.#tracknum]
		} else {
			console.warn("Invalid track number:", this.#tracknum)
			return null
		}
	}

	getVideoTracks() {
		return this.#catalog.tracks.filter(Catalog.isVideoTrack).map((track) => track.name)
	}

	getAudioTracks() {
		return this.#catalog.tracks.filter(Catalog.isAudioTrack).map((track) => track.name)
	}

	getCurrentTime() {
		return (Date.now() - this.#liveStartTime) / 1000
	}

	isPaused() {
		return this.#paused
	}

	get muted(): boolean {
		return this.#muted
	}

	get videoTrackName(): string {
		return this.#videoTrackName
	}

	async switchTrack(trackname: string) {
		const currentTrack = this.getCurrentTrack()
		this.subscribeFromTrackName(trackname)

		if (this.#paused) {
			this.#videoTrackName = trackname
			return
		}
		if (currentTrack) {
			console.log(`Unsubscribing from track: ${currentTrack.name} and Subscribing to track: ${trackname}`)
			//const active_sub = this.#activeSubscriptions.get(currentTrack.name)
			await new Promise((resolve) => setTimeout(resolve, 200)); // Add a small delay
			await this.unsubscribeFromTrack(currentTrack.name)

			//Hit kommer jag
		} else {
			console.log(`Subscribing to track: ${trackname}`)
		}
		this.#tracknum = this.#catalog.tracks.findIndex((track) => track.name === trackname)

	}

	async mute(isMuted: boolean) {
		this.#muted = isMuted
		if (isMuted) {
			console.log("Unsubscribing from audio track: ", this.#audioTrackName)
			await this.unsubscribeFromTrack(this.#audioTrackName)
			await this.#backend.mute()
		} else {
			console.log("Subscribing to audio track: ", this.#audioTrackName)
			this.subscribeFromTrackName(this.#audioTrackName)
			await this.#backend.unmute()
		}
		super.dispatchEvent(new CustomEvent("volumechange", { detail: { muted: isMuted } }))
	}

	async unsubscribeFromTrack(trackname: string) {
		console.log(`Unsubscribing from track: ${trackname}`)
		super.dispatchEvent(new CustomEvent("unsubscribestared", { detail: { track: trackname } }))
		await this.#connection.unsubscribe(trackname)
		const task = this.#trackTasks.get(trackname)
		if (task) {
			await task
		}
		super.dispatchEvent(new CustomEvent("unsubscribedone", { detail: { track: trackname } }))
		console.log("DONE WITH UNSUBSCRIBE!")
	}

	subscribeFromTrackName(trackname: string) {
		console.log(`Subscribing to new track: ${trackname}`)
		const track = this.#tracksByName.get(trackname)
		if (track) {
			super.dispatchEvent(new CustomEvent("subscribestared", { detail: { track: trackname } }))
			this.#runTrack(track)
			super.dispatchEvent(new CustomEvent("subscribedone", { detail: { track: trackname } }))
		} else {
			console.warn(`Track ${trackname} not in #tracksByName`)
		}
	}

	onMessage(msg: Message.FromWorker) {
		if (msg.latency){
			console.log("Latency: ", msg.latency)
		}
		if (msg.timeline) {
			//this.#timeline.update(msg.timeline)
		}
	}

	async close(err?: Error) {
		if (err) this.#abort(err)
		else this.#close()

		if (this.#connection) this.#connection.close()
		if (this.#backend) await this.#backend.close()
	}

	async closed(): Promise<Error | undefined> {
		try {
			await this.#running
		} catch (e) {
			console.error("Error in Player.closed():", e)
			return asError(e)
		}
	}

	/*
	play() {
		this.#backend.play({ minBuffer: 0.5 }) // TODO configurable
	}

	seek(timestamp: number) {
		this.#backend.seek({ timestamp })
	}
	*/

	// Added this to divide play and pause into two different functions
	async togglePlayPause() {
		if (this.#paused) {
			await this.play()
		} else {
			await this.pause()
		}
	}

	async play() {
		if (this.#paused) {
			this.#paused = false
			this.subscribeFromTrackName(this.#videoTrackName)
			if (!this.#muted) {
				this.subscribeFromTrackName(this.#audioTrackName)
				await this.#backend.unmute()
			}
			this.#backend.play()
			super.dispatchEvent(new CustomEvent("play", { detail: { track: this.#videoTrackName } }))
		}
	}

	async pause() {
		if (!this.#paused) {
			this.#paused = true
			const mutePromise = this.#backend.mute()
			const audioPromise = this.unsubscribeFromTrack(this.#audioTrackName)
			const videoPromise = this.unsubscribeFromTrack(this.#videoTrackName)
			super.dispatchEvent(new CustomEvent("pause", { detail: { track: this.#videoTrackName } }))
			console.log("dispatchEvent pause")

			this.#backend.pause()
			await Promise.all([mutePromise, audioPromise, videoPromise])
		}
	}

	async setVolume(newVolume: number) {
		this.#backend.setVolume(newVolume)
		if (newVolume == 0 && !this.#muted) {
			await this.mute(true)
		} else if (newVolume > 0 && this.#muted) {
			await this.mute(false)
		}
	}

	getVolume(): number {
		return this.#backend ? this.#backend.getVolume() : 0
	}

	/*
	async *timeline() {
		for (;;) {
			const [timeline, next] = this.#timeline.value()
			if (timeline) yield timeline
			if (!next) break

			await next
		}
	}
	*/
}
