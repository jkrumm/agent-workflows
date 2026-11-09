// The suites that run scripts/*.sh need zsh, which the mini has and a minimal container may not. Without it they skip
// visibly; on CI (which installs zsh, see ci.yml) a missing zsh fails the file instead, since a skip there is coverage
// the merge gate never had.
import { describe, test } from 'bun:test'

const found = Bun.which('zsh')

if (!found && process.env.CI) throw new Error('zsh is not on PATH: the script tests need it (ci.yml installs it)')

/** The real interpreter from PATH: /bin/zsh on the mini, /usr/bin/zsh on CI. Never spawned where zsh is missing: the suites skip. */
export const ZSH: string = found ?? 'zsh'

/** `describe`, skipped (visibly) where zsh is not installed. */
export const describeZsh = describe.skipIf(!found)

/** `test`, skipped (visibly) where zsh is not installed. */
export const testZsh = test.skipIf(!found)
