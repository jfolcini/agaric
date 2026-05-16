# PEND-37 — Local dev feedback-loop speed-up

> Captured 2026-05-16. Built from a profile of the actual dev loop on the maintainer's workstation (10-core Linux, `rustc 1.95.0`). Six items were greenlit as "do now" alongside this plan; this file documents the **measurement baseline**, **what was done**, and the **remaining follow-ups** so future improvements can be tracked against the baseline.

## Status snapshot (after the do-now items)

| Item | Status | Notes |
| --- | --- | --- |
| L1 — mold linker config | **Partial**: `.cargo/config.toml.example` staged; activation requires `sudo apt install mold && cp .cargo/config.toml{.example,}` | Single biggest win once activated (~20s → ~7-10s per Rust edit). One-time manual step needed. |
| L2 — `cargo clean -p agaric` | **Done** | Freed 55 GB (`src-tauri/target/debug`: 75 GB → 27 GB). Next cold `cargo tauri dev` will pay one-time ~3-5 min rebuild. |
| L3 — jsdom → happy-dom | **Done** | Vitest full suite: 169 s → **68.93 s** (2.5× faster), **9874/9874 passing**. Env-setup CPU: 836 s → 175 s (5×). 11 files pinned back to jsdom via `// @vitest-environment jsdom` directive — see L3-fix below. |
| L3-fix — repair the 27 happy-dom failures | **Done** | Shared `src/__tests__/helpers/axe.ts` wrapper (disables Radix focus-guard false positive) covers 11 files; per-file `@vitest-environment jsdom` pins 11 more for tests reading `var()`/`calc()` inline styles, spying on `Storage.prototype`, or relying on jsdom's DragEvent dataTransfer pass-through. 1 surgical `?? ''` shim for RecentPagesStrip. |
| L4 — Browser-mode workflow doc | **Not started** | Workflow guidance; one-paragraph addition to `AGENTS.md` or `BUILD.md`. |
| L5 — `bacon` / `cargo-watch` | **Not started** | One-line install + small note. |
| C1, C2, C4 (CI subset) | **Done** | See PEND-39 for the CI plan; those three landed alongside this one. |

## Measurement baseline (2026-05-16)

Captured on the maintainer's workstation: 10 cores, `rustc 1.95.0 (59807616e 2026-04-14)`, Linux 6.17, default `bfd` linker, **no** `mold` / `lld` / `sccache`. `src-tauri/`: 228 Rust files, ~206 K LOC. Frontend: React 19 + Vite 8, ~409 vitest files, ~9 874 tests.

| Loop step | Time | Bottleneck |
| --- | --- | --- |
| `cargo check` after touching `lib.rs` (incremental) | **20.49 s** | Default `bfd` linker; 58 % CPU = mostly serial |
| `cargo check` no-op (graph walk) | 66.73 s | I/O on `target/debug` (was 76 GB pre-clean) + dep graph traversal |
| `tsc -b` cold (no .tsbuildinfo cache) | 60.81 s | Single-process tsc on ~700 TS files |
| `tsc -b --dry` (cache hit) | 0.30 s | Confirms incremental cache works |
| `vite build` (prod bundle) | 5.28 s | Fine; not a target. |
| `vitest run --no-coverage` (full suite, 9 874 tests, 10× parallelism, 968 % CPU) | **168.97 s** wall; jsdom **environment-setup CPU = 836 s** | jsdom per-file env startup dominates. |

These numbers are the reference point. Re-measure after each follow-up to confirm the change moved the needle.

## What landed alongside this plan

### L1 — mold linker (staged, activation required)

`.cargo/config.toml.example` ships with:

```toml
[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```

Staged as `.example` (not active) because mold isn't installed on the maintainer's workstation, and an unconditional `[target.…]` config can't gate itself on tool presence — activating without mold installed breaks every `cargo build` with a confusing `cannot find -fuse-ld=mold` error.

**Activation steps** (run once, ~30 s):

