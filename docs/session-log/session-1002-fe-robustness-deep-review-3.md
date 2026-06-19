# Session 1002 — /batch-issues loop: FE robustness hardening, batch 3 (2026-06-19)

## What happened

Third cohesive batch of the `/loop /batch-issues` run: four more frontend
robustness findings from the multi-agent deep review, each on a non-overlapping
file, built by parallel subagents and adversarially reviewed before ship. Pipelined
against batch 2 (PR #1786, pending CI). Batch 1 (PR #1785) merged at the prior
boundary.

## Shipped

Single PR `fix/fe-robustness-deep-review-3`:

- **#1587** — the image input rule accepted any `src` with no scheme validation
  (asymmetric with the link path's `isValidHttpUrl` gate); added `isValidImageSrc`
  (http/https + the app's real local schemes `data:`/`blob:`/`asset:`/`tauri:` +
  scheme-less relative paths, rejecting `javascript:`/`vbscript:`/`file:`/`ftp:`) and
  gated the rule to no-op on an invalid src.
- **#1591** — `useBlockFlush`'s checkbox-todo branch ran a detached async edit with no
  in-flight guard, so a rapid second edit could be clobbered by a late resolve; added
  a per-block monotonic sequence token captured before the await and re-checked after
  (success and catch paths) so a superseded run bails instead of clobbering.
- **#1594** — unresolved agenda tag filters were silently dropped, widening a
  multi-dimension result to a superset; added a `TAG_FILTER_UNSATISFIABLE` sentinel so
  an all-unresolved tag dimension collapses the AND to empty (the backend treats
  `tagIds:[]` as no-filter, so the short-circuit must live frontend-side).
- **#1592** — `findConflicts`' cross-category pass ignored document-level Escape
  listeners in focus-scoped categories; added a `documentLevel` flag on the catalog,
  marked the three genuinely document-level entries (`zoomOut`, `clearSelection`,
  `listClearSelection`), gave `closeOverlays` an explicit overlay-open condition so the
  layered default Escape chain stays disjoint, and widened the conflict filter.

## Review pass

Four adversarial reviewers (one per item, none self-reviewing) re-read code, re-ran
targeted suites, and ran `tsc`/`oxlint`. The #1587 reviewer caught and fixed two real
TS errors in the new test (the builder's "tsc clean" claim was false:
`addNodeView: undefined` under exactOptionalPropertyTypes, and a missing 5th
`handleTextInput` arg). Others were clean.

## Notes

- All four touch disjoint files (`editor/extensions/image.ts`,
  `block-tree/use-block-flush.ts`, `lib/agenda-filters.ts`,
  `keyboard-config/{catalog,storage}.ts`) — clean parallel build, one cohesive PR.
- Reviewer tsc-gating proved its worth again (#1587): builders run vitest only, so a
  reviewer `tsc -b --noEmit` is the gate that catches type errors before CI.
- Backend Rust cluster (#1589 deeplink length bound, #1590 frontmatter scalar,
  #1607 MCP search byte-budget) held for batch 4 in the main checkout — serializing
  the heavy Rust pre-push avoids the concurrent-push OOM risk.
