#!/usr/bin/env bash
# Session-log numbering guard (#2556).
#
# History: once the log crossed session-999, `ls docs/session-log | tail`
# started sorting lexicographically (session-1000 < session-996), and every
# agent that derived "next number" that way collided on session-1000 —
# fifteen times. The rule is NUMERIC max + 1; this hook enforces it for
# newly added files so the mistake is caught at commit time, not review.
#
# Checks, for each staged ADDED docs/session-log/session-NNN-*.md:
#   1. NNN does not collide with any existing (committed or staged) entry.
#   2. NNN is exactly numeric-max-of-the-rest + 1 (multiple new files in one
#      commit must form a contiguous run above the old max).
set -euo pipefail

LOG_DIR="docs/session-log"

added=$(git diff --cached --name-only --diff-filter=A -- "$LOG_DIR/session-*.md" || true)
[ -z "$added" ] && exit 0

num_of() { basename "$1" | sed -E 's/^session-([0-9]+)-.*$/\1/'; }

# All session numbers already in HEAD (i.e. excluding the staged additions).
existing_max=$(git ls-tree -r --name-only HEAD -- "$LOG_DIR" 2>/dev/null \
  | grep -oE 'session-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
existing_max=${existing_max:-0}

expected=$((existing_max + 1))
fail=0
for f in $(echo "$added" | while read -r p; do echo "$(num_of "$p") $p"; done | sort -n | cut -d' ' -f2); do
  n=$(num_of "$f")
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "ERROR: $f — cannot parse session number." >&2; fail=1; continue
  fi
  if [ "$n" -ne "$expected" ]; then
    echo "ERROR: $f is numbered $n but the next session number is $expected" >&2
    echo "  (numeric max of existing entries is $existing_max — compute it with:" >&2
    echo "   ls $LOG_DIR | grep -oP 'session-\\K[0-9]+' | sort -n | tail -1" >&2
    echo "   NEVER with plain 'ls | tail': it sorts lexicographically.)" >&2
    fail=1
  fi
  expected=$((n + 1))
done

# Duplicate detection across the full staged tree (catches collisions with
# the fifteen historical session-1000 files too, for any number).
dupes=$( { git ls-tree -r --name-only HEAD -- "$LOG_DIR" 2>/dev/null; echo "$added"; } \
  | grep -oE 'session-[0-9]+' | sort -n | uniq -d || true)
if [ -n "$dupes" ]; then
  for d in $dupes; do
    # Pre-existing duplicates (the 1000 pileup) are history; only flag a dupe
    # if one of the staged additions participates in it.
    if echo "$added" | grep -q "$d-"; then
      echo "ERROR: staged session-log file reuses an existing number: $d" >&2
      fail=1
    fi
  done
fi

exit $fail
