# Session 2051 — Ctrl+B sidebar test: settle focus before the chord

`keyboard-collisions.spec.ts` "focus outside the editor toggles the sidebar
visibility" failed on two PRs (#5532, #5535) that touch nothing near the
sidebar, both times with the sidebar still `expanded`, and passed on main and
locally.

The CI trace's last frame shows the Pages view's new-page input focused. On a
view change `App` moves focus to the view's registered primary element one
animation frame later, and the Pages view registers that input. Since #5525
the view can mount without suspending, so whether the input is registered
before that frame depends on whether the idle preload has finished, which is
timing. When it is, Ctrl+B reaches an input, and the sidebar shortcut leaves
inputs alone by design.

The test now lets that frame pass, puts focus on the Pages nav button, and
asserts it, so the chord always starts outside any input. Shown both ways:
forcing focus into the new-page input fails the old test exactly as CI did
and passes the new one.

Suites run: the spec, 5 repeats, plus the forced-focus checks on copies.
