# Session 4418 — vault-import's mutation survivors, and typing kept through a refused slash command

**Ask.** Kill the new frontend survivors deep-checks run 44519358559 reported at a1c7358, all in `src/lib/vault-import.ts`'s Logseq naming, or record the equivalent ones; and fold in #7019's review note.

**Killed.** Three tests in the `Logseq graph (#6033)` block of `vault-import.test.ts`, each red on its mutants applied as the report gives them:
- an Org page is titled by its file name, not a `title::` line: `extension === '.org' || notion` forced false (both positions), turned to `&&`, and `'.org'` emptied;
- a note outside `pages/` that shares a tag page's title keeps its name: `startsWith('pages/')` emptied;
- a Markdown page merges into the page of its Logseq title, not an Org `#+TITLE` line in it: the merge's `if (extension !== '.org') return path` forced false. The run reported it at line 693, which on a1c7358 is this line, not the `source` line.

**Equivalent.** Four go in `mutation-accepted.tsv`, each with its reason: the graph-less branch's `{ tags: [], title: null }` emptied, and its tags given the mutator's mixed-case string (that branch's tags are read only with a graph, and a tag page needs a lowercase title equal to the tag); and `read[index]?.` and `relPaths[index]?.` without the `?` (both arrays are `notes.map`, so every index exists).

**#7019's note.** A refused content slash command put back the text from before it, dropping what was typed on top of its text while its write was on its way. The refusal now keeps the editor's live text when it differs from the command's, and saves it. `useSlashCommandStructural.test.ts` gains "typing during a refused write is kept and saved", red without the change.

**Ran:** `npx vitest run src/components/block-tree src/lib/vault-import.test.ts src/lib/__tests__/vault-import-merges.test.ts src/lib/__tests__/logseq-import.test.ts`, `npm run typecheck`, and each mutant applied by hand against `vault-import.test.ts`.
