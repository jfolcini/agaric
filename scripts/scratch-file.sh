#!/usr/bin/env bash
# scripts/scratch-file.sh — collision-proof scratch files for content that is
# CONSUMED LATER THAN IT IS WRITTEN (#3731).
#
# ─── The failure ────────────────────────────────────────────────────────
#
# #3719 and #3725 both opened carrying #3718's PR body, `Closes` lines
# included — merging either as-is would have auto-closed two issues neither
# PR touched, while leaving the issue each actually fixed open. Every gate
# was green: the code was right, tests passed, DCO passed. A PR body is
# simply not something anything verifies, so the only signal was a human
# reading the body against the diff.
#
# The mechanism (confirmed, jfolcini on #3731): an agent wrote its PR body to
# a GENERIC name — `msg.txt`, `pr.md`, `body.md` — in the scratchpad
# directory, which is keyed on SESSION, not on agent. Every concurrent
# subagent in that session shares the same directory and can pick the same
# name. The agent then ran, in order: `git commit -F msg.txt` (immediately —
# correct), `./scripts/push.sh` (~15 minutes of CI-equivalent verification),
# `gh pr create --body-file msg.txt` (reading the file AFTER that wait).
# Another agent overwrote the path during the wait. The commit is right and
# the PR body is wrong, on the same branch, from the same source file — the
# diff, the commit message and the sign-off all agree, so a body-vs-diff
# reviewer has nothing to flag; only the body is from another PR.
#
# The generalisable rule (jfolcini): in a shared scratchpad, any file
# consumed later than it is written needs a unique name, and anything
# consumed across a long wait should be re-verified at the point of use. A
# unique name is not a convention here, because convention already failed
# TWICE with five colliding generic names sitting in the directory at the
# time (`pr.md`, `prbody.md`, `body.md`, `msg.txt`, `msg2.txt`, plus three
# more under `/tmp`). This file exists so "unique name" is something you
# call, not something you remember.
#
# ─── Why this is structural, not a naming convention ──────────────────────
#
# `new` allocates through `mktemp -d`, which resolves through mkdtemp(3): the
# kernel's mkdir(2) fails atomically with EEXIST on any name collision, and
# mkdtemp retries with a fresh random suffix until one call wins. Two concurrent callers
# — even passing the IDENTICAL label — cannot receive the same path, because
# the path does not exist until the call that wins creates it. Sharing the
# scratchpad ROOT is harmless; only sharing a PATH decided in advance is the
# hazard, and this removes the "in advance" — the path isn't known until
# `new` returns it to the one caller that made it.
#
# `verify` closes the second, narrower half: a file whose PATH is unique can
# still be read across a long wait by the same process that wrote it, and
# jfolcini's fix generalises to "anything consumed across a long wait should
# be re-verified at the point of use" — defence in depth for a hardcoded path,
# a copy-pasted variable, or any other way a caller might defeat `new`.
#
# ─── Lifetime and cleanup (#3961) ───────────────────────────────────────
#
# THIS SCRIPT NEVER REMOVES ANYTHING. Each `new` leaves a 0700 directory in
# `${TMPDIR:-/tmp}` for the OS to reap on reboot. That is the chosen policy,
# not an oversight, and it is stated here so nobody has to infer it from the
# absence of an `rm`.
#
# A reaper was considered and rejected for now. The whole point of the
# allocator is that a path stays valid across a long, unbounded gap — the
# incident it fixes is a `gh pr create --body-file` reading a path ~15 minutes
# after `push.sh` started. Any reaper must therefore separate "abandoned" from
# "still held by an agent mid-gate", and getting that wrong reintroduces #3731
# in a worse form: a body file deleted underneath its owner rather than merely
# overwritten. The ~15-minute figure from #3731 is one observation, not a
# bound, so an age threshold would be an invented number.
#
# If cleanup does land later, it needs a test demonstrating it does NOT remove
# a directory whose holder is still live — falsified against a naive
# unconditional `rm -rf`, per #3961's acceptance criterion.
#
# ─── Usage ──────────────────────────────────────────────────────────────
#
#   file="$(scripts/scratch-file.sh new pr-body)"
#   printf '%s' "$body" > "$file"
#   fp="$(scripts/scratch-file.sh fingerprint "$file")"
#   ./scripts/push.sh                                    # the long wait
#   scripts/scratch-file.sh verify "$file" "$fp"          # exits 4 on mismatch
#   gh pr create --body-file "$file"
#
# Exit: 0 on success. 2 bad usage. 3 fingerprint of a missing file. 4 verify
# failed — the file's content is not what this caller wrote; DO NOT consume
# it.

