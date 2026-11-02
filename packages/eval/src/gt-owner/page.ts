/** One line of code on the page: its number in the file, its text, and whether it is part of the claimed location. */
export interface CodeLine {
  n: number
  text: string
  mark: boolean
}

export interface CaseItem {
  kind: 'case'
  /** The candidate id: what an `OwnerCaseLabel` names. */
  id: string
  repo: string
  introSubject: string
  /** "file:start-end", or null when no labeller named a place. */
  where: string | null
  /** The bug claim (a labeller's description), or the line saying nobody claimed one. */
  claim: string
  fixSubject: string
  /** The introducing commit's file around the place, or why it could not be read. */
  code: CodeLine[] | string
  /** The fix commit's diff for that file, cut. */
  fixDiff: string
}

export interface PairItem {
  kind: 'pair'
  /** `<caseId>:<judge run id>:<finding id>`: what an `OwnerPairLabel` names. */
  id: string
  bug: { where: string; description: string; code: CodeLine[] | string }
  finding: { tag: string; where: string; message: string }
}

export type PageItem = CaseItem | PairItem

export interface SessionPage {
  sessionId: string
  items: PageItem[]
  /** Shortfalls and skips, shown under the instructions. */
  notes: string[]
}

/** JSON for an inline `<script>`: nothing in it can close the tag or open a comment. */
const embed = (value: unknown) =>
  JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1b1b1f;--muted:#6b6b76;--card:#fff;--line:#d9d9e0;--code:#f3f3f6;--mark:#fff1b8;--add:#e3f6e6;--del:#fde5e5;--accent:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#e8e8ee;--muted:#9a9aa8;--card:#1d1d22;--line:#34343c;--code:#101013;--mark:#4a3f10;--add:#16301b;--del:#3a1b1b;--accent:#7b9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
