#!/usr/bin/env bash
#
# bump-version.sh — bump the project version in every version manifest in
# lockstep (the authoritative list is `Files updated:` below — this script IS
# that list; anything that needs to name them should point here rather than
# keep a count that drifts), regenerate lock files, and (optionally)
# commit + tag + push.
#
# The Release workflow (`.github/workflows/release.yml`) has a
# `verify-version` job that fails fast if the tag and the manifests
# disagree. Pre-this-script, the bump was a manual five-step ritual that
# the maintainer kept forgetting; this script makes it a one-liner.
#
# Files updated:
#   - src-tauri/Cargo.toml              (`version = "X.Y.Z"`)
#   - src-tauri/Cargo.lock              (regen via `cargo update -p agaric`)
#   - src-tauri/fuzz/Cargo.lock         (regen via `cargo update -p agaric`,
#                                        run from src-tauri/fuzz — its OWN
#                                        workspace, path-depending on `agaric`)
#   - src-tauri/tauri.conf.json         (`"version": "X.Y.Z"`)
#   - package.json                      (`"version": "X.Y.Z"`)
#   - package-lock.json                 (two-field `jq` edit — version-only)
#
# Usage
# -----
#
#   scripts/bump-version.sh <new-version> [--commit] [--tag] [--push]
#   scripts/bump-version.sh --check-identity
#
#   <new-version>     Semver triple, e.g. `0.1.16`. No leading `v`.
#   --commit          Stage the changed files (see `Files updated:` above)
#                     and create a release commit.
#   --tag             Create the `<new-version>` git tag (requires --commit).
#   --push            Push main + the new tag to origin (requires --tag).
#   --check-identity  Only check that the configured git identity can produce
#                     a commit GitHub will mark verified (#3745, #4082), then
#                     exit. Nothing is edited, committed or pushed.
#
# Examples
# --------
#
#   # 1) Update manifests only — review the diff manually, then commit+tag+push yourself.
#   scripts/bump-version.sh 0.1.16
#
#   # 2) Full automated release (matches what the maintainer used to do manually).
#   scripts/bump-version.sh 0.1.16 --commit --tag --push
#
#   # 3) Local dry-run — bump, commit, tag, but DON'T push (useful for review).
#   scripts/bump-version.sh 0.1.16 --commit --tag

set -euo pipefail

# ── Release identity and signature verification (#3745, #4082) ──────────────
#
# The bump commit is the ONLY commit that reaches `main` without a squash
# merge, so it is the only one whose local git identity is ever tested.
# Every other commit's identity is laundered by the merge — GitHub re-signs
# squash commits with its own web-flow key, so they land `verified=true`
# whatever `user.email` says.
#
# 0.9.4 (#3745) and 0.9.8 (#4082) both landed a correctly GPG-signed bump
# commit that GitHub reported as `verified=false, reason=unverified_email`.
# The signature was good and made with the configured key; the commit was
# authored as `t <t@t.t>`, which is neither a user ID on that key nor a
# verified address on the account. GitHub binds a signature to an identity
# through the COMMITTER ADDRESS, so without that binding the "Commits must
# have verified signatures" rule is BYPASSED rather than satisfied, and the
# release tag — the root every SLSA attestation the release workflow
# produces describes — names a commit that cannot be attributed. The same
# address lands in the commit's `Signed-off-by` trailer too
# (scripts/dco-signoff.sh writes it from the AUTHOR identity, which for an
# un-overridden checkout is that same config), so the DCO asserts an
# identity that does not exist.
#
# Two gates, both fail-closed:
#
#   1. BEFORE the commit — `release_require_identity` refuses to bump when
#      the configured identity provably cannot verify. It asserts a
#      property; it does not choose an identity. WHICH address a release is
#      cut under is a maintainer decision (it must be both a user ID on the
#      signing key and a verified email on the GitHub account), so no
#      address, key or bot account is hardcoded here.
#   2. AFTER the push — `release_require_verified_commit` asks GitHub
#      itself, BETWEEN the `main` push and the tag push. The tag push is the
#      point of no return (release.yml publishes with no approval gate), so
#      a commit that landed unverified stops the release before it starts
#      rather than after. The bypass block scrolls past in a wall of push
#      output; it survived 0.9.4 and 0.9.8 — and probably 0.9.3 — precisely
#      because nothing ever asserted on it.
#
# Neither gate has a bypass flag, deliberately. The defect is that a release
# push bypasses branch protection; an escape hatch here would reproduce it.

