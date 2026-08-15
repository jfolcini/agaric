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
# this script's --self-test and the PR that introduced it), not a guess at
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
# ─── Which way this fails, and the limit of its self-test ──────────────────
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
# The self-test drives a STUB `cargo` (see below). It therefore cannot
# detect the one way this guard is most likely to rot: cargo-audit changing
# its own wording, at which point a real database-load failure stops
# matching and starts reading as exit 1 — the pre-#3688 behaviour, restored
# silently, with the self-test still green. That limit is inherent to
# testing offline against captured text; the mitigation is the fail
# direction above (rot degrades to the old, blocking behaviour rather than
# to a pass) plus the assertion below that pins the exact fingerprint, so
# the classifier and its test cannot drift apart without someone editing
# both. The real-tool reproduction was done by hand while writing this and
# is recorded in the PR body, not re-run in CI.
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
#   scripts/cargo-audit-guard.sh --self-test
#
# crate-dir defaults to `.`; the CI step passes `src-tauri`.

set -uo pipefail

# The fingerprint. This is cargo-audit's OWN prefix (rustsec crate's
# `Error::LoadDb` Display impl), not a phrase this repo invented — matched
# against a live reproduction, not assumed. See --self-test and the PR body
# for the exact captured text.
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
# Exported as a function (rather than only inline in `main`) so the
# self-test can point it at a stub `cargo` on PATH without touching the
# real network or the real advisory database.
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
  local out rc
  out=$(cd "$dir" && cargo audit "$@" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q "$DB_LOAD_ERROR_RE"; then
    print_db_load_banner "$dir"
    return 2
  fi
  return 1
}

# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------
#
# Offline and deterministic: a stub `cargo` on PATH stands in for the real
# binary. The canned text is not invented —
# it is the text captured from a REAL `cargo audit` run against (a) a
# locally-reproduced directory/package mismatch built the same way RustSec
# commit e11d6b33 broke it, using real advisory-db fixture files, and (b) a
# real RUSTSEC-2026-0194 (quick-xml) report against this repo's own
# Cargo.lock with that one advisory un-ignored. Both captured while writing
# this script; see the PR body for the exact commands.

SELFTEST_FAILURES=0
st_ok() { printf '  ok   - %s\n' "$1"; }
st_fail() {
  SELFTEST_FAILURES=$((SELFTEST_FAILURES + 1))
  printf '  FAIL - %s: %s\n' "$1" "$2" >&2
}
st_expect() {
  if [ "$2" = "$3" ]; then st_ok "$1"; else st_fail "$1" "expected [$2], got [$3]"; fi
}
# Presence check, immune to how many TIMES a phrase occurs — the fixed-line
# `grep -c` counting this file used at first broke the moment a phrase
# legitimately appeared on more than one line (the two-remedy banner line).
st_contains() {
  if printf '%s' "$3" | grep -q -- "$2"; then st_ok "$1"; else st_fail "$1" "'$2' not found in output"; fi
}
st_not_contains() {
  if printf '%s' "$3" | grep -q -- "$2"; then st_fail "$1" "'$2' unexpectedly found in output"; else st_ok "$1"; fi
}

# The exact stderr text captured from a real `cargo audit --db <fixture>`
# run against an advisory whose directory doesn't match its `package`
# field — the live reproduction of RustSec commit e11d6b33.
STUB_DB_LOAD_TEXT='error: error loading advisory database: git operation failed: expected RUSTSEC-2026-9999 to be in gettext-sys directory (instead of ""/tmp/adb-malformed/crates/gettext-rs"")'

# The exact stderr text captured from a real `cargo audit` run with
# RUSTSEC-2026-0194 (quick-xml, a genuine advisory, not "unmaintained")
# un-ignored against this repo's own Cargo.lock.
STUB_VULN_TEXT='Crate:     quick-xml
Version:   0.37.5
Title:     Quadratic run time when checking a start tag for duplicate attribute names
ID:        RUSTSEC-2026-0194
Severity:  7.5 (high)
error: 4 vulnerabilities found!'

# bindir gets its own `cargo` shim on PATH; text/exitcode are what `cargo
# audit` prints/returns for that shim.
st_make_stub_cargo() {
  local bindir="$1" text="$2" exitcode="$3"
  mkdir -p "$bindir"
  cat > "$bindir/cargo" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "audit" ]; then
  cat >&2 <<'TXT'
