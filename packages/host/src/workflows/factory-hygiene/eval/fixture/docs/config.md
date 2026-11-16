# Config

example-queue reads no config file. Its defaults live in `src/config.js`:

- `DEFAULT_PORT`: 8420
- `MAX_PAYLOAD_BYTES`: 65536
- `POLL_INTERVAL_MS`: 500
- `LEASE_SECONDS`: 30

The worker's own limits, `MAX_RETRIES` and `BACKOFF_BASE_MS`, live in `src/worker.js`.
