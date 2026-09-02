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
# Checks, for each staged ADDED or RENAMED docs/session-log/session-NNN-*.md
# (resolved to its destination path — see `staged_targets` below):
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
# Checks 1 and 2 are about a number that NEWLY APPEARS, so they are skipped
# for a staged path whose number did not change (a slug-only rename); check
# 3 is not, and still runs on it. See `staged_targets` for why.
#
# Pre-existing duplicates (the fifteen session-1000 files, the two
# session-1281 files) are history: only a STAGED addition or rename can fail.
#
# WHY RENAMES ALSO HAVE TO BE SELECTED (#4527)
# ---------------------------------------------
# A renumber — the exact fix this guard's own "your base is stale" message
# tells you to run — is `git mv session-NNN-x.md session-MMM-x.md`, which
# git stages as a RENAME, not an addition. Selecting only `A` (as this guard
# did before #4527) means the loop body never runs on a renumber, and the
# guard exits 0 having checked nothing — on exactly the collision-prone path
# (two parallel branches renumbering onto the same number) it exists for.
# See `staged_targets` for the selector and why a rename must resolve to its
# DESTINATION path, never its source.
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

# Staged files this guard must check: brand-new logs AND `git mv` renumbers,
# resolved to their DESTINATION path (#4527).
#
# The original selector was `git diff --cached --name-only --diff-filter=A`.
# A renumber — the operation this guard's own "your base is stale" message
# tells you to perform — is done as `git mv session-NNN-x.md
# session-MMM-x.md`, which git stages as a RENAME (`R`), not an addition.
# `--diff-filter=A` matches none of that, so the loop body never ran and the
# guard exited 0 having checked nothing — silently, on precisely the
# collision-prone path (two parallel branches renumbering onto the same
# number) the guard exists for. Whether git records `R` or `D`+`A` for the
# same logical edit depends on rename-detection similarity (edit the body
# enough while renumbering and it flips to `D`+`A`), so the old selector's
# coverage flickered on and off for the identical operation.
#
# `--diff-filter=ACR`:
#   A — a brand-new log (the case the guard already covered).
#   R — a renumber. THE dominant path by which this guard's own advice is
#       acted on. Resolved below to its DESTINATION — the new, contested
#       number — never the source.
#   C — a copy (rare here, but the same "a number newly appears" shape as A,
#       and the same two-path record shape as R).
# `M` (content edited, filename and number both unchanged) is DELIBERATELY
# EXCLUDED. Including it would be a wrong-answer bug, not a missed check:
# the file's number is already present in `HEAD` — as this same file — so
# running it through check 1 below would flag it as colliding WITH ITSELF.
# There is nothing to (re-)validate about a number that did not change.
#
# The SAME self-collision hazard applies to a rename that does not change
# the number — a reworded slug (`session-1440-a-guard-….md` →
# `session-1440-the-guard-….md`) or a move within $LOG_DIR — and #4527
# widened it from a near-miss into the deterministic outcome by adding `R`
# to this selector without accounting for it (caught in review on #4535).
# The number-preserving half of an `R`/`C` record is excluded below from
# CHECKS 1 AND 2 by the same reasoning as `M`, using the source path this
# comment's predecessor discarded: a RENUMBER always changes the number and
# is still emitted, checked, and reported; a number-preserving rename never
# reaches check 1 at all, exactly like `M`.
#
# It is NOT excluded from check 3 (review, #4535 note 3). The first cut of
# this fix dropped the path entirely, which meant a slug reword that also
# mangled the in-file `# Session NNNN` heading passed silently — the guard
# stopped looking at a file it had every reason to keep looking at. Only
# the two NUMBER checks are meaningless for a number that did not change;
# the "the number is stored twice and both copies must agree" check is
# exactly as meaningful as before. `staged_targets` therefore emits a MODE
# per path rather than a bare path.
#
# Git also records the identical number-preserving rename as a `D`+`A`
# pair when the slug edit drops below the rename-similarity threshold —
# the same nondeterminism the header above documents for a genuine
# renumber. `--diff-filter=ACR` never sees the `D` half, so on the `A`
# record alone there is no way to tell "a brand-new file claiming a number
# `HEAD` already has" from "the same file `HEAD` already has, arriving
# under a new name, in the same commit that removes the old one" — the
# distinction that made this a live bug even before #4527 (a rename this
# guard's old `--diff-filter=A` selector already matched on the `A` half).
# `freed_by_deletion` below closes it the same way: a `D` under $LOG_DIR in
# this same commit frees its number, and an `A` claiming that exact number
# in the same commit is that same move, not a new arrival, so it takes the
# same heading-only mode — one `A` per `D`, see `staged_targets`.
#
# `-z --name-status` rather than plain `--name-status`: an ordinary rename
# line prints BOTH paths on one row, and naive whitespace-splitting would
# hand the guard the SOURCE path — the OLD, colliding number — which is
# worse than the silent skip it replaces. `-z` NUL-delimits every field (a
# status token, then one path for A/M, two for R/C), so source and
# destination can never be confused for a single token; the parser below
# reads exactly the field count each status implies and explicitly discards
# the source (except where it is read for its NUMBER, below, and still
# never emitted as a path).

