# Session 4468 — Settings: a section list that drills in on a phone, one heading and description size, a rail that stays in view

Part of the #7040 UI review, items P7 and D5.

**What shipped**

- **Phone section list.** On a phone (`usePhoneLayout()`) Settings opens on the rail's four groups as cards of `ListItem` rows with a chevron, in place of the section Select.
  - A tap opens the section under a view header with a Back `IconButton` and the section title as an h2. Focus moves to the title on the way in and back to the row on the way out.
  - Android's back gesture leaves a section for the list before it leaves Settings (`registerBackHandler`).
  - A stored, `?settings=` or deep-linked section opens straight into it. Going back to the list clears the stored section, so Settings reopens on the list.
- **One description size.** `CardDescription`, used only in Settings, is `text-xs` like `SettingRow`'s descriptions, and so is the Agent access intro.
- **No capture button on Settings.** It covered the External images Select on a 740 px tall phone, so `QuickCaptureFab` hides on Settings and the view drops the bottom padding kept for it (`keepsCaptureRoom` in `App.tsx`).
- **Desktop rail.**
  - It stays in view while the content scrolls, when the window is at least 44rem tall. A shorter window scrolls it away, so its last tabs stay reachable.
  - It takes the app sidebar's states: active is `font-medium` on `sidebar-accent`, hover regular weight on `sidebar-accent/50`.
- **One card heading.** `CardTitle` renders an `h2`, and Agents and Recent activity use it instead of their smaller h2s.
- **Keyboard tab.** The keys column takes its own width (`@lg:w-auto @lg:max-w-56`), fixed only while a binding is edited, so labels stop wrapping at 240 px.
- **Properties chips** are all `Badge tone="outline"`: the type, the count and Built-in. The amber "don't fit" badge stays, since it is a button.

**False premises in the issue**

- The rail's hover and active fills already differed (`nav-active-item.spec.ts`). Both were `font-medium`, which is what made them look alike.
- The two "15 px" descriptions were `CardDescription` at 14 px.
- At 412 × 915 the capture button covered no control at rest. It did at 740 px tall.

**Not done**

- Single-card tabs still have no card heading: the rail, or the phone's section title, already names the section.
- The section rows have no icons, because the sections have none.

**Tests**

- e2e:
  - `settings-phone`: the drill-in and Back, a stored section opening straight away, 44 px rows, no Keyboard row without a hardware key, no Editor control under the capture button from 664 to 915 px tall.
  - `settings-desktop` (new): the rail in view at the bottom of a long tab, active vs hovered weight, one card-heading size, one description size, no empty keys or buttons column in Keyboard, one chip style in Properties.
  - `openSettingsTab` (`e2e/helpers.ts`) taps the section row on a phone, pressing Back first when another section is open.
- vitest: `SettingsView`'s phone section list (five tests with axe), `card` (the title is a level-2 heading).
- Each was shown red before the change, and again by a mutation after it. The first Keyboard check stayed green with only the keys column reverted, so it was tightened to "no empty column" and both reverts went red.
