# Session 2855 — property definitions are per space (#5841 S0.5)

Slice S0.5 of #5841. It follows the revised design and the maintainer's decisions of 2026-10-22: definitions are keyed `(space_id, key)`. A new space starts with the built-ins plus `status`, `url`, `effort`, `assignee` and `location`, and copies nothing from another space. MCP `list_property_defs` takes `space_id`. Settings › Properties gets a space selector and *Copy to space…*.

- **Migration 0129** rebuilds `property_definitions` as `STRICT` with primary key `(space_id, key)`. It copies every existing row into every registered space, trashed spaces included, since `spaces` keeps a soft-deleted space's row.
  - `space_id` has no foreign key, as `tags_cache.space_id` has none: a `spaces` or `blocks` rebuild deletes and restores the registry rows, and a cascade would take the definitions with them. A space purge deletes its rows itself.
  - A fresh vault has no spaces at migration time, so the table starts empty. The bootstrap seeds the defaults into Personal and Work when it creates them.
  - It seeds only a space that never existed, so restoring a trashed seeded space does not bring back a default the user deleted.
- **Every reader resolves the block's space:**
  - the property commands and their usage probes;
  - page Markdown and front matter;
  - the bibliography import;
  - recovery's reprojection (`db/recovery.rs`);
  - sync's `project_pass_a` (`loro_sync.rs`);
  - the engine's apply and projection paths.

  A space block or a trashed block resolves no space and sees only the built-ins. Those are the only keys it ever holds.
- **Usage probes count trashed blocks** in their own space (a soft delete keeps `blocks.space_id`), as the delete guard and the create probe did before. The options-edit orphan count stays live-only.
- **MCP:** `list_property_defs` takes `space_id` and an agent's space limits apply. `src-tauri/src/mcp/AGENTS.md`'s exemption sentence was corrected, with the maintainer's approval.
- **Frontend:**
  - Every definition read passes the block's or page's space.
  - `PropertyDefinitionsList` has a space selector.
  - `CopyDefinitionToSpace` offers every other live space.
- **Mock:** keyed per space and pinned by `conformance/fixtures/property_defs_per_space.json`.

Left for later slices:
- **S0.6, the cross-space move:** replace the "a move keeps all values" pitfall in `docs/features/properties.md`, and count trashed descendants in the loss preview. The move fixtures declare `related` as `ref` in both spaces, so keep that when the drop rule lands.
- **S1, sync:**
  - A received space has no rows, so either its doc root carries the defaults or the receiver seeds them on first sight.
  - `project_pass_a` loads value types once, before the pass.
  - `repair_property_definitions` must walk `(space, key)`, trashed spaces included.
- **S0, the usage count:** stays live-only and does not reuse the delete or create probes.
- **S2, rename:** `renameMayDeclareKey`'s pre-flight still uses the vault-wide key list.

Not guarded: a boot that both recovers a missing `blocks` table and runs 0129 would copy into an empty `spaces`, losing the definitions but not the values. No release reaches it, because every released vault has had Personal and Work since 0.1.0.

**Shown red:**
- the purge cascade;
- sync typing by the wrong space;
- recovery typing;
- the bootstrap re-adding a deleted default;
- MCP listing another space;
- 0129 skipping a trashed space;
- the selector ignoring the picked space;
- the copy menu offering the source space.

The real upgrade chain was checked by hand: a DB at 0127 with three spaces (one trashed), two user definitions and a deleted `effort` ended with 18 rows (6 keys × 3 spaces), `effort` still gone.

**Suites run:**
- `cargo nextest run --workspace` in three partitions: 7138 passed;
- doc-tests;
- `cargo clippy --workspace --all-targets -- -D warnings`;
- `SQLX_OFFLINE=true cargo check --workspace --all-targets`;
- the four `sqlx prepare --check` lanes;
- vitest over `src/__tests__` and every touched and mounting directory;
- typecheck and lint;
- `prek run --hook-stage manual --all-files`;
- the property Playwright specs (46 passed).

The new `e2e-tauri/property-defs-per-space.e2e.ts` runs in CI's real-backend lane only.
