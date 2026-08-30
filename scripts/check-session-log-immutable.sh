#!/usr/bin/env bash
# Session-log immutability guard (#4536).
#
# docs/session-log/README.md: a merged session log is append-only — a
# correction goes in the NEW session's log with a back-reference
# ("session-1430 said X; it was wrong because Y"), never as an edit to the
# existing file. #4530 broke that rule (edited session-1430 after #4506 had
# already merged it) and nothing caught it locally. This is the mechanical
# side of that fix: the docs side (README.md) says where a correction goes,
# this says an edit to an already-merged log fails the commit.
#
# ─── Why diff-filter, not a parser ────────────────────────────────────────
#
# "Was this path already in the merge target's tree?" is answered entirely
# by git's own status classification against `origin/main` — no model of
# session-log content is needed to answer it.
#
# ─── D, M and R, all three (#4527) ────────────────────────────────────────
#
# #4527 is the record of `check-session-log-numbering.sh` selecting only
# `--diff-filter=A` and silently checking nothing on a `git mv` renumber.
# This guard's first cut reproduced that bug one letter over, with
# `--diff-filter=MR`, and the reasoning that got it there is worth keeping
# so it is not repeated: `M` and `R` look like the complete set of "the
# file changed but still exists" statuses, and they are — but the
# operations this guard must catch are not all spelled that way.
# Verified in a throwaway repo, git 2.43, all four spellings:
#
#   M   edit in place of a merged log                    → caught by M
#   R   `git mv` of a merged log, body untouched (R100)  → caught by R
#   D+A `git mv` of a merged log PLUS a heavy body edit  → NOT R AT ALL.
#       Below git's rename-similarity threshold the same logical operation
#       is staged as a `D` of the old path and an `A` of the new one, so
#       `MR` selected NOTHING and the guard printed "0 … nothing to check"
#       over a rewritten merged log. This is #4527's bug verbatim, and it
#       is not hypothetical: `diff.renames=false` in a user's git config
#       turns EVERY rename into this shape.
#   D   `git mv` of a merged log to a path outside $LOG_DIR, or an
#       outright `git rm` of it. Inside the pathspec both are a bare `D`.
#
# So the selector is `--diff-filter=DMR`, and a `D` whose path is in the
# merge target FAILS like the others. Telling "the D half of a rename"
# apart from "a deletion" would need a similarity model — the parsing this
# guard exists to avoid — and both answers are the same anyway: deleting a
# merged log destroys the record more completely than editing it does.
# The one legitimate `D` is an archive compaction (folding merged logs
# into `docs/session-log/2026-sessions-401-800.md` and friends); that is a
# deliberate, rare, maintainer operation and the error message names the
# `SKIP=` override for it.
#
# A pure RENAME (no content change) of an already-merged log is rejected
# deliberately, not incidentally: README.md says "never rename … an
# existing file" in the same sentence as "never edit" it, so a rename is
# its own violation of the rule this guard enforces.
#
# ─── always_run, not a `files:` key (prek.toml) ───────────────────────────
#
# The hook stanza uses `always_run = true` with no `files` regex, for the
# reason `check-sqlx-cache-drift` and `migrations-immutable` already
# document: prek's changed-file set EXCLUDES deletions, so a `files`-keyed
# hook is skipped outright on a commit that only deletes a session log —
# verified against prek 0.3.8, which reported "(no files to check)Skipped"
# for exactly that commit. A path-keyed trigger would also be one more
# instance of #4501's class (a path-keyed guard whose subject moves stops
# selecting anything); `always_run` cannot go stale. The cost is two cheap
# git calls and one "0 … nothing to check" line on every commit.
#
# ─── What "already-merged" means here ─────────────────────────────────────
#
# A file added and then amended on the SAME branch, before that branch
# merges, must not be flagged — that is normal drafting, not a correction
# of a published record. The cheap, unambiguous way to tell the two apart:
# does the path (M, D) / the rename's SOURCE path (R) exist in the MERGE
# TARGET's tree (`origin/main`, falling back to local `main`) right now? If
# not, the file has never been merged, so editing, renaming or deleting it
# now is fine. This can't be fooled by same-branch history rewrites and
# needs no model of "when was this committed."
#
# When NEITHER ref exists the guard FAILS rather than passing. Unlike
# `check-session-log-numbering.sh`, which degrades to a still-meaningful
# branch-local check, the merge target is this guard's ONLY input: with no
# target there is no question it can answer, and a green exit would be a
# negative claim over an empty set — the precise shape #4501 catalogues and
# #4527 was filed about. It says so and exits 1.
#
# ─── No --self-test (#4536, per #4556's criterion) ────────────────────────
#
# #4536 scopes this guard without one, on #4556's criterion that a guard
# earns a self-test only when it parses source text with its own parser.
# This one does not parse anything. Note honestly what that criterion does
# NOT cover, since this guard has already been bitten by it once: the
# fail-open surface here is the SELECTOR, not a parser, and a wrong
# letter-set fails silently and green, exactly as it did in #4527. The
# four spellings enumerated above are the arms that matter; anyone editing
# the `--diff-filter` below should re-drive all four in a throwaway repo
# before trusting prose about which statuses git emits.
set -euo pipefail

