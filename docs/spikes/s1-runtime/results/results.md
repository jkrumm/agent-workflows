## Summary

| metric | own | dbos | vercel |
|-|-|-|-|
| scenarios ok (first run) | 13/13 | 11/15 | 9/13 |
| isolated reruns of non-ok rows that were ok | 0/0 | 0/4 | 0/4 |
| kill scenarios ok, first run (9) | 9/9 | 9/9 | 6/9 |
| completed steps re-executed (all runs) | 0 | 0 | 0 |
| in-doubt re-runs (kill between step end and journal) | 2 | 2 | 2 |
| runs where the effect was not inserted exactly once | 0 | 0 | 0 |
| effect retries absorbed by the key | 1 | 1 | 1 |
| m-agent (SIGKILL at 30 s): agent wall, sessions, prompts | 60.2 s; 1 session(s), 0 orphan; prompts 1 sent, 1 no-op | 60.1 s; 1 session(s), 0 orphan; prompts 1 sent, 1 no-op | - s; 1 session(s), 0 orphan; prompts 1 sent, 1 no-op |
| m-agent-open (SIGKILL after session create, before handle write) | 60.2 s; 2 session(s), 1 orphan; prompts 1 sent, 0 no-op | 60.0 s; 2 session(s), 1 orphan; prompts 1 sent, 0 no-op | 60.1 s; 2 session(s), 1 orphan; prompts 1 sent, 0 no-op |
| runs that sent more than one prompt | 0 | 0 | 0 |
| median restart to first step activity, incl. process start and SDK launch (s) | 0.2 | 1.4 | 2 |
| deploy, compatible change | ok, finished on v2 | stuck: no outcome 120s after restart; isolated rerun: stuck: no outcome 120s after restart | ok, finished on v2 |
| deploy, step inserted ahead of the run's position | ok, finished on v2-break | stuck: no outcome 120s after restart; isolated rerun: stuck: no outcome 120s after restart | ok, finished on v2-break |
| deploy, step inserted before recorded steps | ok, finished on v2-break | stuck: no outcome 120s after restart; isolated rerun: stuck: no outcome 120s after restart | FAIL: no outcome (failed); isolated rerun: FAIL: no outcome (failed) |
| deploy, pinned version (DBOS only) | - | ok, finished on v2 | - |
| deploy, pinned, step inserted before recorded (DBOS only) | - | FAIL: no outcome (failed); isolated rerun: FAIL: no outcome (failed) | - |
| stuck rows and their follow-up | - | deploy #1: v1 process finished it in 4 s; deploy #2: v1 process finished it in 5 s; deploy-break #1: v1 process finished it in 5 s; deploy-break #2: v1 process finished it in 4 s; deploy-break-late #1: v1 process finished it in 4 s; deploy-break-late #2: v1 process finished it in 3 s | b-finish #1: 2 locks back-dated; v1 process finished it in 57 s; b-finish #2: 3 locks back-dated; v1 process finished it in 20 s; m-agent #1: 1 locks back-dated; v1 process finished it in 47 s; m-agent #2: 1 locks back-dated; v1 process finished it in 53 s; m-child #1: 3 locks back-dated; v1 process finished it in 13 s; m-child #2: 3 locks back-dated; v1 process finished it in 12 s |
| middleware run/pre,step/pre,step/post,run/post (happy) | 4/8/8/4 | 1/8/7/1 | 1/8/7/1 |
| LOC runtime / workflow+wiring | 163 / 39 | 0 / 50 | 40 / 83 |
| deps direct / transitive | 1 / 14 | 1 / 22 | 2 / 358 |
| install size (MB) | 0.5 | 10.3 | 190.3 |
| Postgres tables / indexes | 2 / 2 | 13 / 38 | 15 / 32 |
| engine schemas after one happy run on fresh schemas (kB, incl. empty-table overhead) | 64 | 632 | 712 |
| happy path wall (s) | 64.5 | 65.7 | 66.4 |
| Postgres restarts hit (reruns) | 0 | 0 | 0 |

## Per scenario

