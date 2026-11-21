# example-worker

A queue worker for example-app. Placeholder repository for the factory Judge's tests and live check.

## Validate

`make check` runs format, lint, types and tests. Every change runs it before a push.

## Logging

Every service logs JSON lines through pino, the library the other services use: see `docs/plan.yaml`.
