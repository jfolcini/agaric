# Session 3863 — The batch skill lets a reviewer approve a test edit

The batch-issues skill told builders never to edit an existing test and to stop for "the reviewer or the maintainer" when a change needed one. In a run over the audit's issues this stopped three builders on work the issue itself prescribed: #6547 (the selection bar from two blocks), #6528 (the "no devices paired" dot) and #6554 (the page editor's error boundary). Each reported correctly and each waited on a sign-off the maintainer does not want to give case by case.

The rule now separates two cases. A test that pins the behaviour an issue asks to change is edited with the change; the builder names each old and new assertion, the reviewer decides whether the old assertion was the old behaviour or a contract the change breaks, and the PR body lists them. A test that goes red for any other reason is still a finding and is never edited to pass.

Changed: the builder prompt skeleton's "Do NOT modify" line and the first paragraph of § 3 in `.claude/skills/batch-issues/SKILL.md`. Nothing else in the skill says otherwise. No code changed and nothing was run beyond the Markdown hooks.
