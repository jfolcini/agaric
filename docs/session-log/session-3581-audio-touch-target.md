# Session 3581 — the audio player meets the 44 px touch target (#5410)

Checked whether the attachment `<audio controls>` player (`AttachmentAudio`) is a 44 px target under a coarse pointer. It is: Chromium, the engine of Android's WebView and the only coarse-pointer platform Agaric ships, draws it 54 px tall, so nothing changed in the component.

- `touch-hit-area` cannot apply: `<audio>` is a replaced element and renders no `::before`, so the element's own box is the target.
- The assertion is a measured Playwright check in `e2e/attachments.spec.ts` (touch context, `pointer: coarse` asserted), not the `AttachmentAudio` vitest: jsdom has no layout, so a component test could only check a class name.
- Falsified: `h-8` on the player made it red with "Expected: >= 44, Received: 32"; restored.
- Not checked: WebKit's control height (WKWebView on macOS has a fine pointer; WebKitGTK on a Linux touch screen was not measured here).
- Trap: this container's Playwright wants `chromium-1248`, and `/opt/pw-browsers` has 1243; a `PLAYWRIGHT_BROWSERS_PATH` of symlinks naming 1243 as 1248 runs the lane, even for specs that set their own `launchOptions`.
