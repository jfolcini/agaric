# Tauri 2.10 → 2.11 migration — 2026-05-13

> **Status:** **blocked — needs upstream fix** (dependabot PR #1).
> Tauri 2.11.x changed the internal symbol scheme that
> `tauri-specta::collect_commands!` / `agaric_commands!` rely on;
> two attempted fixes (Session 707) both failed to resolve the macro
> path mismatch. Tracked here so the security advisory motivating the
> bump (Tauri Origin Confusion Issue, dependabot alert, medium
> severity) is not lost.

## Investigation log — Session 707 (2026-05-13)

Two paths attempted and ruled out:

**Path 1 — upgrade `tauri-specta` in lockstep.** Bumped `specta` /
`specta-typescript` / `tauri-specta` to `=2.0.0-rc.25` (the latest
available) alongside `tauri = 2.11.1`. `tauri-specta` rc.25 still
delegates to `tauri::generate_handler!` internally (see
`/home/javier/.cargo/registry/src/.../tauri-specta-2.0.0-rc.25/src/macros.rs:42-50`),
which builds the macro path by appending `__tauri_command_name_<cmd>`
to the **last segment of the function path**. For
`$crate::commands::create_block`, generate_handler looks up
`commands::__tauri_command_name_create_block!()` — but in tauri-macros
2.6.1 (`/home/javier/.cargo/registry/src/.../tauri-macros-2.6.1/src/command/wrapper.rs:299`)
the macro is now generated with `#[macro_export]` placing it at the
**crate root** (`agaric::__tauri_command_name_create_block`). Path
mismatch → 120 `E0433: cannot find __tauri_command_name_<cmd> in
commands` errors. Verdict: **needs upstream tauri-specta release that
matches the new tauri 2.11 macro layout**, or a tauri-side fix to
generate_handler that handles macro_export'd macros at the crate root.

**Path 2 — pass unqualified command names to `collect_commands!`.**
Rewrote `agaric_commands!` to expand to `{{ use $crate::commands::*;
::tauri_specta::collect_commands![create_block, edit_block, …] }}`,
so generate_handler would mutate `create_block` →
`__tauri_command_name_create_block!()` (no module prefix). The
macro_export'd macros at the crate root are accessible by short name
from anywhere in the crate via the 2015 macro scope rule. **Did not
work** — rustc reported `cannot find macro
__tauri_command_name_<cmd>` for many of the commands, with a hint
suggesting `__cmd__<cmd>` as a similar name. Investigation suggests
tauri 2.11 may have changed which symbols are macro_export'd
versus module-scoped, and that the `pub use crate::name;` re-export
trick fails with `error: macro-expanded macro_export macros from the
current crate cannot be referred to by absolute paths`.

## Recommended path forward

**Wait for an upstream fix.** Either:

1. **tauri-specta releases a new RC** that adapts to the new tauri
   2.11 macro layout. The maintainer (`oscartbeaumont`) has historically
   tracked tauri's breaking changes within a few weeks.
2. **tauri's `generate_handler!` is fixed** to either resolve the
   macro at the crate root automatically, OR to not require the
   path-appended macro form.

Once one of these lands, retry the lockstep bump:

```bash
cargo update --precise <new_version> tauri-specta --manifest-path src-tauri/Cargo.toml
cargo update --precise 2.11.1 tauri --manifest-path src-tauri/Cargo.toml
```

…and re-run the full nextest suite.

**Alternative:** vendor `tauri-specta` locally and patch
`collect_commands!` to look up the macro at the crate root
(`$crate::__tauri_command_name_<cmd>!()`). The fork would be small
(macros.rs is ~50 lines). Carries the cost of tracking upstream until
the real release lands.

## The breaking change

Tauri 2.10.x exposes a per-command symbol named
`__tauri_command_name_<command>` that `tauri-specta::collect_commands!`
discovers at macro-expansion time. Tauri 2.11.x removed or renamed
that symbol — every `$crate::commands::<name>` path inside the
`agaric_commands!` macro (around 120 entries at `src-tauri/src/lib.rs:64`)
fails to resolve, all with the same `E0433: cannot find
__tauri_command_name_<command>` error.

Two ways through the wall:

1. **Upgrade `tauri-specta` in lockstep.** Check whether a newer
   `tauri-specta` release (≥ 2.0.0-rc.25? or the 2.0.0 stable line)
   has caught up to the new Tauri scheme. The Cargo.toml currently
   pins `tauri-specta = { version = "=2.0.0-rc.24", … }`. If yes,
   bump both together — minimal code change.
2. **Replace `collect_commands!` with `tauri::generate_handler!`.**
   Tauri's own handler-collection macro stayed stable across the
   2.10 → 2.11 boundary; switching to it would unblock the bump.
   Cost: TS-binding generation for those commands moves out of
   `tauri-specta` and into a separate explicit step. Affects every
   `*_inner` Tauri command shape.

Option 1 is the cheap path if a compatible `tauri-specta` exists.
Option 2 is the durable path if upstream lags.

## Why we don't merge dependabot PR #1 as-is

The PR runs against a stale main snapshot and so its CI failure
is a mix of "main has moved" and "the bump breaks compilation"
— both classes of failure surface as `validate / validate
FAILURE` on the PR. Even after a rebase to current `main`, the
120-error compilation failure described above persists. Merging the
PR without doing one of the two paths above is a non-starter.

## Affected files

- `src-tauri/Cargo.toml`: `tauri`, `tauri-build`, `tauri-runtime-*`,
  `tauri-codegen`, `tauri-macros`, `tauri-specta`, `tauri-plugin-*` —
  several need coordinated version bumps.
- `src-tauri/src/lib.rs`: the `agaric_commands!` macro at
  `:64` is the entry point that breaks. Option 2 would replace this
  macro with a direct `tauri::generate_handler!` invocation.
- `src/lib/bindings.ts`: TS bindings are regenerated by
  `cargo test -- specta_tests --ignored`; under option 2 a different
  emission path may be needed.

## Cost

- **Option 1 (lockstep `tauri-specta` bump):** S–M if a compatible
  release exists; verify via `cargo search tauri-specta` and the
  upstream changelog.
- **Option 2 (move off `tauri-specta`):** M. The codebase has
  ~120 commands; each needs a small adjustment + the binding-emit
  step has to be re-plumbed.

## Verification when picked up

1. `cargo build --manifest-path src-tauri/Cargo.toml` — should
   compile cleanly.
2. `cd src-tauri && cargo test -- specta_tests --ignored` — TS
   bindings regen.
3. `cd src-tauri && cargo nextest run` — full test suite.
4. `npx vitest run` — frontend tests still pass with new bindings.
5. Manual smoke: launch `npm run tauri dev` and click through every
   nav-item (Pages, Agenda, Tags, Trash, Settings, etc.) to surface
   any IPC contract drift.

## Security context

Dependabot flagged `tauri = "2.10.3"` for "Origin Confusion Issue
that Allows Remote Pages to Invoke Local-Only commands" (medium
severity). Practically the agaric app does not load remote pages
in its WebView (it's a local-first desktop app with no public web
surface), so the practical exploit surface is small. But: the
advisory is real, and the bump is the long-term right answer when
the migration cost is acceptable.

## Related

- Dependabot PR #1: `chore(deps): bump tauri from 2.10.3 to 2.11.1`.
  Leave open; this plan file is the discussion thread.
- Tauri release notes for 2.11.0 / 2.11.1 (upstream).
- `tauri-specta` changelog — pinned `=2.0.0-rc.24`.
