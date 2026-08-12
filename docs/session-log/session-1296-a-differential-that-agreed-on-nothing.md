# Session 1296 — a differential that agreed on nothing (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 1 discovery, 1 build, 1 review, 1 fix |
| **Items advanced** | `#3347` (re-scoped and first slice) |
| **Items filed** | `#3821` |
| **Tests added** | 12 query steps across 3 fixtures + ratchet coverage (both legs) |

**Summary:** #3347 asked for a differential oracle between `tauri-mock` and the real backend. One already existed and gated every PR, so the issue was re-scoped and the work became extending it to read/query commands — the surface its ratchet excludes by construction. The new steps found two live mock-vs-backend divergences (#3821), and review found the differential could pass while contributing nothing.

**Process notes:**

**The issue's central premise was false, and that is now the fourth in this cluster.** #3347 called the mock "an unchecked second implementation" and said the only real-stack test was `e2e-tauri-weekly` — "6 specs, weekly, non-blocking… the coupled surface is 6 smoke tests nobody must pass". But #763/#3083 already binds mock and backend through 27 fixtures with backend-authored `expected` snapshots, replayed by `conformance.rs` on one side and `conformance.test.ts` on the other, gating on every PR via `validate-all`. The rule the issue wanted to institutionalise was already in force for mutating commands.

The issue body and title were rewritten rather than merely commented on, since a front page asserting something untrue about the tree costs every future reader. The original survives in the edit history.

**One part of the body was exactly right**, and worth recording because the rest was not: the `e2e-tauri-weekly` characterisation. 6 specs — literally every real-backend spec that exists, since the glob takes the whole directory, so not an allowlist gap — `cron: '43 2 * * 1'`, no `pull_request` trigger.

**Then the re-scope was itself refuted.** The rewritten body claimed read coverage was *zero*. It is not: `conformance/pages-metadata/*.vectors.json` is an existing cross-implementation golden-vector mechanism asserted by both `pages_*_conformance_tests.rs` and the mock tests. Corrected in place. What is genuinely uncovered is everything outside the Pages filter-primitive surface — and that harness has a hard limit worth knowing, since `PAGES_ALLOWED_KEYS` rejects `state` and `due-date`, so its Rust leg *cannot* exercise them and its mock-side assertions for those are hand-written rather than backend-authored.

Correcting one's own correction is the cost of writing the issue body from a single discovery pass. The alternative — leaving "zero" standing because it was directionally useful — is how the original body's errors got there.

**The differential passed while contributing nothing, and this was demonstrated rather than argued.** Nothing required a query step to *return* anything. Review repointed a fixture's scope at an existing-but-empty space id and recorded `rows: []`: all 39 Rust conformance tests and all 327 vitest tests passed, and the ratchet still counted the command as covered. A projected `[]` is indistinguishable from a legitimately-empty result, so a whole fixture of empty steps reads as coverage.

The fixture already carried a "vacuity guard" — as a *comment*, enforced by nothing. It is now enforced: every step must record non-empty rows or declare `expect_empty`, and a stale declaration fails too.

