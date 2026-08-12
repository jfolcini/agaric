# Session 1293 — a typecheck that checked nothing (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 1 build |
| **Items closed** | `#3805` |
| **Items modified** | — |
| **Tests added** | 0 (frontend) / 0 (backend) |
| **Files touched** | 9 |

**Summary:** `npx tsc --noEmit` — the obvious local typecheck, and the one used throughout this cluster's agent prompts — type-checks nothing in this repo and always exits 0. Added `npm run typecheck` (`tsc -b --noEmit`) as the single definition, pointed the three existing copies of that invocation at it, and documented it in the four places someone would look.

**Files touched (this session):**
- `package.json`, `justfile` — the script and a `just typecheck` recipe
- `AGENTS.md`, `CONTRIBUTING.md` — the command and, more importantly, why not the bare form
- `tsconfig.json` — a `"//"` note where someone lands when a check comes back suspiciously empty
- `prek.toml`, `.github/workflows/_validate.yml`, `src-tauri/tauri.conf.json` — the three pre-existing copies of the invocation, now calling the script
- `docs/session-log/session-1293-a-typecheck-that-checked-nothing.md` (new)

**Verification:**
- With a deliberate `TS2322` in `src/`: `npm run typecheck` exits **1**, `npx tsc --noEmit` exits **0**. That contrast is the whole issue.
- The script was proved to fail on a deliberate error in **each of the four referenced projects** (`app`, `node`, `e2e`, `wdio`), each probe reverted. A typecheck script that silently misses a project is the same bug with a better name.
- No build artefacts: every project sets `tsBuildInfoFile` under `node_modules/.tmp/`, so the four `.tsbuildinfo` files land there, gitignored.
- `markdownlint-cli2`, link-target and doc-code-path checks, `typos`, `just --list`, and `package.json` JSON validity all pass.

**Process notes:**

**Why the root config makes the obvious command a lie.** `tsconfig.json` is solution-style: `{"files": [], "references": [...]}`. With no `include` and no files, the program is empty — and `--noEmit` does not follow project references; only `--build` does. So `tsc --noEmit` succeeds on nothing. It is not a command that reports nothing; it is a command that returns a *green result meaning nothing*, which is strictly worse.

**`main` was never at risk, and that is why it lasted.** `prek.toml` ran `npx tsc -b --noEmit` and CI ran `npx tsc -b` — both real. The damage was confined to local iteration: a contributor or agent iterating against the bare form gets false green, then meets the real failure at commit time, detached from the change that caused it. In this cluster it waved through a genuinely broken guard removal during #3787; the removal was only caught because a later step happened to run the project-scoped form.

**The chosen invocation is deliberately not the "cleanest" one.** `tsc -b --noEmit` was picked over explicit per-project `-p` calls precisely because it is *identical* to what the hook runs — a local green then predicts the gate, and the two cannot drift apart. It also walks `references`, so a fifth project is covered the day it is added. An explicit list would rot, and that rot is exactly the hole `tsconfig.e2e.json` (#3606) and `tsconfig.wdio.json` (#3664) were created to close; both carry notes saying a project outside `tsc -b` is a project nothing checks.

**Documentation placement was the substantive decision.** The command is in `AGENTS.md` and `CONTRIBUTING.md` where verification commands live, but the note that matters most is in `tsconfig.json` itself — because the person who needs it is the one staring at a suspiciously fast green check, and that is the file they open. Each place says *why not* the bare form, not just what to run: an instruction that says "use this" without "and not that" does not stop someone who has already typed the other thing.

**The PR argued against duplication while leaving three copies of it.** Review pointed out that CI, `prek.toml` and `tauri.conf.json` each re-spelled `tsc -b` rather than calling the new script — so "a local green means the gates will be green" was true only *coincidentally*, resting on all four projects happening to set `noEmit`. All three now invoke `npm run typecheck`, which makes the claim structural. The same anti-drift argument the change makes for preferring `tsc -b` over an explicit project list applies one level up, and the first draft did not apply it to itself. That is the identical shape as the four-copy reserved-key finding in #3797.

**A guard was considered and declined.** Intercepting `npx tsc` would need a shell shim or a fake `tsc` on `PATH`, and would obstruct the legitimate `tsc -p …` / `tsc -b` forms the repo uses in four scripts. The failure mode is a plausible command returning a lie, and the proportionate fix is discoverability, not enforcement. If it recurs, the next step is cheaper than a guard, and it is already taken: the note in the config file.
