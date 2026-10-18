#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Picks the e2e specs a change can affect, in both lanes, and prints the
# command that runs each lane's pick (`just e2e-related`). It runs nothing:
# CI runs both full suites; this is for choosing what to run before a push.
#
# Every top-level test or describe title in both lanes ends with its area tags,
# `… @editor @pages`; Playwright reads them as native tags (`--grep @editor`).
# `scripts/e2e-related.test.mjs` (node:test, run by `lint`) fails a spec without a known one.
#
# A changed path selects specs by the first rule it matches:
#   *.md, vitest tests, Rust test-only trees   nothing (no e2e lane runs them)
#   a spec that still exists                   that spec
#   e2e/helpers.ts, src/lib/tauri-mock*,       the whole Playwright lane
#   playwright.config.ts
#   any other e2e-tauri/*.ts, wdio.conf.ts,    the whole WebdriverIO lane
#   tsconfig.wdio.json, src-tauri/migrations/**
#   package.json, package-lock.json,           both whole lanes
#   tsconfig*.json, vite.config.ts, index.html,
#   src-tauri/tauri.conf.json
#   src/**, public/**                          both lanes' specs tagged with an
#                                              area whose word the path holds,
#                                              or both whole lanes if none does
#   src-tauri/**                               the same in the WebdriverIO lane
#                                              only: the mock lane has no backend
#   anything else                              nothing
#
# Diff sources (the last one given wins):
#   --cached         (default) files in the git index
#   --range REVSPEC  files differing in a commit range, e.g. `--range main...HEAD`
#   --worktree       uncommitted work: staged, unstaged and untracked files
#                    against HEAD (`just e2e-related`)
#   --stdin          one repo-relative path per line on stdin
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail
export LC_ALL=C # byte-order sort, the same on every machine

# `<area>: <words>`. A path takes every area one of whose words it contains,
# lowercased. The areas are the vocabulary the spec tags draw from.
AREA_WORDS=(
  'attachments: attachment image camera microphone voice speech pdf'
  'boot: boot onboarding welcome recovery'
  'editor: editor block property properties slash clipboard undo draft toolbar emoji
    callout task priority liststyle list-style template richcontent mermaid katex diagram'
  'graph: graph'
  'journal: journal agenda calendar recurrence repeat reminder duepanel reschedule
    week quickcapture quick-capture'
  'markdown: markdown import export turndown serializ source-buffer'
  'mcp: mcp agent'
  'mobile: mobile android touch platform haptic gesture swipe keyboard-inset
    longpress pulltodismiss softkeyboard'
  'pages: page backlink alias tag trash history link reference rename bookmark
    tabbar tabs'
  'search: search fts query filter palette'
  'settings: setting preference theme keyboard-config shortcut font language
    bug-report bugreport'
  'spaces: space'
  'sync: sync peer pairing unpair mdns transport device'
)

SOURCE="cached"
LABEL="staged"
RANGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cached)
      SOURCE="cached"; LABEL="staged"; shift ;;
    --range)
      RANGE="${2:-}"
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      SOURCE="range"; LABEL="range $RANGE"; shift 2 ;;
    --worktree)
      SOURCE="worktree"; LABEL="working tree"; shift ;;
    --stdin)
      SOURCE="stdin"; LABEL="stdin"; shift ;;
    *)
      echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "ERROR: e2e-related.sh must run inside a Git worktree." >&2
  exit 2
fi

list_changed() {
  case "$SOURCE" in
    cached)   git -C "$REPO_ROOT" diff --cached --name-only --no-renames ;;
    range)    git -C "$REPO_ROOT" diff "$RANGE" --name-only --no-renames ;;
    worktree) git -C "$REPO_ROOT" diff HEAD --name-only --no-renames \
                && git -C "$REPO_ROOT" ls-files --others --exclude-standard ;;
    stdin)    cat ;;
  esac
}

# A git failure (a bad revspec) must not read as "nothing changed".
if ! CHANGED_RAW=$(list_changed); then
  echo "ERROR: could not list the $LABEL changes." >&2
  exit 2
fi
mapfile -t CHANGED <<< "$CHANGED_RAW"

