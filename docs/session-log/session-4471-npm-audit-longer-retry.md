# Session 4471 — the npm audit retry waits long enough for the registry to recover

Main's `validate / lint` went red on 1289842 at `npm audit signatures`. `registry.npmjs.org/-/npm/v1/attestations/@tiptap%2fextension-code-block-lowlight@3.34.0` answered with the plain-text body `OK` instead of JSON on all three attempts from `scripts/npm-audit-retry.sh` (23:46:15 to 23:46:38 UTC). Half an hour later the same URL returned JSON, and `npm audit signatures` passed locally on main's lockfile.

**Cause.** It was the second episode of this registry failure. #7050 saw the same `OK` body for `playwright@1.65.1`, across 33 s. #7054 then gave each attempt its own npm cache, so a retry asks the registry again. This time every fresh request still got `OK`, so the registry kept serving it for longer than the retries ran: 5 s then 15 s.

**Fix.** `BACKOFF_SECONDS` is now `(5 15 60 120)`, five attempts. Such an episode gets minutes to clear before the gate reds. A real failure, such as an advisory or a bad signature, still fails, only later: about three minutes, on a step that runs only when a dependency manifest changes.

**Ran.**
- `node --test scripts/npm-audit-retry.test.mjs`: 6 passed.
- With the old `(5 15)`, three of the tests fail on the attempt count and the sleeps.
- Main's failed lint job was re-run once beside this fix.