header.top{display:flex;gap:16px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:1}
.grow{flex:1}.muted{color:var(--muted)}button{font:inherit;padding:6px 12px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer}
button.on{background:var(--accent);color:#fff;border-color:var(--accent)}details{margin:8px 0}summary{cursor:pointer;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
.q{font-size:17px;font-weight:600;margin:0 0 12px}h3{margin:16px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
pre.code{margin:0;background:var(--code);border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:46vh;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.ln{display:block;padding:0 8px;white-space:pre}.ln i{display:inline-block;width:4ch;margin-right:1.5ch;color:var(--muted);font-style:normal;text-align:right;user-select:none}
.ln.mark{background:var(--mark)}.ln.add{background:var(--add)}.ln.del{background:var(--del)}
.claim{white-space:pre-wrap}.answers{display:flex;gap:8px;margin-top:16px;align-items:center;flex-wrap:wrap}
kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:12px ui-monospace,monospace}
textarea{width:100%;margin-top:8px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);min-height:56px}
.tag{font:12px ui-monospace,monospace;border:1px solid var(--line);border-radius:4px;padding:1px 6px}`

const INSTRUCTIONS = `
<details open><summary>Instructions: about 40 seconds per item, two hours in total. Answers save in this browser as you go.</summary>
<p><b>Commit items.</b> Someone claims the commit introduced a bug. Answer <b>yes</b> if it is a real defect this commit created, at about the marked place;
<b>no</b> if it is a feature change, a refactor, a preference, a bug that was already there, or a different problem;
<b>unsure</b> if you cannot tell in a minute.</p>
<p><b>Finding items.</b> A review finding is shown next to a known bug. Answer <b>yes</b> if the finding describes this bug (same defect, even in other words, about the same place);
<b>no</b> if it names a different issue, even a plausible one in the same file; <b>unsure</b> otherwise.</p>
<p>Keys: <kbd>y</kbd> <kbd>n</kbd> <kbd>u</kbd> answer and move on, <kbd>j</kbd>/<kbd>k</kbd> or the arrows move, <kbd>e</kbd> writes a note (<kbd>Esc</kbd> leaves it).
Export downloads <code>owner-labels.jsonl</code>; it works offline and can be repeated.</p></details>`

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent)
const items = DATA.items
const KEY = 'agw-owner-session:' + DATA.sessionId
let saved = {}
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') } catch (e) { saved = {} }
let cur = 0
let onlyOpen = false
const $ = (id) => document.getElementById(id)
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch (e) {} }
const answered = (i) => !!saved[items[i].id]?.verdict
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
function section(parent, title) { parent.append(h('h3', '', title)) }
function codeBlock(lines) {
  const pre = h('pre', 'code')
  if (typeof lines === 'string') { pre.append(h('span', 'ln', lines)); return pre }
  for (const l of lines) {
    const row = h('span', 'ln' + (l.mark ? ' mark' : ''))
    row.append(h('i', '', String(l.n)), document.createTextNode(l.text))
    pre.append(row)
  }
  return pre
}
function diffBlock(text) {
  const pre = h('pre', 'code')
  for (const line of text.split('\\n')) {
    const k = line.startsWith('+') && !line.startsWith('+++') ? ' add' : line.startsWith('-') && !line.startsWith('---') ? ' del' : ''
    pre.append(h('span', 'ln' + k, line))
  }
  return pre
}
function render() {
  const item = items[cur]
  const box = $('item'); box.replaceChildren()
  const card = h('div', 'card')
  if (item.kind === 'case') {
    card.append(h('p', 'q', 'Is this a real defect that this commit created, at about this place?'))
    section(card, 'Repository and commit'); card.append(h('div', '', item.repo + ' — ' + item.introSubject))
    section(card, 'The claim' + (item.where ? ' (' + item.where + ')' : '')); card.append(h('div', 'claim', item.claim))
    section(card, 'Code as the commit left it'); card.append(codeBlock(item.code))
    section(card, 'The later fix: ' + item.fixSubject); card.append(diffBlock(item.fixDiff))
  } else {
    card.append(h('p', 'q', 'Does this finding describe this bug?'))
    section(card, 'The known bug (' + item.bug.where + ')'); card.append(h('div', 'claim', item.bug.description))
    card.append(codeBlock(item.bug.code))
    section(card, 'The finding'); const f = h('div'); f.append(h('span', 'tag', item.finding.tag), document.createTextNode(' ' + item.finding.where))
    card.append(f, h('div', 'claim', item.finding.message))
  }
  const a = saved[item.id] || {}
  const row = h('div', 'answers')
  for (const [v, label] of [['yes', 'y  Yes'], ['no', 'n  No'], ['unsure', 'u  Unsure']]) {
    const b = h('button', a.verdict === v ? 'on' : '', label); b.onclick = () => answer(v); row.append(b)
  }
  const note = h('textarea'); note.id = 'note'; note.placeholder = 'Note (e)'; note.value = a.note || ''
  note.oninput = () => { saved[item.id] = { ...(saved[item.id] || {}), note: note.value }; persist() }
  note.onkeydown = (e) => { if (e.key === 'Escape') note.blur() }
  card.append(row, note)
  box.append(card)
  const done = items.filter((_, i) => answered(i)).length
  $('progress').textContent = done + ' / ' + items.length + ' answered — item ' + (cur + 1)
  $('open').className = onlyOpen ? 'on' : ''
}
function move(dir) {
  for (let i = cur + dir; i >= 0 && i < items.length; i += dir) {
    if (!onlyOpen || !answered(i)) { cur = i; break }
  }
  render()
}
function answer(verdict) {
  const id = items[cur].id
  saved[id] = { ...(saved[id] || {}), verdict, at: new Date().toISOString() }
  persist(); move(1)
}
function exportLabels() {
  const lines = []
  for (const item of items) {
    const a = saved[item.id]
    if (!a || !a.verdict) continue
    const label = item.kind === 'case' ? { kind: 'case', candidateId: item.id } : { kind: 'pair', pairId: item.id }
    Object.assign(label, { verdict: a.verdict, at: a.at })
    if (a.note && a.note.trim()) label.note = a.note.trim()
    lines.push(JSON.stringify(label))
  }
  const url = URL.createObjectURL(new Blob([lines.join('\\n') + '\\n'], { type: 'application/x-ndjson' }))
  const link = h('a'); link.href = url; link.download = 'owner-labels.jsonl'
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  $('exported').textContent = lines.length + ' answers exported'
}
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return
  const k = e.key
  if (k === 'y') answer('yes')
  else if (k === 'n') answer('no')
  else if (k === 'u') answer('unsure')
  else if (k === 'j' || k === 'ArrowRight' || k === 'ArrowDown') move(1)
  else if (k === 'k' || k === 'ArrowLeft' || k === 'ArrowUp') move(-1)
  else if (k === 'e') { e.preventDefault(); $('note').focus() }
  else return
  if (k.startsWith('Arrow')) e.preventDefault()
})
$('open').onclick = () => { onlyOpen = !onlyOpen; render() }
$('export').onclick = exportLabels
render()`

/** The owner session as one self-contained HTML file: no network, no external fonts or scripts. */
export function renderSession(page: SessionPage): string {
  const notes = page.notes.length
    ? `<ul class="muted">${page.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner session</title><style>${STYLE}</style></head>
<body><main>
<header class="top"><b>Owner session</b><span id="progress" class="muted"></span><span class="grow"></span>
<button id="open" type="button">Unanswered only</button><button id="export" type="button">Export</button><span id="exported" class="muted"></span></header>
${INSTRUCTIONS}${notes}
<div id="item"></div>
</main>
<script type="application/json" id="data">${embed({ sessionId: page.sessionId, items: page.items })}</script>
<script>${SCRIPT}</script>
</body></html>
`
}

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
