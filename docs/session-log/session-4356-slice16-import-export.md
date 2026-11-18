# Session 4356 — #6926 slices 16 and 17: import and export

`e2e/import-export.spec.ts` joins `REAL_BACKEND_SPECS`, and eight WebdriverIO import specs are ported into it and deleted.

**Triage on the bridge.** 13 of the spec's 19 tests passed as they were. The other six, none a backend defect:
- *the warning count*: it asserts the mock's canned "attachments are not imported" warning, so it is `@mock-only`.
- *the properties-set count*: the backend reported 2 where the test expected 1. A `- ` item also stores its list style (`listStyle: bullet`, #6190), which the mock does not count; probed on the bridge, the block holds `mood` and `listStyle`. The fixture is a paragraph now, which reports 1 on both.
- *the three link and tag token tests*: the backend's export names a link's page and a tag (`[[Quick Notes]]`, `#work`), the mock writes the stored ids. That is decided (#5071, the grammar in Rust only), so the tests assert the names and are `@real-only`.
- *import then export*: the raw `import_markdown` invoke lacked `dialect`, `runPages` and the progress channel, which the backend requires and the mock never checked. It imports through the Data tab's file input now.

**Ported**, as `The real importer` (`@real-only`: the mock's import is flat and models no link, keyword, property or callout): `import-markdown-nesting`, `import-markdown-readme`, `import-obsidian-comment`, `import-vault-adopts-link-target` (both orders), `import-logseq-graph`, `import-logseq-query`, `import-logseq-tasks` (3), `import-notion-org` (4). Each bridge test runs on a fresh vault, so the WDIO run-scoped markers are gone; a resolved link is checked by the chip's `data-id` against the page `list_all_pages_in_space` names, which also fails on a twin page. The Notion test's title checks were already the mock test's.

**Shown red on the bridge**, each break in one bridge build: `comment_as_callout` off, `STARTED` read as TODO, `rewrite_org_blocks` off (also reddened the Org `id:` test), `[#A]` kept as `A`; parents ignored (depth), every import title minted anew (twins); link bodies dropped, Logseq `TODO` read as DOING; the export's names dropped; `properties_set` never counted. Each of the 14 ports and three of the four rewritten tests failed at the assertion on the stored effect. An adopt-arm break (`ImportTarget::Adopt` never taken) reddened nothing: a run's own link-created page merges instead, so that break was replaced. The round-trip test changed only its call path and was not shown red.

**Ran:** the spec on the bridge three times (93 passed) and on the mock twice (32 passed); `npm run typecheck`; `node --test scripts/e2e-related.test.mjs`; the commit hooks.

## Slice 17: import and export, part 2

Nine WebdriverIO specs are ported into a new `e2e/import-formats.spec.ts` (on `REAL_BACKEND_SPECS`) and deleted: `import-formats` (12 tests), `import-obsidian-vault`, `import-reimport-merge` (4), `import-bibliography-warnings` (its four tests on one shared vault are one test here, as each bridge test gets a fresh vault), `import-export-folder`, `export-roundtrip` (3), `export-restore`, `vault-restore` and `ref-property-export-roundtrip`: 26 tests. `vault-restore` is not a duplicate of `import-export.spec.ts`'s restore test, which picks a hand-made folder; the port exports the real whole-vault ZIP and picks it twice. `attachment-image-render` is ported as the image test but kept whole in WDIO: its one test is both the storage half and the WebKitGTK render under the CSP, which folds into smoke 13 later.

All but the image test are `@real-only`: the mock's import has no attachments, links, task keywords, nesting or properties, and its export writes no names. The image test passes on the mock too, which stores attachment bytes. No backend divergence.

Two harness traps: Playwright's directory upload cannot read a file whose name is not ASCII (`Über.md`), so `importFolder` sets the FileList in the page, each File carrying `webkitRelativePath`, as the WDIO helper did; and an import's confirmations can reuse one dialog node, so `confirmEach` waits for the confirmed dialog's text to go. Two flakes found by `--repeat-each`, both in the spec's selectors: a row's text gains a list marker (`•`) once the block's list style loads, and a referenced block's text gains a child, so the page-copy rows strip the marker and the anchor test picks its row by excluding the linking one.

**Shown red**, each test once at an assertion on what was stored or shown: frontend breaks (title separators kept, the Evernote task-group and code-block selectors missed, `.enex` tags dropped, Joplin to-dos ignored, list items padded, the ZIP's relative asset path, the space file's property definitions skipped); Rust builds (attachments never ingested, the bibliography's `journaltitle` ignored, a ref value exported as its id; merges never taken, `read_attachment` returning no bytes, the export's task marker dropped; a pasted page copy's front matter read as blocks). One merge break (`run_pages.is_empty()`) did not reach a single-file pick and was replaced; one build that failed to compile left the previous mutated binary in place, so only that run's frontend break was counted. The page-copy test's first "red" was the list-marker flake, and was replaced by the front-matter break.

**Ran:** the new file on the bridge three times (78 passed) and on the mock twice (2 passed, the rest `@real-only`); the flaky pair ten times each after the fix (20 passed); `npm run typecheck`; `node --test scripts/e2e-related.test.mjs`; the commit hooks.

Disk: the cloud box's allowance filled mid-session; removing `src-tauri/target/debug/incremental` (14 GB) freed it, and bridge builds then ran with `CARGO_INCREMENTAL=0`.
