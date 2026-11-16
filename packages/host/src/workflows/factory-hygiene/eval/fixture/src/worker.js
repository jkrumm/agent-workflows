import { LEASE_SECONDS, POLL_INTERVAL_MS } from './config.js'

export const MAX_RETRIES = 5
export const BACKOFF_BASE_MS = 200

export const backoffMs = (attempt) => BACKOFF_BASE_MS * 2 ** attempt

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Claims jobs one at a time; a failed job is released with a delay until its retries are spent, then dead-lettered. */
export async function runWorker(queue, handler, signal) {
  while (!signal.aborted) {
    const job = queue.claimNext(LEASE_SECONDS)
    if (!job) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    try {
      await handler(job.payload)
      queue.ack(job.id)
    } catch (error) {
      if (job.attempts > MAX_RETRIES) queue.deadLetter(job.id, String(error))
      else queue.release(job.id, backoffMs(job.attempts))
    }
  }
}
