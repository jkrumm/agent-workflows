# Queue

`Queue.enqueue(payload)` adds a job and rejects a payload that is too large.

`Queue.pop(leaseSeconds)` claims the oldest ready job and leases it to the caller.

`Queue.ack(id)` removes a finished job. `Queue.release(id, delayMs)` makes a failed job ready again after the delay.