# Attempts / delay for the post-push verification query. The retry exists for
# an API read-after-write blip, and a definitive `verified:false` is never
# retried.
RELEASE_VERIFY_ATTEMPTS="${RELEASE_VERIFY_ATTEMPTS:-3}"
RELEASE_VERIFY_DELAY="${RELEASE_VERIFY_DELAY:-2}"

# The colon-delimited listing for `user.signingkey`, read ONCE so the three
# checks below cannot end up describing different keys.
release_key_records() {
  gpg --list-keys --with-colons -- "$1" 2>/dev/null
}

# How many PRIMARY keys `user.signingkey` resolved to. `git commit -S` passes
# the configured id straight to gpg, and a short id or a bare email can name
# more than one key in a keyring — measured on gpg 2.4.4, two keys sharing a
# UID address answer one `gpg --list-keys <address>` with two `pub` records.
# gpg then picks one, which need not be the key whose UID the comparison
# below matched, so the gate would pass on a signature that cannot bind.
release_key_count() {
  printf '%s\n' "$1" | grep -c '^pub:' || true
}

# The PRIMARY key's own validity character (`r` revoked, `e` expired, `u`
# ultimately valid, …). Measured on gpg 2.4.4, a revoked or expired primary
# key stamps `r`/`e` on its UID records too, so the UID filter below already
# rejects both — but that mirroring is a gpg behaviour rather than a
# guarantee, and "no usable user ID" is the wrong diagnosis to hand someone
# whose key has simply lapsed. Read it explicitly and name the condition.
release_key_validity() {
  printf '%s\n' "$1" | awk -F: '$1 == "pub" { print $2; exit }'
}

# Emails carried by the USABLE user IDs in a colon-delimited key listing,
# lower-cased, one per line. Revoked (`r`) and expired (`e`) UIDs are
# excluded: GitHub will not bind a signature to them, so counting them here
# would make the gate pass on exactly the configuration that fails at the
# push.
release_key_uid_emails() {
  printf '%s\n' "$1" |
    awk -F: '$1 == "uid" && $2 != "r" && $2 != "e" { print $10 }' |
    sed -n 's/^[^<]*<\([^>]*\)>.*$/\1/p' |
    tr '[:upper:]' '[:lower:]' |
    sort -u
}

# The email in one of git's resolved identity strings (`Name <email> ts tz`).
# Read through `git var` rather than `git config --get user.email` on
# purpose: `git var` reports the address the commit will ACTUALLY carry,
# including a `GIT_COMMITTER_EMAIL` override or an `includeIf` config that
# `--get user.email` does not see.
release_ident_email() {
  git var "$1" 2>/dev/null |
    sed -n 's/^[^<]*<\([^>]*\)>.*$/\1/p' |
    tr '[:upper:]' '[:lower:]'
}

