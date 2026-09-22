# Session 1799 — `dirs` goes, `std::env::home_dir` stays (#5060)

One direct dependency for one call site, and a claim to check before touching
it. The claim held, with one wrong name.

`std::env::home_dir` in the pinned 1.95 toolchain (read from `rust-src`, not
from memory) is `#[stable]` with no `#[deprecated]` attribute. On Unix it reads
`$HOME` when set and non-empty, else `getpwuid_r`. On Windows it reads
`USERPROFILE` when set and non-empty, else `GetUserProfileDirectoryW` — not
`SHGetKnownFolderPath`, which is what the issue and the old call-site comment
named, and which is in fact what `dirs` uses (`dirs-sys::known_folder_profile`,
with no `USERPROFILE` read at all). Same directory by either route; the comment
now names the API std actually calls. The pre-1.85 `$HOME`-on-Windows reading
that made `dirs` worth adding is gone, so `dirs` is gone: `src-tauri/Cargo.toml`
loses the line, `Cargo.lock` loses `dirs 7.0.0`, and the tree stops building
three majors of it (`tauri` and friends still pull 6.0.0 and 4.0.0).

The two old tests asserted `home_dir_string()` equals `dirs::home_dir()`,
which after the swap would have become `std::env::home_dir()` equals itself.
Replaced by one test on every platform that pins the function to the
platform's own variable (`USERPROFILE` on Windows, `$HOME` elsewhere), which
is the property the Windows leak was about. Falsified against a copy:
reading a variable that does not exist reddens it (`left: None, right:
Some("/root")`), restore verified with `cmp`. The Windows arm is compiled, not
run, on this box.

`src-tauri/fuzz/Cargo.lock` re-resolved with `cargo metadata`, per AGENTS.md
§ Coupled Dependency Updates, since removing a requirement invalidates it.
