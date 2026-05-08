# PEND-36 — UnlinkedReferences "Link it" silently fails on alias-only matches

## Origin

Spot-check 2026-05-08 of whether unlinked references match page aliases.
Outcome: **the backend search does honour aliases** — the bug is in the
FE "Link it" button, which only knows the canonical title and silently
no-ops on alias-only matches while the optimistic UI removes the block
from the list. The user is told the conversion succeeded; on the next
refresh the same block reappears in the unlinked list.

## Backend status — works as intended (no fix needed)

`eval_unlinked_references` (`src-tauri/src/backlink/grouped.rs:349-470`)
already:

1. Loads the canonical title (`:361-371`).
2. Loads all aliases for the page (`:373-378`).
3. Sanitizes title + each alias and OR-joins them into a single FTS5
   query (`:380-417`).
4. Excludes blocks already linked via `block_links.target_id = page_id`
   (`:448-450`) — this catches alias-resolved `[[ULID]]` links too,
   because `[[ULID]]` is what's actually stored after slash-command
   resolution.

Coverage tests confirm both the positive and negative paths:

- `eval_unlinked_refs_alias_match`
  (`src-tauri/src/backlink/tests.rs:4720-4762`) — alias-only mention
  surfaces as an unlinked group.
- `eval_unlinked_refs_linked_blocks_excluded_even_with_alias`
  (`src-tauri/src/backlink/tests.rs:4766-4794`) — block that mentions
  the alias **and** has `[[TARGET]]` is correctly excluded.
- `eval_unlinked_refs_empty_alias_ignored`
  (`src-tauri/src/backlink/tests.rs:4797-4825`) — empty/whitespace
  aliases don't cause false matches.

Edge case worth noting (not a bug, FTS5 limitation): aliases shorter
than 3 chars are silently dropped by `sanitize_fts_query`'s trigram
floor (`src-tauri/src/fts/search.rs:131-176`). Same constraint applies
to short titles. Out of scope for this plan — would require widening
the trigram tokenizer or adding a non-FTS substring search path.

## The bug

**Location**: `src/components/UnlinkedReferences.tsx:158-180`
(`handleLinkIt`).

```typescript
const handleLinkIt = useCallback(
  async (blockId: string, content: string) => {
    const regex = new RegExp(escapeRegExp(pageTitle), 'i')
    const newContent = content.replace(regex, `[[${pageId}]]`)
    try {
      await editBlock(blockId, newContent)
      // Remove block from groups after successful edit
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          blocks: g.blocks.filter((b) => b.id !== blockId),
        })).filter((g) => g.blocks.length > 0),
      )
      setTotalCount((prev) => prev - 1)
    } catch (err) { /* ... */ }
  },
  [pageId, pageTitle, t],
)
```

**Failure scenario** (real, reachable from normal use):

1. User has page **"Project Alpha"** with alias **"ProjAlpha"**.
2. Some block contains the literal text `See ProjAlpha for more info`
   (no occurrence of "Project Alpha").
3. The block correctly surfaces in **UnlinkedReferences for Project
   Alpha** (alias match — confirmed by backend test
   `eval_unlinked_refs_alias_match`).
4. User clicks **Link it** on that block.
5. `regex = /Project Alpha/i` does not match the content.
6. `content.replace(regex, …)` returns the **unchanged** string.
7. `editBlock(blockId, content)` is called with the same content. This
   is *not* a hard no-op — the backend writes a new edit op (validated
   by `edit_block` not having an idempotence early-return).
8. The optimistic UI removes the block from the visible groups and
   decrements `totalCount`.
9. **The user is told "linked"** by the disappearance of the row.
10. On next page mount / `fetchGroups` invocation the block reappears
    in the unlinked list with the same content.

**Severity**: silent correctness bug. No error toast, no console
warning. The user's intent (convert the alias mention) is dropped on
the floor while the UI confirms success. The wasted op_log entry from
step 7 is a secondary cost.

