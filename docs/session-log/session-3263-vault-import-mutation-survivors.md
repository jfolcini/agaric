# Session 3263 — vault-import mutation survivors

The weekly mutation sweep left three survivors in `src/lib/vault-import.ts`
(#3766), in `resolveVaultPath` and `resolveVaultRef`, the code #6202 and #6203
added for attachment refs beside the note.

Two survivors kept a `.` segment in a resolved path: one turns the `.` check
into `true`, the other turns the `'.'` literal into `''`. No test saw it,
because a `./` ref that misses the exact path still lands on the basename
fallback. The new test puts two same-named files in different folders, where
the fallback returns both. A kept `.` returns that tie, and dropping it returns
the one file. Stryker kills one of the two outright and counts the other as a
timeout. A hand mutation of the `.` check reddens the new test alone.

The third, `path === null ? undefined : …` with the guard forced off, is
equivalent. Every `byPath` key is a string, so `byPath.get(null)` is
`undefined` as well. The guard exists for the type checker and stays.
It is recorded in `mutation-accepted.tsv`.

Ran: `node scripts/run-mutation.mjs vault-import` before (3 survived) and after
(0 survived), `npx vitest run src/lib/vault-import.test.ts`, `npm run typecheck`.
