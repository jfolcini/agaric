# Session 4429 — the pins stale lane sends GITHUB_TOKEN to api.github.com by host, not by substring

**Ask.** Address the open code-scanning alerts.

**#301 (CodeQL `js/incomplete-url-substring-sanitization`).** `httpClient()` in `scripts/pins.mjs` attached `authorization: Bearer $GITHUB_TOKEN` to any URL that contained `api.github.com`. A URL such as `https://example.com/api.github.com/x` or `https://api.github.com.example.com/x` would have received the token. Every URL the stale lane fetches today is a literal in `UPSTREAMS`, so nothing leaked, but the check said something it did not do. It now compares `new URL(url).hostname`.
- New test: "sends GITHUB_TOKEN to api.github.com only, not to a url that merely contains it". It fails with the old `includes` check and passes with the fix.
- `httpClient` is exported for that test.

**#300 (Scorecard Dangerous-Workflow) on `gradle-verification-commit.yml`.** Not changed here. The `workflow_run` job checks out `head_branch` under `contents: write`, but runs nothing from it: it copies one XML file that it parses first, then commits and pushes. The options were left for the maintainer to choose.

**Ran:**
- `node --test scripts/pins.test.mjs`: 24 pass. The falsification restored `url.includes('api.github.com')` and the new test went red on its `deepEqual`, the only failure.
- oxlint and oxfmt on both files.
