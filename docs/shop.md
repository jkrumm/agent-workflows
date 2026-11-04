# Shop: amazon.de through `agw`

**TLDR.** `agw shop search|item|find` reads amazon.de at low volume and parses the pages in code, so ASINs, URLs, dimensions and image URLs survive and a repeat run returns the same list. `agw image-read` is the generic vision door the shop uses for product photos. A model only ever sees fields the parser already pulled out.

| Command | Does | Model |
|-|-|-|
| `agw shop search "<query>" [--include-sponsored] [--limit n] [--fresh]` | Result cards: ASIN, title, price, rating, review count, image, sponsored and Prime flag, `https://www.amazon.de/dp/<ASIN>` | none |
| `agw shop item <asin\|url> [--summarize] [--ask "<q>"] [--fresh]` | Title, brand, price, availability, rating, bullets, spec tables, images, seller; `null` where the page has nothing | `cheap.summarize`, `cheap.extract`, only on the flags, from the parsed fields |
| `agw shop find "<query>" --ask "<criteria>" [--top 5] [--images]` | Search, open the top non-sponsored hits, summary each, judge all against the criteria | `cheap.summarize` per hit, `cheap.extract` once, `vision.describe` per image with `--images` |
| `agw image-read <url\|/abs/path> [--ask "<q>"]` | One question about one picture | `vision.describe` |

Why scraping: Amazon's PA-API 5.0 is deprecated (403) and its successor, the Creators API, needs an Associates account with 10 qualifying sales in 30 days. There is no official product search for a non-seller (research 2026-11-01).

## Conduct

A personal tool at low volume. These rules are code in `shop-fetch.ts`, not intentions.

- **One request at a time**, across search, item and find, with a **2-5 s jittered pause** between two page fetches. Cache hits do not count and cost no pause.
- **Cache:** a search page 1 h, an item page 24 h, per process, parsed results only. `--fresh` reads again. Only a page that parsed is kept, so a wall is never served back.
- **A wall stops the call:** a 429, a robot-check page or a redirect to the sign-in flow raises `blocked (rate-limited | bot-protection | login-required)`. No retry, no second identity, no proxy, no login, no captcha solving, no affiliate tag. `shop find` stops the whole run, no partial list.
- **Cooldown:** after a wall the process refuses further page reads for 15 minutes (`blocked (cooldown)`, nothing sent), so a loop of calls cannot lean on the shop.
- **Honest client:** `user-agent: agent-workflows/0.1 (shop)`, `accept-language: de-DE`. Only `https://www.amazon.de`, no credentials, default port; every redirect hop is checked again, and the connection is pinned to the vetted address like `web.fetch`.
- **Page text is untrusted data.** Product text reaches a model only inside a `<product asin="…">` fence with `<` and `>` replaced, under a system prompt that says the fence is data. Image answers are labelled untrusted and fenced the same way before the judge sees them.

## Decisions

- **Raw HTML, not the `web.fetch` chain.** `web.fetch` returns the page as text (and the browser leg `innerText`): `data-asin`, hrefs and image URLs are gone before a parser could see them. The shop doors do their own read (`shop-fetch.ts`: the direct leg of the same chain, with the same SSRF guard and pinning) and keep a cache of their own, because `web.fetch`'s is fixed at 6 h and holds text. The headed-Chrome and Tavily legs are not carried: the direct read returned complete pages on every probe, and a wall is a stop under the conduct rules, not something to climb over. If the direct read starts to meet walls, extending `browser.ts` to hand back HTML is the change to make, not a second scraper.
- **`shop find` is a composed capability, not a workflow** (concept §2: the difference is the ratio). It has no agent step and no scorer, it is a fixed sequence of code steps and cheap single calls, and the host already journals it as one `cap.shop.find` run with usage. What a workflow would add is step-level resume after a restart without reading the shop again and an eval set. Promote it when one of those is needed. It is also not possible from here: workflows live in `packages/host`, outside this change's files.
- **Vision is one generic capability** (`image.read`, command `image-read`: `agw image` is a workflow, and a command may not prefix another). Nothing in the shop duplicates it; `--images` calls it. The chat port carries text only, so the call lives in `image-read.ts` (non-streamed, half-hour hang guard, same fallback rule as every single call). Folding images into `ChatRequest` is the follow-up once the inference gateway lands.
- **`position`** is the card's place on the page with sponsored cards counted, so a filtered list shows the gaps.

## Parsers

Pure functions in `shop-parse.ts`: HTML string in, typed data out; no network, no clock, no model. A field the page does not carry is `null`, never guessed.

| Page | Read from |
|-|-|
| Search card | `div[data-component-type="s-search-result"][data-asin]`; `h2` text; first `span.a-price` (not `a-text-price`, which is the unit price) `a-offscreen`; `aria-label="4,5 von 5 Sternen"`; `aria-label="7.795 Bewertungen"`; `img.s-image`; offer note "Keine hervorgehobenen Angebote verfügbar" / "Nur noch 4 auf Lager" |
| Sponsored | the card carries `puis-sponsored-label`, `s-sponsored-label`, `AdHolder` or a `Gesponsert` label. The "Von Kunden häufig angesehen" carousels are not result cards (`data-component-type=""`) and are never returned |
| Product page | `#productTitle`, `#bylineInfo`, `#corePrice_feature_div`, `.primary-availability-message`, `#acrPopover[title]`, `#acrCustomerReviewText`, `#feature-bullets`, `#productOverview_feature_div` and `#prodDetails` rows (`tr` with two cells), `"hiRes"` image URLs from `colorImages` (fallback `#landingImage` `data-a-dynamic-image`), `#sellerProfileTriggerId` |

