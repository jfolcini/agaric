# Session 2814 — the code highlighter is installed once, not twice

The page-mode review (#5691, 2026-10-21) traced #5743's note that lowlight ran twice per transaction to `CodeBlockWithShortcut` in `use-roving-editor.ts`. TipTap's `extend()` copies the parent's `addProseMirrorPlugins` into the child's config and also binds `this.parent` to the parent's result, so the inherited function ran on top of its own output and installed a second lowlight plugin. Each one rescans the whole document on every transaction, in block mode and page mode alike. The extension now overrides `addProseMirrorPlugins` to return the parent's plugins only, and a test counts the lowlight plugin keys (red at two with the override removed). The one plugin left still scans the whole document per transaction, so #5691's "no plugin scans" box stays open.

The page-mode fast-check property test also gets its own 60 s timeout: it drives real editors step by step and timed out once against the global 20 s in a loaded directory run. Its `numRuns` is unchanged.

Suites run: `npx vitest run src/editor/__tests__ src/editor/page-mode/__tests__/page-mode.property.test.ts`, typecheck, lint, and the mermaid round-trip and keyboard-shortcut Playwright specs.
