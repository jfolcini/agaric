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
#   scripts/scratch-file.sh --self-test
#
# Exit: 0 on success. 2 bad usage. 3 fingerprint of a missing file. 4 verify
# failed — the file's content is not what this caller wrote; DO NOT consume
# it.

set -euo pipefail

# Split from `usage` because `exit` inside a bash function terminates the whole
# PROCESS: the argument-less subcommand paths below need to report bad usage and
# `return 2` so `run_self_test` can observe that status instead of dying on it.
usage_text() {
  cat >&2 <<'EOF'
usage:
  scratch-file.sh new <label>                 mint a fresh, collision-proof scratch file; prints its path
  scratch-file.sh fingerprint <file>           print a content fingerprint for later verification
  scratch-file.sh verify <file> <fingerprint>  exit 0 iff <file>'s content still matches <fingerprint>
  scratch-file.sh --self-test
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
# inside a bash function terminates the whole PROCESS, which would abort
# `run_self_test` the instant it exercises a failure path instead of letting it
# observe one. `main()` below is the only place a non-zero return becomes the
# process's exit status, for direct CLI invocation. A missing argument returns
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

run_self_test() {
  local st_fail=0
  st_ok() { printf '  ok   - %s\n' "$1"; }
  st_bad() {
    printf '  FAIL - %s: %s\n' "$1" "$2" >&2
    st_fail=1
  }

  # Not `local` — a trap that outlives this function's scope must not close
  # over a local, or it dereferences an unbound variable once the function
  # that declared it has returned.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  export CLAUDE_SCRATCHPAD_DIR="$work/scratchpad"
  mkdir -p "$CLAUDE_SCRATCHPAD_DIR"

  # 1. THE FALSIFICATION: run the exact #3731 timing (write, long wait, a
  #    second writer with the SAME label lands mid-wait, read) down two paths
  #    side by side, and require the old one to clobber AND the new one not to.
  #
  #    The old path is not a hand-written literal in this test — writing two
  #    string literals to one hardcoded name and asserting they differ would
  #    invoke none of the code under test and could not fail. It is derived
  #    from the script itself: `$(scratch_root)/<label>` is precisely what a
  #    name-per-label allocator hands back, so if `new_scratch_file` ever
  #    regressed to a path decided in advance it would return that same path,
  #    the mid-wait writer would land on it, and the second conjunct below
  #    would fail. (Verified by patching a copy of this script to drop
  #    `mktemp -d`: this assertion fails against it.)
  local body_a='PR body for #3719 (the op-log frontier fix)'
  local body_b='PR body for #3718 (docs). Closes #3272. Closes #3273.'
  local old_shape_a new_shape_a
  old_shape_a="$(scratch_root)/pr-body" # what the pre-fix code produced
  new_shape_a="$(new_scratch_file pr-body)"
  printf '%s' "$body_a" >"$old_shape_a"
  printf '%s' "$body_a" >"$new_shape_a"
  # the long wait — a second concurrent agent, identical label, lands mid-wait
  printf '%s' "$body_b" >"$(scratch_root)/pr-body"
  printf '%s' "$body_b" >"$(new_scratch_file pr-body)"
  local old_readback new_readback
  old_readback="$(cat "$old_shape_a")"
  new_readback="$(cat "$new_shape_a")"
  if [ "$old_readback" = "$body_b" ] && [ "$new_readback" = "$body_a" ]; then
    st_ok "the #3719 timing clobbers a path derived from the label, and does NOT clobber new's path"
  else
    st_bad "the #3719 timing clobbers a label-derived path but not new's path" \
      "label-derived path read back [$old_readback]; new's path read back [$new_readback]"
  fi

  # 2. THE FIX: `new` with the SAME label, called twice, never returns the
  #    same path — not "unlikely", checked directly.
  local fa fb
  fa="$(new_scratch_file pr-body)"
  fb="$(new_scratch_file pr-body)"
  if [ "$fa" != "$fb" ]; then
    st_ok "new: two calls with the identical label get distinct paths"
  else
    st_bad "new: two calls with the identical label get distinct paths" "both got $fa"
  fi

  # 3. THE FIX UNDER REAL CONCURRENCY: not two sequential calls (mktemp's
  #    clock-based fallback could paper over a race a sequential test can't
  #    see) but N callers racing for real, same label, same instant.
  local n=25 pathsfile="$work/paths.txt"
  : >"$pathsfile"
  local pids=()
  for _ in $(seq 1 "$n"); do
    (new_scratch_file pr-body >>"$pathsfile") &
    pids+=("$!")
  done
  local pid
  # `|| true`: a non-zero child status propagated by `wait` would trip `set -e`
  # and kill the self-test before the assertion below can print its
  # "$got lines, $uniq distinct" diagnostic. The line/uniq counts do the
  # asserting — a caller that failed contributed no line, so it still fails.
  for pid in "${pids[@]}"; do wait "$pid" || true; done
  local got uniq
  got="$(wc -l <"$pathsfile" | tr -d ' ')"
  uniq="$(sort -u "$pathsfile" | wc -l | tr -d ' ')"
  if [ "$got" = "$n" ] && [ "$uniq" = "$n" ]; then
    st_ok "new: $n genuinely concurrent callers, identical label, $uniq/$n distinct paths — no collision"
  else
    st_bad "new: $n concurrent callers all get distinct paths" "$got lines, $uniq distinct (wanted $n/$n)"
  fi

  # 4. THE FIX REPLAYS THE INCIDENT: run the exact #3719/#3725 timing again,
  #    this time through `new` instead of a shared generic name — the writer
  #    that "loses" the OLD race in test 1 must read back its OWN content.
  local fileA fileB
  fileA="$(new_scratch_file pr-body)"
  printf 'PR body for #3719 (the op-log frontier fix)' >"$fileA"
  local wroteA
  wroteA="$(cat "$fileA")"
  # the long wait; a second, concurrent agent writes ITS OWN scratch file —
  # same label, guaranteed-distinct path, so it cannot land on $fileA
  fileB="$(new_scratch_file pr-body)"
  printf 'PR body for #3718 (docs). Closes #3272. Closes #3273.' >"$fileB"
  local readA
  readA="$(cat "$fileA")"
  if [ "$readA" = "$wroteA" ]; then
    st_ok "new: the #3719 timing replayed through unique paths reads back its own body, unclobbered"
  else
    st_bad "new: the #3719 timing replayed through unique paths reads back its own body" \
      "wrote [$wroteA] read [$readA]"
  fi

  # 5. fingerprint/verify: unchanged content verifies clean.
  local f fp
  f="$(new_scratch_file commit-msg)"
  printf 'fix(sync): the op-log frontier …' >"$f"
  fp="$(fingerprint "$f")"
  if verify "$f" "$fp" 2>/dev/null; then
    st_ok "verify: passes when the file is exactly what fingerprint saw"
  else
    st_bad "verify: passes when the file is exactly what fingerprint saw" "verify exited nonzero"
  fi

  # 6. fingerprint/verify: defence in depth — tampered content is REFUSED,
  #    loudly, not silently accepted.
  printf 'a different agent wrote over this' >"$f"
  if verify "$f" "$fp" 2>/dev/null; then
    st_bad "verify: refuses a file whose content changed since fingerprinting" \
      "verify exited 0 on tampered content"
  else
    st_ok "verify: refuses a file whose content changed since fingerprinting"
  fi

  # 7. fingerprint/verify: a REMOVED file is refused too, not silently
  #    treated as "nothing to check".
  rm -f "$f"
  if verify "$f" "$fp" 2>/dev/null; then
    st_bad "verify: refuses a file that no longer exists" "verify exited 0 on a missing file"
  else
    st_ok "verify: refuses a file that no longer exists"
  fi

  # 8. The documented exit codes are the ones a caller actually observes. The
  #    header promises "2 bad usage"; an argument-less subcommand used to reach
  #    a `${1:?…}` expansion and abort the shell with 1, so anything branching
  #    on status 2 to detect misuse never saw it.
  local self="${BASH_SOURCE[0]}" bad_usage_fail=''
  local case_desc rc
  for case_desc in 'new' 'fingerprint' 'verify' 'verify /nonexistent' 'not-a-subcommand'; do
    rc=0
    # shellcheck disable=SC2086 # deliberate word-splitting: each case is an argv
    bash "$self" $case_desc >/dev/null 2>&1 || rc=$?
    [ "$rc" = 2 ] || bad_usage_fail="$bad_usage_fail [$case_desc exited $rc, wanted 2]"
  done
  if [ -z "$bad_usage_fail" ]; then
    st_ok "usage: every argument-less subcommand and an unknown one exit 2, as the header documents"
  else
    st_bad "usage: every argument-less subcommand and an unknown one exit 2" "$bad_usage_fail"
  fi

  # 9. A degenerate label ('.' / '..') survives the allow-set unchanged and
  #    would name the minted directory itself, so `: >"$file"` died with "Is a
  #    directory" and aborted `new` under `set -e`. Nonsense in, a usable
  #    scratch file out.
  local degenerate df dfail=''
  for degenerate in '.' '..' '/' '///'; do
    df=''
    df="$(new_scratch_file "$degenerate" 2>/dev/null)" || df=''
    if [ -z "$df" ] || [ ! -f "$df" ]; then
      dfail="$dfail [label '$degenerate' -> '${df:-<none>}']"
    fi
  done
  if [ -z "$dfail" ]; then
    st_ok "new: degenerate labels ('.', '..', '/', '///') still mint a real, writable file"
  else
    st_bad "new: degenerate labels still mint a real file" "$dfail"
  fi

  if [ "$st_fail" -ne 0 ]; then
    echo "scratch-file.sh self-test FAILED" >&2
    return 1
  fi
  echo "scratch-file.sh self-test passed"
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
    --self-test)
      run_self_test
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
