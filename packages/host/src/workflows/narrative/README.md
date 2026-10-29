# Narrative (Wave 10)

`agw narrative --cwd <repo> --project <name> [--previous-page …] [--since …]` (`src/workflows/narrative/`): writes or
revises ONE project's narrative page for the Obsidian vault: what the project is, where it stands, how it got here, in
business terms. Port of agent-gateway's `narrative` job (`server/jobs/handlers/narrative.ts`, `server/skills/narrative.md`).
**The workflow returns the page and never writes into a vault or a repo**; the caller (Hermes' `project-narratives.py`) does.

| Step | What |
|-|-|
| `gather` | code: the commits (`git log --no-merges`) and the session-transcript prose since the cutoff, with legacy's bounds verbatim (`gather.ts`: bootstrap 180 days or 120 commits, 12 sessions, 1 MB transcript tail, 40 KB sessions, 30 KB commits, 4 KB minimum file, 3 blocks of 200+ chars per session). Git and the transcript directory are ports |
| `compose` | the `narrative.compose` capability (route `narrative`): the skill text, the voice contract, the nonce-fenced facts and the post-data reassertion; JSON only; one re-ask on a rejected answer |
| `render` | code: link and comment stripping, the section caps, the page with its frontmatter (`sections.ts`) |
| `polish` | a child run (`narrative-polish`, internal) of `prose-polish`'s steps on the body (medium `vault`, `verdictFirst: false`, the headings listed as the brief), frontmatter kept verbatim |

Input: `cwd` (at most 1000 chars), `project`, `previousPage` (default null), `since` (an ISO datetime, default null: an unparseable one would silently drop every session), `polish` (default true). The free `model`
override is gone (the model is the `narrative` route's; `AGW_ROUTES` overrides it). Output is agent-gateway's, field for field,
minus `backend` (the platform has one): `project`, `changed`, `reason`, `summary`, `page`, `sections`, `inputs`, `model`,
`prose{status, kept, keptReason, costUsd}`.

- **Nothing to say is a correct answer.** No commits and no sessions answer `changed: false` without a model call; the
  composer may answer `changed: false` too.
- **The polish never fails the run.** A polish that fails (a reviewer, writer or voice-guide failure) leaves the unpolished
  page with `prose.status: errored` and `keptReason: prose failed: <the child's error>`; a gate refusal or a changed
  heading list leaves it with `declined` and the reason. The child (`narrative-polish`) runs `prose-polish`'s `polishDraft`
  and answers `{ok, output | error}`: a plain failed child run would only be a `null` with no message. A cancel, a
  shutdown and an infrastructure failure are not caught, and a cancelled parent ends cancelled.
- **Transcripts read.** Bootstrap reads the newest 12; a real cutoff the newest 24 changed since it (legacy had no cap
  there: a project with hundreds of files read them all).
- **Capability.** `narrative.compose` takes the gathered facts, never a prompt, and is `internal` (not served over HTTP or the CLI). Where
  legacy re-asked once with a JSON-only directive after a rejected answer (and once more after a session failure), the
  call is `completeJson` (one re-ask echoing the rejection) and the transport's own retries; a second rejected answer fails
  the run, as the legacy job threw.
- **Route.** `narrative` (`packages/routes/src/table/narrative.ts`): `iu-anthropic`, Haiku 5.5, legacy's CLASSIFY tier. The
  gateway ran a tool-less OpenCode session; the platform asks for the same JSON as one Messages request.
- The page's frontmatter still says `generated_by: agent-gateway/narrative` (legacy's, so the vault does not churn).
