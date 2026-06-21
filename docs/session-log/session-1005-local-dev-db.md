# Session 1005 — provision the local sqlx dev DB on setup

Reduces `git push --no-verify` reliance for Rust changes by making the local
pre-push verification work out of the box.

## Problem

The pre-push verifier (`scripts/verify-ci-equivalent.sh`, Phase E) runs
`cargo sqlx prepare --check` whenever a push touches Rust — which **connects**
to the DB named by `DATABASE_URL` (`src-tauri/.env` → `sqlite:dev.db`).
`setup.sh` wrote that `.env` but **never created/migrated `dev.db`**, so on a
fresh clone the check errored ("unable to open database file") and the push got
bounced toward `--no-verify`. (The infra was otherwise already present —
`.env.example`, the scoped verify phases — so the gap was just the missing DB.)

## Change

- New **`scripts/setup-dev-db.sh`**: installs `sqlx-cli` if missing (same
  features as CI — `rustls,sqlite`), then `cargo sqlx database create` +
  `cargo sqlx migrate run`. Idempotent → re-run to refresh after pulling new
  migrations. Mirrors the CI provisioning in `_validate.yml`.
- **`setup.sh`** calls it (non-fatal — a frontend-only or offline setup still
  completes, with a warning).
- **`.env.example`** comment now points at the script.

## Verification

- `shellcheck` clean; `setup-dev-db.sh` runs green (DB created + migrated).
- `cargo sqlx prepare --check` passes against the provisioned DB — i.e. a Rust
  push now clears Phase E locally instead of needing `--no-verify`.

## Note

The remaining `--no-verify` pressure is the full-workspace clippy compile +
range-scoped nextest under memory pressure (earlyoom can kill concurrent heavy
pushes). That's an environment/concurrency issue, not a missing-setup one —
serialize hook-heavy pushes; left as-is here.