**An undocumented global weakening.** Because of a real mock bug (#3821: `run_advanced_query` sorts `b.id ASC` where the backend uses `b.id DESC`), row comparison was made unordered. Two things were wrong with how that landed. It was not scoped to the affected command — unordered was the *global default*, with 1 of 9 steps opting out, so `search_blocks`' bm25 relevance order and both task-list orders silently compared as sets. And the issue number appeared nowhere in the diff, while the rationale that was present was false for the fixture it governed: those queries hit only *seed* blocks, whose ids are byte-identical on both stacks, so their order was fully comparable and the unordered compare was the only thing keeping them green.

The general lesson is the one from #3346 restated: every normalisation is a class of divergence the oracle can no longer see, so each needs a justification at the site and a way to be tightened later. A blanket default with a per-case rationale is the worst arrangement, because the rationale looks specific while the effect is universal.

**Harness-side fixups are where a differential goes quietly wrong.** `stampMockSpace` mirrors the Rust runner's space assignment (backend scopes via the `blocks.space_id` column, the mock via a `space` ref property on the owning page). Without it every scoped read returns empty on the mock and the two stacks "agree" on nothing. It had two defects: it skipped *tombstoned* pages, where the Rust side's blanket `UPDATE` has no `deleted_at` filter, so any tombstone-visible scoped read would have shown a harness divergence dressed as an implementation one; and it ran once where the Rust runner runs twice, so the mock replayed every op with no space membership while the backend replayed with it resolved.

Neither is visible from the test's pass/fail. Both were found by reading the two runners against each other rather than by running them.

**Two live divergences, filed not fixed (#3821).** `run_advanced_query` ignores `BlockType` entirely in the mock — every row is built through `buildPageMetaRow`, which hardcodes `blockType: 'page'`, so the filter arm can never reject anything, and `block-type` is user-reachable via `QUERY_ALLOWED_KEYS`. And its default order is reversed, with a comment claiming the ASC sort is "the engine's terminal tiebreaker". The ordering bug also drives the mock's cursor keyset, so a multi-page advanced query would return different *rows*, not merely a different order — the fixture's `limit: 100` over 5 rows never paginates, so nothing pins it today.

Both were confirmed empirically with a backend-authored probe observed against the mock, not inferred from reading the handlers.

**The strongest single piece of evidence for the mechanism** was reverting the `list_page_links` page rollup: the entire rest of the mock suite stayed green — 323 passed, 1 failed — and the 1 was the new differential. That is a command with no competing unit-test coverage, which made it a far better canary than the one the plan nominated for a reason that turned out to be irrelevant.

**A waiver with a false reason is worse than no waiver.** Most read commands are waived rather than covered, so the reasons carry the weight. Review spot-checked 12 and found 4 false or misleading — two claiming wall-clock dependence for commands that take an explicit `date` argument and query `content` with it. A waiver forecloses the question; a waiver with a wrong reason forecloses it with a wrong answer, and reads as diligence.

Both journal waivers were **deleted and replaced by a real fixture** rather than reworded, which is the right resolution whenever the stated blocker turns out not to exist. The other three were rewritten to their true blocker — for `count_agenda_batch` a `HashMap<date, count>` return with no row identity the projection can bind, for `compute_edit_diff` an `op_log` `(device_id, seq)` coordinate each stack generates independently, so no fixture can spell the same input twice.

**Then the same audit turned up a systematic version of the fault.** The allowlist documents a `fixture candidate` category meaning "nothing structural blocks this; it simply is not written". Four more entries were filed under it while returning a shape the projection cannot bind at all — a bare `i64`, two `HashMap` count maps, and a rendered markdown string. That is the same blocker `count_agenda_batch` was just rewritten for, so leaving them would have made the file internally inconsistent within one commit. All four rewritten, and two categories added to the doc block (`<return shape>`, `<arg not fixture-expressible>`) so the next waiver has somewhere honest to go.

The general shape is worth keeping: a taxonomy with a comfortable default bucket will collect entries that do not belong in it, because the default costs nothing to choose. `fixture candidate` reads as a to-do; `<return shape>` reads as a design limit. Only one of them is true of a command returning a count map, and the difference decides whether anyone ever revisits it.

**The journal fixture was built to be non-vacuous, deliberately.** Its seed is not in date order, so the ordered range result differs from the canonical sort and `ordered: true` is load-bearing rather than decorative. One seed page is `"2026-01-0x"`, which passes the backend's sargable `content LIKE '____-__-__'` prefilter and falls inside the lexicographic range — so *only* the backend's `GLOB` digit class excludes it, and on the mock only its `^\d{4}-\d{2}-\d{2}$` regex. Drop either guard and the step reddens. Another page is renamed into date shape by an `edit_block` op, so the range must also see pages that were not journal pages at seed time.

That is what a fixture has to do to be worth its maintenance: fail for a specific reason that a plausible implementation would get wrong.
