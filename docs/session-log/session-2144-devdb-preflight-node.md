# Session 2144 — the dev.db preflight runs on Node

The last Python in the repo's own code was a heredoc in
`scripts/verify-ci-equivalent.sh`: `devdb_migration_gap`, the pre-push
check that `src-tauri/dev.db` has every migration applied, plus the
`python3 -c` builders its `--self-test` fixtures used. The maintainer
asked for it to go too (#5579).

The check is now `scripts/lib/devdb-migration-gap.mjs`, called from the
same bash function with the same interface: exit 0 when caught up, 1 on a
confirmed gap (the push is blocked), 2 when it could not inspect (warn and
continue). It opens dev.db with `node:sqlite` read-only on a plain path,
so a checkout path with `#`, `?` or `%` needs no URI escaping, and a
missing file is never created. Every failure after the file starts runs
through one try/catch that exits 2; `node:sqlite` is imported inside it,
so a Node without it warns rather than blocks.

Node 22.22 loads `node:sqlite` without a flag but prints an
ExperimentalWarning on stderr, which the function folds into its
diagnosis, so it runs with `--no-warnings`; without the flag 15 self-test
cases fail on Node 22 and none on Node 24.

Equivalence with the Python, run side by side on the same fixtures: every
self-test scenario, 23 more `.env`, URL and file-state cases, permission
cases run as an unprivileged user, the real dev.db (caught up) and a copy
with one applied row deleted (behind, naming the file). Every exit code
matches. The reviewer's further ~190 runs found the same, with three
inputs no sqlx-written vault produces: a `.env` starting with a BOM now
resolves `DATABASE_URL` (Python kept the BOM; dotenvy strips it, as the
port now does), a hand-made INTEGER checksum and a version past 2^53 now
warn instead of blocking.

Falsified: comparing only the highest applied version fails exactly the
mid-sequence-gap case; letting a SQLite error read as caught up fails
exactly the corrupt-database case. The self-test runs 118 cases, as
before; 37 and 41 now cover a missing `node` and one exiting 126.

Not covered by the self-test, as before the port: a `success = 0` row, a
NULL checksum, and the read-only flag itself; the reviewer's mutants there
survive.

Ran: `bash scripts/verify-ci-equivalent.sh --self-test` (118) on Node 24
and 22, `shellcheck`, `oxfmt`, type-aware `oxlint`,
`check-hook-budget.mjs`.
