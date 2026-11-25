# Session 4420 — the open Dependabot updates, in one run

**Ask.** Check and merge the open Dependabot upgrades.

**Shape.** All five PRs (#7025, #7029, #7030, #7031, #7035) were red only on main's `cargo deny` failure (session 4419). Each carries a full CI run, and capacity is the bottleneck, so they land as one PR, one commit per Dependabot group. The Tauri crates (#7029) and the `@tauri-apps` packages (#7025) are one coupled stack, so they are one commit. wry and tao do not move.

**What the bumps needed.** oxlint 1.94 (#7035) no longer reports `new Date()` in `VoiceNoteDialog`'s record handler under `react/purity`, so its disable directive went unused, and the lint job fails unused directives. The directive is deleted. The new `react/rule-suppression` warnings (38) are warnings by design (`.oxlintrc.json`, #4493).

**Ran:** `npm ci`, `npm run lint` (no errors), `oxfmt --check .`, `npm run typecheck`, `cargo deny check` on the combined lockfile, `cargo metadata --locked` on `src-tauri/fuzz`.

**specta under Dependabot.** `specta` and `tauri-specta` were on an ignore rule at every semver level, so a new release candidate never surfaced; its comment still named rc.24, and the workspace is on rc.25. The maintainer chose updates over the hold, so the rule is now a group: `specta`, `specta-*`, `tauri-specta` and `tauri-specta-*` move as one, release candidates included. A bump PR fails `ts_bindings_up_to_date` until `just gen-bindings` runs on its branch. The Loro, mermaid-major and d3-selection 3.0.1 holds stay: a measured quadratic regression, a licence the allowlist refuses, and one broken release.
