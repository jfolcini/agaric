# PEND-45 — publish support-window matrix in SECURITY.md

**Goal**: flip `OSPS-DO-04.01` (state scope and duration of support per release) and `OSPS-DO-05.01` (communicate end of security update timeline) from Unmet → Met on the OpenSSF Best Practices form (project 12870).

## Current state

`SECURITY.md` § Supported versions has a 3-row table (latest tag / earlier tags / pre-tag commits on main) but **does not** state:

- The duration of support for the "latest tag" row (e.g. "supported until the next minor release ships").
- An explicit end-of-life timeline for older `0.1.x` tags.
- A statement about what happens at 1.0 (LTS vs rolling).

Without a duration, the table answers "is this version supported?" but not "for how long?" — which is what the OSPS criteria require.

## Acceptance criteria

1. `SECURITY.md` § Supported versions includes a per-version table with at minimum: version range, supported-until policy, security-update window.
2. The policy is realistic for the project's solo-maintainer cadence (e.g. "only the latest `0.1.x` tag receives security updates; older `0.1.x` tags are end-of-life on the day the next tag ships").
3. The 1.0 transition is documented at least as a placeholder ("the support window for 1.x will be defined when 1.0 is cut").
4. `OSPS-DO-04.01` + `OSPS-DO-05.01` flipped to Met on project 12870 with a URL to the relevant section.

## Approach

Replace the existing 3-row table with a richer one:

```markdown
| Version range                  | Status                | Security updates                                       | EOL trigger                          |
|--------------------------------|-----------------------|--------------------------------------------------------|--------------------------------------|
| Latest `0.1.x` tag             | Supported             | Until the next minor release (typically days–weeks).   | New `0.1.(x+1)` tag pushed.          |
| Earlier `0.1.x` tags           | End-of-life           | No backports; upgrade to the latest `0.1.x` instead.   | EOL the day a newer tag ships.       |
| Pre-tag commits on `main`      | Best-effort           | No guarantee; tagged releases are the supported unit.  | Pre-tagged main = always best-effort.|
| `1.x` (post-1.0 cut)           | Policy TBD            | Will be defined when 1.0 is cut.                       | n/a — placeholder.                   |
```

Below the table, two short paragraphs:

- **Why no LTS branch for 0.1.x**: pre-1.0 cadence + solo maintainer; the upgrade path is binary-compatible (op-log + migration invariants in AGENTS.md) so users can always move to the latest tag without losing data.
- **EOL signaling**: an EOL `0.1.x` version is not removed from GitHub Releases (the artifacts stay downloadable for reproducibility / archive value); it just stops receiving security updates.

## Out of scope

- Long-Term Support branch policy — only relevant post-1.0.
- Mailing list / notification mechanism for EOL announcements — the maintainer-as-sole-channel model doesn't have one yet; consider with `bus_factor` work.

## Estimated cost

S (~30 min) — single-file doc edit, no code or workflow changes.
