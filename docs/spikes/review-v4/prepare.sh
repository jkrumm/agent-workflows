#!/usr/bin/env bash
# Prepare one review-v4 PoC job: a detached worktree at the change's head and a job dir of pointers.
#   prepare.sh <repo-dir> <gh-repo> <pr> <base> <head> [prior.json]
# Prints the job dir. Nothing is written in <repo-dir>'s checkout; the worktree lives under $RV4_ROOT (default /tmp/rv4).
set -euo pipefail
repo=$1 gh_repo=$2 pr=$3 base=$4 head=$5 prior=${6:-}
here=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$repo")
root=${RV4_ROOT:-/tmp/rv4}
job="$root/$name-$pr" wt="$root/wt-$name-$pr"
mkdir -p "$job"
[ -d "$wt" ] || git -C "$repo" worktree add --quiet --detach "$wt" "$head"

git -C "$repo" diff -M "$base..$head" > "$job/diff.patch"
git -C "$repo" diff -M --numstat "$base..$head" > "$job/stat.txt"
paths=(); while IFS= read -r p; do paths+=("$p"); done < <(git -C "$repo" diff -M --name-only "$base..$head")
git -C "$repo" log -n 15 --format='--- %h %ad%n%s%n%n%b' --date=short "$base" -- "${paths[@]}" > "$job/history.txt"
gh pr view "$pr" -R "$gh_repo" --json title,body --jq '"# " + .title + "\n\n" + .body' > "$job/intent.md"
if [ -n "$prior" ]; then cp "$prior" "$job/prior.json"; else echo '[]' > "$job/prior.json"; fi
cp "$here/REVIEW.$name.md" "$job/REVIEW.md"

cat > "$job/job.json" <<EOF
{ "repo": "$gh_repo", "pr": $pr, "base": "$base", "head": "$head", "worktree": "$wt",
  "files": { "diff": "$job/diff.patch", "stat": "$job/stat.txt", "intent": "$job/intent.md",
             "history": "$job/history.txt", "prior": "$job/prior.json", "reviewMd": "$job/REVIEW.md",
             "agentsMd": "$wt/AGENTS.md" } }
EOF
echo "$job"
