# Session 1311

## The bug report was wrong, and the fix introduced a worse one

#3883 said `scripts/push.sh` exits 0 when it refuses to push, so automation reads a
refusal as success. I filed it. It is not true.

### What was actually true

All three transcripts in the issue were re-run as real subprocess invocations against
`push.sh` exactly as it stands on `main`. Every one exits **1**. The exit-code half had
been fixed incidentally by `a650ab4de` (#3724, "make four guards fail on the thing they
were guarding") on 2026-08-09 — five days before the issue was filed. The message text
quoted in the report was itself introduced by that same commit, which dates the checkout
being read.

So the severity was wrong: automation was never reading a refusal as success. The cost was
misdirected debugging, not silent data loss.

One real bug survived the correction. Instance 3 reproduces: a **local** pre-push hook
rejection is reported as `PUSH FAILED on the wire`, sending the reader to look at their
network when the answer is clippy. And instance 1 had a genuine gap even with a correct
exit code — a preflight refusal was indistinguishable from a push failure, so preflight now
exits **2** and reserves **1** for verify/push/postcondition failures.

### The fix made one case worse

`classify_push_failure` gained a heuristic: no `remote:`-prefixed line alongside git's
generic `error: failed to push some refs` ⇒ local rejection. Review built a real bare repo
with a real `pre-receive` hook that declines while printing nothing, and got:

```
 ! [remote rejected] HEAD -> main (pre-receive hook declined)
error: failed to push some refs to '.../bare2'
--> classify_push_failure: local-rejection      # WRONG
```

There is no `remote:` line because the hook printed nothing. The **old** code classified
this as `remote` — correctly. So the fix regressed a case that already worked, and the new
message asserts "GitHub never rejected this" while GitHub is precisely what rejected it.
This is not exotic: branch-protection and required-status-check declines present exactly
this way.

The fix: check git's own `[remote rejected]` marker first. Git emits it whenever the far
side declined the ref, printed output or not, so it is a reliable signal in a way that
absence-of-a-prefix is not. The heuristic now runs only when that marker is absent.

Also: a self-test case for exactly this transcript (40/40, was 39/39). Its absence is what
let the regression through — the existing cases covered hook-rejection-without-`remote:`
and branch-protection-with-`remote:`, but not silent-remote-decline, which is the
intersection that breaks the rule.

And the message no longer states its inference as fact. The heuristic is syntactic; a
local hook that happened to print a `remote:`-prefixed line would flip it. Wording now
says "most likely" and names itself a heuristic.

### Two lessons, both about evidence

The report was written from a stale worktree and asserted a behaviour nobody re-ran. The
fix was written from real transcripts but tested against hand-written fixtures for the one
case that mattered, and a real repo disproved it in one run.

Same failure both times: a claim about what a program does, made without running the
program in the state being claimed.

### #3905

`scripts/` now has a tsconfig project, referenced from the root config. Zero type errors
surfaced — the files the issue cited were already fixed by #3804/#3906.

"Zero errors" from a new checker is indistinguishable from a checker that checks nothing,
which is the exact bug #3905 is about. So it was proven non-vacuous: a deliberate type
error injected under `scripts/`, caches cleared, `npm run typecheck` fails with `TS2322`,
error reverted. The project is genuinely in the `tsc -b` graph.

One orphan found while enumerating every `.ts`/`.tsx` against all five projects:
`useStarredPages.test.tsx` is silently dropped because a `.ts` sibling shares its base
name — a reproducible `tsc` include-glob quirk. Filed as #3912, not fixed here.
