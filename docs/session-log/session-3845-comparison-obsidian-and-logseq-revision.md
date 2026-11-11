# Session 3845 — Agaric vs Obsidian, and the Logseq comparison revised

Part of a whole-application audit. The app is meant to compete with both Logseq and Obsidian, but only the Logseq comparison existed and it described v0.20.0.

## What shipped

- `COMPARISON-OBSIDIAN.md`, new. Same method and status key as `COMPARISON.md`: Agaric rows cite a path or PR at `db1628007` (v0.23.0), Obsidian rows a primary source fetched on 2026-11-11, and what could not be verified is labelled.
- `COMPARISON.md`, revised to 2026-11-11 against the same commit. Its Part 10 lists every change and every row carried forward unread.

## Decisions and traps

- Each document was written by one agent and fact-checked by a second that had not seen the first's reasoning. Both checks found overclaims for Agaric, the failure the Logseq document had already been corrected for twice.
- The Obsidian draft carried hand-assigned scores that did not trace to rows. The check replaced them with a count of rows by status.
- The Logseq revision scored Agaric on `main` and Logseq 2.0 on its release. The two-way Markdown mirror's reading half merged on 2026-11-11 and is in no release, so released Agaric is one-way, as 2.0 is. Rows and the scorecard now say which is which.
- History is bounded: `op_log_compact` prunes ops older than 90 days and Trash purges at 90 days. The Obsidian document says so; `docs/features/views.md` does not yet.
- The first pass ran on a 50-commit shallow clone, so `15f3f9705..HEAD` did not resolve. The check ran after the history was deepened.
- `scripts/check-doc-code-paths.mjs` names `COMPARISON.md` in `DOC_ROOTS` and not the new file, so the new file's path citations are unguarded. Adding it may trip on literals such as `.obsidian/`.

## Found in other docs, not fixed here

- `docs/features/agent-access.md` lists 19 read-write tools; the registry has 20.
- `docs/FEATURE-MAP.md` cites #4554 for outstanding reminder work; it is closed.
- `docs/features/pickers-and-slash.md` and `docs/features/tags-and-links.md` disagree on `[[` targets and `/embed`.
- `README.md` describes a transport, journal modes, property types and task keywords the code does not have.

## Verification

`markdownlint-cli2`, `scripts/check-doc-code-paths.mjs` and `scripts/check-md-link-targets.mjs` pass on both files; `typos` passes on the new one. No app or test suite was run: these are documents, and every runtime claim in them is labelled unverified.

## The audit waivers, in the same PR

The audit found that all three `.nsprc` waivers lapsed on 2026-11-12, after which `npm audit` fails `lint` on the minimatch advisory. It rides this PR because the session may push to one branch.

- minimatch (GHSA-g3hv-75wg-m249): still unfixed for the 10.x consumers. `mocha` 12.0.3 declares `^10.2.2` and `@stryker-mutator/core` 10.1.1 declares `~10.2.4`. Both keys extended to 2026-12-10.
- braces (GHSA-vfj7-8cjw-p6xm): dropped. `npm audit` no longer reports it and OSV returns nothing for `braces@3.0.3`.
- `npx better-npm-audit audit` passes; `osv-scanner.toml` regenerated with `scripts/sync-audit-from-deny.mjs`.
