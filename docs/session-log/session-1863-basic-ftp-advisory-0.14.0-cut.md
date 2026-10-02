# Session 1863 — basic-ftp advisory blocks the 0.14.0 release run

Continues session 1862. The 0.14.0 tag's release run went red at
`validate / lint` on `npm audit`: GHSA-c475-qrg2-pj4r (basic-ftp, high,
published 2026-10-01) has no `.nsprc` entry. `publish-release` is gated on
`validate`, so the run was cancelled before any build uploaded; no draft
release exists.

basic-ftp is dev-only (`@wdio/cli` → `@puppeteer/browsers` → `proxy-agent`
→ `pac-proxy-agent` → `get-uri` → `basic-ftp`; `npm ls basic-ftp
--omit=dev` is empty). The fix is 6.2.1, but every published `get-uri`,
8.0.1 included, asks for `^5`, so there is no upgrade path and the
override goes in `package.json`. That is a real fix, not an exception:
`.nsprc` is for advisories with no fixed version. basic-ftp 6.0's only
breaking change is separate transfer hosts being off by default; `get-uri`
calls `access`, `lastMod`, `list`, `downloadTo` and `close`, none of which
changed, and the CJS entry point is the same `dist/index`.

## Verified

`npx better-npm-audit audit` exits 0 with the override and 1 with main's
`package-lock.json` restored over it. The lockfile diff is the basic-ftp
entry alone.

After merge, 0.14.0 is re-tagged on the fix (the 0.13.0 recovery path):
delete the tag, then `git tag -s` on synced main.
