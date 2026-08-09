# shellcheck shell=bash
#
# Shared guard for any script that runs `git` against a SCRATCH tree (#3722).
#
# ─── The failure ──────────────────────────────────────────────────────────
#
# A self-test that builds git fixtures runs `git -C "$dir" init`, `git -C
# "$dir" config user.email …`, `git -C "$dir" commit …`. That looks isolated
# and is not. When the script runs from a git hook — which is exactly where a
# prek self-test runs — git has exported `GIT_DIR`, `GIT_INDEX_FILE` and
# `GIT_WORK_TREE` pointing at the REAL repository, and **those outrank
# `git -C <dir>`**. So:
#
#   * `git -C "$tmp" init` re-inits the real repo and rewrites `core.worktree`
#     to `$tmp`, which stops working the moment `$tmp` is removed — every
#     later `git` in that repo dies with "fatal: Invalid path '/tmp/tmp.XXX'",
#     including the ones `gh` shells out to;
#   * `git -C "$tmp" config user.email t@example.com` overwrites the
#     developer's own identity;
#   * `git -C "$tmp" add -A` writes the REAL index, which then believes every
#     tracked file is deleted and the fixture's files are the repo's.
#
# All three have now happened in this repo. #3690 hit it while writing the
# session-log fixtures. #3722 hit it again. It hit a third time on #3736,
# where a new self-test wired as a pre-commit hook left the worktree's index
# claiming 4,464 deletions and the main checkout unusable.
#
# ─── Why this file exists rather than a fourth copy ───────────────────────
#
# Three scripts already carry their own private version of this scrubber
# (`check-session-log-numbering.sh`, `check-migrations-immutable.sh`,
# `test-related-rust.sh`). Each was added after the same incident, and each
# protected only itself — so the fourth script to build a git fixture was
# unprotected, and duly reproduced the failure. A per-script fix does not end
# a class of defect; it just moves the next occurrence somewhere new. Any
# script that touches a scratch git tree should source THIS file.
#
# ─── Contract ─────────────────────────────────────────────────────────────
#
#   git_scratch_guard [<scratch-root>]
#     Unsets every variable through which git's ambient context can reach a
#     scratch tree, then VERIFIES none survived and **exits 3 if any did**,
#     rather than proceeding with a polluted environment. Verification is not
#     ceremony: a readonly variable cannot be unset, and "unset succeeded" is
#     an assumption, not an observation. With <scratch-root> given, also pins
#     `GIT_CEILING_DIRECTORIES` so a fixture repo cannot discover a real
#     repository above itself.
#
#   git_scratch_init <dir>
#     `git init` a fixture at <dir> with hooks, signing and identity made
#     safe, then assert its toplevel really is <dir> — the belt-and-braces
#     check that catches anything the scrub missed, before a single commit.

# Every variable through which git's ambient context can redirect a command,
# as one list so the scrub and the verification cannot drift apart. That
# drift is its own hazard: a scrubber checking a shorter list than it unsets
# reports clean while a variable it forgot is still doing the damage.
GIT_SCRATCH_LEAK_VARS='GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_PARAMETERS
GIT_CONFIG_COUNT GIT_AUTHOR_DATE GIT_COMMITTER_DATE GIT_INDEX_VERSION
GIT_INTERNAL_GETTEXT_SH_SCHEME'

git_scratch_guard() {
  local scratch_root="${1:-}" v survivors=''
  for v in $GIT_SCRATCH_LEAK_VARS; do
    unset "$v" 2>/dev/null || true
  done
  # Observed, not assumed. `printenv` asks the ENVIRONMENT — which is what git
  # reads — rather than the shell's own variable table, so a readonly export
  # that `unset` could not remove is still caught.
  for v in $GIT_SCRATCH_LEAK_VARS; do
    if printenv "$v" >/dev/null 2>&1; then
      survivors="${survivors:+$survivors }$v"
    fi
  done
  if [ -n "$survivors" ]; then
    echo "git-scratch-guard: REFUSING TO RUN — ambient git environment survived scrubbing:" >&2
    echo "  $survivors" >&2
    echo "  These outrank \`git -C <dir>\`, so every fixture command would operate on the" >&2
    echo "  REAL repository: re-initialising it, rewriting core.worktree and its index" >&2
    echo "  (#3722). Aborting instead of proceeding." >&2
    exit 3
  fi
  if [ -n "$scratch_root" ]; then
    # A fixture must not discover a repository ABOVE itself either — that is
    # the same accident by a different route.
    GIT_CEILING_DIRECTORIES="$(dirname "$scratch_root")"
    export GIT_CEILING_DIRECTORIES
  fi
}

