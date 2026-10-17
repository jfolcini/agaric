# Session 2486 — spaces and sync happy paths (#5739)

Mock-lane specs for #5739's Spaces items and two of its Sync items.

**`e2e/spaces-happy-paths.spec.ts`:**
- **Open on launch** keeps the chosen space after leaving Settings. It
  falls back to *Last used* once the space is deleted by another device,
  which takes the same refresh path as a local delete. The mock cannot
  delete a space locally, because its `list_blocks` block-type branch
  ignores the active space.
- **Switching spaces** restores each space's own tabs, recent pages and
  journal date.
- **The collapsed sidebar's space badge** switches to the next space. The
  accent stripe and the Pages rail both change.

**`e2e/templates.spec.ts`:** the *Configure journal template* popover offers
the templates plus *New journal template*.

**`e2e/sync-happy-paths.spec.ts`:**
- **The sidebar Sync icon** shows idle, syncing, failed and offline, each
  with its tooltip lines. Syncing is observed by holding the mock's
  `start_sync` open, the way a slow peer would.
- **The internet fallback switch** starts off, turns on, is stored, and
  stays on after leaving Settings.

**Corrections to the issue:**
- **Sync events:** there is no `sync:started` event.
- **Tooltip:** it has no "failed" wording.
- **Restart note:** it is the switch's fixed description.
- **Template badge:** the template page has no badge.

**Found:**
- **"Last synced N ago"** never advances. It is fixed in its own PR.
- **Per-peer progress (item 2)** has no UI, although the store records it
  and the doc describes it. That waits on the maintainer.

**Shown red:**
- **Open on launch:** the fallback guard inverted, and the preference
  serialised empty. Only the leave-and-return check catches the second.
- **Per-space state:** tabs not stored per space, and the journal date
  not restored.
- **The badge:** it does not advance.
- **The template popover:** *New journal template* relabelled.
- **The sync icon:** the last-synced update, the offline guard and the
  syncing dot each broken.
- **The fallback switch:** its load and its save each broken.

**Ran:**
- the three files with `--repeat-each=3`;
- every spaces and sync spec;
- `npm run typecheck`, oxlint and oxfmt.
