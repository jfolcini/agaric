# Session 2615 — e2e specs carry area tags, and `just e2e-related` picks the ones a change can affect

#5845, built end to end.

- **Tags:** every Playwright spec (238) and WebdriverIO spec (86) ends each
  top-level title with its `@area` tags, from a fixed vocabulary of 13
  (attachments, boot, editor, graph, journal, markdown, mcp, mobile, pages,
  search, settings, spaces, sync). In the title, not Playwright's
  `{ tag }` option: 58 Playwright files have no top-level describe and
  many have several, so the option meant reformatting about 7,400 lines;
  Playwright reads title tokens as tags all the same (`--grep @graph`), and
  WebdriverIO uses the same form.
- **`scripts/e2e-related.sh`** (`--cached` default, `--range`, `--worktree`,
  `--stdin`, as the other selectors): a path-word table maps changed files
  to areas, and it prints one command per lane for the specs carrying those
  areas plus the changed ones, deleted specs left out. A `src/` or
  `src-tauri/` path no word matches, the lanes' shared helpers, the mock,
  the runner configs and the manifests run a lane whole. Backend paths
  select only WebdriverIO specs. Playwright's `--only-changed` narrows the
  files it is given rather than adding to them, so the script lists
  changed specs itself. `just e2e-related`.
- **`scripts/e2e-related.test.mjs`** (node:test, in `lint`'s script tests,
  so a spec-only PR runs it): every spec is tagged from the vocabulary and
  parses, and a `src/editor/` change selects both lanes' editor specs.
- Root `AGENTS.md` (approved) and both lanes' AGENTS.md carry the rule and
  the recipe.

Ran: the node test (8), red with a tag removed, an unknown tag, an
unparseable spec, a broken tag match and a dropped whole-lane rule;
`playwright test --list --grep` over the union of the tags lists all 1,312
tests; typecheck for the app, e2e and e2e-tauri projects; shellcheck;
oxlint; prek. Neither e2e suite was run.