AREAS_OF=()
areas_of() { # <path> → sets AREAS_OF
  local path entry word
  path=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  AREAS_OF=()
  for entry in "${AREA_WORDS[@]}"; do
    for word in ${entry#*:}; do
      if [[ "$path" == *"$word"* ]]; then AREAS_OF+=("${entry%%:*}"); break; fi
    done
  done
}

PW_FULL="" WD_FULL=""
PW_AREAS=() WD_AREAS=() PW_SPECS=() WD_SPECS=()
for f in "${CHANGED[@]}"; do
  case "$f" in
    ''|*.md|*.test.ts|*.test.tsx|*/__tests__/*|src/test-setup.ts|*/snapshots/*|*/.sqlx/*) ;;
    src-tauri/tests/*|src-tauri/benches/*|src-tauri/fuzz/*|src-tauri/gen/*) ;;
    src-tauri/proptest-regressions/*|src-tauri/*.txt) ;;
    e2e/*.spec.ts)
      if [ -f "$REPO_ROOT/$f" ]; then PW_SPECS+=("$f"); fi ;;
    e2e-tauri/*.e2e.ts)
      if [ -f "$REPO_ROOT/$f" ]; then WD_SPECS+=("$f"); fi ;;
    e2e/*|src/lib/tauri-mock*|playwright.config.ts)
      PW_FULL="$f" ;;
    e2e-tauri/*.ts|wdio.conf.ts|tsconfig.wdio.json|src-tauri/migrations/*)
      WD_FULL="$f" ;;
    # `src-tauri/tauri.conf.json`: e2e/interface-zoom.spec.ts sizes its viewport from it.
    package.json|package-lock.json|tsconfig*.json|vite.config.ts|index.html|src-tauri/tauri.conf.json)
      PW_FULL="$f"; WD_FULL="$f" ;;
    src/*|public/*)
      areas_of "$f"
      if [ ${#AREAS_OF[@]} -eq 0 ]; then
        PW_FULL="$f (no area)"; WD_FULL="$f (no area)"
      else
        PW_AREAS+=("${AREAS_OF[@]}"); WD_AREAS+=("${AREAS_OF[@]}")
      fi ;;
    src-tauri/*)
      areas_of "$f"
      if [ ${#AREAS_OF[@]} -eq 0 ]; then
        WD_FULL="$f (no area)"
      else
        WD_AREAS+=("${AREAS_OF[@]}")
      fi ;;
  esac
done

# The specs matching <glob> that carry one of the areas given. grep exits 1 on
# no match and 2 on an error (a glob that matched no file), which must fail.
tagged_specs() { # <glob> <area...>
  local glob=$1 alternation
  shift
  alternation=$(IFS='|'; echo "$*")
  # shellcheck disable=SC2086 # the glob expands to the spec files
  (cd "$REPO_ROOT" && grep -lE "[\"'\` ]@($alternation)[\"'\` ]" -- $glob) || [ $? -eq 1 ]
}

# <lane> <whole-lane reason> <command> <glob> <spec flag> <changed specs…> -- <areas…>
report_lane() {
  local lane=$1 full=$2 command=$3 glob=$4 flag=$5
  shift 5
  local specs=() areas=() matched spec line why=""
  while [ "$1" != "--" ]; do specs+=("$1"); shift; done
  shift
  if [ ${#specs[@]} -gt 0 ]; then why="changed"; fi
  if [ -n "$full" ]; then
    echo "$lane: $full changed — the whole lane"
    echo "  $command"
    return
  fi
  if [ $# -gt 0 ]; then
    readarray -t areas < <(printf '%s\n' "$@" | sort -u)
    matched=$(tagged_specs "$glob" "${areas[@]}")
    why="${why:+$why, or }tagged$(printf ' @%s' "${areas[@]}")"
    if [ -n "$matched" ]; then readarray -t -O "${#specs[@]}" specs <<< "$matched"; fi
  fi
  if [ ${#specs[@]} -eq 0 ]; then
    echo "$lane: nothing to run"
    return
  fi
  readarray -t specs < <(printf '%s\n' "${specs[@]}" | sort -u)
  echo "$lane: ${#specs[@]} spec(s), $why"
  line="  $command${flag:+ --}"
  for spec in "${specs[@]}"; do line="$line${flag:+ $flag} $spec"; done
  echo "$line"
}

echo "e2e specs for the $LABEL changes:"
report_lane Playwright "$PW_FULL" 'npx playwright test' 'e2e/*.spec.ts' '' \
  ${PW_SPECS[@]+"${PW_SPECS[@]}"} -- ${PW_AREAS[@]+"${PW_AREAS[@]}"}
report_lane WebdriverIO "$WD_FULL" 'npm run test:e2e-tauri' 'e2e-tauri/*.e2e.ts' '--spec' \
  ${WD_SPECS[@]+"${WD_SPECS[@]}"} -- ${WD_AREAS[@]+"${WD_AREAS[@]}"}