LOG_DIR="docs/session-log"

# Merge target this commit is going to join, same fallback chain as
# check-session-log-numbering.sh: `origin/main` for a real checkout, local
# `main` for a clone that has not fetched. Empty when neither exists.
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

exists_in_target() {
  git cat-file -e "$1:$2" 2>/dev/null
}

# Staged records, read from a FILE rather than a process substitution: a
# `git diff` that fails inside `< <(…)` leaves the loop reading an empty
# stream, which this guard would otherwise report as "0 … nothing to
# check" — a clean run it never performed.
records_file="$(mktemp)"
trap 'rm -f "$records_file"' EXIT
if ! git diff --cached -z --name-status --diff-filter=DMR \
  -- "$LOG_DIR/session-*.md" >"$records_file"; then
  echo "ERROR: session-log-immutable: \`git diff --cached\` failed; refusing to report a clean run it did not perform." >&2
  exit 1
fi

# Parse first, judge second, so the no-merge-target case can be reported
# against the real record count instead of a truncated one.
statuses=()
srcs=()
dsts=()
while IFS= read -r -d '' status; do
  case "$status" in
    M | D)
      IFS= read -r -d '' src
      dst=""
      ;;
    R*)
      IFS= read -r -d '' src
      IFS= read -r -d '' dst
      ;;
    *)
      # Unreachable under --diff-filter=DMR today. If git ever emits a
      # status this parser does not know, the field count per record is
      # unknown from here on and every subsequent record is garbage — so
      # fail loudly rather than silently mis-parse the rest.
      echo "ERROR: session-log-immutable: unrecognised git status '$status' under $LOG_DIR; refusing to guess its field count." >&2
      exit 1
      ;;
  esac
  statuses+=("$status")
  srcs+=("$src")
  dsts+=("$dst")
done <"$records_file"

total="${#statuses[@]}"

if [ "$total" -eq 0 ]; then
  echo "session-log-immutable: 0 staged modification/rename/deletion(s) under $LOG_DIR/session-*.md — nothing to check."
  exit 0
fi

target_ref="$(merge_target_ref)"
if [ -z "$target_ref" ]; then
  echo "ERROR: session-log-immutable: $total staged modification/rename/deletion(s) under $LOG_DIR, and no merge target to check them against." >&2
  echo "  Looked for refs/remotes/origin/main, then refs/heads/main — neither exists in this checkout." >&2
  echo "  This guard's only question is 'is this path already in the merge target's tree?', so with no target it can" >&2
  echo "  answer nothing. Passing here would be a green run that checked zero of $total files (#4527, #4501)." >&2
  echo "  Fix: git fetch origin main:refs/remotes/origin/main   (or create a local refs/heads/main)." >&2
  exit 1
fi

target_name="${target_ref#refs/remotes/}"
checked=0
fail=0
for i in "${!statuses[@]}"; do
  status="${statuses[$i]}"
  src="${srcs[$i]}"
  dst="${dsts[$i]}"
  checked=$((checked + 1))
  exists_in_target "$target_ref" "$src" || continue
  case "$status" in
    M)
      echo "ERROR: $src — already merged into $target_name; a correction belongs in the NEW session's log with a back-reference (docs/session-log/README.md), not an edit to this file." >&2
      ;;
    R*)
      echo "ERROR: $src -> $dst — already merged into $target_name; renaming a merged session log is the same violation as editing one (docs/session-log/README.md)." >&2
      ;;
    D)
      echo "ERROR: $src — already merged into $target_name; deleting a merged session log destroys the record more completely than editing it (docs/session-log/README.md)." >&2
      echo "  If this is the other half of a rename git staged as D+A, the rename itself is the violation." >&2
      echo "  If this is a deliberate archive compaction, that is the one legitimate case: SKIP=session-log-immutable git commit …" >&2
      ;;
  esac
  fail=1
done

# #4501: the report must not be able to overstate what was examined.
if [ "$checked" -ne "$total" ]; then
  echo "ERROR: session-log-immutable: selected $total staged record(s) but checked $checked." >&2
  fail=1
fi

echo "session-log-immutable: checked $checked staged modification/rename/deletion(s) against $target_name."
exit "$fail"
