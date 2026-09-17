# Session 1775 — a keyboard-opened ref peek never took focus

Carried over as an unverified suspicion: `BlockRefPeek`'s focus effect has deps
`[refId, fromKeyboard, peekRef]` and no `position`, so `.focus()` could fire
while the peek is still `visibility: hidden` and never retry. The standing rule
on it was that it must not be filed or fixed without browser evidence, because
jsdom accepts focus on a hidden element and the component suite therefore
cannot see it either way.

This session got the evidence. The suspicion was right, and probing it turned
up a second, separate defect that is NOT fixed here.

## The keyboard path, traced

`useBlockRefPeek.handleKeyDown` is a window bubble listener on the one
delegated host per page container. `Alt+ArrowDown` with no other modifier takes
`document.activeElement.closest('[data-type="block-ref"][data-id]')`, requires
it inside the host, and opens with `fromKeyboard = true`. The focusable chip is
the read-only one (`RichContentRenderer/marks/blockRef.tsx`: `role="link"`,
`tabIndex={0}`, `aria-haspopup="dialog"`), so the path is Tab to a static
block's chip, then `Alt+ArrowDown`. The TipTap NodeView chip is inside a
contenteditable where `activeElement` is the editor, not the chip. Hover never
sets `fromKeyboard`; `focusin` is the close path, not an open path.

## What the browser did

With `HTMLElement.prototype.focus` patched in an init script to record computed
`visibility` at the moment of the call, after `Alt+ArrowDown`:

```
focusLog: [{ target: "ref-peek", visibilityAtCall: "hidden",
             inlineStyle: "left: 589.453px; top: 247.938px; visibility: hidden;",
             activeAfter: "block-ref-chip" }]      ← focus() refused
settled (+1000ms): peek "visible", active still "block-ref-chip"
after Tab: peek dismissed, activeElement = <button>Add block</button>
```

`.focus()` fires once, the element is hidden, the browser refuses it, and the
effect never re-runs once `computePosition` lands. The peek is on screen and
unreachable. The first `Tab` walks past it into the page's "Add block" button,
which fires `focusin` outside chip+peek and dismisses the peek — so its `Open`
and `Copy reference` actions cannot be reached without a pointer.

Worth noting for future specs: `expect(peek).toBeVisible()` passes throughout.
Visibility was never the symptom.

## The fix

Gate the focus effect on a resolved `position`. Two lines. `position` already
resets to `null` on close, so a re-open always passes through the hidden state
before focusing, and there is no stale-position early focus.

Focus is taken twice, not once: when the payload lands, the positioning effect
re-runs, resets `position` to `null`, hides the peek for a frame and drops
focus to `<body>`; the second placement re-focuses. The spec asserts focus
*after* the payload text is present, so that round trip is pinned rather than
assumed.

A bound this leaves, stated rather than hidden: a user who tabs to `Open` in
the window between the first placement and the payload landing has focus pulled
back to the dialog container by that second call. The window is one render
wide, and before this change focus never arrived at all, so the trade is
strictly positive; the root cause is the unconditional `setPosition(null)` in
the positioning effect, which is not this change's to relitigate.

## Escape is separately broken, and NOT fixed here

Escape does not close a keyboard-opened peek, before or after this fix:

```
window-capture     target=block-ref-chip  defaultPrevented=false
document-bubble    target=block-ref-chip  defaultPrevented=false
window-bubble-last target=block-ref-chip  defaultPrevented=true
→ peek still open, chip aria-expanded="true", title still parked
```

`handleCloseOverlays` (`useAppKeyboardShortcuts.ts`) is an App-level window
bubble listener mounted before `useBlockRefPeek`'s, and it calls
`preventDefault()` for any Escape outside a typing field.
`useBlockRefPeek.handleKeyDown` opens with `if (e.defaultPrevented) return`, so
the peek's Escape branch only runs when focus is in the editor or an input —
the hover case. The `held === true` branch, which restores focus to the chip,
is dead in the real app. The jsdom suite passes it because it renders bare
chips with no App shell, so nothing preventDefaults first.

Left for its own change: the fix is a design call between three options (have
the peek listen for `CLOSE_ALL_OVERLAYS_EVENT`, teach `handleCloseOverlays` to
skip while a peek holds focus, or move the peek's listener to capture), and it
touches hooks outside this change's scope. Filed with the trace above.

## Verified

`e2e/block-ref-peek-keyboard.spec.ts` asserts focus is inside the peek right
after `Alt+ArrowDown`, still inside after the payload lands, and that one `Tab`
reaches the peek's `Open` button with the peek still open.

Shown red against the unfixed component, twice — once by the agent that wrote
it and once independently, after killing the preview server by port so the run
rebuilt rather than serving a stale bundle:

```
Error: expect(locator).toBeFocused() failed
Expected: focused
Received: inactive
  34 × locator resolved to <div role="dialog" tabindex="-1" data-testid="ref-peek" …>
     - unexpected value "inactive"
```

The first attempt at that independent run is worth recording as a near miss:
`pkill -f "vite preview"` matched the running shell's own command line and
killed it mid-sequence, leaving the REVERTED component on disk with the new
comment still above it — a comment claiming a gate the code no longer had.
Caught by checking the file rather than trusting the exit code, and restored.
That is the #4287 / #4018 / #4204 failure mode exactly, and the reason the rule
is to mutate a copy and `cmp` afterwards.

Green after restore: `block-ref-peek-keyboard.spec.ts` + `block-ref-peek.spec.ts`
→ 2 passed. `BlockRefPeek.test.tsx` + `useBlockRefPeek.test.ts` → 26 passed.
`npm run typecheck:e2e` clean.
