# Release vaults

A vault written by a released build, for the upgrade test
(`src-tauri/src/upgrade_vault_tests.rs`) to open with head.

| Path | What |
|---|---|
| `generator.rs` | The program that writes a vault. It is compiled at the release, never at head. |
| `<version>/notes.db.gz` | The database the release wrote, gzipped. |
| `<version>/attachments/` | The attachment's bytes, where the release stored them. |
| `<version>/device-id` | The device the vault's ops belong to. |
| `<version>/export-projects.txt` | The release's own Markdown export of the "Projects" page. |
| `<version>/counts.txt` | The release's own counts at exit: blocks, ops left in the log, the seq its compaction purged through. |

## How a vault is produced

```bash
scripts/gen-release-vault.sh 0.23.0
```

The script checks the release out into a throwaway worktree, copies
`generator.rs` in as an example and runs it there. The generator opens the
database with the release's boot path (pools and migrations, the materializer,
crash recovery, the seeded spaces), writes through the release's `*_inner`
commands, and exits as the app does: queues drained, engine snapshots saved,
WAL folded in.

A regenerated vault has new block ids, timestamps and hashes; the test finds
its rows by content, and reads from `counts.txt` what depends on how many ops
the release's commands write.

## What a vault holds

Two spaces; in Personal a page with a task (state, priority, due and scheduled
dates), a nested block linking to a second page, a tagged block and a repeating
task; a second page with an alias, a block carrying one property of each value
type and an attachment, and a moved block; a tag; a trashed page with a child.
In Work, one page with one block.

A compacted op log: everything above but the nested block's text is a year
old when the release's own compaction (the daily job's command, 90 days) runs,
so those ops are purged and the engine snapshots are their only record. The
nested block's edit, the attachment and the Work page are written after it.

A paired device in `peer_refs`, with a name and an address.

## What is not written by a command

- The ops' age. No command writes an old op, so the generator moves
  `op_log.created_at` back a year before it compacts.
- The peer's row. Pairing needs a second device on the wire; the generator
  calls the function the pairing handshake pins a peer with
  (`peer_refs::bind_endpoint_id`), then the device list's two commands.

The vault is written through the release's command layer, not its UI, and
holds no state from a sync session.
