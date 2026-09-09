# Session 1625 — two new advisories, one fix and one exception

`validate / lint` went red on an open PR whose diff touches no dependency.
Main's last run was green, so these are advisories published since it: 1193727
against js-yaml and 1193685 against extract-zip. Inherited red, and it would
have failed every PR from here, so it is fixed off `origin/main` rather than
inside the PR that noticed it.

## js-yaml — fixed

`js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources`,
affecting `>=4.0.0 <4.3.2`. The tree had 4.3.1 and 4.3.2 is published, so this
is a real fix, not a judgement call.

`npm audit fix` was the wrong instrument: it also carried the whole `@wdio`
stack from 9.31.5 to 9.31.7 and mocha from 10 to 11, a major, in a 346-line
lockfile diff. Dependency stacks in this repo move deliberately and together,
not as a side effect of an unrelated audit. `npm update js-yaml
--package-lock-only` does the same job in three lines.

Reach was dev-only either way (`npm ls js-yaml --omit=dev` is empty; it comes
in through mocha and markdownlint-cli2), but the fix cost three lines, so the
reach did not have to carry the decision.

## extract-zip — excepted

`extract-zip allows arbitrary file writes through symlink archive entries`.
npm reports the affected range as `*`: every published release. There is
nothing to upgrade to, and `npm audit fix` proposes a semver-major downgrade of
`@wdio/cli` that does not remove the dependency either.

This is the sibling of 1139346, already excepted here for the same package by
the same path — `@wdio/cli` → `@wdio/utils` → `@puppeteer/browsers` →
extract-zip, used by the e2e-tauri lane to unpack browser drivers.
`npm ls extract-zip --omit=dev` is empty, so it is in no shipped artifact, and
the only archives that lane extracts are browser binaries from official
Chromium endpoints over TLS. The new entry takes 1139346's expiry so the two
are re-evaluated in one pass.

## Verification

`npx better-npm-audit audit` reports both extract-zip advisories as excepted
and nothing else, and exits clean. js-yaml no longer appears at all, which is
the check that the version bump landed rather than being silenced.
