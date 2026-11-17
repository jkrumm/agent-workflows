# @agent-workflows/hyperdx

The HyperDX dashboard **`agw`** and its seven alerts, kept as code. Prod ClickStack holds them in Mongo, which has no
backup: `definitions/` is the backup and the only way to rebuild them.

```sh
make hyperdx-apply ARGS=--dry-run   # validate the dashboard, print the plan, write nothing
make hyperdx-apply                  # upsert dashboard and alerts by name (prod)
make hyperdx-export                 # write the live dashboard and its agw-tagged alerts back (capture a UI edit)
agw hdx link <dashboardId> --last 24h   # open it; `agw hdx rest /dashboards` has the id
```

Everything goes through the `agw hdx` door, which holds the credentials; this package holds none. The files use the
format of `vps/observability/{dashboards,alerts}` (a tile's `source` and `connection`, an alert's `dashboard`, `tile` and
`webhook` are names, resolved to the env's ids on apply), so `agw` is not a second convention. Tile ids are derived from
the tile name (an apply never changes the id an alert points at). The alerts notify the webhook the other prod alerts
use (`Factory door`).

vps's `hyperdx-export` also pulls every dashboard and every non-weatherorb alert of an env into `vps/observability/`.
The `agw` objects there are a copy; this directory is the one that gets applied.

## Alerts

`above` fires on value >= threshold, `above_exclusive` on >. Windows are the alert's interval, aligned to its clock.

| Alert | Tile | Interval | Fires when |
|-|-|-|-|
| gateway silent | Gateway spans / 1 h | 1h | fewer than 1 `agw-gateway` span |
| failed runs | Failed root runs per workflow | 1h | a workflow (not `cap.web.*`) has >= 3 failed root runs, a `NOT_FOUND` answer not counted |
| failed web runs | Failed root runs per web capability | 1h | a `cap.web.*` capability has >= 20 failed root runs |
| gateway errors | Gateway error spans | 15m | >= 5 error spans, caller `modelpick` excluded |
| error logs | Error logs / 15 min | 15m | >= 3 error-level logs of `agw`, `agw-gateway`, `agw-audio` |
| cost | Cost, rolling 24 h | 1h | root-run `agw.cost.usd` of the last 24 h above 30 USD |
| dead workflow | Workflows with every run failed in 6 h | 1h | a workflow with >= 3 root runs in 6 h failed every one |

A failed root run is `agw.run` span with `agw.run.id = agw.run.root_id`, `StatusCode = 'Error'`, purpose not `verify`
or `eval` (the deploy's probes fail on purpose: 136 of the 14 days' failures are `door.speech` probes). A run that ends in a capability's `NOT_FOUND` (`"code":"NOT_FOUND"` in `agw.error.message`) is not a failed run of the per-workflow tile either: asking for a part number or package nobody lists is the lookup's answer, not a breakage (2026-11-17: 23 `cap.shop.offers` runs in four minutes, every one "idealo has no product with part number …"). The reason table still lists them, and the dead-workflow alert still fires when every run of a workflow fails, whatever the reason, so a parser that stopped finding anything is not hidden. The cost and
dead-workflow tiles are raw SQL with a fixed window anchored at `{endDateMilliseconds}`, so they hold the same number
on the dashboard and in the alert. To silence one: `agw hdx write clickstack_save_alert` with its id and a changed
threshold, or delete the file and the live alert; `agw hdx query clickstack_get_alert '{}'` finds the id.

The two cost tiles leave out `agw.run eval.run`: its journal `cost` is the sum of its case runs and judge calls, and each
case run is also a root of its own (`parent_id` set, `root_id` = its own id), so counting both bills every eval case twice
(2026-11-16: 11.09 of 49.81 USD). The case runs carry the spend; the judge calls, which are children of the eval run and
no root, drop out of the tile (about 0.1 USD per 10 cases).

## Backtest

Measured 2026-11-16 on prod spans, 2026-11-02 to 2026-11-16, each window evaluated on the alert's own clock.

| Alert | Would have fired | Not otherwise |
|-|-|-|
| gateway silent | never since the gateway first exported (the hourly minimum is 11 spans, p5 is 12); the empty windows are 2026-11-02 00:00 to 08:00, before it existed | the 2026-11-15 07:00 gap is 15 minutes: it does not fire, by design (a 30 minute window false-fires on two quiet buckets of 4.4 days) |
| failed runs | 2026-11-13 09:00, `factory.digest`, 3 of 14 runs failed (a real cluster); 2026-11-17 19:00, `cap.shop.offers`, 22 NOT_FOUND runs, which the `NOT_FOUND` exclusion (measured 2026-11-17) removes: those 23 are the only NOT_FOUND root failures of the 15 days | the busiest other hour is 2 (`cap.hdx.rest`, 2026-11-16 07:00) |
| failed web runs | 2026-11-14 16:00 (`cap.web.read` 61, `cap.web.fetch` 22) and 17:00 (59, 24) | 15:00 on 11-14 is 10 and 8; the highest hour on any other day is 10 (`cap.web.fetch`, 11-07 00:00): 2x margin |
| gateway errors | six 15 min windows: 11-02 09:00 (6), 09:15 (5), 09:45 (6), 14:15 (15); 11-03 09:45 (5); 11-13 09:45 (10, caller `agw`, `/anthropic/v1/messages`, the hour `factory.digest` failed) | no window on any other day; 23 non-probe errors in 7 days, none clustered |
| error logs | never: the stderr files of the 14 days hold 0 error-level lines (133 warn, 272 info) | shipping is live since the 2026-11-16 deploy: no history in ClickStack yet |
| cost | 11-02 evening to 11-03 21:00 (a 160 USD day, 130 USD of it non-eval) | every window after is at most 20 |
| dead workflow | 2026-11-06 14:00 and 2026-11-09 00:00 to 03:00, both `cap.web.read`, 3 of 3 runs failed in 6 h | no other workflow, no other window (at 5 runs it never fires) |

Two acceptance claims the data does not support:

- **2026-11-15 07:00 gateway errors.** The blip cannot be replayed from ClickStack. The span export itself failed
  (`telemetry: span export failed`, then `getaddrinfo ENOTFOUND` in the gateway's stderr from 07:00), so `agw-gateway` has
  no span in the 07:00 to 07:15 bucket at all, errors included. Alert 3 counts spans; spans that never arrive are not counted. The silent alert
  (60 min) is the one that sees an export that stays dead.
- **2026-11-14 error logs.** No error-level log line was written that day: the 144 `cap.web.read` failures were returned
  as run failures, not logged. The failed-web-runs alert fires on it; the error-log alert does not.

## Not on the dashboard

- **Pool credit left.** No pool balance reaches ClickStack: the gateway keeps it in its ledger and `/health`. The tile
  "Gateway spend per pool per day" stands in; a credit tile needs the gateway to export a gauge.
- **Fetch-chain blocked share by reason.** The `blocked (<reason>)` is only in `agw.error.message`; the leg
  (`agw.web.leg`, `agw.web.cached`) exists since the 2026-11-16 deploy and only on runs that succeeded. The two tiles
  show what exists (failure reasons by workflow, runs by leg); a share needs the leg and reason as attributes of the
  failing run.
- Tile "Error logs by service" is empty until the first error log: empty is healthy.
