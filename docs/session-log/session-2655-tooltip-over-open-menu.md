# Session 2655 — a tooltip never sits over its trigger's open Select or menu

Two #5908 flakes, `pages-view.spec.ts` sort ("the listbox stays open after
Escape") and `spaces-management.spec.ts:118` (the switcher's "Ctrl+1–9"
tooltip intercepting the click on an option), had one cause, and the second
was failing most PR runs of its shard.

- **Mechanism (Radix source):** the Select trigger calls `preventDefault()` on a
  mouse pointerdown, and Radix skips the tooltip trigger's own close once the
  event is prevented. The tooltip's pointerdown-outside dismissal is attached
  in a `setTimeout(0)` after it mounts. So a tooltip that opens in the same
  moment as the press (focus returning to the trigger, or a hover) stays open
  over the listbox as the topmost layer, with inline `pointer-events: auto`:
  it takes the Escape meant for the listbox and the clicks on its options. A
  person could hit it too.
- **Fix, in `ui/tooltip.tsx` only:** a tooltip refuses to open while its
  trigger (or something inside it) has `aria-expanded="true"`, and while open
  a `MutationObserver` on the trigger closes it when the menu opens, checking
  once on start because the menu can open before the effect runs. It covers
  the Pages sort, the space switcher, the page header kebab and every icon
  button that opens a menu, with no call-site change.
- **Workarounds removed:** `switchToSpace`'s `page.mouse.move(0, 0)` and the
  spaces spec's "first Escape only closes the tooltip" skip; the spec's open,
  check, Escape step from before #5515 is back.

Shown red naturally: with that step restored, the old code failed 5 of 10
runs at two workers; the fix passed the sort and switcher tests 40 of 40.
The vitest race case fails without the observer, the open-gate cases fail
without the gate, and the old code fails all three.

Ran: every spec that uses `switchToSpace`, plus `pages-view`,
`tooltip-pointer-events` and `spaces-management` (60); vitest over
`ui/__tests__`, SpaceSwitcher, PageBrowser and PageHeaderMenu (994);
`npm run typecheck`; `oxlint src e2e`.
