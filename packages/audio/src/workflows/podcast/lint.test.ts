import { describe, expect, test } from 'bun:test'
import { ASK_COVERAGE_MIN, askCoverage, assignAsks } from './asks.ts'
import { expressionSummary, lintNotes, lintSegmentation, lintSegments, renderLintReport } from './lint.ts'
import type { ScriptSegment } from './script.ts'

const seg = (turns: Array<['A' | 'B', string]>): ScriptSegment => ({
  title: 't',
  turns: turns.map(([speaker, text]) => ({ speaker, text })),
})
const rules = (segments: ScriptSegment[], opts = {}): string[] =>
  lintSegments(segments, opts).findings.map((f) => f.rule)

describe('lintSegments', () => {
  test('flags a turn that opens by repeating the previous turn', () => {
    const s = seg([
      ['A', 'Um die zu übernehmen, brauchte es einen Sweeper von gut zweitausend Zeilen.'],
      ['B', 'Zweitausend Zeilen. Und trotzdem ist DBOS bei ihnen noch drin.'],
    ])
    expect(rules([s])).toContain('echo-reaction')
  })

  test('does not flag a short reaction that adds a new word', () => {
    const s = seg([
      ['A', 'Der Sweeper ist gut zweitausend Zeilen lang.'],
      ['B', 'Wer pflegt den eigentlich?'],
    ])
    expect(rules([s])).not.toContain('echo-reaction')
  })

  test('flags a lecture turn over the monologue limit', () => {
    const long = Array.from({ length: 140 }, (_, i) => `wort${i}`).join(' ')
    expect(
      rules([
        seg([
          ['A', long],
          ['B', 'Ok?'],
        ]),
      ]),
    ).toContain('monologue')
  })

  test("flags stock phrases, and a second 'Stell dir vor'", () => {
    const s = seg([
      ['A', 'Nicht zuletzt zählt der Preis.'],
      ['B', 'Stell dir vor, es läuft.'],
      ['A', 'Stell dir vor, es bricht.'],
    ])
    const found = lintSegments([s]).findings.filter((f) => f.rule === 'stock-phrase')
    expect(found.map((f) => f.turnIndex)).toEqual([0, 2])
  })

  test('flags a long segment where nobody asks anything, and metronomic turn lengths', () => {
    const turns: Array<['A' | 'B', string]> = Array.from({ length: 10 }, (_, i) => [
      i % 2 === 0 ? 'A' : 'B',
      'Das ist ein Satz mit genau acht Wörtern drin.',
    ])
    const found = rules([seg(turns)])
    expect(found).toContain('no-questions')
    expect(found).toContain('uniform-turns')
  })

  test('a segment with questions and varied turns raises neither', () => {
    const turns: Array<['A' | 'B', string]> = [
      [
        'A',
        'Kurz die Lage: drei Dienste, ein Vertrag, und der läuft Ende des Monats aus, weshalb wir heute entscheiden müssen.',
      ],
      ['B', 'Und wer bezahlt das?'],
      ['A', 'Du.'],
      ['B', 'Okay, und wenn wir wechseln, was bricht dann zuerst, die Anbindung oder die Abrechnung?'],
      ['A', 'Die Abrechnung.'],
      ['B', 'Warum?'],
      ['A', 'Weil sie als Einziges ohne Test läuft, und genau da ist die Lücke, die wir kennen.'],
      ['B', 'Gut.'],
    ]
    const found = rules([seg(turns)])
    expect(found).not.toContain('no-questions')
    expect(found).not.toContain('uniform-turns')
  })

  test('an acronym used without an introducing clause is flagged once; an introduced one is not', () => {
    const bare = seg([
      ['A', 'ADR einhundertneunzehn sagt etwas anderes.'],
      ['B', 'Und ADR einhundertvier?'],
    ])
    const found = lintSegments([bare]).findings.filter((f) => f.rule === 'unintroduced-term')
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('ADR')

    const introduced = seg([
      ['A', 'Dazu gibt es Architecture Decision Records, kurz ADR. ADR einhundertneunzehn sagt etwas anderes.'],
    ])
    expect(rules([introduced])).not.toContain('unintroduced-term')
  })

  test('glossary terms count as terms to introduce, host names do not', () => {
    const s = seg([['A', 'Jonas und Lena fragen: Das Sweeper-Problem ist alt.']])
    expect(rules([s], { glossaryTerms: ['Sweeper-Problem'], hostNames: ['Jonas', 'Lena'] })).toContain(
      'unintroduced-term',
    )
    expect(rules([s], { hostNames: ['Jonas', 'Lena'] })).not.toContain('unintroduced-term')
  })

  test('single CAPS emphasis words are not acronyms when the source does not spell them in caps', () => {
    const s = seg([['A', 'Das ist KEIN Run, sondern ein Zustand, und DBOS merkt sich ihn.']])
    const found = lintSegments([s], { source: 'Wir nutzen DBOS für Workflows.' }).findings.filter(
      (f) => f.rule === 'unintroduced-term',
    )
    expect(found.map((f) => f.message.match(/"([^"]+)"/)?.[1])).toEqual(['DBOS'])
  })

  test('speech tags are ignored by every rule', () => {
    const s = seg([['A', 'Dazu gibt es Records, <short pause> kurz ADR.']])
    expect(rules([s])).toEqual([])
  })
})

describe('report rendering and notes', () => {
  test('only stock phrases and unintroduced terms become writer notes', () => {
    const report = lintSegments([
      seg([
        ['A', 'Nicht zuletzt zählt ADR.'],
        ['B', 'ADR.'],
      ]),
    ])
    const notes = lintNotes(report)
    expect(notes.every((n) => n.reviewer === 'lint' && n.segmentIndex === 0)).toBe(true)
    expect(notes.length).toBeGreaterThan(0)
    expect(renderLintReport(report)).toContain('words/turn')
  })
})

const words = (n: number, prefix = 'wort'): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
const dseg = (turns: Array<['A' | 'B', string, string?]>): ScriptSegment => ({
  title: 't',
  turns: turns.map(([speaker, text, delivery]) => ({ speaker, text, ...(delivery && { delivery }) })),
})

describe('expression lint', () => {
  test('flags a tag outside the allowlist', () => {
    expect(rules([dseg([['A', `${words(14)} <sniff> ${words(5)}`]])])).toContain('tag-not-allowed')
    expect(rules([dseg([['A', `${words(14)} <short pause> ${words(5)}`]])])).not.toContain('tag-not-allowed')
  })

  test('flags a tag as the first word of a short turn, not of a long one', () => {
    expect(rules([dseg([['A', `<laugh> ${words(4)}`]])])).toContain('tag-leads-short-turn')
    expect(rules([dseg([['A', `<laugh> ${words(20)}`]])])).not.toContain('tag-leads-short-turn')
  })

  test('flags adjacent tags', () => {
    expect(rules([dseg([['A', `${words(14)} <short pause> <laugh> ${words(5)}`]])])).toContain('tags-adjacent')
  })

  test('measures tags per ten turns against the band, only on segments long enough', () => {
    const plain = (n: number): Array<['A' | 'B', string]> =>
      Array.from({ length: n }, (_, i) => [i % 2 ? 'B' : 'A', `${words(10 + (i % 5) * 7, `w${i}x`)}?`])
    expect(rules([dseg(plain(12))])).toContain('tags-below-band')
    expect(rules([dseg(plain(8))])).not.toContain('tags-below-band')
    const tagged = plain(12).map(([s, t]): ['A' | 'B', string] => [
      s,
      `${t} <short pause> ${words(4, 'z')} <short pause> ${words(3, 'q')}`,
    ])
    expect(rules([dseg(tagged)])).toContain('tags-above-band')
    const balanced = plain(12).map(([s, t], i): ['A' | 'B', string] => [
      s,
      i % 4 === 0 ? `${t} <short pause> ${words(12, 'y')}` : t,
    ])
    const found = rules([dseg(balanced)])
    expect(found).not.toContain('tags-below-band')
    expect(found).not.toContain('tags-above-band')
  })

  test('flags a delivery outside the vocabulary and one on a short line', () => {
    expect(rules([dseg([['A', words(12), 'furious']])])).toContain('delivery-unknown')
    expect(rules([dseg([['A', words(3), 'curious']])])).toContain('delivery-short-turn')
    expect(rules([dseg([['A', words(12), 'curious']])])).not.toContain('delivery-short-turn')
  })

  test('flags the same non-baseline delivery on three consecutive turns, once', () => {
    const d = (n: number): ['A' | 'B', string, string] => [n % 2 ? 'B' : 'A', words(12, `s${n}x`), 'amused']
    const found = lintSegments([dseg([d(0), d(1), d(2), d(3)])]).findings.filter((f) => f.rule === 'delivery-streak')
    expect(found.map((f) => f.turnIndex)).toEqual([2])
    expect(rules([dseg([d(0), d(1), ['A', words(12, 'gap'), undefined], d(3)])])).not.toContain('delivery-streak')
  })

  test('flags more than one CAPS emphasis in a turn but not source acronyms or host names', () => {
    expect(rules([dseg([['A', 'Das ist KEIN Run und auch NICHT schnell.']])])).toContain('caps-emphasis')
    expect(rules([dseg([['A', 'Das ist KEIN Run.']])])).not.toContain('caps-emphasis')
    expect(rules([dseg([['A', 'DBOS und AGPL laufen.']])], { source: 'DBOS AGPL' })).not.toContain('caps-emphasis')
  })

  test('counts tags and deliveries into the metrics and the profile summary', () => {
    const report = lintSegments([
      dseg([
        ['A', `${words(14)} <short pause> ${words(5)}`, 'curious'],
        ['B', 'Ja.'],
      ]),
    ])
    expect(report.metrics[0]).toMatchObject({ tags: 1, deliveries: 1 })
    expect(expressionSummary(report)).toMatchObject({ tags: 1, deliveries: 1, findings: {} })
  })
})

describe('lintSegmentation', () => {
  const texts = ['Wie geht das?', 'So geht das.', 'Und dann?', 'Dann passiert das.', 'Neue Sache.']
  test('reports unit count and size spread', () => {
    const r = lintSegmentation({
      texts,
      segmentLengths: [5],
      units: [{ turnIndexes: [0, 1] }, { turnIndexes: [2, 3, 4] }],
      maxChars: 3000,
    })
    expect(r).toMatchObject({ units: 2, minChars: 25, maxChars: 38, findings: [] })
  })

  test('flags a unit over the limit, a cross-segment unit and a split question', () => {
    const over = lintSegmentation({
      texts: ['x'.repeat(60), 'y'.repeat(60)],
      segmentLengths: [2],
      units: [{ turnIndexes: [0, 1] }],
      maxChars: 100,
    })
    expect(over.findings[0]).toContain('over the 100 limit')
    const across = lintSegmentation({
      texts,
      segmentLengths: [2, 3],
      units: [{ turnIndexes: [0, 1, 2] }, { turnIndexes: [3, 4] }],
      maxChars: 3000,
    })
    expect(across.findings.some((f) => f.includes('spans a segment boundary'))).toBe(true)
    const split = lintSegmentation({
      texts,
      segmentLengths: [5],
      units: [{ turnIndexes: [0, 1, 2] }, { turnIndexes: [3, 4] }],
      maxChars: 3000,
    })
    expect(split.findings).toEqual(['unit 0: ends on a question whose answer opens unit 1'])
  })

  test('a single over-long turn is not a finding', () => {
    expect(
      lintSegmentation({ texts: ['x'.repeat(500)], segmentLengths: [1], units: [{ turnIndexes: [0] }], maxChars: 100 })
        .findings,
    ).toEqual([])
  })
})

describe('conversation rules', () => {
  test('a host that only prompts is flagged, a balanced segment is not', () => {
    const lecture = words(40, 'lec')
    const lopsided: Array<['A' | 'B', string]> = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? ['A', `${lecture} ${i}?`] : ['B', 'Und?'],
    )
    expect(rules([seg(lopsided)])).toContain('host-imbalance')
    const balanced: Array<['A' | 'B', string]> = Array.from({ length: 10 }, (_, i) => [
      i % 2 === 0 ? 'A' : 'B',
      `${lecture} ${i}?`,
    ])
    expect(rules([seg(balanced)])).not.toContain('host-imbalance')
  })

  test("two hedges are fine, the third is a tic; 'in deinen Notizen' as a source of knowledge is not ignorance", () => {
    const hedge = (): ['A' | 'B', string] => ['A', 'Das wissen wir nicht.']
    expect(rules([seg([hedge(), hedge()])])).not.toContain('meta-hedge')
    expect(rules([seg([hedge(), hedge(), hedge()])])).toContain('meta-hedge')
    expect(rules([seg([['A', 'In deinen Notizen steht, dass der Dienst auf dem Mini läuft.']])])).not.toContain(
      'notes-ignorance',
    )
    expect(rules([seg([['A', 'Ob bei dir jemand schwanger ist, steht nicht in deinen Notizen.']])])).toContain(
      'notes-ignorance',
    )
  })

  test('notes-as-ignorance and meta-hedge findings become writer notes', () => {
    const s = seg([
      ['A', 'Ob bei dir jemand schwanger ist, steht nicht in deinen Notizen.'],
      ['B', 'Das wissen wir nicht.'],
      ['A', 'Das wissen wir nicht.'],
      ['B', 'Das wissen wir nicht.'],
    ])
    const notes = lintNotes(lintSegments([s]))
    expect(notes.some((n) => n.note.includes('Notizen'))).toBe(true)
    expect(notes.some((n) => n.note.includes('Das wissen wir nicht'))).toBe(true)
  })

  test('research named as having come up empty is flagged, a real finding is not', () => {
    expect(rules([seg([['A', 'Dazu haben wir leider nichts gefunden.']])])).toContain('research-gap')
    expect(rules([seg([['A', 'Dazu konnten wir online nichts herausfinden.']])])).toContain('research-gap')
    expect(rules([seg([['A', 'Wir haben dazu keine Informationen gefunden.']])])).toContain('research-gap')
    expect(rules([seg([['A', 'Wir haben dazu einen guten Artikel gefunden.']])])).not.toContain('research-gap')
  })

  test('subject-first word order and an umlaut word in the gap are also caught', () => {
    expect(rules([seg([['A', 'Wir haben dazu nichts gefunden.']])])).toContain('research-gap')
    expect(rules([seg([['A', 'Wir konnten dazu nichts finden.']])])).toContain('research-gap')
    expect(rules([seg([['A', 'Dazu haben wir tatsächlich nichts gefunden.']])])).toContain('research-gap')
  })
})

