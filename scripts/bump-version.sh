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
#   scripts/bump-version.sh --self-test
#
#   <new-version>     Semver triple, e.g. `0.1.16`. No leading `v`.
#   --commit          Stage the changed files (see `Files updated:` above)
#                     and create a release commit.
#   --tag             Create the `<new-version>` git tag (requires --commit).
#   --push            Push main + the new tag to origin (requires --tag).
#   --check-identity  Only check that the configured git identity can produce
#                     a commit GitHub will mark verified (#3745, #4082), then
#                     exit. Nothing is edited, committed or pushed.
#   --self-test       Run the identity/verification suite against fakes and
#                     exit. Touches neither the host nor the repository.
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

# Attempts / delay for the post-push verification query. Overridable only so
# the self-test below does not have to sleep; the retry exists for an API
# read-after-write blip, and a definitive `verified:false` is never retried.
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


# ── self-test ───────────────────────────────────────────────────────────────
# Behavioural suite for the identity gate and the post-push verification
# above. It USED to run as the `release-identity-selftest` prek hook;
# #4556 Phase 1 unwired that hook, so this suite runs only when invoked
# by hand until Phase 2 restages it. Everything it
# touches is a fake: `gpg` and `gh` are shadowed on PATH and `HOME` points at
# a throwaway directory, so no key is read, no API is called and neither the
# host nor the real repository is mutated. Runs before argument parsing, so
# it is fast and cannot reach a single manifest edit.
if [ "${1:-}" = "--self-test" ]; then
  st_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # Absolutised NOW: the suite cd's into its scratch directory below, and the
  # ratchets at the end read this file back off disk.
  st_self="$st_scripts_dir/$(basename "${BASH_SOURCE[0]}")"
  # A self-test that reads git config is exactly the #3722 shape: an ambient
  # GIT_DIR (which a prek hook exports) OUTRANKS the working directory, so
  # every `git config --get` below would read the REAL repository's local
  # config — including the `t@t.t` this file exists to reject — and the
  # fixtures would be silently ignored.
  # Sourced with an explicit empty argument: `.` passes the CALLER's positional
  # parameters through when given none, so the bare form would hand the helper
  # our own `--self-test` and run ITS suite in this process — which exports a
  # GIT_DIR on purpose, as its "without the guard" demonstration, and leaves
  # the scrub below refusing to run.
  # shellcheck source=scripts/lib/git-scratch-guard.sh
  . "$st_scripts_dir/lib/git-scratch-guard.sh" ''

  st_tmp="$(mktemp -d -t bump-version-selftest.XXXXXX)"
  trap 'rm -rf "$st_tmp"' EXIT
  git_scratch_guard "$st_tmp"

  st_fail=0
  st_ok() { printf '  ok   - %s\n' "$1"; }
  st_bad() {
    printf '  FAIL - %s: %s\n' "$1" "$2" >&2
    st_fail=1
  }

  # ── fakes ─────────────────────────────────────────────────────────────
  st_bin="$st_tmp/bin"
  mkdir -p "$st_bin"

  # Fake gpg. Emits colon-format records for FAKE_GPG_KEY only. One `pub`
  # record per FAKE_GPG_PUBS line carrying that line's validity character, so
  # an expired or revoked PRIMARY key and an id that resolves to MORE THAN ONE
  # key are both expressible; the UIDs come from FAKE_GPG_UIDS as
  # `<validity>|<user id>` lines, so a revoked or expired UID can be modelled
  # exactly as gpg reports it. Only the fields the production code reads are
  # populated — this is a model of gpg's answer, not of gpg.
  cat >"$st_bin/gpg" <<'FAKE_GPG'
#!/usr/bin/env bash
set -uo pipefail
key="${*: -1}"
[ "$key" = "${FAKE_GPG_KEY:-}" ] || exit 2
while IFS= read -r validity; do
  [ -n "$validity" ] || continue
  printf 'pub:%s:255:22:%s:1700000000:::u:::scESC::::::23::0:\n' "$validity" "$key"
done <<<"${FAKE_GPG_PUBS:-u}"
while IFS='|' read -r validity uid; do
  [ -n "$validity" ] || continue
  printf 'uid:%s::::1700000000::0000::%s::::::::::0:\n' "$validity" "$uid"
