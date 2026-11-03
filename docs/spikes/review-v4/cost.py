#!/usr/bin/env python3
"""API-equivalent cost and wall time of the PoC reviewer subagents of one Claude Code session.

  cost.py <config_dir> <session_id>   -> JSON lines: description, model, effort, wall_s, usd, tokens

Nested verifier agents (spawnDepth 2) are added to the reviewer that spawned them (matched by the parent's tool use
ids). Prices and transcript reading: ../review-v3/data/usage.py.
"""
import glob, json, os, sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "review-v3", "data"))
from usage import read, total  # noqa: E402

cfg, sid = sys.argv[1:3]
base = glob.glob(os.path.join(cfg, "projects", "*", sid, "subagents"))[0]
agents = {}
for meta_path in glob.glob(os.path.join(base, "*.meta.json")):
    meta = json.load(open(meta_path))
    path = meta_path.replace(".meta.json", ".jsonl")
    msgs, _, first, last = read(path)
    tool_ids = set()
    for line in open(path, errors="replace"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        for c in (r.get("message") or {}).get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in ("Agent", "Task"):
                tool_ids.add(c["id"])
    agents[path] = {"meta": meta, "msgs": msgs, "first": first, "last": last, "spawned": tool_ids}

for path, a in agents.items():
    meta = a["meta"]
    if not meta.get("description", "").startswith("rv4") or meta.get("spawnDepth", 1) != 1:
        continue
    kids = [k for k in agents.values() if k["meta"].get("toolUseId") in a["spawned"]]
    agg, usd = total([a["msgs"], *[k["msgs"] for k in kids]])
    last = max([a["last"] or 0, *[k["last"] or 0 for k in kids]])
    print(json.dumps({"run": meta["description"], "model": meta.get("model"), "effort": meta.get("effort"),
                      "verifiers": len(kids), "wall_s": round(last - (a["first"] or last)), "usd": usd,
                      "tokens": {f: {k: v for k, v in x.items() if k != "usd"} for f, x in agg.items()}}))
