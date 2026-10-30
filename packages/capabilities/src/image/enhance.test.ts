import { describe, expect, test } from 'bun:test'
import { DEFAULT_ROUTES as IMAGE_ROUTES } from '@agent-workflows/routes'
import type { Usage } from '../context.ts'
import { CapabilityCallError } from '../errors.ts'
import { createRegistry } from '../registry.ts'
import { fakeTransports } from '../testing/fake-transports.ts'
import { checkVerbatim, modeApplied, verbatimTokens } from './enhance.ts'
import { createImageCapabilities } from './index.ts'
import { composePlaybook, PLAYBOOK_VERSION } from './playbook.ts'

const route = IMAGE_ROUTES['image.enhance']
const plan = (overrides: Record<string, unknown> = {}) => ({
  intent: { detected: 'hero', confidence: 0.8 },
  prompt: 'Editorial photograph of a lighthouse at dusk, wide negative space above. No text.',
  additions: [{ slot: 'lighting', text: 'golden hour' }],
  assumptions: ['assumed a landscape crop'],
  warnings: [],
  proposed_settings: { model: 'auto', size: '1536x1024', quality: 'low', background: 'auto', n: 1 },
  ...overrides,
})
const reply = (value: unknown) => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  tokens: { input: 1000, output: 2000, cacheRead: 0, reasoning: 0 },
})

function enhance(replies: ReturnType<typeof reply>[], input: Record<string, unknown>) {
  const transports = fakeTransports({ openai: replies })
  const registry = createRegistry(createImageCapabilities({ env: {} }, { transports, env: {} }))
  const usage: Usage[] = []
  const run = () => registry.call('image.enhance', input, { addUsage: (u) => usage.push(u) })
  return { run, transports, usage }
}

