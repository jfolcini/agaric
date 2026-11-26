# Session 4530 — #7040 M6: touch sizes read the `coarse` variant and three tokens

M6 of the UI review, the last open item on #7040: the full sweep of decision 24, and decision 39's fix to AGENTS.md's touch-target line.

**What shipped**

- **One touch signal.**
  - Every inline `[@media(pointer:coarse)]:` class is now `coarse:`, so it follows `<html data-touch>` as `index.css` and `useIsTouch` already do. The two fine-pointer classes are `not-coarse:`.
  - Under decision 26 the platform decides touch. The desktop app keeps its mouse sizes even with a pointer WebKitGTK reports as coarse (#1236). A touch phone and the Android app lay out as before.
- **Hover-none badges (decision 44).** AttachmentRenderer's two `[@media(hover:none)]` opacities are `coarse:` too, so no media query decides touch anywhere in `src`.
- **Three tokens.** `--touch-target`, `--phone-header-h` and `--fab-clearance` are each defined once in `index.css` and replace their copies:
  - `--touch-target` is the 44 px side of a control, and stays in rem, the unit of the Tailwind sizes it replaced.
  - `--phone-header-h` is the phone header's height, where a bottom sheet stops.
  - `--fab-clearance` is the room a view keeps under the capture button.
- **Docs-born classes (decision 45).** `@source not '../docs';` stops Tailwind from generating classes it finds only in the docs, such as the session logs' old `[@media(pointer:coarse)]:*` names. The built CSS shrinks by about 20 KB: 199 docs-only rules go, and nothing `src` uses changes.
  - On its own it would have shipped a regression. `duration-150` and `duration-200`, which appear only in session logs, were what made Tailwind register `--tw-duration` as non-inheriting.
  - Without that registration, the variable inherits, and 22 elements of the desktop journal changed their transition from 0.15 s to 0.2 s, the sidebar buttons among them.
  - `index.css` now registers `@property --tw-duration` itself.
- **Docs.** AGENTS.md § Mandatory patterns names the variant and the token (decision 39). docs/UX.md and docs/UI-MAP.md follow.

**Tests**

- `desktop-app-touch.spec.ts` measures a list row, an icon button and a menu row twice:
  - in the desktop app with a coarse pointer, where they are mouse-sized. Red on `main`: 44 px each;
  - on a touch phone, where they are 44 px.
- Falsified on the branch:
  - one row's class put back to `[@media(pointer:coarse)]` reddens only the desktop arm;
  - `--touch-target: 2.5rem` reddens only the phone arm.
- `desktop-app-touch.spec.ts` also attaches an image and reads its resize cues at rest: hidden in the desktop app with a coarse pointer (red before decision 44: received 0.5), and at 0.5 and 0.6 on a phone, unchanged.
- `motion-speed.spec.ts` pins a sidebar button's transition at 150 ms (Full) and 75 ms (Fast). Red with `@source not` alone: received 0.2 s and 0.1 s.
- The edited unit tests change only the prefix and the size names. Each negative assertion goes red when a `coarse:` class is put back.
- Old build against new build, laid out on phone, Android, iPad and desktop mouse across every view: 49 of 49 computed-style dumps are identical, and 15 of 15 again after decisions 44 and 45. The desktop app with a coarse pointer now matches the plain-mouse layout.
- CSS order: every `coarse:` class was compared with each class that shares its property. None of the 9 order changes meets on one element. tailwind-merge resolves the token the same as the old sizes.
- A separate session reviewed the branch. It fixed three comments that described the old classes, and it re-ran the red and both falsifications.
