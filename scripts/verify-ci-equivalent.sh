#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Pre-push verifier.
#
# Wired via `prek.toml` as the `verify-ci-equivalent` pre-push hook (the
# hook ID is kept for stability — actual scope is narrower than CI now).
#
# Strategy (re-scoped from full CI mirror to fast-feedback):
#
#   Phase A — `prek run --all-files --hook-stage pre-commit`
#             Runs every pre-commit hook against the WHOLE tree, not just
#             staged files. Catches the "latent breach in an untouched
# File" class ('s `useAppKeyboardShortcuts`
#             cognitive-complexity drift that the staged-only pre-commit
#             missed). Tests are skipped here because the prek vitest /
#             cargo-test hooks read `--cached` and there's nothing staged
#             at push time — the SKIP= env var below silences their
#             "no staged files" log noise.
#
#   Phase B/C/D — vitest + cargo nextest scoped to the **commit range**
#                 being pushed (`@{upstream}..HEAD`, override with
#                 `PRE_PUSH_RANGE`). Uses `scripts/test-related-{ts,rust}.sh
#                 --range REVSPEC` (same scripts the pre-commit hooks use,
#                 just with a different diff source).
#
#   Phase E — `cargo sqlx prepare --check` if any .rs changed in range,
#             against all four committed `.sqlx/` caches (workspace root +
#             `agaric-store`/`agaric-engine`/`agaric-sync`) — mirrors every
#             `sqlx-offline-check` lane in `_validate.yml`.
#
#   Phase F — `agaric-mcp` release build + MCP UDS smoke + externalBin
#             host-triple verify. **Only when MCP paths change**
#             (`src-tauri/src/mcp/`, `src-tauri/src/commands/mcp.rs`,
#             `src-tauri/src/bin/agaric-mcp.rs`, `src-tauri/binaries/`).
#             Skipped for unrelated pushes — the release build is the
#             slowest non-test step and most pushes don't touch MCP.
#
#   Phase G — warn-only `cargo audit` + `npm audit signatures`.
#
# Explicitly NOT here (vs the prior CI-equivalent verifier):
#
#   * **Playwright e2e.** CI still runs the full suite on every PR — local
#     skip trades a delayed safety signal for a much faster push (Playwright
#     dominated the prior pre-push wall clock). If you've touched anything
#     interaction-heavy, run `npx playwright test` manually before pushing.
#   * **Full `vitest run` / `cargo nextest run --workspace --profile ci`.** Scoped to
#     the push range above; CI still runs the full suites.
#   * **Desktop bundle build / cross-OS / SLSA attestations.** Same as
#     before — run `scripts/verify-release-build.sh` manually for the
#     bundle pre-flight.
#
# Skip override (CI-R16): set `SKIP_CI_VERIFY` to a short, descriptive
# REASON to short-circuit the hook, e.g.
#   SKIP_CI_VERIFY='docs typo, no source change' git push
# A bare truthy flag (`SKIP_CI_VERIFY=1`) is REJECTED — the escape hatch
# exists for genuine one-offs, and forcing a reason keeps it from quietly
# becoming the default push path. Range override:
# `PRE_PUSH_RANGE=origin/main...HEAD git push` for branches without a
# tracking upstream (three dots — see the range block below).
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

# ── sqlx probe-DB allocation (#3257) ───────────────────────────────
# Phase E needs a throwaway SQLite database per crate to run
# `cargo sqlx prepare --check` against. These used to live at a
# MACHINE-GLOBAL fixed path (`${TMPDIR:-/tmp}/$crate-sqlx-prepare.db`)
# even though every sibling log file on the adjacent lines already used
# `mktemp`. Two concurrent pushes from different worktrees — this
# project's standard parallel-batch workflow, which
# `scripts/seed-worktree.sh` exists to support — would therefore `rm -f`
# each other's probe database: worktree B's `rm -f` lands while worktree
# A is mid-`prepare --check`, A's queries stop resolving against the now
# empty file, and A reports `✗ sqlx prepare check failed` with advice
# steering the developer at the checked-in `.sqlx/` caches to chase a
# phantom failure.
#
# Allocate a fresh DIRECTORY per invocation instead and remove it
# wholesale, so SQLite's `-wal` / `-shm` siblings go with it rather than
# being left behind (the old `rm -f "$db"` cleanup leaked both).
# Defined up here so `--self-test` below can drive them directly.
sqlx_probe_dir_new() {
    mktemp -d -t pre-push-sqlx.XXXXXX
}

sqlx_probe_dir_cleanup() {
    [ -n "${1:-}" ] && rm -rf "$1"
    return 0
}

# ── Node dependency preflight (#3656) ──────────────────────────────
# A `git worktree add` checkout has no `node_modules` — it is not a
# tracked path, and the convention here is to symlink it from the main
# checkout (scripts/seed-worktree.sh, step 1). Forget that, and Phase A
# does not say so: `npx oxlint`, `npx oxfmt`, `npx tsc` and the
# node-based guard scripts each fail on their own terms, producing five
# unrelated red hooks — two of them *guard self-tests*, which reads as
# "your change broke a guard" — and not one line of the output contains
# the string `node_modules`. The failure is real; its ATTRIBUTION is
# wrong, and wrong attribution is what costs the hour (the natural next
# move is to bisect the branch's content).
#
# So: name the cause before any hook runs. Returns 1 and echoes a
# one-line diagnosis when the node-based hooks cannot possibly work;
# returns 0 silently otherwise. Takes the root as an argument so the
# self-test below can drive it against fixture directories.
node_deps_problem() {
    local root="${1:-}" nm
    nm="$root/node_modules"

    if [ -L "$nm" ] && [ ! -e "$nm" ]; then
        printf 'node_modules is a DANGLING symlink: %s -> %s\n' \
            "$nm" "$(readlink "$nm" 2>/dev/null || echo '?')"
        return 1
    fi
    if [ ! -d "$nm" ]; then
        printf 'node_modules is MISSING: %s\n' "$nm"
        return 1
    fi
    if [ ! -d "$nm/.bin" ]; then
        printf 'node_modules exists but has no .bin/ (dependencies not installed): %s\n' "$nm"
        return 1
    fi
    return 0
}

# Remedy text for the failure above, tailored to where you are: a linked
# worktree (`--git-dir` != `--git-common-dir`) wants the symlink that
# seed-worktree.sh creates; the main checkout wants an `npm ci`.
node_deps_remedy() {
    local root="${1:-}" git_dir common_dir main_root
    git_dir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null || echo '')"
    common_dir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo '')"
    if [ -n "$git_dir" ] && [ -n "$common_dir" ] && [ "$git_dir" != "$common_dir" ]; then
        main_root="$(cd "$common_dir/.." 2>/dev/null && pwd || echo '<main-checkout>')"
        printf 'This is a LINKED WORKTREE. Seed it (idempotent, also fixes the\n'
        printf '  upstream and dev.db prerequisites):\n'
        printf '    bash scripts/seed-worktree.sh\n'
        printf '  or, node_modules alone:\n'
        printf '    ln -s %s/node_modules %s/node_modules\n' "$main_root" "$root"
        printf '  (create the symlink BEFORE anything runs tsc/npm here — once a\n'
        printf '  REAL node_modules directory exists, `ln -s` nests inside it.)\n'
    else
        printf 'Install dependencies in this checkout:\n'
        printf '    npm ci\n'
    fi
}

# ── dev.db migration gap check (#4266) ─────────────────────────────
# `scripts/seed-worktree.sh` migrates a fresh `dev.db` when a worktree is
# born (via `scripts/setup-dev-db.sh`) — deliberately, since copying a
# snapshot `dev.db` from the main checkout goes stale as soon as the
# next migration merges. The MAIN checkout is never re-seeded, so ITS
# `dev.db` drifts a little further behind with every migration that
# lands, until a push from it hits Phase D/D2's online `sqlx::query!`
# macros compiling against a schema missing a table/column they expect —
# surfacing as e.g. `no such table: block_links_unresolved` from a crate
# the diff never touched (observed live, #4266).
#
# Detect it HERE, before any phase that actually runs cargo against
# dev.db, comparing the SET of applied `_sqlx_migrations` versions
# against the SET of `.sql` files on disk (not just the max of each) so
# a gap in the middle — not only a missing tail — is caught too.
#
# Option 1 from the issue: detect and instruct, not option 2's
# auto-migrate-behind-the-developer's-back — this gate is otherwise
# read-only, and a check that mutates local state during it is a
# surprise. The sqlite read goes through `python3`'s stdlib sqlite3
# module (already a build dependency for the `check-*.py` prek hooks) in
# read-only URI mode, so this function never creates, migrates, or
# otherwise writes dev.db itself.
#
# Pure: takes the two directories as arguments (no implicit `cd`, no
# global state) so the self-test below can drive it against fixture
# trees instead of this repo's own dev.db. Prints a diagnosis + the
# exact remedy command on stdout; prints nothing on stdout when it is
# caught up. Returns 0 when dev.db is caught up with migrations/, 1 when
# it is confirmed missing/never-migrated/behind (the caller should hard
# block), 2 when it could not be inspected at all — e.g. python3 is
# missing, or a permission/OS error reading .env or dev.db (the caller
# should warn and continue: a guard that cannot inspect the database is
# not evidence the database is behind).
devdb_migration_gap() {
    local src_tauri="$1" migrations_dir="$2"
    local out rc
    # stderr folded into the capture: a missing python3 (exit 127) or an
    # interpreter-level failure that never reaches the try/except below
    # would otherwise print to the terminal while $out stays empty — a
    # hard block with a headline and a blank body.
    out="$(python3 - "$src_tauri" "$migrations_dir" 2>&1 <<'PYEOF'
import os
import re
import sqlite3
import sys

def main():
    src_tauri, migrations_dir = sys.argv[1], sys.argv[2]

    # Resolve DATABASE_URL the way sqlx-cli does: an exported DATABASE_URL wins
    # over `.env` (dotenvy never overrides an already-set var), and within
    # `.env`, dotenvy keeps the FIRST "DATABASE_URL=" line, not the last.
    # Default to "dev.db" (sqlx-cli's own default) when neither is set.
    def resolve_sqlite_path(url):
        # Mirrors the `url` crate parse that sqlx's SqliteConnectOptions::from_str
        # relies on: for a non-special scheme, "sqlite://host/path" folds `host`
        # into the filename (so "sqlite://dev.db" -> "dev.db", NOT the bogus
        # absolute "//dev.db" a naive strip-and-isabs check would produce),
        # "sqlite:///abs/path" is the true absolute form (empty host), and a bare
        # "sqlite:relative.db" has no host at all. A trailing "?...querystring"
        # (e.g. "?mode=rwc") is never part of the path.
        rest = url[len("sqlite:"):]
        q = rest.find("?")
        if q != -1:
            rest = rest[:q]
        if rest.startswith("//"):
            rest = rest[2:]
            slash = rest.find("/")
            host, path = (rest, "") if slash == -1 else (rest[:slash], rest[slash:])
            return host + path
        return rest

    db_rel = "dev.db"
    val = os.environ.get("DATABASE_URL")
    if not val:
        env_file = os.path.join(src_tauri, ".env")
        if os.path.isfile(env_file):
            with open(env_file, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DATABASE_URL="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break  # dotenvy keeps the FIRST match, not the last
    if val and val.startswith("sqlite:"):
        db_rel = resolve_sqlite_path(val)
    db_file = db_rel if os.path.isabs(db_rel) else os.path.join(src_tauri, db_rel)

    # Printed as two lines rather than one "cd src-tauri && cargo sqlx migrate
    # run" string: the self-test's #3361 root-lane ratchet greps THIS FILE for
    # "cd src-tauri" followed within 40 chars by "cargo sqlx (migrate run|
    # prepare)" to catch a real Phase E invocation that forgot the DATABASE_URL
    # override — a message string with the same two substrings on one line
    # would be indistinguishable from that to a plain grep.
    def print_remedy():
        print("    cd src-tauri")
        print("    cargo sqlx migrate run")

    if not os.path.isfile(db_file):
        print("dev.db does not exist: %s" % db_file)
        print("  Provision it (idempotent):")
        print("    bash scripts/setup-dev-db.sh")
        print("  or apply migrations directly:")
        print_remedy()
        sys.exit(1)

    expected = {}
    pat = re.compile(r"^(\d+)_.+\.sql$")
    if os.path.isdir(migrations_dir):
        for fn in sorted(os.listdir(migrations_dir)):
            m = pat.match(fn)
            if m:
                expected[int(m.group(1))] = fn

    try:
        con = sqlite3.connect("file:%s?mode=ro" % db_file, uri=True)
        cur = con.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'"
        )
        if cur.fetchone() is None:
            print("dev.db exists but has never been migrated (no _sqlx_migrations table): %s" % db_file)
            print("  Apply all migrations:")
            print_remedy()
            sys.exit(1)
        cur.execute("SELECT version FROM _sqlx_migrations")
        applied = {row[0] for row in cur.fetchall()}
    except sqlite3.Error as e:
        print("could not inspect dev.db (%s): %s" % (db_file, e))
        sys.exit(2)

    pending = sorted(v for v in expected if v not in applied)
    if pending:
        print("dev.db is behind src-tauri/migrations/ — pending migration(s):")
        for v in pending:
            print("    %s" % expected[v])
        print("  Apply them:")
        print_remedy()
        sys.exit(1)

    sys.exit(0)

# sys.exit(0/1) calls inside main() raise SystemExit, which does NOT
# subclass Exception — they propagate through this handler untouched.
# Only a genuine failure-to-inspect (PermissionError opening .env,
# OSError from listdir, an unexpected sqlite3/other error) lands here:
# say so plainly and exit 2 — distinct from exit 1's confirmed gap — so
# the caller can WARN instead of hard-blocking a push nothing is wrong
# with.
if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("could not inspect dev.db: %s: %s" % (type(e).__name__, e))
        sys.exit(2)
PYEOF
)"
    rc=$?
    if [ "$rc" -eq 127 ]; then
        # `python3` itself is missing — bash's own "command not found" is
        # already folded into $out via the 2>&1 above.
        printf 'could not inspect dev.db: python3 not found on PATH: %s\n' "$out"
        return 2
    fi
    printf '%s' "$out"
    return "$rc"
}

