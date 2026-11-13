# Release vaults

A vault written by a released build, for the upgrade test
(`src-tauri/src/upgrade_vault_tests.rs`) to open with head.

| Path | What |
|---|---|
| `generator.rs` | The program that writes a vault. It is compiled at the tag, never at head. |
| `<tag>/notes.db.gz` | The database the tag wrote, gzipped. |
| `<tag>/device-id` | The device the vault's ops belong to. |
| `<tag>/export-projects.txt` | The tag's own Markdown export of the "Projects" page. |

## How a vault is produced

```bash
scripts/gen-release-vault.sh 0.23.0
```

The script checks the tag out into a throwaway worktree, copies `generator.rs`
in as an example and runs it there. The generator opens the database with the
tag's boot path (pools and migrations, the materializer, crash recovery, the
seeded spaces), writes through the tag's `*_inner` commands, and exits as the
app does: queues drained, engine snapshots saved, WAL folded in.

A regenerated vault has new block ids, timestamps and hashes; the test finds
its rows by content.

## What a vault holds

Two spaces; in Personal a page with a task (state, priority, due and scheduled
dates), a nested block linking to a second page, a tagged block and a repeating
task; a second page with an alias, a block carrying one property of each value
type, and a moved block; a tag; a trashed page with a child. In Work, one page
with one block.

## What it does not hold

The vault is written through the tag's command layer, not its UI. It has no
attachment, no compacted op log, no paired peer and no sync state.
