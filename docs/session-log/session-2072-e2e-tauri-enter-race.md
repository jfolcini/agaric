# Session 2072 — e2e-tauri: wait for Enter's blank block before acting on it

`attachment-only-block-survives-blur.e2e.ts` failed on #5551's run with the pasted
attachment on the marked block instead of the blank one below it. Enter's new block
takes focus after a create round-trip, and the spec pasted straight after the key
press, into whichever block the roving editor was still in. `focusedBlankBlockId`
now waits until the editor is in a blank block rather than asserting it once, and
the attachment arm calls it before pasting. The two control arms that already call
it after Enter get the same wait.

Verified: `tsc -p tsconfig.wdio.json`, oxlint and oxfmt. The lane itself cannot run
locally; it runs on this PR.
