// Shared content-shell class string for Dialog and AlertDialog primitives.
//
// PERF: hoisted from an inline string in render — twMerge then only re-parses
// the caller's `className` rather than this whole base on every render.
// LAYOUT: `flex flex-col + overflow-hidden` pin header/footer while the
// body owns the scrollable region.
//
// Single source of truth so modal and alert-modal chrome stay in lockstep
// (previously two verbatim-duplicated local consts kept in sync by comment only).
export const DIALOG_CONTENT_BASE =
  'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex flex-col w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-xl border p-6 shadow-(--shadow-overlay) duration-moderate sm:max-w-lg'

// Radix ScrollArea's Viewport wraps its children in an inner
// `<div style="min-width:100%; display:table">`. `display:table` shrink-wraps
// wide content instead of respecting the viewport width, which can make modal
// body content overflow horizontally without a horizontal scrollbar. The
// important `block` override keeps children constrained to the viewport while
// `px-6` restores the content gutter removed by each body's `-mx-6`.
export const DIALOG_BODY_VIEWPORT_CLASS = 'px-6 [&>div]:!block'
