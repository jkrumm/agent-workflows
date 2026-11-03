#!/usr/bin/env bash
# Route the last N merged PRs of a repo (rebase-merged: GitHub's merge_commit_sha is the PR's last commit on master, base = head~commits).
#   distribution.sh <repo-dir> <gh-repo> <review-md> [N]   -> one line per PR: pr tier rule
set -euo pipefail
repo=$1 gh_repo=$2 review_md=$3 n=${4:-60}
here=$(cd "$(dirname "$0")" && pwd)
gh pr list -R "$gh_repo" --state merged --limit "$n" --json number,title --jq '.[] | "\(.number)\t\(.title)"' |
while IFS=$'\t' read -r pr title; do
  read -r count head < <(gh api "repos/$gh_repo/pulls/$pr" --jq '"\(.commits) \(.merge_commit_sha)"')
  git -C "$repo" cat-file -e "$head^{commit}" 2>/dev/null || { echo "$pr ? (merge commit not local)"; continue; }
  r=$(python3 "$here/route.py" "$repo" "$head~$count" "$head" "$review_md" 2>/dev/null || echo '{"tier":"?","rule":"route failed"}')
  echo "$pr $(echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["tier"], "|", d["rule"])')"
done
