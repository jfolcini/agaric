# Session 1318

## The gap was hiding a bug

#3878 fixed a conformance ratchet that keyed on the *command*, so an uncovered *branch* of
a covered command read as covered. Its working note claimed the command it fixed was the
only one shaped that way. #3892 exists because that claim was wrong. This is the fix for
the second instance — and the review of it found the same defect one level down, in the
change written to remove the defect.

### Four branches, not three

The issue predicted three newly-visible uncovered arms. There are four. A property filter
carrying only a `key` and no value emits no value predicate at all — `Ok(String::new())` —
so the `EXISTS` degrades to a bare key-presence check. That is a distinct SQL shape with
its own way of being wrong, and the "four `value_*` fields" framing cannot see it, because
it is the *absence* of all four.

Worth noticing that both this and #3892 itself are the same error: enumerating the arms
you can name, and missing the one that is defined by nothing being present.

### Why the manifest could not be copied

The issue warned against copying the `list_blocks` entry mechanically, and it was right for
reasons more specific than "be careful":

- The discriminators live on each element of `propertyFilters[]`, not on a request DTO. So
  one step credits a *set* of branches, and a step with no property filters credits **none**
  — the dispatch never ran. Reading `args.request` the way `list_blocks` does would have
  credited the default branch for every step in the suite.
- `value_text_in` is a `Vec` dispatched on `!is_empty()`, so a null-check would credit the
  branch for `[]`, which the backend treats as absent.
- The default-branch arithmetic inverts: `list_blocks`'s last discriminator *is* the
  terminal `else`; here all four have their own arm and there is a real fifth.

Three of those forced changes to shared machinery. A mechanical copy would have compiled,
passed, and credited coverage that did not exist.

### The review found invisible coverage inside the fix for invisible coverage

A non-reserved step credited the value-shape branch for **both** routings — reserved key
(direct `b.<col>` predicate) and non-reserved (`EXISTS` over `bp.value_*`). So the reserved
path's distinctive `AND b.{col} IS NOT NULL` gate, and the key-presence arm which emits
*only* that gate, were marked covered with no differential evidence at all.

The reviewer's test was the right one: *delete that line and every ratchet in the file stays
green.*

It was verified by deleting it rather than by agreeing. Without the gate the filter becomes
a no-op:

```
left:  ["B1","B2","B3","B4","B5","B6"]   (gate deleted)
right: ["B2"]                            (recorded backend truth)
```

### And the gap was hiding a real divergence

Adding the reserved-key step turned the **mock** red — for a genuine reason, not a
fixture-authoring mistake. `fbqPropertyFilterMatches` never checked null-ness for the
reserved-key-plus-no-value combination, though every other value shape was already
null-safe for `source === 'reserved'`. The mock returned all six blocks where the backend
returns one.

So this was not a documentation gap that happened to be uncovered. It was a live cross-stack
divergence that had never been exercised, sitting behind a ratchet reporting full coverage.
That is the strongest argument available for why "the ratchet is green" and "the behaviour
is right" are different claims.

### The sweep, with a denominator

The uniqueness question that #3878 got wrong is now settled by counting: 140 IPC commands,
74 read-only, 20 claiming coverage (so 20 can produce this false positive), 54 waived
wholesale. Of the 20, five are multi-arm; after this, two are declared and one is fully
covered.

Three more instances are filed rather than fixed (#3927), and a separate defect found en
route is filed as #3928 — the `get_block` conformance step drives the *permissive* reader
while the shipped command calls the strict one, so the step certifies behaviour the command
does not have, and the mock agrees with the harness rather than with production.

The forward-looking half matters more than the backlog: the 54 waived commands are safe only
because they claim nothing. Several become false positives the instant a single step is added
under #3825–#3829. The cheap moment to add the branch entry is in that PR, not after it.

### Three comments that claimed more than the code

Also corrected, because a PR about honest coverage should not ship dishonest comments: the
per-element docstring said every ANDed predicate must be right for the rows to be right (a
stricter sibling can mask an over-broad one); the Rust→IPC name mapping was described as
derived from `#[serde(rename_all)]` when it is a hardcoded literal; and #3878's second wrong
dismissal — `export_page_markdown` waved off as write-path formatting code when it is a
read-only command — had been deleted rather than corrected, losing the breadcrumb.
