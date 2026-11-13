# Session 3956 — batch-issues model tiers: Fable for the toughest items

The maintainer asked for the batch-issues model guideline to read: Fable for the toughest
challenges, Opus as the default, Sonnet for easy tasks, Haiku for rote or mechanical work.

The table in `.claude/skills/batch-issues/SKILL.md` § Model selection now has those four rows.
The Pareto-frontier paragraph that excluded Fable went with it, and so did the per-row effort
escalation (`xhigh`, `max`): the escalation ladder is one row up, `haiku` → `sonnet` → `opus` →
`fable`. The toughest row is reviewed by `opus`, so builder and reviewer are still two models.

No code changed; no suite ran.
