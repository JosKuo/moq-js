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
	#latencyEnd: number = 12000
	#latencyStart: number = 2000 //Start latency test after 2 seconds
	#testLatency : boolean = false //Change to true to measure latency
	#latencyDone: boolean = false
	#latencyTestResults: any[] = [] //Test result to download

	//Probing settings
	#useProbing: boolean = false //Change to true to enable probing
    #timeInterval: number = 1000 //How often runProbe() is called
    #probeSize: number = 0 // Value to keep track of current probesize
    #probePriority: number = 1 // Probe priority
    #probeTimer: number = 0 // Timer to run probe, if equal to timeinterval, then it runs a new probe. 
	#currentBitrateIndex = 0 //Index of the current bitrate at test
	#latencyBenchmark: number = 0.7 //Latency benchmark
	#testnumber: number = 3 //Couter to keep track of how many times we have tested the bitrate
	#trackSize: number = 0 //Used to keep track of the previous size of the probe.

    #probeTestResults: any[] = [] //Test result to download
	#roundMeasurements: any[] = [] //Collect the bitrate measurements used to calculate average bandwidth 
	#latencyDuringProbe: any[] = [] //Save the latency during the probe
	#latencyHistory: number[] = []

	//iframe bw measurment settings
	#duration: any[] = [] 
	#useIframeEstimate: boolean = true //Change to true to enable iframe estimate
	
	// Running is a promise that resolves when the player is closed.
	// #close is called with no error, while #abort is called with an error.
	#running: Promise<void>
	#close!: () => void
	#abort!: (err: Error) => void
	#trackTasks: Map<string, Promise<void>> = new Map()
	#bitrates: number[]

	private constructor(connection: Connection, catalog: Catalog.Root, tracknum: number, canvas: OffscreenCanvas) {
		super()
		this.#connection = connection
		this.#catalog = catalog
		this.#tracksByName = new Map(catalog.tracks.map((track) => [track.name, track]))
		this.#bitrates = [4000000, 5000000, 6000000] //bps
		this.#tracknum = tracknum
		this.#audioTrackName = ""
		this.#videoTrackName = ""
		this.#muted = false
		this.#paused = false
		this.#backend = new Backend({ canvas, catalog }, this)
		
		 // Listen for latency events from the Backend

		this.addEventListener("latency", ((event: Event) => {
			const customEvent = event as CustomEvent;
			
			if(this.#testLatency && this.#latencyDone == false && this.#latencyStart < performance.now() && performance.now() < this.#latencyEnd){
				this.#latencyTestResults.push(customEvent.detail);
			}
			else if(this.#testLatency == true && this.#latencyDone == false && performance.now() >= this.#latencyEnd){
				this.#latencyDone = true,
				console.log(`Done with latency test after ${this.#latencyEnd/1000}s, download the results`)
				this.downloadLatencyStats()
			}

			if(this.#useProbing == true){
				pushWithLimit(this.#latencyDuringProbe, customEvent.detail[1], 1000)
			}
			
		}) as EventListener);
		
		this.addEventListener("iframe", ((event: Event) => {
			const customEvent = event as CustomEvent;
			if(this.#useIframeEstimate == true){
				console.log("Iframe estimate: ", customEvent.detail[0], customEvent.detail[1], customEvent.detail[2])
				//this.#duration.pushWi(customEvent.detail[1], customEvent.detail[2])
			}
		}) as EventListener);
		
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
		
		if(this.#useProbing == true){
				this.initiateProbing()			
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

	initiateProbing() {
		clearInterval(this.#probeTimer)
		this.#probeTimer = setInterval(this.runProbe, this.#timeInterval)
    }

	downloadProbeStats = () => {
        const link = document.createElement("a")
        document.body.appendChild(link)

        // download logs
        if (this.#probeTestResults.length > 0) {
            const headers = ["time", "duration", "totalBufferSize", "average_bw", "curr_bitrate", "switch_decision"]
            const csvContent = "data:application/vnd.ms-excel;charset=utf-8," + headers.join("\t") + "\n" + this.#probeTestResults.map((e) => Object.values(e).join("\t")).join("\n")
            const encodedUri = encodeURI(csvContent)
            link.setAttribute("href", encodedUri)
            link.setAttribute("download", "probe_" + Date.now() + ".xlsx")
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
	

	checkLatencyTrend = (latencies: number[], benchmark: number) => {
		const windowSize = 100
		if (latencies.length < windowSize) return false
	
		// Extract the last 100 samples
		const window = latencies.slice(-windowSize)
		
		// Count how many times the latency increased compared to the previous sample
		let increases = 0
		for (let i = 1; i < window.length; i++) {
			if (window[i] > window[i - 1]) increases++
		}
		
		// Increases more than "benchmark"% ?
		const ratio = increases / (windowSize - 1)
		console.log(ratio > benchmark)
		return ratio > benchmark
	}

	checkSpikes = (latencies: number[]) => {
		/* This method checks if there are spikes based on mean + 2×std (95%)*/
		const windowSize = 100
		const window = latencies.slice(-windowSize)

		if(latencies.length >= windowSize){
			const threshhold = dynamixSpikeTreshold(window); 
			if(Math.max(...window) > threshhold){
				console.log("Spikes detected! ", Math.max(...window), " > ", threshhold)
				return true
			}
		}
	}

	downloadEstimate = () => {
		
	}
	
	runProbe = async () => { 
		let sub: any
		let switch_decision: number
		let curr_bitrate: number = this.#bitrates[this.#currentBitrateIndex] 
		let next_bitrate: number;
		if (this.#currentBitrateIndex + 1 < this.#bitrates.length) {
			next_bitrate = this.#bitrates[this.#currentBitrateIndex + 1];
		} else {
			console.warn("Next bitrate index is out of bounds. Staying at current bitrate.");
			next_bitrate = curr_bitrate; // Default to current bitrate if next is unavailable
		}
		// Check if we are using the highest bitrate
		
		try {
			let curr_byte = curr_bitrate/8 //bits -> bytes
			let next_byte = next_bitrate/8 //bits -> bytes
			this.#probeSize = ((this.#timeInterval/1000)*((next_byte-curr_byte) + this.#trackSize))  // t* (next - current), probea upp till nästa bitrate.
			const start = performance.now()
			const probeTrackName = ".probe:" + this.#probeSize + ":" + this.#probePriority 
			sub = await this.#connection.subscribe(["bbb"], probeTrackName)
			
			console.log("playback | probe sub", sub, probeTrackName)
			
			const result = await Promise.race([
				sub.data(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for probe data")), 3000))
			])
		
			let totalBufferSize = 0
	
			while (true) {
				// Read and wait for the next chunk of data
				const chunk = await result.read()
				if (!chunk) break
				if (typeof chunk.payload === "number") continue
				totalBufferSize += chunk.payload.byteLength
			} 
			const end = performance.now()
			const duration = end - start
			const measuredBandwidth = (totalBufferSize * 8) / (duration / 1000) //bps	
			console.log(measuredBandwidth, "bps")
			this.#roundMeasurements.push(measuredBandwidth)

			//const avgLatency = this.#latencyDuringProbe.reduce((acc, e) => acc + e, 0) / this.#latencyDuringProbe.length
			//this.#latencyDuringProbe = [] 
			//this.#latencyHistory.push(avgLatency)
			
			
			/*If we have measured enough times, then we calculate the average bandwidth calculated */
			//if(this.#roundMeasurements.length == this.#testnumber){ 
				let increasing_latency = this.checkLatencyTrend(this.#latencyDuringProbe, this.#latencyBenchmark)
				let spikes = this.checkSpikes(this.#latencyDuringProbe)
				const average_bw = this.#roundMeasurements.reduce((acc, e) => acc + e, 0) / this.#roundMeasurements.length
				this.#roundMeasurements = [] 

				// If the average bandwidth is greater than 80% of the current bitrate, switch up
				if(average_bw*0.8 > curr_bitrate && this.#currentBitrateIndex < this.#bitrates.length-1){
					this.#trackSize += ((this.#bitrates[this.#currentBitrateIndex + 1] - this.#bitrates[this.#currentBitrateIndex]) / 8)
					this.#currentBitrateIndex = this.#currentBitrateIndex + 1
					switch_decision = this.#bitrates[this.#currentBitrateIndex]
					this.#latencyDuringProbe = [] //Empty the array
					console.log("Probing for next level: ", this.#bitrates[this.#currentBitrateIndex])
				}
				else if(increasing_latency == true && this.#currentBitrateIndex > 0){
					this.#trackSize -= ((this.#bitrates[this.#currentBitrateIndex] - this.#bitrates[this.#currentBitrateIndex-1]) / 8)
					this.#currentBitrateIndex = this.#currentBitrateIndex - 1
					switch_decision = this.#bitrates[this.#currentBitrateIndex]
					console.log("Increasing latency:", this.#bitrates[this.#currentBitrateIndex])
				}
				/*else if(spikes == true && this.#currentBitrateIndex > 0){
					this.#trackSize -= ((this.#bitrates[this.#currentBitrateIndex] - this.#bitrates[this.#currentBitrateIndex-1]) / 8)
					this.#currentBitrateIndex = this.#currentBitrateIndex - 1
					switch_decision = this.#bitrates[this.#currentBitrateIndex]
					console.log("Spikes, switching down: ", this.#bitrates[this.#currentBitrateIndex])
				}*/
				// Else we are at a good level. 
				// TODO: This might be a bit unstable...? Test this in lab. 
				else{
					switch_decision = curr_bitrate
					console.log("Stay at the current level!", curr_bitrate)
				}
				this.#probeTestResults.push([performance.now, duration, totalBufferSize, average_bw, curr_bitrate, switch_decision])
			//}
	
			
		} catch (e) {
			console.error("probe error", e)
		} finally {
			console.log("probe closed")
			if (sub) await sub.close()
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
		
		console.log("TRYING TO SUBSCRIBE TO: ", track.name)
		const sub = await this.#connection.subscribe(track.namespace, track.name)
		try {
			for (;;) {
				let start = performance.now()
				const segment = await Promise.race([sub.data(), this.#running])

				let end = performance.now()

				console.log("Time to get segment: ", end - start)
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

function pushWithLimit<T>(arr: T[], value: T, limit: number) {
	/*Helper function to avoid memory consumption */
	if (arr.length >= limit) {
		arr.shift() // Remove the oldest element
	}
	arr.push(value) // Add the new element
}

function computeMean(latencies: number[]): number {
	/*Helper function to calculate the mean of an array */
	if (latencies.length === 0) return 0
	const sum = latencies.reduce((acc, latency) => acc + latency, 0)
	return sum / latencies.length
}

function computeStd(latencies: number[], mean: number): number {
	/*Helper function to calculate the standard deviation of an array */
	const variance = latencies.reduce((acc, val) => acc + (val - mean) ** 2, 0) / latencies.length
	return Math.sqrt(variance)
}

function dynamixSpikeTreshold(latencies: number[], multiplier: number = 2): number {
	/*Helper function to calculate the dynamic threshold */
	const mean = computeMean(latencies)
	const std = computeStd(latencies, mean)
	return mean + multiplier * std
}