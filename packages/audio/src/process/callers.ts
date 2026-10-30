// Who may call the door, and under which name. The audio process binds 127.0.0.1, so a caller is a process on this
// machine; it presents a bearer from the local caller-token file (`tokens.ts`, shared with the host's image door). The
// platform's own API secret is accepted too, as the caller `agw`. No 1Password item: a token is local to the machine it
// serves.
export { type CallerAuth, callerAuth } from '@agent-workflows/host/door-tokens'
export { PLATFORM_CALLER, parseDoorTokens, readDoorTokens } from './tokens.ts'
