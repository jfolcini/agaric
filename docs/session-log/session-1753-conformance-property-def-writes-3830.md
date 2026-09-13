# Session 1753 — the two property-def writers, pinned (#3830)

`create_property_def` and `update_property_def_options` were waived in
`NO_FIXTURE_ALLOWLIST` as "property_definitions registry (app-layer), not
projected block state". That reason stopped being the blocker when #4939 put
`seed.property_defs` on both runners and pinned `list_property_defs` /
`get_property_def` with query steps: the table is on both stacks with a
backend-authored reader, which is exactly the precondition the peer-ref and
page-alias waivers already call "fixture candidate".

Both commands answer with a `PropertyDefinition`, so the command leg's
`RETURN_SHAPE` takes them with no new return shape. The attribute list is
`PROPERTY_DEF_ATTRS`, now shared with the read token on both stacks rather than
spelled a third and fourth time — the "MUST match the Rust twin" comment the
tokens already carry is cheaper to keep true with one constant than four.

## The mock had no validation at all

The backend refuses five things on these two commands. The mock refused one of
them (an unknown key on update). Everything else went straight through:

| backend rule | mock before |
|---|---|
| `validate_property_def_shape`: key 1-64 chars, `[A-Za-z0-9_-]`, `value_type` one of six | accepted anything |
| select requires a non-empty options array; non-select forbids options entirely | accepted anything |
| `create_property_def` is INSERT OR IGNORE — the existing declaration wins | overwrote it |
| `update_property_def_options` parses `Vec<String>` *before* the key lookup | wrote the string through |
| options only mean something on a select-type definition | updated a `text` def |

The idempotency one is the divergence with teeth. `create_property_def_inner`
validates first and *then* returns any existing row untouched, so re-declaring
`priority_level` as `text` answers with the original `select` row, options and
all. The mock's `propertyDefs.set(key, def)` replaced it. A spec could declare
a key one way in the browser mock and get the other behaviour from the real
backend — which is the whole class #3830 exists to close.

## The anti-vacuity guard was right, and the waiver is a different case

The first green run wasn't green: #3966's guard flagged the fixture because its
`expected` equals the seed-only snapshot. That is correct and unfixable here —
`property_definitions` is not in the projected snapshot, so no sequence of these
two commands can move `blocks` / `properties` / `block_tags` / `page_links`.

`SNAPSHOT_OPS_INERT` was deliberately empty, with a comment saying the two
offenders the #3966 sweep found were *repaired* rather than waived because
waiving was the cheaper option. This entry is a different case and the map now
says so: those two were round trips over projected state, so a snapshot-moving
op sequence existed and they were rewritten to use it. Here repairing is
impossible, not merely harder, and the claim lives in `expected_ops` (the
returned row, four validation refusals, one NotFound) and `expected_queries`
(the registry read back) — neither of which that guard inspects.

## Falsification

The fixture passed the mock leg on its first run, which proves nothing on its
own: the mock's validation landed in the same change. Four mutants, each
against a copy, each restored and `cmp`-verified:

| mutant | result |
|---|---|
| drop the `validatePropertyDefShape` call | killed — 3 legs red |
| drop the INSERT OR IGNORE early return | killed — 3 legs red |
| drop the select-type-only guard on update | killed — 3 legs red |
| drop the empty-array check on update | killed — 3 legs red |

Each kills all three legs rather than one, because a refusal the fixture did not
declare fails `check_declaration` before the snapshot comparison runs.

## A unit test that encoded the wrong precedence

The pre-push run failed on a test I had not touched.
`tauri-mock.test.ts`'s "update_property_def_options throws for non-existent
key" passed `options: '[]'` with an unknown key and expected the NotFound. On
the real backend that call is a **validation** refusal: `Vec<String>` is parsed
and the empty case rejected before the transaction opens, so the key is never
looked up. The test was green only because the mock had no parse step at all —
it reached the lookup, which the backend never does.

Its #2463 comment says the message "now mirrors `update_property_def_options_inner`'s
NotFound text", so the intent was always to pin the NotFound arm; `'[]'` was an
arbitrary throwaway argument that happened to select a different arm on the
other stack. It now passes `'["a"]'`, which reaches the lookup on both, and the
two arms are pinned separately with backend-authored answers in the fixture
(`update_options_empty_rejects` → validation, `update_options_unknown_key_rejects`
→ not_found). Falsified after the repair: stub the NotFound out and it still
reddens.

This is the second-implementation problem in miniature. A hand-written mock test
can assert an ordering the backend does not have, and stay green forever,
because nothing differences the two. That is what the fixture is for.

## Not pinned

- **`conflicting_existing_values`** (#4399) — the probe that refuses a
  declaration which would orphan `block_properties` rows already stored under
  that key. The mock has no equivalent; the seed deliberately declares no such
  row, so the fixture says nothing about it either way.
- **`delete_property_def`** stays waived. It returns `Result<(), AppError>`, and
  `RETURN_SHAPE` assumes an id-bearing response on both stacks, so it needs a
  unit-return shape first. That shape is the cheapest next slice: it also
  unblocks `delete_attachment`, `rename_attachment` and `set_reminder_settings`,
  whose tables and readers are already on both runners.

Ratchet: `NOT_YET_PINNED_MUTATING` 40 → 38.
