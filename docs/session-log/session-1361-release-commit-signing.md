# Session 1361 — release commits land verified, or no release is cut (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review + fixes of an existing working-tree diff) |
| **Items closed** | `#4082`, `#3745` |
| **Items modified** | — |
| **Tests added** | +13 shell assertions (0 frontend / 0 backend): `bump-version.sh --self-test` 24 → 35, `git-scratch-guard.sh --self-test` +2 |
| **Files touched** | 4 |

**Summary:** #3745 (at 0.9.4) and #4082 (at 0.9.8) are one defect reported twice: the
release bump commit is correctly GPG-signed, but it is committed as `t <t@t.t>` — an
address that is neither a user ID on the signing key nor a verified email on the GitHub
account — so GitHub answers `verified=false / unverified_email` and the "Commits must
have verified signatures" rule is BYPASSED rather than satisfied. Two fail-closed gates
now stand in the way: `release_require_identity` refuses to commit under an identity that
provably cannot verify, and `release_require_verified_commit` asks GitHub itself BETWEEN
the `main` push and the tag push, so a bad commit stops the release before the point of
no return. This session reviewed that diff adversarially, proved every assertion in it
non-vacuous by mutation, and fixed six defects it found — including one live production
bug (`--jq '.object.sha'` prints the literal string `null`, so the tag-ref guard never
fired) and one hermeticity hole that let an ambient `GIT_COMMITTER_EMAIL` redden eight
assertions.

**Files touched (this session):**
- `scripts/bump-version.sh` (+843) — the two gates, `--check-identity`, and the 35-assertion `--self-test`
- `prek.toml` (+22) — `release-identity-selftest` hook (both gates are invisible until a release is cut, which is the worst moment to discover one was deleted)
- `scripts/release.sh` (+12) — identity preflight before the 5-10 minute local release build
- `scripts/lib/git-scratch-guard.sh` (+48 / -1) — the identity half of the ambient-git surface

**What the review changed (six findings, all fixed):**

1. **The shared scrubber missed the identity variables** (`git-scratch-guard.sh`).
   Measured: with `user.email = fixture@example.invalid` in the fixture's config,
   `git var GIT_COMMITTER_IDENT` still answers the environment's `GIT_COMMITTER_EMAIL`.
   Running the new suite under an ambient `GIT_COMMITTER_EMAIL=t@t.t` turned 8 of 24
   assertions red — a self-test about committer addresses was reading the caller's shell.
   `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` were already scrubbed and the NAME/EMAIL half
   was not, which reads as an asymmetry rather than a decision. Added
   `GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL` to
   `GIT_SCRATCH_LEAK_VARS`, plus a behavioural assertion (a fixture commit must carry the
   fixture's address) and its non-vacuity twin (without the scrub, the ambient address
   does win). Fixed in the shared library rather than locally because
   `check-git-fixture-isolation.mjs` rule 1 rejects private copies of this scrub, and
   because every other fixture builder has the same latent bug.
2. **The load-bearing comparison's exactness was unpinned.** Weakening `grep -Fxq` to
   `grep -Fq` left the whole suite green — so a UID that merely *contains* the committer
   address would have satisfied the gate. Added a case with UID
   `<notjfolcini86@gmail.com>` against committer `<jfolcini86@gmail.com>`.
3. **An ambiguous `user.signingkey` was accepted.** Measured on gpg 2.4.4: two keys
   sharing a UID address answer one `gpg --list-keys <address>` with two `pub` records,
   and the old harvest merged UIDs across all of them. `git commit -S` hands the id
   straight to gpg, which picks one — not necessarily the key whose UID matched. Now
   rejected by key count, with "set user.signingkey to a full 40-character fingerprint".
4. **An expired or revoked PRIMARY key was diagnosed as a UID problem.** Measured: gpg
   2.4.4 stamps `e`/`r` on the UID records too, so the UID filter already rejected both —
   but that mirroring is a gpg behaviour, not a promise, and "no usable user ID" is the
   wrong thing to tell someone whose key has simply lapsed. The `pub` record's validity
   is now read explicitly and the condition named.
5. **`gpg` absent from PATH was diagnosed as a key defect.** On a fresh machine the
   message was "signing key … has no usable user ID", sending the maintainer after a
   defect that does not exist. This gate has no bypass flag, so the message *is* the
   remedy. Now diagnosed as gpg being absent.
