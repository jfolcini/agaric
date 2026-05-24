#!/usr/bin/env bash
#
# release.sh — the single, canonical entry point for cutting an Agaric release.
#
# One command, start to finish:
#
#     scripts/release.sh <new-version>          # e.g. scripts/release.sh 0.2.1
#
# What it does, in order:
#   1. Preflight — clean tree, HEAD on main, local main in sync with origin,
#      required tools present, tag does not already exist.
#   2. Local release-build verification (scripts/verify-release-build.sh):
#      a full `cargo tauri build` + bundle-path probes for THIS OS, so
#      release-only failures surface locally before a CI run is spent.
#      Skip with --skip-verify-build.
#   3. Bump all 5 version manifests in lockstep, commit (GPG-signed), tag
#      (GPG-signed), and push main + the tag (scripts/bump-version.sh).
#   4. The pushed tag triggers .github/workflows/release.yml, which builds
#      every platform and DRAFTS the GitHub Release.
#
# Then: review the draft on the Releases page and click Publish. The release
# workflow drafts — it never auto-publishes.
#
# Why the bump is local and there is no CI "release" button: pushing the bump
# commit to `main` requires bypassing the branch ruleset. The in-workflow
# GITHUB_TOKEN is NOT a ruleset bypass actor (and its pushes don't trigger
# workflows anyway), so a CI bump can't land without a long-lived PAT — which
# we reject on security grounds. The maintainer IS an admin bypass actor, so
# the bump is cut locally and only the resulting tag triggers CI. This keeps
# the branch protection intact (1 review + admin bypass) with no PAT.
#
# Flags:
#   --skip-verify-build   Skip the local bundle build (faster; relies on CI).
#   --dry-run             Bump + commit + tag locally but DO NOT push.
#   -y, --yes             Skip the confirmation prompt.
#   -h, --help            Show this help.

set -euo pipefail

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed 's/^# \{0,1\}//; s/^#$//' | sed '$d'
}

# ── Argument parsing ────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  echo "ERROR: missing <new-version> argument." >&2
  echo "Usage: $0 <new-version> [--skip-verify-build] [--dry-run] [-y]" >&2
  exit 2
fi

NEW_VERSION=""
SKIP_VERIFY_BUILD=0
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --skip-verify-build) SKIP_VERIFY_BUILD=1 ;;
    --dry-run)           DRY_RUN=1 ;;
    -y|--yes)            ASSUME_YES=1 ;;
    -h|--help)           usage; exit 0 ;;
    -*)
      echo "ERROR: unknown flag '$arg'" >&2
      echo "Usage: $0 <new-version> [--skip-verify-build] [--dry-run] [-y]" >&2
      exit 2
      ;;
    *)
      if [ -n "$NEW_VERSION" ]; then
        echo "ERROR: unexpected extra argument '$arg' (version already set to '$NEW_VERSION')." >&2
        exit 2
      fi
      NEW_VERSION="$arg"
      ;;
  esac
done

# Strip an accidental leading `v` so callers can pass either shape.
NEW_VERSION="${NEW_VERSION#v}"

if ! echo "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'; then
  echo "ERROR: '$NEW_VERSION' is not a valid semver triple (expected X.Y.Z[-prerelease])." >&2
  exit 2
fi

# ── Repo root + tool check ──────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: not inside a git repository." >&2
  exit 1
fi
cd "$REPO_ROOT"

for cmd in git gh jq cargo node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

# ── Preflight: branch, sync, cleanliness, tag freshness ─────────────────────

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ERROR: HEAD is on '$CURRENT_BRANCH', not 'main'. Releases are cut from main." >&2
  echo "       Run: git checkout main && git pull" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree has uncommitted changes; commit or stash them first." >&2
  git status --short >&2
  exit 1
fi

echo "→ fetching origin/main to confirm local main is in sync"
git fetch --quiet origin main
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "ERROR: local main ($LOCAL_SHA) and origin/main ($REMOTE_SHA) differ." >&2
  echo "       Run 'git pull --ff-only' (or push your main commits) so the release tag" >&2
  echo "       lands on the same SHA reviewers see on GitHub, then re-run." >&2
  exit 1
fi

CURRENT_VERSION="$(jq -r .version package.json)"
if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "ERROR: already at $NEW_VERSION — nothing to release." >&2
  exit 1
fi

if git rev-parse --verify --quiet "refs/tags/$NEW_VERSION" >/dev/null; then
  echo "ERROR: tag '$NEW_VERSION' already exists locally." >&2
  echo "       Delete it first if this is intentional:" >&2
  echo "         git tag -d $NEW_VERSION && git push --delete origin $NEW_VERSION" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$NEW_VERSION" >/dev/null 2>&1; then
  echo "ERROR: tag '$NEW_VERSION' already exists on origin." >&2
  echo "       Pick a new version, or delete the remote tag if this is intentional:" >&2
  echo "         git push --delete origin $NEW_VERSION" >&2
  exit 1
fi

# ── Confirm ─────────────────────────────────────────────────────────────────

echo
echo "Release plan:"
echo "  version:        $CURRENT_VERSION → $NEW_VERSION"
echo "  from commit:    $(git rev-parse --short HEAD) ($(git log -1 --pretty=%s))"
if [ "$SKIP_VERIFY_BUILD" -eq 1 ]; then
  echo "  local build:    SKIPPED (--skip-verify-build; CI is the only gate)"
else
  echo "  local build:    cargo tauri build + bundle probes for $(uname -s) (~5-10 min)"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  push:           NO (--dry-run — bump + commit + tag locally only)"
else
  echo "  push:           main + tag $NEW_VERSION → origin (triggers the Release workflow → DRAFT release)"
fi
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Proceed? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# ── Local release-build verification ────────────────────────────────────────

if [ "$SKIP_VERIFY_BUILD" -eq 1 ]; then
  echo "→ skipping local release-build verification (--skip-verify-build)"
else
  echo "→ verifying release build locally (scripts/verify-release-build.sh)"
  scripts/verify-release-build.sh
fi

# ── Bump + commit + tag (+ push) ────────────────────────────────────────────

if [ "$DRY_RUN" -eq 1 ]; then
  echo "→ bumping + committing + tagging locally (dry run — no push)"
  scripts/bump-version.sh "$NEW_VERSION" --commit --tag
  echo
  echo "Dry run complete. Review with:  git show $NEW_VERSION"
  echo "When ready, push manually:      git push origin main && git push origin $NEW_VERSION"
  echo "Or re-run without --dry-run to push automatically."
  exit 0
fi

echo "→ bumping + committing + tagging + pushing (scripts/bump-version.sh)"
scripts/bump-version.sh "$NEW_VERSION" --commit --tag --push

echo
echo "✓ Released $NEW_VERSION. The Release workflow is now building every platform:"
echo "    https://github.com/jfolcini/agaric/actions/workflows/release.yml"
echo "  When it finishes, review the DRAFT and click Publish:"
echo "    https://github.com/jfolcini/agaric/releases"
