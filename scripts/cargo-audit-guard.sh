#!/usr/bin/env bash
# #3688 — `cargo audit` collapses two categorically different outcomes into
# one non-zero exit code:
#
#   1. our dependency tree contains a known-vulnerable crate — actionable,
#      the thing the gate exists for.
#   2. the RustSec advisory DATABASE itself failed to load — infrastructure,
#      says nothing about our dependencies, and is not actionable in this
#      repo at all.
#
# Live incident: RustSec commit e11d6b33 added an advisory whose directory
# didn't match its own `package` field (`crates/gettext-rs/RUSTSEC-0000-
# 0000.md` declaring `package = "gettext-sys"`). `cargo audit` refuses to
# load the WHOLE database on a mismatch like that and exits non-zero before
# auditing anything — indistinguishable, from the exit code alone, from a
# real vulnerable dependency. It reddened every backend PR simultaneously.
#
# ─── Why this is not "add a waiver" ────────────────────────────────────────
#
# The documented escape hatch (`_validate.yml`, PEND-41 R5) is an entry in
# `src-tauri/.cargo/audit.toml [advisories].ignore` naming an advisory ID.
# Case 2 never reaches the point of reporting an ID — cargo-audit dies
# inside `Database::load`, before it has parsed a single Cargo.lock
# dependency against anything. There is nothing to ignore. So this script
# does not add a bypass; it makes the two cases tell themselves apart, in
# the exit code AND in the text a human reads, so a database-load failure
# can never again be read as "you have a vulnerable dependency".
#
# The classification is on the TOOL'S OWN error text ("error loading
# advisory database: ...", verified live against a real cargo-audit
# invocation against a locally-reproduced directory/package mismatch — see
# the PR that introduced this script), not a guess at
# what upstream might do next. `cargo-audit` 0.22.1 emits that exact prefix
# for every reason `Database::load` can fail (git operation, TOML parse,
# lockfile format) — the messages after the colon vary, the prefix does
# not.
#
# Deliberately still BLOCKING on case 2 (fail closed): a real vulnerability
# behind a broken database is invisible for as long as the database stays
# broken, and this repo has no way to tell "broken" from "an attacker broke
# it" from inside a CI job. What changes is that the failure now SAYS which
# case it is, with a distinct exit code a caller can act on, instead of
# reading as an accusation against this repo's own dependency tree.
#
# ─── Which way this fails ──────────────────────────────────────────────────
#
# The classification is a POSITIVE match: only output carrying that prefix
# becomes exit 2. Everything else — a reworded upstream error, a network
# timeout, a corrupt lockfile, cargo itself missing, a crate directory that
# does not exist — falls through to exit 1, blocking, with cargo's own text.
# That is the deliberate direction: a misclassification can only ever turn a
# database problem into an over-loud "check your dependencies", never turn a
# real advisory into a silent pass. Measured on all four of those inputs;
# each returns 1 and prints what the tool said. Do NOT "improve" this by
# widening the match to catch more infrastructure cases, and never make an
# UNMATCHED failure exit 2 — that inverts the direction.
#
# The way this guard is most likely to rot is cargo-audit changing its own
# wording, at which point a real database-load failure stops matching and
# starts reading as exit 1 — the pre-#3688 behaviour, restored silently. The
# mitigation is the fail direction above: rot degrades to the old, blocking
# behaviour rather than to a pass. The real-tool reproduction was done by
# hand while writing this and is recorded in the PR body, not re-run in CI.
#
# ─── Contract ───────────────────────────────────────────────────────────────
#   exit 0 — cargo audit ran clean.
#   exit 1 — cargo audit ran and reported something about OUR dependencies
#            (a real advisory), OR failed in any way this script does not
#            recognise. Unchanged behaviour — the output is cargo-audit's
#            own, verbatim.
#   exit 2 — the advisory DATABASE failed to load. Says nothing about our
#            dependencies. A banner names the cause, the two known remedies
#            (wait for upstream; or, if the machine's local cache is
#            stale — #3688's second finding, `cargo deny`'s hard-reset
#            fetch never removes an untracked leftover after an advisory
#            relocates — `git -C <db-path> clean -fdx`), and the upstream
#            repo. Written to $GITHUB_STEP_SUMMARY too, when set, so it is
#            visible without opening the raw log.
#
# Usage:
#   scripts/cargo-audit-guard.sh [crate-dir] [-- cargo-audit-args...]
#
# crate-dir defaults to `.`; the CI step passes `src-tauri`.

