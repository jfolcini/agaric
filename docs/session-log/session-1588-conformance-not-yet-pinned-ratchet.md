# Session 1588 — split the conformance waivers, and put a number on the debt (#4667)

## What

`NO_FIXTURE_ALLOWLIST` (53 entries) and `READ_NO_QUERY_ALLOWLIST` (41) are now
split into a permanent half and a shrink-only ratchet:

- `NO_DOMAIN_STATE_MUTATING` (12) and `NO_DOMAIN_STATE_READ` (14) — commands
  carrying no domain state a snapshot could compare: transport sessions, the
  observability and MCP runtime toggles, and process/environment/status probes.
  No fixture will ever pin these, so they are not debt.
- Everything else — **41 mutating + 27 read** — is debt with a number on it.

## The criterion is each command's own reason, not its section header

The first pass classified by section, which put five `app_settings` /
`peer_refs` writers in the permanent set — `cancel_pairing` ("pending-pairing
marker (app_settings)"), the three peer-registry writers, and
`set_reminder_settings` — while `list_peer_refs` sat in the debt set for a
BYTE-IDENTICAL reason string. Reviewer-caught.

The honest test is the reason itself: "no durable/persistent state" is
permanent; "outside the conformance snapshot scope" is not, because that says
the snapshot is too narrow, which is a thing a widened snapshot fixes.
`get_reminder_settings` moved too — it reads the `app_settings` row its own
setter writes, so classifying the setter as debt and the getter as permanent
was the same inconsistency in the other direction.

Re-classified per-command, the split is 12 + 14 — which is exactly what
#4667's independent audit measured before any of this was written.

## Why the existing guard was not enough

The honesty tests already failed on a stale waiver, a now-covered one, or a
citation naming a file that does not mention the command. What they could not
say is *which* waivers are debt. A principled waiver and an unwritten one read
identically, so 76% of the command surface looked like a settled decision rather
than a backlog.

That is #4667's point: the guard measured bookkeeping, not coverage.

## The ratchet is an equality, not a ceiling

```ts
expect({ mutating: mutating.length, read: read.length }).toEqual({
  mutating: NOT_YET_PINNED_MUTATING_BASELINE,
  read: NOT_YET_PINNED_READ_BASELINE,
})
```

`<=` would let a stale baseline hide a win: pin a command, the count drops, the
test still passes, and the number is free to drift back up unnoticed. Equality
makes both directions fail — pinning one requires lowering the baseline in the
same diff, and waiving a new one requires raising it where a reviewer sees it.
Same mechanism as `tauri-import-baseline`, which fails on "new importer **or**
stale baseline entry" for exactly this reason.

A second test rejects a principled name that is not actually waived, so the
permanent list cannot be used to shrink the debt count without pinning anything.

## Falsification

Three mutants, against a copy, restored and `cmp`-verified. All red:

- remove a waiver, as if that command had just been pinned → 40 ≠ 41;
- move a batch command into the principled set, mislabelling debt as permanent →
  the count drops and fails;
- add a principled name that is not in any allowlist → the orphan test fires.

## Counts, and why they differ from the issue

#4667 measured 52 mutating + 55 read waived. The file today holds 53 + 41; the
read side shrank as commands were pinned since that audit. The numbers here are
measured from the file rather than copied from the issue body, which is the
point of making the count a test rather than prose — though the principled
counts landing on the issue's own 12 + 14 after re-classification is a useful
cross-check that the criterion is the same one the audit used.

## Not done here

The issue's other two acceptance criteria — query steps for the 14 self-labelled
"fixture candidate" reads, and widening the migration⇒mock CONTRACT map beyond
its 9 of 59 tables — are separate work. This commit is the mechanism that makes
that burn-down visible; it does not do the burning down.
