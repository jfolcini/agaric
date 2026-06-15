# Session 1038 — clear inherited `main` CI reds (npm-audit advisories + chevron hover-reveal e2e)

2026-06-16. Discovered during the `/loop /batch-issues` batch-boundary sweep: every open
PR (#1290/#1291/#1293/#1294) was red on the same two checks (`lint`, `playwright (1)`),
i.e. failures inherited from `main`. Fixed in this dedicated PR off `origin/main` so it
merges first and clears all of them.

## 1. `lint` — npm audit (new dependency advisories)
8 new advisories landed in the dep tree: 7 dompurify IN_PLACE-mode XSS bypasses
(1120800/1120801/1120802/1120803/1120805/1120812/1120813) + 1 markdown-it quadratic DoS
(1120820). All require attacker-controlled DOM / sanitizer-config / adversarial markdown,
which does not exist in a single-user local-first app with no adversarial input
(AGENTS.md threat model) — same rationale as the existing mermaid/dompurify/js-yaml
allowlist. Added to `.nsprc` with justifications + 90-day expiry. `better-npm-audit` →
exit 0.

## 2. `playwright (1)` — chevron hover-reveal regression from #1244
#1244 made an EXPANDED parent's collapse chevron `opacity-0 pointer-events-none` at rest
(hover-revealed). Two e2e tests clicked the chevron after `Escape` (un-focused, un-hovered),
so Playwright's actionability check timed out:
- `keyboard-shortcuts.spec.ts:295` (Ctrl+. … click chevron)
- `block-keyboard-select-collapse.spec.ts:34` (collapse a selected ancestor)

Fix: `await <row>.hover()` before the expanded-chevron click — matching the real
hover-reveal interaction. (The later expand-click needs no hover: a COLLAPSED chevron
stays visible/interactive at rest. The keyboard-only Ctrl+. test and `toBeVisible()`
asserts were unaffected — `opacity-0` still passes Playwright visibility.)

Verified: `playwright -g collapse` → 3 passed.
