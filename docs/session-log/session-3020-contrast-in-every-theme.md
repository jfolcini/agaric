# Session 3020 — Code blocks and muted text clear 4.5:1 in every theme (#6160)

Set out to fix #6160. The review-notes PR (#6161) moved code-block colours onto theme tokens, so a code comment now uses `--muted-foreground` on `--muted`. That pair was under 4.5:1 in Solarized Dark, Dracula and One Dark Pro.

**Shipped:**
- **`--muted-foreground` is lighter in three themes;** hue and chroma are kept. It now clears 4.5:1 on `--muted`, `--accent`, `--secondary`, `--card`, `--popover`, `--background` and the sidebar surfaces:
  - Solarized Dark 0.66 → 0.69 (lowest pair 4.55, on `--accent`);
  - Dracula 0.70 → 0.75 (4.67, on `--muted`);
  - One Dark Pro 0.70 → 0.73 (4.68, on `--accent`).
  Light, Dark and Solarized Light are untouched.
- **`.hljs-addition`** (an added line in a diff block) joins the tip-token group. github.css's `#22863a` was 4.47:1 on its own `#f0fff4`; `--alert-tip-foreground` is 7.16 in Light and 6.02 in Solarized Light.
- **`this` and `self` take the keyword colour again in dark themes.** `.dark .hljs-variable.language_` joins the keyword group: a later `.dark .hljs-variable` rule of equal specificity had painted them blue.

**Decisions and traps:**
- **#6160's premise held only after #6161.** On `main` before it, comments used a hard-coded `#768390`, which failed every dark theme, and Dracula and One Dark Pro also failed on keywords. #6160 was built on #6161's branch.
- **Solarized Dark's muted text is 0.01 L lighter than its body text.** That is invisible. Keeping it under would need a darker `--accent`, which touches every hover surface.
- **The new e2e could pass without checking the diff block.** It now waits for every block's tokens before axe runs.
- **Review folded the per-theme pairs into `theme-contrast.test.ts`'s table,** replacing a second copy of the colour maths. Two `DOCUMENTED_GUARANTEES` values moved with the tokens, as that pin is meant to.

**Tests:**
- `e2e/code-comment-contrast.spec.ts` runs axe `color-contrast` over eight code blocks in all six themes, and checks in the four dark themes that `this` has the keyword colour.
- Seven pairs added to the per-theme table, run over every theme with and without high contrast.
- Each change was shown red by reverting it.

**Suites:**
- vitest over `src/lib`, `src/components/settings` and `src/editor` (9,903 tests), then the contrast table (375);
- typecheck, lint and the manual-stage hooks;
- Playwright: `code-comment-contrast`, `block-syntax-reveal`, `closed-task-contrast`, `theme-icons`, `theme-overlay` and `nav-active-item`.
- `diagram-legibility` fails three tests locally with and without this change, and passes in CI.
