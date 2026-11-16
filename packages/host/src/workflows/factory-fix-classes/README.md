# factory-fix-classes

software-factory's Improve screen shows fix commits per week by class (a KPI in its `docs/product.md`). A commit whose
conventional scope and subject settle the class is sorted in code over there; the rest come to this workflow, which gives each
one class from the list the caller sends. The factory never calls a model (SF2).

```
echo '{"repo":"example-app","classes":[{"key":"logic","meaning":"…"},{"key":"other","meaning":"…"}],"commits":[{"sha":"a1b2c3d","subject":"…","scope":null,"body":"","files":["src/a.ts"]}]}' | agw factory-fix-classes --format json
```

| | |
|-|-|
| Input (stdin JSON) | `{repo, classes[{key, meaning}], commits[{sha, subject, scope\|null, body, files[]}]}`. 1 to 32 classes (unique keys, identifiers), 1 to 40 commits (unique shas), `body` at most 800 characters, `files` at most 20 paths. `subject`, `scope`, `body` and `files` are untrusted. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}` |
| Output | the run envelope's `output`: `{answers: [{sha, class, reason}]}`; exactly one answer per input sha, `class` one of the input `classes[].key`, `reason` one sentence on one line (at most 240, the factory's parser; a longer one from the model is clipped at a word boundary with `…`, never re-asked) |
| Shape | one journaled step (`sort`), one tool-free call to the internal `factory.fixclasses` capability |
| Fixture | `packages/host/test/fixtures/software-factory-fix-classes.json` (one request, one valid answer); software-factory mirrors it at `packages/contract/fixtures/fix-classes.json` |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.fixclasses` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **The classes travel in the input.** The workflow hardcodes none of them: the class list and what each means are the
  caller's. `meaning` is supplied by the factory and sits outside the data fence, collapsed to one line.
- **Data is fenced.** The instructions and the class list sit outside the fence; every commit (sha, scope, subject, paths, body)
  sits inside one fenced block with its fence markers neutralized and the nonce computed over all of the free text.
- **A wrong answer is a schema failure, never repaired.** The capability checks the model's JSON against the request: a sha
  that is not in the input, a missing sha, a duplicate sha or a class outside the keys fails the schema, is re-asked once, and
  then fails the run. Nothing is dropped, filled in or corrected; the factory retries a failed run with a backoff.
- **Nothing is cut.** A request over the limits is a 400; the caller cuts (the body to 800, the paths to 20, the batch to 40).
- **The answer's shape is held by the schema; whether it is right is the eval's** (below).

## Route

`factory.fixclasses`: the `EASY` tier (Haiku high) on the native Messages wire; the model lives only in the tier.

## Eval

`agw eval run factory-fix-classes [--yes]` replays `eval/cases.jsonl` (9 cases of 3 or 4 commits, committed): 28 fix commits
of this public repo (real shas, subjects, bodies and changed paths, read from `git`) and 2 written ones for the class the
repo's own history lacks (a fix in documentation only), under the factory's real class list. The reference is one reader's
class per commit; `basis` says how it was settled: `files` (the changed paths decide it: tests only, scripts only), `reading`
(subject and body) or `written`. Scores: `accuracy` over all commits, `mechanical` over the `files` ones (a model that misses
those is wrong beyond argument) and `judged` over the rest; `valid` fails an answer that does not cover the case's shas. The
`judged` labels are one reader's: a class two readers would split is a limit of the set (`logic` against `contract` against
`concurrency`), not of the model. The `files` labels are held to what the paths settle with no second reading: three fixes of
`scripts/deploy.sh` and a probe script, first labelled `tooling` from their paths, were dropped after the first run, because a
fix of a deploy script is as much `environment` (the class's own words: deploy, host) as `tooling` (scripts).
