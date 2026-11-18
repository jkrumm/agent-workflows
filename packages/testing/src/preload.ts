// bunfig.toml [test] preload. Under `bun test --isolate` this runs once per test file, as the file starts, so each
// file samples the host load itself. Bun binds a test's timeout when the test is registered, so nothing finer is possible.
import { applyLoadScaledTimeout } from './load-timeout.ts'

applyLoadScaledTimeout()

import { afterAll } from 'bun:test'

// A finished file's heap is not given back to the OS until a full collection: without it a parallel worker keeps
// every file's garbage in its resident size (the full test step peaked at 4.7 GiB, 3.2 GiB with it).
afterAll(() => {
  Bun.gc(true)
})
