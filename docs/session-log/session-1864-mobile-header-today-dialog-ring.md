# Session 1864 — Today everywhere, square mobile drawer, unclipped dialog focus rings

Four UI reports from the maintainer.

**Mobile drawer had rounded corners.** The nav drawer is a left `Sheet`, which
rounds its inward corners like a modal card. The sidebar's mobile `SheetContent`
now passes `rounded-none`.

**Today should always show, everywhere.** It was hidden on today's daily page,
in stream mode, below `sm` (re-offered inside the calendar dropdown instead),
and on every view outside `pages`/`search`/`tags`/`query`. Now it is on every
header in every mode. Today in stream mode lands on today's daily page, as it
already did from agenda. The dropdown's phone-only copy (`onToday`) is deleted.
`GlobalDateControls` owns the `DATE_CONTROL_VIEWS` set and gates only Agenda and
the calendar on it. Its journal-view hide branches were unreachable, since the
journal renders `JournalControls`, so they and their tests are gone.

Fitting it: at 360px a text button squeezed the date chip to one letter.
Below `md` it is a 24px ghost house icon (the maintainer picked this over
collapsing the mode tabs). The 640-1023px touch band had a separate
defect: the date span's `sm:min-w-[100px]` was wider than the squeezed chip,
so its centred text spilled out under the chevrons. That floor is now
`lg:`-only. Non-journal phone headers wrap instead of stacking every control
on its own row, so "Settings · Today · search" is one row.

**Quick-capture textarea border looked wrong.** The dialog/sheet body is a
ScrollArea whose viewport clips overflow and had `px-6` but no vertical
padding, so a focused first or last field lost the top and bottom of its 3px
ring (measured: ring present at the sides, absent above and below). The shared
viewport class gains `py-1`; the three bodies take `-my-1` so layout is
unchanged.

**Property Definitions create row.** `SelectTrigger` is `w-full` by default and
out-grew the `flex-1` key input, leaving it about 24px wide. The trigger is now
`sm:w-36`.

## Verified

Playwright (system Chrome via a throwaway config; the bundled Chromium
download timed out): `mobile-overflow.spec.ts` and `properties-system.spec.ts`
green at 360px and 390px. Each new assertion (drawer radius, Today in every
mode plus chip width, textarea ring room, create-row widths) went red against a
mutated copy and the file was restored and `cmp`-checked. Unit tests for the
journal/agenda/App surfaces were falsified the same way. `npm run typecheck`
clean.

## Weekly scheduled run

The last two `scheduled-deep-checks` runs were red. On 09-21 `full-suite-prek`
failed on zizmor `ref-version-mismatch`: upstream moved the
`dtolnay/rust-toolchain` `v1` tag. On 09-28 `fuzz` hit an `import_parse`
char-boundary panic. Both are already fixed on main (#5116/#5230, #5228), and
zizmor passes on main today. The pin has been hand-moved four times since
August (#3434, #4502, #5116, #5230), each after a red run. That recurrence is
reported to the maintainer, not changed here.
