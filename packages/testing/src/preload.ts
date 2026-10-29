// bunfig.toml [test] preload. Under `bun test --isolate` this runs once per test file, as the file starts, so each
// file samples the host load itself. Bun binds a test's timeout when the test is registered, so nothing finer is possible.
import { applyLoadScaledTimeout } from './load-timeout.ts'

applyLoadScaledTimeout()
