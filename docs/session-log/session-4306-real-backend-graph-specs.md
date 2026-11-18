# Session 4306 — four graph spec files join the real-backend project

Stage 2 of #6529, the `@graph` area. The five files tagged `@graph` were tried on a locally built `bridge`, and 39 of 40 tests passed. Four join `REAL_BACKEND_SPECS`: `graph-happy-paths`, `graph-restore`, `graph-view` and `pages-header-routes`. They passed 3 times out of 3 on the bridge (105 tests) and pass on the mock.

`phone-views` (tagged `@mobile`, `@pages`, `@journal` and `@graph`) stays off the list:

- **History's touch pill** failed: it measured the newest History entry's Diff button. On the real backend the seed's newest op is a property write, which has no diff. Fixed in the spec: it first makes an edit through `edit_block`, so the newest entry is an edit on both backends.
- **The capture button** then failed 1 run in 6 on the bridge, and passed 8 of 8 on the mock. The failing step is the spec's own absence check: after Back restores the Pages scroll position, it waits a fixed second and expects the button still shown. Under the real backend's latency the restore can land later and read as a scroll down. Whether that is an app bug (the button hiding after Back) or only the check's timing is not established, so the file waits rather than join a flaky test.

Ran: the four joining files on the bridge (3 × 35 passed) and on the mock; `phone-views` on both.