# Prints a one-line diagnosis and returns 1 when the configured identity
# cannot produce a commit GitHub will mark verified; silent, returns 0,
# otherwise. Same shape as verify-ci-equivalent.sh's `node_deps_problem`.
release_identity_problem() {
  local name config_email committer_email author_email format key records matches uids
  name="$(git config --get user.name 2>/dev/null || true)"
  config_email="$(git config --get user.email 2>/dev/null || true)"

  if [ -z "$name" ]; then
    printf 'git `user.name` is not set, so the release commit has no author name and the DCO trailer cannot be written.\n'
    return 1
  fi
  if [ -z "$config_email" ]; then
    printf 'git `user.email` is not set, so the release commit would be attributed to a guessed address.\n'
    return 1
  fi

  config_email="$(printf '%s' "$config_email" | tr '[:upper:]' '[:lower:]')"
  committer_email="$(release_ident_email GIT_COMMITTER_IDENT)"
  if [ -z "$committer_email" ]; then
    printf 'git could not resolve a committer identity (`git var GIT_COMMITTER_IDENT` produced no address).\n'
    return 1
  fi
  # The DCO trailer is written from the AUTHOR identity — `git var
  # GIT_AUTHOR_IDENT` (scripts/dco-signoff.sh, #4561) — while the signature
  # binds to the COMMITTER address. If they disagree the sign-off asserts a
  # different identity from the one that signed, which is the third symptom
  # reported in #4082.
  #
  # Read the author, not `user.email`. Until #4561 the trailer did come from
  # `user.email` and comparing that was right; it is not any more, and the
  # difference is not cosmetic: `GIT_AUTHOR_EMAIL` and `git commit --author=`
  # both change the trailer while leaving `user.email` untouched, so a gate
  # reading the config would pass while the trailer it protects disagrees with
  # the committer — exactly the state it exists to refuse.
  author_email="$(release_ident_email GIT_AUTHOR_IDENT)"
  if [ -z "$author_email" ]; then
    printf 'git could not resolve an author identity (`git var GIT_AUTHOR_IDENT` produced no address), so the DCO trailer cannot be written.\n'
    return 1
  fi
  if [ "$author_email" != "$committer_email" ]; then
    printf 'the Signed-off-by trailer would say <%s> (the AUTHOR identity, per scripts/dco-signoff.sh) while the commit is committed as <%s>; the DCO would assert a different identity from the one that signed.\n' \
      "$author_email" "$committer_email"
    return 1
  fi
  # `user.email` disagreeing with the author is a weaker but still fatal
  # signal: it means the release is being cut under an overridden identity,
  # and WHICH address a release is cut under is a maintainer decision this
  # gate deliberately does not make for them.
  if [ "$config_email" != "$author_email" ]; then
    printf 'git `user.email` is <%s> but the commit would be authored as <%s> (GIT_AUTHOR_EMAIL or --author is overriding it); a release must not be cut under an identity the repository config does not name.\n' \
      "$config_email" "$author_email"
    return 1
  fi

  format="$(git config --get gpg.format 2>/dev/null || true)"
  : "${format:=openpgp}"
  if [ "$format" != openpgp ]; then
    # SSH / X.509 signing has no user-ID list to compare against, so this
    # gate has nothing to assert. The post-push check is then the only gate,
    # and it is authoritative — do not invent a local rule for a format
    # whose binding we cannot inspect.
    return 0
  fi

  key="$(git config --get user.signingkey 2>/dev/null || true)"
  if [ -z "$key" ]; then
    printf '`user.signingkey` is not set, so `git commit -S` cannot pick a key deterministically and the signature may not bind to <%s>.\n' \
      "$committer_email"
    return 1
  fi

  # An openpgp signature that cannot be made is not a milder problem than one
  # that cannot bind, and "no usable user ID" would send the maintainer
  # hunting a key defect that does not exist.
  if ! command -v gpg >/dev/null 2>&1; then
    printf '`gpg` is not on PATH, so `git commit -S` cannot make an openpgp signature at all and signing key %s cannot be inspected. Install gnupg, or set `gpg.format` to the scheme this machine actually signs with.\n' \
      "$key"
    return 1
  fi

  records="$(release_key_records "$key")"

  matches="$(release_key_count "$records")"
  if [ "$matches" -gt 1 ]; then
    printf '`user.signingkey` (%s) matches %s keys in this keyring, so `git commit -S` cannot pick one deterministically: gpg may sign with a key that does not carry <%s>, and the commit would then land verified=false. Set user.signingkey to a full 40-character fingerprint.\n' \
      "$key" "$matches" "$committer_email"
    return 1
  fi

  case "$(release_key_validity "$records")" in
    r*)
      printf 'signing key %s is REVOKED, so nothing it signs can be verified by anyone. Configure a current key.\n' "$key"
      return 1
      ;;
    e*)
      printf 'signing key %s has EXPIRED, so `git commit -S` will refuse to sign with it. Extend its expiry (`gpg --quick-set-expire`) and re-upload the public key to GitHub, or configure a current key.\n' "$key"
      return 1
      ;;
  esac

  uids="$(release_key_uid_emails "$records")"
  if [ -z "$uids" ]; then
    printf 'signing key %s has no usable (non-revoked, non-expired) user ID with an email address, so GitHub cannot bind its signatures to any account.\n' \
      "$key"
    return 1
  fi
  if ! printf '%s\n' "$uids" | grep -Fxq "$committer_email"; then
    printf 'committer address <%s> is not a user ID on signing key %s (its usable UIDs: %s). GitHub binds a GPG signature through the committer address, so the commit would land verified=false / unverified_email and the "Commits must have verified signatures" rule would be bypassed rather than satisfied.\n' \
      "$committer_email" "$key" "$(printf '%s' "$uids" | tr '\n' ' ')"
    return 1
  fi

  return 0
}

