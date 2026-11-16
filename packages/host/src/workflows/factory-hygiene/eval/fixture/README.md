# example-queue

A small job queue with one worker loop and a file-backed store.

## Quickstart

Start the server with `example-queue serve`. It listens on port 8080 unless you pass `--port`.

Add a job with `example-queue enqueue <json>`. The worker claims jobs one at a time.

The design is in `docs/architecture.md`, the commands and flags are in `docs/cli.md`.
