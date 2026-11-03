#!/usr/bin/env python3
"""Print the PoC reviewers' findings compactly: show.py <label> [job...] (jobs default: every /tmp/rv4 job)."""
import glob, json, os, sys
label, jobs = sys.argv[1], sys.argv[2:] or sorted(d for d in glob.glob("/tmp/rv4/*-*") if not os.path.basename(d).startswith(("wt-", "invalid")))
for job in jobs:
    p = os.path.join(job, f"out-{label}.json")
    if not os.path.exists(p):
        print(f"{os.path.basename(job)}: (missing)"); continue
    try:
        d = json.load(open(p))
    except Exception as e:
        print(f"{os.path.basename(job)}: unreadable {e}"); continue
    print(f"{os.path.basename(job)}: {d.get('summary')}")
    for f in d.get("findings", []):
        print(f"  {f.get('tag','?')[:4]} {f.get('class','?')[:5]} {f.get('file')}:{f.get('line')} {f.get('votes') or ''} | {(f.get('message') or '')[:170]}")