# Remedy text. Deliberately names no address, key or account: which identity
# a release is cut under is the maintainer's call (#3745 lists the options),
# and guessing it here would silently change who is trusted to push to main.
release_identity_remedy() {
  cat <<'REMEDY'
  Point git at an identity that BOTH the signing key and the GitHub account carry:

      git config user.name  "<the account's display name>"
      git config user.email "<an address that is a user ID on the signing key AND
                              a verified email on the GitHub account>"

  To see the candidates:
      gpg --list-keys "$(git config --get user.signingkey)"   # the key's user IDs
      gh api user/emails --jq '.[] | select(.verified) | .email'   # verified account emails

  (That second command needs the `user` token scope and answers 404 without it;
  `gh auth refresh -h github.com -s user` grants it. The account's verified
  addresses are also listed at https://github.com/settings/emails.)

  If the address you want is verified on the account but missing from the key, add it
  as a UID (`gpg --quick-add-uid`) and re-upload the public key to GitHub. Choosing
  WHICH address (personal, or the account's `users.noreply.github.com` form) is a
  maintainer decision this script deliberately does not make for you.
REMEDY
}

release_require_identity() {
  local problem
  if problem="$(release_identity_problem)"; then
    return 0
  fi
  echo "ERROR: refusing to cut a release with an identity that cannot verify (#3745, #4082):" >&2
  echo "       $problem" >&2
  release_identity_remedy >&2
  exit 1
}

# Ask GitHub whether an object's signature verified. Prints `<verified>|<reason>`
# (e.g. `true|valid`, `false|unverified_email`), or nothing when the API gave
# no answer at all — which is treated as a failure, not as a pass.
release_github_verification() {
  local api_path="$1" jq_prefix="$2" jq_expr
  jq_expr="$jq_prefix | [(.verified | tostring), (.reason // \"unknown\")] | join(\"|\")"
  gh api "$api_path" --jq "$jq_expr" 2>/dev/null || true
}

# Fail loudly unless GitHub reports the object as verified. <label> names the
# object in the messages; <api-path> and <jq-prefix> locate its verification
# block (a commit's hangs off `.commit`, a tag object's off the root).
release_require_verified() {
  local label="$1" api_path="$2" jq_prefix="$3"
  local attempt=1 answer='' verified reason
  while :; do
    answer="$(release_github_verification "$api_path" "$jq_prefix")"
    case "$answer" in
      'true|'* | 'false|'*) break ;;
    esac
    if [ "$attempt" -ge "$RELEASE_VERIFY_ATTEMPTS" ]; then
      echo "ERROR: could not read GitHub's signature verification for the $label" >&2
      echo "       (GET $api_path returned no usable answer after $RELEASE_VERIFY_ATTEMPTS attempts)." >&2
      echo "       Failing closed: an unread verification is not a passed one (#3745)." >&2
      return 1
    fi
    attempt=$((attempt + 1))
    if [ "$RELEASE_VERIFY_DELAY" != 0 ]; then
      sleep "$RELEASE_VERIFY_DELAY"
    fi
  done

  verified="${answer%%|*}"
  reason="${answer#*|}"
  if [ "$verified" != true ]; then
    echo "ERROR: GitHub reports the $label as UNVERIFIED (reason: $reason)." >&2
    echo "       The signature rule on main was BYPASSED, not satisfied — which is the" >&2
    echo "       defect #3745 and #4082 describe, not a passing release." >&2
    release_identity_remedy >&2
    return 1
  fi
  printf '✓ GitHub verified the %s (reason: %s).\n' "$label" "$reason"
  return 0
}

release_require_verified_commit() {
  release_require_verified "release commit $1" "repos/{owner}/{repo}/commits/$1" '.commit.verification'
}

# The annotated tag is signed with the same key and carries the same tagger
# address, so it fails and passes for the same reasons as the commit (#3745).
# Its verification lives on the tag OBJECT, which has to be resolved from the
# ref first.
release_require_verified_tag() {
  local tag="$1" object_sha
  # `// empty` because `--jq '.object.sha'` on a body that has no `.object`
  # — a 404's `{"message":"Not Found"}`, a rate-limit body — prints the
  # literal string `null`, which is not empty. Without it the guard below
  # never fires on the commonest failure shape and the tag lookup goes on to
  # ask for the object named `null`: still fail-closed, but diagnosed as an
  # unreadable verification rather than as a tag that is not there.
  object_sha="$(gh api "repos/{owner}/{repo}/git/ref/tags/$tag" --jq '.object.sha // empty' 2>/dev/null || true)"
  if [ -z "$object_sha" ]; then
    echo "ERROR: could not resolve the pushed tag '$tag' on origin to a tag object." >&2
    echo "       Failing closed: an unread verification is not a passed one (#3745)." >&2
    return 1
  fi
  release_require_verified "release tag $tag" "repos/{owner}/{repo}/git/tags/$object_sha" '.verification'
}

# ── Identity preflight (--check-identity) ───────────────────────────────────
# Exposed as a flag so scripts/release.sh can fail on a bad identity BEFORE
# it spends 5-10 minutes on the local release build, and so the check can be
# run on its own from a fresh clone or a new machine.
if [ "${1:-}" = "--check-identity" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$REPO_ROOT" ]; then cd "$REPO_ROOT"; fi
  release_require_identity
  echo "✓ release identity can produce a commit GitHub will verify."
  exit 0
fi

# ── Argument parsing ────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  echo "ERROR: missing <new-version> argument." >&2
  echo "Usage: $0 <new-version> [--commit] [--tag] [--push]" >&2
  exit 2
fi

NEW_VERSION="$1"
shift

# Strip any accidental leading `v` so callers can pass either shape.
NEW_VERSION="${NEW_VERSION#v}"

# Validate semver-ish shape: must be `MAJOR.MINOR.PATCH` with optional
# `-prerelease`. The Release workflow's `verify-version` step accepts
# anything jq/grep returns, so we keep this lenient.
if ! echo "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'; then
  echo "ERROR: '$NEW_VERSION' is not a valid semver triple (expected X.Y.Z[-prerelease])." >&2
  exit 2
fi

DO_COMMIT=0
DO_TAG=0
DO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --commit) DO_COMMIT=1 ;;
    --tag)    DO_TAG=1; DO_COMMIT=1 ;;     # --tag implies --commit
    --push)   DO_PUSH=1; DO_TAG=1; DO_COMMIT=1 ;;  # --push implies --tag + --commit
    *)
      echo "ERROR: unknown flag '$arg'" >&2
      echo "Usage: $0 <new-version> [--commit] [--tag] [--push]" >&2
      exit 2
      ;;
  esac
