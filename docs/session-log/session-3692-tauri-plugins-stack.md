# Session 3692 — Tauri plugin stack in one commit

Dependabot split one Tauri plugin update across #6440 (npm), #6444 (cargo) and #6448 (the fuzz lock), with #6459 a later copy of #6448. Split, each one fails the npm/cargo version-agreement check. This PR moves the whole stack together, as `AGENTS.md` § Coupled Dependency Updates requires, and replaces all four.

## The change

- **Versions:**
  - shell 2.6.0, notification 2.8.0 and updater 2.14.1 on both sides.
  - deep-link 2.6.3 on npm only; the crate was already on 2.6.3.
  - single-instance 2.5.5 on cargo only.
- **npm, redone from `main`:** #6440's lock predates `main`'s `@vitejs/plugin-react` bump and would have reverted it.
- **notification 2.8.1** is out on both registries. `.npmrc`'s seven-day `min-release-age` refuses it, so both sides stay on 2.8.0.
- **Cargo locks:** both take only the four plugin entries. `cargo update --precise` re-pointed unrelated `windows-sys` and `syn` edges, so it was not used; `cargo metadata --locked` validates both locks. `wry` and `tao` do not move.
- **rmcp:** #6448 also carried rmcp 3.8.0 for the fuzz lock. It was not held on purpose; the fuzz lock had just fallen behind. #6453 moved both locks to 3.9.0 for RUSTSEC-2026-0462, so it is left out here.

## Why the three were red

- #6440's `build` and `e2e-tauri-gate` failed the version-agreement check.
- #6444's and #6448's `lint` was `cargo deny` on two new advisories against `main`'s lock, fixed by #6453.
