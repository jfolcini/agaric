# Session 2576 — the ruleset requires the check run's real name

**Found (#5853):** the `default` ruleset required a status context named
`validate-all`, but the check run `ci.yml` posts is `validate /
validate-all` (its `validate` job calls `_validate.yml`). The required
context never matched, so a PR could only merge through the admin bypass.
Checked on #5860's head: the check runs are `dco` and
`validate / validate-all`.

**Fixed:** with the maintainer's approval, the ruleset's required contexts
are now `validate / validate-all` and `dco` (changed through the rulesets
API; `rules/branches/main` reads them back). `branch-protection-assert.yml`
pins the same pair in `EXPECTED_CONTEXTS`, so its next run passes and
later drift still fails it.

**Docs:** with the maintainer's approval, `.github/AGENTS.md` no longer
calls the match unresolved, and root `AGENTS.md` names the full context.