done

# ── Repo root + dependency check ────────────────────────────────────────────

# Always run from the repo root regardless of where the user invoked us.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: not inside a git repository." >&2
  exit 1
fi
cd "$REPO_ROOT"

for cmd in jq cargo git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

# Refuse to bump on a dirty tree when --commit is requested — the commit
# would otherwise sweep up unrelated work in progress.
if [ "$DO_COMMIT" -eq 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree has uncommitted changes; refusing to --commit on top of them." >&2
  echo "       Stash or commit your in-flight work first, or run without --commit." >&2
  git status --short >&2
  exit 1
fi

# Assert HEAD is on main before any mutating git op. The release flow's
# entire contract is "land the bump on main, tag main, push main + tag";
# every downstream consumer (PR #42-style stale-PR collision, release
# workflow's main-only gate, the `git push --no-verify origin main`
# line below) assumes that. We saw 0.1.37 land on `fix-pend-74-hastag-flake`
# in one session because HEAD silently moved to that branch between the
# user's `git checkout main` and this script's invocation — root cause
# unproven (most likely the Claude Code harness's worktree management
# leaking a branch switch onto the primary working tree), but a one-line
# branch-name assertion at script entry forecloses the entire failure
# class regardless of how HEAD got moved. Belt and braces: even if the
# upstream automation gets fixed, this guard is cheap insurance against
# a future regression.
if [ "$DO_COMMIT" -eq 1 ]; then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "ERROR: HEAD is on '$CURRENT_BRANCH', not 'main' — refusing to --commit a release bump." >&2
    echo "       Release commits MUST land on main so the tag and the PR (if any) point at the same SHA." >&2
    echo "       Switch with 'git checkout main' and re-run." >&2
    exit 1
  fi
fi

# Identity gate (#3745, #4082) — see the header block. Placed here, before a
# single manifest is edited, so a placeholder identity costs nothing but the
# error message rather than a half-bumped tree to clean up.
if [ "$DO_COMMIT" -eq 1 ]; then
  release_require_identity
fi

# The post-push verification below is not optional, so neither is `gh`. A
# release that cannot be verified must not be cut: failing here is the whole
# point (#3745 — "release.sh should verify it rather than trust it").
if [ "$DO_PUSH" -eq 1 ] && ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: required command 'gh' not found in PATH." >&2
  echo "       --push verifies with GitHub that the pushed commit and tag landed" >&2
  echo "       with verified signatures; without gh that check cannot run, and an" >&2
  echo "       unrun check is not a passed one." >&2
  exit 1
fi

# ── Read current version ────────────────────────────────────────────────────

CURRENT_VERSION="$(jq -r .version package.json)"
if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "ERROR: package.json already at $NEW_VERSION — nothing to bump." >&2
  exit 1
fi

echo "Bumping $CURRENT_VERSION → $NEW_VERSION"

# ── Update the 3 source-of-truth manifests ──────────────────────────────────

# package.json — jq with -i not portable; use a temp file.
TMP="$(mktemp)"
jq --arg v "$NEW_VERSION" '.version = $v' package.json > "$TMP"
mv "$TMP" package.json

# src-tauri/tauri.conf.json — same pattern.
TMP="$(mktemp)"
jq --arg v "$NEW_VERSION" '.version = $v' src-tauri/tauri.conf.json > "$TMP"
mv "$TMP" src-tauri/tauri.conf.json

# `jq` pretty-prints with one-element-per-line arrays; oxfmt's formatter
# wants short arrays inlined. Without this, the post-bump diff carries
# `tauri.conf.json` / `package.json` formatting changes the CI lint shard
# rejects. Run oxfmt on both manifests so the bump commit
# matches the canonical repo style. oxfmt is a devDependency — assume it
# is installed (the script is documented to run after `npm install`).
if [ -x node_modules/.bin/oxfmt ]; then
  node_modules/.bin/oxfmt --write package.json src-tauri/tauri.conf.json >/dev/null 2>&1
fi

# src-tauri/Cargo.toml — only the FIRST `version = "..."` line is the
# package version; sub-dep `version = "..."` lines later in the file must
# stay untouched. Use sed with `0,/.../` so only the first match is edited.
sed -i.bak "0,/^version = \"$CURRENT_VERSION\"$/s//version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak

# Sanity check: did the in-place edit actually update Cargo.toml?
ACTUAL_CARGO="$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)"
if [ "$ACTUAL_CARGO" != "$NEW_VERSION" ]; then
  echo "ERROR: src-tauri/Cargo.toml still at $ACTUAL_CARGO after sed; refusing to continue." >&2
  exit 1
fi

# ── Regenerate lock files ───────────────────────────────────────────────────

# package-lock.json mirrors package.json. A pure version bump touches
# exactly two fields in the lockfile (`.version` and
# `.packages[""].version`) — verified empirically against every prior
# bump commit. We edit them directly with `jq` rather than shelling out
# to `npm install --package-lock-only`, which OpenSSF Scorecard's
# pinned-dependencies check flags as `npmCommand not pinned by hash`
# (code-scanning alert #115). Direct `jq` edit removes the npm
# invocation entirely; if a future bump ever needs to do more than
# version-substitute (e.g. dependency graph change), restore the
# `npm install --package-lock-only --ignore-scripts` path and reopen
# the Scorecard finding.
TMP="$(mktemp)"
jq --arg v "$NEW_VERSION" '.version = $v | .packages[""].version = $v' \
  package-lock.json > "$TMP"
mv "$TMP" package-lock.json

# Cargo.lock — `cargo update` with the package + precise version is the
# minimal-diff way to bump just the agaric workspace member.
( cd src-tauri && cargo update -p agaric --precise "$NEW_VERSION" >/dev/null 2>&1 )

# src-tauri/fuzz/Cargo.lock — the SAME bump, in the fuzz crate's own
# workspace. `src-tauri/fuzz` is excluded from the parent workspace (its
# `[workspace]` table) and keeps a separate lock that pins `agaric` through a
# path dependency on `..`, so the call above does not reach it. Left stale it
# is not cosmetic: `cargo metadata --locked --manifest-path fuzz/Cargo.toml`
# then fails outright, which is what `_validate.yml`'s `verify-lockfiles`
# (#4142) and `verify-version-agreement` now assert on every backend PR.
# Every release from 0.7.1 to 0.9.8 left this file behind (by up to five
# versions) because nothing in the automation touched it.
#
# Ordering: this needs `src-tauri/Cargo.toml` to ALREADY carry the new version
# (the sed above) — `--precise` names the path dep's own manifest version. It
# is independent of `src-tauri/Cargo.lock`: separate workspace, resolved from
# `../Cargo.toml`, never from the parent lock. Verified both orders.
# stderr is NOT swallowed here, unlike the parent call above. This one runs
# on a maintainer-only path that no test and no CI job exercises, and it
# fires AFTER four manifests and the parent lock have already been rewritten
# — so a failure (network down, or cargo declining --precise) would abort the
# bump under `set -e` leaving a dirty tree and no explanation. The cost of
# keeping stderr is a little noise on success; the cost of dropping it is a
# silent abort mid-release.
if ! ( cd src-tauri/fuzz && cargo update -p agaric --precise "$NEW_VERSION" >/dev/null ); then
  echo "error: failed to bump agaric to $NEW_VERSION in src-tauri/fuzz/Cargo.lock." >&2
  echo "  The parent manifests and src-tauri/Cargo.lock have ALREADY been rewritten," >&2
  echo "  so the tree is dirty. Fix the cause above, then re-run this script." >&2
  exit 1
fi

# ── Sanity: every manifest now agrees ───────────────────────────────────────

CONF=$(jq -r .version src-tauri/tauri.conf.json)
CARGO=$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)
PKG=$(jq -r .version package.json)
PKG_LOCK=$(jq -r .version package-lock.json)
CARGO_LOCK=$(awk '/^name = "agaric"$/{getline; print; exit}' src-tauri/Cargo.lock | cut -d'"' -f2)
FUZZ_LOCK=$(awk '/^name = "agaric"$/{getline; print; exit}' src-tauri/fuzz/Cargo.lock | cut -d'"' -f2)