# ── caller-supplied SKIP (#3968) ───────────────────────────────────
# Phase A runs prek with a SKIP list this script computes from the
# changed-file categories. It used to build that list and then run
#
#     SKIP="$PHASE_A_SKIP" prek run …
#
# which OVERWRITES whatever `SKIP` the caller exported. `SKIP=<hook>` is
# prek's own documented bypass, and it reaches this script by ordinary
# environment inheritance (`SKIP=cargo-deny git push` → prek's pre-push
# stage → this script), so a developer using it got: the hook running
# anyway, no mention of their request anywhere in the output, and — the
# part that makes it worse than a no-op — a SUCCESS report. If the hook
# then passed they concluded the bypass works; if it failed they
# concluded the bypass is broken *for that hook*. Either way their model
# of the gate diverged from the gate.
#
# Semantics chosen: UNION, announced. Not refusal.
#
#   * Refusing (exit non-zero when a caller SKIP would be discarded)
#     would turn a working prek idiom into a hard push failure, and the
#     value arrives here by INHERITANCE — the caller aimed it at prek,
#     not at this script, so a refusal punishes a reasonable action.
#   * Union honours the request, which is the only reading under which
#     the developer's mental model and the gate agree.
#
# But this script exists to approximate CI, and a caller skip makes the
# run inequivalent BY CONSTRUCTION. So the union is announced when it
# actually removes something, and repeated in the final PASS banner: a
# green from a run with caller skips must not be quotable as a clean
# gate. Silently discarding the instruction is the one option ruled out.
#
# Both helpers take (required, caller) as comma-separated strings,
# tolerate empty/whitespace/duplicate entries, and are pure — the
# self-test below drives them directly.
#
# NEWLINES SEPARATE TOO (#3990 item 5). `IFS=',' read -ra` reads ONE LINE:
# a `SKIP` carrying a newline — `SKIP=$'gitleaks\ntypos'`, or a value that
# picked one up from a shell heredoc or an editor — silently lost everything
# after the first, including from the non-equivalence warning, so the run was
# reported as omitting fewer hooks than it did. That is the silent-discard
# shape #3968 exists to have removed. `read -r -d ''` consumes the whole
# value (returning non-zero at EOF, hence `|| true`) and `IFS=$',\n'` makes
# the newline a separator, so every entry the caller wrote is honoured, named
# in the warning, and handed to prek in the comma-separated form prek reads.
# Newline is IFS WHITESPACE, so a trailing one collapses rather than adding an
# empty entry; the comma is not, so `a,,b` still yields the empty field the
# trim/skip below is written for.

# Union of the script's own required entries and the caller's, in that
# order, de-duplicated. The required entries always survive: they are the
# hooks Phase A cannot run meaningfully (the `--cached` test hooks) plus
# the category-absent list, and a caller cannot un-skip them by omission.
phase_a_skip_compose() {
    local required="${1:-}" caller="${2:-}"
    local -a items=()
    local item seen="," out=""
    IFS=$',\n' read -r -d '' -a items <<< "$required,$caller" || true
    for item in "${items[@]}"; do
        item="${item#"${item%%[![:space:]]*}"}"
        item="${item%"${item##*[![:space:]]}"}"
        [ -z "$item" ] && continue
        case "$seen" in *",$item,"*) continue ;; esac
        seen="$seen$item,"
        out="${out:+$out,}$item"
    done
    printf '%s' "$out"
}

# The caller's entries that are NOT already in the required set — i.e.
# exactly the hooks the caller's SKIP actually removes from this run.
# This, not the raw `SKIP`, is what the non-equivalence warning reports:
# a caller who redundantly re-skips `vitest` has changed nothing, and
# warning about it would train the reader to ignore the warning.
phase_a_skip_extra() {
    local required="${1:-}" caller="${2:-}"
    local -a req=() cal=()
    local item reqset="," seen="," out=""
    IFS=$',\n' read -r -d '' -a req <<< "$required" || true
    for item in "${req[@]}"; do
        item="${item#"${item%%[![:space:]]*}"}"
        item="${item%"${item##*[![:space:]]}"}"
        [ -z "$item" ] && continue
        reqset="$reqset$item,"
    done
    IFS=$',\n' read -r -d '' -a cal <<< "$caller" || true
    for item in "${cal[@]}"; do
        item="${item#"${item%%[![:space:]]*}"}"
        item="${item%"${item##*[![:space:]]}"}"
        [ -z "$item" ] && continue
        case "$reqset" in *",$item,"*) continue ;; esac
        case "$seen" in *",$item,"*) continue ;; esac
        seen="$seen$item,"
        out="${out:+$out,}$item"
    done
    printf '%s' "$out"
}

