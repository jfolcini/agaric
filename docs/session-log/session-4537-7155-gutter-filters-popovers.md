# Session 4537 — #7155 R1, R4, R8, R14: gutter order, phone editing frame, filter funnels, one info popover

Round 2 of the UI review (#7155), four agreed fixes from the maintainer's notes on the #7040 report.

**What shipped**

- **R1 (desktop):** a selected row reads grip, checkbox, text.
  - `BlockGutterControls`: while the selection checkbox shows, it takes the gutter lane and the grip hangs left of it, out of flow, so no text moves. A row without a checkbox keeps the grip in the lane.
  - `--block-room` became hang plus `--block-lane`, so a narrow window does not clip the hanging grip.
- **R14 (phone):** the focused task's editing frame in `SortableBlock` sits 8 px from both screen edges; it used to touch the left edge and stop 16 px short of the right. The checkbox and text stay on the 16 px gutter, and the desktop shot is pixel-identical.
- **R8:** an icon that labels a button sits inside it.
  - The references panel (`BacklinkFilterBuilder`, not `AgendaFilterBuilder` as the issue assumed), the Agenda and the Graph each had a standalone funnel beside "Add filter". The funnel moved into the button, replacing its "+" where it had one.
  - The Graph's "Filters" label and its i18n key went.
  - A scripted sweep found no other decorative icon beside a button.
- **R4:** opening an info popover closes any other.
  - Several `InfoPopover`s could be open at once (Settings › App health). The trigger stops its click so rows behind it do not react, and Radix's outside-press check on touch waits for that click, so the open one never heard the press.
  - The component is now controlled, and a module-level closer shuts the open one when another opens. `onCloseAutoFocus` is prevented when another popover closed it, so focus does not bounce back and close the new one.

**Tests**

- New funnel tests in the three filter-bar suites. The Graph's "Filters" label assertion was replaced by "the funnel is inside Add filter, with no standalone icon or label".
- `info-popover.test.tsx`: opening a second closes the first; reopening the first and pressing Escape returns focus to its trigger. The reviewer added the second half: the reset it covers had no test.
- New e2e:
  - `batch-operations.spec.ts`: grip left of the checkbox, no text shift;
  - `phone-content-edge.spec.ts`: equal frame inset;
  - `app-health-info.spec.ts`: a second tap leaves one explanation open.
- Every test was shown red, by the builder and again by the reviewer.
- The reviewer ran 295 agenda, filter, graph, references, selection, gutter, phone and info e2e tests (all passed) and screenshotted every item in both themes.
- The builder's container failed 9 phone e2e specs on `origin/main` as well; main's CI is green on them, and the reviewer's container passed them.
