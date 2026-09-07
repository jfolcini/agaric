# Session 1591 — re-vendor the pdf.js worker for the npm group bump (#4837)

## What broke

`validate / playwright (2)` failed on the Dependabot minor-and-patch PR with
three PDF specs red and 264 passing. The bump moved `pdfjs-dist` `^6.2.108` →
`^6.3.289`, but `public/pdf.worker.min.mjs` is **hand-vendored** and Dependabot
does not touch it. pdf.js requires the API and worker versions to match exactly,
so `getDocument()` rejected and no page ever parsed — visible in the DOM as
`aria-label="Page 1 / 0"`.

The surfacing error is uninformative on purpose-adjacent grounds: Playwright
shows a bare `UnknownErrorException`, and the version-mismatch text never
reaches the log.

## The fix, which the spec itself documents

`e2e/pdfjs-v6-smoke.spec.ts`'s header says it outright:

> EVERY pdfjs-dist bump (including Dependabot's) must re-vendor the worker in
> the same commit, or this spec goes red and PDF attachments stop opening.
> When this spec fails … Do not go hunting for a rendering bug; check the worker
> version first.

So: re-vendor `public/pdf.worker.min.mjs` from the packed 6.3.289 artifact (with
the trailing newline `end-of-file-fixer` requires), and move the hard-pinned
`expect(result.version).toBe(…)` to `6.3.289`. Both edits are needed — the pin
fails on its own even after the worker is refreshed.

`pdfjs-dist` was NOT pinned back: that defers the same break to the next
Dependabot run, and the re-vendor is two lines.

## This is the third time

`16ca18b8f` (#3449) and `ec5ffce4f` (#2394) are the same defect with the same
fix. Nothing in `prek.toml` compares the vendored worker against the installed
`pdfjs-dist`, so each bump rediscovers it through a red CI round.

A hook comparing `sha256(head -c -1 public/pdf.worker.min.mjs)` against
`node_modules/pdfjs-dist/build/pdf.worker.min.mjs` would run in milliseconds and
could print the exact re-vendor command. Against the "Guards earn their keep"
checklist: the defect has occurred (three times, cited above), nothing else
catches it, it is well under 500 ms, it fails loudly with the fix, and it fails
closed (a missing or unreadable file is a violation). That is a separate change
and a maintainer call on the hook budget, so it is recorded here rather than
folded into a Dependabot PR.
