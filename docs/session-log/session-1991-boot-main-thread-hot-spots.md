# Session 1991 — boot main-thread hot spots, first pass

Set out to take the cheap items from #5440 off the journal's boot path. A
builder died mid-work; a continuation agent reviewed its diff, finished it and
verified it.

Shipped: `formatDateDisplay` caches one `Intl.DateTimeFormat` per locale
instead of building one through `toLocaleDateString` per call; `JournalPage`
builds the daily entry once per render and `JournalControls` the date label
once; i18next runs with `keySeparator: false` because every catalog is flat;
`DailyView` skips the fade only for the first day it shows.

Traps: the inherited diff carried a window-title change that belongs to
#5442, removed here. Its first `DailyView` version remembered the first day
forever, so returning to it never faded; the test now covers that return.
`keySeparator: false` changes speed only, so no test can redden its removal.

Not done: the tailwind-merge config and the mount-time layout reads, and the
4x-throttled profile the issue asks for, so no boot-time gain is claimed.
Suites run: full vitest, typecheck, lint.