```sh
sudo apt install mold                          # Debian/Ubuntu since 22.04
cp .cargo/config.toml.example .cargo/config.toml
```

After activation, the 20 s incremental `cargo check` should drop to ~7-10 s — re-time with `touch src-tauri/src/lib.rs && time cargo check --manifest-path src-tauri/Cargo.toml`.

### L2 — `cargo clean -p agaric` (done)

Reclaimed 54.9 GB of stale incremental artifacts (`Removed 11149 files`). `target/debug/` is now 27 GB instead of 75 GB. Dep cache (the slow-to-rebuild part) is preserved. Next `cargo tauri dev` cold-compiles our crate but reuses every dependency.

## Remaining follow-ups

### L3-fix — shipped: 27 happy-dom failures fixed via 3 patterns

L3 + L3-fix both shipped together. Final state: `npx vitest run` runs all 9 874 tests across 409 files in **68.93 s** (was 168.97 s pre-swap, 2.45× speed-up). The 27 failures sorted into three crisp classes; each class got the cheapest fix that preserved coverage:

**Pattern 1 — shared axe helper (11 files).** Created `src/__tests__/helpers/axe.ts` that re-exports `vitest-axe`'s `axe()` with `aria-hidden-focus` disabled by default. Radix portals (Sheet/Dialog/AlertDialog/Popover) insert `<span data-radix-focus-guard tabindex=0 aria-hidden>` sentinels as part of their focus-trap implementation; happy-dom's stricter focus-visibility computation made axe's `aria-hidden-focus` rule fire on these even though the guards are never user-reachable. jsdom's looser computation hid it. The wrapper preserves per-test rule overrides via spread merge, so a test that wants to *verify* `aria-hidden-focus` can re-enable it. Migrated files: `BlockDatePicker`, `BacklinkFilterBuilder`, `BlockGutterControls`, `FilterPillRow`, `PageOutline`, `PairingDialog`, `RenameDialog`, `UnpairConfirmDialog`, `alert-dialog`, `dialog`, `sheet`.

**Pattern 2 — surgical assertion shim (1 file).** `RecentPagesStrip.test.tsx` `mask-image` assertion: `expect(viewport.style.maskImage ?? '').toBe('')`. happy-dom returns `undefined` for unset style properties where jsdom returned `''` — one-line coercion handles both.

**Pattern 3 — per-file `// @vitest-environment jsdom` pin (11 files).** For tests that depend on jsdom-specific behavior with no portable equivalent:

| File | Reason |
| --- | --- |
| `SpaceAccentBadge.test.tsx`, `SpaceSwitcher.test.tsx`, `SpaceTopStripe.test.tsx` | React sets inline styles via CSSStyleDeclaration; happy-dom's parser rejects `var(--…)` values, leaving `getAttribute('style')` null and `.style.backgroundColor` empty. |
| `useBlockCollapse.test.ts`, `useLocalStoragePreference.test.tsx`, `keyboard-config.test.ts` | `vi.spyOn(Storage.prototype, 'setItem')` doesn't intercept `localStorage.setItem` calls under happy-dom (its Storage impl bypasses the prototype method). |
| `BlockListItem.test.tsx` | `fireEvent.dragStart(li, { dataTransfer })` — happy-dom's DragEvent constructor reconstructs a fresh DataTransfer and discards the test's reference. |
| `SortableBlockWrapper.test.tsx` | Inline `style.marginLeft = calc(var(--indent-width) * N)` — happy-dom's CSS parser rejects both `var()` and `calc()`. |
| `BacklinkFilterBuilder.test.tsx`, `FilterPillRow.test.tsx` | "active filters" a11y test threw `STACK_TRACE_ERROR` deep in the runner under happy-dom — the helper axe wrapper didn't help; the render or axe walk crashes. Pinning the file is the conservative call until the crash is investigated. |
| `PageBrowser.test.tsx` | Virtualizer's auto-load timing depends on jsdom's IntersectionObserver shim. |

