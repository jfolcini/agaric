# Session 1995 — History view walks the op-log index instead of scanning it

Set out to stop the global History view from scanning and sorting the whole op
log on every page (#5424). A builder died mid-work; a continuation agent
reviewed its diff, finished it and verified it.

Shipped: the global query is two static statements, a first page and a cursor
page with a row-value keyset `(created_at, seq, device_id) < (?, ?, ?)`, both
walking `idx_op_log_created` newest-first; the space filter is a correlated
`EXISTS` instead of an `IN` list of every block in the space. The old query is
a test-only oracle, compared page by page over a seeded walk; a plan test pins
the index walk and the absence of a list subquery.

Traps: every keyset column is `NOT NULL`, which is what makes the row-value
comparison equal to the old OR-chain. Rows sharing a `created_at` still sort
in a small temp B-tree because the index covers `created_at` only; removing it
needs a composite index, which is a migration. Putting the OR-chain back in
production SQL breaks the build on sqlx nullability, so that falsification ran
against the plan test's copy.

Not done: the bench numbers the issue asks for; the new `list_global_history`
Criterion group needs the scheduled bench lane. Suites run: targeted nextest
over history, pagination and space-filter tests, clippy, offline check, the
bench in test mode.
