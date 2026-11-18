# Session 4270 — the phone Settings section picker flake

Found in #6878's flake hunt (session 4239). On a phone, `openSettingsTab` (`e2e/helpers.ts`) picks the Settings section from a Radix Select: it taps the trigger, then taps the option. The open list scrolls to line the chosen item up with the trigger, and under load the option tap is aimed while the list still moves, so it misses and leaves the list open on General. Every phone spec that opens a Settings section through the helper inherits it.

The helper now taps the trigger and presses Enter on the option, which needs no aim, then waits for the trigger to show the section. `settings-phone.spec.ts` still taps the option itself: that spec is about touch selection.

## What ran

- Red first: a spec that pairs a device, opens Settings › Sync & devices through the helper and waits for the device row, at the iPhone 13's 3× ratio with all four cores busy, 8 workers. The tapping helper failed 1 of 32 runs on this base, and 2 of 32 and 3 of 20 in session 4239; the screenshots show the list open on General. With the fix, 48 of 48, twice.
- Every phone spec that calls `openSettingsTab`: green, apart from `qr-scanner-camera.spec.ts`, whose browser cannot launch in this container.
