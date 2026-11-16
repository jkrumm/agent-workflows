import { MAX_PAYLOAD_BYTES } from './config.js'

export class Queue {
  constructor(store) {
    this.store = store
  }

  enqueue(payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new Error('payload too large')
    return this.store.insert({ payload, attempts: 0, state: 'ready', leaseUntil: 0 })
  }

  claimNext(leaseSeconds) {
    const now = Date.now()
    const job = this.store.all().find((j) => (j.state === 'ready' || j.state === 'leased') && j.leaseUntil <= now)
    if (!job) return null
    return this.store.update(job.id, {
      state: 'leased',
      attempts: job.attempts + 1,
      leaseUntil: now + leaseSeconds * 1000,
    })
  }

  ack(id) {
    this.store.remove(id)
  }

  release(id, delayMs) {
    this.store.update(id, { state: 'ready', leaseUntil: Date.now() + delayMs })
  }

  deadLetter(id, reason) {
    this.store.update(id, { state: 'dead', reason })
  }
}
