# Session 1114 — tauri-mock PathGlob: port backend SQLite-GLOB dialect (#1910)

## Problem

The Pages page-path glob filter is reimplemented in the tauri-mock so the e2e
suite and unit tests run without the Rust backend. The backend moved this
surface to the **SQLite `GLOB`** dialect in #1320-A (`prepare_globs` in
`src-tauri/src/fts/glob_filter.rs`, bound into `LOWER(title) GLOB ?` by
`compile_pages_filters`). The mock's `globMatchesTitle` was never updated — it
still implemented the old **LIKE-style** translation (`*`→`.*`, `?`→`.`,
bare-word→substring, everything else regex-escaped). Surfaced while scoping
#1908; confirmed as the exact #1886 failure mode: every test exercising a page
glob filter through the mock asserted results that don't match production, and a
backend glob regression would stay green.

Seven divergence classes (backend = source of truth): brace expansion, `[class]`
ranges, the literal-bracket flip, the substring-wrap trigger (`[`-aware),
validation/rejection of malformed globs, whitespace trimming, and ASCII-only
case folding.

## Approach — port the backend pipeline, lock it cross-language

Rather than patch `globMatchesTitle` inline, ported the backend pipeline into the
existing JS glob module `src/lib/search-query/glob-validate.ts` (already the FE
mirror of `glob_filter.rs`, with `validateGlob`/`expandBraces`):

- **`prepareGlobs(entries)`** — faithful port of `prepare_globs`: top-level comma
  split (commas inside `{…}` not split), trim, empty-skip, `MAX_GLOB_LEN`
  (UTF-8 byte length), `validateGlob`→throw with the shared `InvalidGlob:`
  prefix, bounded brace expansion, `[`-aware substring-wrap, then **ASCII-only**
  lowercase (mirrors SQLite's ICU-free `LOWER`, #381).
- **`globToRegExp(prepared)`** — compiles ONE prepared pattern to an anchored
  `RegExp` mirroring SQLite `GLOB`: `*`→`.*`, `?`→`.`, `[…]` classes with `^`
  negation / ranges / literal-leading-`]`, all else literal (no escape char —
  backslash is literal). No `i` flag: case is handled by ASCII-lowercasing both
  the pattern (in `prepareGlobs`) and the title.
- **`pageGlobFilterMatches(pattern, title, exclude)`** — mirrors
  `compile_pages_filters`: whitespace-only → no constraint (row passes); include
  = match ANY prepared pattern; exclude = match NONE; invalid glob → drop the row
  (the backend rejects the whole query, closest per-row approximation is "no
  rows").

`src/lib/tauri-mock/handlers.ts` drops `globMatchesTitle`; the `PathGlob` branch
delegates to `pageGlobFilterMatches`.

## Cross-language conformance lock (the #1886/#1908 pattern)

`conformance/pages-metadata/path-glob.vectors.json` is a second shared fixture
asserted from both sides:

- **Rust** — `pages_path_glob_conformance_tests.rs` seeds `pages_cache` titles
  and drives the REAL `list_pages_with_metadata_inner` with a `PathGlob` filter
  (`prepare_globs` → `LOWER(title) GLOB ?`), asserting the matching-id set and
  that every `invalid[]` pattern fails with `InvalidGlob:`.
- **TS** — `glob-conformance.test.ts` drives `pageGlobFilterMatches` against the
  same fixture (matching-id set + invalid-rejection), plus unit assertions on
  `prepareGlobs` pipeline shape and `globToRegExp` dialect.

Only the **set of matching page ids** is compared cross-impl. Scenarios cover all
seven divergence classes; `invalid[]` covers unbalanced bracket/brace, nesting,
and escapes.

## Behaviour change — low risk, no existing tests broke

Every page-glob test that runs through the mock today uses only `*`, `?`, and
bare-word substring patterns — all **preserved** by the new dialect (a bare word
is still substring-wrapped to `*word*`). Brace/char-class/validation paths were
never tested through the mock, so the fix changes only previously-untested
behaviour. The full affected frontend suite (760 tests) passed unchanged.

## Verification

- TS: `glob-conformance.test.ts` (24) + `src/lib/search-query`, `src/lib/filters`,
  `src/lib/tauri-mock`, `tauri-mock.test.ts` — 760 passed. `tsgo -b` clean;
  `oxlint` clean on changed files.
- Rust: `pages_path_glob_conformance_{matching,rejects_invalid}` pass.
- Adversarial reviewer re-read both sides (GLOB→regex correctness, prepareGlobs
  parity, fixture expected-ids vs `sqlite3` GLOB) — see PR notes.

Closes #1910.