# ── self-test ──────────────────────────────────────────────────────
# Fixture suite for the probe-DB isolation above (#3257), wired as the
# `verify-ci-equivalent-selftest` prek hook so a regression back to a
# fixed /tmp path is caught at commit time rather than as a
# non-deterministic Phase E failure that blames sqlx. Runs BEFORE the
# bypass guard and the multi-minute verifier body, so it is fast and
# side-effect free.
if [ "${1:-}" = "--self-test" ]; then
    st_fail=0
    st_ok() { printf '  ok   - %s\n' "$1"; }
    st_bad() { printf '  FAIL - %s: %s\n' "$1" "$2" >&2; st_fail=1; }

    # 1. Two invocations (the two concurrent pushes) must not collide.
    d1="$(sqlx_probe_dir_new)"
    d2="$(sqlx_probe_dir_new)"
    if [ "$d1" != "$d2" ]; then
        st_ok "two invocations get distinct probe dirs"
    else
        st_bad "two invocations get distinct probe dirs" "both got $d1"
    fi

    # 2. Each is a real, private directory.
    if [ -d "$d1" ] && [ -d "$d2" ]; then
        st_ok "probe dirs are created as directories"
    else
        st_bad "probe dirs are created as directories" "d1=$d1 d2=$d2"
    fi

    # 3. Worktree B's cleanup must NOT touch worktree A's database — the
    #    literal cross-process collision this fix is about.
    : > "$d1/agaric-store.db"
    sqlx_probe_dir_cleanup "$d2"
    if [ -f "$d1/agaric-store.db" ]; then
        st_ok "one invocation's cleanup leaves the other's probe DB intact"
    else
        st_bad "one invocation's cleanup leaves the other's probe DB intact" \
            "$d1/agaric-store.db was deleted by cleanup of $d2"
    fi

    # 4. Cleanup takes the SQLite -wal / -shm siblings with it.
    : > "$d1/agaric-store.db-wal"
    : > "$d1/agaric-store.db-shm"
    sqlx_probe_dir_cleanup "$d1"
    if [ ! -e "$d1" ]; then
        st_ok "cleanup removes the probe dir including -wal/-shm siblings"
    else
        st_bad "cleanup removes the probe dir including -wal/-shm siblings" \
            "$(ls -A "$d1" 2>/dev/null | tr '\n' ' ')"
    fi

    # 5. Ratchet: the fixed machine-global path must not come back. Guards
    #    against a future edit quietly reintroducing the collision while
    #    the assertions above keep passing against dead helpers. Every
    #    `db=` assignment in this script must be the per-invocation form.
    if grep -nE '^[[:space:]]*db=' "${BASH_SOURCE[0]}" \
        | grep -vq 'db="\$probe_dir/\$crate\.db"'; then
        st_bad "every probe-DB assignment is the per-invocation form" \
            "$(grep -nE '^[[:space:]]*db=' "${BASH_SOURCE[0]}" \
                | grep -v 'db="\$probe_dir/\$crate\.db"' | tr '\n' ' ')"
    else
        st_ok "every probe-DB assignment is the per-invocation form"
    fi

    # 6. Ratchet: Phase E must actually USE the per-invocation dir. Anchored
    #    at line start so this cannot match the grep patterns and messages
    #    inside this self-test itself (an unanchored match would make the
    #    assertion tautological — a check that cannot fail).
    if grep -qE '^[[:space:]]*db="\$probe_dir/\$crate\.db"$' "${BASH_SOURCE[0]}"; then
        st_ok "Phase E allocates its probe DBs under the per-invocation dir"
    else
        st_bad "Phase E allocates its probe DBs under the per-invocation dir" \
            'no `db="$probe_dir/$crate.db"` assignment found'
    fi

    # 7. Ratchet (#3361): the root lane's OLD vulnerable form must not come
    #    back — root's sqlx subcommands run with NO DATABASE_URL override,
    #    which falls through to whatever `src-tauri/.env`'s DATABASE_URL
    #    points at, i.e. the developer's real dev.db, not an isolated probe
    #    DB. Excludes comment lines (incl. this one) so the assertion can't
    #    match its own description of the pattern it guards against.
    bad_root_lines="$(grep -vE '^[[:space:]]*#' "${BASH_SOURCE[0]}" \
        | grep -nE 'cd src-tauri.{0,40}cargo sqlx (migrate run|prepare)')"
    if [ -n "$bad_root_lines" ]; then
        st_bad "root sqlx lane never runs cargo sqlx without a DATABASE_URL override" \
            "$(printf '%s' "$bad_root_lines" | tr '\n' ' ')"
    else
        st_ok "root sqlx lane never runs cargo sqlx without a DATABASE_URL override"
    fi

    # 8. Ratchet (#3361): Phase E's root lane must actually allocate its
    #    probe DB under the per-invocation dir. Anchored at line start,
    #    exact form, so a `root_db=` pointing anywhere else fails this.
    if grep -qE '^[[:space:]]*root_db="\$probe_dir/root\.db"$' "${BASH_SOURCE[0]}"; then
        st_ok "Phase E allocates the root lane's probe DB under the per-invocation dir"
    else
        st_bad "Phase E allocates the root lane's probe DB under the per-invocation dir" \
            'no `root_db="$probe_dir/root.db"` assignment found'
    fi

    # 9. Ratchet (#3361): the root lane's `cargo sqlx migrate run` — the
    #    command that actually WRITES schema — must be prefixed with the
    #    per-invocation DATABASE_URL override. A partial fix that isolated
    #    `database create`/`prepare --check` but left `migrate run`
    #    pointed at the real DB would still migrate the developer's dev.db
    #    to whatever schema is on the pushed branch.
    if grep -qE '^[[:space:]]*&& DATABASE_URL="sqlite:\$root_db" cargo sqlx migrate run \\$' "${BASH_SOURCE[0]}"; then
        st_ok "root lane's cargo sqlx migrate run uses the per-invocation DATABASE_URL"
    else
        st_bad "root lane's cargo sqlx migrate run uses the per-invocation DATABASE_URL" \
            'no `&& DATABASE_URL="sqlite:$root_db" cargo sqlx migrate run \` line found'
    fi

    # ── Node dependency preflight (#3656) ────────────────────────────
    # The property: a checkout whose node-based hooks CANNOT run is named
    # as such, and one whose dependencies are present is left alone.
    st_fixture_root="$(mktemp -d -t pre-push-nodedeps.XXXXXX)"

    # 10. The live #3656 shape: a fresh worktree with no node_modules at
    #     all. Must be diagnosed, and the diagnosis must contain the
    #     string the five-red-hooks output never did.
    mkdir -p "$st_fixture_root/fresh"
    st_out="$(node_deps_problem "$st_fixture_root/fresh")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -q 'node_modules'; then
        st_ok "missing node_modules is diagnosed by name"
    else
        st_bad "missing node_modules is diagnosed by name" "rc=$st_rc out=$st_out"
    fi

    # 11. A dangling symlink — `ln -s` run against a main checkout that
    #     has since moved. `-d` alone follows the link and reports false,
    #     so this would otherwise be indistinguishable from case 10; it
    #     gets its own diagnosis because the remedy differs.
    mkdir -p "$st_fixture_root/dangling"
    ln -s "$st_fixture_root/does-not-exist" "$st_fixture_root/dangling/node_modules"
    st_out="$(node_deps_problem "$st_fixture_root/dangling")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -qi 'dangling'; then
        st_ok "dangling node_modules symlink is diagnosed as dangling"
    else
        st_bad "dangling node_modules symlink is diagnosed as dangling" "rc=$st_rc out=$st_out"
    fi

    # 12. Present but empty — `npm ci` interrupted, or a stray `mkdir`.
    #     `npx oxlint` still cannot run, so this must not pass.
    mkdir -p "$st_fixture_root/empty/node_modules"
    st_out="$(node_deps_problem "$st_fixture_root/empty")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ]; then
        st_ok "node_modules without .bin/ is diagnosed (npx would fail)"
    else
        st_bad "node_modules without .bin/ is diagnosed (npx would fail)" "rc=$st_rc"
    fi

    # 13. The healthy shapes — a real directory, and the symlink the
    #     worktree convention actually uses — must pass SILENTLY. A
    #     preflight that fires on a good checkout is worse than none.
    mkdir -p "$st_fixture_root/real/node_modules/.bin"
    st_out="$(node_deps_problem "$st_fixture_root/real")" && st_rc=0 || st_rc=$?
    mkdir -p "$st_fixture_root/linked"
    ln -s "$st_fixture_root/real/node_modules" "$st_fixture_root/linked/node_modules"
    st_out2="$(node_deps_problem "$st_fixture_root/linked")" && st_rc2=0 || st_rc2=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ] && [ "$st_rc2" -eq 0 ] && [ -z "$st_out2" ]; then
        st_ok "installed deps (real dir and symlink) pass silently"
    else
        st_bad "installed deps (real dir and symlink) pass silently" \
            "real: rc=$st_rc out=$st_out | symlink: rc=$st_rc2 out=$st_out2"
    fi

    # 14. Ratchet: the preflight must be WIRED, and wired BEFORE Phase A.
    #     Diagnosing the cause after the five red hooks have already
    #     printed is the state this fixes; a future edit that moves the
    #     call below Phase A restores it while cases 10-13 stay green.
    #
    #     The lookup is a function called from a condition context, with
    #     `|| true` on each capture. This script runs `set -uo pipefail`
    #     WITHOUT `-e`, so the inline form here did still reach its
    #     diagnosis (verified) — unlike push.sh's, which aborted silently.
    #     One `set -e` away from the same bug, and the fixtures below cost
    #     nothing, so it gets the same shape.
    st_line_of() {
        grep -n "$1" "$2" 2>/dev/null | head -1 | cut -d: -f1 || true
    }
    st_order_check() {
        # $1 file, $2 anchor that must come FIRST, $3 anchor after it.
        # Echoes a human diagnosis; non-zero on any violation, including a
        # MISSING anchor (unwired is a failure, not a reason to skip).
        local f="$1" first="$2" second="$3" a b
        a="$(st_line_of "$first" "$f")"
        b="$(st_line_of "$second" "$f")"
        if [ -z "$a" ]; then
            echo "<not wired>: no line matching /$first/"
            return 1
        fi
        if [ -z "$b" ]; then
            echo "<anchor missing>: no line matching /$second/"
            return 1
        fi
        if [ "$a" -lt "$b" ]; then
            echo "ok (line $a < $b)"
            return 0
        fi
        echo "<out of order>: /$first/ at line $a is not before /$second/ at line $b"
        return 1
    }

    ST_CALL_ANCHOR='^if ! node_deps_problem_out='
    ST_PHASE_A_ANCHOR='^if ! SKIP="\$PHASE_A_SKIP" prek run'
    st_rc=0
    st_out="$(st_order_check "${BASH_SOURCE[0]}" "$ST_CALL_ANCHOR" "$ST_PHASE_A_ANCHOR")" || st_rc=$?
    if [ "$st_rc" -eq 0 ]; then
        st_ok "the node-deps preflight runs before Phase A — $st_out"
    else
        st_bad "the node-deps preflight runs before Phase A" "$st_out"
    fi

    # 15. The ratchet's diagnostics must survive the failure they describe:
    #     a NAMED message, not a silent abort and not a bare non-zero.
    grep -v "$ST_CALL_ANCHOR" "${BASH_SOURCE[0]}" >"$st_fixture_root/unwired.sh" || true
    st_rc=0
    st_out="$(st_order_check "$st_fixture_root/unwired.sh" "$ST_CALL_ANCHOR" "$ST_PHASE_A_ANCHOR")" || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -q 'not wired'; then
        st_ok "ratchet names an UNWIRED preflight instead of aborting silently"
    else
        st_bad "ratchet names an UNWIRED preflight instead of aborting silently" \
            "rc=$st_rc out=$st_out"
    fi

    printf 'if ! SKIP="$PHASE_A_SKIP" prek run --all-files\nif ! node_deps_problem_out="x"\n' \
        >"$st_fixture_root/swapped.sh"
    st_rc=0
    st_out="$(st_order_check "$st_fixture_root/swapped.sh" "$ST_CALL_ANCHOR" "$ST_PHASE_A_ANCHOR")" || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -q 'out of order'; then
        st_ok "ratchet names a preflight moved BELOW Phase A, with both line numbers"
    else
        st_bad "ratchet names a preflight moved BELOW Phase A, with both line numbers" \
            "rc=$st_rc out=$st_out"
    fi

    # ── caller-supplied SKIP (#3968) ─────────────────────────────────
    # The property: a `SKIP` the caller exported reaches prek instead of
    # being silently replaced, the required entries still survive, and
    # the run reports that it is no longer CI-equivalent.

    # 16. UNION. Before the fix the caller's entry was simply absent from
    #     the value handed to prek — the hook ran and the run reported
    #     success. Exact equality, so an implementation that dropped
    #     either side, or reordered, fails.
    st_out="$(phase_a_skip_compose "vitest,cargo-test" "cargo-deny")"
    if [ "$st_out" = "vitest,cargo-test,cargo-deny" ]; then
        st_ok "a caller SKIP is composed with the required entries, not discarded"
    else
        st_bad "a caller SKIP is composed with the required entries, not discarded" \
            "got '$st_out'"
    fi

    # 17. The required entries are NOT overridable from outside: a caller
    #     SKIP naming something else cannot displace them. (The mirror of
    #     16 — that direction of the swap has its own way of being wrong.)
    st_out="$(phase_a_skip_compose "vitest,cargo-test" "cargo-deny")"
    case ",$st_out," in
        *",vitest,"*) case ",$st_out," in *",cargo-test,"*) st_rc=0 ;; *) st_rc=1 ;; esac ;;
        *) st_rc=1 ;;
    esac
    if [ "$st_rc" -eq 0 ]; then
        st_ok "the script's own required skips survive a caller SKIP"
    else
        st_bad "the script's own required skips survive a caller SKIP" "got '$st_out'"
    fi

    # 18. Whitespace and duplicates: `SKIP='cargo-test , cargo-deny'` is a
    #     shape a human types. A duplicate must collapse (prek takes a
    #     comma list; a doubled entry is noise in the echoed SKIP= line)
    #     and surrounding spaces must not become part of a hook name,
    #     which would silently match nothing.
    st_out="$(phase_a_skip_compose "vitest,cargo-test" " cargo-test , cargo-deny ")"
    if [ "$st_out" = "vitest,cargo-test,cargo-deny" ]; then
        st_ok "caller SKIP entries are trimmed and de-duplicated"
    else
        st_bad "caller SKIP entries are trimmed and de-duplicated" "got '$st_out'"
    fi

    # 19. No caller SKIP is the overwhelmingly common case (every
    #     scripts/push.sh invocation): the composed value must be exactly
    #     the required list, with no trailing comma — prek reads an empty
    #     trailing field as a hook name that matches nothing, which is how
    #     a "harmless" formatting slip becomes a silent no-op again.
    st_out="$(phase_a_skip_compose "vitest,cargo-test" "")"
    if [ "$st_out" = "vitest,cargo-test" ]; then
        st_ok "no caller SKIP leaves the required list byte-identical"
    else
        st_bad "no caller SKIP leaves the required list byte-identical" "got '$st_out'"
    fi

    # 19b. EMPTY fields inside the caller's value — `SKIP=a,,b`, or a value
    #      that is nothing but separators and spaces. `read -ra` drops a
    #      TRAILING empty field on its own, so case 19 above does not reach
    #      the empty-entry skip; only an interior or whitespace-only field
    #      does. An empty entry reaching prek is a hook name that matches
    #      nothing, i.e. exactly the silent no-op this issue is about, one
    #      layer down. Both helpers, since both split the same way.
    st_out="$(phase_a_skip_compose "vitest,cargo-test" "cargo-deny,,typos")"
    st_out2="$(phase_a_skip_compose "vitest" " , ")"
    st_out3="$(phase_a_skip_extra "vitest" "cargo-deny,,typos")"
    if [ "$st_out" = "vitest,cargo-test,cargo-deny,typos" ] &&
        [ "$st_out2" = "vitest" ] && [ "$st_out3" = "cargo-deny,typos" ]; then
        st_ok "empty and whitespace-only SKIP entries are dropped, not passed to prek"
    else
        st_bad "empty and whitespace-only SKIP entries are dropped, not passed to prek" \
            "compose='$st_out' whitespace-only='$st_out2' extra='$st_out3'"
    fi

    # 19c. A caller SKIP carrying a NEWLINE (#3990 item 5). `IFS=',' read -ra`
    #      reads one LINE, so everything after the first was dropped from the
    #      value handed to prek AND from the non-equivalence warning — the run
    #      omitted hooks it did not name, which is the silent discard #3968
    #      removed one layer up. Both helpers, and both must name `typos`.
    st_nl_compose="$(phase_a_skip_compose "vitest,cargo-test" "gitleaks
