# Session 2779 — Lessons from 2253–2771 into the AGENTS files; 2201–2700 archived

The maintainer asked for the session logs since the last fold (#5661, which mined up to 2252 and archived 2101–2200) to be read, their lessons put in the AGENTS files briefly, and the logs archived a hundred at a time.

Four readers took 2253–2400, 2401–2500, 2501–2600 and 2601–2771, each reading every log in full and proposing only lessons still true of the code and not already written down. A fifth agent merged their lists, dropped what was covered, one-off or speculative, and wrote the rest into the nested AGENTS files and the batch-issues skill, each as a rule and its reason. Three themes came from two ranges each and became one rule each: TipTap's equal-priority extension order, the `rust-cache` key and CI console quietness, and the React Compiler being off under vitest. Root `AGENTS.md` gained one clause on the 44 px line, since touch-only layout keyed on width alone is a rule for every component. The skill drops the "flake list" several logs sent flakes to: no such list exists.

Two findings were left as code, not doc: `sync_import_bench` and `interactive_slo` assert `iters > 0` from the outer bench body, so a name-filtered local run panics on the first case it skips (CI runs them unfiltered); and `validate-all` treats a missing classifier output as "not true", the fail-open shape that session 2254 fixed in `e2e-tauri-gate` only.

The fold is the README's: sessions 2201–2700 moved into `sessions-2201-2300.md` … `sessions-2601-2700.md`, headings demoted one level, newest first, a split number's later letter first. Every archive's "Sessions above" line and the README's archive list moved to 2700 together. No file outside the folder linked to a folded log. 2701 onward stays as individual files.

Checks run: `prek run --files` on every edited AGENTS and skill file; a line-count comparison of the folded logs against the new archives; the session-log guards on the commit.
