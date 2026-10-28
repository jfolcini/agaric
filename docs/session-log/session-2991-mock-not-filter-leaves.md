# Session 2991 — The mock models the filter leaves a `Not` can reach (#6054 D2)

Set out to port the backend's `Not` filter semantics to the mock (#6054 item D2).

**Finding.** The premise was half wrong. The backend compiles `Not` as `NOT COALESCE(child, 0)`, which already agrees with the mock's `!child` whenever the child is two-valued. The real divergence was in the leaves: `metaRowMatchesFilter` and the backlink filter returned a silent `true` for every leaf they did not evaluate. So a `Not` over one of those leaves emptied the result where the backend returned the complement.

**Shipped:**
- The advanced query models `ChildOf`, `Space`, `Created`, `LinkedFrom` and `HasParentMatching`.
- The backlink filter models `PropertyNum`, `PropertyDate`, `DueDate` and `CreatedInRange`.
- Each leaf has the backend's NULL handling and goes through the mock's existing property and date predicates.
- The search-only leaves are refused, as the backend's `gate_leaves` refuses them. An unknown leaf throws instead of matching everything.
- **Review fix:** the mock refused a bad filter only once a row reached it, so an empty page accepted it. It now checks the filter up front, as the backend does.

**Trap.** The fixture's five newest steps were written by hand while the one Rust build tree was busy. They were later run through `CONFORMANCE_UPDATE`, and the backend produced the same values; only the file's formatting differed. D1 (#6146) landed first and removed the mock's `space` property row, so the backlink-leaves test now places its pages with `setSpace`.

**Suites:**
- vitest over the mock and `tauri-mock.test.ts`: 59 files, 1691 passed, including the conformance suite on the new fixture;
- typecheck, plus oxlint and oxfmt on the mock;
- the backend authoring run over every fixture.
