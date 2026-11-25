# Session 4420 — the open Dependabot updates, in one run

**Ask.** Check and merge the open Dependabot upgrades.

**Shape.** All five PRs (#7025, #7029, #7030, #7031, #7035) were red only on main's `cargo deny` failure (session 4419). Each carries a full CI run, and capacity is the bottleneck, so they land as one PR, one commit per Dependabot group. The Tauri crates (#7029) and the `@tauri-apps` packages (#7025) are one coupled stack, so they are one commit. wry and tao do not move.

**What the bumps needed.** oxlint 1.94 (#7035) no longer reports `new Date()` in `VoiceNoteDialog`'s record handler under `react/purity`, so its disable directive went unused, and the lint job fails unused directives. The directive is deleted. The new `react/rule-suppression` warnings (38) are warnings by design (`.oxlintrc.json`, #4493).

**Ran:** `npm ci`, `npm run lint` (no errors), `oxfmt --check .`, `npm run typecheck`, `cargo deny check` on the combined lockfile, `cargo metadata --locked` on `src-tauri/fuzz`.

**specta under Dependabot.** `specta` and `tauri-specta` were on an ignore rule at every semver level, so a new release candidate never surfaced; its comment still named rc.24, and the workspace is on rc.25. The maintainer chose updates over the hold, so the rule is now a group: `specta`, `specta-*`, `tauri-specta` and `tauri-specta-*` move as one, release candidates included. A bump PR fails `ts_bindings_up_to_date` until `just gen-bindings` runs on its branch. The Loro, mermaid-major and d3-selection 3.0.1 holds stay: a measured quadratic regression, a licence the allowlist refuses, and one broken release.

**What the Tauri bump broke.** `@tauri-apps/api` 2.12.5's mocks deliver a listened event as `{ ...event, id }`, the shape a real Tauri `Event<T>` has. Five tauri-mock tests (`event-bus.test.ts` four, `bridge.test.ts` one) asserted the old shape without `id`: green on main with 2.12.4, red with 2.12.5. They now expect `id: expect.any(Number)` beside the name and payload, as upstream's own example does.

**Pins and libraries past the cooldown.**
- Pins: typos-cli 1.52.2, cargo-audit 0.23.0 (the audit guard exits 0 with it), cargo-nextest 0.9.152, uv 0.13.9 and syft 1.57.2. The repo calls uv only as `uv tool install` / `uv tool dir --bin` and syft only as `syft scan … -o`; both forms hold. cargo-binstall 1.28.0 and temurin are still cooling.
- npm: @tanstack/react-query 5.108.0, i18next 27.1.5, lucide-react 1.74.0. mermaid 12 and d3-selection 3.0.1 stay held.
- Cargo, lock-only: regex 1.13.2, rmcp 3.11.0, uuid 1.29.3, the icu stack at 2.4.0, and the three yanked crates cargo deny warned about (async-executor, chacha20, clipboard-win).
- Left for their own change: notify-rust 4.19 (pulls a second zbus major, whose latest is inside the cooldown), tauri 2.12.7 (the stack moves as one), sqlx 0.9.1 (needs `just gen-sqlx`), iroh 1.5.0 (its own group), url and cookie (gate dates in `deny.toml`), and the majors rfd 0.18, qrcode 0.15, gtk 0.19 / webkit2gtk 3.0 (the wry stack) and specta-typescript 0.0.15 (the specta group).

**Ran (the batch):** `npm run typecheck`, `npm run lint`, vitest in six shards (only the five mock tests above were red, and are green after), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo deny check`, `cargo-audit-guard.sh` with cargo-audit 0.23.0, `node --test scripts/pins.test.mjs`, `node scripts/sync-audit-from-deny.mjs --check`.