echo "Versions after bump:"
printf '  src-tauri/tauri.conf.json: %s\n' "$CONF"
printf '  src-tauri/Cargo.toml:      %s\n' "$CARGO"
printf '  src-tauri/Cargo.lock:      %s\n' "$CARGO_LOCK"
printf '  src-tauri/fuzz/Cargo.lock: %s\n' "$FUZZ_LOCK"
printf '  package.json:              %s\n' "$PKG"
printf '  package-lock.json:         %s\n' "$PKG_LOCK"

for v in "$CONF" "$CARGO" "$CARGO_LOCK" "$FUZZ_LOCK" "$PKG" "$PKG_LOCK"; do
  if [ "$v" != "$NEW_VERSION" ]; then
    echo "ERROR: post-bump sanity check failed — at least one manifest is not $NEW_VERSION." >&2
    exit 1
  fi
done

echo "All manifests at $NEW_VERSION ✓"

# ── Optional: commit ────────────────────────────────────────────────────────

if [ "$DO_COMMIT" -eq 0 ]; then
  echo
  echo "Done. Review the diff with 'git diff' and commit/tag manually if it looks good."
  echo "Or re-run with --commit / --tag / --push to automate the rest."
  exit 0
fi

# Re-assert HEAD is on main immediately before the staging+commit pair.
# Defensive against anything that could have moved HEAD between the
# entry-point guard above and here (manifest edits, biome format, cargo
# update, post-tool-use hooks the maintainer's editor / harness may run
# between subprocess invocations). The check is one fork + one process
# substitution — vanishingly cheap relative to the work it guards.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ERROR: HEAD moved off 'main' to '$CURRENT_BRANCH' during the bump — refusing to commit." >&2
  echo "       The release tag must land on main; abort and investigate before retrying." >&2
  exit 1
