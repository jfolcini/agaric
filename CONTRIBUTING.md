# Contributing to Agaric

Thanks for your interest in contributing. Agaric is a local-first block-based note-taking app built on Tauri 2 (Rust backend) + React 19 + TipTap (frontend). This file covers how to get a patch accepted. It is deliberately short; deeper material lives in the documents linked below.

## Before you start

- Read [**AGENTS.md**](AGENTS.md) — repository invariants, architectural guarantees, coupled-dependency rules, code style, and mandatory testing conventions. These are strict; PRs that violate them will be asked to re-work.
- Read [**docs/BUILD.md**](docs/BUILD.md) — how to build on Linux / macOS / Windows / Android, required toolchain versions, and common troubleshooting steps.
- Skim [**docs/FEATURE-MAP.md**](docs/FEATURE-MAP.md) and [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) if you want a guided tour of the feature surface before picking something to change.
- Check the [issue tracker](https://github.com/jfolcini/agaric/issues) for items that are already known and triaged.
- Abide by the [**Code of Conduct**](CODE_OF_CONDUCT.md).

## Bootstrap

**One command sets up everything:**

```bash
bash scripts/setup.sh      # or: npm run setup  (identical)  ·  or: just setup  (if you have just)
```

That is the whole dev-environment setup. The script is idempotent — safe to re-run any time — and handles all of it for you:

- **Node** — provisions the version pinned in [`.nvmrc`](.nvmrc) via `nvm` if your active `node` is older (the `engines` floor is `>=24`), so you don't have to match it by hand.
- **Dependencies** — `npm ci` (deterministic install from the lockfile) and Playwright's chromium.
- **`.env`** — copies `src-tauri/.env.example` to the gitignored `.env` beside it (sqlx reads `DATABASE_URL` from it at compile time; skipping this is the classic fresh-clone compile failure).
- **Dev DB** — provisions the local sqlx offline-check database so pre-push Rust checks pass.
- **prek hook toolchain + git hooks** — installs `prek` and every host binary the commit/push hooks shell out to (cargo-deny, sqruff, typos, zizmor, taplo, lychee, shellcheck, `just`, …), then runs `prek install` to wire the git shims (pre-commit, commit-msg, prepare-commit-msg, pre-push, post-commit). This step is best-effort: anything it can't auto-install on your platform prints a manual hint instead of failing, and you can re-run `scripts/setup-hooks.sh` (or `just install-hooks`) any time to fill gaps. See [`docs/BUILD.md` → Hook toolchain](docs/BUILD.md#hook-toolchain) for the full install set (which mirrors CI).

The base toolchain the script builds on — Rust stable (`rustup default stable`) and Tauri's CLI (the pinned `@tauri-apps/cli` devDependency, installed by `npm ci`) — is documented in [`docs/BUILD.md`](docs/BUILD.md).

After bootstrap, every `git commit` runs the fast subset (lint + format + static checks, no tests), every `git push` runs the slower CI-equivalent gate (`scripts/verify-ci-equivalent.sh`, which adds nextest + clippy + knip + lychee + the related-test suites), and the commit message is checked against Conventional Commits. The full surface — including all rules, hook IDs, and stage assignments — lives in [`prek.toml`](prek.toml); the same hooks run again in CI via `.github/workflows/_validate.yml`, so green local prek ⇒ green CI validate.

> **Claude Code on the web / cloud VMs:** bootstrap runs **automatically**. The repo ships a `SessionStart` hook ([`.claude/hooks/session-start.sh`](.claude/hooks/session-start.sh)) that runs `scripts/setup.sh` when `CLAUDE_CODE_REMOTE=true`, so a fresh cloud session lands build- and commit-ready with no manual step. For the fastest startup you can _also_ paste `bash scripts/setup.sh` into your environment's **Setup script** field in the web UI — that runs once and is filesystem-cached across sessions. (One sandbox caveat: prek's three git-cloned hooks — gitleaks, actionlint, conventional-pre-commit — can't be provisioned when the session's git credential is scoped to a single repo, so they stay unwired locally and run in CI instead. Every other hook works.)

