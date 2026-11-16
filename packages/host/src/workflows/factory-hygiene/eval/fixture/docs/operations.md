# Operations

## Limits

`Queue.enqueue` rejects a job whose JSON payload is larger than 65536 bytes.

## Polling

An idle worker sleeps 500 ms between polls.

## Lease

A lease lasts 30 seconds; after that another claim may take the job.
