# CLI

`example-queue <command> [flags]`

## Commands

- `serve` starts the server and the worker loop.
- `enqueue <json>` adds one job.

## Flags

- `--port N` sets the listen port.
- `--verbose` turns on verbose logging.
- `--drain` stops the worker once the queue is empty.
- `--fast` skips the payload size check when a job is enqueued.

An unknown flag stops the command and prints the usage line.