describe('image.enhance', () => {
  test('a short brief is fully enhanced: the playbook is the system prompt, the route pins model, effort and ceiling, the call is priced', async () => {
    const { run, transports, usage } = enhance([reply(plan())], { brief: 'a lighthouse at dusk, blog header' })
    const out = await run()

    const first = transports.chatCalls[0]
    const wire = first?.wire
    // biome-ignore lint/suspicious/noExplicitAny: the request is asserted field by field
    const request = first?.request as Record<string, any>
    expect(wire).toBe('openai')
    expect(request).toMatchObject({ model: route.model, effort: 'high', maxOutputTokens: 32_000, json: true })
    expect(request.system).toStartWith(composePlaybook('auto'))
    expect(request.system).toContain('SINGLE JSON object')
    expect(request.prompt).toContain('Aggressiveness: FULL')
    expect(request.prompt).toContain('Brief: "a lighthouse at dusk, blog header"')

    expect(out).toMatchObject({
      prompt: plan().prompt,
      modeApplied: 'full',
      playbookVersion: PLAYBOOK_VERSION,
      enhanceModel: route.model,
      intent: { detected: 'hero' },
      settings: { endpoint: 'generate', model: 'flare', size: '1536x1024', quality: 'low', background: 'auto', n: 1 },
      additions: [{ slot: 'lighting', text: 'golden hour' }],
    })
    expect(out.assumptions).toEqual(['assumed a landscape crop', 'Routed to flare: a low-quality draft.'])
    // 196 output tokens at 1024x1024, scaled by 1536x1024 pixels, at 30 USD/M
    expect(out.estimatedCost?.perImageUsd).toBeCloseTo(((196 * 1.5) / 1e6) * 30, 10)
    // 1000 in x 0.10 + 2000 out x 0.50 USD/M
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ model: route.model, cost: 0.0011, costSource: 'rate' })
  })

  test('reference images make it an edit on the quality model; the settings are what image.generate takes', async () => {
    const { run } = enhance([reply(plan({ proposed_settings: { model: 'auto', quality: 'low' } }))], {
      brief: 'make it dusk',
      hasReferences: true,
    })
    const out = await run()
    expect(out.settings).toMatchObject({ endpoint: 'edit', model: 'sunburst' })
    expect(out.assumptions).toContain('Routed to sunburst: editing/reference precision.')
  })

  test('a final-quality proposal routes to the quality model; an explicit proposal is kept', async () => {
    expect(
      (await enhance([reply(plan({ proposed_settings: { quality: 'high' } }))], { brief: 'x' }).run()).settings.model,
    ).toBe('sunburst')
    const kept = await enhance([reply(plan({ proposed_settings: { model: 'flare', quality: 'max' } }))], {
      brief: 'x',
    }).run()
    expect(kept.settings.model).toBe('flare')
    expect(kept.assumptions.some((a) => a.startsWith('Routed'))).toBe(false)
  })

  test('a retired model in the proposal degrades to auto instead of failing the plan', async () => {
    const out = await enhance([reply(plan({ proposed_settings: { model: 'gpt-image-1.5', quality: 'low' } }))], {
      brief: 'x',
    }).run()
    expect(out.settings.model).toBe('flare')
  })

  test('a size the endpoint refuses snaps to the nearest preset, with a note', async () => {
    const out = await enhance([reply(plan({ proposed_settings: { size: '1500x1000', quality: 'low' } }))], {
      brief: 'x',
    }).run()
    expect(out.settings.size).toBe('1536x1024')
    expect(out.assumptions.at(-1)).toContain('"1500x1000"')
    expect(out.assumptions.at(-1)).toContain('snapped to 1536x1024')
  })

  test('the aggressiveness gate is by word count: under 25 full, 25-100 gaps, over 100 off; an explicit mode wins', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect([24, 25, 100, 101].map((n) => modeApplied('auto', words(n)))).toEqual(['full', 'gaps', 'gaps', 'off'])
    expect(modeApplied('off', words(3))).toBe('off')
    expect(modeApplied('full', words(500))).toBe('full')
  })

  test('passthrough never trusts the model with the prose: the brief is the prompt, plus its constraint block', async () => {
    const brief = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ')
    const { run, transports } = enhance(
      [reply(plan({ prompt: 'REWRITTEN', constraint_block: ' Keep the logo untouched. ' }))],
      { brief },
    )
    const out = await run()
    expect(out.prompt).toBe(`${brief}\n\nKeep the logo untouched.`)
    expect(out.additions).toEqual([])
    expect(out.modeApplied).toBe('off')
    expect(transports.chatCalls[0]?.request.prompt ?? '').toContain('PASSTHROUGH')
  })

  test('a pinned intent adds its playbook file and overrides the detected one', async () => {
    const { run, transports } = enhance([reply(plan({ intent: { detected: 'hero', confidence: 0.4 } }))], {
      brief: 'a leaf',
      intent: 'icon',
    })
    const out = await run()
    expect(transports.chatCalls[0]?.request.system).toStartWith(composePlaybook('icon'))
    expect(composePlaybook('icon')).not.toBe(composePlaybook('auto'))
    expect(out.intent).toEqual({ detected: 'icon', confidence: 0.4 })
  })

  test('warnings come through, a hard one included', async () => {
    const warning = { code: 'real_person', severity: 'hard' as const, message: 'names a real person' }
    expect((await enhance([reply(plan({ warnings: [warning] }))], { brief: 'x' }).run()).warnings).toEqual([warning])
  })

  test('an answer that is not the plan is asked for again once, with the reason; twice is INVALID_OUTPUT', async () => {
    const good = enhance([reply('not json at all'), reply(plan())], { brief: 'x' })
    expect((await good.run()).prompt).toBe(plan().prompt)
    expect(good.transports.chatCalls).toHaveLength(2)
    const second = good.transports.chatCalls[1]?.request.prompt ?? ''
    expect(second).toContain('RETRY')
    expect(second).toContain('not json at all')
    expect(good.usage).toHaveLength(2)

    const bad = enhance([reply({ prompt: '' }), reply('{"prompt": 1}')], { brief: 'x' })
    const error = await bad.run().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(CapabilityCallError)
    expect(error).toMatchObject({ code: 'INVALID_OUTPUT' })
    expect(bad.transports.chatCalls).toHaveLength(2)
  })

  test('the verbatim check finds the brief tokens the prompt dropped', () => {
    const brief = 'Logo for "Nordlicht" in #1A2B3C, 3 stars, by Anna'
    expect(verbatimTokens(brief).sort()).toEqual(['#1A2B3C', '3', 'Anna', 'Nordlicht'])
    expect(checkVerbatim(brief, 'A logo: Nordlicht, #1A2B3C, 3 stars, Anna')).toEqual({ ok: true, missing: [] })
    expect(checkVerbatim(brief, 'A logo with stars').missing.sort()).toEqual(['#1A2B3C', '3', 'Anna', 'Nordlicht'])
  })

  test('a brief-only call is unchanged: no iteration, style, series or pin sections, and the new settings take their defaults', async () => {
    const { run, transports } = enhance([reply(plan())], { brief: 'a lighthouse at dusk' })
    const out = await run()
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toBe(
      [
        "Aggressiveness: FULL. Fully enhance the brief per the playbook's canonical ordering, filling every reasonable gap (lighting, composition, medium, mood, style anchor).",
        'Detect the intent from the brief and report it as "intent.detected", choosing the closest match from the enum.',
        'Brief: "a lighthouse at dusk"',
      ].join('\n\n'),
    )
    expect(out.settings).toEqual({
      endpoint: 'generate',
      model: 'flare',
      size: '1536x1024',
      quality: 'low',
      background: 'auto',
      n: 1,
      moderation: 'auto',
      partialImages: 1,
    })
  })

  test('an iteration: the current prompt, the delta and the preserve list are in the request; the delta decides the gate', async () => {
    const current = 'A watercolour lighthouse at dusk, teal sea, "Nordlicht" painted on the hull. No text.'
    const { run, transports } = enhance([reply(plan({ prompt: 'REWRITTEN with the moon' }))], {
      currentPrompt: current,
      delta: 'add a moon',
      preserveList: ['the teal sea', 'the hull lettering'],
    })
    const out = await run()
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('Aggressiveness: FULL')
    expect(prompt).toContain('This is an iteration on an existing accepted prompt.')
    expect(prompt).toContain(`Current accepted prompt: "${current}"`)
    expect(prompt).toContain('Requested change (the delta): "add a moon"')
    expect(prompt).toContain(
      'Preserve list (must survive unchanged; re-state it in "constraint_block"): the teal sea, the hull lettering',
    )
    expect(prompt).toContain('Apply ONLY the delta')
    expect(prompt).not.toContain('Brief: ')
    expect(out.prompt).toBe('REWRITTEN with the moon')
    // the verbatim check reads what this round adds
    expect(out.verbatimCheck).toEqual({ ok: true, missing: [] })
  })

  test('an iteration without a delta is a verbatim re-run; passthrough keeps the current prompt, plus the constraint block', async () => {
    const current = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ')
    const { run, transports } = enhance(
      [reply(plan({ prompt: 'REWRITTEN', constraint_block: 'Keep the sea teal.' }))],
      {
        currentPrompt: current,
        mode: 'off',
      },
    )
    const out = await run()
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('treat as a verbatim re-run request')
    expect(prompt).toContain('PASSTHROUGH')
    expect(prompt).toContain('the current prompt')
    expect(out.prompt).toBe(`${current}\n\nKeep the sea teal.`)
    expect(out.modeApplied).toBe('off')
  })

  test('exactly one of brief and currentPrompt, and a delta only with a currentPrompt: a 400, nothing is called', async () => {
    for (const bad of [
      {},
      { brief: 'x', currentPrompt: 'y' },
      { brief: 'x', delta: 'z' },
      { delta: 'z' },
      { currentPrompt: 'y', delta: '' },
    ]) {
      const { run, transports } = enhance([reply(plan())], bad)
      expect(
        await run().then(
          () => undefined,
          (e: unknown) => e,
        ),
      ).toMatchObject({ status: 400 })
      expect(transports.chatCalls).toEqual([])
    }
  })

  test('a style guide is woven into the request; a fragment over 40 words is a 400', async () => {
    const { run, transports } = enhance([reply(plan())], {
      brief: 'a leaf',
      styleGuide: {
        promptFragment: 'flat vector, bold outlines',
        palette: ['#1A2B3C', '#FFEEDD'],
        avoid: ['gradients', 'text'],
        refImageCount: 2,
      },
    })
    await run()
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('weave this fragment verbatim into the prompt: "flat vector, bold outlines"')
    expect(prompt).toContain('Palette (verbatim hexes, do not alter): #1A2B3C, #FFEEDD')
    expect(prompt).toContain('Avoid: gradients, text')
    expect(prompt).toContain('2 style reference image(s) will ride along.')

    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect(
      (await enhance([reply(plan())], { brief: 'x', styleGuide: { promptFragment: words(40) } }).run()).prompt,
    ).toBeString()
    const tooLong = enhance([reply(plan())], { brief: 'x', styleGuide: { promptFragment: words(41) } })
    expect(
      await tooLong.run().then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toMatchObject({ status: 400 })
  })

  test('series context lists the prior prompts, and nothing of their settings', async () => {
    const { run, transports } = enhance([reply(plan())], {
      brief: 'a fox',
      seriesContext: [
        { prompt: 'A flat vector owl, teal and cream.', settings: { size: '1024x1024' } },
        { prompt: 'A flat vector hare, teal and cream.' },
      ],
    })
    await run()
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('belongs to an ongoing series')
    expect(prompt).toContain('- A flat vector owl, teal and cream.\n- A flat vector hare, teal and cream.')
    expect(prompt).not.toContain('1024x1024')
  })

  test('pinned overrides win over the proposal and are echoed verbatim into the settings', async () => {
    const { run, transports } = enhance(
      [
        reply(
          plan({
            proposed_settings: {
              model: 'flare',
              size: '1024x1024',
              quality: 'low',
              background: 'opaque',
              n: 3,
              moderation: 'auto',
              partial_images: 2,
            },
          }),
        ),
      ],
      {
        brief: 'x',
        overrides: {
          model: 'sunburst',
          size: '1536x640',
          quality: 'xhigh',
          background: 'transparent',
          n: 2,
          moderation: 'low',
          partialImages: 0,
        },
      },
    )
    const out = await run()
    expect(out.settings).toEqual({
      endpoint: 'generate',
      model: 'sunburst',
      size: '1536x640',
      quality: 'xhigh',
      background: 'transparent',
      n: 2,
      moderation: 'low',
      partialImages: 0,
    })
    // an explicit model is not a routing decision, so there is no routing note
    expect(out.assumptions.some((a) => a.startsWith('Routed'))).toBe(false)
    const prompt = transports.chatCalls[0]?.request.prompt ?? ''
    expect(prompt).toContain('The user has pinned these settings')
    expect(prompt).toContain('"moderation":"low"')
    expect(prompt).toContain('"partial_images":0')
    expect(prompt).not.toContain('partialImages')
  })

  test('a pinned auto model is still routed; an empty overrides object adds no section', async () => {
    const pinned = await enhance([reply(plan({ proposed_settings: { model: 'flare', quality: 'low' } }))], {
      brief: 'x',
      overrides: { model: 'auto', quality: 'high' },
    }).run()
    expect(pinned.settings).toMatchObject({ model: 'sunburst', quality: 'high' })
    expect(pinned.assumptions).toContain('Routed to sunburst: a high-quality final render.')

    const empty = enhance([reply(plan())], { brief: 'x', overrides: {} })
    await empty.run()
    expect(empty.transports.chatCalls[0]?.request.prompt ?? '').not.toContain('pinned')
  })

  test('input_fidelity never survives: neither model takes it, proposed or pinned, with a note', async () => {
    const proposed = await enhance([reply(plan({ proposed_settings: { input_fidelity: 'high' } }))], {
      brief: 'x',
      hasReferences: true,
    }).run()
    expect(proposed.settings).not.toHaveProperty('inputFidelity')
    expect(proposed.assumptions.some((a) => a.startsWith('Dropped input_fidelity'))).toBe(true)

    const pinned = await enhance([reply(plan())], {
      brief: 'x',
      hasReferences: true,
      overrides: { inputFidelity: 'low' },
    }).run()
    expect(pinned.settings).not.toHaveProperty('inputFidelity')
    expect(pinned.assumptions.some((a) => a.startsWith('Dropped input_fidelity'))).toBe(true)
  })

  test('previews need one image: an unpinned proposal of previews for n>1 is set to 0, a pinned one is kept', async () => {
    const corrected = await enhance([reply(plan({ proposed_settings: { n: 4, partial_images: 2, quality: 'low' } }))], {
      brief: 'x',
    }).run()
    expect(corrected.settings).toMatchObject({ n: 4, partialImages: 0 })
    expect(corrected.assumptions.some((a) => a.startsWith('Set partialImages to 0'))).toBe(true)

    const kept = await enhance([reply(plan({ proposed_settings: { n: 4, quality: 'low' } }))], {
      brief: 'x',
      overrides: { partialImages: 2 },
    }).run()
    expect(kept.settings).toMatchObject({ n: 4, partialImages: 2 })
  })

  test('an out-of-range brief is a 400, nothing is called', async () => {
    const { run, transports } = enhance([reply(plan())], { brief: '' })
    expect(
      await run().then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toMatchObject({ status: 400 })
    expect(transports.chatCalls).toEqual([])
  })
})
