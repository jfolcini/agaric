# Session 4496 — multi-select's checkboxes and focus ring, and colour dots in the space switcher

Part of the #7040 UI review, items O4 and O9; O3 was a false premise.

**What shipped**

- **O4, multi-select on desktop.**
  - The block gutter's selection checkbox is `ui/checkbox`, as Trash and Pages use, not a native black box. Its tooltip sits on a wrapping span: on the Checkbox, the tooltip trigger's `data-state` replaced the checked state the primitive's styles key on. On touch an unselected row no longer renders the checkbox at all, where CSS hid it before.
  - The cursor row keeps the focus, but its 3 px ring moved from the `<li>`, which spans the gutter, to the block's content column (`group-focus/row`, `data-testid="block-content"`), so it lines up with the selection box and stops short of the drag handle. A task's checkbox stays outside the ring; D3 covers the focused task's box.
- **O9, the space switcher.** Every option shows its space's colour, in the desktop Select and in the phone's menu sheet, through one `SpaceDot` that also draws the trigger's dot. `SelectItem` gains a `startContent` slot outside the text Radix copies into the trigger, so the trigger still shows one dot. A space with no accent (one made by an import) drew its dot in `--accent-current`, the active space's colour; it now uses `DEFAULT_ACCENT_TOKEN`, the colour it shows once current.

**False premises in the issue**

- **O3:** the desktop date picker (`BlockDatePicker`) is the `ui/dialog` Dialog, portalled to `<body>` with a fixed full-window scrim; `elementFromPoint` over the sidebar, the header and the content all hit it, and the review's own screenshot dims evenly. The journal's calendar dropdown dims nothing on purpose: it is non-modal, like `TemplatePicker`.
- **O4's "Clear and × do the same thing":** "Clear" in the batch bar sets every selected block's task state to none; "×" (Clear selection) only empties the selection. Both stay.

**Tests**

- e2e (mock lane): `batch-operations` (the selection checkbox is the app's Checkbox; the cursor's ring starts right of the drag handle), new `space-switcher` (each option's dot, on a desktop and a phone).
- vitest: `SpaceSwitcher` (each option's dot; an unset accent takes the default).
- Shown red on the old code and each under one mutation: the native input back, the ring back on the `<li>`, `startContent` inside the copied text (two dots in the trigger), the slot dropped, the phone dot removed, the unset-accent default removed.
- **Edited to the new markup:** `block-select-cursor`'s `expectCursorOn` (the ring is on `block-content`, not the `li`); `BlockGutterControls.test` (`type="checkbox"` → `data-slot="checkbox"`, `.checked` → `toBeChecked()`, an unselected touch row has no checkbox); `SpaceSwitcher.test` (the unset-accent fallback is the default accent).
