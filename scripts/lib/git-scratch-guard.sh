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
#     safe, then assert that EVERY path git resolves from inside it — the
#     toplevel, the git dir, AND THE INDEX — lands inside <dir>. The
#     belt-and-braces check that catches anything the scrub missed, before a
#     single commit.
#
# ─── Why the index is probed separately (#4015) ───────────────────────────
#
# This function used to assert one property only:
#
#     top="$(git -C "$dir" rev-parse --show-toplevel)"; [ "$top" = "$dir" ]
#
# and that property is structurally blind to a leaked `GIT_INDEX_FILE`.
# Measured on git 2.43, with `GIT_INDEX_FILE` exported at another repository
# and no other git variable set:
#
#   git -C <fixture> rev-parse --show-toplevel      <fixture>          (pinned)
#   git -C <fixture> rev-parse --absolute-git-dir   <fixture>/.git     (pinned)
#   git -C <fixture> rev-parse --git-path index     <victim>/.git/index  ← MOVES
#
# So the guard written after three separate incidents (#3690, #3722, #3736)
# was checking the one thing that cannot see this variant — and #3962 duly
# shipped a `.mjs` self-test that enumerated the REAL repository's 4,610
# paths in place of its 8-file fixture, with every assertion green. Only
# `--git-path index` moves, so only `--git-path index` detects it. Do not
# "simplify" the probe list back down to the toplevel: the toplevel alone
# reports nothing.
#
# A RELATIVE `GIT_INDEX_FILE` (`.git/index` — what an ordinary `git commit`
# exports) resolves against the fixture and is therefore NOT a leak; the
# check resolves relative answers against <dir> rather than rejecting them.

# Every variable through which git's ambient context can redirect a command,
# as one list so the scrub and the verification cannot drift apart. That
# drift is its own hazard: a scrubber checking a shorter list than it unsets
# reports clean while a variable it forgot is still doing the damage.
#
# The identity half of that surface belongs here for the same reason the DATE
# half already did. `GIT_COMMITTER_EMAIL` OUTRANKS the fixture's own
# `user.email` (measured: with `user.email = fixture@example.invalid` in the
# fixture's config, `git var GIT_COMMITTER_IDENT` answers the environment's
# address), so a fixture that configures an identity and then asserts on it is
# asserting on the caller's shell instead. A self-test that compares the
# committer address against something is then green or red for a reason it
# never set up — the #3722 shape exactly, one variable to the left. Scrubbing
# GIT_AUTHOR_DATE while leaving GIT_AUTHOR_EMAIL was an asymmetry, not a
# decision. `EMAIL` is git's documented fallback when no `user.email` is
# configured, and reaches a fixture by the same route.
GIT_SCRATCH_LEAK_VARS='GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_PARAMETERS
GIT_CONFIG_COUNT GIT_AUTHOR_DATE GIT_COMMITTER_DATE GIT_INDEX_VERSION
GIT_INTERNAL_GETTEXT_SH_SCHEME GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL'

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

# Absolutise a path git reported, against the fixture's PHYSICAL root.
# `rev-parse --git-path index` answers relatively (`.git/index`) when the
# index really is the fixture's, and absolutely when it is somebody else's,
# so both spellings have to reach the same comparison.
_gsg_abs() {
  case "$2" in
    /*) printf '%s\n' "$2" ;;
    *) printf '%s/%s\n' "$1" "$2" ;;
  esac
}

# True iff "$2" (already absolutised) names "$1" or something under it. A
# value containing a `..` segment is treated as OUTSIDE regardless of how it
# spells itself — resolving it textually is how a check like this gets
# talked out of a leak it should have caught.
_gsg_inside() {
  case "$2" in
    *"/../"* | */..) return 1 ;;
  esac
  case "$2" in
    "$1" | "$1"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# One `git rev-parse <args>` probe against the fixture. Empty (the command
# failed) counts as a LEAK, not as a pass: a probe that could not look has
# not established anything, which is the failure mode this whole file is
# about.
_gsg_probe_inside() {
  local base="$1" label="$2" dir="$3"
  shift 3
  local value abs
  value="$(git -C "$dir" rev-parse "$@" 2>/dev/null || true)"
  if [ -z "$value" ]; then
    echo "git-scratch-guard: fixture at '$dir' — \`git rev-parse $*\` produced no answer," >&2
    echo "  so its isolation could not be established. Refusing to continue." >&2
    exit 3
  fi
  abs="$(_gsg_abs "$base" "$value")"
  if ! _gsg_inside "$base" "$abs"; then
    echo "git-scratch-guard: fixture at '$dir' is NOT isolated — its $label resolves to" >&2
    echo "  '$abs', outside the fixture. Every command run here would operate on that" >&2
    echo "  tree instead (#3722, #4015). Refusing to continue." >&2
    exit 3
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
  # still harmless. THREE probes, not one — see the header: the toplevel and
  # the git dir both stay pinned to the fixture under a leaked
  # `GIT_INDEX_FILE`, and only `--git-path index` moves.
  local base
  base="$(cd "$dir" && pwd -P)"
  _gsg_probe_inside "$base" 'toplevel' "$dir" --show-toplevel
  _gsg_probe_inside "$base" 'git dir' "$dir" --absolute-git-dir
  _gsg_probe_inside "$base" 'index' "$dir" --git-path index
}
