# Session 4356 — #6926 slice 16: import and export, part 1

`e2e/import-export.spec.ts` joins `REAL_BACKEND_SPECS`, and eight WebdriverIO import specs are ported into it and deleted.

**Triage on the bridge.** 13 of the spec's 19 tests passed as they were. The other six, none a backend defect:
- *the warning count*: it asserts the mock's canned "attachments are not imported" warning, so it is `@mock-only`.
- *the properties-set count*: the backend reported 2 where the test expected 1. A `- ` item also stores its list style (`listStyle: bullet`, #6190), which the mock does not count; probed on the bridge, the block holds `mood` and `listStyle`. The fixture is a paragraph now, which reports 1 on both.
- *the three link and tag token tests*: the backend's export names a link's page and a tag (`[[Quick Notes]]`, `#work`), the mock writes the stored ids. That is decided (#5071, the grammar in Rust only), so the tests assert the names and are `@real-only`.
- *import then export*: the raw `import_markdown` invoke lacked `dialect`, `runPages` and the progress channel, which the backend requires and the mock never checked. It imports through the Data tab's file input now.

**Ported**, as `The real importer` (`@real-only`: the mock's import is flat and models no link, keyword, property or callout): `import-markdown-nesting`, `import-markdown-readme`, `import-obsidian-comment`, `import-vault-adopts-link-target` (both orders), `import-logseq-graph`, `import-logseq-query`, `import-logseq-tasks` (3), `import-notion-org` (4). Each bridge test runs on a fresh vault, so the WDIO run-scoped markers are gone; a resolved link is checked by the chip's `data-id` against the page `list_all_pages_in_space` names, which also fails on a twin page. The Notion test's title checks were already the mock test's.

**Shown red on the bridge**, each break in one bridge build: `comment_as_callout` off, `STARTED` read as TODO, `rewrite_org_blocks` off (also reddened the Org `id:` test), `[#A]` kept as `A`; parents ignored (depth), every import title minted anew (twins); link bodies dropped, Logseq `TODO` read as DOING; the export's names dropped; `properties_set` never counted. Each of the 14 ports and the four rewritten tests failed at the assertion on the stored effect. An adopt-arm break (`ImportTarget::Adopt` never taken) reddened nothing: a run's own link-created page merges instead, so that break was replaced. The round-trip test changed only its call path and was not shown red.

**Ran:** the spec on the bridge three times (93 passed) and on the mock twice (32 passed); `npm run typecheck`; `node --test scripts/e2e-related.test.mjs`; the commit hooks.

Disk: the cloud box's allowance filled mid-session; removing `src-tauri/target/debug/incremental` (14 GB) freed it, and bridge builds then ran with `CARGO_INCREMENTAL=0`.
