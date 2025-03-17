import * as MP4 from "./index"

export interface Frame {
	track: MP4.Track // The track this frame belongs to
	sample: MP4.Sample // The actual sample contain the frame data
	prfts: MP4.BoxParser.prftBox[] // Recent prft boxes
	ntpTime?: number; // Store computed NTP timestamp

}

// Decode a MP4 container into individual samples.
export class Parser {
	info!: MP4.Info // Stores metadata about the MP4 file
	#mp4 = MP4.New() //Creates a new MP4 parser instance
	#offset = 0
	#last_boxes_length = 0
	#ntpTimestamps: Array<{ mediaTime: number; ntpTime: number }> = []; // Store extracted NTP timestamps

	#samples: Array<Frame> = [] // Stores extracted frames

	constructor(init: Uint8Array) {
		this.#mp4.onError = (err) => {
			console.error("MP4 error", err)
		}

		this.#mp4.onReady = (info: MP4.Info) => {
			this.info = info
			// Extract all of the tracks, because we don't know if it's audio or video.
			for (const track of info.tracks) {
				this.#mp4.setExtractionOptions(track.id, track, { nbSamples: 1 })
			}
		}
		this.#mp4.onSamples = (_track_id: number, track: MP4.Track, samples: MP4.Sample[]) => {
			for (const sample of samples) {
				const prfts = this.#getLastPRFTs();
				let ntpTime: number | undefined = prfts.length > 0 ? prfts[0].ntp_time : undefined;
		
				// Store sample and associated PRFT data
				this.#samples.push({ track, sample, prfts, ntpTime });
		
				// Update global ntpTimestamps array for real-time overlay
				if (ntpTime !== undefined) {
					this.#ntpTimestamps.push({
						mediaTime: sample.cts / track.timescale, // Convert to media time
						ntpTime: ntpTime
					});
				}
			}
		};
		


		this.#mp4.start()

		// For some reason we need to modify the underlying ArrayBuffer with offset
		const copy = new Uint8Array(init)
		const buffer = copy.buffer as MP4.ArrayBuffer
		buffer.fileStart = this.#offset

		this.#mp4.appendBuffer(buffer)
		this.#offset += buffer.byteLength
		this.#mp4.flush()

		if (!this.info) {
			throw new Error("could not parse MP4 info")
		}
	}

	getNtpTimestamps() {
        return this.#ntpTimestamps;
    }

	decode(chunk: Uint8Array): Array<Frame> {
		const copy = new Uint8Array(chunk)
		// For some reason we need to modify the underlying ArrayBuffer with offset
		const buffer = copy.buffer as MP4.ArrayBuffer
		buffer.fileStart = this.#offset

		// Parse the data
		this.#mp4.appendBuffer(buffer)
		this.#mp4.flush()

		this.#offset += buffer.byteLength


		const samples = [...this.#samples]
		this.#samples.length = 0

		return samples
	}
	
	#getLastPRFTs(): MP4.BoxParser.Box[] {
        const length = this.#mp4.boxes.length
        const delta = length - this.#last_boxes_length
        this.#last_boxes_length = length

        // FIXME: Filter only prfts that are related to the current track

        // In reverse order check last delta chunks for PRFT boxes
        const prfts = []
        for (let i = 1; i <= delta; i++) {

            const box = this.#mp4.boxes[length - i]

            if (box.type === "prft"){
				
				const npt_time = ntptoms(box.ntp_timestamp)

				prfts.push({...box, ntp_time: npt_time})
			} 
        }
		
        return prfts
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
	const unixTimestamp = upperMilliseconds + lowerMilliseconds - ntpEpochOffset

    // Combine both parts and adjust for the NTP epoch offset
    return unixTimestamp
}