fi

git add \
  package.json \
  package-lock.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock \
  src-tauri/fuzz/Cargo.lock \
  src-tauri/tauri.conf.json

# GPG-sign the bump commit so the `required_signatures` ruleset on `main`
# accepts it. Without `-S` the bump pushes either silently bypass via the
# maintainer admin actor (defeating the rule) or fail outright when the
# bypass is later removed. Relies on the maintainer's local
# `user.signingkey` being set (it is — `git config --get user.signingkey`
# returns the project signing key).
git commit -S -m "$(cat <<EOF
chore(release): bump version to $NEW_VERSION

Generated by scripts/bump-version.sh. Updates the 3 source-of-truth manifests
(package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json) and the 3
regenerated lock files (package-lock.json, src-tauri/Cargo.lock,
src-tauri/fuzz/Cargo.lock) in lockstep so the Release workflow's
verify-version job passes on the matching tag.
EOF
)"

echo "Committed."

# ── Optional: tag ───────────────────────────────────────────────────────────

if [ "$DO_TAG" -eq 0 ]; then
  echo "Tag with 'git tag $NEW_VERSION' when ready."
  exit 0
fi

# Refuse to clobber an existing tag — the maintainer should explicitly
# delete + retag if that's what they want.
if git rev-parse --verify --quiet "refs/tags/$NEW_VERSION" >/dev/null; then
  echo "ERROR: tag '$NEW_VERSION' already exists locally. Delete it first if intentional:" >&2
  echo "  git tag -d $NEW_VERSION && git push --delete origin $NEW_VERSION" >&2
  exit 1
