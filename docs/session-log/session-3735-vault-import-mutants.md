# Session 3735 — the vault-import mutants

The last PR of this frontend mutation sweep (#4691), for the vault importer (#3766). On `origin/main`, `node scripts/run-mutation.mjs vault-import` showed 27 no-coverage mutants and 55 survivors. The issue listed 50 survivors, from an older test file. Each mutant now has a test, a deletion, or a reasoned entry in `mutation-accepted.tsv`.

## What shipped

- **Restoring a space file had no test at all.** That's `restoreSpaceFile`, where all 27 no-coverage mutants sat. A new describe drives it through a stateful fake backend built with `mockInvokeCommands`. The fake matches `create_property_def_inner`: a key the space already holds changes nothing, and a built-in key is refused. Each test re-queries the space through `listAllPropertyDefs`. The tests cover:
  - every definition is created, and titles are answered by path;
  - a definition the space already holds is left alone, a built-in one included, with no warning;
  - a refused definition is warned of and logged, and the others are still restored;
  - a space whose definitions can't be read is warned of and logged, and its titles are still answered;
  - a space file that can't be read is logged;
  - malformed space files (titles that are a string, a title that is no string, a null definition) say so.
- **Other tests:**
  - a backslash in a path reads as a folder separator;
  - a legacy config is read wherever it falls in the pick;
  - which page a plain pick's note, an enex note and a jex note may merge into;
  - a `file:` link to a Markdown note stays relative for the backend;
  - a note outside a Logseq graph keeps its file name;
  - each file is read with the right dialect.
- **Each kill was seen red.** The builder applied each mutation in a command that restores the file and watched the predicted assertion fail. The one exception is 570:91, whose red is the note's `load()` rejecting, which is the import failing.
- **One deletion.** `restoreSpaceFile` checked `webkitRelativePath !== ''` before comparing the path to `.agaric/space.json`. `vaultRelativePath('')` is `''`, which never equals that path, so the check did nothing.
- **Two equivalents,** recorded with reasons:
  - **`if (org.fileId !== null)`.** It only adds a null key to `ids`, and org-import reads `ids` only with string ids taken from a link.
  - **`target === null ? undefined : orgTitles.get(target)`.** `orgTitles.get(null)` is `undefined` as well.

## Traps

- **The registry needed `setup: true`.** The space-file tests use `vi.mocked(invoke)`, the global mock from `src/test-setup.ts`. Stryker's vault-import entry did not load that file, so the dry run failed with "mockImplementation is not a function" while plain vitest passed. The entry now opts in with `setup: true`, as the registry's own comment prescribes for modules tested through that mock. Expect the module's Stryker run to be slower.
- **Run the type-aware linter.** Plain `npx oxlint` on the changed files is not `npm run lint`: only the type-aware run catches a floating `act()`. That is what reddened #6476's lint.

## Counts

vault-import, distinct tracked mutants (no coverage + survived) net of `mutation-accepted.tsv`: 27 + 55 on `origin/main`, 0 on this branch.

Suites run: the full vitest suite, `npm run typecheck`, `npm run lint`, `e2e/import-export.spec.ts` (18 of 18), and the Stryker pass above on the rebased tree.

#4691 stays open: enex-import (#4815) is another session's.
