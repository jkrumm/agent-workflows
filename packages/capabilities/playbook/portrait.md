# Portraits and Application Photos

Headshots, German Bewerbungsfotos, application, CV, LinkedIn and passport-style portraits. Where this file disagrees with `core.md`, `settings.md` or the aggressiveness instruction, this file wins. Verified on 2026-11-26: 13 of 13 sunburst edits of one real photo kept the identity (`policy.md`, Calibration).

## Rules (a reference photo is attached: an edit)

- **Describe only the delta the brief names.** Never add a change of posture, head tilt, expression, grooming, age, weight or skin on your own. A skin, posture or expression change is written only when the brief asks for it.
- An application photo or headshot brief implies two deltas of the format: reframing to head and shoulders, and studio relighting. It does not imply a new outfit. An unnamed background becomes a seamless neutral light-grey studio backdrop. A brief that asks for one change only ("change the jacket", "only the background") gets that one change and nothing else.
- "FULL" aggressiveness means writing the skeleton below completely. It never means more changes.
- **No film grain, no noise, no imperfection effects** on a headshot, although `core.md` suggests them for photorealism.
- One sentence per delta, each starting with its verb (Reframe, Replace the room with, Relight, Change only their outfit, Straighten their head), then the preserve sentence, then the constraint line.
- You do not see the photo: write "this person" and "their", unless the brief says otherwise. Do not invent what they wear or look like.

## Skeleton (a reference photo is attached)

1. `Edit this real photograph into a professional application headshot for a CV.` (add "(German Bewerbungsfoto)" when the brief is German or says Bewerbungsfoto)
2. `Reframe as a vertical head-and-shoulders portrait, eyes on the upper third, a little space above the hair.`
3. `Replace the room with a seamless neutral light-grey studio backdrop with a soft gradient.` (or the background the brief names)
4. `Relight them as a studio portrait: large soft key light from the front left, gentle fill from the right, no direct-flash shine on forehead and nose, neutral white balance.`
5. `Keep their clothing exactly as it is.` (or `Change only their outfit: replace ... with ....` when the brief asks for it)
6. The preserve sentence, copied word for word: `Preserve the person's identity exactly: facial features, face shape, proportions, age, skin texture with visible pores, eye colour, hairline, hairstyle, facial hair shape and length, and their expression. Do not beautify, slim, smooth or stylize the face.`
7. The constraint line, copied word for word: `Constraints: photorealistic, looks like a real camera photograph, natural skin, no beauty retouching, no text, no watermark.`

When the brief asks for a change the preserve sentence forbids (a straighter head, a different expression), drop only the clashing item from that sentence.

Optional deltas, only when the brief names them:

- Flash redness: `Even out the flash redness to their natural skin tone while keeping pores and texture.`
- Outfit: `Change only their outfit: a well-fitted dark navy wool blazer over a white shirt, collar open, no tie.`
- Background: light-grey seamless, dark charcoal with rim light, or a softly blurred bright office with window light from the left.
- Posture: `Straighten their head so it is upright, no sideways tilt; same expression.`

## No reference photo

Generating a portrait of an invented person is an ordinary photorealistic brief: the same framing and light, no preserve sentence. A named real person without a reference stays a hard wall (`policy.md`).

## Settings

- Size 4:5 tall. Draft: `1024x1280`, quality `low`. Final (the brief asks for a final or print): `1600x2000`, quality `high`.
- `n: 1`, unless the brief asks for variants.
- Background `auto`, never transparent unless asked.
- In `assumptions`, note: pass the uncropped original (long edge about 2048 px, jpeg) as the reference, and branch every variant from the original, never from an output.
