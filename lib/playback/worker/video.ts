import { Frame, Component } from "./timeline"
import * as MP4 from "../../media/mp4"
import * as Message from "./message"

interface DecoderConfig {
	codec: string
	description?: ArrayBuffer | Uint8Array | DataView
	codedWidth?: number
	codedHeight?: number
	displayAspectWidth?: number
	displayAspectHeight?: number
	colorSpace?: {
		primaries?: "bt709" | "bt470bg" | "smpte170m"
		transfer?: "bt709" | "smpte170m" | "iec61966-2-1"
		matrix?: "rgb" | "bt709" | "bt470bg" | "smpte170m"
	}
	hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software"
	optimizeForLatency?: boolean
}

export class Renderer {
	#canvas: OffscreenCanvas
	#timeline: Component

	#decoder!: VideoDecoder
	#queue: TransformStream<Frame, VideoFrame>
	#prftMap = new Map<number, number>() // PTS -> NTP
	#decoderConfig?: DecoderConfig
	#waitingForKeyframe: boolean = true
	#paused: boolean
	#hasSentWaitingForKeyFrameEvent: boolean = false
	#serverTimeOffset: number = 0

	constructor(config: Message.ConfigVideo, timeline: Component) {
		this.#canvas = config.canvas
		this.#timeline = timeline
		this.#paused = false

		this.#queue = new TransformStream({
			start: this.#start.bind(this),
			transform: this.#transform.bind(this),
		})

		this.#run().catch(console.error)
	}

	pause() {
		this.#paused = true
		this.#decoder.flush().catch((err) => {
			console.error(err)
		})
		this.#waitingForKeyframe = true
	}

	play() {
		this.#paused = false
	}

	async #run() {
		/*
		Det jag gör här är att när NTP ändras så uppdaterar jag lastValidNtp och skriver ut det på skärmen.
		Jag har även lagt till en variabel lastLatency som håller koll på senaste latency så att variabeln endast
		ändras när jag får en ny NTP timestamp. Annars räknar den uppåt. 
		*/
		const reader = this.#timeline.frames.pipeThrough(this.#queue).getReader();
		let lastValidNtp: number | undefined = undefined; // Store the last valid NTP timestamp
		let previousNtp: number | undefined = undefined; // Store the previous NTP timestamp for comparison
		let lastLatency : number | 0;
		for (;;) {
			const { value: frame, done } = await reader.read();
	
			if (this.#paused) continue;
			if (done) break;
	
			// Extract PRFT timestamp for this frame
			const prft = this.#prftMap.get(frame.timestamp);
			let ntp: number | undefined = prft ? ntptoms(prft) : lastValidNtp;
	
			// Adjust for server time offset
			if (ntp !== undefined && !isNaN(ntp) && !isNaN(this.#serverTimeOffset)) {
				ntp -= this.#serverTimeOffset;
			}
	
			// Update lastValidNtp only if the new NTP timestamp is valid
			if (ntp !== undefined && !isNaN(ntp)) {
				lastValidNtp = ntp;
			}
	
			self.requestAnimationFrame(() => {
				this.#canvas.width = frame.displayWidth;
				this.#canvas.height = frame.displayHeight;
			
				const ctx = this.#canvas.getContext("2d");
				if (!ctx) throw new Error("failed to get canvas context");
			
				ctx.fillStyle = "white";
				ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
			
				ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
			
				// Set font and text color
				ctx.font = "48px Arial";
				ctx.fillStyle = "white";
			
					// Calculate position for bottom-left corner
					const padding = 10;
					const textHeight = 48; // Approximate height of the text
					const yPosition = this.#canvas.height - padding; // Bottom with padding
			
					// Display the last valid NTP timestamp only if it differs from the previous one
					if (lastValidNtp !== undefined && lastValidNtp !== previousNtp) {
						// Use performance.timeOrigin as the reference for latency calculation
						const currentTime = performance.now() + performance.timeOrigin;
				
						// Ensure latency is not negative
						const networkLatency = Math.max(0, (currentTime - lastValidNtp));
				
						// Add background for the text
						const text = `Latency: ${networkLatency}ms`;
						const textWidth = ctx.measureText(text).width;
				
						ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; // Semi-transparent black background
						ctx.fillRect(padding, yPosition - textHeight - padding, textWidth + padding * 2, textHeight + padding);
				
						// Draw the text
						ctx.fillStyle = "white";
						ctx.fillText(text, padding * 2, yPosition - padding);
				
						// Update the previous NTP timestamp
						previousNtp = lastValidNtp;
						lastLatency = networkLatency;
					} else {
						// Add background for the text

						const text = `Latency: ${lastLatency}ms`;
						const textWidth = ctx.measureText(text).width;
				
						ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; // Semi-transparent black background
						ctx.fillRect(padding, yPosition - textHeight - padding, textWidth + padding * 2, textHeight + padding);
				
						// Draw the text
						ctx.fillStyle = "white";
						ctx.fillText(text, padding * 2, yPosition - padding);
					}
			
				frame.close();
			});
		}
	}

	#start(controller: TransformStreamDefaultController<VideoFrame>) {
		this.#decoder = new VideoDecoder({
			output: (frame: VideoFrame) => {
				controller.enqueue(frame)
			},
			error: console.error,
		})
	}

	#transform(frame: Frame) {
		if (this.#decoder.state === "closed" || this.#paused) {
			console.warn("Decoder is closed or paused. Skipping frame.")
			return
		}

		const { sample, track } = frame

		// Reset the decoder on video track change
		if (this.#decoderConfig && this.#decoder.state == "configured") {
			if (MP4.isVideoTrack(track)) {
				const configMismatch =
					this.#decoderConfig.codec !== track.codec ||
					this.#decoderConfig.codedWidth !== track.video.width ||
					this.#decoderConfig.codedHeight !== track.video.height

				if (configMismatch) {
					this.#decoder.reset()
					this.#decoderConfig = undefined
				}
			}
		}

		// Configure the decoder with the first frame
		if (this.#decoder.state !== "configured") {
			const desc = sample.description
			const box = desc.avcC ?? desc.hvcC ?? desc.vpcC ?? desc.av1C
			if (!box) throw new Error(`unsupported codec: ${track.codec}`)

			const buffer = new MP4.Stream(undefined, 0, MP4.Stream.BIG_ENDIAN)
			box.write(buffer)
			const description = new Uint8Array(buffer.buffer, 8) // Remove the box header.

			if (!MP4.isVideoTrack(track)) throw new Error("expected video track")

			this.#decoderConfig = {
				codec: track.codec,
				codedHeight: track.video.height,
				codedWidth: track.video.width,
				description,
				// optimizeForLatency: true
			}

			this.#decoder.configure(this.#decoderConfig)
			if (!frame.sample.is_sync) {
				this.#waitingForKeyframe = true
			} else {
				this.#waitingForKeyframe = false
			}
		}

		//At the start of decode , VideoDecoder seems to expect a key frame after configure() or flush()
		if (this.#decoder.state == "configured") {
			if (this.#waitingForKeyframe && !frame.sample.is_sync) {
				console.warn("Skipping non-keyframe until a keyframe is found.")
				if (!this.#hasSentWaitingForKeyFrameEvent) {
					self.postMessage("waitingforkeyframe")
					this.#hasSentWaitingForKeyFrameEvent = true
				}
				return
			}

			// On arrival of a keyframe, allow decoding and stop waiting for a keyframe.
			if (frame.sample.is_sync) {
				this.#waitingForKeyframe = false
				this.#hasSentWaitingForKeyFrameEvent = false
			}

			const chunk = new EncodedVideoChunk({
				type: frame.sample.is_sync ? "key" : "delta",
				data: frame.sample.data,
				timestamp: frame.sample.dts / frame.track.timescale,
			})			

			for (const prft of frame.prfts) {
				this.#prftMap.set(chunk.timestamp, prft.ntp_timestamp)
			} 
	
			this.#decoder.decode(chunk)
		}
	}
}


function ntptoms(ntpTimestamp?: number) {
    if (!ntpTimestamp) return NaN

    const ntpEpochOffset = 2208988800000 // milliseconds between 1970 and 1900

    // Split the 64-bit NTP timestamp into upper and lower 32-bit parts
    const upperPart = Math.floor(ntpTimestamp / Math.pow(2, 32))
    const lowerPart = ntpTimestamp % Math.pow(2, 32)

    // Calculate milliseconds for upper and lower parts
    const upperMilliseconds = upperPart * 1000
    const lowerMilliseconds = (lowerPart / Math.pow(2, 32)) * 1000

    // Combine both parts and adjust for the NTP epoch offset
    return upperMilliseconds + lowerMilliseconds - ntpEpochOffset
}