# Session 1801 — jex-import mutation survivors, third pass (#4816)

The issue body as re-rendered on 2026-09-21 listed 43 survivors (48 raw,
before dedup by location and mutator) and 2 no-coverage lines in
`src/lib/jex-import.ts`, after #4843 and #4921. This pass kills 11 and
records the 37 that remain, with reasons a reader can re-derive.

**What the three new tests pin.** A USTAR size field is octal digits inside
12 bytes padded with NULs or spaces; a pad byte folded into the number makes
`parseInt` stop early and a member silently yields no bytes (six mutants at
line 118). A `resources/.png` member carries no id any `:/<32-hex>` ref can
reach, so without the empty-id guard it squats the vault path `.png` and the
real resource is pushed aside (two at 389). A tag or note-tag link carries a
title line too; only a `type_: 4` item may name a resource's file (three at
433). Each falsified against a copy with the mutant applied by hand, and the
module itself is byte-identical to `main`: no mutant proved a branch dead.

**Two of the three are judgement calls, said plainly.** The 389 and 433
shapes are archives Joplin cannot emit (a nameless binary colliding with a
`.png`-titled resource; a tag sharing a resource's id). The tests stay
because the guards they cover are real classification and naming rules and
the mutants were demonstrably killable, which is the parent issue's bar.

**What the review corrected.** The builder's rewritten ACCEPTED-GAPS header
carried four claims that did not survive re-checking: "every `id.length > 0`
site is never looked up" while the diff's own test kills the one in
`splitMembers` (the line is that `resourceBinaries` is iterated, the other
maps are read by 32-hex key); `mimeToExt`'s `?? ''` called unreachable when
Stryker covers it and it survives only because any over-long subtype ends at
`bin`; the `readTar` bullet quoting the comparison mutant when the survivor is
`offset + BLOCK` → `offset - BLOCK` (the comparison is already pinned by the
last-block test); and the empty-name guard's true reason lost in the rewrite.
A paragraph narrating a differential harness nobody can re-run was deleted,
and one assertion that killed nothing (Stryker on lines 291–400 gives the
identical survivor set without it) went with it. Survivors orphaned by the
rewrite (118:9, 307:51, 239's blank check) now each map onto one of the seven
shapes.

**Verified.** Stryker over the whole module in four line-range chunks: 37
survivors (0 / 4 / 14 / 10 / 9 by range) plus 2 no-coverage `?? ''`
operands, from 48 + 2 before. Full frontend suite in two shards: 837 files,
19,268 passed, 51 skipped, 1 expected fail, 0 failures. `oxlint`, `oxfmt` and
`tsc -b` clean.
