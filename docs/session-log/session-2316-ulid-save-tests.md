# Session 2316 — Two Edit as Markdown tests caught between merges

#5696 and #5697 each passed CI alone and were merged minutes apart. #5696
renamed Edit as Markdown's Save to "Save (N changes)". #5697 added two tests,
"Save warns, naming each one once, and saves anyway" and "Save warns of
nothing when every one resolves", that looked the button up by the exact name
"Save". Together they made `PageSourceEditor.test.tsx` fail on main, which
surfaced through another PR's pre-push verify.

The two tests now use the file's existing `saveButton()` helper, which
matches the label with or without the count; the file passes 76 of 76. A
search of the other exact "Save" lookups found them on other dialogs, or on
an unchanged page whose label is still "Save".

Lesson for the batch: two approved PRs that touch the same component can
each be green and still break main together. Before merging the second,
rebase it on the first or rerun its tests on the merged tree.
