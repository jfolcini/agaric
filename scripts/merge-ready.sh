#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# "Can this PR merge now?" One line per check; exits 1 if any fails.
#
#   scripts/merge-ready.sh <pr-number>        (or: just merge-ready <pr-number>)
#
# Reads GitHub through `gh api` only (`gh pr` / `gh run` are unavailable in
# cloud sessions). A call that fails, or a field it cannot read, is a FAIL:
# "could not look" never reads as "nothing wrong".
#
#   required checks   `validate / validate-all`, `e2e-tauri-gate` and `dco` are
#                     all success on the PR's current head sha (a missing or
#                     still-running one fails)
#   review            the newest submitted review is APPROVED on that same head
#                     sha, or every changed file is Markdown, which the
#                     reviewer skips (`claude-code-review.yml` paths-ignore)
#   mergeable         `mergeable_state` is not dirty; `unknown` (GitHub is still
#                     computing it) and `draft` fail too
#   main moved        no file the PR changes has changed on main since the PR's
#                     merge base: a PR whose CI predates a main change to a
#                     shared file merges main first (.github/AGENTS.md § The gate)
#   main is green     the newest completed `ci.yml` push run on main concluded
#                     success. In-progress runs are ignored; a cancelled run
#                     (a pending run replaced by a newer push) says nothing
#                     about main and is skipped, naming it.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="jfolcini/agaric"
REQUIRED_CHECKS=("validate / validate-all" "e2e-tauri-gate" "dco")

PR="${1:-}"
if [[ ! "$PR" =~ ^[0-9]+$ ]] || [ $# -ne 1 ]; then
  echo "usage: scripts/merge-ready.sh <pr-number>" >&2
  exit 2
fi

FAILED=0
pass() { printf 'ok    %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILED=1
}

# Every page of an endpoint, concatenated; callers slurp it with `jq -s`.
# Non-zero when the call fails, so an error never reads as an empty result.
api() { # <path>
  gh api --paginate "$1" 2>/dev/null
}

short() { printf '%.7s' "$1"; }

# ── the PR ──────────────────────────────────────────────────────────
if ! pr_json=$(api "repos/$REPO/pulls/$PR") || [ -z "$pr_json" ]; then
  fail "pull request #$PR: could not be read"
  exit 1
fi
read -r STATE DRAFT MSTATE HEAD BASE_REF < <(
  jq -r '[.state, .draft, .mergeable_state, .head.sha, .base.ref] | map(tostring) | join(" ")' <<<"$pr_json"
) || true
if [ -z "${HEAD:-}" ] || [ "$HEAD" = "null" ] || [ "${BASE_REF:-null}" = "null" ]; then
  fail "pull request #$PR: no head sha or base branch in the response"
  exit 1
fi
if [ "$STATE" = "open" ]; then
  pass "pull request #$PR is open at $(short "$HEAD")"
else
  fail "pull request #$PR is $STATE, not open"
fi

# ── required checks on the current head sha ────────────────────────
if ! raw=$(api "repos/$REPO/commits/$HEAD/check-runs?per_page=100") || ! runs=$(jq -s '[.[].check_runs[]?]' <<<"$raw" 2>/dev/null); then
  for want in "${REQUIRED_CHECKS[@]}"; do
    fail "$want: check runs of $(short "$HEAD") could not be read"
  done
else
  for want in "${REQUIRED_CHECKS[@]}"; do
    # Matched by full name or by the suffix after " / ", never by substring:
    # `stop-after-dco` is not `dco`.
    verdict=$(jq -r --arg w "$want" '
      [.[] | select(.name == $w or (.name | endswith(" / " + $w)))] as $m
      | if ($m | length) == 0 then "missing"
        elif all($m[]; .status == "completed" and .conclusion == "success") then "success"
        else [$m[] | "\(.name) \(if .status == "completed" then .conclusion else .status end)"] | join(", ")
        end' <<<"$runs")
    case "$verdict" in
      success) pass "$want: success on $(short "$HEAD")" ;;
      missing) fail "$want: no check run on $(short "$HEAD")" ;;
      *) fail "$want: $verdict on $(short "$HEAD")" ;;
    esac
  done
fi

# ── the review ─────────────────────────────────────────────────────
if ! raw=$(api "repos/$REPO/pulls/$PR/files?per_page=100") || ! files=$(jq -s '[.[][]?]' <<<"$raw" 2>/dev/null); then
  files=""
  fail "review: the PR's changed files could not be read"
