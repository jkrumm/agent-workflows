#!/usr/bin/env python3
"""Earlier review findings on the paths a change touches (review v4 spike, stand-in for the ledger).

  prior.py <repo-dir> <base> <head> <pr> <head-branch> > prior.json

Reads v1 runs (agw.runs, purpose prod) on the same repo created before <base>'s commit time and keeps the blocking and
improvement findings whose file the change touches, newest first, at most 12. v1 has no dispositions, so every state
is "unknown". Needs PGPASSWORD (secrets-run read op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD).
"""
import json, os, subprocess, sys

repo, base, head, pr, branch = sys.argv[1:6]
name = os.path.basename(os.path.abspath(repo))
git = lambda *a: subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, text=True).stdout
paths = set(git("diff", "--name-only", f"{base}..{head}").split())
since = git("show", "-s", "--format=%cI", base).strip()
sql = f"""
select coalesce(json_agg(t), '[]') from (
  select id, input->>'pr' as pr, created_at, output->'blocking' as b, output->'improvements' as i
  from agw.runs where workflow = 'review' and parent_id is null and purpose = 'prod' and status = 'done'
    and input->>'cwd' like '%/{name}%' and created_at < '{since}'
    and coalesce(input->>'pr', '') <> '{int(pr)}'
    and input::text not like '%{branch.replace("'", "")}%'  -- the PR's own runs without a pr number
  order by created_at desc limit 200) t
"""
rows = json.loads(subprocess.run(["psql", "-h", "127.0.0.1", "-U", "agent_workflows", "-d", "agent_workflows", "-Atc", sql],
                                 check=True, capture_output=True, text=True).stdout)
out = []
for r in rows:
    for tag, items in (("blocking", r["b"] or []), ("improvement", r["i"] or [])):
        for f in items:
            if f.get("file") in paths:
                out.append({"id": f"{r['id'][:13]}:{len(out)}", "runId": r["id"], "pr": r["pr"], "at": r["created_at"],
                            "tag": tag, "file": f["file"], "line": f.get("line"), "message": f.get("message"),
                            "state": "unknown"})
print(json.dumps(out[:12], indent=1))