6. **Production bug: `--jq '.object.sha'` prints the literal string `null`** on a body
   with no `.object` (a 404's `{"message":"Not Found"}`, a rate-limit body), so
   `release_require_verified_tag`'s `[ -z "$object_sha" ]` guard never fired on the
   commonest failure shape and the lookup went on to ask for the object named `null`.
   Still fail-closed, but diagnosed as an unreadable verification rather than a tag that
   is not there. Fixed with `.object.sha // empty`; found only because the new assertion
   was written against the diagnosis rather than the exit status.

Also improved two maintainer-facing messages: the remedy's `gh api user/emails` needs the
`user` token scope and answers 404 without it (verified against this account), so it now
names `gh auth refresh -h github.com -s user` and the settings page; and the failure
between the two pushes now distinguishes "GitHub said verified=false" (land a new bump)
from "GitHub did not answer" (the local tag already exists — re-ask and resume from the
tag push; do not re-run `release.sh`, which refuses on a version the manifests already
hold).

**Branch protection:** untouched, and verified as such. The diff deletes no line of
`bump-version.sh` or `release.sh`; both `git push --no-verify` lines are pre-existing and
byte-identical (the three other `--no-verify` hits are grep *patterns* inside the order
ratchets, not commands); the only `git config` writes in the diff are inside a quoted
heredoc of remedy text and are never executed; no workflow, ruleset or `.github` file is
touched. Neither gate has a bypass flag, and neither env knob is one:
`RELEASE_VERIFY_ATTEMPTS=0` fails closed, and `verified` must equal the literal `true`.
The diff is strictly additive gating on a path that already bypassed protection.

**Verification:**
- `bash scripts/bump-version.sh --self-test` — 35 assertions, all pass. Hermetic: fake
  `gpg` and `gh` on `PATH` (asserted to resolve to the fakes before anything else runs),
  `HOME` at a throwaway directory, `GIT_CONFIG_NOSYSTEM=1`, and the shared scratch guard.
  The fake `gh` evaluates the REAL `--jq` expression through the real jq, so the
  production jq programme is what is under test.
- `bash scripts/lib/git-scratch-guard.sh --self-test` — all assertions pass (+2 new).
- `shellcheck --severity=warning scripts/{bump-version,release}.sh scripts/lib/git-scratch-guard.sh` — clean.
- `bash -n` on all three — clean.
- `node scripts/check-git-fixture-isolation.mjs` — OK, 101 scripts checked (31 .sh, 61 .mjs, 9 .py).
- `prek.toml` — parses (96 repo blocks, 168 hooks), no duplicate hook ids, and every path
  in `release-identity-selftest`'s `files` regex exists and matches it.
- Mutation testing, 17 mutations, every one red except where noted: the identity call
  site deleted; the commit verification moved AFTER the tag push (order-only); the
  `--check-identity` preflight moved after the build in `release.sh` (order-only); the
  case fold dropped from each side independently; `grep -Fxq` → `-Fq`; the revoked/expired
  UID filter removed; the same filter made over-broad (blacklisting an address that also
  appears on a usable UID); the jq prefix changed to `.verification`; a missing API answer
  treated as a pass; the gpg-absent, multi-key and pub-validity branches each deleted;
  `.object.sha // empty` reverted; the tag-ref early return deleted.
- The three harness defects the author reported fixed were re-proved fixed, and each fix
  shown to be load-bearing: removing the `[ "$st_fail" = 0 ]` from case 9's subshell makes
  the suite print `FAIL` and exit **0** with "self-test passed"; removing `|| true` from
  `st_where` makes a non-matching ratchet pattern kill the suite at exit 1 with **no
  diagnosis at all**; and the fake-`gh` payload paths were confirmed collision-free, with
  case 13's fail-closed path proved live by mutation rather than by a deleted body.
- `scripts/bump-version.sh --check-identity` run for real against the maintainer's
  keyring: rejects today's `t <t@t.t>` and names the one candidate the key carries.

**Process notes:** the maintainer-facing consequence is deliberate and should be stated
plainly — `scripts/release.sh` will refuse to cut a release until `user.name`/`user.email`
are pointed at an address that is both a UID on the signing key and verified on the
account. That is the right default: the gate exists because three releases shipped on an
unread bypass, and an escape hatch would reproduce the defect. It does not strand the
project. The error names the single candidate the key already carries, gives the two
commands that enumerate candidates, and the remedy is two `git config` lines; the gate is
also scoped to `--commit`, so `scripts/bump-version.sh X.Y.Z` still edits the manifests
for a fully manual hotfix without any gate at all. No path requires editing the script.

**Lessons learned (for future sessions):** an assertion written against an exit status
rather than a diagnosis can be green while the branch it names has gone — the tag-ref
case only found the `.object.sha` → `"null"` bug once it required the message. And
`--jq '<path>'` is not a null check: `gh api --jq` prints the four characters `null` for
a missing path, so every `[ -z "$x" ]` guard downstream of one needs `// empty`.

**Commit plan:** single commit — not pushed. Number 1361 was allocated externally while
this branch's union max (HEAD and `origin/main`) is 1350; `session-log-numbering`'s
`GAP_BOUND=10` accepts 1351–1360, so the sibling sessions holding 1351–1360 must land
before this commits, or the guard will reject the number.
