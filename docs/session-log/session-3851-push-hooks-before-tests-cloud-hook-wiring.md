# Session 3851 — Pre-push hooks before the tests; cloud hooks wired early

Two checkboxes of #6560: wire the git hooks in a cloud session as soon as the pre-commit tools exist and stop compiling `cargo-nextest`; and make `scripts/push.sh` run the pre-push hooks (clippy first) before the test phases and before the connection opens. The sqlx-cache experiment and the squash-merge setting from the same issue were not touched.

## What changed

- `scripts/setup-hooks.sh` installs the pre-commit-stage tools, then shellcheck/go/python3, then provisions and wires the hooks, and only then installs `cargo-audit`, `cargo-nextest`, `just`, `lychee`, `sqlx-cli`. `cargo-nextest` goes through `install_nextest`: binstall with `--disable-strategies compile`, else `get.nexte.st`'s tarball, never `cargo install`.
- `scripts/verify-ci-equivalent.sh` has a Phase A2 right after Phase A: `prek run --hook-stage pre-push` over the push range, `verify-ci-equivalent` skipped and the caller's `SKIP` composed in. Self-test case 61 pins A2 above Phase C.
- `scripts/push.sh` pushes with `--no-verify` instead of exporting `SKIP_CI_VERIFY`, unless the caller set `SKIP_CI_VERIFY`, in which case A2 did not run and the push runs the pre-push hooks as before. The `local-rejection` classifier and the "not fully covered" header are gone; the remote failure message now names a non-fast-forward as a cause, since that case used to be classified there.
- `prek.toml`: `check-raw-tx`, `check-dynamic-sql`, `check-table-ownership`, `check-baseline-paths` are pre-commit only (Phase A runs them at push). The `vitest` and `cargo-test` hooks are deleted, along with their entries in `prek_skip_list` and the workflow SKIP lists and comments.
- Docs: `docs/BUILD.md` (cloud hooks, hook toolchain, pre-push table and push.sh paragraph), `CONTRIBUTING.md`, `docs/architecture/ci-and-tooling.md`, `.claude/hooks/session-start.sh`, `scripts/setup.sh`. The approved `AGENTS.md` Pre-push correction: "over the whole tree" became "over the files the push changes"; Phase A has been range-scoped (`--from-ref/--to-ref`) for a while.

## Decisions and traps

- A2 must not re-run inside `git push`'s own hook, where prek has already run the other pre-push hooks (it runs them in file order and `verify-ci-equivalent` is last). prek sets `PRE_COMMIT_REMOTE_NAME` only for a hook run by `git push`, not for `prek run`, checked with a throwaway repo and real prek 0.3.8. A2 is gated on that variable.
- `SKIP_CI_VERIFY='<reason>' scripts/push.sh` must not push with `--no-verify`: the verifier exits before A2, and `no-commit-to-branch` is a pre-push hook CI never runs. The first version did, and in the review a stub harness pushed straight to `main` that way; push.sh now keeps `--no-verify` only when `SKIP_CI_VERIFY` is empty.
- The evidence for the cloud timeline is file mtimes, not the log: `/tmp/agaric-setup-hooks.log` was overwritten by a later session start (every tool "already installed"). In the first boot, `~/.cargo/bin/prek` is 21:09, `taplo` 21:22, the `cargo-nextest` crate source was unpacked into the registry at 21:22 and its binary landed at 21:34, `just` 21:37. Every tool has an unpacked source tree in `~/.cargo/registry/src`, so binstall compiled all of them there. The reorder wires the hooks after `taplo`, not after `just`; the 5-minute target needs prebuilt binaries (the environment setup script) as well.
- The `prek_skip_list` base is now empty, so `--print-skip 1 1 1 1` prints nothing and CI's SKIP can end in a comma. prek ignores empty SKIP entries (checked).

## Checks run

- `bash scripts/verify-ci-equivalent.sh --self-test`: passed (124 ok). Case 61 went red when the A2 block was moved below Phase C, then the file was restored.
- `shellcheck --severity=warning` on every changed script: clean. `prek run --files <changed>`, `prek run --hook-stage manual --files <changed>` and `SKIP=verify-ci-equivalent prek run --hook-stage pre-push --files <changed>`: all passed. `node scripts/check-hook-budget.mjs`: 115/140.
- A stub harness (PATH-stubbed `cargo`, `prek`, `node`, `npm`, a real bare remote) printed the push sequence before and after. Before: tests, then `git push`, then clippy inside the open connection. After: Phase A, Phase A2, tests, `git push --no-verify`; with clippy failing, nothing after A2 runs and no connection opens. A raw `git push` runs the pre-push stage once, and so do `SKIP_CI_VERIFY='<reason>'` with `scripts/push.sh` or a raw `git push`.
- `setup-hooks.sh` in a scratch repo printed `git hooks wired` before `cargo-audit`. Run again with binstall and `cargo install` stubbed to fail, it installed `cargo-nextest` from the prebuilt tarball.
- No cargo: the real clippy-fails-the-push case was not run.
