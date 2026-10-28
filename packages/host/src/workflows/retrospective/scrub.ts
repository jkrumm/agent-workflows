// Only for what the agent is shown. Nothing the model writes reaches a public issue (issue.ts), so this is hygiene, not
// the security boundary: absolute paths and credential-shaped tokens carry no signal for a proposal and would be quoted.

const PATH_END = String.raw`[^\s'"\x60)\]>,;]*`
const PATTERNS: [RegExp, string][] = [
  // `C:\Users\x`, `D:/work`
  [new RegExp(String.raw`(?<![\w])[A-Za-z]:[\\/]${PATH_END}`, 'g'), '<path>'],
  // `~/notes`, `~jane/notes`
  [new RegExp(String.raw`(?<![\w.:/-])~[\w.-]*\/${PATH_END}`, 'g'), '<path>'],
  // `/Users/x/y`, `/etc/hosts`, and the single segment `/tmp`: a slash not preceded by a word character, dot, colon or
  // slash (so `agents/x` and `https://h/x` keep their inner slashes)
  [new RegExp(String.raw`(?<![\w.:/-])\/[\w.@+-]+(?:\/[\w.@+-]*)*`, 'g'), '<path>'],
  [/\b(?:github_pat|ghp|gho|ghu|ghs|ghr|sk|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <redacted>'],
]

export function scrubForPrompt(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replaceAll(pattern, replacement)
  return out
}
