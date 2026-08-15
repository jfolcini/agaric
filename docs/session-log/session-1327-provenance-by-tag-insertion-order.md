# Session 1327

## Provenance by tag-insertion order

#3925 was filed as a latent risk: `recompute_subtree_inheritance` step 3 has no nearest-ancestor
ranking, and "the two paths agree today only because SQLite's recursive-CTE queue happens to emit
ancestors nearest-first". A dependency on unspecified behaviour, worth removing before it bites.

They do not agree today. With two tagging ancestors above the subtree — `TOP[#T] > MID[#T]` —
step 3 attributes to the **furthest** one. Probed against unmodified `main`:

```
incremental = [("LFX","TAGX","TOPX"), ("MIDX","TAGX","TOPX"), ("RTX","TAGX","TOPX")]
    rebuilt = [("LFX","TAGX","MIDX"), ("MIDX","TAGX","TOPX"), ("RTX","TAGX","MIDX")]
```

The queue argument does not save it because `ancestor_tags` is a **join**, and the planner drives
it from `block_tags` rather than from the `ancestors` CTE — so the CTE's emission order is gone
before `INSERT OR IGNORE` ever sees a row.

### The probe that made it worse

The review did not stop at reproducing. It re-ran the same fixture with only the two
`INSERT INTO block_tags` statements swapped:

```
incremental = [("LFX","TAGX","MIDX"), ("MIDX","TAGX","TOPX"), ("RTX","TAGX","MIDX")]
    rebuilt = [("LFX","TAGX","MIDX"), ("MIDX","TAGX","TOPX"), ("RTX","TAGX","MIDX")]
    AGREE   = true
```

Attribution follows `block_tags` rowid order. So provenance has not been merely wrong — it has been
a function of the order the user happened to apply their tags, healed only incidentally by the next
whole-vault rebuild.

That is a different claim from the one in the issue, and it is the one worth writing down. A latent
risk gets scheduled; a live bug whose output depends on insertion order gets fixed now.

### The mirror of #3919, decided by the same question

#3926 is the deleted-**ancestor** direction: the walk climbed past soft-deleted intermediates while
its authority, `tag_inh_descendant_tags_full!`, filters `deleted_at IS NULL` on the tagger and on
every descendant step.

#3919 — merged hours earlier — removed a filter from a descendant walk. This adds one to an ancestor
walk. Opposite edits, one rule: **which behaviour does the full rebuild define, and does the
incremental path claim to match it?** There the walk had a filter its authorities lacked; here it
lacks one its authority has.

A stronger local argument turned up that nobody had gone looking for: `recompute_subtree_inheritance`
**already contradicted itself**. Its subtree walk stops at a deleted intermediate —
`recompute_subtree_skips_deleted` has asserted exactly that for as long as it has existed — yet
recomputing the same fixture from below gave the opposite answer. The function disagreed with itself
depending on where you started it, and a test had been pinning one half of the disagreement.

The `remove_inherited_tag` case matters most, because RemoveTag's fan-out carries no rebuild backstop:

```
canonical   = [("KDZ","TRZ","PRZ")]
incremental = [("KDZ","TRZ","GRZ"), ("PRZ","TRZ","GRZ")]
    rebuilt = []
```

Two rows resurrected from a tagger unreachable behind a tombstone, **durably**. `severity:low` on
that path is understated.

### The half-covered pair, and an honest limit

Step 2 (`tagged_descendants`) has the identical unranked shape and was fixed too — fixing one and
leaving the other is exactly the half-covered pair this project keeps rejecting.

But step 2's test can only claim so much, and the code now says so rather than leaving the caveat in
a PR body. It reddens on `MIN`→`MAX`, so it pins the ranking *rule*. It does **not** redden if the
collapse is deleted outright, and no fixture can make it: `tagged_descendants`' depth is
distance-to-tagger, SQLite's recursive-CTE queue is FIFO absent an `ORDER BY`, and step 2's consumer
is a bare scan of the materialised CTE — unlike step 3, where the join let the planner reorder. So
emission is non-decreasing in depth and `INSERT OR IGNORE` already keeps the MIN-depth row.

The precise claim is therefore "the SQL now says what it means", enforced by the MIN/MAX test plus a
drift guard tying step 2's collapse to the arbiter's — not "a regression test now exists for
un-ranking it". Mutation confirmed it: deleting the collapse leaves the whole suite green.

### The reachability argument that was not true

The builder flagged a third direction out of scope — `tag_inh_subtree_active!` seeds the root with no
`deleted_at` check, so recomputing on a tombstone inserts rows `rebuild_all` refuses — and justified
leaving it with "every production caller passes a live root".

The review checked. The **local command** path guards; the **remote apply path does not**.
`OpType::MoveBlock` reaches `apply_move_block_via_loro` with no `deleted_at` guard,
`project_move_block_to_sql` has no filter, and both apply paths then call
`recompute_subtree_inheritance` unconditionally. Concurrent delete-on-A / move-on-B reaches it.

Filed as #3944 with the apply path as the reachability proof, rather than shipped as a sentence
asserting the opposite. Scoping something out is fine; the *reason* given for scoping it out is a
claim like any other, and this one was wrong.

### One thing that is safe, by a non-obvious argument

`remove_inherited_tag` step 2's hand-written `anc` CTE is not covered by the macro fix and still has
no `deleted_at` filter. It is safe — `taggers ⊆ descendants`, and `descendants` admits a block only
through an all-live chain from the root, so the parent-chain segment between any `descendants` member
and any `taggers` member is provably all-live, and the climb cannot cross a tombstone.

Recorded because the next reader will see an unfiltered walk next to three filtered ones and either
"fix" it or assume it was already handled. Neither is what happened.
