# Session 1819 — grammar, phase 1: shared vectors for stored content and names

Part of #5160's Phase 1 ("the oracle first"): tests that pin today's behaviour, so every decision in the issue lands as a visible flip. This half adds two sets of vectors that the Rust side and the editor both read. The other half (the import corpus, fuzzing and the parser properties) is session 1820.

**Stored block content** (`conformance/block-content.vectors.json`, finding X1).
- Each row is content a block can hold: `hello\nworld`, a `key:: v` line under text, a line shaped like a bullet, an anchor line, a hard line break, a fence holding `- x`, `[x] not a task`, `1. not a list`, and the checkbox alphabet.
- Rust: each row renders as one block in Source and reads back unchanged.
- Vitest: the editor's blur flush classifies an edited copy of each row as a plain edit. Where it splits or strips today, the row records that result with finding X1, so D2's phase flips exactly those rows. Six rows carry it, including a stored `- [ ] open task` that the flush folds into a checkbox.
- The checkbox alphabet is shared: Source's marker for each task state and the editor's `processCheckboxSyntax` must agree on every marker.

**Name rules** (`conformance/reference-tokens.vectors.json`, `nameRuleCases`).
- What the text surfaces' name pass requests, and what the editor's `parse` makes of the stored result, for `#42`, a URL fragment, a `](…)` destination, `&#39;` and `[#A]` (N1), `\#tag` and `\[[Page]]` (N3), `[[Page|label]]` (N6), `[[Page#Heading]]` (D10's fallback), `[[C# Notes]]`, and `#C++` / `#v1.2` on read and on export (N8).
- A row where the sides disagree, or where today differs from the decision, names its finding. The vitest fails a disagreeing row that names none.
- The Rust test copies the resolver's lookup, since `resolve_link_names` needs a database. Phase 3 updates it together with the resolver; the `[[C# Notes]]` row's N8 id points there.

**Review.** An independent reviewer corrected one finding id (a stored `- [ ]` is X1's flush, not P1's import) and deleted rows that re-ran checks the render→parse proptest and the existing token cases already make: task states, list styles, properties, the multi-word tag, fence and inline-code rows. With those optional fields gone, a misspelled key now fails the row instead of passing silently.

**Verified.**
- The mutations were made on copies, each restored and `cmp`-checked. Each turned exactly its rows red:
  - the flush never splitting;
  - `#` not escapable;
  - the alphabet losing `/` or `X`;
  - the N1 fix's tag rule, which flips the `#42` row as intended;
  - Source no longer escaping an ambiguous continuation line.
- `cargo nextest run --workspace` passed 6512. Clippy and fmt are clean.
- The whole vitest suite passed 19356 tests. `npm run typecheck` is clean.
