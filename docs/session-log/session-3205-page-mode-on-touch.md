# Session 3205 — Page mode on touch

#5691's "Touch and IME" item, as far as emulation reaches. The maintainer chose to enable page mode on touch behind Playwright touch emulation and to test on Android after the release; the device-only checks are listed below and the box stays open.

**What changed**
- **Page mode opens on touch.** `usePageMode` no longer requires a desktop pointer. Every gate assertion that encoded the old rule was flipped, not weakened.
- **Block actions in the toolbar.** A finger cannot hover into the grip, so the pinned toolbar gets a *Block actions* button (`BlockMenuButton`, shared with *Edit as Markdown*'s bar) that opens the block menu on the caret's block, in its bulk form when blocks are selected. It opens when the finger lifts, not when it lands: opening on touch put a menu row under the finger, and the lift ran it (Delete, in one trace).
- **The toolbar shows only while the page is edited,** as block mode's does, so the quick-capture button stays reachable on pages and the journal. Block mode's rule for when editing ends moved into `focusStaysInEditor` (`editor-portal.ts`), which both editors now call; block mode's blur is unchanged branch for branch.
- **The caret never types behind the toolbar:** ProseMirror's `scrollThreshold`/`scrollMargin` take the space the pinned bar covers, measured from its top so the keyboard inset counts.
- **The phone switch.** On a phone (`useIsTouch() && useIsMobile()`) the Blocks | Page switch pushed the star and *Page actions* to a second header row, against #5332's one-row header. By the maintainer's choice it is an *Edit as page* / *Edit as blocks* row in the *Page actions* menu (`EditModeItem`), disabled with its reason on a page over the cap. The shortcut and palette listener moved into `useEditModeShortcut`, one per mounted page. Tablets and desktop keep the header switch.
- Smaller: the link bubble fits a phone and shows alone; the journal day's row of actions wraps at 390 px; `PageSourceEditor`'s `onSwitchToPage` is required.

**Decisions and traps**
- A focus guard that greyed *Block actions* until the document had focus was added in review and removed again once the toolbar stopped showing before a tap: under the toolbar's *More* on a 320 px phone, opening *More* takes the focus, so the guard left the row permanently disabled.
- Playwright's tap lifts in the same instant it lands, which hid the ghost tap; `fingerTap` (`e2e/helpers.ts`) lifts one frame later, like a finger.

**Only an Android pass can check:** the soft keyboard against the pinned toolbar and the caret in WebView; IME composition across a long document; hold-to-select with native handles; whether Android's back key hides the keyboard without blurring (the toolbar would then stay, as block mode's does); focus after the block menu sheet closes; speed at the cap.

**Red first:** the touch gate restored (every page-mode-touch test); the toolbar always mounted on touch (the new page and journal tests); every blur ending editing (the block-menu step); *Block actions* opening on press (the reorder test, 3 of 3); the guard restored (the narrow-phone test); `pinnedToolbarCover` returning 0 (the foot test); `useEditModeShortcut` removed from `PageHeader` (three vitest cases); the link bubble's cap or reposition removed; the day row without `flex-wrap` (three `mobile-overflow` tests).

**Suites:** vitest over `src/components`, `src/editor`, `src/hooks`, `src/stores`, `src/lib` and `src/__tests__`; typecheck; lint; the manual-stage hooks; Playwright over every `page-mode*` spec, `app-chrome`, `mobile-overflow`, the journal specs and every `@mobile`-tagged spec. In this container `diagram-legibility`, `block-line-break` "tapping New line" and `pdfjs-v6-smoke` fail on clean `main` too. The whole Playwright and WebdriverIO lanes are CI's.
