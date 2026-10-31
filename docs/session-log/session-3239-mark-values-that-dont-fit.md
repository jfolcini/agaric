# Session 3239 — mark a value that doesn't fit wherever it shows

#6206 slice 4 of 5, frontend only. The maintainer decided that nothing is hidden: a value that doesn't fit its key's type is shown, marked, with a link to its review in Settings › Properties. Before this slice, chips showed such a value unmarked, and four editors in the page property table hid it.

**The rule.**
- `src/lib/property-fit.ts` is the one TypeScript copy of `unfit_values`' rule (`commands/property_unfit.rs`). It moved out of the mock, and the mock imports it back.
- `property-fit.test.ts` copies the Rust tables `each_type_takes_only_its_own_forms_6206` and `a_builtin_select_takes_only_its_options_6206`. That table test pins every arm. The conformance fixtures only exercise the select and text-to-date arms; a reviewer broke the url arm and they stayed green.
- A select whose stored options are not a JSON array takes no text, with a warning. A `JSON.parse(...) as` cast tripped the `json-parse-cast` guard once the code left the mock.

**Chips.**
- Chips read the space's definitions from `useSpacePropertyDefs`: one cached `list_property_defs` query per space, with no IPC per chip. `invalidatePropertyCaches()` invalidates it, so every definition write refreshes it.
- A chip that doesn't fit takes the warning tone and an `UnfitValueMark`.
- The mark opens Settings › Properties with the key's dialog open. It goes through a new field on the existing navigation store, `pendingPropertyReview`, which is not persisted. The dialog clears the field on open.

**Table and sheet.** They mark the value and stop hiding it:
- **Boolean:** shows the stored text beside the indeterminate box.
- **Ref:** shows its text.
- **Select:** shows a disabled item for the dropped option, carrying the stored value so choosing a real option doesn't duplicate it.
- **Number:** becomes a text input.
- **`value_bool`:** reads as true or false.
- **No accidental writes:**
  - leaving a date untouched no longer NL-parses it;
  - an unchanged blur on a marked sheet field writes nothing, so it can't raise an invalid-number toast.

**Not marked, per the comment on the issue:** exports (re-import refuses a value that doesn't fit whatever the mark), search results, the History detail, MCP and the `+N` overflow pill.

**Traps.**
- Strict IPC fails any suite that renders chips with a space set and has no `list_property_defs` stub. `SortableBlock.test.tsx` gained one.
- One existing assertion now also expects the new `kind: 'date' | 'number'` on extra properties. That is a stricter contract the rule needs, because a number under a text key doesn't fit while the text `"42"` does.

**Left as is (minor):**
- A ref value under a number, url or boolean key shows empty, because `readCurrentValue` doesn't read `value_ref`.
- A number `1` under a select with the option `"1"` gives two equal items.

**Review.** A separate reviewer re-ran six reds:
- the select arm and the url arm;
- the sheet guard and the table date guard;
- the e2e spec with `isUnfit` false, and with the slot consumer as a no-op.

It also confirmed no editor writes when a misfit is left untouched.

**Suites:** full `npx vitest run`, typecheck, lint, `prek` (both stages), and 70 Playwright specs matching `propert|setting|mobile|block|page-mode|perf`. That includes the new `e2e/property-unfit-marks.spec.ts` and the perf IPC pins.
