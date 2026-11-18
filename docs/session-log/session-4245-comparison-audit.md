# Session 4245 — the Logseq and Obsidian comparisons checked against main

The maintainer asked for an exhaustive check of the four `COMPARISON-*.md` files after the Logseq matrix turned out to have no row for the Advanced Query board. An earlier pass had only listed the PRs merged since the files' last commit; several feature PRs had edited only their own row, so that said nothing about the rest.

Method: every row of both matrices and both prose pages read against `docs/FEATURE-MAP.md`, `docs/features/*.md`, `docs/SEARCH.md` and the feat/fix commits on `main` since the rewrite (#6734), with the code checked where a claim looked stale. Logseq and Obsidian columns were left as they were; two new Logseq-side cells say **unverified**.

What was stale:

- #6726 merged just before the rewrite and was never reflected: on Android exports, *Save as Markdown file* and attachments save to Downloads, text shared from another app opens Quick Capture, and a newer release is announced once a day. Every "not on Android" for those, and "no share target", was wrong.
- #6742's OR between filters, with parentheses: both matrices still said filters combine by fixed rules.
- #6760's nested tags: the Logseq *Tag hierarchy* row still said a `LIKE` prefix.
- #6746's count on a referenced block: the Logseq scorecard note still listed it as missing.
- The Logseq prose said properties hold one value each, after #6741.
- The mirror row said the latest release had only the writing half; 0.25.0 carries the read-back.
- The Flathub manifest builds from source now (#6788).

Added rows: the Logseq matrix gains *Board view* (§7) and *Outgoing links* (§4). The scorecards were recounted with `node scripts/comparison-scorecard.mjs --write`.

Not done here: the README's line that only the desktop app checks for updates is stale for the same reason (#6726); it is outside these four files. #6877 and #6879 change the supply-chain and language rows but were not on `main`.

## What ran

- `node scripts/comparison-scorecard.mjs --write` on both matrices.
- `prek run --files` on the changed files.
