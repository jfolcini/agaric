# Session 1301 — issue snapshots that had gone stale (2026-08-14)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-14 |
| **Subagents** | 4 build, 5 review/verify |
| **Items advanced** | `#3295`, `#3321`, `#3291`, `#3853`, `#3834`, `#3838`, `#3837` |
| **Items filed** | `#3859`, `#3860`, `#3863`, `#3864` |
| **PRs merged** | 8 |

**Summary:** The back half of the overnight batch, and a second theme on top of session 1300's: **a filed issue is a point-in-time observation, and three of tonight's had already drifted from the code.** In each case the builder checked before acting and the check changed the work. The corollary bit too — a claim written to *prevent* an action performed it.

**Process notes:**

**Three stale snapshots, three different consequences.** #3295 ("panic isolation is dead code") described counters that #3382 had already deleted; what survived was one vestigial field and the prose, so the fix was smaller than filed. #3321 (two store hot-path allocations) had had two of its three sub-fixes shipped by #3699 — and the maintainer's comment leaving it open cited a blocker that turned out to be a false dichotomy: targeting the *page* half of a preload does not require skipping the *tag* half, because the tag fetch is one round-trip either way while the page walk is `ceil(pages/100)`. #3853's own suggested fix ("prefer the interface carrying the default route") was wrong on the phone it was filed about, since a VPN's default route points away from the LAN. None of this is a criticism of the filings; it is an argument for reading the code before the issue body.

**A disclaimer that did the thing it disclaimed.** PR #3862 was written deliberately *not* to close #3291, and its commit body said so: "Deliberately NOT `Closes #3291`." GitHub's keyword parser matched the pair inside the negation — backticks do not escape it — and closed the issue on merge. The sentence explaining why it had to stay open is what closed it. Reopened, mechanism recorded on the issue.

**The measurement that was worth more than the fix.** #3321's targeting reduces a sync tick on a 3,000-page space from 31 IPCs to 2. The number that mattered was the *before*: it is pinned by a test that fails with `expected 30 to be +0` if the targeting is disabled, so the baseline cannot quietly stop being true.

**Reviewers kept finding the shape session 1300 named.** A guard that reads as coverage and supplies none turned up three more times. The panic-contract test coupled code to two free-floating substrings in a 1000-line document: it **passed** a bullet rewritten to assert the opposite and **failed** a semantically identical synonym swap. The `lan_only` locality gate was pinned one level down and left unwired one level up, with a rustdoc claiming otherwise — deleting the whole extension left the suite green. And a mock's sort-column lookup accepted `constructor`/`valueOf` where the engine rejects them; four of the six tests written to pin that turned out to be *unfalsifiable* (the bogus getter compares equal for every row, so "accepted but inert" is indistinguishable from "ignored" through the public seam), and were removed rather than shipped.

**Two things could not be tested, and saying so was the work.** Cargo ignores a profile's `panic` key for test targets, so every test binary unwinds and no in-process test can observe the release abort contract — verified with a standalone crate rather than asserted. And `daemon_loop`'s mDNS announce needs a live `ServiceDaemon` and never returns. Both are written into a residual-coverage list that lives in the module docs, where it cannot drift out of the code the way a PR description does.

**One thing was left for the maintainer.** #3853's fix has to relax a gate that previously refused any publicly-routable bind, because the reporter's own LAN uses public-numbered space. Review sharpened the cost past what the PR claimed: a host with a public NIC *and* a private bridge goes from not-exposed (it bound the bridge — broken sync, unreachable) to exposed. The shipped mitigation is loudness, and loudness turned out not to work either, because loopback is always enumerated so the "quiet" branch is unreachable and every daemon start already warns. That is being fixed; the product decision — opt-in gate, user-visible banner, or accept-with-reasoning — is #3864 and is deliberately not being made unattended.

**What generalises:** verify the issue against the code before planning from it, and treat a maintainer's stated blocker as a hypothesis rather than a constraint — it may be describing a dichotomy that isn't one. Both are cheap; both changed the shape of the work tonight.
