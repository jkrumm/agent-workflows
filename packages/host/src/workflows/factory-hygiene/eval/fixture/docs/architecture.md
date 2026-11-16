# Architecture

example-queue has three parts: the `Queue` in `src/queue.js`, the `FileStore` in `src/store.js` and the worker loop in
`src/worker.js`.

## Failure handling

A job that fails is released back to the queue after an exponential delay and claimed again. A job is retried 3 times;
after that it is dead-lettered and no worker claims it again.

## Leases

A claimed job is leased to its worker for 30 seconds. A lease that runs out makes the job claimable again.
