#!/usr/bin/env bash
# Commit files to a pull request's branch through the GitHub API, for the
# workflow_run jobs that hold a write token (gradle-verification-commit.yml,
# advisory-waiver-prune.yml). They never check the PR branch out, so nothing
# from it sits in the tree they run scripts from (OpenSSF Scorecard
# Dangerous-Workflow).
#
#   commit-via-api.sh <branch> <head-sha> <message> <dir> <path>...
#
# Each <path>, read from <dir>/<path>, whose content differs from the branch's
# copy at <head-sha> goes into one commit on top of <head-sha>, as a regular
# file (mode 100644), authored by github-actions[bot] with the matching
# Signed-off-by dco.yml checks. Prints the new commit's sha; prints nothing
# when the branch has moved past <head-sha> or no file differs. The ref update
# is a fast-forward from <head-sha>, so a push that lands in between fails the
# update instead of being overwritten. Needs GH_TOKEN and REPO.
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "usage: $0 <branch> <head-sha> <message> <dir> <path>..." >&2
  exit 2
fi
branch=$1 head=$2 message=$3 dir=$4
shift 4
api() {
  local path=$1
  shift
  gh api "repos/$REPO/$path" "$@"
}

if [ "$(api "git/ref/heads/$branch" --jq .object.sha)" != "$head" ]; then
  echo "$branch moved past $head since CI ran; the next CI run starts again from the new head." >&2
  exit 0
fi

entries='[]'
for path in "$@"; do
  parent=$(dirname "$path")
  [ "$parent" = . ] && parent=
  theirs=$(api "contents${parent:+/$parent}?ref=$head" | jq -r --arg p "$path" '.[] | select(.path == $p) | .sha')
  [ "$(git hash-object --no-filters "$dir/$path")" = "$theirs" ] && continue
  blob=$(base64 -w0 "$dir/$path" | jq -Rs '{content: ., encoding: "base64"}' | api git/blobs --input - --jq .sha)
  entries=$(jq -c --arg p "$path" --arg s "$blob" '. + [{path: $p, mode: "100644", type: "blob", sha: $s}]' <<<"$entries")
done
if [ "$entries" = '[]' ]; then
  echo "No file differs from $branch at $head; nothing to commit." >&2
  exit 0
fi

bot='github-actions[bot]'
email='41898282+github-actions[bot]@users.noreply.github.com'
base_tree=$(api "git/commits/$head" --jq .tree.sha)
tree=$(jq -n --arg b "$base_tree" --argjson e "$entries" '{base_tree: $b, tree: $e}' \
  | api git/trees --input - --jq .sha)
commit=$(jq -n --arg m "$message" --arg t "$tree" --arg p "$head" --arg n "$bot" --arg e "$email" \
  '{message: "\($m)\n\nSigned-off-by: \($n) <\($e)>", tree: $t, parents: [$p], author: {name: $n, email: $e}}' \
  | api git/commits --input - --jq .sha)
api "git/refs/heads/$branch" -X PATCH -f sha="$commit" -F force=false >/dev/null
echo "$commit"