# Session numbers freed by a pure staged DELETION under $LOG_DIR in this
# same commit — the `D` half of a low-similarity `D`+`A` split. `D` is not
# in `--diff-filter=ACR`, so it needs its own pass; see the comment above
# `staged_targets` for why this exists at all.
freed_by_deletion() {
  git diff --cached -z --name-status --diff-filter=D -- "$LOG_DIR/session-*.md" \
    | while IFS= read -r -d '' _status; do
      IFS= read -r -d '' _path
      num_of "$_path"
    done
}

# Emits one record per staged path this guard must act on, as
# `<mode>\t<path>`:
#
#   full    — a number NEWLY APPEARS at this path (a brand-new log, or a
#             renumber's destination). Checks 1, 2 and 3 all apply.
#   heading — the path's number did NOT change (a slug-only rename, or the
#             `D`+`A` spelling of one). Checks 1 and 2 are skipped — the
#             number is already in `HEAD`, as this same entry, so check 1
#             would flag it as colliding with itself. Check 3 still runs.
#
# A TAB cannot appear in either mode token, so `cut -f2-` / `read -r mode
# path` recover a path containing one.
staged_targets() {
  local status path1 path2 freed want rest fline hit
  freed="$(freed_by_deletion)"
  while IFS= read -r -d '' status; do
    case "$status" in
      A)
        IFS= read -r -d '' path1
        # A number this same commit just freed via a staged deletion (the
        # D+A spelling of a number-preserving rename) is not a new arrival
        # — see the header comment.
        #
        # The exemption is CONSUMED, one `D` per `A`, not tested as set
        # membership (review, #4535 note 2). Set membership let a single
        # staged deletion of `session-1280-a.md` exempt EVERY `A` claiming
        # 1280: stage additions of both `session-1280-b.md` and
        # `session-1280-c.md` alongside it and both were waved through, so
        # the selection came back empty, the guard printed "nothing to
        # check" and exited 0 over an in-commit duplicate — the exact case
        # check 1's own "or by another file in this same commit" clause
        # exists to catch. One deletion can only be one file's move.
        #
        # Compared with `=` on the whole string, not `grep -qx` (review,
        # #4535 note 5): `num_of` returns the basename UNCHANGED when the
        # filename does not match its pattern, and such a path
        # (`docs/session-log/session-1.2-x.md`) still matches this guard's
        # pathspec — so the old form handed grep a pattern with live
        # metacharacters, where a `.` could match a freed basename the
        # path is not actually equal to (`session-1a2-x.md`, same length,
        # differing only under the dot) and exempt it wrongly.
        #
        # Stated plainly because it cannot be pinned: this one is NOT
        # independently falsifiable, and no fixture in the suite below
        # makes it so. A wrong exemption needs a NON-NUMERIC `want` — a
        # pure-digit string is its own only regex match — and any path
        # with a non-numeric number is rejected by run_guard's "cannot
        # parse session number" branch (Case 20) before the exemption's
        # outcome can change a verdict. Swapping `=` back for `grep -qx`
        # therefore leaves the whole suite green; verified, not assumed.
        # The fix stays anyway: "another check happens to catch it
        # downstream" is not a property to build an exemption on, and the
        # masking disappears the moment `num_of` or that branch changes.
        want="$(num_of "$path1")"
        hit=0
        rest=""
        while IFS= read -r fline; do
          [ -n "$fline" ] || continue
          if [ "$hit" = 0 ] && [ "$fline" = "$want" ]; then
            hit=1
            continue
          fi
          rest="$rest$fline