typos")"
    st_nl_extra="$(phase_a_skip_extra "vitest,cargo-test" "gitleaks
typos")"
    if [ "$st_nl_compose" = "vitest,cargo-test,gitleaks,typos" ] &&
        [ "$st_nl_extra" = "gitleaks,typos" ]; then
        st_ok "a caller SKIP containing a newline is honoured whole, not truncated"
    else
        st_bad "a caller SKIP containing a newline is honoured whole, not truncated" \
            "compose='$st_nl_compose' extra='$st_nl_extra'"
    fi

    #      The other direction — a value that merely ENDS in a newline must
    #      not gain an empty trailing entry — has no assertion of its own on
    #      purpose: newline is IFS whitespace, the empty-entry drop in 19b and
    #      the whitespace trim in 18 (whose `[[:space:]]` class covers `\n`)
    #      each independently guarantee it, and no implementation that passes
    #      19c can fail it. An assertion there would be decoration.

    # 20. The warning reports what the caller's SKIP actually REMOVES, not
    #     the raw value: re-skipping something already required changes
    #     nothing, and warning about it trains the reader to ignore the
    #     warning.
    st_out="$(phase_a_skip_extra "vitest,cargo-test" "cargo-test,cargo-deny")"
    if [ "$st_out" = "cargo-deny" ]; then
        st_ok "the non-equivalence warning names only the hooks actually removed"
    else
        st_bad "the non-equivalence warning names only the hooks actually removed" \
            "got '$st_out'"
    fi

    # 21. …and is EMPTY when the caller removed nothing, so a redundant
    #     SKIP does not print a scary "not CI-equivalent" banner on a run
    #     that is, in fact, equivalent.
    st_out="$(phase_a_skip_extra "vitest,cargo-test" " vitest ")"
    if [ -z "$st_out" ]; then
        st_ok "a redundant caller SKIP produces no non-equivalence warning"
    else
        st_bad "a redundant caller SKIP produces no non-equivalence warning" "got '$st_out'"
    fi

    # 22. Ratchet: the helpers above are worthless if Phase A does not USE
    #     them. This is the half that the pure-function cases cannot cover
    #     — the original bug was entirely in the call site, not in any
    #     function. Anchored at line start and matched as exact text so a
    #     future edit back to `PHASE_A_SKIP="$(IFS=,; …skip_items…)"`
    #     fails here rather than silently reinstating the clobber.
    ST_COMPOSE_ANCHOR='^PHASE_A_SKIP="\$\(phase_a_skip_compose "\$PHASE_A_REQUIRED_SKIP" "\$CALLER_SKIP"\)"$'
    ST_CALLERSKIP_ANCHOR='^CALLER_SKIP="\$\{SKIP:-\}"$'
    # Both ratchets are expressed as FUNCTIONS taking a file, so case 25
    # can drive the identical logic against a fixture that violates the
    # property. A ratchet written inline as a grep over this file alone
    # passes on a healthy tree no matter what it looks for, and a weakened
    # pattern is then indistinguishable from a satisfied one.
    st_skip_wiring_ok() {
        grep -qE "$ST_CALLERSKIP_ANCHOR" "$1" && grep -qE "$ST_COMPOSE_ANCHOR" "$1"
    }
    # Numbered against the FILE (#3990 item 4). This used to pipe through
    # `grep -vE '^[[:space:]]*#'` FIRST and number SECOND, so the line numbers
    # were positions in the comment-stripped stream: a clobber reinstated near
    # the end of this file would be announced hundreds of lines above where it
    # lives, sending the reader to the wrong place.
    #
    # That prefilter is gone rather than reordered. What excludes the prose
    # above is the `^` ANCHOR — a commented line begins with `#`, so it can
    # never match `^PHASE_A_SKIP=`. The filter was doing nothing, and the
    # comment at case 23 crediting it was a stale justification. Case 25 pins
    # the anchor's exclusion directly instead.
    st_clobber_lines() {
        grep -nE '^PHASE_A_SKIP="\$\(IFS=,' "$1" || true
    }
    st_rc=0
    st_skip_wiring_ok "${BASH_SOURCE[0]}" || st_rc=1
    if [ "$st_rc" -eq 0 ]; then
        st_ok "Phase A's SKIP is built by composing the caller's SKIP, not by replacing it"
    else
        st_bad "Phase A's SKIP is built by composing the caller's SKIP, not by replacing it" \
            'no `CALLER_SKIP="${SKIP:-}"` + `PHASE_A_SKIP="$(phase_a_skip_compose …)"` pair found'
    fi

    # 23. Ratchet: the clobbering form must not come back alongside it. A
    #     re-added `PHASE_A_SKIP="$(IFS=,; …)"` line would satisfy case 22
    #     (the composing line still exists) while whichever ran last won.
    #     The `^` anchor is what keeps this off the prose above; case 25
    #     drives that exclusion against a fixture rather than asserting it.
    st_out="$(st_clobber_lines "${BASH_SOURCE[0]}")"
    if [ -z "$st_out" ]; then
        st_ok "the clobbering PHASE_A_SKIP assignment is gone and stays gone"
    else
        st_bad "the clobbering PHASE_A_SKIP assignment is gone and stays gone" \
            "$(printf '%s' "$st_out" | tr '\n' ' ')"
    fi

    # 24. Ratchet: a run made inequivalent by a caller SKIP must say so in
    #     the FINAL banner, not only in a Phase A line that has scrolled
    #     past by the time the gate reports. The banner is the line that
    #     gets quoted as "the gate passed".
    if grep -qE '^[[:space:]]*echo "  ⚠ NOT CI-equivalent: caller SKIP omitted' "${BASH_SOURCE[0]}"; then
        st_ok "the PASSED banner declares the run non-equivalent when caller skips applied"
    else
        st_bad "the PASSED banner declares the run non-equivalent when caller skips applied" \
            'no "NOT CI-equivalent" line found near the final banner'
    fi

    # 25. Cases 22 and 23 must be able to FAIL. Both are checks over this
    #     very file, so on a healthy tree they pass whatever they look
    #     for — a weakened `st_skip_wiring_ok` (or one that always returns
    #     0) is indistinguishable from a satisfied one. Drive the SAME
    #     functions against fixtures that violate the property and require
    #     them to report it there.
    grep -vE "$ST_COMPOSE_ANCHOR" "${BASH_SOURCE[0]}" >"$st_fixture_root/unwired-skip.sh" || true
    if st_skip_wiring_ok "$st_fixture_root/unwired-skip.sh"; then
        st_bad "the compose-wiring ratchet reports a file with the wiring removed" \
            'st_skip_wiring_ok passed a fixture with the composing assignment stripped'
    else
        st_ok "the compose-wiring ratchet reports a file with the wiring removed"
    fi
    #     The forbidden line is placed at line 10, behind nine COMMENT lines,
    #     for two reasons at once: it must still be found (the ratchet works)
    #     and it must be reported at line 10 (#3990 item 4 — numbering a
    #     comment-filtered stream reported it at line 1, sending the reader
    #     hundreds of lines from the reinstated clobber in this file). A
    #     one-line fixture cannot tell those apart: every line number is 1.
    {
        for st_i in 1 2 3 4 5 6 7 8 9; do
            printf '# PHASE_A_SKIP is discussed in prose on line %s\n' "$st_i"
        done
        printf 'PHASE_A_SKIP="$(IFS=,; printf %%s "${skip_items[*]}")"\n'
    } >"$st_fixture_root/clobber.sh"
    st_out="$(st_clobber_lines "$st_fixture_root/clobber.sh")"
    if [ -n "$st_out" ]; then
        st_ok "the clobber ratchet reports the exact form it forbids"
    else
        st_bad "the clobber ratchet reports the exact form it forbids" \
            'st_clobber_lines found nothing in a fixture that is the forbidden line'
    fi
    case "$st_out" in
        10:*) st_ok "the clobber ratchet reports the line number of the FILE" ;;
        *)
            st_bad "the clobber ratchet reports the line number of the FILE" \
                "want line 10, got '$st_out'"
            ;;
    esac
    #     The other half: a clobber sitting inside a COMMENT is still not a
    #     clobber. Numbering first must not have re-admitted the prose this
    #     ratchet was written to ignore.
    printf '# PHASE_A_SKIP="$(IFS=,; printf %%s "${skip_items[*]}")" was the old form\n' \
        >"$st_fixture_root/clobber-in-comment.sh"
    if [ -z "$(st_clobber_lines "$st_fixture_root/clobber-in-comment.sh")" ]; then
        st_ok "the clobber ratchet still ignores the forbidden form inside a comment"
    else
        st_bad "the clobber ratchet still ignores the forbidden form inside a comment" \
            'a commented-out clobber was reported as a live one'
    fi

    rm -rf "$st_fixture_root"

    # ── dev.db migration gap (#4266) ─────────────────────────────────
    # The property: a dev.db genuinely behind (or missing, or never
    # migrated) is caught and named, with the exact remedy command; a
    # dev.db that is caught up is left alone. Own fixture root, cleaned
    # at the end of this section.
    st_devdb_root="$(mktemp -d -t pre-push-devdb.XXXXXX)"

    st_devdb_seed() {
        # $1 name, $2 = space-separated list of migration FILENAMEs to place
        # in migrations/ on disk (each already encodes its own version via
        # its leading digits, e.g. "0001_initial.sql" — no separate version
        # tag needed), $3 = space-separated applied version numbers (or ""
        # for none, or "NOTABLE" for a dev.db with no _sqlx_migrations table
        # at all, or "NODB" for no dev.db file), $4 = optional db filename
        # (default "dev.db" — override to prove a DATABASE_URL form was
        # actually parsed, not just defaulted).
        local name="$1" disk="$2" applied="$3" dbname="${4:-dev.db}"
        local dir="$st_devdb_root/$name/src-tauri"
        mkdir -p "$dir/migrations"
        local fn
        for fn in $disk; do
            touch "$dir/migrations/$fn"
        done
        case "$applied" in
            NODB) ;;
            NOTABLE)
                python3 -c "
