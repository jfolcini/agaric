# Session 4232 — the reopened mutation survivors

The weekly run reopened #3756, #3763, #3766 and #4651. Each survivor is now either killed by a test or recorded in `mutation-accepted.tsv` with its reason.

## What shipped

- **history-utils (#3756):** tests for `opTypeLabel` (a known type is labelled, an unknown one shows as itself and is logged), the `__all__` sentinel the backend reads, and `getPayloadDisplayContent` on a payload that is not JSON. The `content !== null` survivor is equivalent: `displayPageTitle(null)` returns null.
- **to-search-filter (#3763):** the three mutants on `case 'invalid'` are equivalent. The case only breaks and nothing follows the switch.
- **vault-import (#3766):** both survivors are equivalent. `holdsLogseqQuery` only skips reading the pick's tags, because `translateLogseqQueries` touches no line its pre-check misses. The default `keptQueries` is never read.
- **loro engine (#4651):** a unit test pins `PropertyValue::into_list_item` for every variant.

## What ran

- `node scripts/run-mutation.mjs history-utils to-search-filter vault-import`: every survivor left is accepted. A filer dry run over those reports finds 11 survivors and suppresses all 11.
- cargo-mutants is not installed here, so the Rust test was falsified by hand: `into_list_item` returning `None` reddens it on `left: None, right: Some(Text("a"))`.
