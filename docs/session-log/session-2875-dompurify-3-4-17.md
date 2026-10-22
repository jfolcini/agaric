# Session 2875 — DOMPurify 3.4.17 clears three critical advisories

`npm audit` began failing on 2026-10-22 with three critical DOMPurify advisories (1242880, 1242881, 1242882; every version up to 3.4.16). The pre-push verify's `better-npm-audit` hook, and the CI lint job that runs it, reject any push while they stand.

**Reach.** DOMPurify is in the shipped tree only through `mermaid` (`npm ls dompurify`: `mermaid@11.17.2 → dompurify@3.4.16`), which sanitizes the SVG of a rendered diagram.

**Fix.** A lockfile-only bump to 3.4.17 inside mermaid's range (`npm update dompurify --package-lock-only`); `package.json` is unchanged and nothing else in the lock moved. No `.nsprc` entry, since a fixed version exists.

**Checked.** `npm audit` reports only the existing `braces` entry (1240992, held in `.nsprc` until a fix ships). On a fresh `npm ci` (dompurify 3.4.17 installed), the vitest files that mention mermaid pass: 13 files, 1129 tests.
