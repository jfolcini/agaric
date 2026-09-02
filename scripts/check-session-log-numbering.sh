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

run_guard
