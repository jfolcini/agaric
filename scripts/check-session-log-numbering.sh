#!/usr/bin/env bash
# Session-log numbering guard (#2556, #3690).
#
# History: once the log crossed session-999, `ls docs/session-log | tail`
# started sorting lexicographically (session-1000 < session-996), and every
# agent that derived "next number" that way collided on session-1000 —
# fifteen times. The rule is NUMERIC max + 1; this hook enforced it for
# newly added files so the mistake was caught at commit time, not review.
#
# WHY max+1 WAS NOT ENOUGH (#3690)
# --------------------------------
# max+1 is not collision-safe when work happens in parallel. Two branches
# forked from the same `main` (highest number 1280) each applied the rule
# honestly and each arrived at 1281; both passed this guard, because both
# were validated against the files visible IN THAT BRANCH, where 1281
# really was free. The collision exists only in the merge result — the one
# state nothing was checking. It landed: `docs/session-log/` carries two
# session-1281 files to this day.
#
# So the number is now checked against the MERGE TARGET (`origin/main`, the
# tree this commit is going to join) as well as against the branch itself.
# A sibling branch that took your number and merged first is then visible
# the moment you fetch, and the guard says so — "your base is stale,
# rebase" — instead of explaining the max+1 rule at someone who already
# applied it correctly.
#
# The number also lives in TWO places per entry: the filename and the
# `# Session NNNN` heading inside the file. Renumbering by hand updated one
# and forgot the other. The guard checks they agree.
#
# WHY EXACT max+1 WAS TOO STRICT (#3929)
# ---------------------------------------
# Requiring NNN to be exactly max+1 makes the identifier a dense sequence,
# and a dense sequence cannot be allocated in parallel: with N PRs in
# flight, only ONE can hold a valid number at a time — every other one is
# holding a number that becomes a duplicate the instant any sibling merges.
# Measured cost: a batch of five parallel PRs needed four renumber cycles
# (each a commit + the full ~10-minute pre-push gate + a CI re-run) that
# changed no shipped code at all.
#
# But exact contiguity was never what caught a collision — check 1 (below)
# does that, independently, by testing the number against the ACTUAL union
# of taken numbers, not against an "is it dense" rule. Contiguity was only
# ever cosmetic: the header history above explains why the max must be
# computed NUMERICALLY, and why it must include the merge target — neither
# reason needed "no gaps" to hold. So check 2 now accepts a BOUNDED WINDOW
# above the max (max+1 .. max+GAP_BOUND) instead of demanding max+1 on the
# nose: several PRs forked from the same base can each claim a distinct
# number in the window without colliding OR needing to renumber when a
# sibling merges first, while a number wildly off the max (a stale
# understanding of it, a typo) still fails outside the window. GAP_BOUND is
# sized well above the project's own parallel-PR pipeline cap (5) so it
# will not itself start forcing renumbers under normal parallelism.
#
# Checks, for each staged ADDED docs/session-log/session-NNN-*.md:
#   1. NNN is not already taken — on this branch, in the merge target, or by
#      another file in this same commit. THIS is what makes a collision
#      unrepresentable in the merge result; it does not depend on check 2.
#   2. NNN falls in (max, max+GAP_BOUND] over the UNION of branch and merge
#      target, updated as each staged file in this commit is accepted —
#      catches a number that is not just non-collision-safe but plainly
#      wrong, without forcing every parallel PR onto the single dense next
#      value.
#   3. The `# Session NNNN` heading inside the file matches the filename.
#
# Pre-existing duplicates (the fifteen session-1000 files, the two
# session-1281 files) are history: only a STAGED addition can fail.
#
# `--self-test` drives the guard through throwaway git repositories — no
# network, no mutation of this repo — including the exact #3690 shape:
# branch base at 1280, `origin/main` already carrying 1281.
set -euo pipefail

LOG_DIR="docs/session-log"

