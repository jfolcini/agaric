# Session 1787 — review notes from #5106

The approving review on #5106 left three non-blocking notes. Per "Reviews
judge impact", none caused a push to the approved branch; this is the
follow-up.

- `perModule[].ok` in `scripts/check-mutation-reports.mjs` was written at
  three sites and read at none: the OK line prints module and mutant count
  only, and `analyzeReports` has no other consumer. Deleted.
- The widened `testNamePattern` selects a superset of the covering tests, so
  a mutant can be recorded killed by a test that does not cover it and the
  survivor counts in #5106's table are lower bounds. Already stated in the
  shim comment; nothing to change.
- A non-RegExp `testNamePattern` passes through the shim unwidened. If
  upstream ever switches to a string the shim stops working and guard (d)
  fails the sweep loudly, which is the right outcome; nothing to change.
