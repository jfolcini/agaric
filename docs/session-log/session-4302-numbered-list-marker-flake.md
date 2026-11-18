# Session 4302 — the /numbered-list spec raced the focused block's marker

Two tests in `slash-commands-coverage.spec.ts` read the focused editor's text right after `/numbered-list` and expected only the block's text. Since #3000 the roving editor paints the `1.` marker as a widget inside the contenteditable once the `listStyle` property lands, so `toHaveText('first item')` passed only when it read the editor before that paint, and failed for good once the marker arrived first ("1.first item "). The app is right; the assertion was.

The Enter test now waits for the `.list-marker` widget, then asserts the text beside it, the shape `list-style-keyboard.spec.ts` already uses. The Escape test (#4577) accepts the text with or without the marker: waiting for the marker there would delay the Escape and let the pending edit commit by itself, which is the regression it guards.

## What ran

- Before, on 088d761: `-g "numbered-list" --repeat-each=40 --workers=8` failed 7 of 80, every red the marker in the received text (the orchestrator's run had 13 of 160).
- After: the same two tests ×80 on 8 workers, 160 of 160.
- Falsified: with `buildDecorations` returning no marker, the Enter test goes red on the new `.list-marker` assertion.
