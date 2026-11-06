# Session 3635 — the meeting specs' remaining gaps

The eighth PR of #5364 slice 2 (S5a-4), tests only. It fills the slice's end-to-end gaps except the two-device sync, which gets its own PR.

- Mock lane, `e2e/meeting-attachments.spec.ts`: `/meeting` in a block on the journal day 2031-03-14.
  - The dialog dates the meeting that day, and the page is `Standup 2031-03-14` with that `meeting_date`.
  - The recording block's layout comes after the link: the audio first, the summary file open, the transcript closed until its toggle. Checked again after leaving the page and coming back.
  - The mock's audio bytes don't decode, so the first slot is the audio's chip, not a player.
- Real-backend lane, `e2e-tauri/meeting-attachments.e2e.ts`:
  - The MCP case now attaches a summary file. It checks the summary shows open, then opens the transcript and clicks `[00:00:01]`. The real player's `currentTime` moves: `tone-opus.ogg` is 1.0065 s, read from its last Ogg page's granule position.
  - A new case makes a meeting from the palette's *New meeting* with today's journal on screen. The link shows there without leaving, and the page and the link both survive leaving and coming back.
- Red, mock lane, run here: dating every meeting today failed the date assertion (`2026-11-06` for `2031-03-14`). Swapping the summary and transcript slots failed the open summary's text.
- Red, real-backend lane, which cannot run in this container: a scratch draft PR carried the new cases with the seek handler and `reloadMeetingLink` broken. CI's real-backend lane failed on those two assertions; the PR names that run.
