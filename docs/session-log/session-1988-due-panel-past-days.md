# Session 1988 — past days' Due panel reads a 90-day cache (#5421)

The Due panel on any past journal day expanded every repeating block on the
fly: `list_projected_agenda` routed every range starting before today to
`list_projected_agenda_on_the_fly`, on the async worker. Scrolling back
through the journal paid it for every day.

What shipped:

- The projected-agenda rebuild (`agaric-store/src/cache/projected_agenda.rs`)
  also writes every occurrence from 90 days before its reference date up to
  yesterday (`BACKWARD_WINDOW_DAYS`), then the existing forward pass.
- `list_projected_agenda` (`commands/agenda.rs`) serves a range from the
  cache when it starts on or after the stored rebuild date minus 90 days
  (the rebuild date, not today, so the window written is the one served
  until the midnight rebuild slides it). Older ranges keep the on-the-fly
  projector, now inside `spawn_blocking`.
- The reconciliation oracle rebuilds with the same two passes.
- `list_projected_agenda_past_day_100000` joins `interactive_slo`.

Measured (100K tier, one day 10 days back, release-test profile, loaded
box): on-the-fly 540 ms → cache 1.51 ms.

Known gap: a cache row written by an older binary claims a backward window it
never wrote, so past days can show an empty Due panel for the seconds after
an upgrade until the boot rebuild replaces it (code comment).

Verified: floor at today, one day early, anchored on today, rebuild window a
day short, oracle window a day long — each red on a copy, restored and
`cmp`-checked. Full `cargo nextest run --workspace` 6,742 passed, one load
timeout (`conformance_fixtures_match_backend`) passed alone in 30.7 s;
clippy, offline sqlx check and fmt clean. The week-open fan-out part of the
issue stays measure-first.