done <<<"${FAKE_GPG_UIDS:-}"
FAKE_GPG

  # Fake gh. Serves a canned body per API path and evaluates the REAL `--jq`
  # expression through the real jq, so the production jq programme is what is
  # under test rather than a paraphrase of it.
  cat >"$st_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -uo pipefail
[ "${1:-}" = api ] || exit 64
api_path="$2"
jq_expr=''
if [ "${3:-}" = --jq ]; then jq_expr="${4:-}"; fi
body_file="$FAKE_GH_DIR/$(printf '%s' "$api_path" | tr '/{}' '___')"
[ -f "$body_file" ] || exit 1
if [ -n "$jq_expr" ]; then
  jq -r "$jq_expr" <"$body_file"
else
  cat "$body_file"
fi
FAKE_GH

  chmod +x "$st_bin/gpg" "$st_bin/gh"
  PATH="$st_bin:$PATH"
  export PATH

  # Hardening: everything below is only safe because these fakes shadow the
  # real binaries. If PATH construction ever regressed, the suite would start
  # reading the maintainer's real keyring and calling the real GitHub API.
  for st_cmd in gpg gh; do
    st_resolved="$(command -v "$st_cmd" || true)"
    if [ "$st_resolved" != "$st_bin/$st_cmd" ]; then
      echo "not ok - refusing to run: '$st_cmd' resolves to '${st_resolved:-<nothing>}'," >&2
      echo "         not the fake in $st_bin." >&2
      exit 1
    fi
  done
  st_ok 'fakes shadow gpg and gh (no real key or API is reachable)'

  # `HOME` is where git looks for the only config file that can now reach it
  # (the scrub above removed GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and the
  # rest), and GIT_CONFIG_NOSYSTEM closes /etc/gitconfig. Without both, the
  # maintainer's own `user.signingkey` leaks into the cases that assert its
  # ABSENCE and those cases pass for the wrong reason.
  # Captured BEFORE the override: rustup resolves its toolchains under
  # `$HOME/.rustup` unless RUSTUP_HOME says otherwise, so the fuzz-lock case
  # below (the only one that runs a real binary rather than a fake) would get
  # "rustup could not choose a version of cargo to run" from the scratch HOME.
  # Only that case reads it; nothing else here may reach the real home dir.
  st_rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
  HOME="$st_tmp/home"
  mkdir -p "$HOME"
  export HOME
  GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_NOSYSTEM
  cd "$st_tmp"

  st_config() { # <name> <email> [<signingkey>] [<gpg.format>]
    {
      printf '[user]\n'
      if [ -n "$1" ]; then printf '\tname = %s\n' "$1"; fi
      if [ -n "$2" ]; then printf '\temail = %s\n' "$2"; fi
      if [ -n "${3:-}" ]; then printf '\tsigningkey = %s\n' "$3"; fi
      if [ -n "${4:-}" ]; then printf '[gpg]\n\tformat = %s\n' "$4"; fi
    } >"$HOME/.gitconfig"
  }

  # Assert the gate's verdict. <expect> is `accept` or `reject`; on `reject`
  # the diagnosis must also contain <needle>, so a case cannot pass by being
  # rejected for an unrelated reason.
  st_identity() { # <expect> <label> [<needle>]
    local expect="$1" label="$2" needle="${3:-}" problem=''
    if problem="$(release_identity_problem)"; then
      if [ "$expect" = accept ]; then
        st_ok "$label"
      else
        st_bad "$label" 'accepted, expected rejection'
      fi
      return 0
    fi
    if [ "$expect" = accept ]; then
      st_bad "$label" "rejected: $problem"
    elif [ -n "$needle" ] && [ "${problem#*"$needle"}" = "$problem" ]; then
      st_bad "$label" "rejected, but the diagnosis never mentions '$needle': $problem"
    else
      st_ok "$label"
    fi
  }

  FAKE_GPG_KEY='6CD11759A20B6111'
  export FAKE_GPG_KEY
  # One healthy primary key unless a case says otherwise (7b-7d).
  FAKE_GPG_PUBS='u'
  export FAKE_GPG_PUBS

  # 1. THE DEFECT (#3745 at 0.9.4, #4082 at 0.9.8), reproduced exactly: a
  #    good signature from a key whose UID is the maintainer's real address,
  #    on a commit committed as the placeholder `t <t@t.t>`. GitHub answers
  #    `unverified_email`; this gate must answer before the push.
  FAKE_GPG_UIDS='u|Javier Folcini <jfolcini86@gmail.com>'
  export FAKE_GPG_UIDS
  st_config 't' 't@t.t' "$FAKE_GPG_KEY"
  st_identity reject 'placeholder t@t.t is rejected (the 0.9.4 / 0.9.8 defect)' 't@t.t'

  # 2. The identity the key actually carries is accepted.
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity accept 'a committer address that is a UID on the signing key is accepted'

  # 3. Address comparison is case-insensitive — RFC-wise the domain is, and
  #    GitHub folds case, so rejecting here would be a false red. Asserted in
  #    BOTH directions: with only the config side folded, dropping the fold on
  #    the key side leaves every assertion green.
  st_config 'Javier Folcini' 'JFolcini86@Gmail.com' "$FAKE_GPG_KEY"
  st_identity accept 'a mixed-case committer address matches its lower-case UID'
  FAKE_GPG_UIDS='u|Javier Folcini <JFolcini86@Gmail.com>'
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity accept 'a lower-case committer address matches its mixed-case UID'
  FAKE_GPG_UIDS='u|Javier Folcini <jfolcini86@gmail.com>'

  # 3c. …and the match is EXACT, not a substring. `grep -Fxq` is what makes it
  #     so, and with `-Fx` weakened to `-F` every other case in this suite
  #     stays green — so the strictness of the single comparison the whole
  #     gate rests on would be unpinned. A UID that merely CONTAINS the
  #     committer address belongs to somebody else, and GitHub binds to it no
  #     more than to a UID that has nothing to do with the address.
  FAKE_GPG_UIDS='u|Someone Else <notjfolcini86@gmail.com>'
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity reject 'a UID that merely CONTAINS the committer address does not match it' \
    'is not a user ID'
  FAKE_GPG_UIDS='u|Javier Folcini <jfolcini86@gmail.com>'

  # 4. A REVOKED UID does not count. GitHub will not bind to it, so counting
  #    it would make the gate pass on the configuration that fails at push.
  #    A second, usable UID keeps the "key has no usable UID at all" branch
  #    out of the way, so this case can only pass on the exclusion itself.
  FAKE_GPG_UIDS='u|Javier Folcini <other@example.invalid>