fi

# Re-assert HEAD is still on main before tagging. The 0.1.37 incident
# was a tag landing on the wrong branch; this is the load-bearing
# moment for that contract. If anything has moved HEAD off main between
# the commit (above) and the tag (below), we'd be tagging the wrong
# SHA — fail loudly instead.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ERROR: HEAD moved off 'main' to '$CURRENT_BRANCH' after the bump commit — refusing to tag." >&2
  echo "       The bump commit may have landed on '$CURRENT_BRANCH' instead of main; investigate:" >&2
  echo "         git log --oneline -1 main" >&2
  echo "         git log --oneline -1 '$CURRENT_BRANCH'" >&2
  exit 1
fi

# Annotated + GPG-signed tag. `git tag -s` requires `user.signingkey` to
# be set and the agent to be unlocked; same key as the bump commit above.
# An annotated tag is what `gh attestation` and the release workflow's
# `verify-version` job both expect.
git tag -s -m "Release $NEW_VERSION" "$NEW_VERSION"
echo "Tagged $NEW_VERSION."

# ── Optional: push ──────────────────────────────────────────────────────────

if [ "$DO_PUSH" -eq 0 ]; then
  echo "Push with 'git push origin main && git push origin $NEW_VERSION' when ready."
  exit 0
fi

# The repo's pre-push hook (no-commit-to-branch=main, see prek.toml)
# blocks direct pushes to main. The release flow has always required
# --no-verify; that's an explicit maintainer decision — release commits
# go straight to main.
git push --no-verify origin main

# Between the two pushes, deliberately. The TAG push is the point of no
# return — release.yml publishes with no approval gate — so a bump commit
# that landed unverified stops the release before it starts rather than
# after. This is the assertion #3745 asked for: the "Bypassed rule
# violations" block scrolls past in a wall of push output, which is exactly
# why 0.9.4 and 0.9.8 both shipped on it unread (and, per #3745, probably
# 0.9.3 before them).
RELEASE_SHA="$(git rev-parse HEAD)"
if ! release_require_verified_commit "$RELEASE_SHA"; then
  echo "       The bump commit is on main but NO TAG WAS PUSHED, so no release was" >&2
  echo "       cut and nothing has been published. If GitHub answered verified=false," >&2
  echo "       fix the identity and land a new bump on top; do not retry the tag until" >&2
  echo "       it reports verified=true." >&2
  echo "       If instead the answer was UNREADABLE (an outage, a rate limit), nothing" >&2
  echo "       is wrong with the commit: the local tag $NEW_VERSION already exists, so" >&2
  echo "       re-ask and resume from the tag push once it answers. Do NOT re-run" >&2
  echo "       scripts/release.sh — it refuses on a version the manifests already hold:" >&2
  echo "         gh api repos/{owner}/{repo}/commits/$RELEASE_SHA --jq .commit.verification" >&2
  exit 1
fi

git push --no-verify origin "$NEW_VERSION"

# The annotated tag is signed with the same key and carries the same tagger
# address, so it fails for the same reason the commit does. By here the
# workflow has already started, so this one is loud rather than preventive.
if ! release_require_verified_tag "$NEW_VERSION"; then
  echo "       The tag is pushed and the Release workflow is ALREADY RUNNING." >&2
  echo "       Cancel it before the publish-release job if this must not ship:" >&2
  echo "         https://github.com/jfolcini/agaric/actions/workflows/release.yml" >&2
  exit 1
fi

echo "Pushed main + tag $NEW_VERSION to origin."
echo "GitHub Actions will now run the Release workflow:"
echo "  https://github.com/jfolcini/agaric/actions"