import sqlite3
con = sqlite3.connect('$dir/$dbname')
con.execute('CREATE TABLE not_a_migrations_table (id INTEGER)')
con.commit()
"
                ;;
            *)
                python3 -c "
import sqlite3
con = sqlite3.connect('$dir/$dbname')
con.execute('''CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY, description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL
)''')
for v in '$applied'.split():
    con.execute(
        'INSERT INTO _sqlx_migrations VALUES (?,?,CURRENT_TIMESTAMP,1,?,0)',
        (int(v), 'seed', b'\x00'),
    )
con.commit()
"
                ;;
        esac
    }

    # The remedy is printed as two lines (see print_remedy() above — kept
    # off one line so this very file doesn't reproduce the #3361 ratchet's
    # forbidden "cd src-tauri" + "cargo sqlx migrate run" adjacency). Assert
    # both lines rather than one contiguous string for the same reason.
    st_devdb_names_remedy() {
        printf '%s' "$1" | grep -qF 'cd src-tauri' \
            && printf '%s' "$1" | grep -qF 'cargo sqlx migrate run'
    }

    # 26. dev.db does not exist at all: fails, names the file and the exact
    #     `sqlx migrate run` remedy.
    st_devdb_seed missing-db "0001_initial.sql" NODB
    st_out="$(devdb_migration_gap "$st_devdb_root/missing-db/src-tauri" "$st_devdb_root/missing-db/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -q 'does not exist' \
        && st_devdb_names_remedy "$st_out"; then
        st_ok "a missing dev.db fails, naming the file and the exact remedy"
    else
        st_bad "a missing dev.db fails, naming the file and the exact remedy" "rc=$st_rc out=$st_out"
    fi

    # 27. dev.db exists but was never migrated (no _sqlx_migrations table —
    #     `cargo sqlx database create` ran, `migrate run` never did): fails,
    #     names the missing table and the remedy.
    st_devdb_seed never-migrated "0001_initial.sql" NOTABLE
    st_out="$(devdb_migration_gap "$st_devdb_root/never-migrated/src-tauri" "$st_devdb_root/never-migrated/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -q '_sqlx_migrations' \
        && st_devdb_names_remedy "$st_out"; then
        st_ok "a never-migrated dev.db fails, naming the missing table and the remedy"
    else
        st_bad "a never-migrated dev.db fails, naming the missing table and the remedy" "rc=$st_rc out=$st_out"
    fi

    # 28. The live #4266 shape: dev.db genuinely behind — applied up through
    #     0002, migration 0003 is on disk and pending. Fails, names exactly
    #     that file and the exact remedy command.
    st_devdb_seed behind-tail "0001_initial.sql 0002_second.sql 0003_third.sql" "1 2"
    st_out="$(devdb_migration_gap "$st_devdb_root/behind-tail/src-tauri" "$st_devdb_root/behind-tail/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -qF '0003_third.sql' \
        && st_devdb_names_remedy "$st_out"; then
        st_ok "a dev.db behind by one migration fails, naming it and the exact remedy"
    else
        st_bad "a dev.db behind by one migration fails, naming it and the exact remedy" "rc=$st_rc out=$st_out"
    fi

    # 29. A GAP, not just a stale tail: 0001 and 0003 applied, 0002 pending.
    #     A max()-only comparison (applied max = 3 = disk max) would call
    #     this caught up; the set comparison this check does must not.
    #     Names ONLY the missing one, not the two already applied.
    st_devdb_seed middle-gap "0001_initial.sql 0002_second.sql 0003_third.sql" "1 3"
    st_out="$(devdb_migration_gap "$st_devdb_root/middle-gap/src-tauri" "$st_devdb_root/middle-gap/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -ne 0 ] && printf '%s' "$st_out" | grep -qF '0002_second.sql' \
        && ! printf '%s' "$st_out" | grep -qF '0001_initial.sql' \
        && ! printf '%s' "$st_out" | grep -qF '0003_third.sql'; then
        st_ok "a mid-sequence gap is caught by set comparison, not just a stale max"
    else
        st_bad "a mid-sequence gap is caught by set comparison, not just a stale max" "rc=$st_rc out=$st_out"
    fi

    # 30. The healthy shape must pass SILENTLY — a preflight that fires on a
    #     caught-up dev.db is worse than none (mirrors case 13 above).
    st_devdb_seed up-to-date "0001_initial.sql 0002_second.sql" "1 2"
    st_out="$(devdb_migration_gap "$st_devdb_root/up-to-date/src-tauri" "$st_devdb_root/up-to-date/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "a dev.db caught up with migrations/ passes silently"
    else
        st_bad "a dev.db caught up with migrations/ passes silently" "rc=$st_rc out=$st_out"
    fi

    # ── DATABASE_URL resolution (#4330 review) ────────────────────────
    # Each case below seeds an UP-TO-DATE dev.db under a name other than
    # the "dev.db" default, so a parser that silently fell back to the
    # default (or mis-parsed the URL and missed the real file) would be
    # caught failing here, not accidentally passing. Every case must
    # resolve to rc=0 with empty output — exactly case 30's healthy shape,
    # just reached through a DATABASE_URL instead of the implicit default.

    # 31. "sqlite://host" form: the host must fold into the filename
    #     ("sqlite://custom-a.db" -> "custom-a.db"), not be treated as an
    #     absolute path via a naive "//custom-a.db" (the exact #4330 bug).
    st_devdb_seed dburl-dblslash "0001_initial.sql" "1" custom-a.db
    st_dir="$st_devdb_root/dburl-dblslash/src-tauri"
    printf 'DATABASE_URL=sqlite://custom-a.db\n' >"$st_dir/.env"
    st_out="$(devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "DATABASE_URL=sqlite://<file> resolves the file, not a bogus absolute path"
    else
        st_bad "DATABASE_URL=sqlite://<file> resolves the file, not a bogus absolute path" "rc=$st_rc out=$st_out"
    fi

    # 32. "sqlite:///abs/path" form: true absolute path (empty host).
    st_devdb_seed dburl-abspath "0001_initial.sql" "1" custom-b.db
    st_dir="$st_devdb_root/dburl-abspath/src-tauri"
    printf 'DATABASE_URL=sqlite://%s/custom-b.db\n' "$st_dir" >"$st_dir/.env"
    st_out="$(devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "DATABASE_URL=sqlite:///<abs path> resolves the absolute file"
    else
        st_bad "DATABASE_URL=sqlite:///<abs path> resolves the absolute file" "rc=$st_rc out=$st_out"
    fi

    # 33. A "?..." query suffix (e.g. sqlx-cli's own "?mode=rwc") must be
    #     stripped, not treated as part of the filename.
    st_devdb_seed dburl-query "0001_initial.sql" "1" custom-c.db
    st_dir="$st_devdb_root/dburl-query/src-tauri"
    printf 'DATABASE_URL=sqlite:custom-c.db?mode=rwc\n' >"$st_dir/.env"
    st_out="$(devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "a trailing ?query string on DATABASE_URL is stripped, not treated as part of the filename"
    else
        st_bad "a trailing ?query string on DATABASE_URL is stripped, not treated as part of the filename" "rc=$st_rc out=$st_out"
    fi

    # 34. dotenvy keeps the FIRST "DATABASE_URL=" line in .env, not the
    #     last — two lines present, first names the real (caught-up) db,
    #     second names one that doesn't exist.
    st_devdb_seed dburl-first-wins "0001_initial.sql" "1" good.db
    st_dir="$st_devdb_root/dburl-first-wins/src-tauri"
    printf 'DATABASE_URL=sqlite:good.db\nDATABASE_URL=sqlite:does-not-exist.db\n' >"$st_dir/.env"
    st_out="$(devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "the FIRST DATABASE_URL= line in .env wins, matching dotenvy"
    else
        st_bad "the FIRST DATABASE_URL= line in .env wins, matching dotenvy" "rc=$st_rc out=$st_out"
    fi

    # 35. An EXPORTED DATABASE_URL (what sqlx-cli itself prefers) must win
    #     over .env, not be ignored — .env here names a db that doesn't
    #     exist; only the exported var names the real, caught-up one.
    st_devdb_seed dburl-exported-wins "0001_initial.sql" "1" good2.db
    st_dir="$st_devdb_root/dburl-exported-wins/src-tauri"
    printf 'DATABASE_URL=sqlite:does-not-exist2.db\n' >"$st_dir/.env"
    st_out="$(DATABASE_URL="sqlite:good2.db" devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 0 ] && [ -z "$st_out" ]; then
        st_ok "an exported DATABASE_URL wins over a stale .env entry"
    else
        st_bad "an exported DATABASE_URL wins over a stale .env entry" "rc=$st_rc out=$st_out"
    fi

    # ── could-not-inspect (#4330 review): warn, don't hard-block ──────
    # A guard that cannot inspect dev.db is not evidence dev.db is behind
    # — it must say so plainly and return 2 (the caller warns and
    # continues), distinct from 1 (a confirmed gap, which hard-blocks).

    # 36. dev.db exists but is not a valid sqlite file at all (corrupt /
    #     truncated) — sqlite3 raises on the first query; caught locally.
    mkdir -p "$st_devdb_root/corrupt-db/src-tauri/migrations"
    touch "$st_devdb_root/corrupt-db/src-tauri/migrations/0001_initial.sql"
    printf 'not a sqlite database\n' >"$st_devdb_root/corrupt-db/src-tauri/dev.db"
    st_out="$(devdb_migration_gap "$st_devdb_root/corrupt-db/src-tauri" "$st_devdb_root/corrupt-db/src-tauri/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 2 ] && printf '%s' "$st_out" | grep -q 'could not inspect'; then
        st_ok "a corrupt (non-sqlite) dev.db is reported as could-not-inspect (rc=2), not a confirmed gap"
    else
        st_bad "a corrupt (non-sqlite) dev.db is reported as could-not-inspect (rc=2), not a confirmed gap" "rc=$st_rc out=$st_out"
    fi

    # 37. python3 itself unavailable — the function must say so plainly on
    #     stdout (not lose it to the terminal as bare stderr) and return 2.
    st_devdb_seed no-python "0001_initial.sql" "1"
    st_dir="$st_devdb_root/no-python/src-tauri"
    st_out="$(PATH="$st_devdb_root/empty-bin-$$" devdb_migration_gap "$st_dir" "$st_dir/migrations")" && st_rc=0 || st_rc=$?
    if [ "$st_rc" -eq 2 ] && printf '%s' "$st_out" | grep -q 'python3 not found'; then
        st_ok "a missing python3 is reported as could-not-inspect (rc=2) with a plain message, not a silent blank body"
    else
        st_bad "a missing python3 is reported as could-not-inspect (rc=2) with a plain message, not a silent blank body" "rc=$st_rc out=$st_out"
    fi

    rm -rf "$st_devdb_root"

    # 38. Ratchet: the preflight must be WIRED, and wired BEFORE Phase A —
    #     same failure shape as case 14 (diagnosing after the fact is the
    #     state being fixed). Reuses ST_PHASE_A_ANCHOR and st_order_check
    #     from the node-deps section above.
    # NOTE: st_line_of/st_order_check use plain `grep -n`, whose patterns are
    # basic regular expressions, not extended ones. Bare "(" "/" ")" are
    # LITERAL there, so they must NOT be backslash-escaped here (the
    # extended-flavoured anchors above happen to contain no parens, so this
    # gotcha never showed up until now).
    ST_DEVDB_ANCHOR='^    devdb_gap_out="\$(devdb_migration_gap '
    st_rc=0
    st_out="$(st_order_check "${BASH_SOURCE[0]}" "$ST_DEVDB_ANCHOR" "$ST_PHASE_A_ANCHOR")" || st_rc=$?
    if [ "$st_rc" -eq 0 ]; then
        st_ok "the dev.db migration-gap preflight runs before Phase A — $st_out"
    else
        st_bad "the dev.db migration-gap preflight runs before Phase A" "$st_out"
    fi

    if [ "$st_fail" != 0 ]; then
        echo "verify-ci-equivalent self-test FAILED" >&2
        exit 2
    fi
    echo "verify-ci-equivalent self-test passed"
    exit 0
