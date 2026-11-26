# Session 4527 — #7040 review notes, batched (sweep 9)

The non-blocking notes from #7132, #7139, #7141, #7143 and #7145, and a bridge flake, in one follow-up, as AGENTS.md § How we work asks.

**What shipped**

- **Sync row (#7132).** An offline Sync row reads "Sync Offline" but was named "Offline", failing label in name. Its name now holds both words. The comments on its state words no longer describe the sidebar dot #7132 removed.
- **Focus ring (#7143).** The skip link and the page title drew a 2 px ring plus the browser outline. They now draw `focus-ring-visible`, like every other control.
- **External links (#7139).** The ↗ could wrap alone onto the next line.
  - Chromium allows a break after a label's last letter whenever the next box is an inline icon or an out-of-flow box. A word joiner, a nowrap wrapper and end padding alone each failed.
  - The icon now sits in the link's end padding, which stays on the label's last line.
  - The "opens in new tab" hint moved from a hidden span into the link's `aria-label`; the accessible name is unchanged.
  - Print hides the icon, so print also drops the end padding; otherwise a printed link left a blank gap after its address.
- **Block drag (#7145).** `moveBlocks` in the drag hook is typed `Promise<boolean>`. `unfoldLanded` says why it reads the saved folds.
- **narrow-desktop (#7141).** The width formula subtracted the input's padding twice. It now measures the content width once, and the assertion still goes red.
- **search-filter-chips flake.** `seedSearchBlocks` settles the backend after seeding, so the real backend's FTS write lands before the search. An unchanged query's resubmit does not search again (decision 43 changes that in the final follow-up).

**Tests**

- AppSidebar.test and sync-happy-paths pin the "Sync Offline" name.
- interaction-states pins the ring on the skip link and the title.
- print-page pins the printed link's end padding at 0; it read 14.8 px without the print rule.
- external-link-open sweeps the static block from 400 to 40 px. On `main` its ↗ sat alone at 52 widths.
- search-filter-chips was red on the bridge with a slowed materializer and the settle removed.
- Edited assertions: AppSidebar.test, sync-happy-paths, RichContentRenderer.test and StaticBlock.test. Each pinned the old name or the hidden span this changes.
- A separate session reviewed items 1–7 and then item 8, re-running each red.
