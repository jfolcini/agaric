# Session 1368 — Four CI guard follow-ups, and a guard scoped to where its bug was found (2026-08-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-21 |
| **Subagents** | two builders (disjoint file sets), one adversarial reviewer |
| **Items closed** | `#4184`, `#4183`, `#4178`, `#4177` |
| **Items modified** | — |
| **Tests added** | +21 self-test assertions |
| **Files touched** | see PR #4223's file list |

**Summary:** Four narrow follow-ups from earlier adversarial reviews, grouped because they
are all guard-or-workflow harness work in the same two directories.

**#4184 — the middle gap between two gates.** `check-doc-code-paths.mjs` had
`PATH_PREFIX_RE` (accept only a known root) and `BARE_CODE_CITATION_RE` (flag a citation
with no slash at all). A *partially-rooted* citation — `pagination/mod.rs:658-668`,
`agaric-store/src/query/engine.rs:229` — has a slash but no known root, so it satisfied
neither and was invisible to exactly the drift the guard exists to catch. Now a
`kind: 'partial-root'` miss, wired through `judge()`, `check()` and `updateBaseline()`,
with the pre-existing population grandfathered the way #4135 did.

**53 pairs baselined, across 17 files.** The review re-derived that number independently
rather than accepting `198 - 145`: 53 added, **0 removed**, every entry carrying the
`#4184` reason string and none reusing #4135's. It also re-ran the detector against the
tree under two different extension policies and got 53 both times, and spot-checked
entries to confirm they are genuine module citations rather than prose swept in to quiet
the guard. Note the issue body's own estimate was **58**; the shipped, twice-reproduced
count is 53, and the gap is unexplained — recorded here rather than rounded away.

**#4183 — saying no, in code.** Three classes of untrusted checkout a single-file textual
guard cannot decide. The issue argued adding a pattern for the undecidable ones would be
*worse* than saying so, and that is what shipped: classes 2 (network-fetched content) and
3 (shell indirection) are marked judged-out-of-scope in `RUN_STEP_CHECKOUT_PATTERNS`'s own
header — no new regex — while class 1, the one that "could happen honestly", became
condition 6: a write-scoped job may only `uses:` an action on a two-entry human-reviewed
allowlist. Verified against the real file: only `post` is write-scoped, and it uses
exactly those two.

**#4178 / #4177 — the annotation that did not survive.** `run:` steps execute under
`bash -e -o pipefail`; a failing `tee -a "$GITHUB_STEP_SUMMARY"` aborted the step on the
pipe's own status, *before* the `::error::` annotation and the explicit `exit 1`. The step
still went red — silently, with neither summary nor annotation. Every such pipe is now
`|| true`, and the exit-1 branch says the typecheck was skipped (#4177), pinned in both
directions: present where the typecheck genuinely did not run, absent from the exit-4
branch where it did.

**The interesting correction came from review.** The first self-test scoped its assertions
to the Verify step — the step where #4178 was *reported*. The review found the identical
unguarded pipe in the "Install npm dependencies" step one step upstream, with the same
`::error::`/`exit 1` after it. Scoping a guard to where a bug was found leaves the rest of
the file free to reintroduce it, and it already had. Fixed drive-by (one `|| true`), and
the assertion is now **file-wide**: every tee to `$GITHUB_STEP_SUMMARY` anywhere in the
workflow must be guarded. Falsified by un-guarding that sixth pipe —
`FAIL - file-wide: ... expected [6], got [5]` — then restored.

**Known tradeoff, recorded not hidden:** `|| true` means a genuine summary-write failure
is now silent. The annotation surviving is worth more than the tee's exit status, and
#4178 named `|| true` as an acceptable fix, so this was a chosen tradeoff rather than a
reflex — but nothing now distinguishes "tee failed" from "tee succeeded".

**Commit plan:** single commit on `claude/ci-guard-followups`, shipped as PR #4223.