r|Javier Folcini <jfolcini86@gmail.com>'
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity reject 'a revoked UID does not satisfy the gate' 'is not a user ID'

  # 5. An EXPIRED UID likewise.
  FAKE_GPG_UIDS='u|Javier Folcini <other@example.invalid>
e|Javier Folcini <jfolcini86@gmail.com>'
  st_identity reject 'an expired UID does not satisfy the gate' 'is not a user ID'

  # 5b. The exclusion is a FILTER, not a blanket. The same address on a
  #     revoked UID *and* a usable one is still bindable through the usable
  #     one, so it must be accepted — a rule of "reject any address that
  #     appears in a revoked UID" would satisfy cases 4 and 5 and be wrong.
  FAKE_GPG_UIDS='r|Javier Folcini <jfolcini86@gmail.com>
u|Javier Folcini <jfolcini86@gmail.com>'
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity accept 'an address carried by BOTH a revoked and a usable UID is accepted'

  FAKE_GPG_UIDS='u|Javier Folcini <jfolcini86@gmail.com>'

  # 6. No signing key: `git commit -S` would pick one by guesswork.
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' ''
  st_identity reject 'a missing user.signingkey is rejected' 'signingkey'

  # 7. A key gpg does not know about yields no UIDs at all.
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' 'DEADBEEFDEADBEEF'
  st_identity reject 'a signing key with no usable UID is rejected' 'DEADBEEFDEADBEEF'

  # 7b. An EXPIRED PRIMARY KEY. gpg 2.4.4 stamps the expiry on the UID records
  #     too (measured), so the UID filter alone would already reject this —
  #     but it would blame the user IDs for a key that has simply lapsed, and
  #     that mirroring is a gpg behaviour rather than a promise. Modelled with
  #     USABLE UIDs precisely so only the `pub` record can reject it.
  FAKE_GPG_PUBS='e'
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity reject 'an expired signing key is rejected, and named as expired' 'EXPIRED'

  # 7c. A REVOKED PRIMARY KEY, the same way.
  FAKE_GPG_PUBS='r'
  st_identity reject 'a revoked signing key is rejected, and named as revoked' 'REVOKED'

  # 7d. An AMBIGUOUS `user.signingkey`. `git commit -S` hands the configured
  #     id straight to gpg, and a short id or a bare email can name two keys
  #     in one keyring (measured on gpg 2.4.4: two keys sharing a UID address
  #     answer one `--list-keys <address>` with two `pub` records). gpg then
  #     picks one, which need not be the key whose UID matched — so accepting
  #     here would pass a signature that cannot bind. Both UIDs stay usable
  #     and matching, so only the key COUNT can reject this.
  FAKE_GPG_PUBS='u
