# Session 1690 — the backlink key is spelled once

The two mechanical notes from #4950's approval, one small follow-up.

The invalidate-on-structure effect that #4950 put in `LinkedReferences`
spelled the `['backlinkGroups', space, target]` prefix by hand, a copy of
the key `useBacklinkGroups` owns and a line-for-line twin of the effect in
`useUnlinkedReferences`. The hook has one caller and already imports the
query client, so the effect moved into it and the copy went; the two
component tests that pin the refresh stay green through the hook, and a
hook-level test pins the second fetch after a bump. Two comments that still
described the abandoned re-key design ("no invalidate" under the very bump
that invalidates; "a bump re-keys") now describe what the code does.

Left in the owed list, not code: the reviewer's measurement note that the
counter fires on every commit, so the unlinked-references query, the journal
badge counts and one backlink page per loaded page re-run at each typing
pause; measure at the 100K-block baseline before adding another consumer.

## Verified

- vitest on `LinkedReferences`, `UnlinkedReferences`, `useBacklinkGroups`
  and `useUnlinkedReferences`: 4 files, 130 passed, by the builder and again
  by me; per-file counts unchanged except the one added hook test.
- `npm run typecheck` exit 0, twice; knip exit 0.
- Falsified on a copy, restored `cmp`-clean: the moved `invalidateQueries`
  call removed reddens the new hook test and both component tests.
- Not run locally: the full suites (CI carries them; the laptop is in use).
