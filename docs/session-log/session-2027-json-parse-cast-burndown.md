# Session 2027 — JSON.parse casts burned down, baseline deleted

Part of #5469. The nine files still in the `JSON.parse(...) as T` baseline now
check what they parse instead of asserting it.

- Op-log payloads (`history-utils`, `HistoryPanel`, `undo`) share one
  `parsePayloadObject`: a plain object or `null`.
- Saved and inline queries check their filter tree with `isFilterExpr`, so a
  malformed `{{query}}` payload or saved view is refused instead of reaching
  the query engine as a half-built tree.
- `useLocalStoragePreference`'s default `parse` falls back to the default when
  the stored value's `typeof` differs from it; richer types already pass their
  own `parse` or `validate`.
- Select-property options must be an array of strings; anything else takes
  the existing warn-and-clear path.
- The two boolean preferences compare the raw string, and the local-graph
  preference reads its fields without a cast.

With nothing left in the baseline, the baseline is deleted: the guard fails
on any cast, naming file and line, and exits 2 when it scans nothing.

Suites run: the affected directories (history, undo, journal, preferences,
advanced query, query, agenda, emoji picker, settings), `npm run typecheck`,
oxlint, the guard, and each new validator shown red by disabling it on a copy.