An unrecognized layout (no `s-main-slot`, no `#productTitle`) is an upstream error, not an empty result. A page that says "Keine Ergebnisse" is `[]`.

**Not verified live:** the Prime badge. No Prime marker appeared on any of the twelve pages read (an anonymous session is shown none), so `prime: false` means "no badge shown", and the detector (`a-icon-prime`, `aria-label="Prime"`) is written from the usual markup, untested against a real badge.

## Fixtures

`packages/capabilities/src/capabilities/fixtures/shop/*.html.txt` (a `.txt` suffix keeps the formatter off markup that is not well-formed). Captured 2026-11-01 from `www.amazon.de` with the client above, trimmed to the cards and sections the parsers read, then sanitized: scripts, styles, comments, forms and inputs removed; every `href` cut at its query string (it carries session-derived tokens); every `data-*` attribute except the three the parsers read removed; card UUIDs removed. No cookie, CSRF token, offer-listing id or raw page is committed.

| File | Source |
|-|-|
| `search-augplatte` | real: six grid cards of "Augplatte Edelstahl M6 Öse" plus a real sponsored carousel (trimmed), which must yield no result |
| `search-sponsored` | real: two inline sponsored cards and two normal ones, from a later read of the same query |
| `search-ps5` | real: list view; two cards without a price, one with "Nur noch 17 auf Lager", a thousands separator |
| `search-empty` | real: a query with no hits |
| `item-with-specs` | real: product page with overview and technical tables, bullets, images, seller |
| `item-unavailable-no-specs` | real: a console with no featured offer and no spec table: price, availability, seller and specs are `null` |
| `robot-check-synthetic` | **synthetic**: no block was served in any probe, so the page is written from the documented shape of Amazon's robot check (`/errors/validateCaptcha`, "Geben Sie die angezeigten Zeichen im Bild ein"). It proves the detector, not Amazon's current markup |

Refresh when the layout shifts: read the pages under the conduct rules above (they apply to fixtures too), trim, apply the sanitization, update the expected values in `shop.test.ts`.

## Vision

Route `vision.describe` (`packages/routes/src/table/vision.ts`), chat wire, one image as a data URL. Probe 2026-11-01 on the IU wire: three saved product photos (a black square-base pad eye set, a polished set of four with screws, a set of eight), one fixed question ("shape, printed dimensions or none, material and finish, burrs or defects; count the main parts"), `timeout`-bounded, non-streamed. The list of models is read from IU's `/models` (`ImageInput` capability); candidates are the cheap GPT-stack models, none via Requesty.

Pass rule written before the run: the image is accepted, the shape is right, the count is right on all three photos (4, 4, 8), no dimension is invented where none is printed, and the material is not guessed wrong.

| Model (effort) | Accepted | Counts 4 / 4 / 8 | Printed dims | Material | Tokens in / out (per photo) | Verdict |
|-|-|-|-|-|-|-|
| Luna (low) | yes | 4 / 4 / 8 | "none" ×3 | black metal / stainless steel / metallic, "not specified" where unclear | 515-563 / 157-224 | **pass, picked** |
| gpt-5.4-nano (low) | yes | 5 / 4 / 8 | "none" ×3 | "likely steel", "galvanized/chrome-like" | 580-620 / 235-336 | fail: counted the screws as a part |
| gpt-4.1-nano | yes | 4 / 4 / 8 | "none" ×3 | "metal" only | 969-1067 / 47-68 | pass on counts; thin answers, price not verified |
| Terra (medium) | yes | 4 / 4 / 8 | "none" ×3 | black / "likely stainless steel" ×2 | 443-483 / 99-120 | pass; ten times Luna's price, so it is the fallback |

**Picked: Luna at effort low**, the seat `VISION` (`packages/routes/src/table/_shared.ts`) already prices ($0.10 in, $0.50 out per million), so the probe adds no model id and no rate. The nano models are not in the route table's rate sources, so "cheaper than Luna" could not be shown for them; if a verified rate says so, move the seat. The fallback is Terra medium (`callFallback(TERRA_MEDIUM)`): it answered the same photos correctly. Live: a 1500 px product photo costs about 2,400 prompt tokens, $0.0002-0.0003 per read.

What the model cannot do is read a size off a picture that prints none; the system prompt says so and the answers did ("Dimensions: none"). Measures come from the spec table, not from `image-read`.

## Live probe, 2026-11-01

`agw shop search "Augplatte Edelstahl M6 Öse"`: 60 cards, 12 sponsored dropped, **48 results**, each with ASIN, price, URL and image URL. The same call again returned `cached: true` and the identical ASIN order. `shop item B0BLBS5SD6 --summarize --ask "…"` returned the spec table (material, maximum weight 70 kg, dimensions 10 x 6 x 0,5 cm) and a summary that flags the listing's own contradiction (50 kg per piece in a bullet, 70 kg in the table). `image-read` on its first image: "a flat, roughly square plate with a raised U-shaped loop. There are 4 parts." `shop find … --top 3 --images` ended with a ranked shortlist, each hit with fits and misses. Cost of the whole find: a few tenths of a cent.

Prices and ASINs drift; the order is stable only inside the cache window and while Amazon's ranking is.
