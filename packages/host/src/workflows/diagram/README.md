# Diagram (Wave 7)

`agw diagram "<brief>"` (`src/workflows/diagram/`): an Excalidraw diagram from a brief; port of agent-gateway's
`excalidraw_diagram`. One agent (`agents/diagram`, route `diagram.agent` = Terra (effort medium) on OpenCode since 2026-10-30; the legacy
tool settled on after its bench) answers `{rationale, elements[]}`, the skeleton. Code does the rest; **the host writes no
caller path**, the caller writes the file.

| Step | What |
|-|-|
| `agent` | The skeleton envelope. No tools (OpenCode's deny-by-default), no web |
| `hydrate` | Parse and check the skeleton (`skeleton.ts`: ids, unique, bound arrows point at existing ids, field types), split off the pseudo-elements, convert with `@excalidraw/excalidraw` in a short-lived child process (`hydrate.ts`) |
| `diagram:reask`, `hydrate:reask` | One re-ask in the same session with the errors (a failed check, or a skeleton the library throws on); a second failure is `invalid_output` |

Input `brief`, `mode` (`create` or `extend`), `existing` (the current `.excalidraw` as a string, extend only:
`--existing "$(cat x.excalidraw)"`; the CLI reads stdin implicitly only for a required field and has no file argument,
so `existing` is a flag). **`existing` is capped at 512 KB** (UTF-8 bytes, about 400 elements; checked on the input).
One command-line argument that large is fine on macOS and over Linux's 128 KB per-argument limit; a bigger file (embedded
images, which are most of the weight) goes in without them, `jq '.files={}' x.excalidraw`, and the caller puts the `files`
back into the result. The agent never sees `files`, nor the app state: it reads a compact view of the elements.
Output `{document, elementCount, viewport, rationale}`; `document` is the v2 file as JSON text, so
`agw diagram "..." --format plain > x.excalidraw` writes the file (the contract's `plainField` is `document`).

**Pseudo-elements** (code, `skeleton.ts`): `cameraUpdate` becomes `viewport` (the last one wins), `delete` and
`restoreCheckpoint` act on the existing document. Legacy parsed them and then only filtered its own skeleton, so a
`restoreCheckpoint` lost the old diagram. Here extend has two honest modes: a skeleton that starts with
`restoreCheckpoint` keeps the existing elements (minus the deleted ones, their labels and arrows) and adds the new ones,
whose arrows may bind to old boxes; any other skeleton replaces the diagram. Rejected for the one re-ask, with the error
text: `restoreCheckpoint` in create mode, `delete` without `restoreCheckpoint`, a `delete` id the existing diagram does not
have, and a new element that reuses the id of an element it keeps (reject, not drop the old copy, so the agent decides); a deleted
id may be drawn again (delete and redraw). What hangs off a deleted element goes too, transitively (its label, an arrow
attached to it, that arrow's label), and survivors' `boundElements` lose the entries of anything deleted. To let a new arrow bind to an old box
the library needs the box in the skeleton it converts, and converting a finished arrow again drops its bindings;
so the new skeleton is converted with bare stand-ins for the boxes it binds to, and the real elements are swapped back in
(`document.ts` `bindingStubs`, `mergeExtension`). In extend mode the agent reads a compact view of the old diagram
(one JSON line per element in skeleton vocabulary), not the hydrated file.

## Hydration decision

Three options, one spike each in a scratch directory (not committed), 5 elements incl. a German label and an arrow
label, compared with a headless Chrome that had the pinned bundle and the Excalifont file loaded (the app's own widths):

| | Text widths vs the app | Cost per call | Runtime dependency |
|-|-|-|-|
| (c) legacy: Chrome + `import ... from "https://esm.sh/..."` | **9-23 % too narrow** (180.52 against 198.38 px for one label): its widths equal a canvas that has no Excalifont, i.e. a fallback font | Chrome start and a CDN fetch (the legacy bench saw a hydrate timeout, 1 of 2 runs on its flash arm) | CDN at runtime: supply chain; Chrome on the host |
| (b) Chrome + a local `bun build` of the pinned package (7.8 MB) + the font awaited | exact (this is the reference) | Chrome start ≈ 1 s; CDP or `--dump-dom`; a PID to kill | Chrome on the host |
| **(a) Bun child process + DOM shim + `@napi-rs/canvas` registering the package's own woff2 files** | **identical to (b)**: 144.86, 148.02, 51.06, 108.20, 150.76 px, including the mid-word wrap of "Größenänderung" in a 120 px box | 295-340 ms per call (below) | pinned npm packages only |

**(a) wins**: same widths as the app, no network, no browser. It first ran in a Bun `Worker`; review moved it into a
child process: the canvas is native code (a crash or an OOM kill must not take the host with it), and its font registry
is process-wide, so a worker registers the fonts again on every call and the host's memory only grows. One `bun
hydrate-child.ts` per call (stdin in, one JSON reply out), run from its package directory (no `.env` or `bunfig.toml` of
the host's cwd) with `PATH`, `HOME`, `TMPDIR` and its own variables only (no secrets), killed by its PID on timeout (30 s)
or abort, a silent exit seen at once (the pipes close), at most 2 alive at once (`MAX_CONCURRENT_HYDRATIONS`, the rest queue
for at most 60 s), stdout capped at 32 MB and stderr read but only its last 4 KB kept. It ends itself too (`watchdog.ts`):
at the host's timeout plus 5 s, and when its parent pid changes, so a host crash or a deploy leaves no orphan. Who owns
which failure: only a conversion error is an `{ok: false}` reply (the agent's skeleton, so the one re-ask); a child that
cannot run (unreadable input, the package, the shim, the fonts or the canvas failing, a crash, an OOM kill, a flood) exits
non-zero and is an `InfraError`, which the runtime does not retry as a step but takes the run back for, and which never
reaches the agent; a timeout or an over-long queue wait is a `timeout` failure that is not retried (the same skeleton would
hang again). A native crash on a Linux host whose `core_pattern` is apport (GitHub's runners) is only reaped after the kernel has written the core dump, 12-17 s, still bounded by the 30 s timeout; the tests use SIGKILL (the OOM killer's signal) for "killed" for that reason. Per call, 12 boxes and 11
arrows, 8 sequential calls, load 8: **Worker** 304-666 ms for the first, then 66-77 ms (median 69-71): warm only because
the library and the fonts stay in the host; **child process** 295-340 ms for every call (median 298-326), 4 calls through
the cap of 2 in 670-720 ms. Hydration is one journaled `hydrate` step. Dependencies, exact: `@excalidraw/excalidraw` 0.18.0 (legacy's version),
`@napi-rs/canvas` 1.0.13 (a prebuilt native module per platform, optional dependencies in the lockfile), `react`
and `react-dom` 19.3.1 (the library's peers, loaded but never rendered).

Traps found on the way, all handled in `hydrate.ts` / `dom-shim.ts`:
- The library multiplies every measured width by 10 when it thinks it runs under a test runner (`MODE === "test"`,
  which `bun test` sets); the child is started with `NODE_ENV=production` and nothing else in its environment.
- The shim lives in the child's global scope; importing it into the host process would give every other workflow a
  `window` and a `document`.
- A font family that registers no file throws (`registerFonts`): a canvas without the font measures in a fallback and
  every label of that family would come out the wrong width without a sign.
- A family ships as unicode-range subsets, and a canvas font string takes one typeface per name: each subset is
  registered under its own alias and the library's font string is rewritten to the list (per-glyph fallback). `Helvetica`
  maps to Liberation Sans (metric-compatible). Xiaolai (CJK, 209 files) is not registered: CJK falls back to a system font.
- Legacy widths come from a fallback font, so its labels are narrower than the app's: a legacy diagram opened in
  Excalidraw can overflow where this one fits.

## Eval

Suite `diagram` (`agw eval run diagram`), plain cases in `$AGW_EVAL_DIR/diagram/cases.jsonl` (private): the legacy bench
brief, an architecture, a flow, an extend on an existing drawing, German labels, a dense one. The scorer
(`scorer.ts`, `metrics.ts`) follows the pre-registered rule in `docs/research/2026-10-29-wave7-ports.md` §diagram:
`valid` (a v2 document), `elementCount`, `boundArrowShare` (both ends bound to existing ids), `overlaps` (crossing
shapes; a shape holding another entirely is a container, not an overlap), `textOverflow` (a label wider than its
container); a case's reference only bounds the element count (`inRange`). An invalid run scores `valid: 0` and nothing
else, so a failure counts in the valid rate and never pulls another mean down; the other means are over valid runs, for
both arms. The legacy arm was run once against agent-gateway's job API (a scratch directory per run; an extend job that left the
seeded file byte-identical counted as invalid) and scored with the same metrics. The job view carried no cost, so a
run's cost was joined from the usage tracker's `agent-gateway-sessions.jsonl`, and a join that could have counted another
caller's job was flagged. The script is deleted with the gateway (Wave 11); the recorded report stays next to the cases.

## Route

Model and rate: `packages/routes/src/table/diagram.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `diagram.agent` | `excalidraw` (Wave 10 bench ran Haiku 5.5 EU on OpenCode; Terra medium since 2026-10-30) | opencode |

Token effect: one read-only session that answers the skeleton JSON on `check`'s model and wire, about 25 s and $0.003-0.005 in the legacy bench; the host hydrates in code.