# How far above the union max a new number may land without being treated
# as "wrong" (#3929). Sized generously above the project's 5-PR pipeline
# cap so ordinary parallel batches never hit the ceiling; a number past it
# is still almost certainly a stale/miscalculated max, not legitimate
# parallel work, so it stays a hard failure.
GAP_BOUND=10

num_of() { basename "$1" | sed -E 's/^session-([0-9]+)-.*$/\1/'; }

# Session numbers recorded in a ref's tree. Empty (not an error) when the
# ref does not exist or holds no session logs.
nums_in_ref() {
  git ls-tree -r --name-only "$1" -- "$LOG_DIR" 2>/dev/null \
    | grep -oE 'session-[0-9]+' | grep -oE '[0-9]+' || true
}

# The tree this commit is going to join. `origin/main` is the real merge
# target; a bare local `main` is the fallback for a clone that has not
# fetched. Empty when neither exists — the guard then degrades to the
# branch-local check rather than failing.
merge_target_ref() {
  local ref
  for ref in refs/remotes/origin/main refs/heads/main; do
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
      echo "$ref"
      return 0
    fi
  done
  echo ""
}

# The `# Session NNNN` heading inside a staged file. Read from the INDEX,
# not the worktree — the index is what is being committed.
heading_num_of() {
  git show ":$1" 2>/dev/null \
    | grep -m1 -oE '^#[[:space:]]+Session[[:space:]]+[0-9]+' \
    | grep -oE '[0-9]+' || true
}

run_guard() {
  local added existing_max expected max_allowed fail=0
  local target_ref target_nums head_nums taken n f heading

  added="$(git diff --cached --name-only --diff-filter=A -- "$LOG_DIR/session-*.md" || true)"
  [ -z "$added" ] && return 0

  target_ref="$(merge_target_ref)"
  head_nums="$(nums_in_ref HEAD)"
  target_nums=""
  [ -n "$target_ref" ] && target_nums="$(nums_in_ref "$target_ref")"

  # Numbers already spoken for, anywhere that matters.
  taken="$(printf '%s\n%s\n' "$head_nums" "$target_nums" | grep -E '^[0-9]+$' | sort -n -u || true)"
  existing_max="$(printf '%s\n' "$taken" | tail -1)"
  existing_max="${existing_max:-0}"
  expected=$((existing_max + 1))

  # Sort the staged additions numerically so a multi-file commit is checked
  # in the order the numbers must run.
  for f in $(printf '%s\n' "$added" | while read -r p; do
    [ -n "$p" ] && echo "$(num_of "$p") $p"
  done | sort -n | cut -d' ' -f2); do
    n="$(num_of "$f")"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      echo "ERROR: $f — cannot parse session number." >&2
      fail=1
      continue
    fi

    # 1. Collision — against the branch, the merge target, or a sibling
    #    file in this same commit.
    if printf '%s\n' "$taken" | grep -qx "$n"; then
      echo "ERROR: $f — session number $n is already taken." >&2
      if [ -n "$target_ref" ] \
        && printf '%s\n' "$target_nums" | grep -qx "$n" \
        && ! printf '%s\n' "$head_nums" | grep -qx "$n"; then
        echo "  It exists on ${target_ref#refs/remotes/} but NOT on this branch: YOUR BASE IS STALE." >&2
        echo "  A sibling branch forked from the same main, computed the same max+1," >&2
        echo "  and merged first. Nothing you did was wrong; the number moved under you." >&2
        echo "  Fix: git fetch origin && git rebase origin/main, then renumber to $expected:" >&2
        echo "    git mv $f $(dirname "$f")/session-$expected-$(basename "$f" | sed -E 's/^session-[0-9]+-//')" >&2
        echo "  ...and update the '# Session $n' heading INSIDE the file — the number" >&2
        echo "  is stored twice, and this guard checks both." >&2
      else
        echo "  (Already used by another entry — every session number must be unique.)" >&2
      fi
      fail=1
      taken="$(printf '%s\n%s\n' "$taken" "$n" | grep -E '^[0-9]+$' | sort -n -u)"
      expected=$((n + 1))
      continue
    fi

    # 2. Bounded window above the running max (#3929) — NOT exact max+1.
    #    Several parallel PRs, each forked from the same base, can each
    #    claim a distinct number in (max, max+GAP_BOUND] without a
    #    renumber when a sibling merges first. A number outside the
    #    window is still almost certainly wrong (a stale understanding of
    #    the max, or a typo), so it is still a hard failure — the window
    #    trades away "no gaps ever" (cosmetic; check 1 above is what
    #    actually prevents a collision), not the uniqueness guarantee.
    max_allowed=$((expected + GAP_BOUND - 1))
    if [ "$n" -lt "$expected" ] || [ "$n" -gt "$max_allowed" ]; then
      echo "ERROR: $f is numbered $n but must be between $expected and $max_allowed" >&2
      echo "  (numeric max across this branch and ${target_ref:-HEAD} is $existing_max; a window" >&2
      echo "  of $GAP_BOUND lets several parallel PRs each hold a distinct valid number without" >&2
      echo "  a renumber when one of them merges first — see #3929)." >&2
      echo "  If $n is still outside that window, your base is probably stale — fetch and" >&2
      echo "  rebase onto origin/main first, which is where the number you want may already" >&2
      echo "  have been taken by a branch that merged while you were working." >&2
      echo "  Compute the max with:" >&2
      echo "    git ls-tree -r --name-only origin/main -- $LOG_DIR | grep -oP 'session-\\K[0-9]+' | sort -n | tail -1" >&2
      echo "  NEVER with plain 'ls | tail': it sorts lexicographically." >&2
      fail=1
    fi

    # 3. The second copy of the same fact.
    heading="$(heading_num_of "$f")"
    if [ -z "$heading" ]; then
      echo "ERROR: $f — no '# Session NNNN' heading found." >&2
      echo "  Every entry opens with '# Session $n — <title>'." >&2
      fail=1
    elif [ "$heading" != "$n" ]; then
      echo "ERROR: $f — filename says session $n, heading inside says $heading." >&2
      echo "  The number is stored twice; a renumber has to update both." >&2
      fail=1
    fi

    taken="$(printf '%s\n%s\n' "$taken" "$n" | grep -E '^[0-9]+$' | sort -n -u)"
    expected=$((n + 1))
  done

  return "$fail"
}

