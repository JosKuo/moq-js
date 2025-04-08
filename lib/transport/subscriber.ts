import * as Control from "./control"
import { Queue, Watch } from "../common/async"
import { Objects } from "./objects"
import type { TrackReader, SubgroupReader } from "./objects"

export class Subscriber {
	// Use to send control messages.
	#control: Control.Stream

	// Use to send objects.
	#objects: Objects

	// Announced broadcasts.
	#announce = new Map<string, AnnounceRecv>()
	#announceQueue = new Watch<AnnounceRecv[]>([])

	// Our subscribed tracks.
	#subscribe = new Map<bigint, SubscribeSend>()
	#subscribeNext = 0n

	#trackToIDMap = new Map<string, bigint>()
	#fetch = new Map<bigint, FetchSend>()

	// probing settings
	#useProbing: boolean = false
	#probeInterval: number = 2000
	#probeSize: number = 20000;
	#probePriority: number = 1;
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

	constructor(control: Control.Stream, objects: Objects) {
		this.#control = control
		this.#objects = objects
	}

	announced(): Watch<AnnounceRecv[]> {
		return this.#announceQueue
	}

	async recv(msg: Control.Publisher) {
		if (msg.kind == Control.Msg.Announce) {
			await this.recvAnnounce(msg)
		} else if (msg.kind == Control.Msg.Unannounce) {
			this.recvUnannounce(msg)
		} else if (msg.kind == Control.Msg.SubscribeOk) {
			this.recvSubscribeOk(msg)
		} else if (msg.kind == Control.Msg.SubscribeError) {
			await this.recvSubscribeError(msg)
		} else if (msg.kind == Control.Msg.SubscribeDone) {
			await this.recvSubscribeDone(msg)
		} else if(msg.kind == Control.Msg.FetchOk) {
			this.recvFetchOk(msg)
		} else if(msg.kind == Control.Msg.FetchError) {
			this.recvFetchError(msg)
		}
		else {
			throw new Error(`unknown control message`) // impossible
		}
	}

	async recvAnnounce(msg: Control.Announce) {
		if (this.#announce.has(msg.namespace.join("/"))) {
			throw new Error(`duplicate announce for namespace: ${msg.namespace.join("/")}`)
		}

		await this.#control.send({ kind: Control.Msg.AnnounceOk, namespace: msg.namespace })

		const announce = new AnnounceRecv(this.#control, msg.namespace)
		this.#announce.set(msg.namespace.join("/"), announce)

		this.#announceQueue.update((queue) => [...queue, announce])
	}

	recvUnannounce(_msg: Control.Unannounce) {
		throw new Error(`TODO Unannounce`)
	}

	async subscribe(namespace: string[], track: string) {
		const id = this.#subscribeNext++

		const subscribe = new SubscribeSend(this.#control, id, namespace, track)
		this.#subscribe.set(id, subscribe)

		this.#trackToIDMap.set(track, id)

		await this.#control.send({
			kind: Control.Msg.Subscribe,
			id,
			trackId: id,
			namespace,
			name: track,
			subscriber_priority: 127, // default to mid value, see: https://github.com/moq-wg/moq-transport/issues/504
			group_order: Control.GroupOrder.Publisher,
			location: {
				mode: "latest_group",
			},
		})

		return subscribe
	}

	async unsubscribe(track: string) {
		console.log(`Starting to unsunscribe from... ${track}`);

		if (this.#trackToIDMap.has(track)) {
			const trackID = this.#trackToIDMap.get(track)
			console.log(`Found track ID for ${track}: ${trackID}`);

			if (trackID === undefined) {
				console.warn(`Exception track ${track} not found in trackToIDMap.`)
				return
			}
			try {
				await this.#control.send({ kind: Control.Msg.Unsubscribe, id: trackID })
				this.#trackToIDMap.delete(track)
			} catch (error) {
				console.error(`Failed to unsubscribe from track ${track}:`, error)
			}
		} else {
			console.warn(`During unsubscribe request initiation attempt track ${track} not found in trackToIDMap.`)
		}
	}

