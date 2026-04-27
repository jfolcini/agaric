/**
 * Shared declarations for the markdown serialize/parse pair.
 *
 * Currently empty: a code-graph audit (REVIEW-LATER MAINT-117) confirmed
 * zero call-graph crossings between the serialize half and the parse half
 * of the original `markdown-serializer.ts` monolith. This module exists so
 * any future helper, regex, or constant that needs to be shared between
 * `markdown-serialize.ts` and `markdown-parse.ts` has a canonical home —
 * without forcing either half to import the other.
 */
export {}
