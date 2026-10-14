# Session 2024 — Fix main: react/purity in the voice-note recorder

The oxlint bump in #5510 landed after #5484's last CI run. Once both were on
main, `react/purity` flagged the `new Date()` that stamps a recording's start
in `VoiceNoteDialog`, and `lint` went red on main.

The call runs in `beginSession`, which only the Record click reaches, so it is
not render-time impurity. A one-line `oxlint-disable-next-line` with that
reason covers it, following the `BootGate` precedent, rather than restructuring
the recorder around a rule that cannot see the call site.

Suites run: `npm run lint`.
