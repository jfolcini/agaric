# Session 1325

## A guard that passed for the wrong reason

Two ways the conformance ratchet could be green while proving nothing. #3928: the `get_block`
step drove the *permissive* reader while the shipped command calls the strict one. #3893: no
step could compare cursor bytes cross-stack, so a Rust cursor-format change would land unseen.

Both were real. Both fixes were then found to have their own version of the same problem.

### The harness certified a path production does not take

`get_block` delegates to `get_active_block_inner` — `WHERE id = ? AND deleted_at IS NULL`,
so `NotFound` for a tombstone. The harness arm called `get_block_inner`, the permissive one,
and the step was *named* `get_block_serves_tombstone` with a comment claiming to pin which of
the two the command uses. The mock matched the harness. Both stacks agreed, on the opposite of
production.

The production Rust was already right; nothing about the shipped command changed. What changed
is that the harness now drives it, and that `run_step` returns a `Result` so `run_query_steps`
can record an `AppErrorKind`. **A refusal is an answer** — that was the missing capability, and
without it a command whose correct behaviour is "refuse" cannot be pinned at all.

Eight tests were reading `deleted_at` off `get_block`, i.e. asserting something the app cannot
do. They moved to `get_blocks`, which is genuinely permissive on both stacks — verified, not
assumed, since fixing one and breaking the other would have been the easy mistake.

### The acceptance criterion could not be met, and saying so was the right answer

The natural criterion is "make the delegation edit redden a fixture". It cannot. Every harness
arm calls an `*_inner` directly, because a `#[tauri::command]` needs `State<'_, ReadPool>` and
that is unconstructible in a test. Pointing production `get_block` back at `get_block_inner`
leaves `conformance_fixtures_match_backend` **passing**.

That source-level coupling is precisely what drifted, so the substitute is a source scan pinning
both directions. Reporting the criterion as unmeetable — rather than quietly adopting a weaker
one and calling it done — is what made the substitute legible as a substitute.

### The guard against invisible coverage had invisible coverage

The scan read from the arm to the first column-0 `}`. For a `match` arm that is the end of
`run_step`: **165 lines spanning ten arms.** So pointing `get_block`'s arm at a third reader
while any *later* arm happened to mention `get_active_block_inner` left the guard green on a
real drift. Demonstrated, not theorised.

It now takes an indentation-aware terminator and scans 24 lines, with a labelled tripwire if the
scope ever widens again. Third time in this programme that the change written to remove a defect
contained it.

### Rejecting the obvious answer for #3893

The issue suggested comparing cursor bytes. That is wrong, and the code proves it: the mock's
`NULL_POSITION_SENTINEL` is `Number.MAX_SAFE_INTEGER` against the backend's `i64::MAX`. Both
paginate correctly; a byte assertion false-reddens.

The property pinned instead: for every step that mints a `next_cursor`, both stacks' cursors
decode as strict URL-safe unpadded base64 of UTF-8 JSON, carry the same schema `version`, and
describe the same keyset *shape* — ordered `t` tags for the engine tuple, sorted populated slots
for `pagination::Cursor`. Values erased; the concrete boundary values are already pinned by the
resumed page's rows.

It also turned out `#3863` stayed green for a duller reason than anyone had proposed: **no
fixture paginated `run_advanced_query` at all**, because `cursor_path` omitted it. Reverting that
one line makes pages 1, 2 and 3 all return page 1.

### The sharpest claim was the false one

The builder's most quotable finding was that `list_by_type`'s 48-byte payload encodes identically
under both base64 alphabets, so *only* the shape check catches the mock's standard-alphabet
cursor, while `list_children`'s 50-byte payload pads and is caught by the alphabet. Two halves,
each load-bearing, each catching a different branch. Very tidy.

The review instrumented the pre-fix encoder and dumped every cursor the fixtures actually mint.
A seed label expands to a 26-character id, so the real payloads are 50 and 52 bytes — **all six
are padded**, and the alphabet half catches every one. The unit test asserting the tidy story
hard-coded a 24-character id the mock never produces, so it passed while describing a payload
that does not occur.

The shape half is still needed — a three-digit position gives a 54-byte payload, a multiple of
three, which encodes with no `+`, `/` or `=` at all. But that is a different argument, and it was
not the one made. A test can be green, and its stated reason fabricated, and both facts can
matter separately.

### What the property still would not catch

Recorded because a coverage claim without its complement is half a claim: renaming
`CursorValue`'s serde `content` key turns every payload into `{"t":"Int","val":3}` while the
projection reads only `t`, so both stacks still render `v1:[Int,Text]` and every fixture stays
green — though nothing minted by the old version decodes. Same class: a value's semantics
changing under a preserved tag. And a *coordinated* alphabet swap in both `engine.rs` and the
Rust twin, which shares production's base64 engine constant.

One gap of that family was closed during review: the tuple branch discarded every top-level key
but `version` and `values`, so `QueryCursor` growing a field was invisible — asymmetric with the
pagination branch, which did not have that hole. Both twins now render a `+{…}` suffix, with zero
fixture churn because the set is empty today.

### Two honest negatives, one labelled and one not

The liveness guard's `error !== null` clause is not load-bearing: `get_block` stays live via its
populated sibling, so deleting the clause leaves every ratchet green. It is kept — a refusal-only
command would otherwise get a *wrong* verdict rather than a missing one — and labelled as such.

Its sibling `misdeclaredRefusal` is equally non-load-bearing and was **not** labelled, in the same
file, by the same change. Now it is. The two together are a small lesson about consistency: the
first was declared because someone thought about it, and the second was not because nobody did.