$text
TXT
  exit $exitcode
fi
echo "stub cargo: unsupported subcommand \$1" >&2
exit 99
STUB
  chmod +x "$bindir/cargo"
}

run_self_test() {
  local tmp
  tmp=$(mktemp -d -t cargo-audit-guard-selftest.XXXXXX)
  # EXIT, not RETURN: this function exits 2 on failure, and an `exit` does
  # not fire a RETURN trap — so the failing run, the one someone will be
  # re-running, was the one that leaked its temp dir.
  # shellcheck disable=SC2064 # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # ── 1. A DATABASE-LOAD FAILURE is classified as exit 2, with the banner ──
  local dbfail_bin="$tmp/bin-dbfail"
  st_make_stub_cargo "$dbfail_bin" "$STUB_DB_LOAD_TEXT" 1
  local out rc
  out=$(PATH="$dbfail_bin:$PATH" run_guard "$tmp" 2>&1)
  rc=$?
  st_expect 'a database-load failure exits 2, not 1' '2' "$rc"
  st_contains 'the banner explicitly says this is NOT a vulnerable dependency' \
    'NOT a statement about our dependencies' "$out"
  st_contains 'the banner names the waiver mechanism and says it cannot help' \
    'CANNOT help here' "$out"
  st_contains 'the banner names the upstream-fix remedy' 'already in flight' "$out"
  st_contains "the banner names the local-cache remedy (git clean -fdx)" 'clean -fdx' "$out"
  st_contains "cargo-audit's own original output is still present verbatim (nothing hidden)" \
    'RUSTSEC-2026-9999' "$out"

  # ── 2. A REAL VULNERABILITY is classified as exit 1 — UNCHANGED, no banner ─
  local vuln_bin="$tmp/bin-vuln"
  st_make_stub_cargo "$vuln_bin" "$STUB_VULN_TEXT" 1
  out=$(PATH="$vuln_bin:$PATH" run_guard "$tmp" 2>&1)
  rc=$?
  st_expect 'a real vulnerability report exits 1 (unchanged, ordinary gate failure)' '1' "$rc"
  st_not_contains 'and does NOT get the database-load banner (the two cases must not look alike)' \
    'NOT a statement about our dependencies' "$out"
  st_contains "cargo-audit's own vulnerability report reaches the caller unmodified" \
    'RUSTSEC-2026-0194' "$out"

  # ── 3. THE CLEAN CASE is exit 0 with no banner ────────────────────────────
  local ok_bin="$tmp/bin-ok"
  st_make_stub_cargo "$ok_bin" 'Loaded 1207 security advisories
Scanning Cargo.lock for vulnerabilities (962 crate dependencies)' 0
  out=$(PATH="$ok_bin:$PATH" run_guard "$tmp" 2>&1)
  rc=$?
  st_expect 'a clean audit exits 0' '0' "$rc"
  st_not_contains 'and carries no banner' 'NOT a statement about our dependencies' "$out"

  # ── 4. AN UNRECOGNISED FAILURE FALLS THROUGH TO 1, NEVER TO 2 ────────────
  # This is the direction question, pinned. Assertions 1 and 2 already fix
  # the two known shapes at 2 and 1 — an extra "the two codes differ" check
  # could only ever redden when one of those already had, so it was
  # decoration. What is NOT implied by them, and is the way this guard
  # actually rots, is what happens to a failure matching NEITHER pattern:
  # upstream rewording its own error, a network timeout, cargo missing. All
  # must land on 1 (blocking, "we could not clear this tree"), because 2 is
  # the code a caller is allowed to treat as "not about our dependencies".
  # Widening the match until an unknown failure exits 2 is the change that
  # would let a genuine advisory pass unnoticed, and it reddens here.
  local reworded_bin="$tmp/bin-reworded"
  st_make_stub_cargo "$reworded_bin" \
    'error: failed to load the advisory database: git operation failed' 1
  out=$(PATH="$reworded_bin:$PATH" run_guard "$tmp" 2>&1)
  rc=$?
  st_expect 'an unrecognised failure (upstream reworded its own error) exits 1, not 2' '1' "$rc"
  st_not_contains 'and gets no database-load banner it has not earned' \
    'NOT a statement about our dependencies' "$out"
  st_contains "and the tool's own text still reaches the caller" \
    'failed to load the advisory database' "$out"

  # A PATH carrying everything EXCEPT cargo — the script's own helpers must
  # still resolve, or this would pass for the wrong reason.
  local nocargo="$tmp/bin-nocargo" p f b
  mkdir -p "$nocargo"
  for p in /usr/bin /bin /usr/local/bin; do
    [ -d "$p" ] || continue
    for f in "$p"/*; do
      b=$(basename "$f")
      [ "$b" = cargo ] || ln -sf "$f" "$nocargo/$b" 2>/dev/null || true
    done
  done
  rc=$(PATH="$nocargo" run_guard "$tmp" >/dev/null 2>&1; echo $?)
  st_expect 'cargo missing from PATH entirely also exits 1 (blocking), never 0 or 2' '1' "$rc"

  # And the fingerprint the classifier keys on is the tool's real prefix, not
  # a paraphrase — the two must be edited together or this reddens.
  st_contains 'the classifier keys on the exact prefix the captured real output carries' \
    "$DB_LOAD_ERROR_RE" "$STUB_DB_LOAD_TEXT"

  # ── 5. GITHUB_STEP_SUMMARY gets the same distinction, when set ───────────
  local summary="$tmp/summary.md"
  : > "$summary"
  GITHUB_STEP_SUMMARY="$summary" PATH="$dbfail_bin:$PATH" run_guard "$tmp" >/dev/null 2>&1
  st_expect 'a database-load failure is also flagged in GITHUB_STEP_SUMMARY' \
    '1' "$(grep -c 'advisory database failed to load' "$summary" || true)"
  : > "$summary"
  GITHUB_STEP_SUMMARY="$summary" PATH="$vuln_bin:$PATH" run_guard "$tmp" >/dev/null 2>&1
  st_expect 'a real vulnerability does NOT write to GITHUB_STEP_SUMMARY (unchanged CI behaviour)' \
    '0' "$(wc -l < "$summary" | tr -d ' ')"

  # ── 6. THE INVOCATION, not only the function ─────────────────────────────
  # Everything above calls `run_guard` directly. The only caller that exists
  # in production is a `run:` line in `.github/workflows/_validate.yml`, and
  # it goes through `main`'s argument parsing, which nothing here had
  # exercised — the guard body tested while its call site was not.
  local cli_rc
  cli_rc=$(PATH="$dbfail_bin:$PATH" bash "$SELF" "$tmp" >/dev/null 2>&1; echo $?)
  st_expect 'invoked as the workflow invokes it (script + crate-dir arg), a db-load failure is still 2' \
    '2' "$cli_rc"
  cli_rc=$(PATH="$vuln_bin:$PATH" bash "$SELF" "$tmp" >/dev/null 2>&1; echo $?)
  st_expect 'and a real advisory is still 1 through the same entry point' '1' "$cli_rc"
  cli_rc=$(PATH="$ok_bin:$PATH" bash "$SELF" "$tmp" -- --no-fetch >/dev/null 2>&1; echo $?)
  st_expect 'the `-- <cargo-audit-args>` form parses and still reports the clean run' '0' "$cli_rc"

  # And the path that `run:` line actually names resolves. `working-directory:
  # src-tauri` plus `bash ../scripts/cargo-audit-guard.sh .` is two facts that
  # have to agree with the filesystem, and neither is checked by anything else.
  local vwf="$REPO_ROOT/.github/workflows/_validate.yml"
  st_expect 'the workflow step still runs this guard instead of bare `cargo audit`' '1' \
    "$(grep -c '^ *run: bash \.\./scripts/cargo-audit-guard\.sh \.$' "$vwf" || true)"
  st_expect "the relative path that step uses resolves to this script" '1' \
    "$(test -f "$REPO_ROOT/src-tauri/../scripts/cargo-audit-guard.sh" && echo 1 || echo 0)"

  if [ "$SELFTEST_FAILURES" -gt 0 ]; then
    printf '\nself-test: %s assertion(s) failed\n' "$SELFTEST_FAILURES" >&2
    exit 2
  fi
  printf 'self-test: all assertions passed\n'
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

main() {
  local dir="."
  if [ $# -gt 0 ] && [ "$1" != "--" ]; then
    dir="$1"
    shift
  fi
  [ "${1:-}" = "--" ] && shift
  run_guard "$dir" "$@"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
else
  main "$@"
fi