"
        done <<<"$freed"
        freed="$rest"
        if [ "$hit" = 1 ]; then
          printf 'heading\t%s\n' "$path1"
          continue
        fi
        printf 'full\t%s\n' "$path1"
        ;;
      R* | C*)
        IFS= read -r -d '' path1 # source — read for its number, never emitted
        IFS= read -r -d '' path2 # destination — the number that matters
        # A rename/copy that does not change the number is excluded from
        # the NUMBER checks for the same reason `M` is, and kept for the
        # heading check — see the header comment.
        if [ "$(num_of "$path1")" = "$(num_of "$path2")" ]; then
          printf 'heading\t%s\n' "$path2"
          continue
        fi
        printf 'full\t%s\n' "$path2"
        ;;
      *)
        # Unreached under --diff-filter=ACR today. If git ever adds a status
        # letter this filter can select, fail loudly rather than silently
        # mis-parse an unknown record's field count as a bare path.
        echo "ERROR: check-session-log-numbering: unexpected diff status '$status' for a staged $LOG_DIR change — refusing to guess its field shape." >&2
        return 1
        ;;
    esac
  done < <(git diff --cached -z --name-status --diff-filter=ACR -- "$LOG_DIR/session-*.md")
}

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
  local records existing_max expected max_allowed fail=0
  local target_ref target_nums head_nums taken n f mode heading
  local total heading_count checked=0

  records="$(staged_targets)" || return 1
  if [ -z "$records" ]; then
    # #4527: a run that checked nothing must SAY so, not just exit 0 —
    # otherwise it is indistinguishable from a run that checked and
    # approved. prek's `files` regex for this hook unions in
    # `scripts/lib/git-scratch-guard.sh` itself (#3997, since this guard
    # sources it), so a commit staging only that shared file fires this
    # hook with ZERO session-log files staged at all — this is not even a
    # rare path. An empty selection is real information (that case, a pure
    # content edit, or a pure deletion — see the `staged_targets` comment
    # for why those are not selected), not a no-op worth staying silent
    # about.
    echo "session-log-numbering: 0 additions/renames staged under $LOG_DIR — nothing to check."
    return 0
  fi

  total="$(printf '%s\n' "$records" | grep -c . || true)"
  heading_count="$(printf '%s\n' "$records" | grep -c $'^heading\t' || true)"
  if [ "$heading_count" -eq 0 ]; then
    echo "session-log-numbering: checking $total staged addition/rename(s)."
  else
    echo "session-log-numbering: checking $total staged addition/rename(s) ($heading_count number-preserving — heading only)."
  fi

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
  # in the order the numbers must run. Paired and split on TAB, not SPACE
  # (review, #4535 note 7): `cut -d' ' -f2` truncates at a path's OWN
  # embedded space, and the unquoted `for f in $(...)` this used to be
  # word-splits the result a second time. Unreachable under today's
  # hyphen-only naming convention, but not for a reason this code
  # enforces. A TAB cannot appear in `num_of`'s output or in a mode token,
  # and `cut -f2-` (not `-f2`) keeps everything after the first TAB
  # together even if one somehow appeared in a path; `read -r mode f`
  # likewise puts the whole remainder of the line in `f`. `while read`
  # over a process substitution, not `for … in $(...)`, so a path is never
  # handed to the shell to word-split at all.
  while IFS=$'\t' read -r mode f; do
    [ -n "$f" ] || continue
    checked=$((checked + 1))
    n="$(num_of "$f")"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      echo "ERROR: $f — cannot parse session number." >&2
      fail=1
      continue
    fi

    # Checks 1 and 2 ask "is this number free, and is it plausible?" —
    # questions only a number that NEWLY APPEARS can be asked. A
    # `heading` record's number is already in HEAD as this same entry
    # (see `staged_targets`), so both would answer about the file itself.
    if [ "$mode" = full ]; then
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
    fi

    # 3. The second copy of the same fact. Runs for BOTH modes (review,
    #    #4535 note 3): a slug reword that also mangles the heading is
    #    still a file whose two copies of the number disagree, and the
    #    number not having changed is exactly why nothing else would
    #    catch it.
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

    if [ "$mode" = full ]; then
      taken="$(printf '%s\n%s\n' "$taken" "$n" | grep -E '^[0-9]+$' | sort -n -u)"
      expected=$((n + 1))
    fi
  done < <(printf '%s\n' "$records" | while IFS=$'\t' read -r mode p; do
    [ -n "$p" ] && printf '%s\t%s\t%s\n' "$(num_of "$p")" "$mode" "$p"
  done | sort -t "$(printf '\t')" -k1,1n | cut -f2- -d "$(printf '\t')")

  # The count line above is an ASSERTION, not decoration (review, #4535
  # note 4). The pairing/sorting process substitution feeding this loop
  # inherits `set -e`, so a mid-stream failure inside it closes the pipe
  # early: the loop simply sees fewer records, every one it did see
  # passes, and the guard returns 0 — after having announced a larger
  # number out loud. Nothing else in this function can tell a truncated
  # run from a complete one, because a truncated run looks exactly like a
  # smaller commit. Comparing what was consumed against what was reported
  # is the only local evidence, and it costs one integer.
  if [ "$checked" -ne "$total" ]; then
    echo "ERROR: check-session-log-numbering: reported $total staged addition/rename(s) but checked $checked." >&2
    echo "  The record pipeline truncated mid-stream — this run is NOT a completed check." >&2
    fail=1
  fi

  return "$fail"
}

