# Session 3075 — Settings rows fit their panel at tablet widths

Found by #6181's stronger overflow check: at 768–900 px wide, Settings › General, Editor and Keyboard cut their controls off. The date-format choice and the "Edit shortcut" buttons ran past the card, where nobody could scroll to them.

**Cause:** the Settings panel is about 250 px wide at those widths, because the sidebar and the tab rail take the rest. Every `sm:` rule keys on the viewport, though, so the rows laid out as if the whole screen were theirs.
- `SettingRow`'s control was `shrink-0`, with a 288 px select.
- The keyboard rows had fixed key and action columns that never wrapped.
- The quick-capture controls did not wrap.
- `SelectTrigger`'s flex rule on its value overrode `line-clamp-1`, so a long value was cut off with no ellipsis.

**Changed:**
- **`SettingRow`** wraps its control under the label when the row is too narrow. `ToggleRow` and the device-ID row keep their small control beside the label.
- **The keyboard rows** key on their list's own width (`@container`, `@lg:`) instead of the viewport.
- **The quick-capture controls** wrap.
- **A select's value** truncates with an ellipsis. The full text stays in the open list. `text-start` sits on the trigger, so a `block` caller stays start-aligned.
- **`e2e/AGENTS.md`'s overflow section** says what the page check now catches. The maintainer approved the edit.

**Not changed:** the tab rail stays visible at tablet widths, because the touch-tablet test in `settings-phone.spec.ts` needs it.

**Red first:**
- **The spec:** the new `mobile-overflow` describes sweep every Settings tab at 768 and 820 px. Against the unfixed rows, 6 of the 24 tests fail on "content cut off by a box that cannot scroll sideways": General, Editor and Keyboard at both widths. They name the `ScrollArea` viewport and the `shrink-0` control.
- **The 1024 width was dropped:** it passed against the unfixed code, and it is the same layout as 768 with a wider panel.

**Review:**
- **Two regressions fixed:**
  - the agenda Property filter's `block` trigger centred its key;
  - the device-ID copy button dropped under the ID.
- **Checked:**
  - At 390 and 1280 px, every Settings tab is pixel-identical to main.
  - The Space switcher and the Pages, References, History and Advanced Query selects are unchanged.
  - Container queries work in WebKitGTK 2.52.6, driven through WebKitWebDriver against the built bundle.
  - Touch targets stay 44 px.
- **Known trade-off:** at 1024 px, the two Import rows whose buttons are wider than about 198 px wrap under their labels, while the other four stay beside them. Only a card-level container query on `SettingRow` would avoid that.

**Suites:**
- vitest over `ui`, `settings`, `layout` and `peers` (1,440 tests);
- typecheck and lint;
- the manual-stage hooks;
- Playwright:
  - `mobile-overflow`, `interface-zoom` and every `settings*` spec (111);
  - 11 specs that drive a `Select` (56).
