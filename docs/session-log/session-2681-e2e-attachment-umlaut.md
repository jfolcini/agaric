# Session 2681 — the real backend checks an attachment in the integrity check, and `[[über]]` on import

The last two open items of #5887.

- **Integrity check with an attachment:** `app-health.e2e.ts`'s integrity test
  now pastes `wdio-health.txt` into a block, leaves through the Journal and
  comes back, then runs the check and expects "Everything matches". The check
  reaches attachments through `reconcile_all` → `reconcile_engine` →
  `diff_engine_attachments`; the mock always answers "matches", so only this
  lane can show it.
- **`[[über]]` on import:** `import-obsidian-vault.e2e.ts`'s vault holds
  `Über.md` and a note linking `[[über]]`. After a round trip the Pages list
  shows `<vault>/Über`, no page is titled `über`, and the link chip resolves
  to `<vault>/Über` (844eccf).
- **Version-mismatch message:** not built. The engine format is the
  compile-time `ENGINE_FORMAT_VERSION`, advertised and checked by the session
  handshake, and `e2e_sync_peer` runs the app's own daemon with no override,
  so a peer on another format needs a second build or a production override.
  `e2e/sync-events.spec.ts` covers the event on the mock.

Shown red: both Unicode folds in `commands/pages/markdown.rs` made
ASCII-only (the absence check, then the link check), and the attachment
filename comparison in `diff_attachment_fields` made to always differ (only
the integrity test failed, reporting `1 row diverged in
engine.attachments.filename`).

Ran: both files on the real backend (`app-health.e2e.ts` 50 s,
`import-obsidian-vault.e2e.ts` 36–44 s), `npm run typecheck`,
`npm run typecheck:e2e-tauri`, `npx oxlint e2e-tauri/`.
