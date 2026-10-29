# Content-Policy Boundaries (Compliance Craft)

Purpose: predict refusals before spending a request, and phrase **policy-compliant** work so it isn't false-positive refused. Never an evasion tool — hard categories stay hard, and the enhancer warns instead of contorting.

Craft guidance for the sensitive-but-allowed artistic subjects (figure studies, dance, fashion/latex editorial, fine-art rope work, implied/draped figures) lives separately in `figure-art.md` — this file stays mechanics-and-triggers only.

## Mechanics

Moderation runs in two stages: an input classifier on the prompt (and on edit reference images) and an output classifier on the generated image. Input blocks are deterministic — the same prompt always fails; retrying is futile; rewrite instead. Output blocks are scene-level — rewording alone won't fix them; change composition/coverage/medium. The API error is `moderation_blocked` (`image_generation_user_error`; arrives 503-wrapped through our upstream as a **string-prefixed body** — extract the embedded JSON — never retried by the gateway) with `moderation_details: { moderation_stage: input|output, categories }` (categories coarse; `"other"` observed). The `moderation: low` parameter reduces false positives on artistic/classical subjects but moves no hard boundary; probe-verified: **accepted on `/images/edits`** by every model checked so far (gpt-image-2, gpt-image-1.5, and both `gpt-image-2.5-flare`/`-sunburst` as of 2026-09-23).

## Calibration (probe-verified 2026-07-17)

Our upstream is more permissive than public-API reports: a photoreal named-celebrity portrait generated fine, while a living-artist style blocked at input and a franchise character blocked at output. The trigger tables below describe _public-API_ behavior — treat pre-check verdicts as advisory warnings, not gates, except for the hard walls.

## Hard boundaries — warn, don't rewrite

Explicit sexual content; anything involving minors combined with realism (never combine minors + photorealism + close-up even innocuously); photorealistic identifiable real people (generation or edit — the classifier can't verify consent, including for the user's own photo); individual living artists' styles by name; realistic gore; hate symbols.

## False-positive triggers and rewrites

| Trigger                                                                        | Rewrite strategy                                                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Living artist name                                                             | Studio/movement/era + three style adjectives + medium ("Studio Ghibli style", "ukiyo-e woodblock") |
| Celebrity / real person                                                        | Described archetype if likeness isn't the point; otherwise warn — hard boundary                    |
| Franchise characters (stricter than DALL·E 3 was)                              | Generic visual traits, original character in the genre style                                       |
| Arousal-coded adjectives ("sexy", "seductive", "revealing", "tight", "skimpy") | Craft vocabulary: elegant, sculptural, tailored, fitted, high-fashion editorial                    |
| Negated sensitive nouns ("no nudity")                                          | Strip the negation; state attire affirmatively ("draped in floor-length ivory silk")               |
| Weapon/violence nouns in realistic register                                    | Stylized/cinematic/historical-illustration framing; motion and lighting instead of gore            |
| Reference photo with a real face or visible skin (edits)                       | Warn up front; suggest stylized source or generation instead                                       |
| Non-English prompt with ambiguous terms                                        | Offer the English translation                                                                      |
| Trivially innocent prompt blocked                                              | Possible upstream moderation incident — retry later, don't contort                                 |

## Enhancer duties

Run the pre-check on every brief; annotate the risk and the rewrite it applied (visibly, in `assumptions`); suggest `moderation: low` when the subject is artistic and the block class is known false-positive-prone; never auto-retry a moderation block.
