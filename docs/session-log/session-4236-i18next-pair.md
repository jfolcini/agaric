# Session 4236 — i18next 27 and react-i18next 18 move as one

Dependabot split the pair into #6867 (i18next 26.7.1 → 27.1.0) and #6868 (react-i18next 17.1.12 → 18.0.1). The two majors fell out of the npm `minor-and-patch` catch-all, and no other group matched them.

- **#6868 was red before any test ran.** react-i18next 18.0.1 peer-requires `i18next >= 27.0.1`, so `npm ci` failed with ERESOLVE in every job.
- **#6867 was green, with a non-blocking review note.** i18next 27 leaves `ReactOptions` empty for react-i18next ≥ 17.1.13 to fill in, so on 17.1.12 the `react` init options went unchecked by types.

This PR bumps both packages in one commit. It also adds an npm `i18next` group (`i18next`, `react-i18next`) with no `update-types`, so majors stay paired. The group has no security mirror because the peer is a `>=` range, not an exact pin.

The second note on #6868 was to check the `Trans` call sites, since v18 always decodes entities in `Trans` output. `SearchHelpDialog` is the only call site, and its `search.help.filter.intro` string contains no entities, so nothing changes. The other v27 breaking changes do not apply, for the reasons #6867's review lists: explicit `fallbackLng`, `keySeparator: false`, `escapeValue: false`, no `CustomTypeOptions`, no `''` catalog values, and no dotted `addResource` calls.

## What ran

- `npm run typecheck`: clean.
- `npx vitest run` over the i18n catalog tests, `SearchHelpDialog`, `useLanguage`, and every suite that calls `addResource` or `changeLanguage`: 45 files, 1165 tests, all passing.
