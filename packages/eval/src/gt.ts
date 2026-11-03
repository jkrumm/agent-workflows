import { join } from 'node:path'
import { z } from 'zod'
import { evalDir } from './cases.ts'

/**
 * The review ground truth (`docs/review-v2.md` §Ground truth): bugs mined from the owner's fix history with SZZ, each
 * confirmed by two of three labelers on different vendors, plus clean controls. The contract between the miner
 * (`eval.mine`), the labelers (`eval.label`), the judges (`eval.judge`), review's scorer and the judge calibration.
 * Every file lives under `$AGW_EVAL_DIR/review-gt/` (mode 0600): cases name private repos, so none of it enters this
 * public repo. No human checks any of it: every report states `GT_LIMIT`.
 */
export const GT_DIR = 'review-gt'

/** The limit of this ground truth, carried by every report that rests on it (mine, calibration, the scorer's notes). */
export const GT_LIMIT = 'LLM consensus (labellers a/b/c, judges a/b), no human check'

/** `$AGW_EVAL_DIR/review-gt/<file>`. */
export const gtPath = (file: GtFile, env: Record<string, string | undefined> = process.env) =>
  join(evalDir(env), GT_DIR, file)

/**
 * The files of the ground truth, all JSONL but `report.json`:
 * - `candidates.jsonl`: SZZ output (`GtCandidate`), rewritten whole by each mine;
 * - `labels.jsonl`: one `GtLabelRecord` per labelled candidate, appended; the miner's resume point (a candidate with a
 *   record is never labelled again under the same `labelerVersion`; seat `c` is added to its record later, in place);
 * - `cases.jsonl`: the suite `agw eval run review` reads (`GtCase`: accepted bugs and controls);
 * - `rejected.jsonl`: candidates the labelers did not accept (`GtRejected`);
 * - `report.json`: aggregates only (counts per filter, per accept path and per reject reason), the input of the committed report;
 * - `judge-calibration.json`: aggregates only, the agreement of the two judges (`eval.gt.calibrate`) the scorer reads;
 * - `judge-b.jsonl`: judge `b`'s answers as the calibration collects them (`JudgeBRecord`), its resume point.
 */
export type GtFile =
  | 'candidates.jsonl'
  | 'labels.jsonl'
  | 'cases.jsonl'
  | 'rejected.jsonl'
  | 'report.json'
  | 'judge-calibration.json'
  | 'judge-b.jsonl'

export const Sha = z.string().regex(/^[0-9a-f]{40}$/)
/** A repo path relative to `$HOME`. `SourceRoot` only: IU repos stay out of the cases (owner decision, 2026-11-01). */
export const GtRepo = z.string().regex(/^SourceRoot\/[^/]+$/)
export const GtSplit = z.enum(['dev', 'test'])
/** Share of cases in `dev` (40 of 200): prompts iterate on `dev`, arms are decided on `test`. */
export const DEV_SHARE = 0.2

/** A bug's class: the vocabulary of labelers, finders and the judge alike. */
export const BugClass = z.enum([
  'logic',
  'edge-case',
  'error-handling',
  'concurrency',
  'security',
  'data',
  'contract',
  'config',
  'resource',
  'performance',
  'ui',
  'other',
])
export type BugClass = z.infer<typeof BugClass>
export const BugSeverity = z.enum(['critical', 'major', 'minor'])

/** Lines in the introducing commit's post-image (the file as that commit left it), 1-based, inclusive. */
export const GtLocation = z
  .object({
    file: z.string().min(1),
    startLine: z.int().positive(),
    endLine: z.int().positive(),
  })
  .strict()
  .refine((l) => l.endLine >= l.startLine, 'endLine < startLine')
export type GtLocation = z.infer<typeof GtLocation>

/** One SZZ candidate: a fix commit and one commit its removed or changed lines blame to (the introducing commit). */
export const GtCandidate = z
  .object({
    /** `<repo dir>-<fixSha[:10]>-<introSha[:10]>`: stable across mines. */
    id: z.string().min(1),
    repo: GtRepo,
    fixSha: Sha,
    fixSubject: z.string(),
    fixDate: z.iso.datetime({ offset: true }),
    introSha: Sha,
    introParent: Sha,
    introSubject: z.string(),
    introDate: z.iso.datetime({ offset: true }),
    /** Lines of the introducing commit's post-image the fix removed or changed (after the cosmetic filter). */
    blamed: z.array(z.object({ file: z.string(), line: z.int().positive() }).strict()).min(1),
    /** Added plus deleted lines of the introducing commit (`git show --numstat`, binaries excluded). */
    introChangedLines: z.int().nonnegative(),
    minerVersion: z.string(),
  })
  .strict()
export type GtCandidate = z.infer<typeof GtCandidate>

