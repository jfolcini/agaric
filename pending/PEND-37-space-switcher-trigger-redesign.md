# PEND-37 — SpaceSwitcher trigger: drop "Space:" prefix, add accent dot

## Origin

Conversation 2026-05-08. The current sidebar space selector renders as
`Space: Personal ▾` with a static "Space:" prefix inside the trigger
(`src/components/SpaceSwitcher.tsx:125`, added in UX-364). Two issues
flagged:

1. The label is repeated on every render and competes for ~50px of
   horizontal room in a sidebar that's already narrow.
2. The trigger looks like a labelled form field, but it's really a
   *context indicator* — Notion / Linear / Slack workspace switchers
   don't carry a label, they show identity (colored avatar + name).

## Existing visual signal

`SpaceTopStripe` (`src/components/SpaceTopStripe.tsx`) already renders a
3px full-width accent stripe at the top of the viewport, sourced from
the active space's `accent_color`. It's `aria-hidden` and decorative —
ambient, but easy to overlook.

The stripe and the proposed dot reinforce each other rather than
duplicate: the stripe is a *frame-level* anchor, the dot in the
trigger ties the *named* current space ("Personal") to the same color.
A user glancing at the sidebar sees the dot; a user glancing at the
window chrome sees the stripe; both read the same identity.

## Proposed change

### Trigger layout

Before: `[Space:] [Personal] [▾]`

After: `[●] [Personal] [▾]`

Where `[●]` is an 8px circle filled with `var(--<accent_color>)`,
rendered before `<SelectValue>` inside the trigger. The "Space:"
`<span>` (`SpaceSwitcher.tsx:125`) is removed.

### Implementation sketch

```tsx
// Inside <SelectTrigger>, replacing the existing "Space:" span:
{activeSpace != null && (
  <span
    aria-hidden="true"
    data-testid="space-switcher-accent-dot"
    className="mr-2 h-2 w-2 shrink-0 rounded-full"
    style={{ backgroundColor: accentVar(activeSpace.accent_color) }}
  />
)}
<SelectValue placeholder={t('space.switch')} />
```

Where `accentVar()` is the same helper already in
`SpaceAccentBadge.tsx:49-56` — extract it to
`src/lib/space-accent.ts` (or similar) and import from both call sites
to keep the fallback logic in one place.

`activeSpace` comes from the existing
`availableSpaces.find((s) => s.id === currentSpaceId)` lookup pattern
already used by `AppSidebar.tsx:158-161`.

### What stays unchanged

- The `aria-label={t('space.switch')}` on `SelectTrigger`. The dot is
  decorative; the accessible name still reads "Switch space".
- Tooltip with `Ctrl+1..9` / `⌘1..9` hints (UX-9 / UX-368).
- Dropdown rows: digit chips (`endContent`), separator, single-space
  "Create another space…" hint (UX-373), "Manage spaces…" sentinel.
- Collapsed-rail `SpaceAccentBadge` (FEAT-3p10).
- `SpaceTopStripe` — kept exactly as-is; the dot in the trigger is
  *additional*, not a replacement.

### i18n

Remove the `space.prefix` key from translation bundles once no
component references it. Quick grep:

```bash
rg "space.prefix" src/
```

If there are no other consumers, drop the key from
`src/i18n/locales/*.json`.

## Why not "label on top" / "no label at all without a dot"

User considered both. Rejected:

- **Label on top (form-field style)**: costs a vertical row in a
  sidebar that's already stacked (brand → switcher → 6 nav items →
  footer with sync/theme/shortcuts/collapse). Form-field framing also
  miscommunicates the affordance — this is a context switcher, not a
  setting.
- **Bare label-less trigger (no dot)**: works, but loses identity. The
  top stripe is too ambient on its own when the user is mentally
  parked in the sidebar; the dot anchors the same color closer to the
  text it qualifies.

## Test plan

Vitest (`src/components/__tests__/SpaceSwitcher.test.tsx`):

1. **Dot renders with the active space's accent**: mount with two
   spaces of different `accent_color` values, switch between them,
   assert the dot's `style.backgroundColor` resolves to the active
   space's accent token (use `data-testid="space-switcher-accent-dot"`
   and `getComputedStyle` or read `style.backgroundColor` directly).
2. **Dot falls back to `--accent-current`** when `accent_color` is
   null / empty — mirrors the `SpaceAccentBadge` fallback test.
3. **No "Space:" prefix in the trigger**: regression assert that the
   accessible text content of `SelectTrigger` does not include the
   removed prefix.
4. **`aria-label="Switch space"` still set** on the trigger (a11y
   regression guard — the dot is `aria-hidden`).

Snapshot of the existing trigger-render test (if one exists) will need
to be regenerated. Verify the dropdown-content tests are unchanged.

Manual:

- Toggle the sidebar to icon-rail and back: collapsed rail still shows
  `SpaceAccentBadge`, expanded shows trigger-with-dot.
- Switch spaces via `Ctrl+1` / `Ctrl+2`: dot color updates in
  lock-step with the top stripe.
- Dark / light theme: dot contrasts against the trigger background in
  both. (If contrast is borderline on light theme for pale accents,
  add a 1px `box-shadow: inset 0 0 0 1px hsl(var(--border))` on the
  dot — match `SpaceAccentBadge`'s shadow approach.)

## Cost / Impact / Risk

| | |
| --- | --- |
| Cost | **XS (~30 min)** — single-file change in `SpaceSwitcher.tsx`, optional helper extraction (`accentVar`) into a shared util, 4 vitest cases, i18n cleanup. |
| Impact | **Low (cosmetic)** — no behaviour change, no new state, no a11y regression. Reclaims ~50px of trigger width and aligns the switcher with industry-standard workspace-picker patterns. |
| Risk | **Very low** — pure visual change in one component. The fallback path (`var(--accent-current)`) already battle-tested in `SpaceAccentBadge` + `SpaceTopStripe`. No data model, no store, no IPC touched. |

## Sequencing

Standalone. No dependencies. Drop into any light-touch FE session.
