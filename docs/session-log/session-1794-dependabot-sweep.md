# Session 1794 — twelve Dependabot PRs, four real blockers

Dependabot opened twelve PRs overnight. Seven were green and touched disjoint
files, so they merged as they stood. The other five each failed for a different
reason, and four of those reasons were the repo's own guards doing their job.

**The fuzz lock (#5119).** Bumping `iroh-base` and `iroh-dns` changes a
requirement in `src-tauri/**/Cargo.toml`, which invalidates `src-tauri/fuzz/Cargo.lock`
even though the PR never touches that crate. `verify-lockfiles` and `lint` both
red on it; `cargo metadata` in the fuzz workspace is the whole fix. Dependabot
cannot know this — the coupling is documented in AGENTS.md and nowhere a bot
reads.

**React closed a gap we had pinned open (#5117).** `effect-event-fiber-tags.test.tsx`
asserted that `useEffectEvent` does *not* republish under `memo(Fn)` or
`forwardRef(Fn)`, and said in its own header that a React upgrade fixing it
should fail here. React 19.3 fixed it; the test failed exactly as designed. The
four fiber tags are still the whole decision surface, so they stay pinned — now
asserting that all four republish, which reddens on a regression or a downgrade.
The companion guard `effect-event-fiber-owner.test.ts` and the `useLayoutEffect`
mirror in `DaySection` are no longer load-bearing; retiring them is a deliberate
change, not a side effect of a version bump.

**The bundle budget caught a real cost (#5117).** React 19.3 grows `react-vendor`
from 78,396 to 86,977 B gzip — measured both ways on the branch, with
`react-dom`'s tarball confirming it at 7.32 → 8.06 MB unpacked. That is +10.9%
on an always-loaded chunk, through the 10% headroom, from a minor release. The
gate is right to stop it; the maintainer accepted the cost, so only
`react-vendor` moves to measured + the same 10% every other entry carries. The
other chunks keep their tighter ratchets.

**A license the project cannot take (#5125).** mermaid 12 makes `elkjs@0.9.3` a
hard runtime dependency under EPL-2.0. This repo is GPL-3.0-or-later and EPL-2.0
is GPL-incompatible, so the allowlist in `prek.toml` is not a knob to turn here —
there is no version of adding it that is legitimate. #5125 stays open and red.

**oxfmt 0.68 (#5120)** was the only ordinary one: a new formatter collapses
`a && b && (` guards and moves a `function (this: T)` parameter list onto the
call. Five files, cosmetic.

The three npm PRs all touch `package-lock.json`, so they merged serially with a
rebase between each — a green measured against a superseded base is not a green.
Eleven of twelve landed; main completed full CI on each merge.