# ── self-test ──────────────────────────────────────────────────────────
# Wired as the `session-log-numbering-self-test` prek hook. Each case
# builds a throwaway repository and runs THIS script inside it, so what is
# tested is the guard as invoked, not a model of it.
if [ "${1:-}" = "--self-test" ]; then
  st_fail=0
  st_ok() { printf '  ok   - %s\n' "$1"; }
  st_bad() { printf '  FAIL - %s: %s\n' "$1" "$2" >&2; st_fail=1; }

  GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  ST_ROOT="$(mktemp -d -t session-log-guard-selftest.XXXXXX)"
  trap 'rm -rf "$ST_ROOT"' EXIT

  # Scrub git's ambient environment before touching a single fixture.
  # When this self-test runs as a pre-commit hook, git has exported
  # GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the REAL
  # repository, and those OUTRANK `git -C <fixture>`: an unscrubbed
  # environment makes `git -C "$d" commit -m base` commit the developer's
  # own staged changes to their own repo, under the fixture's message.
  # (Observed live, once, while writing these fixtures.)
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
    GIT_COMMON_DIR GIT_NAMESPACE GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_PREFIX GIT_CONFIG_PARAMETERS GIT_AUTHOR_DATE GIT_COMMITTER_DATE

  st_new_repo() {
    local dir="$ST_ROOT/$1"
    mkdir -p "$dir/docs/session-log"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email "selftest@example.invalid"
    git -C "$dir" config user.name "self test"
    git -C "$dir" config commit.gpgsign false
    echo "$dir"
  }

  # write <dir> <number> <slug> [heading-number]
  st_write() {
    local dir="$1" num="$2" slug="$3" heading="${4:-$2}"
    printf '# Session %s — %s\n\n**Date:** 2026-01-01\n' "$heading" "$slug" \
      >"$dir/docs/session-log/session-$num-$slug.md"
  }

  st_commit() {
    git -C "$1" add -A
    git -C "$1" commit -qm "$2" --no-verify
  }

  st_run() { (cd "$1" && bash "$GUARD" >"$ST_ROOT/out.txt" 2>&1); }

  # ── Case 0: the fixtures are isolated from the real repository ───────
  # Asserted BEFORE any fixture commits, and fatal: if a git environment
  # variable still points at the surrounding repo, every commit below
  # would land there instead. Cheap, and it is the failure that has
  # actually happened.
  st_leaks="$(env | grep -E '^(GIT_DIR|GIT_INDEX_FILE|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|GIT_NAMESPACE)=' || true)"
  if [ -n "$st_leaks" ]; then
    st_bad "no ambient git environment can redirect the fixtures" \
      "still set: $(printf '%s' "$st_leaks" | cut -d= -f1 | tr '\n' ' ')"
    echo "check-session-log-numbering self-test FAILED (aborted before touching anything)" >&2
    exit 2
  fi
  d="$(st_new_repo isolation)"
  st_top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || echo '?')"
  if [ "$st_top" = "$(cd "$d" && pwd -P)" ]; then
    st_ok "fixture repositories are isolated from the surrounding repo"
  else
    st_bad "fixture repositories are isolated from the surrounding repo" \
      "git inside the fixture resolves to '$st_top' — refusing to run the rest"
    echo "check-session-log-numbering self-test FAILED (aborted before mutating anything)" >&2
    exit 2
  fi

  # ── Case 1: the #3690 collision, exactly ─────────────────────────────
  # Branch forked when main's max was 1280. While it worked, a sibling
  # branch took 1281 and merged. Both computed max+1 honestly; the branch
  # is the one that has to move. Before this change the guard passed here.
  d="$(st_new_repo collision)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha" # back to the branch's stale base
  st_write "$d" 1281 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "parallel collision with origin/main is caught" "guard passed"
  elif grep -q 'BASE IS STALE' "$ST_ROOT/out.txt" && grep -q 'rebase' "$ST_ROOT/out.txt"; then
    st_ok "parallel collision with origin/main is caught, and named as a stale base"
  else
    st_bad "parallel collision with origin/main is caught, and named as a stale base" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 2: the same branch, renumbered ──────────────────────────────
  # 1282 clears the sibling's 1281 even though the branch's own tree still
  # tops out at 1280 — the guard must accept the number that will be
  # correct in the merge result.
  d="$(st_new_repo renumbered)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_write "$d" 1282 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "the renumbered entry (above the merge target's max) passes"
  else
    st_bad "the renumbered entry (above the merge target's max) passes" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 3: no merge target available ────────────────────────────────
  # A clone with no origin/main must degrade to the branch-local rule, not
  # start failing every commit.
  d="$(st_new_repo no-target)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  # Rename the branch away rather than deleting it: HEAD must still have
  # commits, or every tracked file reads as a staged addition.
  git -C "$d" branch -m main feature-branch
  st_write "$d" 1281 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "no origin/main: falls back to the branch-local rule and passes"
  else
    st_bad "no origin/main: falls back to the branch-local rule and passes" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 4: the second copy of the number ────────────────────────────
  # A `git mv` that renumbers the filename and forgets the heading — the
  # exact hand-work the #3690 renumber required.
  d="$(st_new_repo heading)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1281 mine 1280
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "filename/heading disagreement is caught" "guard passed"
  elif grep -q 'heading inside says' "$ST_ROOT/out.txt"; then
    st_ok "filename/heading disagreement is caught"
  else
    st_bad "filename/heading disagreement is caught" "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 5: a gap far past the window is still caught ────────────────
  # max is 1280, so the window is (1280, 1290]; 1295 is well outside it —
  # a real mistake (stale max, typo), not legitimate parallel work.
  d="$(st_new_repo gap)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1295 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "a gap past the window is caught" "guard passed"
  else
    st_ok "a gap past the window is caught"
  fi

  # ── Case 5b: the #3929 motivating scenario — a bounded gap is NOT a
  # renumber trigger ───────────────────────────────────────────────────
  # Branch forked when main's max was 1280. A sibling already merged 1281
  # (visible on origin/main). This branch was never rebased and picks
  # 1283 for itself — not exactly max+1 (1282), the number another
  # parallel PR might independently be holding — but inside the (1280,
  # 1290] window and not actually taken anywhere. Before #3929 this failed
  # ("must be exactly 1282") and forced a renumber-and-repush cycle purely
  # to hold the dense next value; the fix's whole point is that this must
  # now pass without touching the file. Reverting the window (back to
  # requiring n == expected) turns this red again.
  d="$(st_new_repo bounded-gap)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_write "$d" 1283 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "a bounded gap above the max (not exactly max+1) passes without a renumber (#3929)"
  else
    st_bad "a bounded gap above the max (not exactly max+1) passes without a renumber (#3929)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 5c: the top edge of the window passes ────────────────────────
  # max is 1280, GAP_BOUND is 10, so max+GAP_BOUND (1290) is the LAST
  # number the window allows. Off-by-one in either direction on the bound
  # check would show up here or in Case 5d.
  d="$(st_new_repo window-top)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1290 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "the number exactly at max+GAP_BOUND (the window's top edge) passes"
  else
    st_bad "the number exactly at max+GAP_BOUND (the window's top edge) passes" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 5d: one past the top edge of the window fails ────────────────
  # The complement of 5c: proves the window has an actual ceiling, not
  # just a floor — max+GAP_BOUND+1 (1291) must still fail.
  d="$(st_new_repo window-over)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1291 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "one past max+GAP_BOUND is caught (the window has a ceiling)" "guard passed"
  else
    st_ok "one past max+GAP_BOUND is caught (the window has a ceiling)"
  fi

  # ── Case 6: two entries in one commit, contiguous ────────────────────
  d="$(st_new_repo run)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1281 first
  st_write "$d" 1282 second
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "a contiguous run of two new entries passes"
  else
    st_bad "a contiguous run of two new entries passes" "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 7: two entries in one commit reusing one number ─────────────
  d="$(st_new_repo dupe-staged)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  st_write "$d" 1281 first
  st_write "$d" 1281 second
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "two staged entries sharing a number is caught" "guard passed"
  else
    st_ok "two staged entries sharing a number is caught"
  fi

  # ── Case 8: history is history ───────────────────────────────────────
  # docs/session-log/ really does contain two session-1281 files. A
  # pre-existing duplicate must not block an unrelated new entry.
  d="$(st_new_repo legacy-dupes)"
  st_write "$d" 1281 one
  st_write "$d" 1281 two
  st_write "$d" 1282 three
  st_commit "$d" "history, warts and all"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1283 mine
  git -C "$d" add -A
  if st_run "$d"; then
    st_ok "pre-existing duplicates in history do not block a new entry"
  else
    st_bad "pre-existing duplicates in history do not block a new entry" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 9: nothing staged ───────────────────────────────────────────
  d="$(st_new_repo empty)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  if st_run "$d"; then
    st_ok "no staged session-log additions: passes trivially"
  else
    st_bad "no staged session-log additions: passes trivially" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  if [ "$st_fail" != 0 ]; then
    echo "check-session-log-numbering self-test FAILED" >&2
    exit 2
  fi
  echo "check-session-log-numbering self-test passed"
  exit 0
fi

run_guard
