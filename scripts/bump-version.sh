#!/usr/bin/env bash
#
# bump-version.sh — bump the project version in all 5 manifests in lockstep,
# regenerate lock files, and (optionally) commit + tag + push.
#
# The Release workflow (`.github/workflows/release.yml`) has a
# `verify-version` job that fails fast if the tag and the manifests
# disagree. Pre-this-script, the bump was a manual five-step ritual that
# the maintainer kept forgetting; this script makes it a one-liner.
#
# Files updated:
#   - src-tauri/Cargo.toml              (`version = "X.Y.Z"`)
#   - src-tauri/Cargo.lock              (regen via `cargo update -p agaric`)
#   - src-tauri/tauri.conf.json         (`"version": "X.Y.Z"`)
#   - package.json                      (`"version": "X.Y.Z"`)
#   - package-lock.json                 (regen via `npm install --package-lock-only --ignore-scripts`)
#
# Usage
# -----
#
#   scripts/bump-version.sh <new-version> [--commit] [--tag] [--push]
#
#   <new-version>     Semver triple, e.g. `0.1.16`. No leading `v`.
#   --commit          Stage the 5 changed files and create a release commit.
#   --tag             Create the `<new-version>` git tag (requires --commit).
#   --push            Push main + the new tag to origin (requires --tag).
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

for cmd in jq npm cargo git; do
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

# package-lock.json mirrors package.json; --ignore-scripts skips Tauri
# binary downloads (we just want the lock graph updated).
npm install --package-lock-only --ignore-scripts >/dev/null 2>&1

# Cargo.lock — `cargo update` with the package + precise version is the
# minimal-diff way to bump just the agaric workspace member.
( cd src-tauri && cargo update -p agaric --precise "$NEW_VERSION" >/dev/null 2>&1 )

# ── Sanity: every manifest now agrees ───────────────────────────────────────

CONF=$(jq -r .version src-tauri/tauri.conf.json)
CARGO=$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)
PKG=$(jq -r .version package.json)
PKG_LOCK=$(jq -r .version package-lock.json)
CARGO_LOCK=$(awk '/^name = "agaric"$/{getline; print; exit}' src-tauri/Cargo.lock | cut -d'"' -f2)

echo "Versions after bump:"
printf '  src-tauri/tauri.conf.json: %s\n' "$CONF"
printf '  src-tauri/Cargo.toml:      %s\n' "$CARGO"
printf '  src-tauri/Cargo.lock:      %s\n' "$CARGO_LOCK"
printf '  package.json:              %s\n' "$PKG"
printf '  package-lock.json:         %s\n' "$PKG_LOCK"

for v in "$CONF" "$CARGO" "$CARGO_LOCK" "$PKG" "$PKG_LOCK"; do
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

git add \
  package.json \
  package-lock.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json

# Co-author / signed message style is the maintainer's convention; we keep it
# simple and let the user amend if they want.
git commit -m "$(cat <<EOF
chore(release): bump version to $NEW_VERSION

Generated by scripts/bump-version.sh. Updates the 3 source-of-truth manifests
(package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json) and the 2
regenerated lock files (package-lock.json, src-tauri/Cargo.lock) in lockstep
so the Release workflow's verify-version job passes on the matching tag.
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

git tag "$NEW_VERSION"
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
git push --no-verify origin "$NEW_VERSION"

echo "Pushed main + tag $NEW_VERSION to origin."
echo "GitHub Actions will now run the Release workflow:"
echo "  https://github.com/jfolcini/agaric/actions"
