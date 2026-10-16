# Session 2161 — the too-large attachment message suggests compressing (#5410)

#5410's parts 1 and 2 shipped with #5484 (#5364) on 2026-10-14:
- `audio/*` is in all three allow-lists: Rust `ALLOWED_MIME_PATTERNS`, its mock mirror, and the frontend pre-check `ALLOWED_MIME_PREFIXES`;
- the CSP has `media-src 'self' blob:`;
- `AttachmentRenderer` plays audio inline, from the same blob path images use, and has vitest coverage.

This session's brief assumed none of that had landed, and its builder stopped at the premise check without editing anything.

What part 1 still asked for was the rejection hint. The frontend pre-check's toast (`blockTree.attachmentTooLarge`) now reads "File is {{size}} — max is 50 MB. Compress it and try again." That toast is the message a user meets, because the pre-check refuses an oversized file before the IPC. The Rust error is the backstop.

Not added:
- an `audio/mp4` assertion, since `audio/*` is one wildcard arm the existing test already covers;
- an audio e2e spec, for a shipped feature with no reported defect.

Codec playback on WebKitGTK, WKWebView and Android WebView remains the maintainer's manual check. Parts 3 and 4 wait on the issue's design questions.

**Review note from #5615, dropped:** the reviewer suggested reading `rovingEditorRef.current?.originalMarkdown` inline instead of through `readBaseline`. Inline, oxlint's `react-hooks/exhaustive-deps` fails, because the cleanup reads a ref's `.current` directly. Tried on that branch before merge, so the helper stays.

**Falsified** on a copy: with the old message restored, the e2e "a file over the size cap is refused with a toast and leaves no attachment row" fails at its `toBeVisible`.

Ran:
- that e2e case;
- `npx vitest run src/lib/__tests__/file-utils.test.ts src/lib/i18n` (263);
- `npm run typecheck`.
