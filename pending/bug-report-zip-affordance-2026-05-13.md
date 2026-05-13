# Bug report dialog — make the zip-attach step explicit

> Status: ready for review.
> Triggered by: the "Include diagnostic logs" UX is misleading. The dialog implies logs travel with the GitHub issue; in reality clicking *Open in GitHub* silently downloads `agaric-bug-report-YYYY-MM-DD.zip` to the user's Downloads folder and then navigates to GitHub, where the user has to drag the file into the comment box themselves. There is no upfront cue that this is what's about to happen.

## What today's flow actually does

`src/components/BugReportDialog.tsx:239-274` (`handleSubmit`) when "Include diagnostic logs" is ON:

1. `readLogsForReport(redact)` — Tauri IPC reads log files (`src/components/BugReportDialog.tsx:225`).
2. `buildReportZip(...)` — JSZip builds a blob in the renderer with `metadata.json` + `logs/<name>` (`src/lib/bug-report-zip.ts:25`).
3. `downloadBlob(blob, filename)` — `URL.createObjectURL` + programmatic `<a download>` click. On desktop, the OS save dialog or default Downloads folder catches it; on Android, the webview's download manager drops it in `~/Downloads` silently (`src/lib/export-graph.ts:50`).
4. `openUrl(issueUrl)` — opens the GitHub new-issue page with title + body pre-filled.

The body already contains an `## Attachments` section (`src/lib/bug-report.ts:110-113`) that reads *"Please attach the saved `agaric-bug-report-…zip` to this issue before submitting."* — but the user only sees it after they're already on github.com, not in the dialog where the decision is made.

GitHub issue URLs cannot carry binary attachments via querystring, so the manual-attach step is fundamentally required. The fix is to make it visible.

## The fix

Two small changes, both in `src/components/BugReportDialog.tsx` + i18n strings:

### 1. Inline instruction under the logs list

When `includeLogs` is ON, render a one-line hint immediately below the existing "Files that will be included" list:

```
Saves agaric-bug-report-2026-05-13.zip to your Downloads folder. Drag it into
the GitHub issue once it opens.
```

The filename is already computed (`zipFileName` memo, line 172) — interpolate it into the hint string. New i18n key `bugReport.zipDownloadHint`.

### 2. Split the primary action into two explicit buttons

Today's footer (line 507-530):

```
[Cancel] [Copy report] [Open in GitHub]
```

When `includeLogs` is ON, become:

```
[Cancel] [Copy report] [Download zip] [Open GitHub issue]
```

When `includeLogs` is OFF, footer is unchanged (no zip, no extra button).

- *Download zip* runs steps 1-3 from the flow above (`readLogsForReport` → `buildReportZip` → `downloadBlob`) and shows a success toast `bugReport.zipDownloaded` ("Saved `…zip` to Downloads. Now open the GitHub issue and attach it."). Disabled while loading metadata or while the zip is building.
- *Open GitHub issue* just runs `openUrl(issueUrl)`. Same disabled rules as today (`!confirmed || submitting || loadingMetadata || body.length === 0`).
- The order in the footer is *Cancel → Copy report → Download zip → Open GitHub issue*. Visual order matches the natural sequence the user follows.
- The dialog stays open until the user closes it manually (today it auto-closes after `openUrl` resolves). The user is mid-task — open dialog → download → switch to browser → drag file → submit — so closing the dialog the moment the browser opens is also a small footgun. Keep it open.

This split:
- Makes the two distinct actions (a local file save, a browser navigation) two distinct clicks. No more "one button, two effects".
- Lets the user redo a step. If the save dialog is dismissed by accident, click *Download zip* again. Today the only path is to close the dialog, reopen it, re-tick the checkbox, re-click "Open in GitHub" — and a second GitHub tab opens too.
- Matches the inline hint copy: the hint says "saves a zip and you'll attach it manually"; the footer now has a button literally labelled *Download zip* and another labelled *Open GitHub issue*. No surprise.

### 3. Rename the switch label (optional, low cost)

`bugReport.includeLogsLabel` today reads as if logs travel with the report. Change to *"Attach diagnostic logs (downloaded as a zip you'll add to the GitHub issue)"* or keep the short label and beef up the hint immediately below it (`bugReport.includeLogsHint`) to spell out the manual-attach step. Either works; the inline hint in change #1 already covers the gap, so this is polish.

## Verification

- `npm run typecheck`
- `npm run test -- BugReportDialog` — existing tests check the *Open in GitHub* path; add cases for the new *Download zip* button (calls `readLogsForReport` + `buildReportZip` + `downloadBlob`, shows the `zipDownloaded` toast, dialog stays open) and assert *Open GitHub issue* no longer triggers the zip path on its own. The test file is `src/components/__tests__/BugReportDialog.test.tsx`.
- Manual: tick "Include diagnostic logs", verify the inline hint appears with today's filename, click *Download zip*, confirm save dialog / Downloads entry, click *Open GitHub issue*, confirm the GitHub tab opens, drag the saved file into the comment box, submit.

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | S. ~1 hour. Footer split + new handler are small; the underlying `executeBuildZip` hook already exists and just needs to be split out from `handleSubmit`. New i18n keys (`zipDownloadHint`, `zipDownloaded`, optionally a longer `includeLogsHint`). Test updates are mechanical. |
| **Impact** | Closes the only real source of confusion in the bug-report flow. New contributors / first-time bug filers stop dropping the zip on the floor. |
| **Risk** | Low. No primitive or shared-module changes; entirely local to `BugReportDialog.tsx`. The only behavioural change beyond the UI split is the dialog no longer auto-closing after `openUrl` — an existing test asserts that close happens; update it to assert the dialog stays open and the user can dismiss with Cancel / the X button instead. |
| **Reversibility** | High. Single-component change, single PR, easy to revert. |

## Out of scope

- Any change to the zip generation, redaction, or upload mechanism.
- Inlining logs into the issue body (rejected — out of scope per session 2026-05-13 discussion; GitHub URL length limits make the conditional logic not worth it).
- Changes to `openUrl`, `downloadBlob`, or the IPC layer.