fi

# ── Bypass guard (CI-R16) ──────────────────────────────────────────
# Reject a bare truthy flag; require an explicit, self-documenting reason
# of at least 8 characters. The reason is echoed so the skip leaves a
# trace in the push output rather than being silent.
SKIP_REASON="${SKIP_CI_VERIFY:-}"
# Trim leading/trailing whitespace (internal spaces preserved) so a padded
# truthy flag like "1   " can't slip past the truthy/length checks below.
SKIP_REASON="${SKIP_REASON#"${SKIP_REASON%%[![:space:]]*}"}"
SKIP_REASON="${SKIP_REASON%"${SKIP_REASON##*[![:space:]]}"}"
if [ -n "$SKIP_REASON" ]; then
    case "$(printf '%s' "$SKIP_REASON" | tr '[:upper:]' '[:lower:]')" in
        1 | 0 | y | n | on | off | yes | no | true | false)
            printf '✗ SKIP_CI_VERIFY=%s rejected: bypassing the verifier requires a REASON, not a truthy flag.\n' "$SKIP_REASON" >&2
            printf "  Re-run with a short explanation, e.g.:\n" >&2
            printf "    SKIP_CI_VERIFY='docs typo, no source change' git push\n" >&2
            exit 1
            ;;
    esac
    if [ "${#SKIP_REASON}" -lt 8 ]; then
        printf '✗ SKIP_CI_VERIFY reason too short (%s chars, need ≥8): "%s"\n' "${#SKIP_REASON}" "$SKIP_REASON" >&2
        printf "  Give a real reason, e.g. SKIP_CI_VERIFY='rebasing onto main, already verified' git push\n" >&2
        exit 1
    fi
    echo "→ Pre-push verifier skipped. Reason: $SKIP_REASON"
    exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# ── Preflight: node dependencies (#3656) ───────────────────────────
# Before Phase A, not after five of its hooks have gone red for reasons
# none of them can name. Costs a stat; saves the diagnosis.
if ! node_deps_problem_out="$(node_deps_problem "$REPO_ROOT")"; then
    echo "✗ Pre-push verification cannot run: $node_deps_problem_out" >&2
    echo "" >&2
    echo "  Every node-based hook in Phase A (npx oxlint / oxfmt / tsc, and the" >&2
    echo "  node guard scripts) needs this. Without it they fail one by one on" >&2
    echo "  their own terms — including two guard SELF-TESTS, which look like" >&2
    echo "  your change broke a guard. It did not; the dependencies are absent." >&2
    echo "" >&2
    node_deps_remedy "$REPO_ROOT" | sed 's/^/  /' >&2
    exit 1
fi

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# ── Determine the commit range being pushed ────────────────────────
# Default: commits ahead of the tracking upstream. Override via
# PRE_PUSH_RANGE for branches without an upstream (e.g. fresh feature
# branches that haven't been pushed yet — set PRE_PUSH_RANGE=origin/main...HEAD).
#
# Three dots, not two. `git diff A..B` compares the two TIPS, so anything
# present on A but not on B reads as a deletion — a branch cut before a
# migration merged to main gets that migration reported as a *removed*
# shipped migration by check-migrations-immutable.sh, failing the push for
# a change it never made. `A...B` diffs from the merge-base, i.e. only what
# this branch actually did, which is what the guard means to police (and
# what check-migrations-immutable.sh's own --range docs specify).
#
# Three dots loses nothing: a migration edited by this branch is still in
# the merge-base diff, including one introduced by a history rewrite.

RANGE="${PRE_PUSH_RANGE:-}"
if [ -z "$RANGE" ]; then
    if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
        RANGE="@{upstream}...HEAD"
    elif git rev-parse --verify origin/main >/dev/null 2>&1; then
        RANGE="origin/main...HEAD"
        echo "→ No tracking upstream; falling back to range '$RANGE'"
    else
        echo "✗ Cannot determine push range (no upstream, no origin/main)."
        echo "  Set PRE_PUSH_RANGE=<revspec> and retry."
        exit 1
    fi
fi

if ! git rev-list --count "$RANGE" >/dev/null 2>&1; then
    echo "✗ Range '$RANGE' does not resolve to a valid revision range."
    exit 1
fi

# Display count only. `rev-list --count A...B` counts the SYMMETRIC
# difference, so a branch sitting behind main would report main's commits
# as its own; --right-only narrows it to this branch's. Falls back for a
# two-dot PRE_PUSH_RANGE, where --right-only is not meaningful.
RANGE_COUNT="$(git rev-list --count --right-only "$RANGE" 2>/dev/null \
    || git rev-list --count "$RANGE" 2>/dev/null || echo 0)"
echo "→ Pre-push verifier: range '$RANGE' ($RANGE_COUNT commit(s))"

# Fail-closed change detection: keep the git-diff exit status so we can tell a
# genuinely EMPTY diff apart from a diff that could not be computed. If the
# command fails we cannot know what changed, so we run EVERY category below.
if CHANGED="$(git diff "$RANGE" --name-only --diff-filter=ACMR 2>/dev/null)"; then
    CHANGED_OK=1
else
    CHANGED_OK=0
    CHANGED=""
fi

has_match() {
    [ -n "$CHANGED" ] && printf '%s\n' "$CHANGED" | grep -qE "$1"
}

# Per-category change flags. HAS_RS/HAS_MCP gate the Rust/MCP phases (unchanged);
# HAS_TS/HAS_CI/HAS_DOCS join them to make Phase A's prek SKIP category-aware
# (mirroring the CI `lint` job's per-category plan — see the SKIP build below).
HAS_RS=0
HAS_TS=0
HAS_CI=0
HAS_DOCS=0
HAS_MCP=0
if [ "$CHANGED_OK" = "0" ]; then
    # Could not compute the changed-file set → fail closed: run everything.
    echo "→ Could not compute changed-file set for '$RANGE'; failing closed (running every category)."
    HAS_RS=1
    HAS_TS=1
    HAS_CI=1
    HAS_DOCS=1
    HAS_MCP=1
