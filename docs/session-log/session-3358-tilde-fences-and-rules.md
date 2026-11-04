# Session 3358 — The editor reads every fence and rule Rust reads (#6033 S2, #6277 C1)

Set out to build #6033 S2 (= #6277 C1). Rust's grammar reads `~~~` fences and `***` / `___` thematic breaks; the editor's parser read backtick fences and `-{3,}` only, so imported or Edit-as-Markdown content Rust stores as code or a rule showed as text, and the first edit escaped it into text for good (`\~\~\~`).

**What shipped.** `parser.ts` opens a fence on a tilde run (info may hold backticks; it closes on a run of the same character at least as long) and reads a rule through `isThematicBreak`, the existing TS mirror of Rust's `is_thematic_break`, now exported; the serializer's `\---` escape uses it too, so `--- ` stays text. The `src/lib` fence readers (`block-type-convert`, `inline-property-parse`, `import-attachments`) take tilde fences. The serializer still writes backtick fences and `---`, so stored content converges on its next edit.

**Pin.** `conformance/block-content.vectors.json` rows carry a Rust-authored `rustReads` field (`code` / `rule` per block from `import::parse_pasted_text`, written under `CONFORMANCE_UPDATE=1` by `the_block_content_vectors_carry_what_rust_reads`), and the TS conformance test asserts `parse(content)` agrees. The writer touches only that field, so #6277 C3's `editorCanonical` can sit beside it; serde_json sorts keys, which reordered the file once.

**Decision.** A bare `****` line is a rule, as in Rust and CommonMark; the two #5160 N9 serializer tests moved their input to `# ****`, where the run still sits between line edges.

**Known gaps, unchanged.** A fence info string that is not a plain language (`~~~ a`b`) is dropped on re-serialize, as backtick fences always were; the editor wants fence lines at column 0 where Rust allows leading spaces.

**Tests.** Parse cases, round-trip seeds, a page-mode case, the three mirrors, `e2e/tilde-fence-rule-6033.spec.ts` (seeded through IPC, re-queried after navigating away and back); parser revert falsified both sides. Gates: full vitest in shards, typecheck, lint, manual-stage hooks, 204 Playwright specs from `e2e-related`'s selection, nextest over the vector tests (61), clippy over the workspace.
