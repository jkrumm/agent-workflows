# Shop: amazon.de, idealo.de, geizhals.de and the tech shops through `agw`

**TLDR.** `agw shop search|item|find` reads amazon.de at low volume and parses the pages in code, so ASINs, URLs, dimensions and image URLs survive and a repeat run returns the same list. `agw shop offers` reads the offers of ONE exact product (by part number) from idealo.de and geizhals.de and, on their own pages, from Alternate, Mindfactory and Caseking, and `agw shop watch` is the owner's price watch over all of them and amazon.de: a record of the lowest qualifying price per product and an ntfy message on a change of state. `agw image-read` is the generic vision door the shop uses for product photos. A model only ever sees fields the parser already pulled out; the offers door and the watch use no model at all.

| Command | Does | Model |
|-|-|-|
| `agw shop search "<query>" [--include-sponsored] [--limit n] [--fresh]` | Result cards: ASIN, title, price, rating, review count, image, sponsored and Prime flag, `https://www.amazon.de/dp/<ASIN>` | none |
| `agw shop item <asin\|url> [--summarize] [--ask "<q>"] [--fresh]` | Title, brand, price, availability, rating, bullets, spec tables, images, seller; `null` where the page has nothing | `cheap.summarize`, `cheap.extract`, only on the flags, from the parsed fields |
| `agw shop find "<query>" --ask "<criteria>" [--top 5] [--images]` | Search, open the top non-sponsored hits, summary each, judge all against the criteria | `cheap.summarize` per hit, `cheap.extract` once, `vision.describe` per image with `--images` |
| `agw shop offers <part number \| product URL> [--source idealo\|geizhals\|alternate\|mindfactory\|caseking\|shops\|all\|everything] [--history 3M\|6M\|1Y] [--fresh]` | The offers of one exact product (a tech shop's own page gives its one offer, §Tech shops): total with shipping, item price, shipping, shop, marketplace flag, shop rating and count, payment methods, prepayment-only flag, delivery or stock text; the product's name, part number, GTIN, module count and size (memory), offer count and the site's data time; idealo's price series with `--history`. A product whose part number does not equal the one asked is `NOT_FOUND`, never returned | none |
| `agw shop watch [--dry-run]` | One run of the price watch (§Watch) | none |
| `agw image-read <url\|/abs/path> [--ask "<q>"]` | One question about one picture | `vision.describe` |

Why scraping: Amazon's PA-API 5.0 is deprecated (403) and its successor, the Creators API, needs an Associates account with 10 qualifying sales in 30 days. There is no official product search for a non-seller (research 2026-11-01).

## Conduct

A personal tool at low volume. These rules are code in `shop-fetch.ts`, not intentions.

- **One request at a time**, across search, item and find, with a **2-5 s jittered pause** between two page fetches. Cache hits do not count and cost no pause.
- **Cache:** a search page 1 h, an item page 24 h, per process, parsed results only. `--fresh` reads again. Only a page that parsed is kept, so a wall is never served back.
- **A wall stops the call:** a 429, a 503 that is no known page, a robot-check page or a redirect to the sign-in flow raises `blocked (rate-limited | bot-protection | login-required)`. No retry, no second identity, no proxy, no login, no captcha solving, no affiliate tag. `shop find` stops the whole run, no partial list.
- **A bot check goes to the headed Chrome once, then it is reported blocked.** Only a robot check (not a 429, not a sign-in redirect) is read once more in the research Chrome (`AGW_BROWSER_CDP_URL`, `make research-chrome`, the same browser leg and request vetting as `web.fetch`; `browser.ts` hands back the page's `outerHTML` with `{ html: true }`), and the HTML is parsed by the same parsers. If Chrome meets the check too, the call ends `blocked (bot-protection)` (the message names `needs-human`, which is not in the shop's reason union) and nobody is asked: a bot check is not an Errand, the caller goes on with other sources. One browser read per call, no loop. The agent never solves the check, retries, rotates identity or uses a proxy.
- **Cooldown:** after a wall that still blocks the process refuses further page reads for 15 minutes (`blocked (cooldown)`, nothing sent), so a loop of calls cannot lean on the shop. A bot check the browser passes sets none.
- **idealo.de, geizhals.de, caseking.de and mindfactory.de are read in the research Chrome from the first request, alternate.de directly** (§Tech shops has those measurements). A plain client is turned away by idealo (measured 2026-11-17: every path, the history endpoint included, answers a 403 block page) and by geizhals (Cloudflare's "Sichere Verbindung wird überprüft"), so a direct request would be one guaranteed refusal and would start the cooldown for nothing. The browser leg is the one above (`AGW_BROWSER_CDP_URL`, `make research-chrome`, `{ html: true }`): a real browser's own identity, no solving, no stealth, no proxy. A challenge it meets ends the call `blocked (bot-protection)`; no browser configured is `NOT_CONFIGURED`. The same pause, one request at a time and no retry hold, and the **cooldown is per host**: a wall at idealo does not lock geizhals, a tech shop or amazon.de. A browser read of a 404 is "not found" (idealo answers a search with no hit 404), as on the direct leg.
- **One request per product page per run.** The watch keeps the product page URLs it found (`state.json`) and reads only those on later runs; the search by part number is repeated only when a stored page no longer names the part number. `shop offers` reads one search page and one product page per site (and one JSON read for `--history`).
- **Honest client:** `user-agent: agent-workflows/0.1 (shop)`, `accept-language: de-DE`. Only `https://www.amazon.de` and `https://www.alternate.de` (direct), `https://www.idealo.de`, `https://geizhals.de`, `https://www.caseking.de` and `https://www.mindfactory.de` (browser), no credentials, default port; every redirect hop is checked again, and the connection is pinned to the vetted address like `web.fetch`.
- **Page text is untrusted data.** Product text reaches a model only inside a `<product asin="…">` fence with `<` and `>` replaced, under a system prompt that says the fence is data. Image answers are labelled untrusted and fenced the same way before the judge sees them.

## Decisions

- **Raw HTML, not the `web.fetch` chain.** `web.fetch` returns the page as text (and the browser leg `innerText`): `data-asin`, hrefs and image URLs are gone before a parser could see them. The shop doors do their own read (`shop-fetch.ts`: the direct leg of the same chain, with the same SSRF guard and pinning) and keep a cache of their own, because `web.fetch`'s is fixed at 6 h and holds text. Tavily is not carried (it returns text). The headed-Chrome leg was not carried at first: the direct read returned complete pages on every probe. **Owner decision 2026-11-05:** when amazon.de shows a bot check, a human solves it once on screen share in the headed research Chrome and the cookie stays in its profile; the agent still never solves a captcha. So `browser.ts` hands back HTML and the shop reads a bot-checked page through it, then reported blocked when Chrome cannot pass either, rather than writing a second scraper. **Superseded 2026-11-16 (Issue 1740):** the owner is no longer asked; a bot check is reported blocked and the caller goes on.
- **`shop find` is a composed capability, not a workflow** (concept §2: the difference is the ratio). It has no agent step and no scorer, it is a fixed sequence of code steps and cheap single calls, and the host already journals it as one `cap.shop.find` run with usage. What a workflow would add is step-level resume after a restart without reading the shop again and an eval set. Promote it when one of those is needed. It is also not possible from here: workflows live in `packages/host`, outside this change's files.
- **Vision is one generic capability** (`image.read`, command `image-read`: `agw image` is a workflow, and a command may not prefix another). Nothing in the shop duplicates it; `--images` calls it. The picture rides `ChatRequest.images` on both text wires, so the call goes through the shared `complete()` like every single call (retries, usage, the balance fallback). A source over 7 MB is refused: the Messages wire takes 10 MB of base64 per image, and a 400 there is no balance failure, so the fallback would not catch it.
- **`position`** is the card's place on the page with sponsored cards counted, so a filtered list shows the gaps.

## Offers by part number

`shop offers` is the answer to "what does this exact product cost, and from whom". Three rules make it exact:

- **The part number must be equal.** The search lists products; only a card whose part number equals the one asked (letters and digits, any case) is read, and the product page's own part number is checked again. idealo prints it in brackets in the product name, geizhals in `galleryview__mpn` and the page's JSON-LD (`mpn`, `gtin`). geizhals' search is loose (a nonsense query still lists thirty products, fixture `geizhals-search-fuzzy`), so the comparison is what keeps the answer honest. No equal part number is `NOT_FOUND` naming the near misses.
- **Memory states its modules.** idealo: "Anzahl Module 2, Kapazität pro Modul 24 GB" from the product overview; geizhals: "Module 2x 24GB" from the spec table. `memory: { modules, moduleGb, totalGb }` is in the output and the plain text says "2 x 16 GB (32 GB)". A memory product whose page states none says "capacity not stated on the page", never a guess. The research failure that started this (2 x 16 GB kits reported as 2 x 32 GB) cannot recur through this door.
- **Totals are the page's.** idealo prints "x € inkl. Versand" per offer: that is `totalEur`, shipping is the difference. geizhals prints price and a delivery note per offer: shipping is read per way to pay ("Vorkasse kostenfrei. Kreditkarte, PayPal € 8,90"), so `totalEur` is the cheapest way and `totalEurNoPrepayment` the cheapest way that is not prepayment (null when the offer is prepayment only). Fees that are no shipping (Finanzierung, Expressversand, Abholung) are ignored. idealo's list carries every way to pay but one total, so its `totalEurNoPrepayment` equals `totalEur` unless the offer is prepayment only; a shipping form other than "inkl. Versand" has not been seen and yields a null total, never a guess.

What the pages do not carry, and the door therefore does not return: **return terms** (idealo's offer block links a "Shop-Details" overlay that needs one more request per offer; geizhals shows "Infos" and "AGB" links), so the acceptance line "return terms" is not met. idealo gives no data time on the list beyond "Daten vom <date> <time>" (local German time), geizhals gives "Preis vom" per offer (the newest is `dataTime`). idealo lists 20 offers on the first page of a longer list (`offerCount` 28, 20 listed): the list is sorted by price, so the cheapest are on it. `marketplace` is `null` at geizhals, which does not say.

### Price history

idealo's "Preisentwicklung" chart is drawn from `GET https://www.idealo.de/price-chart/sites/1/products/<product id>/history?period=3M|6M|1Y` (found in idealo's own `price-chart-assets/static/js/bundle-main.js`; the guess `/offerpage/pricechart/api/<id>` of 2026-11-17 was wrong). A plain client gets the 403 block page like everywhere on the host; the research Chrome gets JSON: `{ siteId, startDate, data: [{ x: "2025-11-17", y: 22280, date: [2025, 11, 17] }, …], statistics: { avgPrice, lowestPrice, highestPrice, … } }` with `y` in cents and one point a day (366 for a year). `--history` returns it in euros with the statistics, one more read. geizhals' `/?phist=<id>` is a page whose chart is drawn client-side by `chart.js`; only the 6-month low, median and high are in its text, and no series was readable without reverse-engineering the chart bundle, so geizhals has no history here: the watch's own record is the owner's history from its first run on.

## Tech shops

`shop offers --source alternate|mindfactory|caseking` (`--source shops` reads the three, `--source everything` every source; `all` stays idealo and geizhals, as it always was) reads a shop's own page for ONE exact product: one search page and one product page per shop (one request when the search lands on the product, as at Mindfactory), the same conduct, the same equal-part-number rule and the same output as the aggregators. A shop's page names one offer: its own price, no marketplace, no shop rating, no payment list, `offerCount` 1. Issue 2064; the owner asked for them because neither aggregator lists every shop, and a shop's own page is fresher than the aggregator's copy of it (Mindfactory: 851,89 € on its page against 860,79 € total at geizhals at the same time, which is the page's price plus the 8,90 € shipping the door adds).

Access check, 2026-11-17, one request per page with the client above and, where it was turned away, the research Chrome:

| Shop | Plain client | Research Chrome | Read |
|-|-|-|-|
| alternate.de | answers (search and product page) | not needed | direct |
| mindfactory.de | the search redirects, the product page answers 403 with a "Datenbank-Update" notice | answers; a search with one hit lands on the product page | browser |
| caseking.de | Cloudflare check page (403) | answers | browser |
| computeruniverse.net | not tried (the owner's note: only the browser leg answers) | answers, but the search results are drawn client-side after the page settled: the HTML holds no product card | **not read** |

Computeruniverse has no reader: its search page carries no product in the HTML the browser leg returns, and a reader would need its internal search API reverse-engineered for a shop that both aggregators already list (idealo's offers for the Patriot kit name computeruniverse.net). Add it when a product turns up that only Computeruniverse sells. MediaMarkt, Saturn, Conrad, Proshop (403 to a plain client), Galaxus, Kaufland, Otto and the others of the owner's list are not read either: this Issue was the four shops of its title.

How each page is read (`shop-direct-parse.ts`; the shops differ, so each has its own parser over one shared shape):

| Shop | Search | Product page |
|-|-|-|
| Alternate | `/listing.xhtml?q=<mpn>`. The search is loose (a nonsense query lists 840 products), so a card matches only when a word of its subtitle ("schwarz, CMK48GX5M2B5600C40, Vengeance, …") equals the part number | `Product` JSON-LD: `mpn`, `gtin8` (an EAN-13), `offers.price`, `availability`, `shippingDetails.shippingRate` (7,99 €, exact). "Artikel kann derzeit nicht gekauft werden" in the page marks it unavailable |
| Caseking | `/search?q=<mpn>` (the `search=` parameter the shop's own links suggest ignores the term). A tile carries the item number (`MEPM-140`), no part number, so a search with exactly one hit is read and the page's own part number decides; several hits are not read one by one and end the call as an upstream error ("lists N products with no part number on the card"), never as "not listed" | `Product` JSON-LD for price and availability; its `mpn` is the shop's item number, so the part number is the "MPN" attribute of the page; "Versandkosten ab 4,99€" |
| Mindfactory | `/search_result.php?search_query=<mpn>`: one hit lands on `/product_info.php/…_<id>.html` (the final URL says so), none says "ergab 0 Treffer". A list of several hits was not seen live: its links are read and none carries a part number, so it never matches | schema.org microdata (`itemprop="price"`, `availability`, `sku-model` as the part number, `product-ean`); "zzgl. der Versandkosten in Höhe von mind. € 8,90" in the footer |

- **Shipping is what the page states, never a guess.** Alternate's is exact. Caseking and Mindfactory print only the cheapest tier ("ab", "mind."), so `totalEur` is the page's price plus that minimum, a lower bound for a heavier parcel; the delivery text says "Versand ab …". A page that states none gives a `null` total, which the watch does not count. No offer has a payment list, so `totalEurNoPrepayment` equals `totalEur`.
- **The equal part number is still the gate:** the product page's own part number is compared after the read (`NOT_FOUND`, "the caseking page names part number X, not Y"), whatever the search returned.
- **Mindfactory's Chrome HTML** comes back with a few mojibake'd characters in the page's own German text (the page declares `iso-8859-15`); none of the fields the parser reads is affected.
- **The memory split** comes from the name or description ("(2x 24 GB)", or a "Dual Kit" of a total, read as two modules); nothing else is guessed.

In the watch the shops are sources of every product (`shops`: all three by default). A shop that does not list the part number is `offers.<shop>: 0` in the record row, not an error, and is searched again next run; a listed one's page URL is kept in `state.json` and read directly from then on, so a steady run is one request per page. A first run reads six more pages per product (about 30 s at the 2-5 s pause); the job's 30 minute timeout holds for about 40 products. Not built: a product URL per shop in `watch.json` (the search by part number found every listed product), the shops' outlet and B-stock sections (Alternate Outlet, Mindfactory MindStar and DAMN), and category enumeration. Each is a follow-up.

## Watch

`agw shop watch` is one run, a capability in the host (it holds the research Chrome, `NTFY_URL` and `NTFY_TOKEN`; the server comes from the ntfy config `launch.sh` reads, never from this repo). `make shop-watch-setup` installs the LaunchAgent `com.jkrumm.agent-workflows-shop-watch` (every 6 hours, `jobrun --every 21600 --timeout 1800`) and makes the first run; `make shop-watch-teardown` removes it.

Files, in `AGW_SHOP_DIR` (default `~/.agent-workflows/data/shop/`, outside any release):

| File | Holds |
|-|-|
| `watch.json` | The owner's list, edited by hand: `{ "products": [{ "mpn", "label", "ceilingEur", "minRating" (4), "minRatings" (20), "allowPrepayment" (false), "asin"?, "dropPercent" (5), "shops" (all three) }] }` |
| `state.json` | Per part number: the product page URL of every source that listed it (`pageUrls`; a file from before the tech shops, with `idealoUrl` and `geizhalsUrl`, reads the same), whether the price was at or under the ceiling, the price last alerted, the last three lowest totals |
| `record.jsonl` | One row per product and run, appended: time, part number, label, ceiling, lowest qualifying total, its source, shop, rating and count, offers read per source, how many qualified, the alert reason and what happened to the message, and the source errors |

A product's sources are idealo, geizhals, the tech shops of its `shops` list (all three unless it names fewer, `[]` for none) and, with an `asin`, the amazon.de item. An offer **qualifies** when it is not marked unavailable, its shop rating and rating count are at or above the floors, and its total does not need prepayment (unless `allowPrepayment`); a tech shop's own page has no shop rating and qualifies as the known retailer it is, on a stated total and stock alone; the amazon.de item qualifies when Amazon itself is the seller (`soldByAmazon`; a third-party seller's rating is not on the page) and it is not unavailable. The lowest qualifying total is the row's price. A blocked or missing source is a field of the row and the others go on; the run fails (exit non-zero, graded by `jobs-grade`) only when no source of any product could be read.

**A message on a change of state only:** (a) the lowest qualifying total goes from above the ceiling, or none, to at or under it; (b) it is at least `dropPercent` below the price last alerted, or, once the price has risen above that alert, below the median of the last three runs. The same price again is silent, and so is a rise. One ntfy message per product (topic `updates`, the offer's page as the click target). A message the server refused (or no ntfy settings) is recorded `failed` or `off` and the state is not advanced, so the next run sends it again.

Example `watch.json` (placeholders; the real list is the owner's):

```json
{ "products": [
  { "mpn": "<part number>", "label": "<name in messages>", "ceilingEur": 600 },
  { "mpn": "<part number>", "label": "<name>", "ceilingEur": 850, "asin": "<ASIN>", "minRatings": 50 }
] }
```

## Parsers

Pure functions in `shop-parse.ts` (amazon.de), `shop-offers-parse.ts` (idealo, geizhals) and `shop-direct-parse.ts` (Alternate, Caseking, Mindfactory): HTML string in, typed data out; no network, no clock, no model. A field the page does not carry is `null`, never guessed.

| Page | Read from |
|-|-|
| Search card | `div[data-component-type="s-search-result"][data-asin]`; `h2` text; first `span.a-price` (not `a-text-price`, which is the unit price) `a-offscreen`; `aria-label="4,5 von 5 Sternen"`; `aria-label="7.795 Bewertungen"`; `img.s-image`; offer note "Keine hervorgehobenen Angebote verfügbar" / "Nur noch 4 auf Lager" |
| Sponsored | the card carries `puis-sponsored-label`, `s-sponsored-label`, `AdHolder` or a `Gesponsert` label. The "Von Kunden häufig angesehen" carousels are not result cards (`data-component-type=""`) and are never returned |
| Product page | `#productTitle`, the seller from `#sellerProfileTriggerId`, else the buy box' "Versender / Verkäufer" line (`odf-feature-text-desktop-merchant-info`, plain text "Amazon" when Amazon sells: `seller: "Amazon"`, `soldByAmazon: true`; `seller: null` is a parse miss),  `#bylineInfo`, `#corePrice_feature_div`, `.primary-availability-message`, `#acrPopover[title]`, `#acrCustomerReviewText`, `#feature-bullets`, `#productOverview_feature_div` and `#prodDetails` rows (`tr` with two cells), `"hiRes"` image URLs from `colorImages` (fallback `#landingImage` `data-a-dynamic-image`) |
| idealo search | `data-testid="result-item"` cards: `product-summary-title` (name, part number in brackets) and the `OffersOfProduct/<id>_-<slug>.html` link. A search that redirects to a product page is that product |
| idealo product | `h1#oopStage-title`; `oopStage-productInfoTopItems` (module count and size); `"offerCount"` in the JSON-LD; `data-import-time` ("Daten vom 17.11.2026 15:14"); per `productOffers-listItem`: `data-mtrx-click` JSON (`shop_name`, "(Marktplatzhändler)" suffix = marketplace), `data-shop` type (`EBYDE` = eBay), the price link, `productOffers-listItemOfferShippingDetails[title]` ("… € inkl. Versand"), `starAndRatingWrapper` and `numberOfRatings`, payment titles and `payment-icons/2x/<name>-<hash>.png`, `DeliveryStatusDatesTitle` and `DatesRange` |
| idealo history | the JSON in the browser's `<pre>`, see §Price history |
| tech shops | `shop-direct-parse.ts`, see §Tech shops |
| geizhals search | `article.galleryview__item` cards: `galleryview__name-link` (URL, name), `galleryview__mpn` |
| geizhals product | JSON-LD `ProductGroup.hasVariant` entry whose `url` carries the page's `-a<id>.html` (`name`, `mpn`, `gtin`, `offers.offerCount`); the spec row "Module 2x 24GB"; per `div.offer`: `gh_price`, `data-merchant-name`, "Bewertung: 4.8 von 5 Sternen" and `stars-rating-label-bottom`, `offer__delivery-time`, `offer__delivery-payment` (methods and shipping), `offer__payment-icon` alt texts, `offer--unavailable`, `<time datetime>` |

An unrecognized layout (no `s-main-slot`, no `#productTitle`) is an upstream error, not an empty result. A page that says "Keine Ergebnisse" is `[]`.

**Not verified live:** the Prime badge. No Prime marker appeared on any of the twelve pages read (an anonymous session is shown none), so `prime: false` means "no badge shown", and the detector (`a-icon-prime`, `aria-label="Prime"`) is written from the usual markup, untested against a real badge.

## Fixtures

`packages/capabilities/src/capabilities/fixtures/shop/*.html.txt` (a `.txt` suffix keeps the formatter off markup that is not well-formed). The amazon.de files were captured 2026-11-01 from `www.amazon.de` with the client above, trimmed to the cards and sections the parsers read, then sanitized: scripts, styles, comments, forms and inputs removed; every `href` cut at its query string (it carries session-derived tokens); every `data-*` attribute except the three the parsers read removed; card UUIDs removed. No cookie, CSRF token, offer-listing id or raw page is committed.

| File | Source |
|-|-|
| `search-augplatte` | real: six grid cards of "Augplatte Edelstahl M6 Öse" plus a real sponsored carousel (trimmed), which must yield no result |
| `search-sponsored` | real: two inline sponsored cards and two normal ones, from a later read of the same query |
| `search-ps5` | real: list view; two cards without a price, one with "Nur noch 17 auf Lager", a thousands separator |
| `search-empty` | real: a query with no hits |
| `item-with-specs` | real: product page with overview and technical tables, bullets, images, seller |
| `item-unavailable-no-specs` | real: a console with no featured offer and no spec table: price, availability, seller and specs are `null` |
| `item-sold-by-amazon` | real, 2026-11-17: title, price, availability and the merchant line of B0GGJ9YH2D, sold by Amazon (trimmed to those four) |
| `idealo-search-cmk`, `idealo-search-pvv` | real, 2026-11-17: the category list for CMK48GX5M2B5600C40 (four 48 GB and 32 GB Corsair kits) and for PVV532G600C30K (one Patriot 2 x 16 GB kit), cards only |
| `idealo-product-cmk`, `idealo-product-pvv` | real, 2026-11-17: product page head and offer list (all 11 offers of the Corsair 2 x 24 GB kit; the first 6 of the Patriot's 20 listed of 28). Offer keys, tracking attributes and relocator links removed; the payment icon file names kept |
| `idealo-history` | real, 2026-11-17: the 1Y answer for the Corsair kit, cut to 60 of 366 points, statistics as served |
| `geizhals-search-cmk`, `geizhals-search-fuzzy` | real, 2026-11-17: the one card of the exact part number; the first four of thirty cards a nonsense query lists (the proof that the part number must be compared) |
| `geizhals-product-cmk` | real, 2026-11-17: JSON-LD cut to the variant, the spec row, and all 9 offers |
| `alternate-search-cmk`, `alternate-product-cmk` | real, 2026-11-17: the two cards of the search for CMK48GX5M2B5600C40 (the Vengeance kit and the RGB sibling); the Product JSON-LD block of the kit's page and the "Artikel kann derzeit nicht gekauft werden" line |
| `caseking-search-pvv`, `caseking-product-pvv` | real, 2026-11-17: the one tile of the search for PVV564G560C40K; the Product JSON-LD (one image kept), the SKU/EAN/MPN attributes, the "Auf Lager" and the shipping line of the page |
| `caseking-search-none`, `mindfactory-search-none` | real strings of 2026-11-17 (the `searchResults` count and the "keine Ergebnisse" line; the "ergab 0 Treffer" line) in a minimal page: what each shop answers for a part number it does not list |
| `mindfactory-product-cmk` | real, 2026-11-17: the product's microdata, SKU and EAN line, the stock badge and the footer's shipping sentence of the page a search for CMK48GX5M2B5600C40 lands on. The cart form (its token) and every script were left out |
| `robot-check-synthetic` | **synthetic**: no block was served in any probe, so the page is written from the documented shape of Amazon's robot check (`/errors/validateCaptcha`, "Geben Sie die angezeigten Zeichen im Bild ein"). It proves the detector, not Amazon's current markup |

The idealo and geizhals fixtures keep markup the parsers do not read where it sits between two things they do: an `<svg>` is emptied (`<svg></svg>`), never removed. idealo draws a star icon between the rating wrapper and the number, and the first version of the fixtures, which dropped the icon, hid that the rating regex missed every rating on the live page (found by the live probe, fixed in the next commit). A fixture is only worth what its markup shares with the live page, so each is also checked live (§Live probe).

Refresh when the layout shifts: read the pages under the conduct rules above (they apply to fixtures too), trim, apply the sanitization, update the expected values in `shop.test.ts`.

## Vision

Route `vision.describe` (`packages/routes/src/table/vision.ts`), one image as base64 on `ChatRequest.images`, through the shared `complete()` path: a balance failure on the primary moves the call to the fallback like every single call.

**Seat: the `FAST` tier** (Haiku, no thinking, on the Messages wire; $0.10 in, $0.50 out per million, the same price as the earlier Luna seat), falling back to Luna low on the chat wire. Moved from Luna on 2026-11-05 so the call spends the Claude credit. A Claude route spreads a tier (`guard.test.ts`), so the effort is the tier's, not the route's.

Probe 2026-11-05, Haiku on the gateway's Messages wire: three product thumbnails (320 px, harder than the 1500 px the doors send) of the "Augplatte Edelstahl M6 Öse" search, read by eye as 4, 10 and 8 plates, the default question of `image.read`, one call per effort, run twice.

Pass rule: counts right on all three photos, no dimension invented where none is printed, the material not guessed wrong.

| Effort | Counts 4 / 10 / 8 (run 1, run 2) | Printed dims | Output tokens | Verdict |
|-|-|-|-|-|
| none (`FAST`) | 4 / 9 / 8 both | "not visible" ×3 | 385-816 | misses one of ten |
| low | 4 / 10 / 8 both | "not visible" ×3 | 313-434 | the only pass; no tier has it |
| medium (run 1) | 4 / 9 / 8 | "not visible" ×3 | 442-844 | misses one of ten |
| high (`EASY`, run 2) | 4 / 9 / 8 | "not visible" ×3 | 471-912 | misses one of ten |

So `FAST` miscounts a dense grid of ten by one; the material and "not visible" answers were the same at every effort. If the count matters more than the tier rule, a `low` Haiku tier is one new constant next to `FAST` and a guard entry. The earlier probe (2026-11-01, IU chat wire, three other photos with counts 4 / 4 / 8) passed Luna low and Terra medium and failed gpt-5.4-nano (it counted screws as a part); Luna is the fallback because of it. Live: a 1500 px product photo costs about 2,400 prompt tokens, $0.0002-0.0003 per read.

What the model cannot do is read a size off a picture that prints none; the system prompt says so and the answers did. Measures come from the spec table, not from `image-read`.

## Live probe, 2026-11-01

`agw shop search "Augplatte Edelstahl M6 Öse"`: 60 cards, 12 sponsored dropped, **48 results**, each with ASIN, price, URL and image URL. The same call again returned `cached: true` and the identical ASIN order. `shop item B0BLBS5SD6 --summarize --ask "…"` returned the spec table (material, maximum weight 70 kg, dimensions 10 x 6 x 0,5 cm) and a summary that flags the listing's own contradiction (50 kg per piece in a bullet, 70 kg in the table). `image-read` on its first image: "a flat, roughly square plate with a raised U-shaped loop. There are 4 parts." `shop find … --top 3 --images` ended with a ranked shortlist, each hit with fits and misses. Cost of the whole find: a few tenths of a cent.

Prices and ASINs drift; the order is stable only inside the cache window and while Amazon's ranking is.

## Live probe, 2026-11-17 (offers and history)

The product pages above were read once each in the research Chrome, one request per page. `agw shop offers CMK48GX5M2B5600C40`: idealo lists 11 offers from 564,85 € (it-veith.de, rating 4,7 from about 205) to 1.245,07 €; geizhals lists 9 from 770,07 €. The two sites do not list the same shops, which is why the watch reads both. `agw shop offers PVV532G600C30K` answers "2 x 16 GB (32 GB)", 28 offers (20 listed) from 515,89 € total with shipping, among them alternate.de, caseking.de, computeruniverse.net and cyberport.de. `--history 1Y` returned 366 points, low 174,92 €, average 523,88 €, high 740,44 €. A part number nobody lists is `NOT_FOUND`. `agw shop item B0GGJ9YH2D` answers `seller: "Amazon"`, `soldByAmazon: true`, 929,99 €.

The tech shops' own pages are read since Issue 2064 (§Tech shops): for CMK48GX5M2B5600C40 Alternate (730,00 €, cannot be bought) and Mindfactory (851,89 €) show their own price, which idealo does not list at all and geizhals lists a few euros staler.
