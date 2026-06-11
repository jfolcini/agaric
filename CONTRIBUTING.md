# Contributing to Agaric

Thanks for your interest in contributing. Agaric is a local-first block-based note-taking app built on Tauri 2 (Rust backend) + React 19 + TipTap (frontend). This file covers how to get a patch accepted. It is deliberately short; deeper material lives in the documents linked below.

## Before you start

- Read [**AGENTS.md**](AGENTS.md) — repository invariants, architectural guarantees, coupled-dependency rules, code style, and mandatory testing conventions. These are strict; PRs that violate them will be asked to re-work.
- Read [**docs/BUILD.md**](docs/BUILD.md) — how to build on Linux / macOS / Windows / Android, required toolchain versions, and common troubleshooting steps.
- Skim [**docs/FEATURE-MAP.md**](docs/FEATURE-MAP.md) and [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) if you want a guided tour of the feature surface before picking something to change.
- Check the [issue tracker](https://github.com/jfolcini/agaric/issues) for items that are already known and triaged.
- Abide by the [**Code of Conduct**](CODE_OF_CONDUCT.md).

## Bootstrap

The toolchain set is documented in [`docs/BUILD.md`](docs/BUILD.md): Rust stable (`rustup default stable`), Node 24 LTS (pinned in [`.nvmrc`](.nvmrc)), and Tauri's CLI. On top of that, two one-time installs wire up the local pre-commit / pre-push checks:

```bash
# 1. Install prek (Rust reimplementation of pre-commit; no Python toolchain needed).
cargo install --locked prek

# 2. Wire all five git shims (pre-commit, commit-msg, prepare-commit-msg,
#    pre-push, post-commit) to invoke prek. The shim list is declared via
#    `default_install_hook_types` in prek.toml, so plain `prek install`
#    writes all of them.
prek install

# Already cloned before the commit-msg shim was added? Re-run once with -f
# to overwrite the existing shims and pick up the new commit-msg hook (this
# is what makes the Conventional-Commits check actually fire locally):
prek install -f
```

After this, every `git commit` runs the fast subset (lint + format + static checks, no tests), every `git push` runs the slower CI-equivalent gate (`scripts/verify-ci-equivalent.sh`, which adds nextest + clippy + knip + lychee + the related-test suites), and the commit message is checked against Conventional Commits. The full surface — including all rules, hook IDs, and stage assignments — lives in [`prek.toml`](prek.toml); the same hooks run again in CI via `.github/workflows/_validate.yml`, so green local prek ⇒ green CI validate.

**If you cannot install prek locally** (e.g., contributor without Rust toolchain): your patch is welcome anyway; CI will run the same gate on the PR. Open the PR and iterate based on CI feedback.

## Development workflow

```bash
cargo tauri dev              # Dev mode with hot reload
npm run test                 # Vitest (frontend)
cd src-tauri && cargo nextest run   # Rust tests
prek run --all-files         # Full local gate (mirror of CI's `validate` job)
```

Every change must:

1. Keep `prek run --all-files` green. The hooks cover oxlint + oxfmt + tsc, vitest, cargo fmt / clippy / nextest / deny / machete, sqruff, license-checker, and the rest of the surface — `prek.toml` is the source of truth.
2. Add tests for new or changed behaviour. Minimum bar per AGENTS.md: happy-path + error-path for exported functions; render + interaction + `axe(container)` for components.
3. Not introduce architectural change without discussion first. The "Architectural Stability" section of AGENTS.md lists the specific guardrails (no new op types, tables, stores, or sync message types without explicit approval).

## Patch submission

- Open a pull request against `main`.
- Use a conventional-commit-style subject (`fix(ux): …`, `feat(sync): …`, `docs: …`, `test(e2e): …`). Body explains the _why_ and any non-obvious design choices.
- Keep commits focused. Rebase + force-push on your PR branch is fine; on `main` is not.
- If your change touches SQL queries, run `cargo sqlx prepare -- --tests` and commit the regenerated `.sqlx/` files in the same commit.
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

The maintainer uses a PLAN → BUILD → REVIEW → MERGE → COMMIT → LOG pipeline, often driving AI subagents in parallel (see `PROMPT.md` if you want the full recipe). You do not need to replicate this workflow to contribute — a plain PR with green `prek` is enough.

## Asking questions

Open a GitHub Discussion or a draft PR with `[WIP]` in the title. Please do not ping the maintainer privately for code-review questions — keeping them in the open lets future contributors benefit.