set -uo pipefail

# The fingerprint. This is cargo-audit's OWN prefix (rustsec crate's
# `Error::LoadDb` Display impl), not a phrase this repo invented — matched
# against a live reproduction, not assumed. See the PR body for the exact
# captured text.
DB_LOAD_ERROR_RE='error loading advisory database'

print_db_load_banner() {
  local dir="$1"
  cat <<BANNER

################################################################################
# #3688: the RustSec advisory DATABASE failed to load.
#
# This is NOT a statement about our dependencies — cargo-audit died before
# it read a single line of Cargo.lock. Two known causes:
#
#   1. An upstream advisory is malformed (directory/package mismatch, bad
#      TOML, ...) and the fix is already in flight at
#      https://github.com/rustsec/advisory-db — this clears on its own once
#      that lands and the local cache next fetches clean.
#
#   2. The LOCAL cache is stale and will not self-heal: cargo-deny's
#      hard-reset fetch updates tracked files but never removes an
#      untracked leftover, so a relocated advisory can live in two crate
#      directories on disk long after upstream is clean. If this keeps
#      failing on an up-to-date checkout, run:
#          git -C ~/.cargo/advisory-db clean -fdx
#          git -C ~/.cargo/advisory-dbs/* clean -fdx   # cargo-deny's cache
#
# The waiver documented for a real advisory
# (src-tauri/.cargo/audit.toml [advisories].ignore) CANNOT help here: no
# advisory ID was ever reported to ignore. Re-running is the only lever for
# cause 1; the git-clean above is the only lever for cause 2.
#
# Working directory audited: ${dir}
################################################################################
BANNER
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo '### :warning: cargo audit: advisory database failed to load (#3688)'
      echo
      echo 'This is **not** a vulnerable dependency — the check never got that far.'
      echo 'See the job log for the two known causes and remedies.'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Runs `cargo audit` in `$dir`, classifies the result, prints accordingly.
run_guard() {
  local dir="${1:-.}"
  shift || true
  # Without this, a bad path made the subshell fail on `cd` with an EMPTY
  # `$out`, which matches nothing and so exits 1 — blocking, which is the
  # right direction, but reading as "you have a vulnerable dependency" with
  # no output at all to contradict it.
  if [ ! -d "$dir" ]; then
    echo "cargo-audit-guard: '$dir' is not a directory — cargo audit was never run." >&2
    echo "  This is a call-site error, NOT a finding about our dependencies." >&2
    return 1
  fi
  local out rc capfile
  capfile=$(mktemp -t cargo-audit-guard.XXXXXX) || {
    echo "cargo-audit-guard: mktemp failed — cannot run cargo audit" >&2
    return 1
  }
  # Stream AND capture. `out=$(cargo audit ... 2>&1)` buffers the entire run
  # and only prints once the whole thing exits — a slow audit (network fetch
  # of the advisory database) shows NOTHING in the log until it finishes,
  # and the classifier still needs the full text afterward to grep for
  # DB_LOAD_ERROR_RE. `tee` gets both: it writes each line to the real
  # stdout as it arrives AND to $capfile, which is read back once the
  # pipeline finishes for the classification below.
  #
  # `${PIPESTATUS[0]}` — not `$?` — is `cargo audit`'s own exit code: `$?`
  # after a pipeline is `tee`'s exit status (always 0 here), not the left
  # side's, UNLESS `pipefail` is set, in which case `$?` already picks the
  # rightmost non-zero — this script sets `-o pipefail` at the top, so `$?`
  # would in fact also be correct here. PIPESTATUS is used anyway so this
  # line stays correct independent of that option ever changing, and so it
  # is unambiguous under whatever shell mode a future caller runs this
  # under (e.g. GitHub Actions' default `bash -e -o pipefail`, which this
  # script itself does not need but a caller sourcing it might).
  (cd "$dir" && cargo audit "$@") 2>&1 | tee "$capfile"
  rc=${PIPESTATUS[0]}
  out=$(cat "$capfile")
  rm -f "$capfile"
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if printf '%s' "$out" | grep -q "$DB_LOAD_ERROR_RE"; then
    print_db_load_banner "$dir"
    return 2
  fi
  return 1
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

main() {
  local dir="."
  if [ $# -gt 0 ] && [ "$1" != "--" ]; then
    dir="$1"
    shift
  fi
  [ "${1:-}" = "--" ] && shift
  run_guard "$dir" "$@"
}

main "$@"