set -euo pipefail

# Split from `usage` because `exit` inside a bash function terminates the whole
# PROCESS: the argument-less subcommand paths below need to report bad usage and
# `return 2`, letting `main()` decide the process's exit status.
usage_text() {
  cat >&2 <<'EOF'
usage:
  scratch-file.sh new <label>                 mint a fresh, collision-proof scratch file; prints its path
  scratch-file.sh fingerprint <file>           print a content fingerprint for later verification
  scratch-file.sh verify <file> <fingerprint>  exit 0 iff <file>'s content still matches <fingerprint>
EOF
}

usage() {
  usage_text
  exit 2
}

scratch_root() {
  # `${TMPDIR:-/tmp}` is the normal case: nothing in this repo or the harness
  # sets CLAUDE_SCRATCHPAD_DIR, so it is an override for a caller that wants
  # allocation inside the session-scoped scratchpad #3731 identified as the
  # shared namespace — not the default. Uniqueness does not depend on which
  # root wins; mktemp owns that either way (see header).
  printf '%s\n' "${CLAUDE_SCRATCHPAD_DIR:-${TMPDIR:-/tmp}}"
}

# NOTE: `return`, never `exit`, inside the three subcommand functions — `exit`
# inside a bash function terminates the whole PROCESS, so a caller that sources
# this file could not observe a failure path. `main()` below is the only place a
# non-zero return becomes the process's exit status, for direct CLI invocation.
# A missing argument returns
# 2 ("bad usage", per the header) rather than letting `${1:?…}` expansion abort
# the shell with 1.
new_scratch_file() {
  if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
    echo "scratch-file.sh: new: missing <label>" >&2
    usage_text
    return 2
  fi
  local label="$1"
  # Sanitised for readability only (`ls` shows `pr-body.a1b2c3` rather than
  # `tmp.a1b2c3`) — never for uniqueness. See header: mktemp owns that.
  local safe_label
  safe_label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-')"
  # `.` and `..` survive the allow-set unchanged and would make `$dir/$safe_label`
  # name the directory itself (or its parent), so `: >"$file"` dies with "Is a
  # directory". They are degenerate labels, not names — fall back like empty.
  case "$safe_label" in
    '' | '.' | '..') safe_label='scratch' ;;
  esac
  local root
  root="$(scratch_root)"
  mkdir -p "$root"
  local dir
  dir="$(mktemp -d "$root/${safe_label}.XXXXXXXXXX")"
  local file="$dir/$safe_label"
  : >"$file"
  printf '%s\n' "$file"
}

fingerprint() {
  if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
    echo "scratch-file.sh: fingerprint: missing <file>" >&2
    usage_text
    return 2
  fi
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "scratch-file.sh: fingerprint: no such file: $file" >&2
    return 3
  fi
  sha256sum "$file" | awk '{print $1}'
}

verify() {
  if [ "$#" -lt 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
    echo "scratch-file.sh: verify: missing <file> and/or <fingerprint>" >&2
    usage_text
    return 2
  fi
  local file="$1"
  local expected="$2"
  if [ ! -f "$file" ]; then
    echo "scratch-file.sh: verify: REFUSING — $file no longer exists (removed since it was written)" >&2
    return 4
  fi
  local actual
  actual="$(fingerprint "$file")" || return 3
  if [ "$actual" != "$expected" ]; then
    echo "scratch-file.sh: verify: REFUSING — $file's content changed since it was written (#3731:" >&2
    echo "  something else wrote to this path during the wait; do not consume it)" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    return 4
  fi
  return 0
}

main() {
  case "${1:-}" in
    new)
      shift
      new_scratch_file "$@"
      ;;
    fingerprint)
      shift
      fingerprint "$@"
      ;;
    verify)
      shift
      verify "$@"
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
