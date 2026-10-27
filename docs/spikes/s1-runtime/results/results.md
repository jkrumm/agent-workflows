## Summary

| metric | own | dbos | vercel |
|-|-|-|-|
| scenarios ok | 12/12 | 10/14 | 7/12 |
| completed steps re-executed (all kills) | 0 | 0 | 0 |
| in-doubt re-runs (kill between step end and journal) | 1 | 1 | 1 |
| duplicate effects (rows > 1) | 0 | 0 | 0 |
| effect retries absorbed by key | 1 | 1 | 1 |
| agent step wall after kill at 30s (s) | 60.2 | 60.2 | - |
| agent sessions created in m-agent | 1 | 1 | 1 |
| median recovery after restart (s) | 0.1 | 1.3 | 1.2 |
| deploy, compatible change | finished on v2 | stuck: no outcome after 180s; 0 effect rows | finished on v2 |
| deploy, step inserted ahead of the run's position | finished on v2-break | stuck: no outcome after 180s; 0 effect rows | finished on v2-break |
| deploy, step inserted before recorded steps | finished on v2-break | stuck: no outcome after 180s; 0 effect rows | FAIL: no outcome (failed) |
| deploy, pinned version (DBOS only) | - | finished on v2 | - |
| deploy, pinned, step inserted before recorded (DBOS only) | - | FAIL: no outcome (failed) | - |
| status at end of measurement: deploy / deploy-break-late | done / done | SUCCESS / PENDING | completed / failed CORRUPTED_EVENT_LOG |
| middleware run/pre,step/pre,step/post,run/post (happy) | 4/8/8/4 | 1/8/7/1 | 1/8/7/1 |
| LOC runtime / workflow+wiring | 163 / 39 | 0 / 50 | 40 / 83 |
| deps direct / transitive | 1 / 14 | 1 / 22 | 2 / 358 |
| install size (MB) | 0.5 | 10.3 | 190.3 |
| Postgres tables / indexes | 2 / 2 | 13 / 38 | 15 / 32 |
| Postgres kB per run (engine tables / runs measured) | 12 | 63 | 121 |
| happy path wall (s) | 64.4 | 65.2 | 65.8 |
| Postgres restarts hit (reruns) | 0 | 0 | 0 |

## Per scenario

