# Session 1317

## An exemption is not a violation

#3860 added a guard: any i18n key interpolating `{{count}}` must carry plural forms. It
shipped with a 35-key allowlist so it could land without a repo-wide copy change, and
filed #3882 as "drain this". Draining it turned out to be the smaller half of the work.

### The allowlist could not tell two things apart

An entry meant one of two completely different things:

- *this key is broken and nobody has fixed it yet*, or
- *this key is fine, and the guard's heuristic does not apply to it*

Both looked identical. So the list could not shrink under pressure — you could not say
"the unfixed half must go to zero" without also forbidding legitimate exemptions, and you
could not audit it, because there was no way to see which entries had ever been thought
about.

Splitting it into `PRE_EXISTING_COUNT_NOT_YET_FIXED` and `PRE_EXISTING_COUNT_EXEMPT`
(every entry carrying a reason) makes the second question answerable and the first
enforceable. `NOT_YET_FIXED_CEILING = 0` now pins the unfixed half, which closes the ratchet
the issue worried about: nothing previously stopped someone silencing a new violation by
appending to the list.

That is the durable part. The 18 copy fixes will be forgotten; the fact that the list can
no longer grow will not.

### The triage was the work

18 of 35 needed real `_one`/`_other` forms. 17 did not, in four distinct ways:

- **9** already do a manual singular/plural split via a *separate catalog key* chosen by a
  call-site ternary. These read like violations from the key name alone and are not — each
  was checked against its component rather than pattern-matched.
- **2** have no inflecting noun in the text at all.
- **3** are abbreviated units (`5m ago`) that do not inflect in English.
- **3** interpolate a value that is *never rendered*: `compaction.totalOps` and
  `eligibleOps` are cut by `.split(':')[0]` at the call site, so the count reaches the
  string and then gets thrown away.

That last category is the one worth remembering. A guard that scans catalog text cannot see
what the call site does with the result, so "interpolates `{{count}}`" and "displays a
count" are different predicates, and only the first is checkable from the catalog.

### The blind spot, enumerated rather than assumed

The issue's caveat 1 asked whether a key interpolating some *other* variable, while being
called with i18next's `count` option, has the identical defect invisibly — and noted that
nobody had checked.

108 distinct keys are called with `count` across `src/`. All 108 either carry complete
plural forms or a bare form containing `{{count}}`. **0 have the defect.**

One apparent hit was a scanner artefact: `lightbox.counter` (`'{{current}} of {{total}}'`)
has a call site passing `total: count` — where `count` is a local variable's *value*, not
the options object's `count` key. Worth recording, because the next person to run this scan
will hit it too, and "one hit" and "zero hits" lead to very different conclusions.

The honest form of the answer is: zero today, by a scan that would catch it if it appeared.
Not: the defect is impossible.

### One test was pinning the bug

`App.test.tsx` had `'1 items in trash'` hardcoded — the ungrammatical string this change
fixes. It would have gone red on the fix and looked like a regression.

A test that asserts current output rather than intended behaviour turns every correction
into a failure. Worth noticing that it survived #3860's own pass, which is exactly the
window where someone is most likely to have looked at it.
