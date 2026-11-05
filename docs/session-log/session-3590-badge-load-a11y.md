# Session 3590 — a withheld linked badge keeps its link name

A follow-up to the agaric-reviewer note on #6390. While an external badge (`[![CI](https://…/badge.svg)](href)`) was withheld by the external-image policy, the whole privacy placeholder, Load button included, sat inside the link's `role="link"` span. A screen reader then named the link "External image from img.x.com (blocked by your privacy settings) (opens in new tab)": the placeholder's aria-label won, and the alt "CI" was lost.

- The reviewer's suggested red, an axe case, cannot fail here. axe's `nested-interactive` rule covers only roles whose children are presentational, not `link`, so it reports nothing for a button inside a link. The red is the link's accessible name instead (`getByRole('link', { name: 'CI (opens in new tab)' })`), plus the Load button having no `role="link"` ancestor.
- Fix: `GatedImage` takes a `link` wrapper and applies it to whatever it draws. That's the image or the broken-image fallback, or, while withheld, a label holding the alt, placed inside the placeholder next to the domain and outside the Load button.
- Ran: vitest over `src/components` and `src/editor`, `npm run typecheck`, `npm run lint`, and Playwright `linked-image-6342`, `external-image-policy`, `inline-image-1434` and `inline-image-fold`. The new test went red with the label line removed, on the link-name lookup.