| candidate | scenario | run | outcome | completed re-runs | in-doubt re-runs | effect inserted | key-absorbed retries | sessions (orphans) | prompts sent / no-op | agent wall s | restart to first step activity s | finished on | engine status | follow-up | mw pre/sPre/sPost/post | total s |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| own | happy | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | - | v1 | done | - | 4/8/8/4 | 64.5 |
| own | b-agent | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | 0.2 | v1 | done | - | 5/9/8/4 | 66.9 |
| own | b-effect | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 0.4 | v1 | done | - | 5/9/8/4 | 67.4 |
| own | b-fanout | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | 0.3 | v1 | done | - | 6/10/8/4 | 67.6 |
| own | b-finish | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 0.2 | v1 | done | - | 5/9/8/4 | 67 |
| own | m-prepare | 1 | ok | 0 | 1 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 0.1 | v1 | done | - | 5/9/8/4 | 67.2 |
| own | m-agent-open | 1 | ok | 0 | 1 | 1 | 0 | 2 (1) | 1 / 0 | 60.2 | 0.1 | v1 | done | - | 5/9/8/4 | 67.3 |
| own | m-agent | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.2 | 0.1 | v1 | done | - | 5/9/8/4 | 65.6 |
| own | m-effect | 1 | ok | 0 | 0 | 1 | 1 | 1 (0) | 1 / 0 | 60 | 0.3 | v1 | done | - | 5/9/8/4 | 67.3 |
| own | m-child | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 0.1 | v1 | done | - | 8/12/8/4 | 67.5 |
| own | deploy | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.1 | 0.1 | v2 | done | - | 5/9/8/4 | 64.7 |
| own | deploy-break | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.2 | 0.1 | v2-break | done | - | 5/10/9/4 | 64.7 |
| own | deploy-break-late | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 0.2 | v2-break | done | - | 6/11/9/4 | 67 |
| dbos | happy | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | SUCCESS | - | 1/8/7/1 | 65.7 |
| dbos | b-agent | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.4 | v1 | SUCCESS | - | 2/9/7/1 | 70.9 |
| dbos | b-effect | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.2 | v1 | SUCCESS | - | 2/9/7/1 | 69.1 |
| dbos | b-fanout | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.3 | v1 | SUCCESS | - | 2/9/7/1 | 70.3 |
| dbos | b-finish | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.4 | v1 | SUCCESS | - | 2/9/7/1 | 69.1 |
| dbos | m-prepare | 1 | ok | 0 | 1 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 1.8 | v1 | SUCCESS | - | 2/9/7/1 | 70.1 |
| dbos | m-agent-open | 1 | ok | 0 | 1 | 1 | 0 | 2 (1) | 1 / 0 | 60 | 1.3 | v1 | SUCCESS | - | 2/9/7/1 | 69.1 |
| dbos | m-agent | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.1 | 1.6 | v1 | SUCCESS | - | 2/9/7/1 | 65.6 |
| dbos | m-effect | 1 | ok | 0 | 0 | 1 | 1 | 1 (0) | 1 / 0 | 60.1 | 2.1 | v1 | SUCCESS | - | 2/9/7/1 | 70.6 |
| dbos | m-child | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.4 | v1 | SUCCESS | - | 2/11/7/1 | 69.7 |
| dbos | deploy | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | PENDING | v1 process finished it in 4 s | 2/9/7/1 | 154.9 |
| dbos | deploy | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | PENDING | v1 process finished it in 5 s | 2/9/7/1 | 156.3 |
| dbos | deploy-break | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | PENDING | v1 process finished it in 5 s | 2/9/7/1 | 155.1 |
| dbos | deploy-break | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | PENDING | v1 process finished it in 4 s | 2/9/7/1 | 155.2 |
| dbos | deploy-break-late | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | PENDING | v1 process finished it in 4 s | 2/10/7/1 | 186.7 |
| dbos | deploy-break-late | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | - | v1 | PENDING | v1 process finished it in 3 s | 2/10/7/1 | 187.9 |
| dbos | deploy-pinned | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.2 | 1.6 | v2 | SUCCESS | - | 2/9/7/1 | 65.6 |
| dbos | deploy-break-late-pinned | 1 | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 1.6 | - | ERROR | - | 2/8/6/0 | 68.4 |
| dbos | deploy-break-late-pinned | 2 | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | 1.4 | - | ERROR | - | 2/9/6/0 | 67.7 |
| vercel | happy | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.3 | - | v1 | completed | - | 1/8/7/1 | 66.4 |
| vercel | b-agent | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | 1.2 | v1 | completed | - | 1/9/7/1 | 70.3 |
| vercel | b-effect | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 2 | v1 | completed | - | 1/9/7/1 | 71.6 |
| vercel | b-fanout | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.3 | 2.4 | v1 | completed | - | 1/9/7/1 | 71.5 |
| vercel | b-finish | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | running | 2 locks back-dated; v1 process finished it in 57 s | 1/9/7/1 | 190 |
| vercel | b-finish | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | running | 3 locks back-dated; v1 process finished it in 20 s | 1/9/7/1 | 190.9 |
| vercel | m-prepare | 1 | ok | 0 | 1 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | 1.8 | v1 | completed | - | 1/9/7/1 | 70.5 |
| vercel | m-agent-open | 1 | ok | 0 | 1 | 1 | 0 | 2 (1) | 1 / 0 | 60.1 | 1.2 | v1 | completed | - | 1/9/7/1 | 70.6 |
| vercel | m-agent | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | running | 1 locks back-dated; v1 process finished it in 47 s | 1/9/7/1 | 155.7 |
| vercel | m-agent | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | - | - | v1 | running | 1 locks back-dated; v1 process finished it in 53 s | 1/9/7/1 | 156.2 |
| vercel | m-effect | 1 | ok | 0 | 0 | 1 | 1 | 1 (0) | 1 / 0 | 60.2 | 4.1 | v1 | completed | - | 1/9/7/1 | 73.1 |
| vercel | m-child | 1 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | running | 3 locks back-dated; v1 process finished it in 13 s | 1/11/7/1 | 188.2 |
| vercel | m-child | 2 | stuck (no outcome 120s after restart) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.2 | - | v1 | running | 3 locks back-dated; v1 process finished it in 12 s | 1/11/7/1 | 188 |
| vercel | deploy | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.1 | 1.5 | v2 | completed | - | 1/9/7/1 | 66.2 |
| vercel | deploy-break | 1 | ok | 0 | 0 | 1 | 0 | 1 (0) | 1 / 1 | 60.1 | 2.5 | v2-break | completed | - | 1/10/8/1 | 66.4 |
| vercel | deploy-break-late | 1 | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60 | 2.7 | - | failed CORRUPTED_EVENT_LOG | - | 1/7/6/1 | 71 |
| vercel | deploy-break-late | 2 | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 (0) | 1 / 0 | 60.1 | 1.6 | - | failed CORRUPTED_EVENT_LOG | - | 1/7/6/1 | 70.1 |
