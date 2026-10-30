// The door's caller-token file lives in the host package (`@agent-workflows/host/door-tokens`, node-only), shared with the
// host's image door; `make deploy` checks the file through this path before it stops anything.
export { PLATFORM_CALLER, parseDoorTokens, readDoorTokens } from '@agent-workflows/host/door-tokens'
