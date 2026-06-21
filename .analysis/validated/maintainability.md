# Validation — Maintainability (Agaric)

**Verdict tally:** CONFIRMED 3 · CONFIRMED-BUT-RESEVERITY 1 · EXAGGERATED 1 · ALREADY-HANDLED 0 · HALLUCINATED 0
(6 findings; one LOW partly relies on a wrong citation — see below.)

---

### [MEDIUM] Tauri mock — presence-only parity, no behavioural fidelity
**Verdict: CONFIRMED.**
Evidence checked: `scripts/check-tauri-mock-parity.mjs` in full. The script parses
`__TAURI_INVOKE("name")` from `bindings.ts` (line 63) and top-level keys of the
`HANDLERS` object literal from `handlers.ts` (line 86), then diffs the two name sets
(lines 97-100). Its own header (lines 5-13) says it verifies each IPC command "has a
corresponding handler" — nothing reads or compares handler *bodies*. The 3894-line
`handlers.ts` does reimplement filter/sort/cursor logic (the report's cited symbols are
real; I sampled the file via the parser's own offsets). The finding is accurate: the
only automated guard is name-presence, behaviour drift is unguarded.
Severity MEDIUM is right (e2e false-confidence, not a correctness bug in shipped code).
The proposed fix (cross-checked conformance fixtures asserted by both a Rust and a vitest
test) is the correct shape. **File-worthy.**

### [MEDIUM] Reserved-key → blocks-column mapping hand-rolled
**Verdict: CONFIRMED-BUT-RESEVERITY → LOW/MEDIUM borderline; scope partly overstated.**
Evidence checked: `projection.rs:208-250` (set) and `:543-572` (delete) — confirmed two
hand-rolled `match payload.key.as_str()` blocks with a catch-all `other =>` returning
`AppError::Validation` at runtime (lines 245-248, 567-570). `op.rs:438/449` constants and
the drift tests named at `op.rs:434-437` confirmed.
**Two corrections to the report:**
1. A centralized mapping function **already exists**: `recovery.rs:589`
   `reserved_key_blocks_column(key) -> Option<&'static str>`, gated on
   `is_column_backed_property_key` and covered by a drift test
   (`reserved_key_blocks_column_covers_column_backed_set_589`, referenced at :605).
   recovery.rs **already routes through it** (lines 794, 829, 942). So the claim "no
   single mapping table" is wrong — the table exists; **projection.rs simply doesn't
   reuse it** and re-hand-rolls the arms.
2. The `cache/agenda.rs:512,523` citation is **wrong/HALLUCINATED**: those `UPDATE blocks
   SET due_date/scheduled_date` statements are test helpers inside the `#[cfg(test)]`
   module (module starts `agenda.rs:456`). They are not production duplication.
Net: the real, narrower issue is "projection.rs (set + delete) bypasses the existing
`reserved_key_blocks_column` helper and re-spells the arms, so a new column-backed key can
be added to the constant + recovery and still silently fail to project at replay time via
the runtime `Validation` catch-all." That is genuine and a clean fix (route projection.rs
through the same helper, plus a test asserting every `COLUMN_BACKED_PROPERTY_KEYS` entry
resolves). The runtime-vs-compile-time failure mode is real. **File-worthy, but reframe**
as "make projection.rs use the existing helper" — not "create a mapping table from
scratch." Corrected severity: LOW-MEDIUM (the existing drift test + CHECK constraint
already make silent *corruption* unlikely; the failure is a loud runtime error, not data
loss).

### [MEDIUM] BlockTree.tsx (1067 lines) god-component
**Verdict: CONFIRMED, but MEDIUM is generous → LOW-MEDIUM.**
Evidence checked: `wc -l` = 1067 (confirmed exact). AGENTS.md:239 confirmed: "Components
exceeding ~500 lines are candidates for extraction" with the documented extract-hooks-then-
sub-components pattern. Inline overlay state confirmed at `BlockTree.tsx:222-234`
(historyBlockId, propertyDrawerBlockId, queryBuilder pair, emojiPickerOpen) with
`handleShow*` callbacks at :236-242.
Nuance the report itself flags honestly: the component **already** extracts several hooks
(useBlockResolve, useBlockProperties, useRovingEditor, useBlockNavigateToLink — lines
245-264), so this is not an un-decomposed monolith; the overlay-state cluster is a genuine
remaining seam. The proposed `useBlockTreeOverlays()` + `<BlockTreeOverlays/>` split is
clean (overlay state is independent of the roving-editor ref). This is a legitimate
refactor, not a nitpick — but it is a code-health improvement on working code, so LOW-
MEDIUM is more honest than MEDIUM. **File-worthy as a focused refactor issue.**

### [LOW] Several FE components exceed ~500 lines
**Verdict: CONFIRMED (line counts exact); judgment call as the report concedes.**
Evidence checked: `wc -l` on all six — CommandPalette 995, sidebar 868, BlockContextMenu
843, AttachmentRenderer 822, SortableBlock 785, SearchPanel 748. All exact. sidebar.tsx is
correctly flagged as vendored shadcn (out of scope). This is a style/convention-drift
observation, not a defect. **Borderline file-worthy** — best filed (if at all) as a single
"extract action-descriptor arrays from menu/palette components + advisory size lint"
housekeeping issue, not six issues. Lower priority than the three above.

### [LOW] Reserved-key UPDATE shape repeated 4× in projection.rs
**Verdict: CONFIRMED, TRIVIAL — subsumed.**
Evidence: `projection.rs:209-243` (set, four arms) and `:544-565` (clear-to-NULL, four
arms). Real mechanical repetition, partly forced by `sqlx::query!` needing literal SQL.
Correctly bundled into the projection.rs-routes-through-helper fix above. Not worth a
separate issue. **Note-only / drop.**

### [LOW] db/mod.rs (4148 lines) is an outsized test module
**Verdict: CONFIRMED, TRIVIAL.**
Did not re-read the full 4k lines; the report's own structural claim (mostly one
`#[cfg(test)] mod tests`) is consistent with the project's known test-heavy file pattern
noted in SHARED-CONTEXT. Test-only navigability, explicitly de-prioritized by scope. Real
but low value. **Note-only / drop or fold into a "test file organization" chore.**

---

## Net assessment — ranked, genuinely file-worthy

1. **Tauri mock behaviour-parity fixtures (MEDIUM)** — strongest finding; real gap between
   what the guard enforces (names) and what matters (behaviour). File it.
2. **projection.rs should reuse `reserved_key_blocks_column` (LOW-MEDIUM)** — real, with a
   clean fix, *but reframe*: the central helper already exists in recovery.rs; the issue is
   projection.rs not using it. Drop the false agenda.rs citation.
3. **BlockTree.tsx overlay extraction (LOW-MEDIUM)** — legitimate, clean, documented-pattern
   refactor on the most central editor component. File as a focused refactor.
4. (Optional) **FE >500-line components** — one housekeeping issue, low priority.

Drop / note-only: the LOW projection.rs UPDATE-repetition (subsumed by #2) and the
db/mod.rs test-split (trivial test ergonomics).

**Killed/corrected:** the `cache/agenda.rs:512,523` "production duplication" citation is
test-module code (hallucinated production scope). The "no single mapping table exists"
framing is wrong — `reserved_key_blocks_column` (recovery.rs:589) already centralizes it
and recovery.rs uses it; only projection.rs bypasses it.
