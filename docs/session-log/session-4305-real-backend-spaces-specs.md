# Session 4305 — four spaces spec files join the real-backend project

Stage 2 of #6529, the `@spaces` area. All ten files tagged `@spaces` were tried on a locally built `bridge`: 51 of 71 tests passed. Four files pass whole and join `REAL_BACKEND_SPECS` with no spec change: `space-move-property-loss`, `spaces-coverage`, `spaces-happy-paths` and `tooltip-pointer-events`.

The other six stay off the list for now. Their 20 failures come from three causes, none of them a backend bug found so far:

- **The two vaults start with different spaces.** The backend's first boot makes Personal and Work; the mock seeds only Personal, plus Work behind the `__mockWorkSpace` opt-in. Specs that create a space named "Work" (`spaces-management`, `deep-link`, `delete-page-tabs`, `tags-lifecycle`) get two "Work" spaces on the bridge, and every `Work` locator fails strict mode. Which side should change is a maintainer decision, now asked on #6529: have the bridge template drop Work, seed Work in the mock by default, or have specs create spaces under names neither vault seeds.
- **`import-export`** (an `@markdown` file as much as an `@spaces` one): a call to `import_markdown` without the `dialect` argument, which the real command requires and the mock ignores; export output that differs from the mock's (link and tag tokens, warning and property counts); and the whole-vault restore. It is left for the `@markdown` area.
- **`properties-system`** (`@settings`): the usage-count test logs a console error on the bridge and is left for the `@settings` area.

Ran: the four joining files on the bridge (11 passed) and on the mock (11 passed).