git_scratch_init() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  # `core.hooksPath` is inherited from the caller's config, and prek aborts on
  # a repo with no prek.toml — so a fixture commit would fail for a reason
  # having nothing to do with what is under test.
  git -C "$dir" config core.hooksPath /dev/null
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config user.email selftest@example.invalid
  git -C "$dir" config user.name 'self test'
  # Belt AND braces. If anything above was missed, the fixture resolves
  # somewhere other than $dir, and this is the last moment at which that is
  # still harmless.
  local top
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$top" != "$(cd "$dir" && pwd -P)" ]; then
    echo "git-scratch-guard: fixture at '$dir' resolved to '$top' — refusing to continue" >&2
    exit 3
  fi
}

# ---------------------------------------------------------------------------
# self-test — run with `bash scripts/lib/git-scratch-guard.sh --self-test`
# ---------------------------------------------------------------------------

_gsg_self_test() {
  local failures=0 tmp
  _ok() { printf '  ok   - %s\n' "$1"; }
  _bad() {
    failures=$((failures + 1))
    printf '  FAIL - %s: %s\n' "$1" "$2" >&2
  }
  _eq() { if [ "$2" = "$3" ]; then _ok "$1"; else _bad "$1" "expected [$2], got [$3]"; fi; }

  tmp="$(mktemp -d -t git-scratch-guard-selftest.XXXXXX)"
  # shellcheck disable=SC2064 # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # A stand-in for "the developer's repository". Every assertion below is
  # about THIS repo being untouched, so the test can reproduce the real
  # incident without ever pointing at the real checkout.
  local victim="$tmp/victim"
  git_scratch_guard "$tmp"
  git_scratch_init "$victim"
  echo original > "$victim/tracked.txt"
  git -C "$victim" add -A
  git -C "$victim" commit -qm base
  local victim_head victim_status_before
  victim_head="$(git -C "$victim" rev-parse HEAD)"
  victim_status_before="$(git -C "$victim" status --porcelain)"

  # ── 1. THE INCIDENT, reproduced and then prevented ──────────────────────
  # A hook environment pointing at `victim`, and a fixture build that uses
  # `git -C <fixture>` throughout — the shape that broke #3690, #3722 and
  # #3736. With the guard, the fixture is built and the victim is untouched.
  (
    export GIT_DIR="$victim/.git"
    export GIT_WORK_TREE="$victim"
    export GIT_INDEX_FILE="$victim/.git/index"
    git_scratch_guard "$tmp"
    git_scratch_init "$tmp/fixture"
    echo fixture > "$tmp/fixture/fixture-only.txt"
    git -C "$tmp/fixture" add -A
    git -C "$tmp/fixture" commit -qm 'fixture commit'
  ) >/dev/null 2>&1
  _eq 'the victim repo HEAD is unmoved after a fixture build under a hook environment' \
    "$victim_head" "$(git -C "$victim" rev-parse HEAD)"
  _eq 'the victim repo index is unchanged (no phantom deletions, no fixture files staged)' \
    "$victim_status_before" "$(git -C "$victim" status --porcelain)"
  _eq 'the victim repo core.worktree was NOT rewritten by the fixture init' \
    '' "$(git -C "$victim" config --local --get core.worktree || true)"
  _eq "the victim repo's identity was not overwritten" \
    'selftest@example.invalid' "$(git -C "$victim" config --local --get user.email)"
  _eq 'the fixture commit landed in the FIXTURE, not the victim' \
    'fixture-only.txt' "$(git -C "$tmp/fixture" show --name-only --format= HEAD | tr -d '[:space:]')"

  # …and the same shape WITHOUT the guard really does damage, so assertion 1
  # is not vacuous. A guard that has never been shown to prevent anything is
  # indistinguishable from no guard.
  # The damage asserted here is the damage that was MEASURED, not the damage
  # that sounded likely: under `GIT_DIR`, `git -C <fixture> init` prints
  # "warning: re-init", re-initialises the VICTIM and never creates the
  # fixture at all — so every later `git -C <fixture> …` in the self-test also
  # lands on the victim, and `git -C <fixture> config user.email` duly
  # overwrites the developer's identity. (That is what happened on #3736: the
  # main checkout's `user.email` had to be restored by hand, along with a
  # `core.worktree` pointing at a deleted temp dir.)
  local unguarded="$tmp/unguarded"
  git_scratch_init "$unguarded"
  echo original > "$unguarded/tracked.txt"
  git -C "$unguarded" add -A
  git -C "$unguarded" commit -qm base
  (
    export GIT_DIR="$unguarded/.git"
    export GIT_WORK_TREE="$unguarded"
    export GIT_INDEX_FILE="$unguarded/.git/index"
    # NO git_scratch_guard here — this is the pre-#3722 code path.
    mkdir -p "$tmp/leaky"
    git -C "$tmp/leaky" init -q -b main
    git -C "$tmp/leaky" config user.email leaked@example.invalid
  ) >/dev/null 2>&1
  if [ -d "$tmp/leaky/.git" ]; then
    _bad 'WITHOUT the guard, the fixture init lands on the victim instead' \
      'the fixture repo was created — the guarded assertions above may be vacuous'
  else
    _ok 'WITHOUT the guard, the fixture repo is never created (the init re-inits the victim)'
  fi
  _eq "WITHOUT the guard, the victim's identity is overwritten by the fixture's config" \
    'leaked@example.invalid' "$(git -C "$unguarded" config --local --get user.email || true)"

  # ── 2. THE ABORT PATH ───────────────────────────────────────────────────
  # `unset` cannot remove a readonly export, so the scrub CANNOT succeed. The
  # guard must refuse to run rather than continue into the fixtures. Exit 3,
  # and nothing on stdout.
  local rc out
  out=$(
    declare -rx GIT_DIR="$victim/.git"
    git_scratch_guard "$tmp"
    echo "REACHED THE CODE AFTER THE GUARD"
  ) 2>/dev/null
  rc=$?
  _eq 'a git variable that cannot be scrubbed aborts with exit 3' '3' "$rc"
  _eq 'and nothing after the guard runs' '' "$out"
  _eq 'the victim is still untouched after the aborted run' \
    "$victim_head" "$(git -C "$victim" rev-parse HEAD)"

  # ── 3. The scrub and the verification read ONE list ──────────────────────
  # A scrubber that unsets more than it checks reports clean while the
  # variable it forgot is still redirecting commands.
  local listed
  listed="$(printf '%s\n' "$GIT_SCRATCH_LEAK_VARS" | tr ' ' '\n' | grep -c 'GIT_')"
  if [ "$listed" -ge 15 ]; then
    _ok "the leak list covers the documented surface ($listed variables)"
  else
    _bad 'the leak list covers the documented surface' "only $listed variables"
  fi
  # Normalised through word splitting: the list is written across several
  # lines, so a raw substring match sees "GIT_OBJECT_DIRECTORY\n" and reports
  # a variable that IS present as missing.
  local normalised
  # shellcheck disable=SC2086 # deliberate word splitting to collapse newlines
  normalised=" $(echo $GIT_SCRATCH_LEAK_VARS) "
  for v in GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR; do
    case "$normalised" in
      *" $v "*) : ;;
      *) _bad "the leak list contains $v" 'missing' ;;
    esac
  done
  _ok 'the five variables that have actually caused damage are all in the list'

  # ── 4. GIT_CEILING_DIRECTORIES stops upward discovery ───────────────────
  _eq 'the scratch root gets a ceiling so a fixture cannot find a repo above it' \
    "$(dirname "$tmp")" "${GIT_CEILING_DIRECTORIES:-}"

  if [ "$failures" -gt 0 ]; then
    printf '\nself-test: %s assertion(s) failed\n' "$failures" >&2
    exit 2
  fi
  printf 'self-test: all assertions passed\n'
}

if [ "${1:-}" = "--self-test" ]; then
  set -uo pipefail
  _gsg_self_test
fi