/** One labeler's answer about a candidate (`eval.label`'s output, minus `model`). */
export const GtLabel = z
  .object({
    /** The introducing commit created a defect that the fix repairs: not a feature change, a refactor or a preference. */
    defect: z.boolean(),
    /** Where the defect is in the introducing commit's post-image; null when `defect` is false. */
    location: GtLocation.nullable(),
    /** One paragraph: what is wrong, the input or state that triggers it, the wrong result. */
    description: z.string(),
    bugClass: BugClass,
    severity: BugSeverity,
    /** One sentence: why this is, or is not, a defect of the introducing commit. */
    reason: z.string(),
  })
  .strict()
export type GtLabel = z.infer<typeof GtLabel>

/** The labelers: `a` on Claude, `b` on GPT, `c` on Gemini (cross-vendor by design); `c` is asked only when `a` and `b` disagree. */
export const LabelerSeat = z.enum(['a', 'b', 'c'])
export type LabelerSeat = z.infer<typeof LabelerSeat>

export const GtLabelResult = z.union([
  GtLabel.extend({ model: z.string() }).strict(),
  z.object({ error: z.string() }).strict(),
])

/**
 * `labels.jsonl`: each seat's answer for one candidate, or the error of a seat that failed. `a` and `b` are checked
 * against `labelerVersion`. `c` is added later and only when they disagree; it carries its own version (`cVersion`),
 * so adding it never invalidates `a` and `b`, and the run that paid for it (`cRunId`).
 */
export const GtLabelRecord = z
  .object({
    candidateId: z.string(),
    labelerVersion: z.string(),
    at: z.iso.datetime(),
    a: GtLabelResult,
    b: GtLabelResult,
    c: GtLabelResult.optional(),
    cVersion: z.string().optional(),
    cRunId: z.string().optional(),
    /** The eval run that paid for the calls of `a` and `b` (its `cost` is their sum). */
    runId: z.string(),
  })
  .strict()
export type GtLabelRecord = z.infer<typeof GtLabelRecord>

/**
 * The acceptance rule (2 of 3): at least two seats answered `defect` and the locations of two of those name the same
 * file and overlap within `LOCATION_SLACK` lines. Anything else is a rejection with its reason. The reasons for a
 * record without `c` are `a-no`, `b-no`, `both-no`, `no-overlap` and `labeler-error`; with `c`, a disagreement that
 * `c` did not settle is `c-no` (it says no), `c-no-overlap` (it says defect elsewhere) or `c-error`.
 */
export const LOCATION_SLACK = 3
export const RejectReason = z.enum([
  'a-no',
  'b-no',
  'both-no',
  'no-overlap',
  'labeler-error',
  'c-no',
  'c-no-overlap',
  'c-error',
])
/** The pair of seats that agreed on an accepted case. */
export const AcceptPath = z.enum(['a+b', 'a+c', 'b+c'])
export type AcceptPath = z.infer<typeof AcceptPath>

const caseBase = {
  id: z.string().min(1),
  split: GtSplit,
  repo: GtRepo,
  /** The commit under review; a run checks it out and reviews it (`scope: 'head'`). */
  sha: Sha,
  parent: Sha,
  subject: z.string(),
  minerVersion: z.string(),
}

/** An accepted bug case: the introducing commit and the bug it created. The location is labeler `a`'s, else the agreeing pair's first seat. */
export const GtBugCase = z
  .object({
    ...caseBase,
    kind: z.literal('bug'),
    bug: z
      .object({
        location: GtLocation,
        description: z.string(),
        bugClass: BugClass,
        severity: BugSeverity,
        fixSha: Sha,
        fixSubject: z.string(),
      })
      .strict(),
    candidateId: z.string(),
  })
  .strict()

/** A clean control: no later fix within 12 weeks touched its changed code lines and no SZZ candidate blames it. */
export const GtControlCase = z.object({ ...caseBase, kind: z.literal('control') }).strict()

export const GtCase = z.discriminatedUnion('kind', [GtBugCase, GtControlCase])
export type GtCase = z.infer<typeof GtCase>
export type GtBugCase = z.infer<typeof GtBugCase>

export const GtRejected = z
  .object({ candidateId: z.string(), reason: RejectReason, labelerVersion: z.string() })
  .strict()

/** A review finding as the judge and the scorer see it, whatever the arm's output version. */
export const GtFinding = z
  .object({
    /** Stable within one review output: its index as a string when the arm has no ids. */
    id: z.string(),
    /** `important` blocks a merge (v1: `blocking`); `nit` does not (v1: `improvement`, `discussion`). */
    tag: z.enum(['important', 'nit', 'pre-existing']),
    file: z.string(),
    line: z.int().positive().optional(),
    endLine: z.int().positive().optional(),
    message: z.string(),
  })
  .strict()