describe('asks and opening frame', () => {
  const ask = 'Darf ich rohe Karotten ungewaschen essen?'
  const verdict = seg([
    ['A', 'Rohe Karotten ungewaschen essen: ja, das geht, solange die Erde ab ist.'],
    ['B', 'Und die Schale?'],
  ])
  const offTopic = seg([
    ['A', 'Das Grün der Möhre eignet sich für Pesto.'],
    ['B', 'Wirklich?'],
  ])

  test('an ask with a verdict turn is covered, one without is flagged and becomes a writer note', () => {
    expect(rules([verdict], { asks: [{ ask, segmentIndex: 0 }] })).not.toContain('ask-uncovered')
    const report = lintSegments([offTopic], { asks: [{ ask, segmentIndex: 0 }] })
    expect(report.findings.map((f) => f.rule)).toContain('ask-uncovered')
    expect(lintNotes(report).some((n) => n.note.includes('gives a verdict'))).toBe(true)
  })

  test('an ask owned by a segment that does not exist is flagged', () => {
    const found = lintSegments([verdict], { asks: [{ ask, segmentIndex: 3 }] }).findings.filter(
      (f) => f.rule === 'ask-uncovered',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('does not exist')
  })

  test('the first turns must frame what the episode answers', () => {
    const framed = seg([
      ['A', 'Heute geht es darum, ob rohe Karotten ungewaschen essbar sind.'],
      ['B', 'Gute Frage.'],
    ])
    expect(rules([framed], { openingFrame: [ask] })).not.toContain('opening-unframed')
    expect(rules([offTopic], { openingFrame: [ask] })).toContain('opening-unframed')
    expect(rules([offTopic], { openingFrame: [] })).not.toContain('opening-unframed')
  })
})

describe('askCoverage / assignAsks', () => {
  const rawCarrot = 'Darf ich rohe Karotten ungewaschen essen?'
  const kiwi = 'Kann ich Kiwi mit Schale essen?'

  test('measures the share of distinctive words, prefix-matched', () => {
    expect(askCoverage(rawCarrot, 'Rohe Karotten aus der Tüte, ungewaschen: das ist okay')).toBeGreaterThan(0.5)
    expect(askCoverage(rawCarrot, 'Das Grün der Möhre eignet sich für Pesto')).toBeLessThan(0.2)
    expect(askCoverage('', 'irgendwas')).toBe(1)
    expect(ASK_COVERAGE_MIN).toBeGreaterThan(0)
  })

  test('gives every ask to exactly one segment, by overlap with title, goal and key facts', () => {
    const segments: Array<{ title: string; goal: string; keyFacts: string[]; answers?: string[] }> = [
      { title: 'Karotten', goal: 'rohe Karotten ungewaschen', keyFacts: ['Erde'] },
      { title: 'Kiwi', goal: 'Kiwi mit Schale', keyFacts: ['Haare'] },
    ]
    const out = assignAsks(segments, [rawCarrot, kiwi])
    expect(out.map((s) => s.answers)).toEqual([[rawCarrot], [kiwi]])
    expect(assignAsks(segments, []).every((s) => s.answers?.length === 0)).toBe(true)
  })

  test("keeps the outline writer's assignment when it named the ask, even paraphrased", () => {
    const none: string[] = []
    const segments = [
      { title: 'x', goal: 'y', keyFacts: none, answers: ['Rohe Karotten ungewaschen essen'] },
      { title: 'z', goal: 'w', keyFacts: none, answers: ['Kiwi mit Schale essen'] },
    ]
    expect(assignAsks(segments, [kiwi, rawCarrot]).map((s) => s.answers)).toEqual([[rawCarrot], [kiwi]])
  })

  test('the segment whose own answer matches best claims the ask, not the first loose overlap', () => {
    const peel = 'Muss ich Karotten schälen oder darf ich sie waschen?'
    const wash = 'Muss ich Karotten waschen und schrubben?'
    const none: string[] = []
    const segments = [
      { title: 'a', goal: 'b', keyFacts: none, answers: [peel] },
      { title: 'c', goal: 'd', keyFacts: none, answers: [wash] },
    ]
    expect(assignAsks(segments, [peel, wash]).map((s) => s.answers)).toEqual([[peel], [wash]])
  })

  test('an ask nobody names goes to the best textual fit; all-zero overlap falls to segment 0; no segments drops nothing silently', () => {
    const none: string[] = []
    const blank = { title: 'x', goal: 'y', keyFacts: none, answers: none }
    const out = assignAsks([blank, { ...blank, title: 'z', goal: 'w' }], ['Etwas völlig anderes?'])
    expect(out.map((s) => s.answers)).toEqual([['Etwas völlig anderes?'], []])
    expect(assignAsks([], ['Frage?'])).toEqual([])
  })
})
