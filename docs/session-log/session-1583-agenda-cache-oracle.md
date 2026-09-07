# Session 1583 — the `agenda_cache` reconciliation oracle (#3345)

## What

Artefact 10. `agenda_cache` now reconciles against a from-base fold, in both
directions, with its own banner so a failure is never mistaken for a sibling
artefact's.

This is the last of the four #3345 rows that #4679 unblocked, apart from
`projected_agenda_cache`, which is the natural next one.

## What the fold transcribes

From `DESIRED_AGENDA_SQL` (`agaric-store/src/cache/agenda.rs`) and the dedup in
`apply_sort_merge_rebuild`, folded in Rust rather than re-expressed as SQL so it
is an independent recomputation:

- four upstreams, in precedence order — any `block_properties` row with a
  non-NULL `value_date` (`property:<key>`), a `date/YYYY-MM-DD` tag on the block
  (`tag:<tag_id>`), then the promoted `due_date` and `scheduled_date` columns;
- every arm requires the SOURCE block live; the tag arm additionally requires
  the TAG block live and `block_type = 'tag'`;
- every arm repeats the same template exclusion: a block whose owning page
  carries a `template` property contributes nothing, whatever the value;
- the key is `(date, block_id)` and the merge keeps the lowest `prio`.

## The expectation is a SET, and that is not a convenience

Within one prio the winner is genuinely ambiguous. `ORDER BY date, block_id,
prio` leaves two properties with the same `value_date` on one block — or two
distinct date tags naming one day — in unspecified order, and the dedup keeps
whichever SQLite emitted first. An oracle that pinned one of them would red a
correct rebuild on a different SQLite plan.

So the fold returns every source at the winning prio, and only a source from a
LOSING prio (or no row at all) is a divergence. The fixture arms both halves:
one block carries two same-day properties, the test asserts the expectation is
the two-element set, and then forces the stored row to EACH source in turn and
requires both to reconcile. Pinning either one alone leaves the other untested.

## Two SQLite semantics the SQL leans on

Both checked against `sqlite3` rather than recalled:

- `LIKE 'date/%'` is ASCII case-INSENSITIVE — `case_sensitive_like` is set
  nowhere in this schema — so `DATE/2026-03-09` **is** a date tag and does
  produce an agenda row. The fixture contains one, because a Rust reading that
  used `starts_with("date/")` would silently drop it.
- `GLOB '[0-9]'` is ASCII-only, so the digit test is `is_ascii_digit` and not
  `char::is_numeric`, which also accepts `٣` and `３`.

`LENGTH()` counts characters rather than bytes and the fold counts `chars()` to
match — but the two readings cannot disagree on the answer, because the GLOBs
pin all ten trailing positions to ASCII, so anything accepted is 15 bytes as
well as 15 characters. That is written down in the doc comment instead of being
dressed up as a test: a case that cannot fail is not coverage.

## Reading `page_id` as STORED, not re-derived

The template exclusion is `tp.block_id = b.page_id`, against the denormalised
column. The fold reads it the same way. Auditing ownership is the page-id
artefact's job; re-deriving it here would report a stale `page_id` as a phantom
agenda row and misattribute it. Each artefact audits one derivation step.

## Review notes from #4824, folded in

Both land in the file this session was already editing, so neither cost a
separate review round:

- `fold_tags_cache_from_base` carried `content` out of the winner map with
  `unwrap_or_default()`, a fallback for the NULL the loop above had already
  `continue`d past. If it had ever fired it would have asserted `name: ""` as
  the expectation instead of failing. The content now travels with the winner,
  so there is nothing to recover and no fallback to get wrong.
- The #1990 decay guard asserted `"Σigma".to_lowercase() == "σigma"`, which also
  passes for an ASCII pair — so rewriting the fixture to `Aigma`/`aigma` would
  have left it green while the test stopped discriminating `normalize_tag_name`
  from `COLLATE NOCASE`. The discriminating half is the NOCASE rule itself, and
  it is now asserted alongside: `"Σigma".to_ascii_lowercase() != "σigma"`.

## Falsification

Six mutants, each applied to a COPY, run, restored, and the restore
`cmp`-verified byte-identical. All six red.

Against the fold, proving the test's assertions are load-bearing:

- demote the tag arm below `due_date` — `2026-03-04`'s source changes;
- drop the template exclusion — `2026-03-11` is resurrected;
- make the `date/` prefix case-SENSITIVE — `2026-03-09` disappears;
- drop the tag-liveness check — the deleted tag's `2026-03-08` is resurrected.

Against PRODUCTION, which is the point of an oracle — the fold mutants only
prove the test pins the fold, not that the oracle would catch real drift:

- remove the template exclusion from `DESIRED_AGENDA_SQL`'s `due_date` arm —
  production writes the template child's row and the oracle reports it;
- renumber the tag arm's `prio` below `due_date` — production stores
  `column:due_date` for `2026-03-04` and the oracle reports the demoted source.
