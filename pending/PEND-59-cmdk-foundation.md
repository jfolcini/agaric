# PEND-59 — Adopt `cmdk` as the combobox foundation; migrate `SearchablePopover` callers

> **Foundation plan** that the post-PEND-50/51/52/53/54/55 review session committed to. Replaces the hand-rolled `SearchablePopover` component (193 LOC, 17 tests, used by `BacklinkFilterBuilder`, page picker, tag picker, `FilterHelperPopover`) with `cmdk` (Vercel's command-menu library) as the standardised combobox / listbox shell. The driving reason: the Cmd+K palette (PEND-51) is expected to grow into a Linear-style multi-mode command surface (search / nav / actions / settings / spaces). cmdk's `<Command.Group>` and sub-command primitives pay off there; standardising on it removes the divergence between two component models.
>
> Foundation for **PEND-60** (caret-anchored autocomplete on cmdk) and **PEND-61** (refactor PEND-51 palette to cmdk + multi-mode growth).

## TL;DR

- **Add cmdk** as a dependency (`cmdk` ~4 KB gzipped; Apache-2.0 license; on `deny.toml` allowlist already accepts permissive licenses).
- **Build a thin Agaric wrapper** (`src/components/ui/command.tsx`) that styles `cmdk`'s headless components with the existing Tailwind / Radix tokens. Mirrors the shadcn/ui `<Command>` pattern but without pulling shadcn.
- **Migrate `SearchablePopover` callers** in three batches: BacklinkFilterBuilder, page picker (legacy SearchPanel chip), tag picker (legacy SearchPanel chip), `FilterHelperPopover`. The page/tag pickers in `SearchPanel.tsx` were deleted in PEND-54 — only the BacklinkFilterBuilder + `FilterHelperPopover` callers remain to migrate.
- **Delete `SearchablePopover`** + tests once callers migrate.
- **No backend changes.** Pure frontend swap.

## Current state — verified

- `src/components/SearchablePopover.tsx` — 193 LOC, generic over `T`, uses `useListKeyboardNavigation`, Radix `Popover` + `MenuPopoverContent` + `ScrollArea`.
- Tests: `src/components/__tests__/SearchablePopover.test.tsx` — 17 cases.
- Callers (verified via grep): `src/components/backlink-filter/categories/HasTagFilterForm.tsx`, `src/components/search/FilterHelperPopover.tsx` (PEND-54 just landed).
- Other places using a similar combobox pattern but **not** via `SearchablePopover`: `src/components/SearchPalette.tsx` (PEND-51, hand-rolled), `src/components/BacklinkFilterBuilder.tsx` (uses `SearchablePopover` indirectly).
- No cmdk dep today; no shadcn/ui either. The codebase composes Radix Primitives + Tailwind directly.

## Design

### What cmdk gives us

- A headless **combobox shell**: input + scrollable list + keyboard model + filtering + ARIA roles (combobox / listbox / option).
- `<Command.Group>` for categorised lists (state values, tag list, command palette modes).
- `<Command.Item>` with built-in `data-selected` / `data-disabled` attributes for styling.
- Built-in fuzzy scoring (we don't use it — the parser already classifies tokens, and tag / page lookups are exact). Opt-out via the `shouldFilter={false}` prop.

### What cmdk does NOT give us

- **Positioning** — `<Command>` is a `<div>` wrapper. Caret/anchor positioning is BYO via Radix `Popover` (existing) or `@floating-ui/react`.
- **Multi-selection state** — single-select only; `FilterHelperPopover` uses single-select today, so no gap.
- **Async item loading** — items are fed externally; if a future plan needs async fetch (e.g. semantic search results), it's the consumer's responsibility.

### Thin Agaric wrapper (`src/components/ui/command.tsx`)

Styled exports mirroring the shadcn pattern but built on cmdk directly:

```tsx
// Sketch — load-bearing shape only
export const Command = CommandPrimitive
export const CommandInput = ({ className, ...props }: ...) => (
  <CommandPrimitive.Input className={cn(/* Tailwind tokens */, className)} {...props} />
)
export const CommandList = ({ ... }) => (
  <CommandPrimitive.List className={cn(/* scrollable, max-h, ... */)} {...props} />
)
export const CommandItem = ({ ... }) => (
  <CommandPrimitive.Item className={cn(/* hover, focus, data-selected */)} {...props} />
)
// + CommandGroup, CommandSeparator, CommandEmpty
```

Tokens: reuse `--accent` / `--accent-foreground` (the same pair PEND-50 picked for `<mark>`), the existing `--border` / `--background` / `--popover` pairs. No new design tokens.

### Migration pattern

For each `SearchablePopover` caller, the migration is roughly:

```tsx
// Before
<SearchablePopover
  items={items}
  query={query}
  onQueryChange={setQuery}
  onSelect={onSelect}
  ...
/>

// After
<Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger>...</PopoverTrigger>
  <PopoverContent>
    <Command shouldFilter={false}>
      <CommandInput value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>
        {items.map(item => (
          <CommandItem key={item.id} onSelect={() => onSelect(item)}>
            {renderItem(item)}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

The mechanical work is similar across callers; behaviour is preserved.

## Phase split

### Phase 1 — Add cmdk + wrapper (S, ~3-4 h)

- `npm install cmdk` (verify license under `deny.toml` allowlist).
- `src/components/ui/command.tsx` — styled wrappers per the sketch above.
- New `src/components/ui/__tests__/command.test.tsx` — keyboard nav, selection, axe audit.
- No caller migrations yet.

### Phase 2 — Migrate `FilterHelperPopover` (S, ~2-3 h)

PEND-54 just landed this; the migration is small (one caller, three categories). Migrate to cmdk; preserve the categorised-picker behaviour.

### Phase 3 — Migrate `HasTagFilterForm` / backlink-filter callers (S, ~2-3 h)

The remaining production callers of `SearchablePopover`. Tag picker behaviour preserved (search input + tag list + select).

### Phase 4 — Delete `SearchablePopover` + tests (S, ~1 h)

Once all callers migrate, delete `SearchablePopover.tsx` (193 LOC) and `SearchablePopover.test.tsx` (17 cases). Verify no dangling imports.

## Tests

- **Phase 1 unit:** Keyboard nav (arrow up/down/home/end), selection (Enter), Esc to close, filtering (`shouldFilter` false vs true), axe audit on the wrapper.
- **Phase 2-3 integration:** Existing `BacklinkFilterBuilder` and `FilterHelperPopover` test suites pass against the new implementation.
- **Phase 4:** Re-run `prek run --all-files` to catch dangling imports.

## Open questions

1. **Sub-command navigation in `<Command.Group>`** — out of scope for this PEND (PEND-61 owns the multi-mode palette). cmdk's group support is opt-in; we use plain `<CommandItem>` lists for now.
2. **Theming variants** — the `<CommandInput>` placeholder colour should match the existing `<Input>` placeholder. Verify before Phase 2.
3. **knip / dead-code detection** — once `SearchablePopover` is deleted, run `npm run knip` to catch any other obsolete imports.

## Acceptance criteria

- `npm ls cmdk` resolves; `deny.toml` license check passes.
- `src/components/ui/command.tsx` exists with the seven canonical exports (`Command`, `CommandInput`, `CommandList`, `CommandItem`, `CommandGroup`, `CommandSeparator`, `CommandEmpty`).
- `SearchablePopover.tsx` deleted; no production imports remaining (verified via `grep -r 'SearchablePopover' src/`).
- `BacklinkFilterBuilder` + `FilterHelperPopover` behaviour identical to pre-migration (test parity).
- a11y: every new component test includes a `vitest-axe` audit.

## Related

- `pending/PEND-60-caret-autocomplete.md` — depends on this foundation.
- `pending/PEND-61-palette-multimode.md` — depends on this foundation.
- `pending/PEND-62-mobile-unified-search.md` — depends on this foundation (mobile sheet uses cmdk).
- `pending/NOTES-AUTONOMOUS-2026-05-17.md` — the review session that decided to adopt cmdk.
- `src/components/SearchablePopover.tsx` — replaced.
- `src/components/backlink-filter/categories/HasTagFilterForm.tsx` — migration target.
- `src/components/search/FilterHelperPopover.tsx` — migration target.