## Recommended fix

**Approach A — FE-side alias fallback** (recommended; minimal blast
radius, no backend change):

1. Load the page's aliases on mount alongside title:

   ```typescript
   const [aliases, setAliases] = useState<string[]>([])
   useEffect(() => {
     let cancelled = false
     getPageAliases(pageId).then((rows) => {
       if (!cancelled) setAliases(rows)
     }).catch((err) => {
       if (!cancelled) logger.error('UnlinkedReferences', 'Failed to load aliases', { pageId }, err)
     })
     return () => { cancelled = true }
   }, [pageId])
   ```

2. In `handleLinkIt`, try the canonical title first, then each alias in
   declared order:

   ```typescript
   const candidates = [pageTitle, ...aliases].filter((s) => s.trim().length > 0)
   let newContent = content
   let replaced = false
   for (const term of candidates) {
     const regex = new RegExp(escapeRegExp(term), 'i')
     if (regex.test(newContent)) {
       newContent = newContent.replace(regex, `[[${pageId}]]`)
       replaced = true
       break
     }
   }
   if (!replaced) {
     toast.error(t('unlinkedRefs.linkFailed'))
     logger.warn('UnlinkedReferences', 'No title/alias match found for Link it', { blockId, pageId })
     return
   }
   await editBlock(blockId, newContent)
   // ... existing optimistic-update path
   ```

3. The "no candidate matched" branch is a real failure mode (e.g. FTS5
   matched on something the regex literal-matcher can't see, or aliases
   were added after the search) — surface it as the existing
   `linkFailed` toast and skip the optimistic removal.

**Approach B — Backend returns matched-on metadata** (more invasive,
not recommended for this plan): extend `BacklinkBlockData` with a
`matched_term: Option<String>` field populated by
`eval_unlinked_references`. Cost: schema change, type-binding regen,
test fan-out. Benefit: the FE can do a single-shot replace and also
visually mark which mention matched (a separate UX nicety).

Approach A solves the silent-failure bug at FE-only cost. Approach B is
worth considering as a follow-up if/when we add per-mention
highlighting.

## Test plan

Vitest (`src/components/__tests__/UnlinkedReferences.test.tsx`):

1. **Alias-only match — Link it succeeds**: mock
   `listUnlinkedReferences` to return a block whose `content` contains
   only the alias text, mock `getPageAliases` to return the alias,
   mock `editBlock`. Click Link it → assert `editBlock` was called with
   `content` rewritten to include `[[<pageId>]]` (i.e. the alias was
   replaced).
2. **Title match still wins when both present**: content contains both
   title and alias → assert title is the term that gets converted (not
   alias) when the title appears first or anywhere.
3. **No match — error path**: contrive a content/aliases combination
   that the backend matched but the FE regex can't (e.g. a non-Latin
   alias case the regex misses) → assert `editBlock` NOT called,
   `toast.error` shown, optimistic removal NOT applied.

Backend rust tests already exist for the search side; nothing to add.

## Cost / Impact / Risk

| Cost | **S (1-2 h)** — FE-only change in one file plus 3 vitest cases. |
| Impact | **Medium** — silent-correctness bug user-visible. Affects every page with at least one alias whose blocks contain alias-only mentions. Low absolute frequency, high per-incident user confusion ("why does this keep coming back"). |
| Risk | **Very low** — FE-only, additive. The optimistic-removal path is gated by a successful `editBlock`, so a thrown error already surfaces a toast; the new "no candidate matched" branch reuses that same toast key. The `getPageAliases` call mirrors the existing `PageHeader.tsx:367` pattern. |

## Sequencing

Standalone — no dependencies on Tier 1/2/3 items in PEND-35. Fold into
the next light-touch FE session. If PEND-35 §1.2
(`resolve_page_by_alias` scope fix) is also being worked, no shared
files but shared testing context (alias semantics).
