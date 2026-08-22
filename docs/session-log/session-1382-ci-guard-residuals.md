# Session 1382 — CI guard residuals

| | |
|---|---|
| **Issues** | #4265, #4264, #4176, #4175, #4174 (partial) |
| **Branch** | `claude/ci-guard-line-bounds-markers` |
| **Files touched** | see the PR's file list |

Five guard-script residuals, all filed off earlier reviews. Four close; one
(#4174) is deliberately half-done and re-scoped on the issue.

Three of the five were **rejected in review and reworked**, in each case
because the first attempt traded a loud failure for a quiet one.

## #4265 — ambient shapes the erasure guard still false-flagged

`AMBIENT_BLOCK_LEAD` recognised `declare module '<string>'` and
`declare global` but not `declare namespace Foo` or the legacy non-string
`declare module Foo`. Widened, with the head-lookup extended to skip a
possibly-dotted identifier chain before the brace.

Review confirmed the widening keys on `declare` immediately preceding the
lead keyword, so a **non-declared** `namespace Foo { export const x = 1 }` —
which emits a real IIFE — is still correctly flagged. That was the hole worth
checking, and it is not there.

Review surfaced a pre-existing fail-open path, filed as #4269: `declare` is
matched by token adjacency with no statement-boundary check, so `let declare`
before a genuine `namespace` block silences a real leak. Predates this change
and affects `module`/`global` identically.

## #4264 — the line-bounds warning channel had no acknowledgment discipline

`KNOWN_INTENTIONAL_WARNINGS` is now an array of structured records whose stale
entries **fail** the check, mirroring what the JSON baseline already does.
Plus: NEW-first cap ordering, dedupe on `(doc, ref, maxCited)` before both
printing and counting, `countFileLines` cached per resolved target, and a
comment correction (it counts the way an editor numbers lines, not the way
`wc -l` does).

**The first attempt only closed half the issue.** It gated staleness on
whether the entry's doc was scanned this run, which catches "anchor removed"
but structurally cannot catch "doc renamed" — the renamed-away path is by
definition absent from the scan set, so the gate skips the entry at exactly
the moment it has certainly rotted. Worse, the citation returns under the new
name tagged NEW, forever, with nothing forcing the dead entry out.

The rework gives the literal the same isolation the JSON baseline gets for
free. The baseline is a file *in the tree under judgement*, which a throwaway
fixture simply lacks; so the list now asks that question once, over the whole
list, by checking whether the guard's own path is tracked. Staleness is then
fully ungated and both triggers redden. No env var, no CLI flag — an
out-of-band switch that neutralises a guard's own failure-bearing config is
the one thing not to build.

Review also found a **vacuous assertion** in the cap-ordering scenario: it
sourced its 50 new warnings from `docs/gen/*.md`, and since every `.md` is
judged before any `.ts`, the acknowledged warning was already last in
discovery order — an unsorted slice truncated it unaided. The scenario passed
with the ordering fix reverted. Moved to `src/lib/gen/*.ts` so the acknowledged
warning is discovered first, the only arrangement in which the cap's ordering
is observable at all.

`prek.toml`'s hook pattern now includes the guard's own source, for the reason
the baseline is already there: editing failure-bearing config must re-run the
check that judges it.

## #4176 — the deleted-lockfile case misnamed its cause

`lockfiles_agree()` returned `1` for both "the two lockfiles differ" and "the
merge deleted the lockfile". The latter now returns `2` and gets its own early
return with honest diagnostics, never invoking `npm ci` on a lockfile that is
not there.

The author left `pr-overlap.yml` untouched, arguing scope. Review adjudicated
against that: the issue names the rendered summary as a symptom, and before the
edit a maintainer still read "fix the script or the runner rather than the PR"
for a case the PR itself caused. Fixed narrowly in the summary rather than by
minting a new exit code — exit 3 is one verdict ("nothing was type-checked")
and this case is genuinely a member of it.

Review also found a defect the fix itself created: `cmp -s` exits `2` on I/O
trouble (verified: `chmod 000` then `cmp -s` → `2`), which collided with the
function's new deliberate `return 2` and would have reported a permission fault
as a deleted lockfile. Anything above `1` from `cmp` now collapses to `1`.

Recorded as #4271: the content-differs branch has only *negative* assertions —
no fixture asserts its diagnostics are emitted for its own trigger.

## #4175 — order and banner dependencies in the wiring self-test

`findDocsLintRunLine` now excludes `--hook-stage`-qualified lines instead of
taking the first `.find()` match, so step order stops mattering.
`extractJobBlock` terminates on an actual job-key shape instead of the first
2-space-indented non-space line, so the `# ---` banner stops being
load-bearing.

The builder was asked for a red-before fixture for the "banner removed" case
and correctly reported that one **cannot exist**: a real job-key line already
satisfies the old looser condition, so the new terminator's match set is a
strict subset and the old code can only ever stop too early, never too late.
Verified independently. The fixture was kept as a labelled regression guard
rather than presented as a falsification it is not.

## #4174 — partial, and deliberately so

The blockquote half landed: fences prefixed by `>` are now recognised, and
fence identity gained a **quote-depth** component. That second part was not in
scope but proved necessary — without it a bare fence could be closed early by
a depth-mismatched `> ` fence line, after which the real closer read as a fresh
opener and swallowed everything following it.

The list-nested half was **rejected**. Implementing it via unbounded leading
whitespace converted the issue's loud false positive into a silent false
negative: a plain 4-space indented code block starting with a fence-shaped line
opened a phantom fence and swallowed a genuine expired marker (`exit 0`, no
output), and near the top of a 200-line document it swallowed everything after
it. "Fence nested in a list item" and "plain indented code block" are
indistinguishable without container tracking, which this scanner does not have.

Trailing whitespace is capped at 0–3, CommonMark's own per-container cap. The
list-nested case reverts to a visible CI failure, which is the direction the
issue itself calls "not a correctness emergency". Both rejections are pinned by
self-test scenarios, and the list-nested fixture now asserts "still flagged"
rather than silently no-op'ing. Re-scoped on the issue; closing it properly
needs a real block-container model.
