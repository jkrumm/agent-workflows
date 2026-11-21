# The Judge reads the class, the Issue as filed and the Spec's head

**Route unchanged: `factory.ask` stays the `HARD` tier call (Sonnet 5.5, effort medium).** The prompt, the input and twelve new
cases changed; the model did not. Workflow version `2026-11-21.1`, scorer `2026-11-11.1` (the scorer is unchanged: new cases
only add rows).

## Why

A lead's Spec no longer waits for the owner: what is his arrives as a Decision, so the Judge is the only reader in front of him.
It saw the question, the options, what the lead checked and earlier answers, but not the Issue as filed (where a planner quotes
what the owner already said) and not the Spec the question belongs to. In the week to 2026-11-21, 88 of 113 Specs reached the
owner; 49 were "Looks good" and 28 "With notes", and several of those notes say the Spec could have been decided without him.

## What changed

| | Before | After |
|-|-|-|
| Decision input | question, options, checked, precedents | the same, plus optional `class`, `facts` (the Issue as filed, at most 8,000 characters) and `spec` (its head, at most 20,000) |
| Owner when | the ask turns on taste, spend, data loss, other people, security or an owner-only fact | all three: the question is in one of eight classes (`direction`, `look`, `own_surface`, `spend`, `security`, `people`, `irreversible`, `owner_fact`), its answer changes what is built, and the default cannot be taken back by a revert |
| Outside the classes | derived from the plan, the facts or the default | answered with the lead's recommendation (source `default`); "is this plan right" gets the recommendation |
| A direction quoted from the owner in the filed text | not read | answers the question it covers (source `facts: <quote>`) |
| Code guards | an option that cannot be taken back is the owner's; an answer cites a source | unchanged |

A Decision with none of the new fields is assembled exactly as before (`askOfJudge`, tested).

## The set

46 cases, 34 as before and 12 new, from real Specs of 2026-11-14 to 2026-11-21 rewritten to placeholders (repos, hosts, ids and
dates gone). Five Specs the owner sent back with "Changes" are `owner`: a release feed's experience for its users, a build
platform of our own against an existing one, a public guide's address, the look and surface variants of a side panel, a new
surface for his own reviews. Seven Specs he answered with "you decide" or "do your best" are `answer`: a catalog field's
optionality, filter-or-delete of old rows (with an irreversible option), a chart point's name, a form footer's default, a
package subpath's name, a KPI's denominator, a gate's statistic.

## Result

`agw eval run factory-ask` on the deployed route before the change: 30 of 34 (88 %), the four failures `dotfiles-686`,
`weatherorb-697`, `legacy-admin-merge-allow`, `legacy-slack-off`. The comparison below runs the workflow's own logic (the
`factory.ask` capability, `askOfJudge`, `guardAsk`, `guardJudge`) and the repo's scorer over the 46 cases, three runs per arm,
one arm on the code at the parent commit and one on this change, on the same route: 138 case runs each.

| | Before | After |
|-|-|-|
| Pass (every applicable score), 46 cases | 119 of 138 (86 %) | 124 of 138 (90 %) |
| Reference `owner` kept with the owner, 21 cases | 47 of 63 (75 %) | 54 of 63 (86 %) |
| The five sent-back Specs come out `owner` | 8 of 15 | 15 of 15 |
| The seven "you decide" Specs come out `answer` | 21 of 21 | 21 of 21 |
| Reference `answer` answered, 22 cases | 63 of 66 | 61 of 66 |
| Pass on the original 34 | 90 of 102 | 88 of 102 |

No case that held `owner` before answers more often now. Three `owner` cases are answered by the Judge in both arms
(`legacy-admin-merge-allow`, `legacy-slack-off`, `weatherorb-697`); they were failing before the change. Two `answer` cases escalate more: `door-448` (owner token, a do-nothing default; 2 of 3 before, 0 of 3 after) and
`steward-632-0` (3 of 3, then 2 of 3). That is the price of the rule that a question asking the owner to supply a fact or perform
an action is his whatever the default. Run to run the arms move by two or three cases on 46, so read the table as a direction, not a
difference of a point.

## Wording that mattered

The three conditions alone did not move the five Specs: every option was reversible in the code, so the Judge answered. They came
out `owner` once the rules said what "taken back by a revert" means (what people meet outside the code, a public URL or domain, a
look, a surface, a platform, is not undone by a revert even when changing it later is one line), that a lead's own build plan under
its open choices is no evidence the owner agreed, that the lead's recommendation is not a declared default, and that "shipping
fewer" and "our own against an existing platform" are still choices of what people get or what we maintain.

## Limits

Three runs of 46 cases per arm, no interval computed: a case flips between runs, so a few points either way is noise. The local
comparison does not journal runs, so cost, wall time and tokens per arm are not recorded; the deployed route's mean was about
$0.006 a call on the 34-case run, and the new prompt carries roughly 60 more lines of rules plus the Issue text and the Spec's
head (up to 28,000 characters) when the factory sends them. The first `agw eval run factory-ask` on the deployed release after
this change scores the 46 cases through the journal.
