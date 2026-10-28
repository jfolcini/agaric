# Session 2997 — A domain vocabulary for the e2e specs (#6142)

Set out to land the first half of #6142: specs that read as behaviour, built on a small set of domain operations over `e2e/helpers.ts`. The second half, red-first in the agent workflow, merged as #6144.

**Shipped:**
- **`e2e/domain.ts`: five operations** the specs actually repeat:
  - `blockRow`;
  - `startEditing` (`openPage` + `focusBlockById`);
  - `runSlashCommand` (`typeSlashCommand` + a click on the named option);
  - `pickDate` (a calendar day, then it waits for the picker to close);
  - `expectPersisted(page, pageTitle, effect, text?)`: a `reopenPage` round trip, then the re-queried effect.
- **The migrated spec:** `slash-commands-happy-paths.spec.ts` now reads as behaviour. It has the same seven tests and the same or stronger checks; `/code` asserts the exact text, where before it checked only containment.
- **`e2e/AGENTS.md` § Patterns:** one line states the convention.

**Decisions:**
- **Example names.** The issue's sample names (`setDueDate`, `linkBlocks`, `expectAgendaShows`, `createBlockUnder`) match no sequence the specs repeat; the specs set due dates through IPC, for instance. So the real repeats were lifted instead, and the others wait until a spec that uses them is migrated.
- **`expectPersisted` takes the title.** It first read the page title from the DOM. The review caught that the title editor shows chip text for a title holding a link or tag, so `reopenPage` could miss the page or open a different one. The title is now passed in, exactly what the old code passed to `reopenPage`.
- **`/cancelled` clicks its option** instead of pressing Enter. The slash menu has no auto-execute, and the Enter path stays covered in `slash-commands.spec.ts` and `slash-marks.spec.ts`.

**Proof:** the migrated spec went red inside `expectPersisted` when the mock's `set_scheduled_date` stopped storing the date but still returned it. The check before the round trip stayed green, so the red is the persistence check itself.

**Suites:**
- `typecheck` and `typecheck:e2e`;
- lint;
- the migrated spec plus `date-chip-target` and `slash-marks`: 16 passed;
- `e2e-related`'s self-test;
- prek on the three files.