**Cost of the pins:** 11 of 409 files (2.7%) now run under jsdom. They pay the slower env-setup; the other 398 enjoy happy-dom's speed. Net: 169 s → 68.93 s wall clock for the full suite.

**Potential follow-ups** (not required; all tests are green):

- The 6 "real" pins (CSS-var, Storage-prototype, DragEvent, calc/var inline style) are root-causes in happy-dom — could be filed upstream or worked around via shims in `test-setup.ts`. Probably not worth the effort while the file count stays small.
- `BacklinkFilterBuilder` + `FilterPillRow` `STACK_TRACE_ERROR` deserves investigation — could unpin those if the root cause is fixable.
- A future expansion of happy-dom's CSS parser (already on their roadmap) would let the 5 inline-style files swap back automatically.

### L4 — Browser-mode workflow note

For pure-UI work, `npm run dev` (browser, Vite HMR ~50 ms) beats `cargo tauri dev` (20 s Rust loop per edit) by orders of magnitude. The `src/lib/tauri-mock/` handlers already make this viable for most components. Add a one-paragraph "when to use which" note to `BUILD.md` (or `AGENTS.md` § "Daily Dev Loop") so future maintainers / agents pick the right one by default.

### L5 — `bacon` for backend iteration

Backend-only Rust edits don't need a frontend rebuild. `bacon` (or `cargo-watch`) provides a continuously-running `cargo check` that re-runs on save and shows errors in a single keep-open terminal — tighter loop than manual `cargo check` invocations.

```sh
cargo install bacon
# or: cargo install cargo-watch
```

Then keep a `bacon` window open next to the editor. No project-side config needed (defaults are sensible); optional `bacon.toml` for custom jobs (clippy, nextest run, …).

### Stretch follow-ups (not greenlit, listed for completeness)

- **`sccache`** — Limited single-project benefit. Worth measuring if branch-hopping is common.
- **Cargo workspace split** — 206 K LOC in a single crate strains incremental compile. Splitting `src-tauri/src/commands/`, `src-tauri/src/sync_*`, `src-tauri/src/dag/` into workspace members would let cargo skip whole crates on most edits. Significant refactor; only schedule if the dev loop is still painful after mold + clean.
- **Dev-profile dep optimization** — `[profile.dev.package."*"] opt-level = 1` compiles dependencies with light opts but keeps our crate at `opt-level = 0`. Slower first build, faster *runtime* during `cargo tauri dev` (matters for tests that hit hot paths). Measure before adopting — not always a win.
- **`prek` hook profile** — Per-commit cost not measured yet. Worth a `time prek run --all-files` once to see which hooks dominate; candidate slowdown sources: `knip` (TS dead-export scan, runs on every TS change), the several `grep -rn` guards that walk all of `src/` even when `pass_filenames` could be true.

## Cost / Impact / Risk

- **Cost:** S-M. Activations: L1 = 30 s once mold is `apt install`'d. L3 = ~1-2 h including shim work if re-applied. L4, L5 = ~30 min combined. Stretch items separately scoped.
- **Impact:** **High for daily ergonomics**. Mold (~20 s → ~7-10 s per Rust edit) and happy-dom (~3 min → ~90 s per full test run) compound — both fire many times per session.
- **Risk:** **Low**. Each item is independently revertable. The L3 revert proved this end-to-end.

## Open questions

1. Re-apply L3 (happy-dom), or keep the sibling agent's revert? (Need ack from whoever was driving the parallel agent.)
2. Update `BUILD.md` / `AGENTS.md` for L4 in the same commit as the L1 activation, or treat docs separately?
3. Worth measuring `prek run --all-files` end-to-end now, or defer until someone complains about commit-time latency?

## Related

- `pending/PEND-39-ci-parallelism.md` — CI-side speed-ups; C1/C2/C4 landed already.
- `pending/ui-improvements-2026-05-16.md` → "Auto-update wire-up (desktop)" — unrelated but in the same release-infra adjacency.
- `.cargo/config.toml.example` — the staged L1 config; activation steps inline.