# ── self-test ──────────────────────────────────────────────────────────
# Run by hand with --self-test (no prek hook since #4556). Each case
# builds a throwaway repository and runs THIS script inside it, so what is
# tested is the guard as invoked, not a model of it.
if [ "${1:-}" = "--self-test" ]; then
  # Consumed here (not left in $1): sourcing lib/git-scratch-guard.sh below
  # inherits the CALLER's positional parameters when sourced at this
  # top-level scope (unlike a function call, which gets its own), so a
  # leftover $1 == "--self-test" would trigger the LIBRARY's own
  # `--self-test` block as an unwanted side effect of sourcing it, instead
  # of running this script's session-log fixtures at all.
  shift || true
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
  # (Observed live, once, while writing these fixtures.) Shared code
  # (#3722), not a private copy: this script used to carry its own
  # `unset` list (missing GIT_CEILING_DIRECTORIES entirely, among other
  # gaps) — three independent reinventions of this scrub is exactly what
  # let a fourth, unprotected script repeat the incident.
  # shellcheck source=scripts/lib/git-scratch-guard.sh
  . "$(dirname "$GUARD")/lib/git-scratch-guard.sh"
  git_scratch_guard "$ST_ROOT"

  st_new_repo() {
    local dir="$ST_ROOT/$1"
    mkdir -p "$dir/docs/session-log"
    git_scratch_init "$dir"
    # Cases 10/11/15/16 depend on git's rename detection being ON so their
    # `git mv` fixtures actually stage as `R` (each self-checks this, but a
    # self-check only reports the wrong shape — it does not produce the
    # right one). `git_scratch_guard` scrubs `GIT_CONFIG*` from the
    # environment but not `~/.gitconfig`, so a developer with
    # `diff.renames = false` there stages those fixtures as `D`+`A`
    # instead, the fixture-shape check fires `st_bad`, and the self-test
    # exits 2 for an environment reason, not a code one (review, #4535
    # note 2). Pinned here, not in the shared `git_scratch_init` — that
    # helper is also used by `check-migrations-immutable.sh`,
    # `test-related-rust.sh` and `pr-merge-result-check.sh`, each with its
    # own rename-shaped fixtures this script has not reviewed; changing a
    # shared default risks their coverage for a config knob only this
    # file's fixtures are known to depend on.
    git -C "$dir" config diff.renames true
    echo "$dir"
  }

  # write <dir> <number> <slug> [heading-number]
  # Body padded to 8 filler lines (not just the 3-line header) so that
  # `st_renumber`'s heading-only edit (below) stays a HIGH-similarity
  # rename (git measured: R094) rather than tipping into a D+A pair on its
  # own — a real risk on a file this short, and one that would make Cases
  # 10/11 test the wrong thing (a heading edit that happens to cross the
  # rename threshold, not the renumber itself).
  st_write() {
    local dir="$1" num="$2" slug="$3" heading="${4:-$2}" i
    {
      printf '# Session %s — %s\n\n**Date:** 2026-01-01\n' "$heading" "$slug"
      for i in 1 2 3 4 5 6 7 8; do
        printf 'Body content line %d for the %s session log entry.\n' "$i" "$slug"
      done
    } >"$dir/docs/session-log/session-$num-$slug.md"
  }

  st_commit() {
    git -C "$1" add -A
    git -C "$1" commit -qm "$2" --no-verify
  }

  # renumber <dir> <old-num> <slug> <new-num> [rewrite-body?]
  # The actual `git mv` renumber this guard's own stale-base message tells
  # you to perform (#4527) — as opposed to `st_write` above, which drops a
  # brand-new file in place and was all the pre-#4527 fixtures ever staged.
  # Also updates the `# Session NNNN` heading to the new number, because a
  # WELL-FORMED renumber does — Case 4 below already covers the
  # forgot-the-heading half; this helper stays out of that half's way so
  # the collision/window assertions are not muddied by an unrelated
  # heading failure.
  # rewrite-body=1 additionally pads the file with enough new text to push
  # git's rename-detection similarity below its threshold, so the SAME
  # logical renumber stages as `D`+`A` instead of `R` — the nondeterminism
  # edge #4527 calls out. Staged with `add -A` so the rename (or D+A) and
  # the heading fix land in the index together, the way a real renumber
  # commit does.
  st_renumber() {
    local dir="$1" old="$2" slug="$3" new="$4" rewrite="${5:-0}"
    local old_path="docs/session-log/session-$old-$slug.md"
    local new_path="docs/session-log/session-$new-$slug.md"
    git -C "$dir" mv "$old_path" "$new_path"
    # Portable `-i.bak` form (review, #4535 note 3), not GNU-only bare
    # `-i -E` — matches `bump-version.sh:1086` and
    # `patch-android-build.sh:42`, the spelling `bump-version.sh:899`'s own
    # self-test pins. Bare `-i -E` parses on BSD/macOS sed as `-i` taking
    # `-E` AS THE BACKUP SUFFIX, breaking every case that calls this helper
    # on a Mac checkout.
    sed -i.bak -E "s/^# Session [0-9]+/# Session $new/" "$dir/$new_path"
    rm -f "$dir/$new_path.bak"
    if [ "$rewrite" = 1 ]; then
      {
        for i in $(seq 1 12); do
          printf 'filler filler filler filler filler filler filler filler line %d\n' "$i"
        done
      } >>"$dir/$new_path"
    fi
    git -C "$dir" add -A
  }

  # rename_slug <dir> <num> <old-slug> <new-slug> [rewrite-body?]
  # A rename that changes ONLY the slug — a typo fix, or a move within
  # $LOG_DIR — and never touches the number, as opposed to `st_renumber`
  # above. Review, #4535 note 1: the false positive this guards against is
  # exactly the one #4527 introduced by selecting `R` without accounting
  # for a number-preserving rename. No heading edit, because the number
  # never changes. rewrite=1 pushes the same operation below git's
  # rename-similarity threshold, so it stages as `D`+`A` instead of `R` —
  # the pre-#4527 spelling of this same bug (review, #4535 note 1).
  st_rename_slug() {
    local dir="$1" num="$2" old_slug="$3" new_slug="$4" rewrite="${5:-0}"
    local old_path="docs/session-log/session-$num-$old_slug.md"
    local new_path="docs/session-log/session-$num-$new_slug.md"
    git -C "$dir" mv "$old_path" "$new_path"
    if [ "$rewrite" = 1 ]; then
      {
        for i in $(seq 1 12); do
          printf 'filler filler filler filler filler filler filler filler line %d\n' "$i"
        done
      } >>"$dir/$new_path"
    fi
    git -C "$dir" add -A
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
  # The purest instance of the empty-selection path — literally nothing
  # staged — and until #4535 note 7 only Case 14 (a pure `M`) pinned the
  # message. Free coverage on a fixture that already exists.
  if grep -q '0 additions/renames staged' "$ST_ROOT/out.txt"; then
    st_ok "an empty index reports the empty selection explicitly, not silently (#4527)"
  else
    st_bad "an empty index reports the empty selection explicitly, not silently (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 10: #4527 — a `git mv` renumber onto a TAKEN number is caught ──
  # THE defect this issue is about: before the fix, this renumber staged
  # as a pure rename (`R100`), `--diff-filter=A` selected nothing, and the
  # guard exited 0 having checked nothing at all. Also doubles, after
  # #4535 note 1, as the complement of Cases 15/16 below: the number DOES
  # change here (1280 → 1281), so the short-circuit that excludes a
  # number-preserving rename must NOT swallow this one — a short-circuit
  # broad enough to do that would turn this case green for the wrong
  # reason.
  d="$(st_new_repo mv-collision)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_renumber "$d" 1280 base 1281 0
  if ! git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the mv-collision fixture actually stages as a rename" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_bad "a git-mv renumber onto a number already taken is caught (#4527)" "guard passed"
  elif grep -q 'BASE IS STALE' "$ST_ROOT/out.txt" && grep -q 'already taken' "$ST_ROOT/out.txt"; then
    st_ok "a git-mv renumber onto a number already taken is caught (#4527)"
  else
    st_bad "a git-mv renumber onto a number already taken is caught (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 11: #4527 — a `git mv` renumber onto a FREE number passes ─────
  # The complement of Case 10: a fix that rejected every rename (not just
  # colliding ones) would pass Case 10 and fail here.
  d="$(st_new_repo mv-free)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_renumber "$d" 1280 base 1283 0
  if st_run "$d"; then
    st_ok "a git-mv renumber onto a free, in-window number passes (#4527)"
  else
    st_bad "a git-mv renumber onto a free, in-window number passes (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi
  if grep -q 'checking 1 staged addition/rename' "$ST_ROOT/out.txt"; then
    st_ok "a checked renumber reports how many files it checked (#4527)"
  else
    st_bad "a checked renumber reports how many files it checked (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 12: #4527 — the SAME collision, staged as D+A (nondeterminism) ─
  # Whether git records a renumber as `R` or as `D`+`A` depends on
  # rename-detection similarity, not on what the operation MEANS. Rewriting
  # the body past the similarity threshold must not change the verdict.
  d="$(st_new_repo mv-collision-da)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_renumber "$d" 1280 base 1281 1
  if git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the D+A fixture actually stages as D+A, not a rename — fixture invalid" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_bad "the same collision, staged as D+A instead of R, is still caught (#4527)" "guard passed"
  elif grep -q 'already taken' "$ST_ROOT/out.txt"; then
    st_ok "the same collision, staged as D+A instead of R, is still caught (#4527)"
  else
    st_bad "the same collision, staged as D+A instead of R, is still caught (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 13: #4527 — the SAME free renumber, staged as D+A ─────────────
  d="$(st_new_repo mv-free-da)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  base_sha="$(git -C "$d" rev-parse HEAD)"
  st_write "$d" 1281 sibling
  st_commit "$d" "sibling merged to main"
  git -C "$d" update-ref refs/remotes/origin/main "$(git -C "$d" rev-parse HEAD)"
  git -C "$d" reset -q --hard "$base_sha"
  st_renumber "$d" 1280 base 1283 1
  if git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the D+A free-renumber fixture actually stages as D+A, not a rename — fixture invalid" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_ok "the same free renumber, staged as D+A instead of R, still passes (#4527)"
  else
    st_bad "the same free renumber, staged as D+A instead of R, still passes (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 14: #4527 — a content-only edit must not false-alarm ──────────
  # The number is unchanged, so it is already present in HEAD as this same
  # file. Selecting `M` naively (as the issue's own "ACMR" suggestion would,
  # unqualified) would flag it as colliding with itself. Also pins that the
  # empty selection is now REPORTED, not silent (the other half of #4527).
  d="$(st_new_repo modify-only)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  printf '\nAn appended paragraph. The session number never changes.\n' \
    >>"$d/docs/session-log/session-1280-base.md"
  git -C "$d" add -A
  if ! git -C "$d" diff --cached --name-status | grep -qx $'M\tdocs/session-log/session-1280-base.md'; then
    st_bad "the modify-only fixture actually stages as a pure M" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_ok "a content-only edit to an existing log does not false-alarm (#4527)"
  else
    st_bad "a content-only edit to an existing log does not false-alarm (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi
  if grep -q '0 additions/renames staged' "$ST_ROOT/out.txt"; then
    st_ok "a content-only edit reports the empty selection explicitly, not silently (#4527)"
  else
    st_bad "a content-only edit reports the empty selection explicitly, not silently (#4527)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 15: #4535 note 1 — a slug-only rename must not false-alarm ────
  # THE regression #4527 introduced: selecting `R` without excluding a
  # number-preserving rename means the destination's number is already in
  # `HEAD` — as the SOURCE path of this very commit — so check 1 flagged it
  # as "already taken", pointing at a duplicate that does not exist.
  # Reproduced verbatim against the unfixed guard before this fix landed:
  # `ERROR: … session number 1280 is already taken.` /
  # `(Already used by another entry — every session number must be unique.)`
  d="$(st_new_repo slug-rename)"
  st_write "$d" 1280 a-guard-that-never-looked
  st_commit "$d" "base"
  st_rename_slug "$d" 1280 a-guard-that-never-looked the-guard-that-never-looked 0
  if ! git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the slug-rename fixture actually stages as a rename" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_ok "a slug-only rename that preserves the session number passes (#4535 note 1)"
  else
    st_bad "a slug-only rename that preserves the session number passes (#4535 note 1)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 16: #4535 note 1 — the same slug-only rename, staged as D+A ───
  # The reviewer flagged this as broken even BEFORE #4527: the old
  # `--diff-filter=A` selector already matched the `A` half of a
  # low-similarity D+A split, with the same self-collision result. A fix
  # scoped only to the `R`/`C` pairing (Case 15) would leave this spelling
  # of the identical operation red.
  d="$(st_new_repo slug-rename-da)"
  st_write "$d" 1280 a-guard-that-never-looked
  st_commit "$d" "base"
  st_rename_slug "$d" 1280 a-guard-that-never-looked the-guard-that-never-looked 1
  if git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the slug-rename D+A fixture actually stages as D+A, not a rename — fixture invalid" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_ok "the same slug-only rename, staged as D+A instead of R, still passes (#4535 note 1)"
  else
    st_bad "the same slug-only rename, staged as D+A instead of R, still passes (#4535 note 1)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 17: #4535 note 2 — one deletion exempts exactly one addition ──
  # The `D`-frees-a-number exemption used to be a SET membership test, so a
  # single staged deletion of session-1280-a.md exempted EVERY staged `A`
  # claiming 1280. Stage two of them and the guard printed "0
  # additions/renames staged — nothing to check" and exited 0 over an
  # in-commit duplicate — the case check 1's own "or by another file in
  # this same commit" clause exists to catch. Consuming the exemption once
  # per freed number leaves the second `A` to be checked, and caught.
  d="$(st_new_repo freed-consumed-once)"
  st_write "$d" 1280 alpha-original-entry
  st_commit "$d" "base"
  # Written BEFORE the `git rm`: removing the directory's last file makes
  # git prune the now-empty directory out from under the next write.
  st_write "$d" 1280 bravo-replacement-entry
  st_write "$d" 1280 charlie-extra-entry
  git -C "$d" rm -q "docs/session-log/session-1280-alpha-original-entry.md"
  git -C "$d" add -A
  # The fixture is only testing what it claims if git kept all three
  # records apart (D + A + A). If rename detection paired the D with one
  # of the As it becomes R + A, which is a different — also caught —
  # shape, and this case would stop covering the set-membership bug.
  if git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the freed-consumed-once fixture stages as D+A+A, not a rename — fixture invalid" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_bad "one staged deletion exempts only ONE addition claiming that number (#4535 note 2)" \
      "guard passed over an in-commit duplicate: $(tr '\n' '|' <"$ST_ROOT/out.txt")"
  elif grep -q 'already taken' "$ST_ROOT/out.txt"; then
    st_ok "one staged deletion exempts only ONE addition claiming that number (#4535 note 2)"
  else
    st_bad "one staged deletion exempts only ONE addition claiming that number (#4535 note 2)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 18: #4535 note 3 — a number-preserving rename still gets the
  # heading check ───────────────────────────────────────────────────────
  # Excluding a slug-only rename from checks 1 and 2 is correct; excluding
  # it from the FILE was not. A reword that also mangles the in-file
  # `# Session NNNN` heading leaves the number's two copies disagreeing,
  # and because the number did not change, nothing else in this guard
  # would ever look at it again.
  d="$(st_new_repo slug-rename-bad-heading)"
  st_write "$d" 1280 a-guard-that-never-looked
  st_commit "$d" "base"
  st_rename_slug "$d" 1280 a-guard-that-never-looked the-guard-that-never-looked 0
  sed -i.bak -E 's/^# Session [0-9]+/# Session 1279/' \
    "$d/docs/session-log/session-1280-the-guard-that-never-looked.md"
  rm -f "$d/docs/session-log/session-1280-the-guard-that-never-looked.md.bak"
  git -C "$d" add -A
  if ! git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the slug-rename-bad-heading fixture actually stages as a rename" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_bad "a slug-only rename that mangles the heading is still caught (#4535 note 3)" "guard passed"
  elif grep -q 'heading inside says' "$ST_ROOT/out.txt"; then
    st_ok "a slug-only rename that mangles the heading is still caught (#4535 note 3)"
  else
    st_bad "a slug-only rename that mangles the heading is still caught (#4535 note 3)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 19: #4535 note 3, the D+A spelling ───────────────────────────
  # The same operation below git's rename-similarity threshold reaches the
  # heading check by the OTHER exclusion path (`freed_by_deletion`), so it
  # needs its own case: a fix scoped to the R/C pairing alone would leave
  # this one silent.
  d="$(st_new_repo slug-rename-bad-heading-da)"
  st_write "$d" 1280 a-guard-that-never-looked
  st_commit "$d" "base"
  st_rename_slug "$d" 1280 a-guard-that-never-looked the-guard-that-never-looked 1
  sed -i.bak -E 's/^# Session [0-9]+/# Session 1279/' \
    "$d/docs/session-log/session-1280-the-guard-that-never-looked.md"
  rm -f "$d/docs/session-log/session-1280-the-guard-that-never-looked.md.bak"
  git -C "$d" add -A
  if git -C "$d" diff --cached --name-status | grep -q '^R'; then
    st_bad "the slug-rename-bad-heading D+A fixture actually stages as D+A — fixture invalid" \
      "$(git -C "$d" diff --cached --name-status)"
  fi
  if st_run "$d"; then
    st_bad "the same slug-only rename staged as D+A, heading mangled, is still caught (#4535 note 3)" \
      "guard passed"
  elif grep -q 'heading inside says' "$ST_ROOT/out.txt"; then
    st_ok "the same slug-only rename staged as D+A, heading mangled, is still caught (#4535 note 3)"
  else
    st_bad "the same slug-only rename staged as D+A, heading mangled, is still caught (#4535 note 3)" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 20: an unparseable session number is reported, not accepted ──
  # `num_of` returns the basename UNCHANGED when the filename does not fit
  # `session-NNN-`, and such a path still matches this guard's pathspec —
  # `session-1.2-x.md` here. The `cannot parse session number` branch is
  # what stops that being waved through, and it had no fixture at all.
  #
  # This is also the case #4535 note 5 was about, and the note deserves a
  # straight answer rather than a fixture that only looks like it pins it:
  # the exact-match fix in `staged_targets` is NOT independently
  # observable, and no fixture here can make it so. See the note 5 comment
  # in `staged_targets` for why (short version: a wrong regex exemption
  # requires an unparseable basename, and this very branch catches those
  # before the exemption's outcome can matter). What the fix buys is that
  # the exemption stops depending on a downstream check to mask it.
  d="$(st_new_repo unparseable)"
  st_write "$d" 1280 base
  st_commit "$d" "base"
  printf '# Session 1281 — malformed\n\nbody\n' >"$d/docs/session-log/session-1.2-x.md"
  git -C "$d" add -A
  if st_run "$d"; then
    st_bad "a filename with no parseable session number is reported" \
      "guard passed: $(tr '\n' '|' <"$ST_ROOT/out.txt")"
  elif grep -q 'cannot parse session number' "$ST_ROOT/out.txt"; then
    st_ok "a filename with no parseable session number is reported"
  else
    st_bad "a filename with no parseable session number is reported" \
      "$(tr '\n' '|' <"$ST_ROOT/out.txt")"
  fi

  # ── Case 21: #4535 BLOCKING — the report lines reach the terminal
  # THROUGH prek ────────────────────────────────────────────────────────
  # Every assertion above reads `st_run`'s capture, and `st_run` invokes
  # this script DIRECTLY. prek swallows a PASSING hook's stdout (verified
  # against prek 0.3.8), and both report lines are printed on exit-0
  # paths — so those assertions were green over a channel that is closed
  # in the only place this guard actually runs. What holds the channel
  # open is `verbose = true` in the hook block, and nothing tested that it
  # was there; #4527 shipped without it.
  #
  # This case runs the guard through prek in a throwaway repository whose
  # config is THIS repository's own `session-log-numbering` block, lifted
  # out of prek.toml verbatim. So it asserts the config as committed, not
  # a restatement of it: delete `verbose = true` from prek.toml and this
  # case goes red.
  #
  # Only the POSITIVE direction is asserted. "prek hides it without
  # verbose" is a fact about prek, not about this repository; pinning it
  # would turn a future prek that prints everything into a red build for
  # no reason.
  st_prek_toml="$(cd "$(dirname "$GUARD")/.." && pwd)/prek.toml"
  st_hook_block=""
  if [ -f "$st_prek_toml" ]; then
    st_hook_block="$(awk '
      /^\[\[/ {
        if (want) { printf "%s", blk; want = 0; exit }
        blk = ""; want = 0
        inblk = ($0 ~ /^\[\[repos\.hooks\]\]/) ? 1 : 0
      }
      inblk { blk = blk $0 "\n"; if ($0 ~ /^id = "session-log-numbering"$/) want = 1 }
      END { if (want) printf "%s", blk }
    ' "$st_prek_toml")"
  fi
  if ! command -v prek >/dev/null 2>&1; then
    # Loud, not silent: this is the one case that covers the production
    # channel. It cannot run standalone without prek, but prek is present
    # by construction wherever this self-test runs as a hook.
    printf '  SKIP - the guard report reaches the terminal through prek: prek is not on PATH\n'
  elif [ ! -f "$st_prek_toml" ]; then
    printf '  SKIP - the guard report reaches the terminal through prek: no %s\n' "$st_prek_toml"
  elif [ -z "$st_hook_block" ]; then
    st_bad "the guard report reaches the terminal through prek (#4535 BLOCKING)" \
      "no [[repos.hooks]] block with id = \"session-log-numbering\" found in $st_prek_toml"
  else
    d="$(st_new_repo through-prek)"
    mkdir -p "$d/scripts"
    cp "$GUARD" "$d/scripts/check-session-log-numbering.sh"
    {
      printf '[[repos]]\nrepo = "local"\n'
      printf '%s' "$st_hook_block"
    } >"$d/prek.toml"
    st_write "$d" 1280 base
    st_commit "$d" "base"

    st_write "$d" 1281 mine
    git -C "$d" add -A
    # `env -u SKIP -u PRE_COMMIT -u PREK`: the OUTER prek exports SKIP to every
    # hook it runs, and `session-log-numbering` is in that list precisely when
    # a PR touches no Markdown (_validate.yml's `skips+=(... session-log-numbering)`
    # and verify-ci-equivalent.sh's `skip_items`). This self-test hook is in NO
    # skip list and its `files` regex always matches, so it runs on every PR —
    # meaning a nested bare `prek run` would inherit the bypass, print nothing,
    # and redden BOTH assertions below on every non-docs PR. This PR's own CI
    # does not catch that, because it adds a session log and so sets docs=true.
    # Found in review of #4535; it is the same shape as the defect this guard is
    # about, one layer out — an assertion green over a channel whose state
    # differs in the runs that matter. The sibling variables go too: this is the
    # repo's first nested `prek run`, so an inner run inherits nothing that
    # describes the outer one.
    (cd "$d" && env -u SKIP -u PRE_COMMIT -u PREK prek run session-log-numbering --hook-stage pre-commit) \
      >"$ST_ROOT/out.txt" 2>&1 || true
    # Match what prek ACTUALLY prints when a selector is filtered away — measured,
    # not guessed: with SKIP inherited it says "did not match any hooks" and
    # "No hooks found after filtering", never the word "skipped". A grep for
    # "skipped" here looked right and detected nothing.
    if grep -qiE 'did not match any hooks|no hooks found after filtering|skipped' "$ST_ROOT/out.txt"; then
      st_bad "the per-run count line reaches the terminal through prek (#4535 BLOCKING)" \
        "the NESTED prek run was SKIPPED — it inherited a bypass (SKIP=) from the outer run; \
that is not 'prek swallowed the output'. output: $(tr '\n' '|' <"$ST_ROOT/out.txt")"
    elif grep -q 'checking 1 staged addition/rename' "$ST_ROOT/out.txt"; then
      st_ok "the per-run count line reaches the terminal through prek (#4535 BLOCKING)"
    else
      st_bad "the per-run count line reaches the terminal through prek (#4535 BLOCKING)" \
        "prek swallowed it — is 'verbose = true' still on the hook? output: $(tr '\n' '|' <"$ST_ROOT/out.txt")"
    fi

    # ...and the empty-selection line, on the `--all-files` shape Phase A
    # of verify-ci-equivalent.sh uses, where nothing is staged.
    git -C "$d" reset -q
    rm -f "$d/docs/session-log/session-1281-mine.md"
    (cd "$d" && env -u SKIP -u PRE_COMMIT -u PREK prek run session-log-numbering --all-files --hook-stage pre-commit) \
      >"$ST_ROOT/out.txt" 2>&1 || true
    if grep -q '0 additions/renames staged' "$ST_ROOT/out.txt"; then
      st_ok "the empty-selection line reaches the terminal through prek (#4535 BLOCKING)"
    else
      st_bad "the empty-selection line reaches the terminal through prek (#4535 BLOCKING)" \
        "prek swallowed it — is 'verbose = true' still on the hook? output: $(tr '\n' '|' <"$ST_ROOT/out.txt")"
    fi
  fi

  if [ "$st_fail" != 0 ]; then
    echo "check-session-log-numbering self-test FAILED" >&2
    exit 2
  fi
  echo "check-session-log-numbering self-test passed"
  exit 0
fi

run_guard
