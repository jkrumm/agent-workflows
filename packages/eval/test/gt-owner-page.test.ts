import { describe, expect, test } from 'bun:test'
import { type PageItem, renderSession } from '../src/index.ts'

const items: PageItem[] = [
  {
    kind: 'case',
    id: 'repo-aaaaaaaaaa-bbbbbbbbbb',
    repo: 'SourceRoot/demo',
    introSubject: 'feat: add parser',
    where: 'src/a.ts:3-4',
    claim: 'Off by one </script><script>alert(1)</script> in the loop',
    fixSubject: 'fix: loop bound',
    code: [
      { n: 2, text: 'const x = 1', mark: false },
      { n: 3, text: 'for (let i = 0; i <= n; i++) {', mark: true },
    ],
    fixDiff: '-for (let i = 0; i <= n; i++) {\n+for (let i = 0; i < n; i++) {',
  },
  {
    kind: 'pair',
    id: 'case-1:run-1:0',
    bug: { where: 'src/a.ts:3', description: 'Off by one', code: '(code unavailable: no such file)' },
    finding: { tag: 'important', where: 'src/a.ts:3', message: 'The loop runs once too often' },
  },
]

const dataOf = (html: string) => {
  const match = /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)
  return JSON.parse(match?.[1] ?? 'null')
}

describe('renderSession', () => {
  const html = renderSession({
    sessionId: 's1',
    items,
    notes: ['Finding items: 4 of 10 requested exist; all are shown.'],
  })

  test('is one self-contained file: nothing is fetched from anywhere', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<link\b|<img\b|<iframe\b|\ssrc=|@import|url\(/)
    expect(html.match(/<script\b/g)).toHaveLength(2)
  })

  test('is blind: no word of the sampling truth or the judge class on the page', () => {
    expect(html).not.toMatch(/accepted|rejected/i)
    expect(html).not.toMatch(/judgeClass|"match"|not-a-bug/)
    expect(Object.keys(dataOf(html).items[1]).sort()).toEqual(['bug', 'finding', 'id', 'kind'])
  })

  test('item text cannot close the data script', () => {
    expect(dataOf(html).items[0].claim).toContain('</script>')
    expect(html.match(/<\/script>/g)).toHaveLength(2)
  })

  test('carries the keys, the filter, the export file and the colour schemes', () => {
    expect(html).toContain("'owner-labels.jsonl'")
    for (const key of ["'y'", "'n'", "'u'", "'j'", "'k'", "'e'"]) expect(html).toContain(key)
    expect(html).toContain('Unanswered only')
    expect(html).toContain('prefers-color-scheme:dark')
    expect(html).toContain('localStorage')
    expect(html).toContain('Finding items: 4 of 10 requested exist; all are shown.')
  })

  test('cannot reach anything: a CSP allows inline script and style only', () => {
    expect(html).toContain(`content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"`)
  })

  test('says so when the browser will not store answers, and tags every export line with its session', () => {
    expect(html).toMatch(/id="warn"[^>]*hidden/)
    expect(html).toContain('answers are not saved')
    expect(html).toContain('sessionId: DATA.sessionId')
  })
})
