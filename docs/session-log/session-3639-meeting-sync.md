# Session 3639 — a meeting's files reach the other device

The tenth PR of #5364 slice 2, tests only. It closes the slice's last real-backend gap: "extend `sync-two-device.e2e.ts` so the files reach the other device on the same block".

- A new case in `e2e-tauri/sync-two-device.e2e.ts`, after the image cases and before the cancel and unpair cases, which need the pairing.
  - The app makes a meeting through its own `add_meeting` command, the dialog's IPC. It's linked from the block both devices share, and carries an audio file, a transcript and a summary file.
  - After the peer's pull, the test asserts on the peer:
    - the recording block holds exactly `call.ogg`, `call.transcript.md` and `recap.summary.md`;
    - each file's bytes match;
    - the recording block sits under the meeting page;
    - the shared block's text carries the `[[page]]` link.
  - No existing case changed. The file's header comment names the new step.
- Red: a no-PR scratch branch made the meeting path write its attachment rows straight into SQLite, without the `AddAttachment` op. The meeting looks the same locally, but nothing reaches the op log. CI's real-backend lane, dispatched on that branch, failed on the new case's attachment list; the PR names the run.
