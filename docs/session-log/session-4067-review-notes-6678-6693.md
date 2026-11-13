# Session 4067 — review notes from #6678 to #6693

The follow-up PR for the non-blocking notes the reviewer left on the PRs merged on 2026-11-13, plus code-scanning alert 294. One commit per source PR.

## What shipped

- **#6678.** The two `rowHeights` assertions in `e2e/phone-touch-targets.spec.ts` are gone with their helper: the only production change that grows the row is a real `min-height` on the chip, which `expectDrawnUnder30` already catches. The row rule's CSS comment now states the trade the reviewer named: on a row whose text wraps, the chip's area reaches into that row's own neighbouring lines (measured 11 px above and 10 px below at 360 px), and CSS cannot tell a wrapped row.
- **#6679.** `HistoryEntry.agent` serializes as `null` instead of being left out, so specta emits one `HistoryEntry` type again; the mock sends `agent: null`. Four conformance fixtures are committed in the generator's form.
- **#6680.** The `capture` test helper in `deeplink/mod.rs` is inlined.
- **#6692.** The `index.rs` doc comment points at `docs/architecture/search.md` for the shadow-table layout. Migration 0131's header keeps its copy: a merged migration is append-only.

## Corrections to merged logs

- Session 4030 said the chip rule "covers the agenda, Done, Due, unfinished-tasks and a page's tagged-items rows". On a tag's page only the list of tagged pages is a `BlockListItem`, and those rows are page titles. The tagged blocks, which are where chips appear, render through `BacklinkGroupRenderer` and keep their drawn size, as wrapping block text does.

## Notes with a wrong or outdated premise

- #6685 (the fixed-seed fuzz does not gate a mock-only PR) and #6693 (`ci-and-tooling.md` still says three shards and two workers): both were fixed before those PRs merged. The module docs of `conformance_fuzz.rs` already say a mock-only PR skips the test, and neither number is in the doc.
- #6679 (`history-agent-badge.e2e.ts` has never run): it passed on that PR's own real-backend lane before the merge.

## Traps

- **A conformance regeneration looks like it rewrites every fixture.** `CONFORMANCE_UPDATE=1` writes `serde_json`'s pretty form; the committed form is what `oxfmt` makes of it. Run `npx oxfmt conformance/fixtures/*.json` before reading `git status`. After that, four fixtures still differed on `main`, by key order and one collapsed object only (each parses to the same JSON): they had been edited by hand since their last regeneration. `oxfmt` keeps an object expanded once the generator writes it expanded, so a hand-collapsed one never round-trips.
- **Sending `null` for an absent field makes it required in the binding**, so every `HistoryEntry` literal in the tests needed `agent: null` (eleven files). The two insta snapshots that pin the wire shape went red on exactly `agent: ~` before being accepted.
- **The cloud container's Chromium is one revision behind the pinned Playwright.** `docs/BUILD.md` § Claude Code on the web has the `PLAYWRIGHT_BROWSERS_PATH` symlink workaround; it worked as written.

## Skipped

- #6681's `expect(dead_code)` on `rfd_boot_failure_dialog`: `src-tauri/src/lib.rs` was in three open PRs. The attribute is also the only thing that compiles that function on a PR, since PR CI builds Linux only.
- Alert 294 (`js/incomplete-sanitization` on `linkTitleText`) is a false positive: the flagged `replace` runs on `escapeUrl`'s output, which has already doubled every backslash, and the round-trip property test covers a title with both `"` and `\`.

## Ran

Full vitest, `npm run typecheck`, `npm run lint`, the whole-workspace nextest in two halves, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, clippy over all targets, `just gen-sqlx` and `just gen-bindings` (no diff on a second run), the manual-stage hooks, and Playwright over `phone-touch-targets` and the six History specs. `just e2e-related` selects both whole e2e lanes (the mock and the bindings changed), which CI runs.
