# Icons, Logos, Flat Graphics

- Trigger vocabulary: _flat design, vector-like shapes, strong silhouette, balanced negative space, minimal strokes, no gradients unless essential, plain background, single centered subject_.
- Always include _"original, non-infringing"_. Describe brand personality before visual elements ("warm, simple, timeless").
- Demand small-size legibility: _"reads clearly at small and large sizes — avoid fine detail or busy backgrounds"_.
- Square 1024×1024; _"no text unless specified"_.
- **A logo or app icon is a mark, and a mark needs five things committed in the prompt, in this order:**
  1. **Style first** — open with it ("flat vector mark", "bold geometric glyph"), one committed style, no mixing.
  2. **The exact subject count** — "one single leaf", "exactly three stars". Counts above 5 drift (see `core.md`); a model can still miss a small count, so name it once and keep it ≤5.
  3. **How much of the tile it fills** — a number: "fills about 70% of the tile, centered, even margin on all sides", so a launcher mask or rounded corner does not cut it.
  4. **Large simple forms that survive 16 px** — few shapes, thick strokes, high contrast against the ground, no hairlines, no small inner detail, no texture.
  5. **No text** — "no text, no lettering, no wordmark" unless the brief quotes the exact text to render.
- A logo brief that gives a name or a phrase but no quoted text still gets item 5: the name is context, not lettering.
- For a favicon or `image-icon` set, derive **flat colour fills with no gradient, glow, metallic sheen or soft shadow**: those vectorize to nothing usable (an SVG over 64 KB is dropped). If the brief asks for metallic or gradient art, say in `assumptions` that the favicon needs a separate flat derivative.
- For an edit of an accepted mark (`--images`), describe only the delta and keep-list the rest: _"Change only the colour of the leaf to deep green. Keep the shape, the proportions, the fill of the tile and the flat style exactly."_
- **Transparency is available** — both generatable models have a real alpha channel. Derive `background: "transparent"` with `output_format: "png"` (or `"webp"` — jpeg has no alpha and is rejected), and describe an isolated subject with no background scenery in the prompt. See `settings.md` → "Background treatment".