else
    # Backend: Rust sources, the crate manifests/lockfile, shipped migrations.
    has_match '\.rs$|^src-tauri/Cargo\.(toml|lock)$|^src-tauri/migrations/.*\.sql$' && HAS_RS=1
    # Frontend: TS/JS/CSS sources, e2e specs, and the FE build/config surface.
    has_match '^src/|^e2e/|\.(ts|tsx|js|jsx|css)$|package(-lock)?\.json$|(vite|vitest|tailwind|postcss)\.config\.|tsconfig.*\.json$|index\.html$' && HAS_TS=1
    # CI/tooling: workflows plus the lint-tool configs the CI lint job keys on.
    has_match '^\.github/|prek\.toml$|\.taplo\.toml$|lychee\.toml$|\.gitleaks\.toml$' && HAS_CI=1
    # Docs: any Markdown file plus the docs/ tree.
    has_match '\.md$|^docs/' && HAS_DOCS=1
    # MCP gate: only the binary, its module, the Tauri command wrapper, and
    # the prebuilt-binary directory. Catches the surface that affects the
    # agaric-mcp release build + UDS smoke + externalBin pin verification.
    has_match '^src-tauri/src/mcp/|^src-tauri/src/commands/mcp\.rs$|^src-tauri/src/bin/agaric-mcp\.rs$|^src-tauri/binaries/' && HAS_MCP=1

    # Fail-closed for UNRECOGNIZED non-docs paths (mirrors _validate.yml's
    # classifier): a changed file matching neither docs nor any known category
    # (frontend/backend/ci) — e.g. rust-toolchain.toml, .cargo/config.toml, a
    # root *.sh — is a build/toolchain change we cannot attribute to a suite.
    # Without this the per-category SKIP below would drop nearly every hook for
    # such a push. Pin frontend+backend+ci so their hooks still run — the ci
    # hooks (shell lint + the skip-ci-verify guard) then cover *.sh. The
    # recognizer regexes are the SAME patterns that set HAS_TS/HAS_RS/HAS_CI
    # above (so "recognized" ⟺ "set some category flag"), plus a broad docs
    # matcher (LICENSE/NOTICE/… beyond the HAS_DOCS *.md set) so a licence edit
    # is NOT over-escalated to the full suite. A file matching none of these set
    # no flag → fail closed.
    unrec_docs='^(docs/|.*\.md$|LICENSE([.-].*)?$|NOTICE$|AUTHORS$|CHANGELOG$)'
    unrec_fe='^src/|^e2e/|\.(ts|tsx|js|jsx|css)$|package(-lock)?\.json$|(vite|vitest|tailwind|postcss)\.config\.|tsconfig.*\.json$|index\.html$'
    unrec_be='\.rs$|^src-tauri/Cargo\.(toml|lock)$|^src-tauri/migrations/.*\.sql$'
    unrec_ci='^\.github/|prek\.toml$|\.taplo\.toml$|lychee\.toml$|\.gitleaks\.toml$'
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [[ "$f" =~ $unrec_docs || "$f" =~ $unrec_fe || "$f" =~ $unrec_be || "$f" =~ $unrec_ci ]]; then
            continue
        fi
        echo "→ Unrecognized non-docs path: $f → failing closed (frontend+backend+ci)."
        HAS_TS=1
        HAS_RS=1
        HAS_CI=1
        break
    done <<< "$CHANGED"
fi

# ── Preflight: dev.db migration gap (#4266) ─────────────────────────
# Before Phase A, and gated the same as Phase D/D2 below (HAS_RS) — those
# are the phases that actually compile `sqlx::query!` macros against
# dev.db, so this is exactly the condition under which drift would
# otherwise surface there, seconds from now, as a "no such table" error
# from a crate the diff never touched. A doc-only or frontend-only push
# never reaches those phases, so it is not made to pay for a check whose
# failure it could not have caused.
if [ "$HAS_RS" = "1" ]; then
    devdb_gap_out="$(devdb_migration_gap "$REPO_ROOT/src-tauri" "$REPO_ROOT/src-tauri/migrations")"
    devdb_gap_rc=$?
    if [ "$devdb_gap_rc" -eq 1 ]; then
        # Confirmed gap (missing/never-migrated/behind) — the diagnosis
        # below is the headline; this line just generalizes it rather than
        # (wrongly) always naming "behind" when it might be either of the
        # other two.
        echo "✗ Pre-push verification cannot run: dev.db is not in sync with src-tauri/migrations/ (#4266)" >&2
        echo "" >&2
        echo "$devdb_gap_out" | sed 's/^/  /' >&2
        echo "" >&2
        echo "  Without this, Phase D/D2's online sqlx::query! macros compile" >&2
        echo "  against a stale schema and fail with a confusing error (e.g. 'no" >&2
        echo "  such table') from a crate this push never touched." >&2
        exit 1
    elif [ "$devdb_gap_rc" -eq 2 ]; then
        # Could not inspect at all (missing python3, permission/OS error) —
        # this is NOT evidence dev.db is behind, so warn and let the push
        # proceed rather than hard-blocking on an inability to check.
        echo "⚠ Could not check dev.db against src-tauri/migrations/ (#4266) — continuing without this preflight:" >&2
        echo "" >&2
        echo "$devdb_gap_out" | sed 's/^/  /' >&2
        echo "" >&2
    fi
fi

# ── Phase A: prek run --all-files (pre-commit hooks against whole tree) ──
# SKIP silences the vitest/cargo-test hooks (they'd read `--cached` and log
# "no staged files — skipping" — wasted noise since Phase C/D run them with
# --range below) AND, category-aware, the hooks whose category did NOT change.
#
# This mirrors the CI `lint` job's per-category plan (an audit produced the
# exact lists): a hook is skipped only when the category it guards is absent
# from this push. The nightly `full-suite` job in
# .github/workflows/scheduled-deep-checks.yml runs the FULL unskipped prek
# suite over the whole tree as the backstop, so this trades per-push
# whole-tree coverage of the ABSENT categories for a faster push; a latent
# breach in an untouched, unchanged-category file is caught nightly instead.
#
# Never skipped BY CATEGORY (no HAS_* branch below removes them, so they run
# on every push whatever changed): trailing-whitespace, end-of-file-fixer,
# check-merge-conflict, check-added-large-files,
# check-shebang-scripts-are-executable, check-executables-have-shebangs,
# mixed-line-ending, detect-private-key, gitleaks, typos.
#
# "Regardless of category" is the whole claim — it is NOT "regardless of
# everything", and this comment used to say the latter (#3990 item 3). The
# caller's `SKIP` is composed into `PHASE_A_SKIP` (#3968), so
# `SKIP=gitleaks git push` genuinely omits gitleaks from Phase A. Nothing
# about that is silent — `phase_a_skip_extra` names it in the ⚠ line and the
# final PASS banner repeats it as NOT CI-equivalent — but the list above
# describes this script's own category plan, not a guarantee against the
# caller. A green run whose banner declares caller skips is not quotable as a
# clean gate.

# Base: the two test hooks (always scoped in Phases C/D, never here).
skip_items=(vitest cargo-test)

# Frontend absent → skip the FE lint/type/architecture hooks.
if [ "$HAS_TS" = "0" ]; then
    skip_items+=(oxlint oxfmt tsc no-hsl-rgb-var-wrap no-direct-sonner-import \
        no-ui-store-imports no-legacy-react-apis check-elevation-tiers \
        check-elevation-tiers-self-test import-cycles store-layering axe-presence \
        test-file-naming ipc-error-path-coverage ipc-error-path-coverage-selftest \
        no-raw-invoke no-raw-invoke-selftest no-raw-local-storage \
        no-raw-local-storage-selftest trace-interactions-named \
        trace-interactions-named-selftest license-checker)
fi
# Backend absent → skip the Rust/cargo/SQL/migration hooks.
if [ "$HAS_RS" = "0" ]; then
    skip_items+=(cargo-fmt cargo-clippy cargo-deny cargo-machete sqruff \
        tauri-command-sanitize tauri-command-instrumented \
        tauri-command-instrumented-selftest check-raw-tx check-raw-tx-self-test \
        check-dynamic-sql check-dynamic-sql-self-test check-command-arity \
        check-command-arity-self-test check-space-filter-drift unsafe-allowlist \
        audit-toml-in-sync migrations-immutable migrations-strict-tables \
        migrations-rebuild-cascade migrations-rebuild-cascade-self-test \
        check-sqlx-cache-drift check-sqlx-cache-drift-self-test)
fi
# CI/tooling absent → skip the workflow/shell lint hooks.
if [ "$HAS_CI" = "0" ]; then
    skip_items+=(actionlint zizmor shellcheck skip-ci-verify-guard)
fi
# Docs absent → skip the Markdown/doc hooks.
if [ "$HAS_DOCS" = "0" ]; then
    skip_items+=(markdownlint md-link-targets doc-vs-code-paths session-log-numbering)
fi

# Compound guards: skip only when EVERY category they straddle is absent, so a
# binding-boundary / cross-cutting hook still runs if ANY adjacent category
# changed.
[ "$HAS_CI" = "0" ] && [ "$HAS_RS" = "0" ] && skip_items+=(taplo-fmt taplo-lint)
# tauri-mock-parity / snapshot-redaction / retired-pending guard the FE↔BE
# binding boundary — they MUST run if frontend OR backend changed.
[ "$HAS_TS" = "0" ] && [ "$HAS_RS" = "0" ] && \
    skip_items+=(tauri-mock-parity snapshot-redaction no-retired-pending-doc-refs)
[ "$HAS_DOCS" = "0" ] && [ "$HAS_TS" = "0" ] && [ "$HAS_RS" = "0" ] && \
    skip_items+=(architecture-citations)
[ "$HAS_TS" = "0" ] && [ "$HAS_CI" = "0" ] && skip_items+=(check-json)
[ "$HAS_RS" = "0" ] && [ "$HAS_CI" = "0" ] && skip_items+=(check-toml)
[ "$HAS_CI" = "0" ] && skip_items+=(check-yaml)

PHASE_A_REQUIRED_SKIP="$(IFS=,; printf '%s' "${skip_items[*]}")"

# #3968 — compose, don't clobber. See phase_a_skip_compose above for why
# this is a union rather than a refusal, and why the result is announced.
CALLER_SKIP="${SKIP:-}"
PHASE_A_SKIP="$(phase_a_skip_compose "$PHASE_A_REQUIRED_SKIP" "$CALLER_SKIP")"
CALLER_SKIP_EXTRA="$(phase_a_skip_extra "$PHASE_A_REQUIRED_SKIP" "$CALLER_SKIP")"
NOT_CI_EQUIVALENT=0
if [ -n "$CALLER_SKIP_EXTRA" ]; then
    NOT_CI_EQUIVALENT=1
    echo ""
    echo "⚠ Honouring caller-supplied SKIP: $CALLER_SKIP_EXTRA"
    echo "  Those hooks will NOT run in Phase A. CI runs them unskipped, so"
    echo "  this run is NOT CI-equivalent and a green result here does not"
    echo "  predict a green there. Unset SKIP for a representative run."
fi

echo ""
echo "→ Phase A: prek run --all-files (pre-commit stage)"
echo "  SKIP=$PHASE_A_SKIP"
if ! SKIP="$PHASE_A_SKIP" prek run --all-files --hook-stage pre-commit; then
    echo ""
    echo "✗ Pre-push verification FAILED at Phase A (prek --all-files)."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi
echo "  ✓ prek --all-files"

# Migrations append-only backstop (#806): the migrations-immutable hook
# scans the STAGED index, which is empty at push time, so a commit made
# with `--no-verify` would sail through Phase A unnoticed. Re-check the
# whole push range for M/D/R/C/T under src-tauri/migrations/*.sql.
if ! bash scripts/check-migrations-immutable.sh --range "$RANGE"; then
    echo ""
    echo "✗ Pre-push verification FAILED: shipped migration changed in range '$RANGE' (#806)."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi
