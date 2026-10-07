# Session 1888 — review note from #5305

This is the follow-up PR for the sweep that merged #5305, #5307 and #5309.
The reviewer left no notes on #5307 or #5309.

Its one note on #5305 holds. The journal-template catch comment in
`SpaceManageDialog` still said a released id is retried on "the next render".
The same stale wording was fixed one block up in #5305. Retries come from the
next `availableSpaces` change, and the comment now says so.

The change is comment-only, with no behaviour change.
