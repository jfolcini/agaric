# Project governance

Agaric is a [benevolent-dictator-for-life (BDFL)](https://en.wikipedia.org/wiki/Benevolent_dictator_for_life) project. As of this writing the BDFL is [@jfolcini](https://github.com/jfolcini), who is also the sole maintainer.

This document captures how decisions are made today, what role labels mean, and what triggers a governance-model change later.

## Roles

| Role | Held by | Powers | Responsibilities |
| --- | --- | --- | --- |
| **Maintainer / BDFL** | [@jfolcini](https://github.com/jfolcini) | Direct push to `main`; merge any PR; tag releases; rotate signing keys; ban/unban contributors; change this file. | Triage issues + PRs; ship releases; respond to security reports per [`SECURITY.md`](SECURITY.md); apply the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). |
| **Contributor** | Anyone with a merged PR | Open issues, open PRs, comment, propose roadmap changes. | Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off, tests, prek-clean) and the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). |

There are no other roles today (no "committers", no "reviewers" group, no "release manager"). When a second human regularly takes on maintainer-shaped work, this table is the first thing to update — see "Revisit triggers" below.

## How decisions are made

**Technical decisions** (architecture, dependencies, API shape, when to release): the BDFL decides. Major calls are documented under [`docs/architecture/`](https://github.com/jfolcini/agaric/tree/main/docs/architecture) so the rationale is recoverable later. Anyone may open an issue arguing for a different call; the BDFL responds in the issue thread. The thread is the public audit trail.

**Roadmap and priorities**: tracked on the GitHub issue tracker. The BDFL sets priorities; anyone may open an issue to propose new work or argue for a different priority.

**Code-of-conduct enforcement**: handled by the BDFL per [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Appeals go to the same person via the contact channel listed there; there is no separate appeals body yet.

**Security disclosures**: handled per [`SECURITY.md`](SECURITY.md). The BDFL is the sole responder until the role table grows.

## Branch protection / merge rights

Asymmetric by design (see [`docs/architecture/ci-and-tooling.md` § Asymmetric branch-protection convention](docs/architecture/ci-and-tooling.md#asymmetric-branch-protection-convention)): the BDFL can push directly to `main` via an admin bypass on the ruleset. All other contributors go through PRs that require `validate-all` green + code-owner review + last-push approval + thread-resolution. Cryptographic signature is required on every commit on `main` regardless of who pushes — the bypass does not cover that rule.

## Licensing

Agaric is licensed under **GPL-3.0-or-later** ([`LICENSE`](LICENSE)). Contributions are accepted under the same license, asserted by a [Developer Certificate of Origin (DCO) sign-off](CONTRIBUTING.md#developer-certificate-of-origin-dco) on every commit.

There is **no CLA** and no maintainer-held copyright assignment. The project deliberately uses DCO (a lightweight, well-understood mechanism, the same one the Linux kernel uses) instead of a CLA precisely so the BDFL cannot unilaterally relicense the project to a closed-source or non-commercial license. Any relicense would require obtaining permission from every individual contributor — the GPL family's standard rugpull guard.

## Revisit triggers

The governance model is intentionally minimal today. The following events should each trigger a fresh look at this document:

- **First external contributor with a sustained pattern of merged PRs** — codify a "committer" or "reviewer" role; consider sharing release-tagging rights; decide whether the admin bypass goes away or widens to cover both names.
- **A second person is needed for security response** (per [`SECURITY.md`](SECURITY.md) 14-day SLA) — name a backup responder; document the rotation.
- **An incident where a BDFL decision is contested by multiple contributors** — adopt a more explicit dispute-resolution path (e.g., move to a 2-of-N maintainer model, or a written RFC process).
- **The BDFL becomes unavailable for > 30 days** — invoke the succession plan (currently informal; future work to formalise once there is a second maintainer to hand off to).

Each of these is a soft trigger, not a deadline. The point is that this document should change in lockstep with the human reality on the ground rather than ossify.