echo "  ✓ migrations append-only over '$RANGE'"

# sqlx cache drift backstop (#3901): same staged-index-is-empty-at-push-time
# gap as the migrations backstop above — check-sqlx-cache-drift's default
# mode scans `git diff --cached`, so re-check the whole push range for a
# `.sqlx/` entry that disappeared from one cache while a sibling cache still
# has it, with no `query!`-family removal in range to justify it.
if ! bash scripts/check-sqlx-cache-drift.sh --range "$RANGE"; then
    echo ""
    echo "✗ Pre-push verification FAILED: sqlx cache drift in range '$RANGE' (#3901)."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi
echo "  ✓ sqlx cache drift guard over '$RANGE'"

# ── Phase B: externalBin placeholder (only if Rust changed) ────────
# Tauri's build.rs validates the externalBin path on every cargo
# invocation; without the placeholder, `cargo nextest` in Phase D
# would fail with a misleading "missing external-binary" error.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase B: externalBin placeholder"
    if ! node scripts/prepare-external-bins.mjs --placeholder-only > /dev/null 2>&1; then
        echo "  ✗ externalBin placeholder setup failed"
        exit 1
    fi
    echo "  ✓ externalBin placeholder"
fi

# ── Phase C: vitest related (scoped to push range) ─────────────────

echo ""
echo "→ Phase C: vitest related (range $RANGE)"
if ! bash scripts/test-related-ts.sh --range "$RANGE"; then
    echo ""
    echo "✗ Pre-push verification FAILED at Phase C (vitest related)."
    echo "  Iterate: bash scripts/test-related-ts.sh --range $RANGE"
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi

# ── Phase D: cargo nextest related (scoped to push range) ──────────

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase D: cargo nextest related (range $RANGE)"
    if ! bash scripts/test-related-rust.sh --range "$RANGE"; then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase D (cargo nextest related)."
        echo "  Iterate: bash scripts/test-related-rust.sh --range $RANGE"
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase D2: cargo test --doc (only if Rust changed) ──────────────
# nextest (Phase D) does NOT execute doc-tests, so a broken `/// ```` example
# would compile-fail invisibly. Run the doc-tests explicitly here so executable
# doc-comment examples on pure helpers stay honest (#2555). Cheap while there
# are few doc-tests; each compiles as its own binary, so scope grows the cost.
#
# `--workspace` (#2951): CI's "Cargo test --doc" step in _validate.yml runs
# `cargo test --doc --workspace` from `src-tauri` — without `--workspace` here
# only the root `agaric` crate's doc-tests ran locally, so a broken doc-test
# on a #2621 member crate (agaric-store/agaric-engine/agaric-sync) compiled
# clean locally and only failed once pushed to CI.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase D2: cargo test --doc --workspace"
    if ! ( cd src-tauri && cargo test --doc --workspace ); then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase D2 (cargo test --doc --workspace)."
        echo "  Iterate: ( cd src-tauri && cargo test --doc --workspace )"
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase E: cargo sqlx prepare --check, ALL FOUR lanes (only if Rust
# changed) ──────────────────────────────────────────────────────────
#
# Mirrors every `sqlx-offline-check` lane in `_validate.yml`: the workspace
# root (`src-tauri`) plus each layered-workspace member with its own
# crate-local `.sqlx/` cache — `agaric-store`, `agaric-engine`, `agaric-sync`
# (#2621 split). Checking only the root here let member-crate cache drift
# (e.g. #2849) slip past local verification and land only visible on CI —
# the exact gap this phase now closes.
#
# All four lanes get their own ABSOLUTE-path throwaway DB under the shared
# per-invocation probe dir (#3257 / #3361) — none of them ever touch the
# developer's real `src-tauri/dev.db`. The root lane used to reuse
# `src-tauri/.env`'s `DATABASE_URL=sqlite:dev.db` directly. That both
# collided across concurrent worktree pushes sharing that file (the same
# class of bug #3257 already fixed for the sub-crates, just on the one path
# that fix left alone) and meant a failed/interrupted run could leave the
# developer's dev.db migrated to a branch's schema they aren't on. Each
# member lane needs its own absolute-path throwaway DB for a second,
# independent reason: `query!` resolves a *relative* sqlite path at compile
# time from rustc's CWD — the WORKSPACE ROOT, not the crate dir — so a
# relative URL there creates the DB under the crate but looks for it under
# `src-tauri/`, failing every query ("unable to open database file"). (The
# root crate IS the workspace root, so that particular hazard never applied
# to it — it gets an absolute-path DB anyway, for the isolation reason
# above.) Each member's `migrations -> ../migrations` symlink lets
# `migrate run` resolve the shared workspace migrations against that
# throwaway DB; the root lane already sits next to `migrations/` directly.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase E: cargo sqlx prepare --check (4 lanes: root, agaric-store, agaric-engine, agaric-sync)"

    sqlx_check_failed=0

    # #3257 / #3361 — per-invocation probe dir, shared by ALL FOUR lanes
    # below (root + the three sub-crates) so none of them touch the real
    # dev database. The trap also covers the `exit 1` path at the end of
    # this phase; no other EXIT trap exists in this script, so it is safe
    # to install here.
    probe_dir="$(sqlx_probe_dir_new)"
    trap 'sqlx_probe_dir_cleanup "$probe_dir"' EXIT

    root_db="$probe_dir/root.db"
    sqlx_log="$(mktemp -t pre-push-sqlx-root.XXXXXX)"
    if ! ( cd src-tauri \
            && DATABASE_URL="sqlite:$root_db" cargo sqlx database create \
            && DATABASE_URL="sqlite:$root_db" cargo sqlx migrate run \
            && DATABASE_URL="sqlite:$root_db" cargo sqlx prepare --check -- --tests \
         ) > "$sqlx_log" 2>&1; then
        echo "  ✗ sqlx prepare check failed (root: src-tauri)"
        tail -100 "$sqlx_log" | sed 's/^/      /'
        sqlx_check_failed=1
    else
        echo "  ✓ sqlx prepare check (root: src-tauri)"
    fi
    rm -f "$sqlx_log"

    for crate in agaric-store agaric-engine agaric-sync; do
        db="$probe_dir/$crate.db"
        sqlx_log="$(mktemp -t "pre-push-sqlx-$crate.XXXXXX")"
        if ! ( cd "src-tauri/$crate" \
                && DATABASE_URL="sqlite:$db" cargo sqlx database create \
                && DATABASE_URL="sqlite:$db" cargo sqlx migrate run \
                && DATABASE_URL="sqlite:$db" cargo sqlx prepare --check -- --tests \
             ) > "$sqlx_log" 2>&1; then
            echo "  ✗ sqlx prepare check failed ($crate)"
            tail -100 "$sqlx_log" | sed 's/^/      /'
            sqlx_check_failed=1
        else
            echo "  ✓ sqlx prepare check ($crate)"
        fi
        rm -f "$sqlx_log"
    done

    if [ "$sqlx_check_failed" = "1" ]; then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase E (sqlx prepare --check)."
        echo "  Iterate: just gen-sqlx (regenerates all 4 caches), then re-check the failing crate(s) above."
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase F: MCP build + UDS smoke + externalBin verify (gated) ────
# Only runs when MCP-related paths are in the push range. The release
# build is the slowest non-test step in the verifier; gating it on the
# narrow MCP surface keeps unrelated pushes fast.

if [ "$HAS_MCP" = "1" ]; then
    echo ""
    echo "→ Phase F: MCP UDS smoke + externalBin verify (MCP paths touched)"

    smoke_log="$(mktemp -t pre-push-mcp-smoke.XXXXXX)"
    if ! ( cd src-tauri && cargo nextest run --features ci-smoke --profile ci \
            -E 'test(stub_binary_roundtrips_initialize_over_uds)' ) > "$smoke_log" 2>&1; then
        echo "  ✗ MCP UDS smoke test failed"
        tail -100 "$smoke_log" | sed 's/^/      /'
        rm -f "$smoke_log"
        exit 1
    fi
    rm -f "$smoke_log"
    echo "  ✓ MCP UDS smoke"

    extbin_log="$(mktemp -t pre-push-extbin.XXXXXX)"
    if ! node scripts/prepare-external-bins.mjs > "$extbin_log" 2>&1; then
        echo "  ✗ prepare-external-bins.mjs (release) failed"
        tail -100 "$extbin_log" | sed 's/^/      /'
        rm -f "$extbin_log"
        exit 1
    fi
    rm -f "$extbin_log"

    if ! src-tauri/target/release/agaric-mcp --version > /dev/null 2>&1; then
        echo "  ✗ agaric-mcp --version failed"
        exit 1
    fi
    HOST_TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
    if [ -z "$HOST_TRIPLE" ]; then
        echo "  ✗ could not resolve host rustc triple"
        exit 1
    fi
    if ! test -x "src-tauri/binaries/agaric-mcp-$HOST_TRIPLE"; then
        echo "  ✗ externalBin artifact missing: src-tauri/binaries/agaric-mcp-$HOST_TRIPLE"
        exit 1
    fi
    echo "  ✓ externalBin (release + --version + artifact for $HOST_TRIPLE)"
fi

# ── Phase G: warn-only audits (do not block push) ──────────────────

echo ""
echo "→ Phase G: warn-only audits (informational)"

audit_log="$(mktemp -t pre-push-audit.XXXXXX)"
if ( cd src-tauri && cargo audit --no-fetch ) > "$audit_log" 2>&1; then
    echo "  ✓ cargo audit (no findings)"
else
    echo "  ⚠ cargo audit had findings (warn-only); review and triage into deny.toml if accepted"
    tail -20 "$audit_log" | sed 's/^/      /'
fi
rm -f "$audit_log"

npm_sig_log="$(mktemp -t pre-push-npm-sig.XXXXXX)"
if npm audit signatures > "$npm_sig_log" 2>&1; then
    echo "  ✓ npm audit signatures (all verified)"
else
    echo "  ⚠ npm audit signatures had findings (warn-only); not every npm dep ships Sigstore provenance yet"
fi
rm -f "$npm_sig_log"

echo ""
echo "✓ Pre-push verification PASSED."
# #3968 — a green earned with caller-supplied skips is not the same green.
# Repeated here because the Phase A warning has scrolled past by now, and
# this banner is the line that gets quoted as "the gate passed".
if [ "$NOT_CI_EQUIVALENT" = "1" ]; then
    echo "  ⚠ NOT CI-equivalent: caller SKIP omitted these Phase A hooks: $CALLER_SKIP_EXTRA"
fi
[ "$HAS_MCP" = "0" ] && echo "  (MCP build skipped — no MCP paths in range; CI will run the full check)"
echo "  (Playwright skipped — runs in CI on every PR; run \`npx playwright test\` locally if needed)"
echo "  (release bundle build: run scripts/verify-release-build.sh manually before tagging)"
