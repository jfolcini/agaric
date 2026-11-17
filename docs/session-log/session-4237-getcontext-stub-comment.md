# Session 4237 — the getContext stub comment after jsdom 31

#6864's review flagged the comment on the `HTMLCanvasElement.getContext` stub in `src/test-setup.ts`. It said jsdom does not implement canvas, and that the `canvas` package would pull in cairo.

jsdom 31 swaps its optional canvas backend from `canvas` to `@napi-rs/canvas`, and pdfjs-dist already installs `@napi-rs/canvas` as an optional dependency. So once #6864 lands, the files that opt into jsdom would get a real Skia context without the stub. happy-dom, the default environment, returns `null` from `getContext` because no `canvasAdapter` is configured.

The comment now says what the stub does: keep `getContext` returning `null` in every environment.

## What ran

- Read `getContext` in happy-dom 21.0.4 (`canvasAdapter` defaults to `null`). Read jsdom 31.0.0's packed `package.json`: `@napi-rs/canvas` is an optional peer, `^1.0.13`. In jsdom 31's `lib/jsdom/utils.js`, `exports.Canvas = require("@napi-rs/canvas")`.
- `package-lock.json` resolves `@napi-rs/canvas` 1.1.0 through `pdfjs-dist`'s `optionalDependencies`.
- `prek run --files src/test-setup.ts`: green.
