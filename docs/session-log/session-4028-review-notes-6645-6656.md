# Session 4028 — review notes from #6645, #6647, #6649 and #6651; the README's iOS sentence

Finished the `claude/review-notes-6645-6656` branch from the overnight handover (#6667). The builder was cut off; this session rebased it onto `main`, resolved two conflicts with #6655's "saved views are always left out" wording, and checked each note against the reviewer bot's body on its PR.

Shipped:

- #6645: `onCopyAppLink` is a required prop of `PageHeaderMenu` (`PageHeader` always passed it), so the menu loses a branch that never ran; the menu's first item is now Copy app link, and the tests that counted items or read the first focus say so. The complexity warning drops from 31 to 27, still over 25.
- #6647: `wdio.conf.ts` types the reconciliation report with `ReconciliationReport` from the bindings instead of an inline copy.
- #6649: `e2e/tab-reorder.spec.ts` calls `dndClickGuardLifted` instead of its copy.
- #6651: `nameToFlatSegment` (was the private `spaceNameToFolderName`) names the saved Markdown file.
- The `query` MCP tool description and `docs/features/agent-access.md` say a negated `template` predicate still leaves templates out, as `names_template_property` does.
- #6549's last edit: the README says there is no iOS build and none is planned for now. `docs/FEATURE-MAP.md` and `reminders.rs` no longer send readers to #4554, which closed as completed after its scope was narrowed to the desktop slice; the rest is stated as not built and untracked.

Dropped, with the reason: #6655's note on `createViewPage` (a page created by sync between the name check and `create_page_in_space` would be stamped as a view) is a race between two of the user's own devices inside one IPC round trip, and the only clean fix is a create-only flag on the command; #6656's shared count SQL cannot be one string under `query!`, which needs a literal per call site, and its `map_or(true, …)` note covers an op that fails to parse after it was appended, which the reviewer calls unreachable. #6657's comment note belongs to the `claude/6551-6523-edit-and-press-start-sync` branch. The wip commit's reformatting of four conformance fixtures (same JSON, keys reordered) was dropped.

Ran: vitest over `src/components/pages/__tests__/` and the export tests, `npm run typecheck`, oxlint on the changed files, Playwright `tab-reorder`, `page-kebab`, `pages-header-routes` and `import-export` (31 pass), and the `mcp::tools_ro` Rust tests with the description snapshot regenerated.
