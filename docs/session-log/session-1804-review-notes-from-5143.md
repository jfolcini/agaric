# Session 1804 — review notes from #5143

The sweep's last follow-up, per AGENTS.md § How we work: the one
non-blocking note on #5143 (itself the follow-up for #5142's notes) lands
afterwards, off fresh `main`, rather than as a push onto the approved
branch.

**The third stale list.** `docs/UX.md` § "Non-obvious rules" still said
`buildInitParams()` sends `valueText: ''` for a number / date / ref /
select property and that this silently fails. Both halves were out of
date: `url` was missing, and since #5143 the helper returns `null` for
every `DRAFT_ROW_VALUE_TYPES` member (text / select / url) instead of
returning an empty string for any type. The line now says what the helper
does and why the caller opens a draft row for those types. Docs only; no
code changed, no test to falsify.
