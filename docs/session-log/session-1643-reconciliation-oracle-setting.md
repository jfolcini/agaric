# Session 1643 — the opt-in setting in front of the reconciliation oracle

Second half of #4886. Session 1640 moved the oracle out of `cfg(test)` and put
`compute_reconciliation_report` in front of it; nothing called that command. This
session gives it a user.

## Where the setting lives

Settings → Data, as a third card under Import and Export, in
`src/components/settings/IntegrityCheckSection.tsx`. Data is where the other
whole-vault operations already are, and the tab is lazy-loaded, so the card
cannot cost anything on the boot path even by accident.

The preference is `PREFERENCES.integrityCheck` (`integrity-check-enabled`,
device-scoped, default false) in the existing registry. No store, no table, no
migration — the report is held in component state and does not survive a
restart, which is what the issue asked for.

Nothing runs on its own. Rendering the tab does not call the command; neither
does turning the switch on. Turning it on reveals a Run button, and only pressing
Run starts the sweep. Three of the component's tests exist purely to pin that:
off by default with no Run button and zero invokes, enabling with zero invokes,
and an added auto-run effect reddening the second of those.

## What the result looks like

A clean vault gets an `EmptyState`: "Everything matches / Rebuilt every derived
table from 1200 blocks on 2026-09-09 and found no differences." The block count
is in the sentence because zero divergences over zero blocks describes an empty
vault, not a healthy one — the same reason the backend puts `blocks_scanned` in
the payload.

A vault that diverged gets a summary line, then one row per artefact reading
"12 rows diverged in pages_cache.child_block_count", with the backend's sample
keys under it as "Examples: 01ARZ…, 01BX5…" and nothing at all when that artefact
has none. That is the issue's own sentence, which is the bar it set: a count and a
table name is a bug report, a diff dump is not. A `Copy for a bug report` button
produces the Markdown section.

The Run button shows a `Spinner` while the sweep is out, and an
`AppError::Database` becomes a toast through the standard IPC path — the shared
`useReconciliationReport` hook wraps `useIpcCommand`, so the log line and the
toast are the ones every other settings row produces.

## The bug-report decision

The report joins the bundle, and no Rust changed. `formatIntegrityReport` lives
in `src/lib/bug-report.ts` next to `formatRetryQueue`, and `formatReportBody` and
`formatReportFields` both take an optional report. The dialog reads the same
preference and runs the same hook on open, so a reporter who was asked to turn
the setting on does not have to paste anything by hand — the section is in the
preview, in the copied body, and in the `notes` field of the prefilled GitHub
issue form. With the setting off, which is the default, the dialog never calls
the command and the body is byte-for-byte what it was.

The one real cost is that `runningIntegrity` joins the dialog's metadata gate, so
on a large vault the submit button stays disabled a little longer. The
alternative — letting the issue be filed while the sweep the user opted into is
still running — silently drops the thing they turned on, which is worse. Whether
that trade is right for a vault where the sweep takes tens of seconds is a
judgement about a machine I do not have; it is the one part of this worth a
second opinion.

`BugReportDialog.tsx` came out at 508 lines. The hook is already extracted; what
is left is the wiring. Splitting the orchestrator further is a change to a file
this issue only visits, so it is not in here.

## Left out

The Spanish catalog gets nothing. `es-catalog.test.ts` rule 5 fails any value
byte-identical to its English source, and a key `es` omits falls back to English
anyway, so adding untranslated entries would be a red suite in exchange for
nothing on screen.

## Falsification

Eleven mutations against `cp` backups, `cmp`-restored each time. The default
flipped to true, the enabled-gate forced open, an auto-run effect added, the
`clear()`-on-toggle-off dropped, the clean/diverged branch collapsed, the
sample-key suffix dropped, the integrity section removed from the form fields,
the dialog's preference guard removed, and the clipboard catch made to toast
success — each reddened exactly the tests that name it.

Two survived on the first pass and are why this section is worth writing. The
submit gate (`loadingMetadata || runningIntegrity`) had no test at all: the code
comment claimed the issue could not be filed with the section missing, and
nothing checked it. It has a deferred-promise test now. And
`expect(getAllByText(/^Examples: /))` could not fail — testing-library trims, so
the trailing space in the matcher meant the empty-keys row it was asserting the
absence of would never have matched either. Dropping the space kills the mutant.