	recvSubscribeOk(msg: Control.SubscribeOk) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe ok for unknown id: ${msg.id}`)
		}

		subscribe.onOk()
	}

	async recvSubscribeError(msg: Control.SubscribeError) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe error for unknown id: ${msg.id}`)
		}

		await subscribe.onError(msg.code, msg.reason)
	}

	async recvSubscribeDone(msg: Control.SubscribeDone) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe error for unknown id: ${msg.id}`)
		}

		await subscribe.onError(msg.code, msg.reason)
	}

	async recvObject(reader: TrackReader | SubgroupReader) {
		const subscribe = this.#subscribe.get(reader.header.track)
		if (!subscribe) {
			throw new Error(`data for for unknown track: ${reader.header.track}`)
		}

		await subscribe.onData(reader)
	}

	async fetch(namespace: string[], track: string, start_group: number, start_object: number, end_group: number, end_object: number) {
		/* Sends a fetch message */
		const id = this.#subscribeNext++

		//Create a new fetch instance
		const fetch = new FetchSend(this.#control, id) 
		this.#fetch.set(id, fetch) //Set the fetch instance in the map

		this.#trackToIDMap.set(track, id) // Set the track ID in the map

		// Send the control message.
		await this.#control.send({ 
			kind: Control.Msg.Fetch,
			id,
			namespace,
			name: track,
			subscriber_priority: 1, 
			group_order: Control.GroupOrder.Publisher,
			start_group,
			start_object,
			end_group,
			end_object,
		})

		return fetch
	}

		//Subscribe to a probeTrack
	async runProbe(namespace: string[]){

		const probeTrackName = ".probe:" + this.#probeSize + ":" + this.#probePriority
		const id = this.#subscribeNext++
		const subscribeProbe = new SubscribeSend(this.#control, id, namespace, probeTrackName)
		this.#subscribe.set(id, subscribeProbe)
		this.#trackToIDMap.set(probeTrackName, id)

		await this.#control.send({
			kind: Control.Msg.Subscribe,
			id,
			trackId: id,
			namespace,
			name: probeTrackName,
			subscriber_priority: 254, // Lowest priority (High prio: 0, Low prio: 254)
			group_order: Control.GroupOrder.Publisher,
			location: {
				mode: "latest_group",
			},
		})

		return subscribeProbe
	}

	recvFetchOk(msg: Control.FetchOk) {
		/* Recieves fetch */

		// Check if the fetch is valid, for example, if the ID is in the map
		const fetch = this.#fetch.get(msg.id)
		console.log(fetch)
		if (!fetch) {
			throw new Error(`fetch ok for unknown id: ${msg.id}`)
		}
		fetch.onComplete()
	}

	recvFetchError(msg: Control.FetchError) {
		/* Recieves fetch error */
		const fetch = this.#fetch.get(msg.id)
		if (!fetch) {
			throw new Error(`fetch error for unknown id: ${msg.id}`)
		}

		fetch.onError(msg.code, msg.reason)
	}

	recvFetchCancel(msg: Control.FetchCancel) {
		/* TODO: Recieves fetch cancel */
		
	}

}

export class AnnounceRecv {
	#control: Control.Stream

	readonly namespace: string[]

	// The current state of the announce
	#state: "init" | "ack" | "closed" = "init"

	constructor(control: Control.Stream, namespace: string[]) {
		this.#control = control // so we can send messages
		this.namespace = namespace
	}

	// Acknowledge the subscription as valid.
	async ok() {
		if (this.#state !== "init") return
		this.#state = "ack"

		// Send the control message.
		return this.#control.send({ kind: Control.Msg.AnnounceOk, namespace: this.namespace })
	}

	async close(code = 0n, reason = "") {
		if (this.#state === "closed") return
		this.#state = "closed"

		return this.#control.send({ kind: Control.Msg.AnnounceError, namespace: this.namespace, code, reason })
	}
}

export class FetchSend {
	#control: Control.Stream
	#id: bigint
	#data = new Queue<TrackReader | SubgroupReader>()
	#state: "init" | "completed" | "error" = "init"

	constructor(control: Control.Stream, id: bigint) {
		this.#control = control
		this.#id = id 
	}

	async onData(reader: TrackReader | SubgroupReader) {
		/* Receives data from the fetch*/
		if (this.#state === "init" && !this.#data.closed()) {
			await this.#data.push(reader)
		}
	}

	async onError(code: bigint, reason: string) {
		/* Set state to error and abort */
		this.#state = "error"
		const err = new Error(`FETCH_ERROR (${code}): ${reason}`)
		await this.#data.abort(err)
	}

	async onComplete() {
		/* Set state to completed and close stream*/
		this.#state = "completed"
	}

	async data() {
		/* Wait for the next data stream ? NOT APPLICABLE ?*/
		return await this.#data.next()
	}

	async cancel() {
		/* Cancel the fetch */
		if (this.#state === "init") {
			this.#state = "error"
			await this.#control.send({ kind: Control.Msg.FetchCancel, id: this.#id })
			//await this.#data.close()
		}
	}
}

export class SubscribeSend {
	#control: Control.Stream
	#id: bigint

	readonly namespace: string[]
	readonly track: string

	// A queue of received streams for this subscription.
	#data = new Queue<TrackReader | SubgroupReader>()

	constructor(control: Control.Stream, id: bigint, namespace: string[], track: string) {
		this.#control = control // so we can send messages
		this.#id = id
		this.namespace = namespace
		this.track = track
	}

	async close(_code = 0n, _reason = "") {
		// TODO implement unsubscribe
		// await this.#inner.sendReset(code, reason)
	}

	onOk() {
		// noop
	}

	async onError(code: bigint, reason: string) {
		if (code == 0n) {
			return await this.#data.close()
		}

		if (reason !== "") {
			reason = `: ${reason}`
		}

		const err = new Error(`SUBSCRIBE_ERROR (${code})${reason}`)
		return await this.#data.abort(err)
	}

	async onData(reader: TrackReader | SubgroupReader) {
		if (!this.#data.closed()) await this.#data.push(reader)
	}

	// Receive the next a readable data stream
	async data() {
		return await this.#data.next()
	}

}
