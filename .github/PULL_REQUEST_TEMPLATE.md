<!--
Thanks for sending a patch. Before opening, please skim CONTRIBUTING.md
and AGENTS.md — the bar for getting merged is encoded there.
-->

## Summary

<!--
Why does this change exist? The diff already shows the "what"; this
section is for the "why" and any non-obvious design choices the
reviewer would otherwise have to reverse-engineer.
-->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] Feature (non-breaking, additive)
- [ ] Refactor (no behavioural change)
- [ ] Performance (no behavioural change, measurable speedup)
- [ ] Docs only
- [ ] Chore — build / CI / deps / repo hygiene

## Test plan

<!--
How did you verify this works? Cover both happy and error paths per
AGENTS.md. Paste the relevant command output if it's short.
-->

- [ ] `prek run --all-files` is green locally (all 25+ hooks)
- [ ] New / changed Rust functions have happy-path **and** error-path tests (`cd src-tauri && cargo nextest run`)
- [ ] New / changed React components have render + interaction + `axe(container)` tests (`npm test`)
- [ ] If the change affects desktop bundling, `cargo tauri build` was run on at least one platform
- [ ] If the change affects Android, `cargo tauri android build --target aarch64 --debug` was run

## Schema, IPC and design-system checks

- [ ] **No** new schema migration / op-type / Zustand store / materializer queue / sync message type was introduced *(if any was, it has been discussed with the maintainer first — link the discussion below)*
- [ ] If a `.sql` migration or an inline `sqlx::query!` was added or changed: `cargo sqlx prepare -- --tests` re-run and the regenerated `.sqlx/` cache is committed in this PR
- [ ] If a Tauri command signature or a `specta`-exported type changed: `cd src-tauri && cargo test -- specta_tests --ignored` re-run and the regenerated `src/lib/bindings.ts` is committed in this PR
- [ ] If a UI primitive / pattern was added: it lives in the right layer (`src/components/ui/`, `src/components/`, or `src/hooks/`) and follows the CVA + Radix + `cn()` conventions in AGENTS.md § Mandatory patterns
- [ ] All interactive elements meet the 44 px touch-target minimum and have `aria-label` (icon-only) / `focus-visible:ring-[3px]` styles per AGENTS.md

## Coupled-dependency awareness

If this PR touches `package.json` or any `Cargo.toml`, confirm the relevant **stack** moved together (see AGENTS.md § Coupled Dependency Updates):

- [ ] N/A — no dependencies touched
- [ ] Tauri stack (`tauri`, `tauri-build`, all `tauri-plugin-*` crates, `@tauri-apps/api`, `@tauri-apps/cli`, all `@tauri-apps/plugin-*`)
- [ ] Tauri + Android toolchain (AGP / Gradle wrapper / KGP / `gen/android/buildSrc/`) — bumped via `tauri-cli` regeneration only, not by hand-editing `gen/android/`
- [ ] React ecosystem (`react`, `react-dom`, `@types/react*`, `@testing-library/react`, `@tiptap/*`, `@radix-ui/*`, `react-i18next`, `react-day-picker`, …)
- [ ] TipTap (every `@tiptap/*` package on the same version line)
- [ ] Radix UI (every `@radix-ui/*` primitive on the same major)
- [ ] SQLx + `.sqlx/` cache (`sqlx` crate version + regenerated cache in the same commit)
- [ ] specta + tauri-specta (both pinned to the exact same `=2.0.0-rc.*`)

## Screenshots / recordings

<!--
For UI changes: a before/after screenshot or a short clip. Skip
otherwise.
-->

## Related issues

<!--
"Closes #123" / "Refs UX-249 from REVIEW-LATER.md" /
"Follow-up to <commit-sha>".
-->

---

By submitting this PR I confirm that I have read [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and the [Code of Conduct](../CODE_OF_CONDUCT.md), and that my contribution is licensed under **GPL-3.0-or-later**.
