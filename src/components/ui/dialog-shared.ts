// Shared content-shell class string for Dialog and AlertDialog primitives.
//
// PERF: hoisted from inline string in render — twMerge only re-parses caller className.
// See pending/design-system-perf-review-2026-05-09.md Tier 3 item 16.
// LAYOUT: `flex flex-col + overflow-hidden` make header/footer pinned while the
// body owns the scrollable region. See pending/dialog-responsiveness-primitive-2026-05-13.md.
//
// Single source of truth so modal and alert-modal chrome stay in lockstep
// (previously two verbatim-duplicated local consts kept in sync by comment only).
export const DIALOG_CONTENT_BASE =
  'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex flex-col w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-xl border p-6 shadow-(--shadow-overlay) duration-moderate sm:max-w-lg'
