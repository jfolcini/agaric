# Session 1378 — Checking the lines the path fix could not check (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder (with read-only verification subagents), one adversarial reviewer |
| **Items closed** | `#4244`, `#4245` |
| **Items modified** | — |
| **Tests added** | +10 guard self-test assertions (4 in types-erasure, 6 scenarios in doc-code-paths) |
| **Files touched** | 10 — see the PR's file list |

**Summary:** two leftovers from the guard work earlier in this series.

**#4244 — the burndown fixed paths, not lines.** `check-doc-code-paths.mjs` strips `:N` before
checking anything: it verifies the **file exists**, never that the **line is right**. So #4181's
mechanical basename→path rewrite inherited whatever staleness was already there — and then
dressed it in an authoritative-looking repo-rooted path, which makes a wrong citation *harder*
to doubt, not easier.

The population was established rather than estimated: the exact **172** citations that burndown
rewrote, cross-referenced against its own commit's diff. (The follow-up issue guessed "roughly
100 unchecked" — the real remainder was larger.) Each was verified by reading the citing prose
against the lines it points at.

**10 had drifted (~6%)**, plus one found incidentally while confirming a fix. All same-file,
stale-line drift this round — no wrong-file cases, unlike the review sample that prompted the
issue. Corrections span `op.rs`, `KeyboardTab.tsx`, `engine.rs` (three sites, two different
wrong lines), `queries.rs` (three sites, one off-by-one and two pointing at a section that
moved ~100 lines), `useSyncTrigger.ts` and `App.tsx`.

**On symbols vs line numbers:** the plan was to prefer citing a symbol name, since it survives
the next split. Checked first — the guard has **no symbol-citation form** (`isLocalPathCandidate`
rejects `::`, and a bare name with no line suffix is not scanned at all), so the corrected
citations stay as verified line numbers rather than adopting an unenforced format that nothing
would keep honest.

**A warning, deliberately not a failure.** The guard now warns when a cited line number exceeds
the target file's current length. That catches the most egregious drift for free.

It must not fail, and the tree proves why: `platform.test.ts` cites `tauri.ts:1871` against a
106-line file, and the surrounding test asserts that anchor's **absence** — a deliberately
historical negative reference. A hard check would redden the build on a *correct* citation. The
warning path is wired so `warnings` never joins the failure flag, pinned by a self-test scenario
where a warning coexists with a real failure without masking it.

**#4245 — teaching the guard about ambient blocks.** `check-types-erasure.mjs` is a flat token
walk, so a value declared inside `declare module '...' { … }` — the standard TS
module-augmentation pattern — was flagged as a runtime leak, though the outer `declare` makes the
whole block ambient and `tsc --strict` rejects any real initializer there.

It failed *safe*, so it was not urgent. It was a trap: the guard deliberately has no baseline and
no opt-out, so anyone needing the legitimate pattern had no escape but a suppression — and a
suppression here reopens exactly the hole #4226 closed. Better to teach it the nesting than to
leave a trap whose only exit is the one thing the guard must not have.

`findAmbientRanges` tracks brace depth from a statement-position `declare module` / `declare
global` and the classification loop skips exports inside those ranges **before any shape check
runs**, so the exclusion holds for every export form rather than just `const`. Both arms are
pinned, including a mixed file where a file-scope runtime export still fails while an ambient one
passes.

**Verification:** both guards and their self-tests green (22 assertions in types-erasure, 4 of them
new — 3 for #4245 plus the bodyless-shorthand fixture; 6 new scenarios in doc-code-paths); `tsc -b` clean; the touched tauri-mock suites 782
passing. One bug
was caught during the work — an early-return path in `computeMisses()` did not carry the new
`warnings` key and crashed `check()` — fixed before it went green.