elif [ "$(jq 'length' <<<"$files")" -gt 0 ] && jq -e 'all(.[]; .filename | endswith(".md"))' <<<"$files" >/dev/null; then
  pass "review: not required, the diff is Markdown only (the reviewer skips it)"
elif ! raw=$(api "repos/$REPO/pulls/$PR/reviews?per_page=100") || ! reviews=$(jq -s '[.[][]?]' <<<"$raw" 2>/dev/null); then
  fail "review: the PR's reviews could not be read"
else
  # `submitted_at` is null on a pending review that nobody has submitted.
  newest=$(jq -c '[.[] | select(.submitted_at != null)] | sort_by(.submitted_at) | last // empty' <<<"$reviews")
  if [ -z "$newest" ]; then
    fail "review: none submitted"
  else
    read -r rstate rsha < <(jq -r '[.state, .commit_id] | join(" ")' <<<"$newest")
    if [ "$rstate" != "APPROVED" ]; then
      fail "review: the newest review is $rstate, not APPROVED"
    elif [ "$rsha" != "$HEAD" ]; then
      fail "review: approved $(short "$rsha"), but head is $(short "$HEAD")"
    else
      pass "review: newest is APPROVED on $(short "$HEAD")"
    fi
  fi
fi

# ── mergeable state ────────────────────────────────────────────────
if [ "$DRAFT" = "true" ]; then
  fail "mergeable: the PR is a draft"
else
  case "$MSTATE" in
    dirty) fail "mergeable: mergeable_state is dirty (conflicts with $BASE_REF)" ;;
    unknown | null) fail "mergeable: mergeable_state is $MSTATE (GitHub is still computing it; retry)" ;;
    *) pass "mergeable: mergeable_state is $MSTATE" ;;
  esac
fi

# ── files that moved on main since the PR's merge base ─────────────
if [ -z "$files" ]; then
  fail "main moved: not checked, the PR's changed files could not be read"
elif ! cmp_json=$(gh api "repos/$REPO/compare/$BASE_REF...$HEAD?per_page=1" 2>/dev/null) \
  || ! mb=$(jq -er '.merge_base_commit.sha' <<<"$cmp_json" 2>/dev/null); then
  fail "main moved: the merge base of $BASE_REF and $(short "$HEAD") could not be found"
elif ! raw=$(api "repos/$REPO/compare/$mb...$BASE_REF?per_page=100") || ! main_files=$(jq -s '[.[].files[]?]' <<<"$raw" 2>/dev/null); then
  fail "main moved: the files changed on $BASE_REF since $(short "$mb") could not be read"
else
  # A rename counts under both names.
  overlap=$(jq -nr --argjson pr "$files" --argjson main "$main_files" '
    def names: map(.filename, .previous_filename) | map(select(. != null)) | unique;
    ($pr | names) as $a | ($main | names) as $b | $a - ($a - $b) | .[]')
  if [ -z "$overlap" ]; then
    pass "main moved: no PR file changed on $BASE_REF since the merge base $(short "$mb")"
  else
    fail "main moved: $(wc -l <<<"$overlap" | tr -d ' ') PR file(s) changed on $BASE_REF since the merge base $(short "$mb"); merge $BASE_REF in and let CI re-run:"
    sed 's/^/        /' <<<"$overlap"
  fi
fi

# ── the last completed CI run on main ──────────────────────────────
# One page, newest first: `--paginate` would walk every run the repo has.
if ! raw=$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?branch=$BASE_REF&event=push&status=completed&per_page=10" 2>/dev/null) \
  || ! run=$(jq -c '[.workflow_runs[]? | select(.status == "completed" and .conclusion != "cancelled")] | first // empty' <<<"$raw" 2>/dev/null); then
  fail "$BASE_REF CI: the completed ci.yml runs could not be read"
elif [ -z "$run" ]; then
  fail "$BASE_REF CI: no completed, non-cancelled ci.yml push run found"
else
  read -r rid rconc rsha rurl < <(jq -r '[.id, .conclusion, .head_sha, .html_url] | join(" ")' <<<"$run")
  if [ "$rconc" = "success" ]; then
    pass "$BASE_REF CI: run $rid on $(short "$rsha") succeeded ($rurl)"
  else
    fail "$BASE_REF CI: run $rid on $(short "$rsha") concluded $rconc ($rurl)"
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "not ready to merge"
  exit 1
fi
echo "ready to merge"
