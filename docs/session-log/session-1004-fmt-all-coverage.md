# Session 1004 — close the `cargo fmt` workspace-coverage gap

Same class of bug as #1879's clippy `--workspace` gap: the per-PR `cargo fmt`
hook ran `cd src-tauri && cargo fmt` **without `--all`**, so it formats only the
root `agaric` package and silently skips the `agaric-diagnostics` member — that
crate's formatting was never enforced and could drift unnoticed.

## Changes

- **prek `cargo-fmt` hook** → `cargo fmt --all` (formats every workspace member).
- **`clippy-clean` weekly lane** (scheduled-deep-checks.yml) gains a
  `cargo fmt --all --check` step (rustfmt component added), so the cold-build
  drift guard now covers formatting as well as clippy.

Diagnostics is already clean under `--all` today; this enforces it going forward.

## Note — build-job gating (investigated, no change)

Also checked whether frontend `src/**` changes can skip the production bundle
check (#812). They can't: the vite production build is an **unconditional step
in the `vitest` job**, which runs on every non-docs PR. The ci.yml `build` job
(gated on `desktop_re`, which excludes `src/**`) is the **Tauri desktop smoke
build** — correctly skipped on frontend-only diffs, since the JS bundle is
already built in the vitest job. Working as designed.