export type GtFinding = z.infer<typeof GtFinding>

/** The judge's class of a finding. `match`: it describes the case's known bug. */
export const JudgeClass = z.enum(['match', 'real', 'not-a-bug', 'nit', 'unclear'])
export type JudgeClass = z.infer<typeof JudgeClass>

/** `eval.label`'s input: one seat's look at one candidate. Diffs are cut by the capability, never by the caller. */
export const LabelInput = z
  .object({
    seat: LabelerSeat,
    candidateId: z.string(),
    introSubject: z.string(),
    /** The introducing commit's message body (subject excluded), possibly empty. */
    introBody: z.string(),
    /** `git show --format= <introSha>`: the diff whose post-image the location must point into. */
    introDiff: z.string(),
    fixSubject: z.string(),
    fixBody: z.string(),
    /** `git show --format= <fixSha>`. */
    fixDiff: z.string(),
    /** The SZZ-blamed lines, a hint for where to look; the labeler may place the defect elsewhere in the post-image. */
    blamed: GtCandidate.shape.blamed,
  })
  .strict()
export type LabelInput = z.infer<typeof LabelInput>
export const LabelOutput = GtLabel.extend({ model: z.string() }).strict()
export type LabelOutput = z.infer<typeof LabelOutput>

/** The judges: `a` on Claude, `b` on GPT. The same capability and prompt, two vendors; their agreement is the κ. */
export const JudgeSeat = z.enum(['a', 'b'])
export type JudgeSeat = z.infer<typeof JudgeSeat>

/**
 * `eval.judge`'s input: one case's review. For a bug case, `bug` is the known bug and `preselected` the ids of the
 * findings the token-overlap matcher let through (same file, or naming it); only those may be judged `match`. For a
 * control, `bug` is null and `preselected` empty. Every finding gets a class either way.
 */
export const JudgeInput = z
  .object({
    caseId: z.string(),
    bug: z.object({ location: GtLocation, description: z.string() }).strict().nullable(),
    findings: z.array(GtFinding),
    preselected: z.array(z.string()),
    /** The reviewed commit's diff (`git show --format= <sha>`), cut by the capability. */
    diff: z.string(),
    /** The judge seat, default `a`. */
    seat: JudgeSeat.optional(),
  })
  .strict()
export type JudgeInput = z.infer<typeof JudgeInput>

export const JudgeOutput = z
  .object({
    findings: z.array(z.object({ id: z.string(), class: JudgeClass, reason: z.string() }).strict()),
    model: z.string(),
  })
  .strict()
export type JudgeOutput = z.infer<typeof JudgeOutput>

/**
 * `judge-calibration.json` (`eval.gt.calibrate`): how far the two judges agree on whether a finding describes the
 * case's bug. Aggregates only. The review scorer reads it: one judge when `kappa` clears the bar for this judge version,
 * else both. `confusion` is judge `a` (rows) against judge `b`: `yy` both match, `yn` a match and b not, and so on.
 */
export const JudgeCalibration = z
  .object({
    at: z.iso.datetime(),
    limit: z.string(),
    /** The versions of the two judges; the scorer trusts the file only while both are current. */
    judgeVersions: z.object({ a: z.string(), b: z.string() }).strict(),
    judgeModels: z.object({ a: z.array(z.string()), b: z.array(z.string()) }).strict(),
    evalRuns: z.array(z.string()),
    /** Pairs both judges answered. */
    n: z.int().nonnegative(),
    agreement: z.number().nullable(),
    kappa: z.number().nullable(),
    ci95: z.object({ lo: z.number(), hi: z.number() }).strict().nullable(),
    bar: z.number(),
    met: z.boolean(),
    confusion: z.object({ yy: z.int(), yn: z.int(), ny: z.int(), nn: z.int() }).strict(),
    /** Findings neither judge called a match: how often they give the same class. */
    classes: z
      .object({
        n: z.int().nonnegative(),
        agreement: z.number().nullable(),
        /** judge `a`'s class → judge `b`'s class → findings. */
        confusion: z.record(z.string(), z.record(z.string(), z.int())),
      })
      .strict(),
  })
  .strict()
export type JudgeCalibration = z.infer<typeof JudgeCalibration>

/**
 * `judge-b.jsonl`: judge `b`'s answer on one recorded judge-`a` call, keyed by that call's run id and judge `b`'s
 * version. Appended as each answer arrives, so a stopped calibration keeps what it paid for; the latest line wins.
 */
export const JudgeBRecord = z
  .object({ runId: z.string(), judgeBVersion: z.string(), at: z.iso.datetime(), output: JudgeOutput })
  .strict()
export type JudgeBRecord = z.infer<typeof JudgeBRecord>
