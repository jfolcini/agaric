# Session 4326: a failure trace for the saved-views rename dialog

#6910's run 44306809918 failed in `e2e/advanced-query-saved-views.spec.ts`. The Rename click completed, but no dialog opened. 120 local runs did not reproduce it, and neither did a 30-run probe on CI (#6927, closed). Reading the code found no node that the click could have missed. The maintainer chose a permanent diagnostic, so the next failure names its own cause.

**Diagnostic:** an init script in the spec records each pointerdown, pointerup, click and focusin target, with a stable node id, and the mount and unmount of any dialog. It also records a marker at the Rename click. An `afterEach` attaches this trace to the report only when the test fails. Green runs print nothing. It is to be deleted once the flake is root-caused.

**Shown working:**
- With the Rename button's handler stubbed out, the test failed and the attached trace showed the click on the Rename button and no `dialog+` after it.
- On an unmutated app with a forced later failure, the trace showed the Rename dialog mounting 7 ms after the click.
- A green run attaches nothing.
