# Session 1939 — Issue grooming, camera root cause, model tiers for the 5.5 lineup

The maintainer filed 27 one- or two-line issues (#5353–#5379) and asked for them to be fleshed out. The seven already claimed (#5353, #5355, #5356, #5358, #5367, #5374 with open PRs or `in-progress`, and #5357, superseded by #5373) were left alone. The other twenty (#5354, #5359–#5366, #5368–#5373, #5375–#5379) now carry the problem, verified `file:line` pointers, the smallest change that reuses existing code, acceptance tests, and a **Decisions** block at the top recording the maintainer's calls. Research ran in six parallel read-only agents; their load-bearing claims were spot-checked against the code before posting, and one wrong line (what `anchor_free` does, #5363) was corrected after posting.

Decisions the maintainer pushed further than the first draft: #5371 moves every Pages sort into SQL, with a precomputed Unicode `title_sort_key`, a subtree-aware `pages_cache.last_edited_ms` and a device-local `page_opens` table; #5362's "default" is an "Open on launch" space setting; #5375 renders readable names everywhere while keeping each block's `^ID`; aliases become ops, filed as #5387 (`AddPageAlias` / `RemovePageAlias` mirroring tags, a Loro root, an engine format bump and a one-time backfill), which #5378's alias tool now depends on.

#5386 (camera dead on Linux and Android) was filed and root-caused by reproduction, not reading:

- In Chromium with a fake camera against the mock backend, *Scan QR code* replaces Settings with "An unexpected error occurred". html5-qrcode's `start()` empties the `<section>` React renders into (`innerHTML = ""`), React's commit then fails `removeChild`, and the unmount cleanup's `stop()` throws a bare string, which the boundary shows as its fallback. With the library given its own empty `w-full` container, the same run shows a live preview. A first attempt with an `absolute inset-0` container rendered a 0px video, because html5-qrcode forces `position: relative` and sizes the video from the container's width; that constraint is in the issue.
- A PyGObject probe of WebKitGTK 2.52.6 configured as wry 0.57 does it showed `getUserMedia` rejected with `NotAllowedError` until a `permission-request` handler allows `UserMediaPermissionRequest`, after which a mock camera delivered 640×480 video. This corrects this session's own first draft of #5386, which blamed `enable-media-stream`: it is on by default in 2.52.

`.claude/skills/batch-issues/SKILL.md` § Model selection now picks a model *and* an effort per role, each a point on the Pareto frontier of Artificial Analysis's Intelligence Index (v4.3.2) against cost per task for Anthropic models, read on 2026-10-08:
- **The frontier** is Haiku 5.5 at every effort ($0.02–$0.21, 29–43), Sonnet 5.5 `high` ($0.88, 47), then Opus 5.5 `medium` · `high` · `xhigh` · `max` ($1.34–$5.98, 51–58).
- **Fable 5.1 is dominated** at every effort, so it no longer builds.
- **The new table:**
  - discovery: Haiku `high`;
  - mechanical: Sonnet `high`;
  - typical: Opus `high`, the knee;
  - high risk: Opus `xhigh`, reviewed by Sonnet `max`, a second model that is Anthropic's best on Terminal-Bench 4.0 (63.6% against Opus 5.5's 59.6%).
- **Escalation** steps up the frontier and ends at Opus `max`.
- **DeepSWE** (v1.1, no 5.5 rows yet) corroborates the knee on long-horizon coding: Opus 5 is flat from `high` to `max` within error (72.8–73.7%) and drops at `medium` (68.9%) and `low` (58.1%), and Opus 5 beats Fable 5 at every effort for less.

Verified: no product code changed; the scanner file patched for the reproduction was restored from a backup and `cmp`-checked, and `git diff` was clean before the skill edit. No suites were run for this docs-only change.
