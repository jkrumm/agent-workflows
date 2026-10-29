# Core Principles

Cross-cutting prompting doctrine that applies regardless of the detected intent. `composePlaybookSystemPrompt` (`shared/src/playbook.ts`) always leads with this file, then `settings.md`, then `policy.md`, then the files for the detected/requested intent (`icons.md`, `hero.md`, `painterly.md`, `technical.md`, `article.md`, `diagram.md`, `figure-art.md`).

## Core principles

1. **Natural-language prose, not keyword tags.** GPT Image models read descriptive sentences. Midjourney-style tag spam ("8k, masterpiece, trending on artstation") is noise. Short labeled segments or line breaks are fine; comma-soup is not.
2. **Ambiguity is the enemy.** Whatever the prompt leaves open, the model decides — confidently and often wrongly. Every property mentioned should have exactly one committed value. Never hedge ("such as", "for example", "or similar").
3. **Constraints beat descriptions.** A 60-word prompt with tight constraints outperforms a 200-word adjective pile. Target ~60–120 words for a fully enhanced prompt (constraint block excluded).
4. **Describe the job, not just the picture.** State the intended use early ("hero banner for a blog", "app icon", "UI mock", "infographic") — it sets the model's mode and polish level.
5. **Medium/type first.** Open with the image type: photo, oil painting, watercolor, illustration, vector, 3D render.
6. **Canonical ordering:** medium/type → scene/background → subject (lead with the concrete noun) → key details (composition/camera, lighting, palette/mood, style anchor) → exact text + typography → constraint block → the size/aspect intent.
7. **Iterate like a director, not a gambler.** Base composition first, then lighting, then detail/clutter passes. Draft at `quality: low` (~$0.006), finalize at `high` (~$0.053, ~9×) only when the composition is right; reserve `xhigh`/`max` (~$0.094/~$0.211) for an explicit "print / maximum detail" request.

## Photorealism

- Include the word _"photorealistic"_ or _"real photograph / taken on a real camera / iPhone photo"_.
- Counter the AI look explicitly: _"real textures, natural skin, real fabric; no illustration, no CGI look; no beauty-retouching look; keep lighting neutral (avoid warm yellow tint)"_ plus imperfection signals (_subtle film grain, natural noise, visible pores_).

## Negative constraints (there is no negative-prompt parameter)

- Express exclusions inside the prompt, as a terminal constraint block: `Constraints: [what must not change], no watermark, no extra text, no logos, no clutter, no distortion.`
- Prefer **affirmative phrasing** over negation where a positive exists — negation both mis-steers the model and (for sensitive nouns) trips the moderation classifier (see `policy.md`). "Plain background" beats "no busy background"; "wearing a full-coverage leotard" beats "not nude".
- Defensive prompting against the model's default shortcuts: _"Do not stylize the face. Do not cartoonize."_ when realism matters.

## Series consistency

- Re-attach the reference image(s) on **every** call; reference inputs by index (_"Image 1: the product photo. Image 2: style reference — borrow its palette and lighting only."_).
- Repeat a **preserve list** on every iteration: _"Preserve facial features, proportions, age, skin texture, hairstyle, and expression exactly."_ Describe only the delta; keep-list everything else (_"change only the background; keep everything else the same"_).
- Reuse the series' established vocabulary verbatim (medium, lighting, palette words) — vary only the declared difference.
- Chained edits degrade (noise amplification after ~3–5 generations): branch from the original base image, not from the latest output. "Subtle refinements only, preserve original style, minimal changes" for touch-ups.

## Text in images

- gpt-image-2.5 (flare/sunburst) renders Latin text at ~95–99% accuracy; older models are unreliable.
- Quote literal text: `Headline: "SUMMER COLLECTION"`. Unquoted text is treated as a suggestion.
- Specify typography: font feel, weight, color, placement. Spell tricky words letter-by-letter. List each language explicitly for multilingual text.
- If spelling fails: less text, larger type, regenerate. Text-heavy → `quality: high` (worth the cost — see `settings.md`).

## Camera and lighting vocabulary

- Camera terms are **look-and-feel signals, not optical simulation**. Reliable: focal-length classes (35mm natural / 50mm neutral / 85mm portrait compression), framing (close-up, wide shot, flat lay, top-down, low angle, eye level), aperture _behavior_ ("shallow depth of field, f/1.8 feel" vs "everything in focus"), film stocks as style anchors ("shot on 35mm film", "Kodachrome").
- Lighting: give **direction**, not just quality — _"soft window light from the left, shadows falling right"_; named patterns (three-point, rim light, Rembrandt, golden hour) are recognized.
- Depth: name foreground / midground / background contents explicitly.

## Failure modes quick reference

| Failure                                           | Mitigation                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mangled hands/anatomy                             | "anatomically correct hands, natural hand position"; avoid extreme poses; hide hands compositionally |
| AI look (plastic skin, warm tint, oversaturation) | Photorealism counters above; quality high for portraits                                              |
| Text gibberish                                    | See "Text in images" above; use `quality: high` or above for text-heavy work                         |
| Wrong object counts                               | Keep counts ≤5; don't rely on numbering                                                              |
| Iterative drift / overcooking                     | Branch from the base image; preserve lists; "subtle refinements only"                                |
| Strict isometric drift                            | Treat as style cue, not projection; post-cleanup for precision (see `technical.md`)                  |
| Waiting for N streaming partials                  | Upstream may send fewer than requested — never build UI that waits for a fixed count                 |
