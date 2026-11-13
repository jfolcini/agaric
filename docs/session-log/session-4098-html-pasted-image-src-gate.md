# Session 4098 — an image pasted as HTML is gated like a typed one

Found while writing page mode's paste specs for #6714 (session 4095). Page mode keeps ProseMirror's own HTML paste, which reads `<img>` through the image node's parse rule. That rule took any `src`, so `<img src="javascript:alert(1)">` pasted from a web page was stored as `![evil](javascript:alert(1))` and drawn as an image whose load the browser refuses. Block mode converts pasted HTML before it reaches the schema and drops such an image there (`html-paste-1439.spec.ts`), so only page mode showed it.

## Shipped

- `src/editor/extensions/image.ts`: the `img[src]` parse rule refuses a `src` that `isValidImageSrc` refuses, the predicate the typed `![alt](src)` rule already uses. The text around the image still lands.
- `src/editor/__tests__/image-input-rule.test.ts`: both arms through a real editor (an unsafe `src` makes no node, an `https` one keeps its node and alt).
- `e2e/page-mode-paste-image-src.spec.ts`: the same two arms in page mode, read back from the backend.

## Decisions

- The gate is on the node's parse rule, not in page mode's paste: every HTML the schema reads goes through it (a paste, a drop, `setContent` with HTML), and block mode's own conversion stays as it is.
- An image already stored with a refused scheme (an import could hold one) is not touched: Markdown is parsed to JSON, not through this rule.

## What ran

- Red first: the e2e spec and the unit test failed on the unsafe arm before the fix. After it, each arm was shown red again by one mutation (the gate accepting every `src`; the gate refusing every `src`).
- The full vitest suite, `npm run typecheck`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`, `prek run --hook-stage manual --all-files`.
- Playwright: the new spec and the image and HTML-paste specs (`html-paste-1439`, `image-node`, `inline-image-1434`, `linked-image-6342`, `image-resize`, `external-image-policy`, `inline-image-fold`, `page-mode-bubbles`).

Not run: the Rust suites (no `src-tauri/` change), the rest of the Playwright lane, the real-backend lane. CI runs both lanes for a `src/` change.
