# Session 1588 — split the conformance waivers, and name the debt (#4667)

## What

`NO_FIXTURE_ALLOWLIST` (53 entries) and `READ_NO_QUERY_ALLOWLIST` (41) are now
split into a permanent half and a shrink-only ratchet:

- `NO_DOMAIN_STATE_MUTATING` (11) and `NO_DOMAIN_STATE_READ` (14) — commands
  carrying no domain state a snapshot could compare: transport sessions, the
  observability and MCP runtime toggles, and process/environment/status probes.
  No fixture will ever pin these, so they are not debt.
- Everything else — **42 mutating + 27 read** — is debt, named in a committed list.

## The criterion is each command's own reason, not its section header

"no durable/persistent state" is permanent; "outside the conformance snapshot
scope" is debt — that says the snapshot is too narrow, which a widened snapshot
fixes. Classifying by section header instead put five `app_settings` /
`peer_refs` writers in the permanent set while `list_peer_refs` sat in the debt
set for a byte-identical reason.

Deferring to a reason string only works when the string is true, and three were
not: `confirm_pairing` claimed "no durable domain state" while `pairing.rs`
writes an `app_settings` row and clears `peer_refs` flags, and
`get_reminder_settings` claimed "no domain state" while reading the row
`set_reminder_settings` writes. Both are debt. The check is the code.

## The ratchet holds names, not a count

A count nets out: pin one command, waive another, and 42 is still 42. Names
fail in both directions, which is why `check-tauri-import-baseline.mjs` commits
a sorted list rather than a number.

The names are derivable from the two allowlists, and are still worth
committing, because the derivation has two inputs. Deleting an allowlist line
(pinning) shows up in review on its own; moving a command into the PRINCIPLED
set does not — the allowlist line is untouched, and the orphan test only
catches a principled name that is missing from the allowlist entirely. That
second axis is how `get_reminder_settings` would have quietly left the debt
count, and the name list is the only thing that reddens on it.

Falsified on exactly that: promote `get_reminder_settings` to principled with
its waiver untouched, and one assertion fires. Isolated separately by swapping
`start_sync` out of the principled set and `add_tags_by_ids` in — both still
waived, both real command names, count identical at 42 — so nothing else in the
file can be doing the work.

## Not done here

The issue's other two acceptance criteria — query steps for the 14 self-labelled
"fixture candidate" reads, and widening the migration⇒mock CONTRACT map beyond
its 9 of 59 tables — are separate work. This commit is the mechanism that makes
that burn-down visible; it does not do the burning down.