If you'd rather wire just the git hooks by hand (e.g. you already have the toolchain): `cargo install --locked prek && prek install` (add `-f` to overwrite stale shims). **If you cannot install prek at all** (e.g. no Rust toolchain): your patch is welcome anyway; CI runs the same gate on the PR.

### Optional: `just` task runner

A [`justfile`](justfile) at the repo root provides short, discoverable aliases for the everyday commands (`just dev`, `just test`, `just check`, `just fmt`, …). It is a thin façade — every recipe shells out to the canonical entry point (`npm` script, `cargo`, `prek`, or a `scripts/*` helper), so `package.json` and `prek.toml` stay the source of truth and the justfile cannot silently drift from them. It is **entirely optional**: nothing in the build, CI, or git hooks depends on it, so you can keep calling the underlying commands directly.

```bash
cargo install --locked just   # one-time install
just                          # list every recipe (alias for `just --list`)
```

The hooks shell out to a handful of host-installed binaries (lychee, typos-cli, shellcheck, zizmor, taplo-cli, …). Install them once via [`docs/BUILD.md` → Developer tools (prek hook host-binaries)](docs/BUILD.md#developer-tools-prek-hook-host-binaries) so a local `prek run --all-files` is green; otherwise individual hooks fail with `command not found`.

**If you cannot install prek locally** (e.g., contributor without Rust toolchain): your patch is welcome anyway; CI will run the same gate on the PR. Open the PR and iterate based on CI feedback.

### Editor setup (VS Code)

Opening the repo in VS Code prompts you to install the workspace-recommended extensions (declared in the tracked [`.vscode/extensions.json`](.vscode/extensions.json)): the OXC extension (`oxc.oxc-vscode`) for oxlint/oxfmt, rust-analyzer (`rust-lang.rust-analyzer`), and Even Better TOML (`tamasfe.even-better-toml`) for taplo. These match the project's toolchain — installing the default Prettier/ESLint extensions instead will fight the repo's formatters. Per-user `.vscode/settings.json` stays local (gitignored).

### Optional: code-review-graph MCP

[AGENTS.md](AGENTS.md) asks AI agents working in this repo to prefer the **code-review-graph** MCP tools (graph queries, impact radius, review context) over raw Grep/Glob/Read. That MCP is **optional** — it is only needed if you drive the repo with an MCP-aware agent, and human contributors can skip it entirely.

It is wired in the tracked [`.mcp.json`](.mcp.json), which launches the server via [`uvx`](https://docs.astral.sh/uv/) (part of the `uv` Python tool runner):

```bash
# Prerequisite: install uv (which provides uvx). See https://docs.astral.sh/uv/.
# .mcp.json then starts the server on demand with:
uvx code-review-graph serve
```

`uvx` fetches and runs `code-review-graph` without a separate global install, so once `uv` is on your `PATH` no extra setup is required. The server must be **running** for the AGENTS.md "use the graph first" workflow to apply; if it is not available, agents simply fall back to Grep/Glob/Read.

## Development workflow

```bash
cargo tauri dev              # Dev mode with hot reload
npm run test                 # Vitest (frontend)
cd src-tauri && cargo nextest run   # Rust tests
prek run --all-files         # Full local gate (mirror of CI's `validate` job)
```

With the optional [`just`](#optional-just-task-runner) runner installed, the same four are `just dev`, `just test-fe`, `just test-be`, and `just check` (and `just test` runs both test suites); run `just --list` for the rest.

### Fixing a format check failure

The pre-commit hooks split formatting by language. If a hook fails:

```bash
npm run format:changed   # oxfmt — fixes JS/TS/JSON in CHANGED files only (vs HEAD; wraps scripts/format-changed.sh)
npm run format:toml      # taplo — fixes TOML (a `taplo fmt --check` failure is NOT fixed by oxfmt)
```

Prefer formatting only the files you changed (as above), since `npm run format` is `oxfmt --write .` — a whole-repo reformat that can produce large unrelated diffs; reserve it for intentional repo-wide passes. (`just fmt` runs both commands above.) Either way, oxfmt only touches JS/TS/JSON and never reformats TOML, so a `taplo fmt --check` hook failure must be fixed with `npm run format:toml`. The `format:toml` script needs the `taplo` binary on `PATH` (`cargo install taplo-cli --locked`).

Every change must:

1. Keep `prek run --all-files` green. The hooks cover oxlint + oxfmt + tsc, vitest, cargo fmt / clippy / nextest / deny / machete, sqruff, license-checker, and the rest of the surface — `prek.toml` is the source of truth.
2. Add tests for new or changed behaviour. Minimum bar per AGENTS.md: happy-path + error-path for exported functions; render + interaction + `axe(container)` for components.
3. Not introduce architectural change without discussion first. The "Architectural Stability" section of AGENTS.md lists the specific guardrails (no new op types, tables, stores, or sync message types without explicit approval).

## Patch submission

- Open a pull request against `main`.
- Use a conventional-commit-style subject (`fix(ux): …`, `feat(sync): …`, `docs: …`, `test(e2e): …`). Body explains the _why_ and any non-obvious design choices.
- Keep commits focused. Rebase + force-push on your PR branch is fine; on `main` is not.
- If your change touches SQL queries, run `just gen-sqlx` and commit all four regenerated `.sqlx/` caches (root + `agaric-store`/`agaric-engine`/`agaric-sync`) in the same commit. Do **not** run the bare `cargo sqlx prepare -- --tests` — it only regenerates the workspace-root cache and silently leaves the three member-crate caches stale, which passes locally but fails their dedicated CI lanes (see AGENTS.md §Key Architectural Invariants #6).
- If your change touches Rust types exposed via Tauri IPC, run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate `src/lib/bindings.ts`.
- Coupled dependency stacks (Tauri + Android; React + ecosystem; TipTap; Radix; SQLx + `.sqlx/`; specta + tauri-specta) must move together per the rules in AGENTS.md §Coupled Dependency Updates. Partial bumps will be rejected.

## Licensing and sign-off

Agaric is released under **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)). By submitting a patch you agree to license your contribution under the same terms.

### Developer Certificate of Origin (DCO)

Every commit on a non-trivial contribution **MUST** carry a `Signed-off-by:` trailer asserting that the contributor has the right to submit the change under the project's existing license. This is the [Developer Certificate of Origin (DCO) v1.1](https://developercertificate.org/), the same mechanism the Linux kernel uses.

To sign off on a commit, use the `-s` flag:

```bash
git commit -s -m "your commit message"
```

Git will append a line like `Signed-off-by: Your Name <your@email>` to the commit message. The name and email must match the commit author and be a real identity (no pseudonyms, but pseudonymous accounts are fine if consistently used). Per the DCO text:

> By making a contribution to this project, I certify that:
>
> 1. The contribution was created in whole or in part by me and I have the right to submit it under the open source license indicated in the file; or
> 2. The contribution is based upon previous work that, to the best of my knowledge, is covered under an appropriate open source license and I have the right under that license to submit that work with modifications, whether created in whole or in part by me, under the same open source license (unless I am permitted to submit under a different license), as indicated in the file; or
> 3. The contribution was provided directly to me by some other person who certified (a), (b) or (c) and I have not modified it.
> 4. I understand and agree that this project and the contribution are public and that a record of the contribution (including all personal information I submit with it, including my sign-off) is maintained indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

The project deliberately uses DCO instead of a Contributor License Agreement (CLA). The reason is explicit: a CLA would let the maintainer unilaterally relicense the project (including to a non-FLOSS license — the "rugpull" pattern). DCO is a lightweight per-commit assertion that does not transfer copyright; any future relicense would require obtaining permission from every individual contributor. That is the GPL family's standard guard against governance capture, and Agaric preserves it on purpose. See [`GOVERNANCE.md`](GOVERNANCE.md) for the broader rationale.

If you forgot the sign-off on a commit:

- For your most recent commit: `git commit --amend -s --no-edit && git push --force-with-lease`.
- For earlier commits: `git rebase --signoff <base-sha>` then force-push.

## Maintainer workflow

The maintainer uses a PLAN → BUILD → REVIEW → MERGE → COMMIT → LOG pipeline, often driving AI subagents in parallel. You do not need to replicate this workflow to contribute — a plain PR with green `prek` is enough.

## Asking questions

Open a GitHub Discussion or a draft PR with `[WIP]` in the title. Please do not ping the maintainer privately for code-review questions — keeping them in the open lets future contributors benefit.
