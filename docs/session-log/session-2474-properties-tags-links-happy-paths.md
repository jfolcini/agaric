# Session 2474 — Happy-path specs for properties, tags and links

These are #5736's mock-lane items, part of the #5726 sweep. Each assertion
was shown red by a product mutation, and a reviewer re-ran every mutation.

**Shipped:**
- **`property-types-happy-paths.spec.ts`**
  - **Number:** a number property set to 12 in the drawer shows `12` after a
    reopen, and the stored row holds the number. Typed text is refused with
    a toast and leaves the value alone.
  - **Number sort:** the References panel sorts numerically by a number
    property.
  - **Boolean:** a checkbox in the page Properties table stays checked after
    a reopen.
  - **URL:** a URL value's chip opens it, and a plain value has no open
    control.
  - **Overflow:** eight properties show `INLINE_PROPERTY_LIMITS` chips and
    fold the rest into `+5`.
- **`tags-and-links-happy-paths.spec.ts`**
  - **Tag query:** the composer's `(alpha OR beta) AND NOT gamma` lists
    exactly the blocks it admits.
  - **Link kind:** the linked-references toggle (All, Page links, Block refs)
    narrows the list and the header count.

**Premises that were wrong:**
- The block drawer has no boolean toggle: it shows a boolean as an empty
  textbox. The checkbox exists only in the page Properties table.
- There is no ref chip to follow a rename. The chip row keeps only text,
  date and number values, and the ref picker lists no tags. Whether ref and
  boolean values should show as chips is asked on #5736.
- Source-page exclude is a Shift+click in its popover, not a pill. The
  filter builder's Clear all leaves it alone.

**Fixes found on the way, each in its own PR:**
- the `+N` badge opened the wrong block's drawer (#5772);
- a date chip opened, and wrote to, the edited block;
- a tag's colour never reached its chips.

**Bug still open:** the backlink Status and Priority filters never match.
The mock ignores most backlink filters, so a source-page spec can't fail
there.

**Ran:**
- both files together, and with `--repeat-each=3`;
- `npm run typecheck` and oxlint.
