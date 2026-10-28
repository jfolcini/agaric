# Session 2975 — Red first and existing tests as contract in the batch-issues skeleton

Set out to land the second half of #6142: make the failing spec precede the build in the agent workflow, and keep builders from rewriting the specs that judge them.

Two lines in the §2 prompt skeleton of `.claude/skills/batch-issues/SKILL.md`:

- **Red first:** for a behaviour change the builder writes the failing spec in the change's lane (e2e, vitest, Rust test or conformance fixture), runs it red, then implements, and reports the red for the reviewer to re-run. It is scoped to behaviour changes because a deletion or a docs item has no spec to write first; §3's falsification rule stays the verification half.
- **Do NOT modify** now names existing tests under `e2e/**`, `e2e-tauri/**` and `src/**/__tests__/**`. Adding tests there stays allowed, since that is where every new spec lands; editing an existing one is a contract change the builder reports for the reviewer or the maintainer, matching §3's "Never edit an existing test or fixture so a new change passes".

Docs only; no suite ran beyond the pre-commit hooks. The first half of #6142 (the e2e domain vocabulary) is a separate PR.
