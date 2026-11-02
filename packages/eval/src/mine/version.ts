/** Bump on any filter change: a candidate or case names the miner that produced it. */
export const MINER_VERSION = '2026-11-02.1'

export const DEFAULT_OWNER_EMAILS = ['jkrumm@pm.me', 'jokrumm@gmail.com', 'jkrumm@users.noreply.github.com']
/** Repos under the root that are not code the owner reviews. Names starting with `.` are skipped as well. */
export const EXCLUDED_REPOS = ['dispatch-scratch', 'brain', 'dotfiles-private']

/** The introducing commit is at most this many days before its fix (26 weeks), by author date. */
export const MAX_INTRO_AGE_DAYS = 182
/** A reviewable introducing commit or control: added plus deleted lines. */
export const MAX_CHANGED_LINES = 1500
/** A control is at least this old (12 weeks), so a later fix had time to show up. */
export const CONTROL_MIN_AGE_DAYS = 84
export const DEFAULT_CONTROLS = 100
/** Share of controls with a docs, test, refactor or chore subject type. */
export const MAX_WEAK_CONTROL_SHARE = 0.15
/** A mass reformat: this many files, of which this share of the changed lines are whitespace only. */
export const REFORMAT_MIN_FILES = 20
export const REFORMAT_WHITESPACE_SHARE = 0.8
