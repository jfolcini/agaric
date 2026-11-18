# Session 4283 — fix the English source strings the #6879 translation reviewers flagged

The ask: file one issue for the English strings the #6879 reviewers flagged (session 4244, "Follow-ups not done here") and fix them, keeping es, pt, de and fr in step. Issue #6903.

## What shipped

- **Sentence case.** Every multi-word Title Case label the rule catches is now sentence case in English: the five named (`pageBrowser.newPage`, `sidebar.newPage`, `history.title`, `queryBuilder.title`, `property.createdAt`) and `sidebar.query`, `sidebar.toggleSidebar`, `sidebar.newPageTooltip`, `contextMenu.moveUp/moveDown`, `shortcuts.title`, `welcome.getStarted`, `emojiPicker.frequentlyUsed` and the five `emojiPicker.group.*`, `compaction.compactNow/confirmTitle`, `query.column.dueDate`, `queryBuilder.insertButton/updateButton`, `property.drawerTitle` and the other `property.*` field labels, `references.header*`, `unlinkedRefs.header*`, `graph.title`, the six `backlink.*Option`, `tag.addTag`, `keyboard.section.deepLinks`, `dateChip.nextWeek`, `unfinished.title`. The four translations were already sentence case, so none changed. Left as they are: view names used as names (Trash, Journal, Pages), brand and theme names, a count followed by one noun in the agenda panels ("3 Completed", "3 Agenda"), and the sample page titles the welcome dialog creates ("Getting Started", "Quick Tips"), which are user content.
- **Glued fragments.** `TagFilterPanel` rendered `blockMatch` + space + `selectedTags`. It now renders one message, `tagFilter.blockMatchTags` ("{{count}} blocks match {{tags}} ({{mode}})"), whose `{{tags}}` is `tagFilter.tagCount` ("2 tags"). `DuePanel` built "3 Due" from a bare count and the filter-pill label. It now uses `duePanel.countDue` / `countScheduled` / `countProperties` ("3 due", "2 scheduled", "1 by property"), each with plural forms. The pill labels keep their own keys.
- **`meeting.created`** is `Created "{{title}}"`, so the default title no longer reads "Meeting Meeting 2026-11-18 created".
- **`searchQuery.unknownValue`** took the English noun "state" or "priority". It is now two messages, `searchQuery.unknownState` and `searchQuery.unknownPriority`, and `simpleValueRecogniser` takes the message key.
- **`diff.hunkCounter`** has `_one` / `_other` forms keyed on `{{count}}` (was `{{total}}`) in every language.

## Tests and specs edited because the English they select by changed

Unit tests: `LinkedReferences`, `UnlinkedReferences` (+ `countIntegrity`), `useUnlinkedReferences` (comment), `FeatureErrorBoundary`, `GraphView`, `BlockPropertyDrawer`, `BlockTree`, `HistorySheet`, `UnfinishedTasks`, `WelcomeModal`, `ShowWelcomeTourRow`, `CompactionCard`, `DateChipEditor`, `EmojiPicker`, `TagList`, `PageBrowser.row-interaction-a11y`, `i18n.test.ts`, `DuePanel` (the mixed-source heading), `MeetingDialog` (now pins the literal toast, so a repeated "Meeting" fails it), and the three `searchQuery.unknownValue` callers in `QueryResult.text`, `inline-query-text` and `query-text`. The e2e and e2e-tauri specs that name the changed labels follow the new text, including `helpers.ts` in both lanes and the `meeting-attachments` toast wait. Strings that only look the same were left alone: page titles in fixtures ("Brand New Page"), the emoji data's own group names, and `formatPropertyName` output ("Due Date", "Created At") in property tests.

## What ran

- `npm run typecheck`: clean. `npx vitest run` over `src/lib/i18n`, `src/lib/__tests__/i18n.test.ts`, every test file that named an old string, and the agenda, filters, rendering, attachments, search-query and query suites: green.
- Red 1: es `diff.hunkCounter_one/_other` put back as the old single `diff.hunkCounter` with `{{total}}`; `locale-catalogs.test.ts` failed naming the two missing keys and the extra one. Restored by trap, checked with `cmp`.
- Red 2: `TagFilterPanel` passing `tag:` instead of `tags:` to `tagFilter.blockMatchTags`; six `TagFilterPanel` tests failed on the pinned "… match 1 tag (All)" sentence. Restored by trap, checked with `cmp`.
- `just e2e-related` selects the whole of both lanes (an i18n file has no area), so CI's run is the check. Locally, the 46 edited Playwright specs: 436 passed, 8 skipped, 4 failed on case-sensitive regex selectors (`/References?$/`, `/1 Unlinked Reference$/`, `/Query$/`) and `block-line-break`, outside that run, held the same `/References?$/` pattern. After fixing them, those five specs: 26 passed.
- Not run: the WebdriverIO lane (no `tauri-cli` here).

## Not done here

- English keys with no call site, seen on the way: `property.createdAt`, `property.completedAt`, `property.repeatUntil`, `property.repeatCount`, `property.repeatSeq`, `property.repeatOrigin`, `property.todoState`. Recased, not deleted; they go to the follow-up batch.
- The three surfaces in #6902.