| candidate | scenario | outcome | completed re-runs | in-doubt re-runs | effect rows | key-absorbed retries | sessions | agent wall s | recovery s | finished on | engine status | status at end | after lock probe | mw pre/sPre/sPost/post | total s |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| own | happy | ok | 0 | 0 | 1 | 0 | 1 | 60 | - | v1 | done | done | - | 4/8/8/4 | 64.4 |
| own | b-agent | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 0.1 | v1 | done | done | - | 5/9/8/4 | 67.1 |
| own | b-effect | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 0.1 | v1 | done | done | - | 5/9/8/4 | 66.9 |
| own | b-fanout | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 0.2 | v1 | done | done | - | 6/10/8/4 | 66.8 |
| own | b-finish | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 0.1 | v1 | done | done | - | 5/9/8/4 | 67.4 |
| own | m-prepare | ok | 0 | 1 | 1 | 0 | 1 | 60.2 | 0.1 | v1 | done | done | - | 5/9/8/4 | 66.8 |
| own | m-agent | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 0.1 | v1 | done | done | - | 5/9/8/4 | 64.7 |
| own | m-effect | ok | 0 | 0 | 1 | 1 | 1 | 60 | 0.3 | v1 | done | done | - | 5/9/8/4 | 67 |
| own | m-child | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 0.1 | v1 | done | done | - | 8/12/8/4 | 67.3 |
| own | deploy | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 0.1 | v2 | done | done | - | 5/9/8/4 | 64.5 |
| own | deploy-break | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 0.1 | v2-break | done | done | - | 5/10/9/4 | 64.6 |
| own | deploy-break-late | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 0.1 | v2-break | done | done | - | 6/11/9/4 | 67.2 |
| dbos | happy | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | - | v1 | SUCCESS | SUCCESS | - | 1/8/7/1 | 65.2 |
| dbos | b-agent | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.3 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 68.3 |
| dbos | b-effect | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 1.2 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 68.3 |
| dbos | b-fanout | ok | 0 | 0 | 1 | 0 | 1 | 60 | 1.4 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 68.2 |
| dbos | b-finish | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.2 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 68 |
| dbos | m-prepare | ok | 0 | 1 | 1 | 0 | 1 | 60.1 | 1.3 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 67.9 |
| dbos | m-agent | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 1.3 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 64.9 |
| dbos | m-effect | ok | 0 | 0 | 1 | 1 | 1 | 60.2 | 1.2 | v1 | SUCCESS | SUCCESS | - | 2/9/7/1 | 68.1 |
| dbos | m-child | ok | 0 | 0 | 1 | 0 | 1 | 60 | 1.3 | v1 | SUCCESS | SUCCESS | - | 2/11/7/1 | 69.7 |
| dbos | deploy | stuck (no outcome after 180s; 0 effect rows) | 0 | 0 | 0 | 0 | 1 | - | - | - | PENDING | SUCCESS | - | 1/3/2/0 | 214 |
| dbos | deploy-break | stuck (no outcome after 180s; 0 effect rows) | 0 | 0 | 0 | 0 | 1 | - | - | - | PENDING | PENDING | - | 1/3/2/0 | 214.2 |
| dbos | deploy-break-late | stuck (no outcome after 180s; 0 effect rows) | 0 | 0 | 0 | 0 | 1 | - | - | - | PENDING | PENDING | - | 1/3/2/0 | 186.8 |
| dbos | deploy-pinned | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.3 | v2 | SUCCESS | SUCCESS | - | 2/9/7/1 | 64.6 |
| dbos | deploy-break-late-pinned | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.3 | - | ERROR | ERROR | - | 2/9/6/0 | 67.5 |
| vercel | happy | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | - | v1 | completed | completed | completed | 1/8/7/1 | 65.8 |
| vercel | b-agent | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 0.7 | v1 | completed | completed | completed | 1/9/7/1 | 69.3 |
| vercel | b-effect | ok | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.3 | v1 | completed | completed | completed | 1/9/7/1 | 69.5 |
| vercel | b-fanout | stuck (no outcome after 180s) | 0 | 0 | 1 | 0 | 1 | 60.2 | 1 | - | running | completed | completed | 1/9/5/0 | 247 |
| vercel | b-finish | stuck (no outcome after 180s) | 0 | 0 | 1 | 0 | 1 | 60 | - | - | running | completed | completed | 1/8/6/0 | 248.2 |
| vercel | m-prepare | ok | 0 | 1 | 1 | 0 | 1 | 60 | 0.8 | v1 | completed | completed | completed | 1/9/7/1 | 69.9 |
| vercel | m-agent | stuck (no outcome after 180s; 0 effect rows) | 0 | 0 | 0 | 0 | 1 | - | - | - | running | running | completed | 1/3/2/0 | 215 |
| vercel | m-effect | ok | 0 | 0 | 1 | 1 | 1 | 60.2 | 1.2 | v1 | completed | completed | completed | 1/9/7/1 | 70.2 |
| vercel | m-child | stuck (no outcome after 180s) | 0 | 0 | 1 | 0 | 1 | 60.1 | 9 | - | running | failed CORRUPTED_EVENT_LOG | failed CORRUPTED_EVENT_LOG | 1/7/4/1 | 247.6 |
| vercel | deploy | ok | 0 | 0 | 1 | 0 | 1 | 60 | 1.1 | v2 | completed | completed | completed | 1/9/7/1 | 66.7 |
| vercel | deploy-break | ok | 0 | 0 | 1 | 0 | 1 | 60.2 | 1.2 | v2-break | completed | completed | completed | 1/10/8/3 | 66 |
| vercel | deploy-break-late | FAIL (no outcome (failed)) | 0 | 0 | 1 | 0 | 1 | 60.1 | 1.8 | - | failed CORRUPTED_EVENT_LOG | failed CORRUPTED_EVENT_LOG | failed CORRUPTED_EVENT_LOG | 1/7/6/1 | 70.5 |

Vercel follow-up: 13 graphile-worker job locks back-dated past the 4 h expiry, then one v1 worker ran for 120 s (column "after lock probe").
