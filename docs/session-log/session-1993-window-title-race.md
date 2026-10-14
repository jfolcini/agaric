# Session 1993 — window title race at boot

Boot writes the bare "Agaric" title and then the full one as the spaces load;
both IPC writes were in flight at once and the last to land won (#5442).

Each title write now chains on the previous one, so they reach the window in
the order the effect issued them. `setWindowTitle` already logs and swallows
its own failures, so the chain cannot break on a rejection. The issue's other
option, dropping the bare write, would leave a stale title when the active
space disappears.

The patch was cut out of the #5440 worktree, where a dead builder had mixed it
in. The new test holds each write open and lands the newest first; reverting
the hook turns it red on the final title. Suites run: the hook's vitest file,
typecheck, lint.
