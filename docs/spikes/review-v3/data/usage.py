#!/usr/bin/env python3
"""Token usage and API-equivalent cost from Claude Code transcripts.

  usage.py session <config_dir> <session_id>      one session, main thread + subagents
  usage.py window  <config_dir> <iso_t0> <iso_t1>  every transcript of an account, messages inside the window

Prices: USD per token from usage-tracker's litellm snapshot (2026), used only as an API-equivalent weight.
"""
import glob, json, os, sys
from datetime import datetime

PRICES = {  # input, output, cache write (5m), cache read
    "sonnet": (2e-6, 10e-6, 2.5e-6, 0.1e-6),
    "opus": (4e-6, 20e-6, 5e-6, 0.2e-6),
    "haiku": (0.1e-6, 0.5e-6, 0.125e-6, 0.01e-6),
}


def family(model):
    for f in PRICES:
        if f in (model or ""):
            return f
    return None


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def read(path, t0=None, t1=None):
    msgs, entry, first, last = {}, set(), None, None
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("entrypoint"):
                entry.add(r["entrypoint"])
            t = r.get("timestamp")
            if t:
                tt = ts(t)
                if t0 is not None and not (t0 <= tt <= t1):
                    continue
                first = tt if first is None else min(first, tt)
                last = tt if last is None else max(last, tt)
            m = r.get("message") or {}
            u = m.get("usage")
            if r.get("type") == "assistant" and u and m.get("id"):
                msgs[m["id"]] = (m.get("model"), u)  # streamed lines repeat the id; keep the last
    return msgs, entry, first, last


def total(msg_maps):
    agg = {}
    for msgs in msg_maps:
        for model, u in msgs.values():
            f = family(model) or (model or "?")
            a = agg.setdefault(f, {"calls": 0, "input": 0, "cache_write": 0, "cache_read": 0, "output": 0})
            a["calls"] += 1
            a["input"] += u.get("input_tokens", 0) or 0
            a["cache_write"] += u.get("cache_creation_input_tokens", 0) or 0
            a["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
            a["output"] += u.get("output_tokens", 0) or 0
    usd = 0.0
    for f, a in agg.items():
        p = PRICES.get(f)
        if p:
            a["usd"] = round(a["input"] * p[0] + a["output"] * p[1] + a["cache_write"] * p[2] + a["cache_read"] * p[3], 4)
            usd += a["usd"]
    return agg, round(usd, 4)


def session(cfg, sid):
    mains = glob.glob(os.path.join(cfg, "projects", "*", sid + ".jsonl"))
    subs = glob.glob(os.path.join(cfg, "projects", "*", sid, "subagents", "*.jsonl"))
    main_msgs, entry, first, last = {}, set(), None, None
    for p in mains:
        m, e, f, l = read(p)
        main_msgs.update(m); entry |= e
        first, last = f, l
    sub_maps = []
    for p in subs:
        m, e, f, l = read(p)
        sub_maps.append(m); entry |= e
        if l and (last is None or l > last):
            last = l
    main_agg, main_usd = total([main_msgs])
    all_agg, all_usd = total([main_msgs] + sub_maps)
    peak_main_ctx = max((u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                         for _, u in main_msgs.values()), default=0)
    return {"session": sid, "transcripts": len(mains), "subagents": len(subs), "entrypoints": sorted(entry),
            "wall_s": round(last - first) if first and last else None,
            "main": main_agg, "main_usd": main_usd, "peak_main_context": peak_main_ctx,
            "all": all_agg, "usd": all_usd}


def window(cfg, t0, t1):
    a, b = ts(t0), ts(t1)
    maps, entry, files = [], set(), 0
    for p in glob.glob(os.path.join(cfg, "projects", "**", "*.jsonl"), recursive=True):
        if os.path.getmtime(p) < a:
            continue
        m, e, _, _ = read(p, a, b)
        if m:
            maps.append(m); entry |= e; files += 1
    agg, usd = total(maps)
    return {"config": cfg, "t0": t0, "t1": t1, "files": files, "entrypoints": sorted(entry), "by_model": agg, "usd": usd}


if __name__ == "__main__":
    kind = sys.argv[1]
    out = session(sys.argv[2], sys.argv[3]) if kind == "session" else window(sys.argv[2], sys.argv[3], sys.argv[4])
    print(json.dumps(out, indent=1))