u'
  st_identity reject 'a user.signingkey resolving to more than one key is rejected' \
    'matches 2 keys'
  FAKE_GPG_PUBS='u'

  # 7e. gpg ABSENT. Without its own branch the diagnosis is "no usable user
  #     ID", which sends a maintainer on a fresh machine hunting a key defect
  #     that does not exist — and this gate has no bypass flag, so a
  #     misleading message is the whole of the remedy. PATH is narrowed to
  #     symlinks of the commands the gate reaches BEFORE the gpg probe, so the
  #     real gpg is not merely shadowed here, it is unreachable.
  st_nogpg="$st_tmp/nogpg"
  mkdir -p "$st_nogpg"
  for st_cmd in git sed tr awk sort grep; do
    ln -sf "$(command -v "$st_cmd")" "$st_nogpg/$st_cmd"
  done
  # Subshell for the same reason as case 9: `st_fail` set inside cannot
  # propagate out, so the subshell's exit status carries the verdict.
  if ! (
    PATH="$st_nogpg"
    export PATH
    if command -v gpg >/dev/null 2>&1; then
      st_bad 'gpg absent is diagnosed as gpg absent' \
        'gpg is still reachable on the narrowed PATH; the case would prove nothing'
    else
      st_identity reject 'gpg absent is diagnosed as gpg absent, not as a key defect' \
        'not on PATH'
    fi
    [ "$st_fail" = 0 ]
  ); then
    st_fail=1
  fi

  # 8. Missing name / email — the DCO trailer cannot be written from either.
  st_config '' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  st_identity reject 'an unset user.name is rejected' 'user.name'
  st_config 'Javier Folcini' '' "$FAKE_GPG_KEY"
  st_identity reject 'an unset user.email is rejected' 'user.email'

  # 9. #4082's third symptom: the sign-off says one identity and the commit
  #    is committed as another. `GIT_COMMITTER_EMAIL` is the sharpest way to
  #    produce that split, and `git var` is why the gate can see it at all.
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"
  # In a subshell, because the override has to be exported for `git var` to
  # see it and must not leak into the cases below. `st_fail` set in there
  # cannot propagate out, so the subshell's own exit status carries the
  # verdict instead — without that trailing test the case printed FAIL and
  # the suite still exited 0.
  if ! (
    export GIT_COMMITTER_EMAIL='someone-else@example.invalid'
    st_identity reject 'a committer address that disagrees with the DCO trailer is rejected' 'Signed-off-by'
    [ "$st_fail" = 0 ]
  ); then
    st_fail=1
  fi

  # 9b. The AUTHOR side of the same split (#4561). The trailer is written from
  #     `GIT_AUTHOR_IDENT`, so an author override produces the identical
  #     "sign-off asserts a different identity from the one that signed" state
  #     — and before #4561 this gate read `user.email` and could not see it.
  #     Without this case the suite passes identically whether the comparison
  #     reads the author or the config, which is the assertion-true-for-the-
  #     wrong-reason shape #4561 is itself about.
  if ! (
    export GIT_AUTHOR_EMAIL='author-override@example.invalid'
    st_identity reject 'an AUTHOR address that disagrees with the committer is rejected' 'Signed-off-by'
    [ "$st_fail" = 0 ]
  ); then
    st_fail=1
  fi

  # 9c. `user.email` disagreeing with the author is its own refusal: the
  #     release would be cut under an identity the repository config does not
  #     name. Both author and committer are overridden together here, so the
  #     9b comparison is SATISFIED and only the config-vs-author branch can
  #     fire — otherwise this case would pass on 9b's rejection and pin
  #     nothing of its own.
  if ! (
    export GIT_AUTHOR_EMAIL='override@example.invalid'
    export GIT_COMMITTER_EMAIL='override@example.invalid'
    st_identity reject 'user.email disagreeing with the overridden author is rejected' 'user.email'
    [ "$st_fail" = 0 ]
  ); then
    st_fail=1
  fi

  # 10. SSH signing has no UID list to compare against, so the gate asserts
  #     only what it can see and leaves the post-push check authoritative.
  st_config 'Javier Folcini' 'jfolcini86@gmail.com' '' 'ssh'
  st_identity accept 'ssh signing skips the UID comparison rather than inventing a rule'

  st_config 'Javier Folcini' 'jfolcini86@gmail.com' "$FAKE_GPG_KEY"

  # ── post-push verification ────────────────────────────────────────────
  FAKE_GH_DIR="$st_tmp/gh"
  mkdir -p "$FAKE_GH_DIR"
  export FAKE_GH_DIR
  RELEASE_VERIFY_DELAY=0
  RELEASE_VERIFY_ATTEMPTS=2

  st_gh_body() { printf '%s' "$2" >"$FAKE_GH_DIR/$(printf '%s' "$1" | tr '/{}' '___')"; }

  # 11. GitHub says verified — the release proceeds.
  st_gh_body 'repos/{owner}/{repo}/commits/2e10dd82' \
    '{"commit":{"verification":{"verified":true,"reason":"valid"}}}'
  if release_require_verified_commit 2e10dd82 >/dev/null 2>&1; then
    st_ok 'a commit GitHub reports as verified passes the post-push gate'
  else
    st_bad 'a commit GitHub reports as verified passes the post-push gate' 'rejected'
  fi

  # 12. The 0.9.8 answer verbatim. This is the assertion that never existed:
  #     the bypass block scrolled past and three releases shipped on it.
  st_gh_body 'repos/{owner}/{repo}/commits/2e10dd82' \
    '{"commit":{"verification":{"verified":false,"reason":"unverified_email"}}}'
  st_out="$(release_require_verified_commit 2e10dd82 2>&1)" && st_rc=0 || st_rc=$?
  if [ "$st_rc" = 0 ]; then
    st_bad 'an unverified commit fails the post-push gate' 'accepted verified=false'
  elif [ "${st_out#*unverified_email}" = "$st_out" ]; then
    st_bad 'an unverified commit fails the post-push gate' "reason not reported: $st_out"
  else
    st_ok 'an unverified commit fails the post-push gate, naming the reason'
  fi

  # 13. No answer at all is a FAILURE, not a pass — an unread verification
  #     has established nothing. A SHA that was never given a canned body, so
  #     the case cannot silently re-read case 12's: an earlier draft deleted
  #     the body by re-deriving the fake's filename, got the mangling wrong,
  #     and passed against the `verified:false` payload it meant to remove.
  if release_require_verified_commit 00000000deadbeef >/dev/null 2>&1; then
    st_bad 'an unreadable verification fails closed' 'accepted with no answer from the API'
  else
    st_ok 'an unreadable verification fails closed'
  fi

  # 13b. The shapes a real failure actually arrives in. `gh api --jq` treats a
  #      404 body and a rate-limit body as ordinary JSON, so "the API
  #      answered" and "the API answered THIS" are different questions; and
  #      `.verified` on a missing verification block is jq's `null`, which
  #      must not read as a pass. One canned path, rewritten per shape.
  st_no_pass() { # <label> <body>
    st_gh_body 'repos/{owner}/{repo}/commits/deadc0de' "$2"
    if release_require_verified_commit deadc0de >/dev/null 2>&1; then
      st_bad "$1" 'accepted — the gate passed without ever reading verified=true'
    else
      st_ok "$1"
    fi
  }
  st_no_pass 'an empty API body cannot pass the post-push gate' ''
  st_no_pass 'a 404 body cannot pass the post-push gate' \
    '{"message":"Not Found","status":"404"}'
  st_no_pass 'a rate-limit body cannot pass the post-push gate' \
    '{"message":"API rate limit exceeded for user ID 1."}'
  st_no_pass 'a commit body with no verification block cannot pass the post-push gate' \
    '{"commit":{"message":"chore(release): bump version to 0.9.8"}}'

  # 14. The tag object is checked the same way, through the ref (#3745 —
  #     `tag.gpgsign` makes the tag fail for exactly the same reason).
  st_gh_body 'repos/{owner}/{repo}/git/ref/tags/0.9.8' '{"object":{"sha":"aaaa1111"}}'
  st_gh_body 'repos/{owner}/{repo}/git/tags/aaaa1111' \
    '{"verification":{"verified":false,"reason":"unverified_email"}}'
  if release_require_verified_tag 0.9.8 >/dev/null 2>&1; then
    st_bad 'an unverified tag fails the post-push gate' 'accepted verified=false'
  else
    st_ok 'an unverified tag fails the post-push gate'
  fi
  st_gh_body 'repos/{owner}/{repo}/git/tags/aaaa1111' \
    '{"verification":{"verified":true,"reason":"valid"}}'
  if release_require_verified_tag 0.9.8 >/dev/null 2>&1; then
    st_ok 'a verified tag passes the post-push gate'
  else
    st_bad 'a verified tag passes the post-push gate' 'rejected'
  fi

  # 14b. A tag ref that does not resolve to an object is not a verified tag.
  #      Same fail-closed rule one step earlier in the chain: the ref lookup
  #      is a second place the API can decline to answer.
  #      Asserted on the DIAGNOSIS, not just the exit status: with the
  #      early return deleted the tag lookup still fails closed one step
  #      later, on the empty object path — so a status-only assertion would
  #      stay green while the branch it names had gone.
  st_gh_body 'repos/{owner}/{repo}/git/ref/tags/0.9.9' '{"message":"Not Found"}'
  st_out="$(release_require_verified_tag 0.9.9 2>&1)" && st_rc=0 || st_rc=$?
  if [ "$st_rc" = 0 ]; then
    st_bad 'a tag ref that resolves to no object fails closed' 'accepted with no tag object'
  elif [ "${st_out#*could not resolve}" = "$st_out" ]; then
    st_bad 'a tag ref that resolves to no object fails closed' \
      "failed, but not on the ref lookup: $st_out"
  else
    st_ok 'a tag ref that resolves to no object fails closed, naming the ref lookup'
  fi

  # 15. The fuzz-lock bump (#4279). This is the one production path the rest
  #     of the suite cannot reach: it first executes at a real release. What
  #     is untested is not the shell around it but CARGO's acceptance of
  #     `--precise` for a dependency declared as `path = ".."` with NO
  #     `version` field — a different shape from the parent `cargo update`
  #     call two lines above it in production, where `agaric` is a workspace
  #     MEMBER. Model exactly that shape: a package named `agaric`, and a
  #     nested crate carrying its own `[workspace]` table (so it is excluded
  #     from the parent workspace, as src-tauri/fuzz is) that depends on it
  #     by path alone.
  #
  #     Hermetic: the fixture has ZERO registry dependencies, so `--offline`
  #     against a scratch CARGO_HOME resolves the whole graph out of the two
  #     local manifests — no crates.io, no network, and no read or write of
  #     the developer's real cargo state. (Production deliberately does NOT
  #     pass `--offline`; a real release may need the index. That does not
  #     change what is asserted here, which is how cargo treats `--precise`
  #     on a path dep.)
  #
  #     Skipped, loudly, if cargo is absent — this hook also runs in the
  #     dco-signoff/git-scratch-guard file set, and a missing toolchain is a
  #     reason to say so rather than to red an unrelated commit.
  #
  #     "Absent" means UNRUNNABLE, not just off `$PATH`. On a rustup install,
  #     `cargo` on `$PATH` is a shim that still has to CHOOSE a toolchain, and
  #     it can fail to: the fixture lives outside this repo, so
  #     `rust-toolchain.toml` does not apply to it, and a machine whose rustup
  #     has no DEFAULT toolchain (directory overrides only) gets "rustup could
  #     not choose a version of cargo to run". That is the same "unrelated
  #     commit reddened by a toolchain this case does not test" outcome the
  #     `command -v` skip exists to prevent, so probe for it the same way.
  #     The probe mirrors the real calls exactly — same cwd (rustup resolves
  #     directory overrides from it), same scrubbed `HOME`, same restored
  #     `RUSTUP_HOME`, same scratch `CARGO_HOME` — so it cannot pass where
  #     they would fail. `cargo --version` builds nothing and touches no
  #     network.
  st_fuzz="$st_tmp/fuzzshape"
  mkdir -p "$st_fuzz/src" "$st_fuzz/nested/src" "$st_fuzz/cargo-home"
  if ! command -v cargo >/dev/null 2>&1; then
    printf '  SKIP - the fuzz-lock bump shape (cargo not on PATH)\n' >&2
  elif ! st_cargo_probe="$( cd "$st_fuzz/nested" \
      && RUSTUP_HOME="$st_rustup_home" CARGO_HOME="$st_fuzz/cargo-home" \
         cargo --version 2>&1 )"; then
    printf '  SKIP - the fuzz-lock bump shape (cargo is on PATH but cannot run here: %s)\n' \
      "$st_cargo_probe" >&2
  else
    printf '[package]\nname = "agaric"\nversion = "0.9.8"\nedition = "2021"\n\n[workspace]\n' \
      >"$st_fuzz/Cargo.toml"
    : >"$st_fuzz/src/lib.rs"
    printf '[package]\nname = "agaric-fuzz-fixture"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[workspace]\n\n[dependencies.agaric]\npath = ".."\n' \
      >"$st_fuzz/nested/Cargo.toml"
    : >"$st_fuzz/nested/src/lib.rs"
    st_fuzz_pin() { awk '/^name = "agaric"$/{getline; print; exit}' \
      "$st_fuzz/nested/Cargo.lock" | cut -d'"' -f2; }
    # Subshell: CARGO_HOME and the cd must not leak into the ratchets below.
    if ! ( cd "$st_fuzz/nested" \
        && RUSTUP_HOME="$st_rustup_home" CARGO_HOME="$st_fuzz/cargo-home" \
           cargo generate-lockfile --offline ) >/dev/null 2>&1; then
      st_bad 'the fuzz-lock fixture resolves offline' \
        'cargo generate-lockfile failed on a fixture with no registry deps'
    elif [ "$(st_fuzz_pin)" != '0.9.8' ]; then
      st_bad 'the fuzz-lock fixture resolves offline' \
        "fixture lock pinned agaric at '$(st_fuzz_pin)', expected 0.9.8"
    else
      st_ok 'the fuzz-lock fixture resolves offline (path dep, no registry)'
      # The bump production performs: parent manifest already at the NEW
      # version (bump-version.sh seds it first), then `--precise` in the
      # nested workspace.
      printf '[package]\nname = "agaric"\nversion = "0.9.9"\nedition = "2021"\n\n[workspace]\n' \
        >"$st_fuzz/Cargo.toml"
      st_fuzz_out="$( ( cd "$st_fuzz/nested" \
        && RUSTUP_HOME="$st_rustup_home" CARGO_HOME="$st_fuzz/cargo-home" \
           cargo update --offline -p agaric --precise 0.9.9 ) 2>&1 )" \
        && st_fuzz_rc=0 || st_fuzz_rc=$?
      if [ "$st_fuzz_rc" != 0 ]; then
        st_bad 'cargo accepts --precise for a path-dependency agaric' \
          "cargo update exited $st_fuzz_rc: $st_fuzz_out"
      elif [ "$(st_fuzz_pin)" != '0.9.9' ]; then
        st_bad 'cargo accepts --precise for a path-dependency agaric' \
          "cargo update exited 0 but the lock still pins '$(st_fuzz_pin)'"
      else
        st_ok 'cargo accepts --precise for a path-dependency agaric (lock repinned)'
      fi
    fi
  fi

  # ── wiring ratchets ───────────────────────────────────────────────────
  # The cases above prove the functions behave; these prove the script still
  # CALLS them, in the one order that matters. Without them the gates could
  # be deleted from the flow with every assertion above still green.
  #
  # Only the production half of the file is scanned — everything from the
  # argument parser down — so the pattern strings written here cannot match
  # themselves and make a ratchet tautological.
  st_production() { sed -n '/^# ── Argument parsing/,$p' "$st_self" | grep -vE '^[[:space:]]*#'; }
  # `|| true` because of `pipefail`: a pattern that matches NOTHING makes the
  # pipeline fail, and `set -e` would then kill the suite with exit 1 and no
  # diagnosis at all — the "no line matches /…/" branch below was unreachable
  # until this was added.
  st_where() { st_production | grep -nE "$1" | head -1 | cut -d: -f1 || true; }

  st_prod_lines="$(st_production | wc -l)"
  if [ "$st_prod_lines" -lt 100 ]; then
    st_bad 'the ratchets scan a real production slice' \
      "only $st_prod_lines lines matched; the ratchets below would be vacuous"
  else
    st_ok "the ratchets scan a real production slice ($st_prod_lines lines)"
  fi

  st_order() { # <label> <earlier-pattern> <later-pattern>
    local label="$1" first second
    first="$(st_where "$2")"
    second="$(st_where "$3")"
    if [ -z "$first" ]; then
      st_bad "$label" "no line matches /$2/"
    elif [ -z "$second" ]; then
      st_bad "$label" "no line matches /$3/"
    elif [ "$first" -ge "$second" ]; then
      st_bad "$label" "/$2/ is at line $first, /$3/ at $second — wrong order"
    else
      st_ok "$label"
    fi
  }

  st_order 'the identity gate runs before the signed commit' \
    'release_require_identity$' '^git commit -S'
  st_order 'the main push is followed by the commit verification' \
    '^git push --no-verify origin main$' 'release_require_verified_commit "'
  st_order 'the commit is verified BEFORE the tag push (the point of no return)' \
    'release_require_verified_commit "' '^git push --no-verify origin "\$NEW_VERSION"$'
  st_order 'the tag push is followed by the tag verification' \
    '^git push --no-verify origin "\$NEW_VERSION"$' 'release_require_verified_tag "'

  # #4279: case 15 above proves cargo ACCEPTS the call; these prove the script
  # still MAKES it, in the only order that works. The fuzz workspace resolves
  # `agaric` from `../Cargo.toml`, so the parent manifest must already carry
  # the new version when `--precise` runs; and the post-bump sanity loop is
  # worthless if it reads a lock nothing regenerated.
  st_order 'the fuzz lock is bumped only after src-tauri/Cargo.toml carries the new version' \
    'sed -i\.bak .*src-tauri/Cargo\.toml$' \
    'cd src-tauri/fuzz && cargo update -p agaric --precise'
  st_order 'the fuzz lock is bumped before the sanity check reads it back' \
    'cd src-tauri/fuzz && cargo update -p agaric --precise' \
    '^FUZZ_LOCK='

  # release.sh's preflight is only a fast-fail — the gate above is what makes
  # the release safe — but it is the difference between learning about a bad
  # identity now and learning about it after a 5-10 minute release build, and
  # nothing else would notice it going away.
  st_release_sh() { grep -vE '^[[:space:]]*#' "$st_scripts_dir/release.sh"; }
  st_release_where() { st_release_sh | grep -nE "$1" | head -1 | cut -d: -f1 || true; }
  st_check_at="$(st_release_where 'bump-version\.sh --check-identity')"
  st_build_at="$(st_release_where 'verify-release-build\.sh$')"
  if [ -z "$st_check_at" ]; then
    st_bad 'release.sh checks the identity before it spends minutes on a build' \
      'release.sh never runs `bump-version.sh --check-identity`'
  elif [ -z "$st_build_at" ]; then
    st_bad 'release.sh checks the identity before it spends minutes on a build' \
      'release.sh never runs verify-release-build.sh'
  elif [ "$st_check_at" -ge "$st_build_at" ]; then
    st_bad 'release.sh checks the identity before it spends minutes on a build' \
      "--check-identity is at line $st_check_at, the build at $st_build_at"
  else
    st_ok 'release.sh checks the identity before it spends minutes on a build'
  fi

  if [ "$st_fail" != 0 ]; then
    echo 'release identity self-test FAILED' >&2
    exit 1
  fi
  echo 'release identity self-test passed'
  exit 0
fi

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
