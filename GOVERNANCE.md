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

## Continuity and succession

The project is solo-maintained, so this section answers one question: if the BDFL is unavailable, what does someone else need in order to keep triaging, merging and releasing within a week? The answer is short because most of it is already public or replaceable.

| Item | Where it lives | What a successor needs |
| --- | --- | --- |
| Repository administration | The repository is under the BDFL's personal GitHub account; that account is its only admin. | The BDFL's GitHub account names a successor in GitHub's [account successor setting](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-access-to-your-personal-repositories/maintaining-ownership-continuity-of-your-personal-accounts-repositories). GitHub lets that person archive or transfer the public repositories to their own account once the account is unreachable, and a [repository transfer](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository) keeps issues, PRs, webhooks, Actions secrets and deploy keys attached, so the release workflow keeps signing. |
| Commit and tag signing | The BDFL's GPG key, on the BDFL's machines only. | Nothing. The ruleset requires *a* valid signature on `main`, not a specific key (see [Branch protection](#branch-protection--merge-rights)), and [`scripts/bump-version.sh`](scripts/bump-version.sh) signs the release tag with whatever key the local git config selects. A successor signs with their own key. |
| Updater signing key | `TAURI_SIGNING_PRIVATE_KEY` and its password as Actions secrets, plus the BDFL's local copy. | Repository admin is enough to keep releasing: the secrets stay set and `release.yml` uses them. If the local copy is lost, the successor rotates the key per [`SECURITY.md` § Updater signing-key rotation](SECURITY.md#updater-signing-key-rotation); the cost is one manual re-install for existing users, documented there. No escrow of the private key is needed for continuity. |
| Android keystore | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` as Actions secrets, plus the BDFL's local copy. | Same as the updater key: the secrets keep the release workflow signing. A replaced keystore changes the APK signature, so existing sideloaded installs would need a fresh install; there is no store listing yet (#79). |
| DNS and domains | None. Every published URL, including the updater endpoint in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json), is on `github.com`; `com.agaric.app` is a bundle identifier, not a registered domain. | Nothing. |
| Legal rights | GPL-3.0-or-later with DCO sign-off and no CLA (see [Licensing](#licensing)); no trademark is claimed on the name. | Nothing. Anyone may continue the project under its license, including under the same name, from a fork if the repository itself is unreachable. |

**Procedure.** The successor gains repository access through GitHub's successor flow, confirms the Actions secrets are still set, and continues with the same ruleset and release process ([`docs/BUILD.md` § Releasing](docs/BUILD.md#releasing)). Rotating the updater key is the only step that needs a decision, and only if the successor also needs the private key outside CI. Updating the role table above is the first change the successor makes.

## Revisit triggers

The governance model is intentionally minimal today. The following events should each trigger a fresh look at this document:

- **First external contributor with a sustained pattern of merged PRs** — codify a "committer" or "reviewer" role; consider sharing release-tagging rights; decide whether the admin bypass goes away or widens to cover both names.
- **A second person is needed for security response** (per [`SECURITY.md`](SECURITY.md) 14-day SLA) — name a backup responder; document the rotation.
- **An incident where a BDFL decision is contested by multiple contributors** — adopt a more explicit dispute-resolution path (e.g., move to a 2-of-N maintainer model, or a written RFC process).
- **The BDFL becomes unavailable for > 30 days** — invoke the [continuity and succession](#continuity-and-succession) procedure; once a second maintainer exists, name them there instead of relying on the GitHub successor flow.

Each of these is a soft trigger, not a deadline. The point is that this document should change in lockstep with the human reality on the ground rather than ossify.
