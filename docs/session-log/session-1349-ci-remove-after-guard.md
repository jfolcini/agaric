# Session 1349 — remove-after-markers: docs-lint wiring + fenced-block exemption (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review of an uncommitted worktree diff) |
| **Items closed** | #4147, #4146 |
| **Items modified** | — |
| **Tests added** | +8 (self-test scenarios, backend/Node) |
| **Files touched** | 3 |

**Summary:** Adversarially reviewed an uncommitted diff claiming to fix #4147 (a
docs-only PR skipped the `remove-after-markers` guard entirely) and #4146 (the guard
can't document its own convention without tripping itself). Both fixes were
directionally correct — `remove-after-markers` is now in `docs-lint`'s hook list, and
`.md` fenced code blocks are exempt from the marker scan — but the fence exemption's
naive "any fence-shaped line toggles" state machine had a real, exploitable hole: a
shorter fence-shaped line nested inside a longer one (or a different delimiter
character nested inside the other) desynced the open/close parity, silently hiding a
genuinely expired marker in ordinary prose later in the same file. Fixed the state
machine to require CommonMark's own matching rule (same delimiter character, same-or-longer
run, no trailing info string) before a line closes a fence, added regression tests that
fail against the pre-fix logic and pass against the fix, and added a #4147 wiring
self-test scenario that reads the real `_validate.yml` and asserts `remove-after-markers`
stays in `docs-lint`'s hook list.

**Files touched (this session):**
- `scripts/check-remove-after-markers.mjs` (fence state machine fix: `MD_FENCE_RE` +
  new `MD_FENCE_BARE_RE`, `findMarkers`'s per-file `fence` tracking now records
  delimiter char/length instead of an unconditional toggle; +4 adversarial fence
  scenarios in `fenceStateMachineScenarios`; +1 `docsLintWiringScenario` reading the
  real `_validate.yml`; header comments updated to describe the corrected semantics)
- `.github/workflows/_validate.yml` — reviewed only, no changes needed (the `docs-lint`
  job's hook list and comments were already correct)
- `CONTRIBUTING.md` — reviewed only, no changes needed (the new "Marking code with a
  removal deadline" section's fenced examples pass the guard as documented)

**What was already correct in the diff (verified, not just trusted):**
- #4147: `docs-lint`'s `prek run --all-files …` line now names `remove-after-markers`,
  matching the hook id declared in `prek.toml`; `prek.toml` itself is untouched, as the
  job's own comment claims. `actionlint` passes on the edited workflow.
- #4146: the fenced-block exemption is markdown-only (gated on `.md`), scoped to
  content strictly inside a fence (an unfenced real marker in the same file still
  reddens), and doesn't touch the marker regexes themselves.
- All three of the diff's own fence tests were falsified against targeted mutants
  (exemption disabled entirely; the `isMarkdown` gate removed) and correctly reddened
  in both cases — not vacuous.

**What was wrong and fixed:**
- The fence toggle (`inFence = !inFence` on ANY fence-shaped line, regardless of
  delimiter character or run length) is exploitable: nesting a shorter example fence
  inside a longer one, or mixing `~~~`/backtick delimiters, flips the parity an even
  number of times inside the intended block and an odd number of times by EOF,
  silently exempting unrelated prose after the block — including a real expired
  marker. Reproduced against the diff as submitted (exit 0, marker unreported);
  confirmed the fix (exit 1, marker reported) with the same fixture.
- #4147 had no local test at all. Added a self-test scenario that reads the real
  `.github/workflows/_validate.yml` (not a fixture — there's nothing to fixture; the
  bug was a property of that one file) and asserts the `docs-lint` job's hook list
  still names `remove-after-markers`. Falsified by reverting the workflow line and
  confirming the scenario reddens, then restoring it and confirming green.

**Left as-is (deliberately, not a gap):**
- An unterminated fence (opened, never closed) swallows the rest of the file,
  including a real marker after it. This matches CommonMark's own reading of an
  unclosed fence and is now locked in by a scenario asserting the current (accepted)
  behavior, rather than fixed — a markdown file with a broken fence also renders
  visibly broken, which is a different, weaker failure mode than the silent
  parity-corruption bug that was fixed.
- The #4147 wiring self-test only runs via `--self-test` (today: whenever
  `check-remove-after-markers.mjs` itself changes, per the `remove-after-markers-selftest`
  hook's `files` trigger). It does not automatically re-run on every future
  `_validate.yml` edit — widening that hook's trigger to the whole workflow file was
  considered and rejected as disproportionate (a large, frequently-touched file for
  many unrelated reasons; the wiring check itself is cheap, but the rest of the
  self-test battery it would drag in on every unrelated `_validate.yml` touch is not).

**Verification:**
- `node scripts/check-remove-after-markers.mjs --self-test` — 22 assertions, all
  passed.
- Falsification: reverted the fence fix to the pre-review naive toggle (same test
  suite) — the two new fence-parity scenarios correctly reddened; reverted the
  `docs-lint` hook list line — the new wiring scenario correctly reddened; removed the
  `isMarkdown` gate and disabled the fence exemption entirely (two separate mutants) —
  the diff's own three fence tests correctly reddened in both cases. All four mutants
  confirmed non-vacuous coverage; the suite returns to green with the real fix
  restored.
- `prek run remove-after-markers remove-after-markers-selftest markdownlint
  md-link-targets doc-vs-code-paths typos --all-files` — all passed.
- `prek run actionlint --files .github/workflows/_validate.yml` — passed.
- `python3 -c "import yaml; yaml.safe_load(...)"` against `_validate.yml` — parses
  clean.

**Lessons learned (for future sessions):** A markdown fence exemption that toggles on
"any fence-shaped line" rather than matching CommonMark's actual open/close rule
(character + length) is not a cosmetic simplification — it silently corrupts scan state
for the rest of the file on a nested example, which is exactly the kind of realistic
authoring pattern (showing a shorter fence inside a longer one to document the
convention) the exemption itself was added to support. Always falsify a state-machine
exemption against the fixture pattern its own feature encourages people to write, not
just the pattern its acceptance criteria named.

**Commit plan:** not committed — review-and-fix only, left staged for the branch owner.
