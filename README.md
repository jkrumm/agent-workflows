# agent-workflows

One platform for repetitive agent jobs — review, research, observability, briefings, podcasts — on a
single always-on Mac. The unit is a **workflow**: typed input and output, versioned, evaluated.
Every workflow runs inside the same middleware (journal and resume, run record, OpenTelemetry, cost,
scoring), and every caller — Claude Code, a chat agent, cron — reaches it through one generated CLI.

Status: built and deployed on the mini; the design and its version history are in [`docs/concept.md`](docs/concept.md).
