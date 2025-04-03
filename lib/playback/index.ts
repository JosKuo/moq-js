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

	//Probing settings
	#useProbing: boolean = false
    #probeInterval: number = 2000
    #probeSize: number = 40000
    #probePriority: number = 0 // 0 is lowest priority, 1 is highest
    #probeTimer: number = 0
    #useProbeTestData = false
    #probeTestResults: any[] = []
    #probeTestData = {
        start: 10000,
        stop: 300000,
        increment: 10000,
        iteration: 3,
        lastIteration: 0
    }

	#enableSwitchTrackIdFeature = this.getFromQueryString("enableSwitchTrackIdFeature", "false") === "true"

	// Running is a promise that resolves when the player is closed.
	// #close is called with no error, while #abort is called with an error.
	#running: Promise<void>
	#close!: () => void
	#abort!: (err: Error) => void
	#trackTasks: Map<string, Promise<void>> = new Map()

	private constructor(connection: Connection, catalog: Catalog.Root, tracknum: number, canvas: OffscreenCanvas) {
		super()
		this.#connection = connection
		this.#catalog = catalog
		this.#tracksByName = new Map(catalog.tracks.map((track) => [track.name, track]))
		this.#tracknum = tracknum
		this.#audioTrackName = ""
		this.#videoTrackName = ""
		this.#muted = false
		this.#paused = false
		this.#backend = new Backend({ canvas, catalog }, this)
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

		this.parseProbeParametersAndRun()

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
        try {
            if (!location.search) return

            const probeSize = parseInt(this.getFromQueryString("probeSize", "0"))
            const probePriority = parseInt(this.getFromQueryString("probePriority", "-1"))
            const probeInterval = parseInt(this.getFromQueryString("probeInterval", "0"))

            let useProbing = false
            if (probeSize > 0) {
                useProbing = true
                this.#probeSize = probeSize
            }
            if (probePriority > -1) {
                useProbing = true
                this.#probePriority = probePriority
            }
            // set probeInterval and start probeTimer
            if (probeInterval > 0 && probeInterval !== this.#probeInterval) {
                useProbing = true
                if (this.#probeTimer) {
                    clearInterval(this.#probeTimer)
                }
                this.#probeInterval = probeInterval
                this.#probeTimer = setInterval(this.runProbe, this.#probeInterval)
            }

            if (useProbing) {
                this.#useProbing = true
                console.log("playback | parseProbeParameters | probeSize: %d probePriority: %d probeInterval: %d", this.#probeSize, this.#probePriority, this.#probeInterval)
            }
        } catch (e) {
            console.error("playback | parseProbeParameters | error", e)
        }
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
	
	runProbe = async () => { //?probeSize=40000&probePriority=0&probeInterval=3000
		console.log("playback | runProbe")
	
		let totalIteration = 0
		if (this.#useProbeTestData && this.#probeTestData) {
			const totalProbeSizes = (this.#probeTestData.stop - this.#probeTestData.start) / this.#probeTestData.increment + 1
			totalIteration = totalProbeSizes * this.#probeTestData.iteration
			console.log("playback | probe | totalIteration", totalIteration)
			this.#probeSize = this.#probeTestData.start + Math.floor(this.#probeTestData.lastIteration / this.#probeTestData.iteration) * this.#probeTestData.increment
			++this.#probeTestData.lastIteration
		}
	
		let sub: any
		try {

			const start = performance.now()
			const probeTrackName = ".probe:" + this.#probeSize + ":" + this.#probePriority
			sub = await this.#connection.subscribe(["bbb"], probeTrackName)
	
			console.log("playback | probe sub", sub, probeTrackName)
			
			const result = await Promise.race([
				sub.data(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for probe data")), 3000))
			])
			console.log("probe | result", result)
			
			

			let totalBufferSize = 0
			let rtt = 0
	
			while (true) {

				const chunk = await result.read()
				if (!chunk) break
	
				// Skip status messages
				if (typeof chunk.payload === "number") continue
				totalBufferSize += chunk.payload.byteLength
				if (rtt === 0) {
					rtt = performance.now() - start
				}

			} 
	
			const end = performance.now()
			const duration = end - start
			const measuredBandwidth = (totalBufferSize * 8) / (duration / 1000) / 1000 // kbps
			const tc_bandwidth = parseFloat(localStorage.getItem("tc_bandwidth") || "0") || 0
	
			console.log("playback | probe done | duration:", duration, "bytes:", totalBufferSize, "bandwidth:", measuredBandwidth.toFixed(2), "tc_bw:", tc_bandwidth.toFixed(2))
	
			this.dispatchEvent(new CustomEvent("stat", {
				detail: { type: "measuredBandwidth", value: measuredBandwidth }
			}))
	
			this.#probeTestResults.push([duration, totalBufferSize, measuredBandwidth.toFixed(2), tc_bandwidth.toFixed(2)])
	
		} catch (e) {
			console.error("playback | probe error", e)
		} finally {
			console.log("playback | probe closed")
			if (sub) await sub.close()
		}
	
		if (this.#useProbeTestData && this.#probeTestData.lastIteration === totalIteration) {
			//this.downloadProbeStats()
			this.#probeTestData.lastIteration = 0
			clearInterval(this.#probeTimer)
		}
	}
	
	

	/*NOT USED YET 
	TODO: Measure download time. 
	This is where the actual fetch happens.

	

	async #runProbe(namespace: string[]) {
		const startTime = performance.now();
	
		const subprobe = await this.#connection.probe(namespace);
		console.log("subprobe object:", subprobe);
	
		try {
			for (;;) {
				const probeData = await subprobe.data();
				if (!probeData) break; // Exit the loop if no more data is available
	
				// Log the received data
				console.log("Received probe data:", probeData);
			}
		} catch (error) {
			console.error("Error fetching probe data:", error);
		}
	
		const endTime = performance.now();
		const downloadTime = endTime - startTime;
		console.log("Download time:", downloadTime);
	}
	*/
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

		/*
		UNCOMMENT TO KEEP WORKING ON PROBES

		if (track.namespace) {
			this.#runProbe(track.namespace)
		} else {
			console.warn(`Track ${track.name} has no namespace, skipping probe.`)
		}
			
		*/
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
		if (this.#paused) {
			this.#videoTrackName = trackname
			return
		}
		if (currentTrack) {
			console.log(`Unsubscribing from track: ${currentTrack.name} and Subscribing to track: ${trackname}`)
			await this.unsubscribeFromTrack(currentTrack.name)
		} else {
			console.log(`Subscribing to track: ${trackname}`)
		}
		this.#tracknum = this.#catalog.tracks.findIndex((track) => track.name === trackname)

		this.subscribeFromTrackName(trackname)
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
	}

	subscribeFromTrackName(trackname: string) {
		console.log(`Subscribing to track: ${trackname}`)
		const track = this.#tracksByName.get(trackname)
		if (track) {
			super.dispatchEvent(new CustomEvent("subscribestared", { detail: { track: trackname } }))
			this.#runTrack(track)
			super.dispatchEvent(new CustomEvent("subscribedone", { detail: { track: trackname } }))
		} else {
			console.warn(`Track ${trackname} not in #tracksByName`)
		}
	}

	#onMessage(msg: Message.FromWorker) {
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
