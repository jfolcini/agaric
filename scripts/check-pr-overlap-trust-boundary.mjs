#!/usr/bin/env node
// #3967 — pin the trust boundary `pr-overlap.yml` depends on, mechanically.
//
// ─── Why ─────────────────────────────────────────────────────────────────
//
// The #3672 adversarial review found `pr-overlap.yml`'s (former) `overlap`
// job holding `pull-requests: write` in the SAME job that checked out
// PR-authored code (a `pull_request` checkout is `refs/pull/N/merge`, which
// for a fork PR is code the fork author controls). That combination was safe
// today only because GitHub silently downgrades `GITHUB_TOKEN` to read-only
// for a `pull_request` run from a fork, REGARDLESS of the `permissions:`
// block asking for more — a mitigation that lives entirely in GitHub's
// defaults, not in this file, and evaporates the moment someone flips the
// trigger to `pull_request_target` (which does NOT get that downgrade) while
// keeping a checkout of PR content, e.g. because they still want the PR's
// actual diff and reach for `ref: ${{ github.event.pull_request.head.sha }}`
// to get it. That edit is exactly the shape GitHub's own security
// documentation and `pull_request_target` incident writeups describe as
// arbitrary-code-execution-with-a-privileged-token, and it is one line.
//
// #3967 split the job in two instead of relying on the default: the job that
// checks out PR-authored code (`compute`, below) now declares `permissions:
// contents: read` — NO write scope of any kind — and never sees `GH_TOKEN`;
// the job that holds `pull-requests: write` (`post`) never checks out
// PR-authored code. (`contents: read` rather than `{}` because
// `actions/checkout` authenticates its clone with `github.token` regardless
// of the `permissions:` block, so `{}` 403s the checkout on a private repo;
// `pr-overlap.yml`'s `compute` job carries that reasoning in full. What
// matters to this guard is the absence of a WRITE scope, which both spellings
// have.) That split is a structural
// fact about THIS file today. Nothing stops it rotting the way the #3672
// issue itself warned a PROSE note would: "a comment cannot enforce that,
// and comments going stale is the failure mode that caused a separate
// blocking bug in this same batch." So the invariant is checked here instead
// — the same shape as `check-android-trigger.mjs` pinning a regex against
// the paths it names, rather than trusting the regex was written correctly
// once and stays that way.
//
// ─── What this checks ──────────────────────────────────────────────────────
//
// Mechanically, on `pr-overlap.yml` only (this is not a general-purpose
// `pull_request_target` linter — zizmor already runs one over every workflow
// via the `zizmor` prek hook; this is insurance specific to the one file
// #3967 is about, same scoping choice `check-android-trigger.mjs` makes for
// `ci.yml`'s `android_re`):
//
//   1. Does the file's `on:` block name `pull_request_target` as a trigger?
//      `pull_request_target` gets a token scoped by the `permissions:` block
//      as written — no fork downgrade — which is the precondition for the
//      whole hazard.
//   2. If so, does ANY step in the file check out the PR's head content —
//      a `ref:` resolving to `github.event.pull_request.head.*`,
//      `github.head_ref`, or a literal `refs/pull/<n>/(merge|head)`?
//      A `pull_request_target` checkout with NO ref override checks out the
//      BASE branch by default — that is the actual mitigation GitHub
//      recommends, and this guard must not flag it, or it flags every safe
//      use of the trigger and nobody reads its output. It is specifically an
//      EXPLICIT head ref alongside `pull_request_target` that reintroduces
//      the #3967 hazard.
//   3. Independent of the trigger: does any JOB that declares a write
//      permission scope (`<scope>: write` or `write-all`, at the job level
//      or inherited from the top-level `permissions:` block) contain an
//      `actions/checkout` step whose `ref:` is not pinned to the PR's BASE
//      (`github.event.pull_request.base.*`)? A checkout with no `ref:` at
//      all is included — under TODAY's `pull_request` trigger that defaults
//      to `refs/pull/N/merge` (fork-controlled content), which is exactly
//      the #3967 shape even though condition 1 is false. Checks 1+2 above
//      only fire after a hypothetical trigger flip to
//      `pull_request_target`; this check fires on the file AS IT STANDS,
//      which is the only way to prove it is not vacuous — see the
//      self-test fixture that reverts this file's `compute`/`post` split
//      back to one job and confirms THIS check (not 1+2) catches it.
//      "Not vacuous" has to be asserted, not assumed: this check shipped
//      once seeing ZERO checkout steps in `pr-overlap.yml`, because it
//      required `- uses: actions/checkout@` on ONE line while the real
//      file's only write-scoped checkout opens with `- name:`. So the
//      self-test also pins that condition 3 REACHES a checkout step in the
//      real file, and carries fixtures in that same `- name:`-first shape
//      — see `findCheckoutSteps` and the last self-test block.
//   4. Independent of both the trigger AND the `permissions:` block: does any
//      job holding a checkout that is NOT base-pinned (the same "untrusted
//      content" predicate condition 3 uses) reference `secrets.` anywhere —
//      in an `env:`, a `with:`, a `run:`, anywhere? Conditions 1–3 read
//      `permissions:` and nothing else, which leaves the OTHER half of this
//      header's own thesis uncovered: it names a PAT alongside the trigger
//      flip as the way the GitHub fork-downgrade mitigation dies, and a PAT
//      is not a `permissions:` scope. `GH_TOKEN: ${{ secrets.A_PAT }}` added
//      to `compute` reinstates the #3967 arrangement exactly — a
//      write-capable credential sitting in the job that runs fork-authored
//      code — while `compute`'s `permissions: contents: read` stays
//      untouched and conditions 1–3 stay green on it.
//      `secrets.GITHUB_TOKEN` is NOT exempted: under `pull_request` from a
//      fork it is read-only only because of the very GitHub default #3967
//      stopped relying on, and the structural answer (`post` holds the
//      token, `compute` holds the untrusted checkout) needs no token in
//      `compute` at all. A workflow-level `env:` counts too — it is
//      inherited by every job, so a secret declared once above `jobs:` lands
//      in the untrusted job just the same.
//      The `secrets` context counts however it is SPELLED: the accessor
//      forms (`secrets.A_PAT`, `secrets['A_PAT']`) and the whole-context
//      forms GitHub documents, `${{ toJSON(secrets) }}` chief among them —
//      which hands the job EVERY secret in one expression and carries no
//      accessor for an accessor-shaped regex to find. See
//      `SECRET_REFERENCE` / `SECRET_IN_EXPRESSION` below.
//      What this does NOT cover: a secret reaching the untrusted job by a
//      route with no `secrets` token in this file — a `with:` input on a
//      third-party action that fetches its own credential, an OIDC exchange,
//      a value carried in from a reusable workflow's `secrets: inherit`.
//      Nor does it cover the OTHER direction of the split: a job that holds
//      a secret and never checks out anything is trusted BY THIS CHECK, but
//      it may still CONSUME the untrusted job's artifact. That is correct
//      with respect to fork-code EXECUTION — no fork-authored code runs in
//      such a job — and wrong with respect to fork-authored DATA: an
//      artifact is attacker-influenced text, and a job that interpolates it
//      into a `run:` alongside a token is an injection away from the same
//      outcome. `pr-overlap.yml`'s `post` job carries the reasoning for why
//      it does not (the artifact reaches `node` as a `--diverged-from
//      <path>` filename, never as shell text); enforcing that is a
//      taint-tracking check this one does not attempt.
//      Those all need a different check; this one closes the one-line edit.
//
//   5. (#4148) A `run:` step reaching PR content directly — `gh pr checkout`,
//      `gh pr diff`, a git command consuming a fetched `FETCH_HEAD`, or a
//      `git fetch … refs/pull/…` (see `RUN_STEP_CHECKOUT_PATTERNS`) — is NOT
//      an `actions/checkout` step and writes no `ref:` line, so it evaded
//      every condition above: condition 2 only reads `ref:` values, and
//      condition 3 only recognised a step as a checkout if it `uses:
//      actions/checkout@`. `findCheckoutSteps` now also recognises this
//      shape (with `ref: null`, the same "not base-pinned" reading a
//      ref-less `actions/checkout` step already gets), so it feeds BOTH
//      condition 2 (via `findRunStepCheckouts`, gated on the same `dangerous`
//      trigger check) and condition 3 (automatically, since condition 3
//      already iterates every step `findCheckoutSteps` returns).
//      The patterns are matched per SOURCE LINE and, separately, against the
//      step's non-comment lines JOINED, so a command YAML itself splits
//      across lines (a folded `run: >` scalar, a `\`/`&&`/`|` continuation)
//      is not invisible to a line-oriented scan — see `findCheckoutSteps`.
//      Textual and narrow, like the rest of this guard, and the classes it
//      still cannot see are enumerated at `RUN_STEP_CHECKOUT_PATTERNS`
//      rather than left implied: PR content pulled over the network
//      (`curl … .patch | git am`, a tarball, an artifact) and shell-level
//      indirection. A THIRD class — a checkout hidden behind a composite or
//      third-party ACTION — used to be enumerated there too; condition 6
//      below closes it FOR THE ONE PLACE IT MATTERS MOST (a write-scoped
//      job) — see condition 6's own paragraph and `RUN_STEP_CHECKOUT_PATTERNS`'s
//      docstring for why a read-only job stays deliberately out of scope.
//      #4183 is where all three were triaged, and is where the two still
//      open are judged (not merely left) out of scope — see
//      `RUN_STEP_CHECKOUT_PATTERNS`'s own docstring and this header's own
//      "#4183" note after condition 6.
//
//      Two `actions/checkout` spellings of the same reach were found in the
//      same adversarial pass and closed with it, because they are the same
//      failure — a head-content checkout conditions 1+2 could not name:
//      `ref: ${{ github.event.pull_request.merge_commit_sha }}` (see
//      `HEAD_REF_PATTERNS`), and `repository:` redirected at the PR's head
//      repo, which launders even a BASE-pinned `ref:` past condition 3 (see
//      `FORK_REPOSITORY_PATTERNS`).
//
//   6. (#4183) Independent of the trigger, of `secrets` references, and of
//      whether any `ref:` or `run:` line in THIS file reaches PR content:
//      does a job holding a write permission scope `uses:` a step outside a
//      short, pinned allowlist of actions this guard's author has actually
//      read (`TRUSTED_WRITE_SCOPED_ACTIONS`)? #4148's adversarial review
//      named the gap condition 3 and condition 5 share: both recognise a
//      checkout only by its OWN shape (a `ref:`-bearing `actions/checkout`
//      step, or one of `RUN_STEP_CHECKOUT_PATTERNS`'s `run:` shapes) — a
//      checkout hidden inside a LOCAL composite action
//      (`uses: ./.github/actions/<x>`) or an unreviewed third-party one
//      (`uses: some/checkout-ish@v1`) is invisible to both, because the
//      checkout logic lives in a DIFFERENT FILE this guard cannot read (it
//      reads exactly `WORKFLOW_PATH`, by construction — see the header's
//      "not a general-purpose linter" scoping). No single-file textual check
//      can decide what an opaque `uses:` target does, so this does not try
//      to decide it — it refuses to run unreviewed code in a write-scoped
//      job at all, the same shape `pr-overlap.yml` uses no local action and
//      no action outside the allowlist today, so this check starts GREEN on
//      the real file (see `findWriteScopedUntrustedActions`'s own docstring
//      and its self-test fixture, which is the falsifiable half of that
//      claim).
//
// (1 AND (2 OR 5)) is one failure mode; 3, 4 and 6 are three more, each
// independent of it and of each other. Any of them firing is a violation.
//
// Usage:
//   node scripts/check-pr-overlap-trust-boundary.mjs
//   node scripts/check-pr-overlap-trust-boundary.mjs --self-test
//
// Exit: 0 = safe (or the hazard's precondition is absent); 1 = the hazard
// shape is present; 2 = the file could not be parsed at all (a wiring
// failure — the guard could not answer, not an answer of "safe") or a
// self-test assertion failed.

import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/pr-overlap.yml')

const DANGEROUS_TRIGGER = 'pull_request_target'

// Any of these resolving inside a `ref:` value means "PR head content",
// independent of which job or step it appears in.
const HEAD_REF_PATTERNS = [
  /pull_request\.head\.(?:sha|ref)/,
  /\bhead_ref\b/, // github.head_ref
  /refs\/pull\/[^/]+\/(?:merge|head)/,
  // `github.event.pull_request.merge_commit_sha` — GitHub's own precomputed
  // merge of head into base. It is the SAME content `refs/pull/<n>/merge`
  // resolves to (already listed above), spelled as an event field instead of
  // a ref, and it was the one head-content spelling an adversarial pass
  // found that condition 2 did not recognise: a `pull_request_target` job
  // with NO write scope checking out `merge_commit_sha` was green on every
  // condition. Condition 3 already caught it in a WRITE-scoped job (the
  // value is not `pull_request.base.*`, so `isBasePinned` is false), which
  // is exactly why the gap was invisible — the half that fires without a
  // write scope is conditions 1+2, and only they were blind to it.
  /pull_request\.merge_commit_sha/,
]

// A `repository:` value under an `actions/checkout` step's `with:` mapping
// naming the PR's HEAD repository — i.e. the fork. This is the one shape
// that turns condition 3's ACCEPTANCE path into a laundering route: a step
// spelling `ref: ${{ github.event.pull_request.base.sha }}` reads as
// base-pinned to `isBasePinned` and is waved through, while
// `repository: ${{ github.event.pull_request.head.repo.full_name }}`
// silently redirects the whole clone at the fork — the base ref's NAME
// resolved against the fork's object graph, which is content the fork author
// controls. `refFromWithMapping`'s own docstring already worries about a
// nested value laundering a ref-less checkout past condition 3; this is the
// same laundering by the sibling key, and it was open.
const FORK_REPOSITORY_PATTERNS = [/pull_request\.head\.repo/, /\bhead_repo\b/]

// A `ref:` value resolving to one of these is pinned to the PR's BASE
// branch — a commit in this repo's own history, never a fork's — which is
// the one shape of checkout condition 3 (below) accepts inside a
// write-scoped job.
const BASE_REF_PATTERNS = [/pull_request\.base\.(?:sha|ref)/]

// #4148 — a `run:` step reaching the SAME fork-authored content as a
// `ref:`-pinned `actions/checkout`, without ever writing a `ref:` line. Every
// condition above and below this one only inspects `ref:` values or
// `uses: actions/checkout@` steps, so a job whose ONLY checkout is one of
// these `run:` invocations satisfied every condition this guard checked while
// doing precisely the thing it exists to prevent — see the issue's own
// falsification: `gh pr checkout` in a `run:` step, inside a write-scoped
// job, went unnoticed by every condition 1-4 above.
//
//   - `gh … pr checkout <n>` — the GitHub CLI's own PR-checkout command;
//     reaches the PR's head content exactly like `ref: refs/pull/<n>/head`.
//     `[^\n]*` between `gh` and `pr` so the GLOBAL flags the CLI accepts
//     before a subcommand (`gh -R owner/repo pr checkout 1`, `gh --repo …`)
//     do not walk past an anchored `gh\s+pr` — the first evasion an
//     adversarial pass found against the anchored form.
//   - `gh … pr diff` — the sibling shape: the PR's own patch, obtained by
//     the same CLI. `gh pr diff N | git apply -` puts fork-authored code in
//     the workspace with no `checkout` verb anywhere in the line.
//   - a git command CONSUMING `FETCH_HEAD` — not only `git checkout
//     FETCH_HEAD`. Once a `git fetch` has landed PR content in `FETCH_HEAD`,
//     `switch --detach`, `worktree add`, `reset --hard`, `merge`,
//     `cherry-pick`, `rebase`, `restore`, `am`, `apply` and `pull` all
//     materialise it in a tree just as effectively; an anchored `checkout`
//     matched exactly one of ten. The verb alternation is deliberate rather
//     than a bare `git … FETCH_HEAD`: a READ-ONLY inspection (`git rev-parse
//     FETCH_HEAD`, `git log FETCH_HEAD`) puts no fork content in the tree
//     and must not be flagged, or the guard reds on a diagnostic.
//   - `git fetch … refs/pull/…` — fetching a PR ref into the workspace is
//     already reaching fork-authored content, whether or not a later step
//     checks it out (the fetched objects are on disk and buildable either
//     way). Remote name and refspec shape are unconstrained on purpose:
//     `git fetch fork '+refs/pull/*/head:refs/remotes/pr/*'` is the same
//     reach as `git fetch origin refs/pull/1/head`.
//
// Textual and narrow, matching how the rest of this guard is built (see the
// header's "not a general-purpose pull_request_target linter" scoping). What
// it does NOT catch, stated rather than assumed — an adversarial pass
// enumerated each of these and confirmed the guard stayed green on it. #4183
// triaged all three; the first is now closed a different way (condition 6,
// `findWriteScopedUntrustedActions`, below — not by widening THIS pattern
// list, which cannot see into another file no matter how it is written) and
// the other two are JUDGED out of scope, not merely unimplemented — #4183's
// own body makes that call explicitly, so it is repeated here rather than
// left to be re-litigated by the next reader:
//
//   - A checkout behind an ACTION rather than a `run:` step: `uses:
//     ./.github/actions/<x>` (a composite action whose own steps do the
//     checkout) or a third-party `uses: some/checkout-ish@v1`. The checkout
//     lives in a DIFFERENT FILE, and this guard reads exactly one file by
//     construction (`WORKFLOW_PATH`) — no single-file textual check can see
//     it. CLOSED for the one place it matters most (a write-scoped job) by
//     condition 6: rather than following `uses:` targets into files this
//     guard cannot read, a write-scoped job is restricted to a short,
//     human-reviewed allowlist of actions instead — "is this action safe" is
//     answered once, by a person, at allowlist-edit time, not re-derived
//     textually on every run.
//   - PR content fetched over the NETWORK rather than over git: `curl …
//     /pull/N.patch | git am`, `curl … /archive/$HEAD_SHA.tar.gz | tar xz`,
//     or `actions/download-artifact` pulling an artifact an untrusted job
//     produced. Deciding whether an arbitrary URL or artifact name resolves
//     to fork-authored content is not a textual question — it depends on
//     what is AT that URL or in that artifact, which no read of this file
//     can answer. (The artifact case is the same residual condition 4's own
//     docstring names for its DATA half, and is not closed here either.)
//     #4183 judges this out of scope for this guard: not a missing pattern,
//     a class this guard's whole approach (read one file, decide textually)
//     cannot decide.
//   - Shell-level indirection: a command assembled from string
//     concatenation, dispatched through a `$VAR`, or base64-decoded, and a
//     wrapper script that shells out to `git` under a different name.
//     Closing this needs shell-semantics tracking this guard does not
//     attempt — again a class, not a missing regex alternative; adding one
//     would create the false confidence #4183 warns against ("pretending
//     otherwise by adding a pattern would be worse than saying so") without
//     closing the class, since the next obfuscation is a fresh pattern away.
//
// Both residual classes are deliberate-evasion shapes, not a one-line edit a
// maintainer types by accident (#4183's own "why this is lower priority than
// it looks" — the threat model this guard states in its header is the
// accidental #3967 shape, not an adversarial insider already willing to
// obfuscate a command). zizmor's `pull_request_target` linter, run over every
// workflow via the `zizmor` prek hook, is the broader net for exactly these
// shapes; this guard stays the narrow, `pr-overlap.yml`-specific insurance it
// was built as.
const RUN_STEP_CHECKOUT_PATTERNS = [
  /\bgh\b[^\n]*\bpr\s+(?:checkout|diff)\b/,
  /\bgit\b[^\n]*\b(?:checkout|switch|restore|reset|merge|rebase|cherry-pick|worktree|pull|am|apply)\b[^\n]*\bFETCH_HEAD\b/,
  /\bgit\s+fetch\b[^\n]*refs\/pull\//,
]

// #4183 condition 6 — the actions a job holding a write permission scope may
// `uses:` at all. Deliberately an ALLOWLIST of exact `owner/repo` action
// identifiers (the part of a `uses:` value before the `@`), not a denylist
// or a heuristic: the whole point of condition 6 is that this guard cannot
// read what an arbitrary action does (see the header's condition-6 section),
// so the only textually-honest rule is "known-safe, reviewed once by a
// person" rather than "doesn't LOOK like a checkout".
//
// This is exactly the set `pr-overlap.yml`'s own write-scoped job (`post`)
// uses TODAY: `actions/checkout` (with a `ref:` condition 3 already pins to
// the PR base — this allowlist is a SEPARATE, independent gate, not a
// replacement for that check) and `actions/download-artifact` (pulling the
// `compute` job's own upload, never external input — see `post`'s own
// comment on why that artifact is data, not code, and lands under
// `artifact/`, never `scripts/`). Adding a THIRD action here is a conscious,
// reviewed edit to this list — which is the point: an allowlist that grows
// itself silently is not an allowlist.
const TRUSTED_WRITE_SCOPED_ACTIONS = new Set(['actions/checkout', 'actions/download-artifact'])

// Any reference to the `secrets` context BY ACCESSOR: `secrets.GITHUB_TOKEN`,
// `secrets.A_PAT`, or the index form `secrets['A_PAT']`. Condition 4 (below)
// rejects all of them inside a job holding a non-base-pinned checkout — see
// this file's header for why `GITHUB_TOKEN` is not carved out.
const SECRET_REFERENCE = /\bsecrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_-]*|\[)/

// The `secrets` context named inside a `${{ … }}` expression WITHOUT an
// accessor. `${{ toJSON(secrets) }}` is a documented GitHub form and it is
// strictly WORSE than any single accessor — it serialises EVERY secret the
// workflow can see into one value — yet `SECRET_REFERENCE` above cannot see
// it, because the character after `secrets` is `)` rather than `.` or `[`.
// So condition 4, whose whole framing is "closes the one-line edit", had a
// one-line edit that walked straight past it.
//
// Scoped to the inside of an expression rather than matching the bare word
// anywhere on the line, because "secrets" is an ordinary English word that
// appears in step names and prose (`- name: Scan for leaked secrets`), and a
// guard that reds on the word rather than the context is a guard people
// route around. `(?:(?!\}\})[\s\S])*?` is "any text not yet closing the
// expression": the match needs an opening `${{` before the mention, not a
// closing `}}` after it, so an expression broken across lines still fails
// CLOSED on the line that opens it.
const SECRET_IN_EXPRESSION = /\$\{\{(?:(?!\}\})[\s\S])*?\bsecrets\b/

/**
 * Whether one line (already comment-stripped by the caller) references the
 * `secrets` context in any spelling condition 4 rejects.
 *
 * @param {string} line
 */
function referencesSecrets(line) {
  return SECRET_REFERENCE.test(line) || SECRET_IN_EXPRESSION.test(line)
}

/**
 * Extract the top-level `on:` block's raw text (from the `on:` line up to,
 * but not including, the next line that starts at column 0). Comment lines
 * inside it are dropped before the caller matches against it, so a
 * DOCUMENTATION mention of the trigger name (this very file's own header,
 * for instance) cannot be mistaken for the trigger actually being declared.
 *
 * A COLUMN-0 COMMENT IS NOT THE NEXT TOP-LEVEL KEY. YAML allows a comment at
 * any indentation, including none, so `# ─── the target trigger ───` written
 * flush left between two entries of the `on:` mapping is legal and ends
 * nothing. Treating it as the block boundary truncates the block there, and
 * a `pull_request_target:` declared BELOW it is never seen —
 * `declaresDangerousTrigger` returns false and conditions 1+2 stay silent on
 * a file that really does carry the trigger. `splitJobs` had the identical
 * break, for the identical reason; both are fixed together.
 *
 * Throws — not a violation, a WIRING failure — if the file carries no `on:`
 * block at all, which means this guard is looking at the wrong shape of
 * file and must not silently report "safe".
 *
 * @param {string} src
 */
export function extractOnBlock(src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^on:\s*$/.test(l))
  if (start === -1) {
    throw new Error(
      `could not find a top-level \`on:\` block in ${WORKFLOW_PATH} — did the trigger get restructured onto one line?`,
    )
  }
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    // Next top-level KEY — a column-0 comment is not one; see the docstring.
    if (/^\S/.test(lines[i]) && !isCommentLine(lines[i])) break
    if (isCommentLine(lines[i])) continue
    block.push(lines[i])
  }
  return block.join('\n')
}

/**
 * Whether `onBlock` (the raw text `extractOnBlock` returned) declares
 * `pull_request_target` as a trigger, mapping style (`pull_request_target:`).
 *
 * Flow-list style (`on: [pull_request_target]`) is NOT handled here, and
 * there is no dead branch in this regex pretending otherwise: that form
 * never reaches this function in the first place. `extractOnBlock` only
 * recognises a top-level `on:` line with nothing after the colon
 * (`/^on:\s*$/`); a flow-list `on:` fails that match and `extractOnBlock`
 * throws before `declaresDangerousTrigger` is ever called — `main()` has no
 * try/catch around that call, so it fails CLOSED (exit 2; see `main`'s own
 * comment), just not via this function. If this file's trigger is ever
 * restructured onto one line, fix `extractOnBlock`, not this function.
 *
 * @param {string} onBlock
 */
export function declaresDangerousTrigger(onBlock) {
  const re = new RegExp(`(^|\\s)${DANGEROUS_TRIGGER}(\\s*:|\\s|$)`, 'm')
  return re.test(onBlock)
}

/**
 * Every line across the whole file whose `ref:` value resolves to PR head
 * content, with the 1-based line number for the failure message.
 *
 * @param {string} src
 */
export function findHeadCheckoutRefs(src) {
  const lines = src.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return
    // `repository:` alongside `ref:`: a checkout redirected at the PR's HEAD
    // REPOSITORY is reaching fork-authored content no matter what its `ref:`
    // says — see `FORK_REPOSITORY_PATTERNS`. Conditions 1+2 fire on ANY step
    // reaching PR head content, so the sibling key belongs in the same scan;
    // condition 3 reads the same fact per-step via `findCheckoutSteps`.
    if (trimmed.startsWith('repository:')) {
      if (FORK_REPOSITORY_PATTERNS.some((re) => re.test(trimmed))) {
        hits.push({ line: i + 1, text: trimmed })
      }
      return
    }
    if (!trimmed.startsWith('ref:')) return
    if (HEAD_REF_PATTERNS.some((re) => re.test(trimmed))) {
      hits.push({ line: i + 1, text: trimmed })
    }
  })
  return hits
}

/**
 * Split the `jobs:` block into per-job source slices, keyed by job name.
 * Same line-scanning approach as `extractOnBlock`: a job header is a line
 * indented exactly two spaces and ending in `:` (`  compute:`), and its body
 * is every line after that up to the next such header, or a line that
 * dedents back to column 0 (the next top-level workflow key).
 *
 * COMMENT LINES ARE NOT JOB HEADERS, for the same reason `extractOnBlock`
 * drops comments before matching a trigger name. `pr-overlap.yml` separates
 * its jobs with two-space-indented prose banners, and one of those ending in
 * a colon (`  # …what follows is a note about its contract:`) matched the
 * header regex — inventing a PHANTOM job that owns the rest of the REAL
 * job's body. The phantom declares no `permissions:` of its own, so it
 * inherits the workflow-level block (`contents: read`), so condition 3 skips
 * it — and the real job, now truncated to whatever preceded the comment,
 * has no checkout steps left to inspect. A write-scoped job checking out
 * fork content would pass silently. The body lines are still pushed to the
 * job they were already in, so every `headerLine + offset` line number
 * stays exact.
 *
 * THE HEADER REGEX RUNS OVER THE COMMENT-STRIPPED LINE, for the mirror image
 * of that failure. It requires end-of-line after the colon, so `  post: #
 * posts the table compute produced` — a job header with an ordinary trailing
 * comment, more likely to be typed by accident than the banner-ending-in-a-
 * colon above — matched NOTHING, and `post`'s whole body folded into the
 * job before it. If that predecessor is the untrusted `contents: read` half
 * of the split (it is, in this file: `compute` precedes `post`), the merged
 * job reads as non-write-scoped and conditions 3 and 4 skip the write-scoped
 * job entirely. Same silent false negative, opposite direction: there a
 * comment became a job, here a job became a comment. `isCommentLine` still
 * runs on the RAW line — stripping first would turn every whole-line comment
 * into `''`, which is not a header either, but says so by accident.
 *
 * A COLUMN-0 COMMENT IS NOT THE NEXT TOP-LEVEL KEY, exactly as in
 * `extractOnBlock` — a flush-left banner between two jobs is legal YAML and
 * ends nothing, but read as the end of the `jobs:` block it deletes EVERY
 * job below it from conditions 3 and 4. It is pushed into the current job's
 * body rather than skipped, so `headerLine + offset` arithmetic stays exact.
 *
 * Throws — a wiring failure, not a violation — if the file has no top-level
 * `jobs:` block, same discipline as `extractOnBlock`.
 *
 * @param {string} src
 * @returns {Record<string, { body: string[], headerLine: number }>}
 */
export function splitJobs(src) {
  const lines = src.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsStart === -1) {
    throw new Error(`could not find a top-level \`jobs:\` block in ${WORKFLOW_PATH}`)
  }
  /** @type {Record<string, { body: string[], headerLine: number }>} */
  const jobs = {}
  let name = null
  let body = []
  let headerLine = 0
  const flush = () => {
    if (name !== null) jobs[name] = { body, headerLine }
  }
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const line = lines[i]
    // Dedented back to a top-level KEY; the jobs: block is over. A column-0
    // COMMENT is not a key — see the docstring.
    if (/^\S/.test(line) && !isCommentLine(line)) break
    const header = isCommentLine(line) ? null : /^ {2}(\S[^:]*):\s*$/.exec(stripComment(line))
    if (header) {
      flush()
      name = header[1]
      body = []
      headerLine = i + 1
      continue
    }
    if (name !== null) body.push(line)
  }
  flush()
  return jobs
}

/**
 * Whether a job body declares a write permission scope: `permissions:
 * write-all` (inline), or a mapping with any `<scope>: write` entry —
 * `pull-requests: write`, `contents: write`, etc. `permissions: {}` and
 * `permissions:\n  contents: read` are both "no".
 *
 * Returns `null` if the job has no `permissions:` key of its own at all, so
 * the caller can fall back to the workflow-level block (a job with no
 * override inherits it).
 *
 * COMMENTS ARE STRIPPED FIRST. A `permissions:` block routinely explains
 * itself — including by naming the scope it deliberately does NOT ask for
 * ("dropped `pull-requests: write` here", the shape `pr-overlap.yml`'s own
 * `compute` job comments about) — and reading that as a live write scope
 * fails safe but produces a red nobody can explain from the file.
 *
 * @param {string[]} jobBody
 */
export function jobDeclaresWriteScope(jobBody) {
  const idx = jobBody.findIndex((l) => /^ {4}permissions:/.test(l))
  if (idx === -1) return null
  const inline = /^ {4}permissions:\s*(\S.*)$/.exec(stripComment(jobBody[idx]))
  if (inline) return /write/.test(inline[1])
  for (let i = idx + 1; i < jobBody.length; i++) {
    if (/^ {0,4}\S/.test(jobBody[i])) break // dedented back out of the permissions block
    if (declaresWrite(jobBody[i])) return true
  }
  return false
}

/**
 * `line` with any trailing `#` comment removed, and `''` for a whole-line
 * comment, cutting where YAML says the comment starts rather than at the
 * first `#` character.
 *
 * THE NAIVE VERSION FAILED OPEN once this became condition 4's input. It cut
 * at the first `#` anywhere and justified that with "the failure direction
 * is a value that reads as SHORTER, never as a write scope that is not
 * there" — true while the only callers were `jobDeclaresWriteScope` and
 * `refFromWithMapping`, where a shorter value means a scope or a base-pin
 * that reads as ABSENT and the check stays red. It is false for
 * `findSecretReferences`, where shorter means FEWER secrets found, i.e.
 * fewer violations: `run: echo '#' && curl -H "auth: ${{ secrets.A_PAT }}"`
 * truncated at the quoted hash hides the PAT from condition 4 entirely. The
 * fail direction is per-caller, so it cannot be asserted once for the
 * function; the function is made accurate instead.
 *
 * Two YAML rules are enough to close that: a `#` inside a quoted scalar is
 * content, and a `#` in a plain scalar only opens a comment when it follows
 * whitespace (or starts the line) — `sha#frag` is one token, not a token and
 * a comment. Both rules make the retained value LONGER than the naive cut,
 * which is the fail-closed direction for the secrets caller and, for the
 * other two, only ever admits a value that YAML itself says is live.
 *
 * Residual, stated rather than assumed: a line inside a BLOCK scalar
 * (`run: |`) is shell text where `#` is a shell comment and quotes are shell
 * quotes, and this function still reads it as YAML. A block-scalar line
 * carrying an unbalanced quote (`echo "it's fine" # trailing`) can therefore
 * still be cut where YAML would not cut. That is a narrower hole than the
 * one it replaces — the evasion has to survive shell quoting too — and
 * closing it needs block-scalar tracking this guard does not do.
 *
 * @param {string} line
 */
function stripComment(line) {
  /** @type {string | null} */
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === null) {
      if (ch === '"' || ch === "'") quote = ch
      else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    } else if (quote === '"' && ch === '\\') {
      i++ // an escaped character inside a double-quoted scalar, `\"` included
    } else if (ch === quote) {
      // `''` inside a single-quoted scalar is an escaped quote, not the end.
      if (quote === "'" && line[i + 1] === "'") i++
      else quote = null
    }
  }
  return line
}

/**
 * Whether one line of a `permissions:` mapping grants a write scope
 * (`contents: write`, `pull-requests: write`, …), ignoring comments.
 *
 * @param {string} line
 */
function declaresWrite(line) {
  return /:\s*write\b/.test(stripComment(line))
}

/**
 * Every `actions/checkout` step inside a job body, with the `ref:` value
 * found inside that step's own `with:` block (`null` if the step has no
 * `ref:` at all — the triggering event's default checkout applies, which for
 * `pull_request` IS PR head content).
 *
 * Step boundaries are found by indentation, not by a step counter: a step is
 * introduced by a line whose trimmed text starts with `- ` (a YAML sequence
 * item); the step's content ends at the next line whose indentation is no
 * deeper than that `-`. The step is a checkout if `uses: actions/checkout@`
 * appears ANYWHERE in that block — NOT only on the introducing line. That
 * distinction is the whole reason this function exists in this shape: the
 * earlier version required `- uses: actions/checkout@` on one line, and
 * `pr-overlap.yml`'s own `post` job writes its checkout as `- name: …` with
 * `uses:` seventeen lines further down, so the only write-scoped job in the
 * file was invisible to condition 3 and the check asserted nothing. See the
 * `NAME_FIRST_HEAD_REF_CHECKOUT` fixture, which mirrors that step shape
 * deliberately, and the self-test block that pins condition 3 as reaching a
 * checkout step in the real file at all.
 *
 * The `ref:` is read only from the step's own `with:` MAPPING, and only as a
 * DIRECT child of it — not "the first `ref:` at any depth in the step". A
 * `ref:` nested under some other `with:` key (a future option carrying its
 * own mapping) is a different value entirely, and reading it as the
 * checkout's ref would let a base-pinned nested value launder a ref-less —
 * i.e. fork-content — checkout past condition 3.
 *
 * A step whose `uses:` is NOT `actions/checkout` but whose body matches
 * `RUN_STEP_CHECKOUT_PATTERNS` (see #4148 at that constant's definition) is
 * ALSO included, with `ref: null` — a `run:`-step checkout carries no `ref:`
 * to read, and `ref: null` is already how this file's callers (`isBasePinned`)
 * read "not pinned to the PR base", which is the correct, fail-closed
 * classification for content a `run:` step fetched directly. `runCheckoutLine`
 * (like `refLine`) is the offset of the matched line, so a failure message can
 * quote the actual `run:` text rather than only the step's introducing line.
 *
 * @param {string[]} jobBody
 */
export function findCheckoutSteps(jobBody) {
  const steps = []
  for (let i = 0; i < jobBody.length; i++) {
    if (isCommentLine(jobBody[i])) continue
    const m = /^(\s*)-\s/.exec(jobBody[i])
    if (!m) continue
    const indent = m[1].length

    // The step's block: the introducing `- …` line plus every following line
    // indented deeper than the `-`.
    let end = jobBody.length
    for (let j = i + 1; j < jobBody.length; j++) {
      if (jobBody[j].trim() === '') continue
      if (indentOf(jobBody[j]) <= indent) {
        end = j
        break
      }
    }
    const block = jobBody.slice(i, end)

    const usesCheckout = block.some(
      (line) => !isCommentLine(line) && /(?:^|\s)uses:\s*actions\/checkout@/.test(line),
    )
    // #4148 — a `run:` step reaching PR content directly, evading both the
    // `uses: actions/checkout@` test above and every `ref:`-based check in
    // this file. Scanned over the whole step block, not only a line under a
    // `run:` key, for the same reason `usesCheckout` above scans the whole
    // block rather than only the introducing line: a `run: |` block scalar's
    // payload is indented UNDER the `run:` line, not on it.
    const runCheckoutOffset = block.findIndex(
      (line) => !isCommentLine(line) && RUN_STEP_CHECKOUT_PATTERNS.some((re) => re.test(line)),
    )
    // …AND against the step's non-comment lines JOINED into one string. A
    // per-line scan is blind to a command YAML itself splits across source
    // lines: a FOLDED block scalar (`run: >`) rejoins its lines with spaces
    // before the shell ever sees them, so
    //
    //     run: >
    //       git fetch origin
    //       refs/pull/1/head
    //
    // runs `git fetch origin refs/pull/1/head` while no single SOURCE line
    // carries both halves. The same is true of a command continued with a
    // trailing `\`, `&&` or `|` inside a literal `run: |` block. That is a
    // YAML-level blindness, not the shell-level obfuscation this guard
    // disclaims above, so it is closed rather than documented away.
    //
    // The failure direction of joining is toward FALSE POSITIVES (two
    // unrelated lines of one step reading as one command), never toward a
    // missed violation, which is the correct direction for a security guard
    // — and the joined text is still only ever ONE step's lines, so the
    // widest a spurious match can reach is a single step. Comment lines are
    // dropped before joining for the same reason the per-line scan skips
    // them: a step whose prose merely NAMES `gh pr checkout` is not a step
    // running it.
    const flattened = block.filter((line) => !isCommentLine(line)).join(' ')
    const flatCheckout =
      runCheckoutOffset === -1 && RUN_STEP_CHECKOUT_PATTERNS.some((re) => re.test(flattened))
    const isCheckout = usesCheckout || runCheckoutOffset !== -1 || flatCheckout
    if (!isCheckout) continue

    // `refLine` is relative to the job body, like `stepLine`, and is `null`
    // when the step declares no `ref:` — it exists because a `- name:`-first
    // step's `ref:` can sit many lines below the line that introduces it, and
    // a failure message naming only the step line points at a line that does
    // not contain the value it quotes. A `run:`-step checkout has no `with:`
    // mapping to read at all, so `refFromWithMapping` is only consulted when
    // the step is ALSO an `actions/checkout` step — reading it unconditionally
    // would return `{ ref: null, refLine: null }` for a run-step checkout
    // anyway (no `with:` block to find), but skipping the call says so.
    const { ref, refLine } = usesCheckout
      ? valueFromWithMapping(block, indent, 'ref')
      : { ref: null, refLine: null }
    // The `repository:` sibling key — see `FORK_REPOSITORY_PATTERNS`. Read
    // from the SAME direct-child-of-`with:` scan as `ref:`, so a nested
    // `repository:` under some other key cannot stand in for the checkout's
    // own, exactly as for `ref:`.
    const repository = usesCheckout ? valueFromWithMapping(block, indent, 'repository').ref : null
    steps.push({
      stepLine: i,
      ref,
      refLine: refLine === null ? null : i + refLine,
      forkRepository:
        repository !== null && FORK_REPOSITORY_PATTERNS.some((re) => re.test(repository)),
      // A flattened-only match (see `flatCheckout`) has no single source
      // line to cite, so it cites the step's own introducing line rather
      // than inventing one — but it MUST still be non-null, or
      // `findRunStepCheckouts` skips it and condition 3's message prints a
      // misleading `ref: (none)` for a step that has no `ref:` by design.
      runCheckoutLine: runCheckoutOffset !== -1 ? i + runCheckoutOffset : flatCheckout ? i : null,
    })
  }
  return steps
}

/** Indentation width of `line`, in characters. @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/** Whether `line` is a whole-line YAML comment. @param {string} line */
function isCommentLine(line) {
  return line.trim().startsWith('#')
}

/**
 * The value of `key` declared as a DIRECT child of a step's `with:` mapping,
 * with its offset from the step's introducing line. Both are `null` if the
 * step has no `with:` block or no `<key>:` directly under it. See
 * `findCheckoutSteps`' docstring for why "direct child" rather than "anywhere
 * in the step".
 *
 * Parameterised on the key (rather than hard-coded to `ref:`) so the
 * `repository:` sibling — the laundering route `FORK_REPOSITORY_PATTERNS`
 * describes — is read by the SAME direct-child scan, with the same
 * comment-stripping and the same nesting rule, rather than by a second
 * hand-rolled walk that could disagree with this one. The returned field is
 * still named `ref` for both callers: it is "the value this scan found",
 * and renaming it would churn every existing caller for nothing.
 *
 * THE VALUE IS COMMENT-STRIPPED, like every other value this guard reads
 * (`jobDeclaresWriteScope`, `declaresWrite`). Condition 3 accepts a checkout
 * whose `ref:` merely CONTAINS `pull_request.base.…` — a substring test, not
 * an equality one, because the real value is an interpolation with
 * surrounding `${{ }}` — so an unstripped trailing comment is a free pass:
 * `ref: ${{ github.event.pull_request.head.sha }}  # unlike base.sha, this
 * is head` reads as base-pinned and walks past the check while checking out
 * fork content. A `ref:` line whose value is ENTIRELY a comment is treated
 * as no `ref:` at all — no override means the event's default ref, which is
 * the fail-closed reading.
 *
 * @param {string[]} block  the step's lines, starting at its `- …` line
 * @param {number} stepIndent  indentation of that leading `-`
 * @param {string} key  the `with:` key to read (`ref`, `repository`)
 * @returns {{ ref: string | null, refLine: number | null }}
 */
function valueFromWithMapping(block, stepIndent, key) {
  const withIdx = block.findIndex(
    (line) => !isCommentLine(line) && indentOf(line) > stepIndent && /^\s*with:\s*$/.test(line),
  )
  if (withIdx === -1) return { ref: null, refLine: null }
  const withIndent = indentOf(block[withIdx])
  let childIndent = null
  for (let j = withIdx + 1; j < block.length; j++) {
    const line = block[j]
    if (line.trim() === '' || isCommentLine(line)) continue
    const lineIndent = indentOf(line)
    if (lineIndent <= withIndent) break // dedented back out of the with: mapping
    if (childIndent === null) childIndent = lineIndent
    if (lineIndent !== childIndent) continue // nested under some other with: key
    const refMatch = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(stripComment(line))
    if (refMatch) {
      const value = refMatch[1].trim()
      return value === '' ? { ref: null, refLine: null } : { ref: value, refLine: j }
    }
  }
  return { ref: null, refLine: null }
}

/**
 * Condition 3 (see this file's header): every `actions/checkout` step, in
 * every job that declares (or inherits) a write permission scope, whose
 * `ref:` is not pinned to `pull_request.base.*`. Checked on EVERY run,
 * independent of what the file's `on:` block says — unlike conditions 1+2,
 * which only fire after `pull_request_target` is added, this is what
 * catches reverting the `compute`/`post` split back to one job under
 * TODAY's plain `pull_request` trigger, where a ref-less checkout already
 * defaults to fork-controlled content.
 *
 * @param {string} src
 * @param {ReturnType<typeof splitJobs>} [jobs]  the split `checkTrustBoundary`
 *   already computed; defaults to splitting `src` here, so a caller with only
 *   a source string (the self-test, an importer) still works.
 */
export function findWriteScopedUnsafeCheckouts(src, jobs = splitJobs(src)) {
  const lines = src.split('\n')
  const workflowPermissions = (() => {
    const idx = lines.findIndex((l) => l.startsWith('permissions:'))
    if (idx === -1) return false
    // Comments stripped for the same reason as in `jobDeclaresWriteScope`.
    const inline = /^permissions:\s*(\S.*)$/.exec(stripComment(lines[idx]))
    if (inline) return /write/.test(inline[1])
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (declaresWrite(lines[i])) return true
    }
    return false
  })()

  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    const own = jobDeclaresWriteScope(body)
    const writeScoped = own === null ? workflowPermissions : own
    if (!writeScoped) continue
    for (const step of findCheckoutSteps(body)) {
      // A base-pinned `ref:` is the ONE accepted shape — unless the step also
      // redirects the clone at the fork with `repository:`, in which case the
      // base ref's NAME is resolved against the fork's object graph and the
      // pin buys nothing. See `FORK_REPOSITORY_PATTERNS`.
      if (isBasePinned(step.ref) && !step.forkRepository) continue
      hits.push({
        job: jobName,
        line: headerLine + step.stepLine + 1,
        refLine: step.refLine === null ? null : headerLine + step.refLine + 1,
        ref: step.ref,
        // #4148 — set only for a `run:`-step checkout (see `findCheckoutSteps`).
        runCheckoutLine:
          step.runCheckoutLine === null ? null : headerLine + step.runCheckoutLine + 1,
        // See `FORK_REPOSITORY_PATTERNS`: the reason this hit is here at all
        // when its `ref:` IS base-pinned.
        forkRepository: step.forkRepository === true,
      })
    }
  }
  return hits
}

/**
 * Condition 6 (#4183) — see the header's own "condition 6" section and
 * `TRUSTED_WRITE_SCOPED_ACTIONS`'s docstring for the policy this enforces
 * and why it is an allowlist rather than an attempt to inspect what an
 * arbitrary action does.
 *
 * Every `uses:` step inside a job holding a write permission scope (the
 * SAME write-scope computation `findWriteScopedUnsafeCheckouts` uses — "the
 * write-scoped job" must mean the identical set of jobs in both, exactly the
 * reasoning `checkTrustBoundary` gives for splitting jobs once and handing
 * every condition the same map) whose action identifier (the `uses:` value
 * up to the first `@`) is not a member of `TRUSTED_WRITE_SCOPED_ACTIONS`.
 * That covers a LOCAL composite action (`uses: ./.github/actions/<x>`, whose
 * "identifier" is the literal `./…` path — never a member of the allowlist,
 * by construction, since every allowlist entry is an `owner/repo` form) and
 * an unreviewed third-party action alike; both are the same "this guard
 * cannot see what runs here" shape.
 *
 * A `uses:` line with NO `@` at all (an unpinned action, `uses: owner/repo`)
 * gets no special "always flag" treatment — it is resolved the SAME way as
 * any other: its identifier IS the whole value in that case (there is no
 * `@` to split off), and `TRUSTED_WRITE_SCOPED_ACTIONS`'s own entries are
 * bare identifiers with no version, so an unpinned use of an ALLOWLISTED
 * action still resolves to a member and is NOT flagged by this function —
 * only an unpinned use of something NOT on the allowlist is. Pinning itself
 * is a separate concern this guard does not police (`pr-overlap.yml`'s own
 * steps pin every `uses:` to a full commit SHA, but that is a repo
 * convention, not a rule this narrow guard enforces).
 *
 * Residual, stated rather than assumed: this scans EVERY line of the job
 * body for the `uses:` pattern, not just genuine YAML `uses:` keys —
 * including the text of a `run:` block scalar. A write-scoped job whose
 * script ever ECHOES a line that happens to contain `uses: something` (a log
 * message, a heredoc, a printed diff) matches the same regex and gets
 * flagged as if it were a real step. This fails CLOSED, not open: the worst
 * case is a spurious red on a write-scoped job that used no untrusted action
 * at all, never a miss of one that did.
 *
 * @param {string} src
 * @param {ReturnType<typeof splitJobs>} [jobs]  as in
 *   `findWriteScopedUnsafeCheckouts`; the default throws on a file with no
 *   `jobs:` block — a wiring failure, not a violation.
 */
export function findWriteScopedUntrustedActions(src, jobs = splitJobs(src)) {
  const lines = src.split('\n')
  // Duplicated from `findWriteScopedUnsafeCheckouts` rather than factored
  // out: both computations are small, and condition 6 must be provably
  // independent of condition 3's implementation — a shared helper that later
  // grows a condition-3-specific assumption would silently start feeding it
  // to condition 6 too.
  const workflowPermissions = (() => {
    const idx = lines.findIndex((l) => l.startsWith('permissions:'))
    if (idx === -1) return false
    const inline = /^permissions:\s*(\S.*)$/.exec(stripComment(lines[idx]))
    if (inline) return /write/.test(inline[1])
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (declaresWrite(lines[i])) return true
    }
    return false
  })()

  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    const own = jobDeclaresWriteScope(body)
    const writeScoped = own === null ? workflowPermissions : own
    if (!writeScoped) continue
    body.forEach((line, offset) => {
      if (isCommentLine(line)) return
      const m = /(?:^|\s)uses:\s*(\S+)/.exec(stripComment(line))
      if (!m) return
      const identifier = m[1].split('@')[0]
      if (TRUSTED_WRITE_SCOPED_ACTIONS.has(identifier)) return
      hits.push({ job: jobName, line: headerLine + offset + 1, target: m[1] })
    })
  }
  return hits
}

/**
 * Whether a checkout `ref:` value (as `findCheckoutSteps` returns it, `null`
 * for a step with no `ref:` of its own) pins the checkout to the PR's BASE —
 * a commit in this repo's own history, never a fork's. `null` is NOT base
 * pinned: no override means the triggering event's default ref, which under
 * `pull_request` is `refs/pull/N/merge`, i.e. fork-controlled content.
 *
 * Shared by conditions 3 and 4 so "the untrusted job" means the identical
 * thing in both — a job that already passes condition 3 by pinning its
 * checkout is not the job a secret must be kept out of.
 *
 * @param {string | null} ref
 */
function isBasePinned(ref) {
  return ref !== null && BASE_REF_PATTERNS.some((re) => re.test(ref))
}

/**
 * Every `secrets` reference — accessor or whole-context expression, see
 * `referencesSecrets` — with its 1-based line number, in `lines`. Comments
 * are stripped first: this file's own prose (and `pr-overlap.yml`'s)
 * discusses tokens at length, and a comment SAYING `secrets.GITHUB_TOKEN` is
 * not a job holding one. That strip is the one place in this guard where
 * cutting too much loses a violation rather than inventing one, which is why
 * `stripComment` is quote-aware — see its docstring.
 *
 * @param {string[]} lines
 * @returns {{ offset: number, text: string }[]}  offset is 0-based into `lines`
 */
function findSecretReferences(lines) {
  const hits = []
  lines.forEach((line, i) => {
    const bare = stripComment(line)
    if (referencesSecrets(bare)) hits.push({ offset: i, text: bare.trim() })
  })
  return hits
}

/**
 * Condition 4 (see this file's header): every `secrets.` reference sitting in
 * a job that holds a checkout which is not base-pinned — the job running
 * fork-authored content. Independent of `permissions:` entirely, which is the
 * point: a PAT is a credential the `permissions:` block never mentions, so
 * conditions 1–3 cannot see the PAT half of the hazard this guard's header
 * names.
 *
 * A `secrets.` reference in the workflow PREAMBLE (anything above `jobs:` —
 * in practice a workflow-level `env:`) is inherited by every job, so it is
 * reported against each untrusted job with `scope: 'workflow'`, quoting the
 * preamble line it actually lives on.
 *
 * @param {string} src
 * @param {ReturnType<typeof splitJobs>} [jobs]  as in
 *   `findWriteScopedUnsafeCheckouts`; the default throws on a file with no
 *   `jobs:` block — a wiring failure, not a violation.
 */
export function findSecretsInUntrustedJobs(src, jobs = splitJobs(src)) {
  const lines = src.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  const preambleHits = findSecretReferences(lines.slice(0, jobsStart))

  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    const untrusted = findCheckoutSteps(body).some((step) => !isBasePinned(step.ref))
    if (!untrusted) continue
    for (const hit of findSecretReferences(body)) {
      hits.push({ job: jobName, line: headerLine + hit.offset + 1, text: hit.text, scope: 'job' })
    }
    for (const hit of preambleHits) {
      hits.push({ job: jobName, line: hit.offset + 1, text: hit.text, scope: 'workflow' })
    }
  }
  return hits
}

/**
 * #4148 — every `run:`-step checkout (see `RUN_STEP_CHECKOUT_PATTERNS`), in
 * EVERY job regardless of write scope, across the whole file. Feeds
 * conditions 1+2 the same way `findHeadCheckoutRefs` does: those conditions
 * fire on ANY step reaching PR head content once `pull_request_target` is
 * declared, independent of which job holds a write scope, because
 * `pull_request_target` hands every job in the file access to secrets
 * regardless of its `permissions:` block — see this file's header. Condition
 * 3 (write-scope-gated) reuses `findCheckoutSteps` directly instead, since it
 * already needs the per-job write-scope filter this function does not apply.
 *
 * @param {ReturnType<typeof splitJobs>} jobs
 */
export function findRunStepCheckouts(jobs) {
  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    for (const step of findCheckoutSteps(body)) {
      if (step.runCheckoutLine === null) continue
      hits.push({ job: jobName, line: headerLine + step.runCheckoutLine + 1 })
    }
  }
  return hits
}

/**
 * The full verdict for one workflow source string. Pulled out of `main` so
 * the self-test can exercise it against synthetic fixtures without touching
 * the real file.
 *
 * @param {string} src
 */
export function checkTrustBoundary(src) {
  const onBlock = extractOnBlock(src)
  const dangerous = declaresDangerousTrigger(onBlock)
  // Split ONCE and hand the same map to every condition. Not for speed at
  // this file size — so that "the untrusted job" and "the write-scoped job"
  // are provably statements about the identical set of jobs, rather than
  // about two independent parses that a future edit to `splitJobs` could
  // silently make disagree.
  const jobs = splitJobs(src)
  const headRefs = dangerous ? findHeadCheckoutRefs(src) : []
  // #4148 — the `run:`-step half of conditions 1+2's "ANY step checks out PR
  // head content" test; see `findRunStepCheckouts`.
  const runStepCheckouts = dangerous ? findRunStepCheckouts(jobs) : []
  const unsafeWriteCheckouts = findWriteScopedUnsafeCheckouts(src, jobs)
  const secretsInUntrustedJobs = findSecretsInUntrustedJobs(src, jobs)
  // #4183 condition 6 — see `findWriteScopedUntrustedActions`.
  const untrustedActionsInWriteScopedJobs = findWriteScopedUntrustedActions(src, jobs)
  return {
    dangerous,
    headRefs,
    runStepCheckouts,
    unsafeWriteCheckouts,
    secretsInUntrustedJobs,
    untrustedActionsInWriteScopedJobs,
    violation:
      (dangerous && (headRefs.length > 0 || runStepCheckouts.length > 0)) ||
      unsafeWriteCheckouts.length > 0 ||
      secretsInUntrustedJobs.length > 0 ||
      untrustedActionsInWriteScopedJobs.length > 0,
  }
}

/**
 * Render a `checkTrustBoundary` verdict as the lines `main` prints — pulled
 * out so a one-off check against a synthetic fixture (proving condition 3 is
 * not vacuous — see this file's header) can produce the exact same text
 * `main` would, without reading `WORKFLOW_PATH`.
 *
 * @param {ReturnType<typeof checkTrustBoundary>} result
 */
export function renderVerdict(result) {
  const lines = []
  if (!result.violation) {
    lines.push(
      result.dangerous
        ? 'OK: pr-overlap.yml triggers on pull_request_target, but no step checks out PR head content'
        : 'OK: pr-overlap.yml does not trigger on pull_request_target',
    )
    return { lines, exitCode: 0 }
  }
  if (result.dangerous && (result.headRefs.length > 0 || result.runStepCheckouts.length > 0)) {
    lines.push(
      'ERROR: pr-overlap.yml triggers on `pull_request_target` AND checks out PR head content —',
      'that is the exact combination #3967 removed: a `pull_request_target` run gets a token',
      'scoped by the `permissions:` block AS WRITTEN, with none of the fork read-only downgrade',
      '`pull_request` gets, so a job holding write and checking out PR-authored code can leak it.',
      'Offending checkout(s):',
    )
    // `hit.text` is the whole trimmed source line, `ref: …` / `repository: …`
    // key included, so it is printed AS IS — prefixing it with a literal
    // `ref: ` produced `line N: ref: ref: ${{ … }}`, and would be wrong
    // outright for the `repository:` hits.
    for (const hit of result.headRefs) lines.push(`  line ${hit.line}: ${hit.text}`)
    for (const hit of result.runStepCheckouts) {
      lines.push(
        `  line ${hit.line}, job \`${hit.job}\`: a \`run:\` step checks out PR content directly ` +
          '(not an actions/checkout `ref:`) — #4148',
      )
    }
    lines.push(
      '\nEither drop `pull_request_target`, or make the checkout use the default (base-branch) ref',
      'and get any PR-specific data from the job that already runs the untrusted checkout, via an',
      'artifact — see the `compute`/`post` split this file uses today.',
    )
  }
  if (result.unsafeWriteCheckouts.length > 0) {
    lines.push(
      'ERROR: a job declaring a write permission scope checks out code without a checkout',
      "pinned to the PR's BASE ref (`github.event.pull_request.base.sha` or `.base.ref`) —",
      "that is the #3967 shape regardless of what this file's `on:` trigger says today: a",
      "ref-less checkout under `pull_request` already defaults to the PR's own (fork-controlled",
      'for a fork PR) content, and a write-scoped job running that content can leak its token.',
      'Offending job / checkout:',
    )
    for (const hit of result.unsafeWriteCheckouts) {
      // The step's own line and the `ref:`'s line are quoted separately: a
      // `- name:`-first checkout step declares its `ref:` well below the line
      // that introduces the step, so one number cannot honestly stand for both.
      // A `run:`-step checkout (#4148) has neither a `ref:` nor a `with:`
      // block, so it gets its own message naming the matched `run:` line
      // instead of printing a misleading `ref: (none)`.
      const where =
        hit.runCheckoutLine !== null
          ? `no \`ref:\` at all — a \`run:\` step checks out PR content directly (line ${hit.runCheckoutLine})`
          : hit.forkRepository
            ? // A base-pinned `ref:` here is not a pass: `repository:` points
              // the clone at the FORK, so the base ref name resolves against
              // the fork's objects. Say which of the two facts is the problem.
              `${hit.ref ?? '(none)'} — but \`repository:\` points at the PR's HEAD repo (the fork), so the pin resolves against fork objects`
            : hit.refLine === null
              ? '(none)'
              : `${hit.ref} (line ${hit.refLine})`
      lines.push(`  job \`${hit.job}\`, checkout step at line ${hit.line}: ref: ${where}`)
    }
    lines.push(
      "\nEither drop the write permission from that job, or pin its checkout's `ref:` to",
      '`github.event.pull_request.base.sha` and move any PR-specific data through an artifact',
      'from a job with no write scope — see the `compute`/`post` split this file uses today.',
    )
  }
  if (result.secretsInUntrustedJobs.length > 0) {
    lines.push(
      'ERROR: a job whose checkout is NOT pinned to the PR base ref — i.e. a job running',
      'fork-authored content — references the `secrets` context. That is the #3967 hazard by',
      'its other route: a credential in the same job as untrusted code. `permissions:` says',
      'nothing about it, so conditions 1-3 above stay green while the mitigation is gone.',
      '`secrets.GITHUB_TOKEN` counts: it is read-only on a fork PR only because of the GitHub',
      'default #3967 deliberately stopped depending on. Offending job / reference:',
    )
    for (const hit of result.secretsInUntrustedJobs) {
      const where = hit.scope === 'workflow' ? ' (workflow-level, inherited by every job)' : ''
      lines.push(`  job \`${hit.job}\`, line ${hit.line}${where}: ${hit.text}`)
    }
    lines.push(
      '\nMove whatever needs the secret into a job that does NOT check out PR content (pin that',
      "job's checkout to `github.event.pull_request.base.sha`) and pass results between the two",
      'as an artifact — see the `compute`/`post` split this file uses today.',
    )
  }
  if (result.untrustedActionsInWriteScopedJobs.length > 0) {
    lines.push(
      'ERROR: a job declaring a write permission scope `uses:` an action outside the',
      'reviewed allowlist (#4183) — a checkout hidden behind a LOCAL composite action or an',
      'unreviewed third-party action is invisible to every other condition in this guard, which',
      'reads exactly this one file and cannot see what runs inside another. Offending job / step:',
    )
    for (const hit of result.untrustedActionsInWriteScopedJobs) {
      lines.push(`  job \`${hit.job}\`, line ${hit.line}: uses: ${hit.target}`)
    }
    lines.push(
      '\nEither drop the write permission from that job, or replace the step with one of the',
      'allowlisted actions (see `TRUSTED_WRITE_SCOPED_ACTIONS`) — extending the allowlist itself',
      'is a deliberate, reviewed edit to this file, not something to route around.',
    )
  }
  return { lines, exitCode: 1 }
}

function main() {
  let result
  try {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    result = checkTrustBoundary(src)
  } catch (err) {
    console.error(`ERROR: could not evaluate ${WORKFLOW_PATH}: ${err.message}`)
    return 2
  }
  const { lines, exitCode } = renderVerdict(result)
  for (const line of lines) (exitCode === 0 ? console.log : console.error)(line)
  return exitCode
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const SAFE_PULL_REQUEST_ONLY = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

const DANGEROUS_TARGET_WITH_HEAD_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  overlap:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
`

const SAFE_TARGET_NO_HEAD_CHECKOUT = `name: Open-PR file overlap (informational)

# NOTE for a reader: this fixture pins the SIBLING acceptance case —
# pull_request_target genuinely declared, paired with a checkout whose
# \`ref:\` is explicitly pinned to the BASE branch (not head). That is the
# actual GitHub-recommended mitigation, and the guard must not flag it, or
# it flags every legitimate use of the trigger.

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      # ref: pinned to the BASE branch, not head — the actual
      # GitHub-recommended mitigation for pull_request_target.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 1
          persist-credentials: false
`

// A trigger name mentioned only in a COMMENT inside the `on:` block — never
// as a real key — must not be mistaken for the trigger being declared. This
// is the fixture that actually exercises `extractOnBlock`'s comment-drop
// (`SAFE_TARGET_NO_HEAD_CHECKOUT` above does not: it declares
// pull_request_target for real).
const COMMENT_MENTION_IS_NOT_A_TRIGGER = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
    # pull_request_target is mentioned right here, inside the on: block, as
    # a COMMENT — extractOnBlock must drop this line before
    # declaresDangerousTrigger ever sees it, or a comment mentioning the
    # trigger's name would be mistaken for declaring it.

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// THE VACUOUSNESS PROOF for condition 3 (see this file's header): this is
// pr-overlap.yml's `compute`/`post` split COLLAPSED back into one job, under
// TODAY's actual `pull_request` trigger — no `pull_request_target` anywhere,
// so conditions 1+2 (and the OLD version of this guard, before condition 3
// existed) see nothing wrong. The job holds a write scope AND its checkout
// carries no \`ref:\` override at all, which under \`pull_request\` defaults to
// \`refs/pull/N/merge\` — fork-controlled content for a fork PR. That is
// exactly the #3967 shape. If this fixture does not turn condition 3 red,
// the guard is back to asserting nothing about the split it is named for.
const COLLAPSED_SINGLE_JOB_UNDER_PULL_REQUEST = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  overlap:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// THE SHAPE OF THE FILE UNDER GUARD. `pr-overlap.yml`'s `post` job does not
// write its checkout as `- uses: actions/checkout@…` on one line: it opens
// with `- name: Checkout the TRUSTED script source`, spends seventeen lines
// of comment on why the ordering is load-bearing, and only then reaches
// `uses:` and `with:`. An earlier revision of \`findCheckoutSteps\` required
// the `-` and the `uses:` on the SAME line, so it saw ZERO checkout steps in
// \`post\` — the only write-scoped job in the file — and condition 3 asserted
// nothing at all, while every fixture above (all `- uses:`-first) stayed
// green and assertion 5 passed because the hazard was INVISIBLE rather than
// absent. This fixture reproduces the real step shape and carries the
// one-line head-ref edit that reinstates the #3967 arrangement; condition 3
// must catch it.
const NAME_FIRST_HEAD_REF_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        # A long comment between the step's \`- name:\` line and its \`uses:\`
        # line, exactly as the real file has — this is the gap the old
        # same-line regex fell into.
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
`

// The \`ref:\` this guard reads must be the checkout's OWN — a direct child of
// the step's \`with:\` mapping — not merely the first \`ref:\` at any depth
// inside the step block. Here the step declares NO checkout ref (so under
// \`pull_request\` it takes the fork-controlled \`refs/pull/N/merge\` default,
// the #3967 shape) while a DIFFERENT, base-pinned \`ref:\` sits nested under
// another \`with:\` key. Reading that nested value as the checkout's ref would
// launder this step past condition 3.
const NESTED_REF_IS_NOT_THE_CHECKOUT_REF = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          # A hypothetical future option carrying its own mapping, whose
          # \`ref:\` is NOT this checkout's ref.
          fallback:
            ref: \${{ github.event.pull_request.base.sha }}
`

// A `permissions:` block that NAMES a write scope in a comment while granting
// none. `pr-overlap.yml`'s `compute` job comments about exactly this — why it
// holds no write scope — and reading the comment as a live grant would make
// condition 3 flag the untrusted job for the permission it deliberately does
// not have. Fails safe, but produces a red no one can explain from the file.
const COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      # #3967 dropped \`pull-requests: write\` from this job — it runs
      # fork-authored code and must hold nothing worth stealing.
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// CONDITION 4's FALSIFICATION. `pr-overlap.yml`'s `compute` job, unchanged
// except for the one edit this file's header calls the OTHER way the fork
// downgrade dies: a PAT handed to the job that runs fork-authored code. The
// `permissions:` block still says `contents: read`; the trigger is still
// plain `pull_request`; conditions 1, 2 and 3 all see a clean file. Only a
// check that reads `secrets.` catches this.
const SECRET_PAT_IN_UNTRUSTED_JOB = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Post the table from here, it is simpler
        env:
          GH_TOKEN: \${{ secrets.A_PAT_WITH_WRITE }}
        run: gh pr comment "$PR_NUMBER" --body-file table.md
`

// The SIBLING ACCEPTANCE for condition 4: `pr-overlap.yml`'s real `post` job
// holds \`secrets.GITHUB_TOKEN\` and must keep holding it. It is allowed to,
// because its checkout is pinned to the PR BASE — it is the TRUSTED half of
// the split. Condition 4 must not flag it, or the guard forbids the very
// arrangement #3967 introduced.
const SECRET_IN_BASE_PINNED_JOB_IS_FINE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Post the table
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh pr comment "$PR_NUMBER" --body-file table.md
`

// A secret named only in a COMMENT inside the untrusted job — the shape
// `pr-overlap.yml`'s `compute` job actually carries, which explains at length
// which token it does NOT hold. Reading that as a live reference fails safe
// but produces a red nobody can explain from the file, the same objection
// `COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE` pins for condition 3.
const SECRET_NAMED_ONLY_IN_A_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # No \`GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\` anywhere in this job —
      # #3967 moved everything that needs a token into \`post\`.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// The same hazard declared one level up: a workflow-level \`env:\` is inherited
// by EVERY job, so a secret placed there reaches the untrusted checkout
// without appearing anywhere inside the job's own body.
const WORKFLOW_LEVEL_SECRET_ENV = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

env:
  GH_TOKEN: \${{ secrets.A_PAT_WITH_WRITE }}

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// COMMENT EVASION ON THE \`ref:\` VALUE. Condition 3 accepts a \`ref:\` that
// CONTAINS \`pull_request.base.sha\` — a substring test, because the real value
// is an interpolation. Without comment-stripping, a trailing comment MENTIONING
// the base ref makes a head checkout read as base-pinned: the write-scoped job
// checks out fork content and the guard prints OK. Every other value this
// guard reads already routes through \`stripComment\`; this one did not.
const HEAD_REF_LAUNDERED_BY_A_TRAILING_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the PR's own content
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }} # not github.event.pull_request.base.sha, we need the real diff
          persist-credentials: false
`

// A TWO-SPACE-INDENTED COMMENT ENDING IN A COLON is not a job header.
// \`pr-overlap.yml\` separates its jobs with exactly this kind of prose banner,
// so this line is in the file's own idiom. Read as a header, it invents a
// phantom job that inherits the workflow-level \`contents: read\` (it declares
// no \`permissions:\` of its own) and swallows the rest of \`post\`'s body — so
// the write-scoped job below has no checkout left to inspect and its
// unpinned checkout belongs to a job condition 3 skips. Silent false
// negative: this fixture is a REAL violation that a phantom-job split
// reports as clean.
const COMMENT_LINE_IS_NOT_A_JOB_HEADER = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
  # A banner comment in this file's own prose idiom, ending in a colon —
  # about \`post\` above and what follows, not a new job. On its contract:
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// THE MIRROR IMAGE of `COMMENT_LINE_IS_NOT_A_JOB_HEADER`: there a comment was
// read as a job, here a job is not read at all. `  post: # posts the table`
// is an ordinary job header with an ordinary trailing comment — nothing
// exotic, nothing adversarial, the sort of line anyone might type — and the
// header regex requires end-of-line after the colon, so it matched nothing
// and `post`'s entire body folded into `compute` above it. `compute` is the
// untrusted half and declares `contents: read`, so the merged job reads as
// non-write-scoped, condition 3 skips it, and the write-scoped `post` with
// its ref-less (fork-content) checkout vanishes from the guard's view. Like
// the banner fixture, this file is a REAL violation that the unfixed split
// reports as clean.
const JOB_HEADER_WITH_A_TRAILING_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

  post: # posts the table \`compute\` produced
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// A FLUSH-LEFT BANNER BETWEEN TWO JOBS. Legal YAML — a comment has no
// indentation semantics — but `splitJobs` treated any column-0 line as the
// next top-level key and stopped there, deleting `post` and everything after
// it from conditions 3 and 4. This repo's banners happen to be two-space
// indented today, which is the only reason the phantom-job bug was the one
// that got hit and this one did not; a single reflow of a comment block
// swaps which of the two is live.
const COLUMN_ZERO_COMMENT_BETWEEN_JOBS = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

# ─── the trusted half ────────────────────────────────────────────────────
#
# A banner written flush left rather than indented into the block, in the
# idiom this workflow's own header uses. It ends nothing.

  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// THE SAME BREAK IN `extractOnBlock`, with the consequence that belongs to
// conditions 1+2 instead of 3+4: a flush-left banner inside the `on:` mapping
// truncated the block, so a `pull_request_target:` declared BELOW it was
// never seen and `dangerous` came back false on a file that declares the
// trigger. Nothing else in this fixture is a violation — the job holds no
// write scope and no secret — so conditions 1+2 are the only thing that can
// catch it, which is exactly the point.
const COLUMN_ZERO_COMMENT_INSIDE_THE_ON_BLOCK = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

# ─── and the dangerous trigger, below a flush-left banner ────────────────
#
# Legal YAML: a comment between two entries of the \`on:\` mapping, written at
# column 0. The mapping continues below it.

  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
`

// \`toJSON(secrets)\` — condition 4's one-line edit, in the spelling that
// carries no accessor. It is GitHub's own documented way to reach the whole
// context, and it hands the untrusted job EVERY secret at once rather than
// one; an accessor-shaped regex (\`secrets\` followed by \`.\` or \`[\`) sees a
// \`)\` and matches nothing. Trigger, \`permissions:\` and checkout are the real
// file's, untouched — conditions 1, 2 and 3 all stay green here, as with
// \`SECRET_PAT_IN_UNTRUSTED_JOB\`.
const TOJSON_SECRETS_IN_UNTRUSTED_JOB = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Dump the environment while debugging the diverged step
        env:
          EVERYTHING: \${{ toJSON(secrets) }}
        run: node scripts/pr-overlap-debug.mjs
`

// A SECRET BEHIND A QUOTED \`#\`. The naive \`stripComment\` cut at the first
// \`#\` on the line whatever surrounded it, so the hash inside \`'#'\` truncated
// this \`run:\` before the PAT and condition 4 saw a clean job — the one place
// in this guard where over-stripping LOSES a violation instead of inventing
// one. The second step is the acceptance that keeps the fix honest: a
// genuine trailing comment naming the same secret must still be ignored, so
// this fixture must produce exactly ONE hit, not two.
const SECRET_BEHIND_A_QUOTED_HASH = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Fetch the table, marking the payload with a literal hash
        run: |
          echo '#' && curl -sSf -H "authorization: bearer \${{ secrets.A_PAT_WITH_WRITE }}" https://example.invalid/t
      - name: The same token, genuinely commented out
        run: node scripts/pr-file-overlap.mjs # was \${{ secrets.A_PAT_WITH_WRITE }}
`

// #4148's OWN FALSIFICATION, verbatim from the issue: a write-scoped job
// whose ONLY checkout is \`gh pr checkout\` inside a \`run:\` step — no
// \`actions/checkout\` anywhere, no \`ref:\` line anywhere. Before this fix,
// EVERY condition in this file stayed green on it: condition 3 only
// recognised a step as a checkout when it \`uses: actions/checkout@\`, so this
// step was invisible to it entirely, while doing precisely the thing the
// guard exists to prevent — a write-scoped job running fork-authored content.
const WRITE_SCOPED_JOB_GH_PR_CHECKOUT_IN_RUN_STEP = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Check out the PR's own content, the idiomatic CLI way
        run: gh pr checkout \${{ github.event.number }}

      - name: Post the table
        run: gh pr comment "\${{ github.event.number }}" --body-file table.md
`

// The SECOND evasion the issue names: fetching the PR's head ref and checking
// it out with plain git, split across two \`run:\` lines inside one step's
// block scalar — the shape the issue's own example uses. Every condition
// stays green up to and including condition 3's OLD \`uses: actions/checkout@\`
// test, for the same reason as the fixture above.
const WRITE_SCOPED_JOB_GIT_FETCH_CHECKOUT_IN_RUN_STEP = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Check out the PR's own content, the plain-git way
        run: |
          git fetch origin refs/pull/\${{ github.event.number }}/head
          git checkout FETCH_HEAD

      - name: Post the table
        run: gh pr comment "\${{ github.event.number }}" --body-file table.md
`

// Conditions 1+2's half of #4148: \`pull_request_target\` declared, no
// write-scoped job at all (so condition 3 has nothing to say), and the ONLY
// checkout of PR content is a \`run:\`-step \`gh pr checkout\` — no \`ref:\` line
// anywhere for condition 2's OLD \`findHeadCheckoutRefs\` scan to find. Under
// \`pull_request_target\` every job gets secret access regardless of its
// \`permissions:\` block (see this file's header), so this is dangerous even
// though the job itself asks for no write scope.
const DANGEROUS_TARGET_WITH_RUN_STEP_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Check out the PR's own content, the idiomatic CLI way
        run: gh pr checkout \${{ github.event.number }}
`

// THE NEGATIVE CONTROL for #4148: an ORDINARY \`git fetch\` of the BASE branch
// — exactly the shape \`pr-overlap.yml\`'s real \`post\` job already uses
// (\`git fetch --quiet --no-tags origin "$BASE_REF"\`) — must NOT be flagged.
// \`RUN_STEP_CHECKOUT_PATTERNS\`' fetch pattern requires \`refs/pull/\` in the
// same line; a fetch of a named branch never matches it. Without this fixture
// a version of the pattern that matched ANY \`git fetch\` would pass every
// other assertion in this file (none of them fetch a non-\`refs/pull\` ref)
// while making the real \`post\` job's own ordinary fetch a false positive.
const WRITE_SCOPED_JOB_ORDINARY_BASE_FETCH_IS_FINE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Fetch the base branch to diff against, same idiom as the real file
        run: git fetch --quiet --no-tags origin "$BASE_REF" || true
`

// A \`run:\` step whose TEXT merely mentions \`gh pr checkout\` inside a
// comment, never actually running it — the same discipline as
// \`SECRET_NAMED_ONLY_IN_A_COMMENT\` and \`COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE\`
// above: a whole-line YAML comment naming the shape is not the shape being
// used, and \`isCommentLine\` must still filter it out inside a step block.
const RUN_STEP_CHECKOUT_MENTIONED_ONLY_IN_A_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Post the table
        # Deliberately NOT using \`gh pr checkout\` here — see #4148 for why.
        run: gh pr comment "\${{ github.event.number }}" --body-file table.md
`

// ─── the evasions an adversarial pass found against the FIRST cut of
// `RUN_STEP_CHECKOUT_PATTERNS` (#4148 review) ──────────────────────────────
//
// Each of these was GREEN against the anchored patterns that shipped in the
// first draft (`gh\s+pr\s+checkout`, `git\s+checkout\s+FETCH_HEAD`), and each
// reaches exactly the same fork-authored content as the two fixtures above.
// They are written as ONE fixture per evasion CLASS, not one per verb, with
// the verb sweep done in the assertion block below — a fixture per verb would
// be ten near-identical strings pinning one alternation.
//
// 1. `gh` with a GLOBAL FLAG before the subcommand. `gh -R owner/repo pr
//    checkout 1` is the documented spelling for a checkout against an
//    explicitly named repo, and `gh\s+pr` cannot match it.
const WRITE_SCOPED_JOB_GH_GLOBAL_FLAG_BEFORE_PR_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Check out the PR, naming the repo explicitly
        run: gh -R "\${{ github.repository }}" pr checkout \${{ github.event.number }}
`

// 2. A FOLDED block scalar (`run: >`) splitting one command across source
//    lines. YAML rejoins them with spaces before the shell sees them, so the
//    step runs `git fetch origin refs/pull/1/head && git checkout FETCH_HEAD`
//    while NO single source line carries both `git fetch` and `refs/pull/`.
//    This is the shape the per-line scan is structurally blind to, and the
//    reason `findCheckoutSteps` also matches against the flattened block.
const WRITE_SCOPED_JOB_FOLDED_SCALAR_FETCH = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Check out the PR, folded across lines
        run: >
          git fetch origin
          refs/pull/\${{ github.event.number }}/head
`

// 3. A git verb OTHER than \`checkout\` consuming a fetched \`FETCH_HEAD\`.
//    \`git worktree add\` materialises the fork's tree just as completely as
//    \`git checkout\` does, and the fetch here names a SHA rather than a
//    \`refs/pull/\` ref, so the fetch pattern has nothing to match either —
//    the whole step hung on the one anchored verb.
const WRITE_SCOPED_JOB_WORKTREE_FROM_FETCH_HEAD = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Materialise the PR head without the word "checkout"
        env:
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          git fetch origin "$HEAD_SHA"
          git worktree add /tmp/pr FETCH_HEAD
`

// 4. \`merge_commit_sha\` — GitHub's precomputed merge of head into base, the
//    same content \`refs/pull/<n>/merge\` names, spelled as an event field.
//    Under \`pull_request_target\` in a job with NO write scope, conditions
//    1+2 are the only ones that can fire, and \`HEAD_REF_PATTERNS\` did not
//    name it.
const DANGEROUS_TARGET_WITH_MERGE_COMMIT_SHA = `name: Open-PR file overlap (informational)

on:
  pull_request_target:
    branches: [main]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.merge_commit_sha }}
          persist-credentials: false
`

// 5. THE LAUNDERING CASE: a \`ref:\` pinned to the PR BASE — the one shape
//    condition 3 ACCEPTS — while \`repository:\` redirects the whole clone at
//    the fork. The base ref's NAME then resolves against the fork's object
//    graph, i.e. content the fork author controls, and the pin buys nothing.
//    Without \`FORK_REPOSITORY_PATTERNS\` this fixture is green on every
//    condition: \`isBasePinned\` says yes and condition 3 skips the step.
const WRITE_SCOPED_JOB_BASE_PINNED_BUT_FORK_REPOSITORY = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Base-pinned ref, fork repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false
`

// NEGATIVE CONTROL for the widened FETCH_HEAD alternation: a READ-ONLY
// inspection of \`FETCH_HEAD\` puts no fork content in the tree. \`git
// rev-parse FETCH_HEAD\` after an ordinary base-branch fetch is a diagnostic,
// and a pattern matching a bare \`git … FETCH_HEAD\` would red on it. Without
// this fixture the obvious over-broad simplification passes every other
// assertion in this file.
const WRITE_SCOPED_JOB_READ_ONLY_FETCH_HEAD_INSPECTION_IS_FINE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Report which base commit we fetched
        env:
          BASE_REF: \${{ github.event.pull_request.base.ref }}
        run: |
          git fetch --quiet --no-tags origin "$BASE_REF" || true
          echo "base tip: $(git rev-parse FETCH_HEAD)"
`

// #4183 condition 6 — THE FALSIFICATION: a write-scoped job whose checkout
// is hidden behind a LOCAL COMPOSITE ACTION. No \`ref:\` line, no \`run:\` text
// matching \`RUN_STEP_CHECKOUT_PATTERNS\` — every OTHER condition in this file
// is structurally blind to it (condition 3 never even recognises the step as
// a checkout: \`findCheckoutSteps\` requires \`uses: actions/checkout@\` or one
// of the \`run:\` shapes, and this step is neither), which is exactly class 1
// from #4183's own body. The composite action itself is not written here —
// by design, per the header's "no single-file textual check can see it".
const WRITE_SCOPED_JOB_LOCAL_COMPOSITE_ACTION = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Prepare the PR content (composite action)
        uses: ./.github/actions/prepare-pr-content
`

// The sibling shape: an UNREVIEWED THIRD-PARTY action, same reasoning —
// this guard cannot read \`some-org/checkout-ish\`'s own source to know
// whether it checks out fork content.
const WRITE_SCOPED_JOB_THIRD_PARTY_ACTION = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Fetch PR content via a third-party action
        uses: some-org/checkout-ish@v1
`

// NEGATIVE CONTROL 1: the SAME write-scoped job, using ONLY the allowlisted
// actions \`pr-overlap.yml\` itself relies on today — must stay green, or
// condition 6 flags every legitimate use of the split it is meant to protect.
const WRITE_SCOPED_JOB_ONLY_ALLOWLISTED_ACTIONS = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Download the divergence result
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: pr-overlap-diverged-\${{ github.event.pull_request.number }}
          path: artifact/
`

// NEGATIVE CONTROL 2: the IDENTICAL local composite action step, in a job
// with NO write scope. Condition 6 is deliberately scoped to write-scoped
// jobs only (see the header's condition-6 section) — a read-only job using
// an unreviewed action is a different, already-accepted risk this guard does
// not attempt to police, and this fixture proves condition 6 does not
// over-broaden into flagging every \`uses:\` in the file.
const READ_ONLY_JOB_LOCAL_COMPOSITE_ACTION_IS_FINE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - name: Prepare the PR content (composite action)
        uses: ./.github/actions/prepare-pr-content
`

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  // 1. THE FALSIFICATION: pull_request_target + an explicit head checkout
  //    must fail, and must name the offending line.
  {
    const r = checkTrustBoundary(DANGEROUS_TARGET_WITH_HEAD_CHECKOUT)
    expect(
      'pull_request_target + a head-ref checkout is flagged as a violation',
      r.violation === true && r.dangerous === true,
      JSON.stringify(r),
    )
    expect(
      'the offending ref line is the one naming pull_request.head.sha',
      r.headRefs.length === 1 && /pull_request\.head\.sha/.test(r.headRefs[0].text),
      JSON.stringify(r.headRefs),
    )
  }

  // 2. THE SIBLING ACCEPTANCE: pull_request_target alone, with a checkout
  //    that explicitly pins the BASE ref, is safe — the guard must not
  //    flag every legitimate use of the trigger.
  {
    const r = checkTrustBoundary(SAFE_TARGET_NO_HEAD_CHECKOUT)
    expect(
      'pull_request_target + a base-ref-only checkout is NOT a violation',
      r.violation === false && r.dangerous === true,
      JSON.stringify(r),
    )
  }

  // 3. today's actual trigger (no pull_request_target at all) is safe
  //    regardless of what any checkout step's ref looks like.
  {
    const r = checkTrustBoundary(SAFE_PULL_REQUEST_ONLY)
    expect(
      'a plain `pull_request` trigger is not dangerous, independent of checkout refs',
      r.violation === false && r.dangerous === false,
      JSON.stringify(r),
    )
  }

  // 4. A file with no `on:` block at all is a WIRING failure (throws), not
  //    a silent "safe" — same discipline check-android-trigger.mjs applies
  //    to a renamed `android_re='…'` variable.
  {
    let threw = false
    try {
      checkTrustBoundary('name: not a real workflow\njobs:\n  x:\n    runs-on: ubuntu-24.04\n')
    } catch {
      threw = true
    }
    expect('a file with no `on:` block throws rather than reporting "safe"', threw, 'did not throw')
  }

  // 5. THE ACTUAL FILE, today, must pass — the wiring check that this guard
  //    is still pointed at the file #3967 fixed and the fix still holds.
  //    This is meaningful, not vacuous, ONLY because of assertion 7 below:
  //    that assertion proves condition 3 turns red on the file this guard
  //    would pass if condition 3 did not exist.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const r = checkTrustBoundary(src)
    expect(
      'pr-overlap.yml itself passes today (the #3967 split holds)',
      r.violation === false,
      JSON.stringify(r),
    )
  }

  // 6. A trigger name mentioned only in a COMMENT inside `on:` is not
  //    mistaken for the trigger being declared — the behaviour
  //    `extractOnBlock`'s own docstring claims, actually exercised.
  {
    const r = checkTrustBoundary(COMMENT_MENTION_IS_NOT_A_TRIGGER)
    expect(
      'a comment naming pull_request_target inside `on:` does not make `dangerous` true',
      r.dangerous === false && r.violation === false,
      JSON.stringify(r),
    )
  }

  // 7. CONDITION 3 IS NOT VACUOUS: collapse the compute/post split back into
  //    one write-scoped job that checks out PR code, under TODAY's plain
  //    `pull_request` trigger (no pull_request_target anywhere — conditions
  //    1+2 see nothing). This is the exact edit #3967 removed and the exact
  //    edit assertion 5 above would NOT catch without condition 3: revert
  //    this PR and the guard still prints OK on conditions 1+2 alone.
  {
    const r = checkTrustBoundary(COLLAPSED_SINGLE_JOB_UNDER_PULL_REQUEST)
    expect(
      'a reverted single write-scoped job with an unpinned checkout IS flagged, even though dangerous === false',
      r.violation === true && r.dangerous === false && r.unsafeWriteCheckouts.length === 1,
      JSON.stringify(r),
    )
    expect(
      'the offending job is named, and its checkout has no ref: at all',
      r.unsafeWriteCheckouts[0]?.job === 'overlap' && r.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(r.unsafeWriteCheckouts),
    )
    const rendered = renderVerdict(r)
    expect(
      'main()-style output for this fixture is non-zero and names the job',
      rendered.exitCode === 1 && rendered.lines.some((l) => l.includes('`overlap`')),
      JSON.stringify(rendered),
    )

    // …and the same, on the step shape the REAL file actually uses: a
    // `- name:`-first checkout whose `uses:` and `ref:` are many lines below
    // the line introducing the step. Every fixture above is `- uses:`-first,
    // which is precisely how condition 3 shipped vacuous once already — the
    // fixtures did not mirror the file under guard.
    const nameFirst = checkTrustBoundary(NAME_FIRST_HEAD_REF_CHECKOUT)
    expect(
      'a `- name:`-first checkout step (the shape the real file uses) is SEEN by condition 3',
      nameFirst.violation === true &&
        nameFirst.dangerous === false &&
        nameFirst.unsafeWriteCheckouts.length === 1,
      JSON.stringify(nameFirst),
    )
    expect(
      'its head ref is read from the `with:` block several lines below that `- name:` line',
      /pull_request\.head\.sha/.test(nameFirst.unsafeWriteCheckouts[0]?.ref ?? ''),
      JSON.stringify(nameFirst.unsafeWriteCheckouts),
    )

    // The `ref:` must come from the step's own `with:` mapping, not from any
    // deeper nesting under some other key.
    const nested = checkTrustBoundary(NESTED_REF_IS_NOT_THE_CHECKOUT_REF)
    expect(
      'a base-pinned `ref:` nested under another `with:` key does not count as the checkout ref',
      nested.violation === true &&
        nested.unsafeWriteCheckouts.length === 1 &&
        nested.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(nested),
    )
  }

  // 8. A write scope named only in a COMMENT inside a `permissions:` block is
  //    not a granted scope — the same discipline assertion 6 applies to the
  //    `on:` block, applied to the input condition 3 gates on.
  {
    const r = checkTrustBoundary(COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE)
    expect(
      'a comment naming `pull-requests: write` inside `permissions:` is not a write scope',
      r.violation === false && r.unsafeWriteCheckouts.length === 0,
      JSON.stringify(r),
    )
  }

  // 9. THE WIRING PIN behind assertion 5: assertion 5 says the real file
  //    PASSES, and a check that inspects nothing passes too. So assert that
  //    condition 3 actually reaches a checkout step in this file — at least
  //    one write-scoped job, and at least one checkout step inside it. This
  //    is the assertion that would have failed on the revision where
  //    `findCheckoutSteps` could not see `post`'s `- name:`-first step.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const jobs = splitJobs(src)
    const writeScoped = Object.entries(jobs).filter(([, { body }]) => jobDeclaresWriteScope(body))
    const inspected = writeScoped.flatMap(([name, { body }]) =>
      findCheckoutSteps(body).map((step) => ({ job: name, ref: step.ref })),
    )
    expect(
      'condition 3 inspects at least one checkout step in a write-scoped job of pr-overlap.yml',
      writeScoped.length > 0 && inspected.length > 0,
      `write-scoped jobs: ${JSON.stringify(writeScoped.map(([n]) => n))}, checkout steps inspected: ${inspected.length}`,
    )
    expect(
      'and every one of those it inspects is pinned to the PR base ref',
      inspected.every((s) => s.ref !== null && BASE_REF_PATTERNS.some((re) => re.test(s.ref))),
      JSON.stringify(inspected),
    )
  }

  // 10. CONDITION 4 IS NOT VACUOUS: a PAT added to the untrusted job. Every
  //     other condition stays green on this fixture — the `permissions:`
  //     block is untouched `contents: read` and the trigger is plain
  //     `pull_request` — which is the whole point: before condition 4, this
  //     edit reinstated the #3967 arrangement with zero reaction from this
  //     guard.
  {
    const r = checkTrustBoundary(SECRET_PAT_IN_UNTRUSTED_JOB)
    expect(
      'a PAT in the job holding the unpinned (fork-content) checkout IS flagged',
      r.violation === true && r.secretsInUntrustedJobs.length === 1,
      JSON.stringify(r),
    )
    expect(
      'and it is flagged by condition 4 ALONE — trigger and permissions are untouched',
      r.dangerous === false && r.headRefs.length === 0 && r.unsafeWriteCheckouts.length === 0,
      JSON.stringify(r),
    )
    expect(
      'the offending job, line and text are named',
      r.secretsInUntrustedJobs[0]?.job === 'compute' &&
        r.secretsInUntrustedJobs[0]?.scope === 'job' &&
        /secrets\.A_PAT_WITH_WRITE/.test(r.secretsInUntrustedJobs[0]?.text ?? '') &&
        SECRET_PAT_IN_UNTRUSTED_JOB.split('\n')[r.secretsInUntrustedJobs[0].line - 1]?.includes(
          'A_PAT_WITH_WRITE',
        ),
      JSON.stringify(r.secretsInUntrustedJobs),
    )
    const rendered = renderVerdict(r)
    expect(
      'main()-style output for the PAT fixture is non-zero and names the job',
      rendered.exitCode === 1 && rendered.lines.some((l) => l.includes('`compute`')),
      JSON.stringify(rendered),
    )

    // The same secret one level up, in a workflow-level `env:` inherited by
    // every job — invisible to a scan of the job body alone.
    const wf = checkTrustBoundary(WORKFLOW_LEVEL_SECRET_ENV)
    expect(
      'a workflow-level `env:` secret is charged to the untrusted job that inherits it',
      wf.violation === true &&
        wf.secretsInUntrustedJobs.length === 1 &&
        wf.secretsInUntrustedJobs[0]?.job === 'compute' &&
        wf.secretsInUntrustedJobs[0]?.scope === 'workflow',
      JSON.stringify(wf),
    )
  }

  // 11. CONDITION 4's TWO ACCEPTANCES, so it does not simply ban the word
  //     `secrets`: the TRUSTED half of the split (base-pinned checkout) may
  //     hold `secrets.GITHUB_TOKEN` — that is the arrangement #3967 built —
  //     and a secret NAMED IN A COMMENT is not a secret held.
  {
    const trusted = checkTrustBoundary(SECRET_IN_BASE_PINNED_JOB_IS_FINE)
    expect(
      '`secrets.GITHUB_TOKEN` in a job whose checkout is base-pinned is NOT a violation',
      trusted.violation === false && trusted.secretsInUntrustedJobs.length === 0,
      JSON.stringify(trusted),
    )
    const commented = checkTrustBoundary(SECRET_NAMED_ONLY_IN_A_COMMENT)
    expect(
      'a `secrets.` reference inside a COMMENT in the untrusted job is not a secret held',
      commented.violation === false && commented.secretsInUntrustedJobs.length === 0,
      JSON.stringify(commented),
    )
  }

  // 12. THE `ref:` COMMENT EVASION: a head checkout whose trailing comment
  //     mentions the base ref must not read as base-pinned. Before
  //     `refFromWithMapping` stripped comments, `BASE_REF_PATTERNS`
  //     substring-matched the comment and condition 3 waved the step through.
  {
    const r = checkTrustBoundary(HEAD_REF_LAUNDERED_BY_A_TRAILING_COMMENT)
    expect(
      'a head `ref:` with a trailing comment mentioning the base ref is still flagged',
      r.violation === true && r.unsafeWriteCheckouts.length === 1,
      JSON.stringify(r),
    )
    expect(
      "the reported ref is the comment-stripped value, so the failure message quotes what's live",
      r.unsafeWriteCheckouts[0]?.ref === '${{ github.event.pull_request.head.sha }}',
      JSON.stringify(r.unsafeWriteCheckouts),
    )
  }

  // 13. A TWO-SPACE COMMENT ENDING IN `:` IS NOT A JOB HEADER. Two
  //     assertions, because the second one alone would not say WHY: first
  //     that `splitJobs` reports exactly the one real job, then that the
  //     violation this fixture actually contains is still seen. Read as a
  //     header, the comment forks a phantom job that inherits `contents:
  //     read`, owns the checkout, and is skipped by condition 3 — so the
  //     fixture reports clean.
  {
    const jobs = splitJobs(COMMENT_LINE_IS_NOT_A_JOB_HEADER)
    expect(
      'a 2-space-indented comment ending in `:` does not become a phantom job',
      JSON.stringify(Object.keys(jobs)) === JSON.stringify(['post']),
      JSON.stringify(Object.keys(jobs)),
    )
    const r = checkTrustBoundary(COMMENT_LINE_IS_NOT_A_JOB_HEADER)
    expect(
      'and the write-scoped job below that comment keeps its unpinned checkout, and is flagged',
      r.violation === true &&
        r.unsafeWriteCheckouts.length === 1 &&
        r.unsafeWriteCheckouts[0]?.job === 'post' &&
        r.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(r),
    )
  }

  // 14. THE WIRING PIN behind condition 4 on the REAL file, the same
  //     discipline assertion 9 applies to condition 3: "no secrets found" is
  //     also what a check that classifies NO job as untrusted would report.
  //     So assert that `pr-overlap.yml` really does contain a job condition 4
  //     considers untrusted (it does: `compute`, whose ref-less checkout is
  //     the fork-content one by design), and that the file's real
  //     `secrets.GITHUB_TOKEN` uses live in a job that is NOT one of those.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const jobs = splitJobs(src)
    const untrusted = Object.entries(jobs)
      .filter(([, { body }]) => findCheckoutSteps(body).some((step) => !isBasePinned(step.ref)))
      .map(([name]) => name)
    expect(
      'condition 4 classifies at least one job of pr-overlap.yml as holding untrusted content',
      untrusted.length > 0,
      `untrusted jobs: ${JSON.stringify(untrusted)}`,
    )
    const secretsAnywhere = findSecretReferences(src.split('\n'))
    expect(
      'and the file does carry real `secrets.` references — in the trusted job only',
      secretsAnywhere.length > 0 && findSecretsInUntrustedJobs(src).length === 0,
      `secret lines: ${JSON.stringify(secretsAnywhere.map((h) => h.offset + 1))}`,
    )
  }

  // 15. THE ONE LINE-NUMBER CITATION `pr-overlap.yml` MAKES ABOUT ITSELF.
  //     `merge-result`'s fetch step justifies its `|| true` by pointing at
  //     "the tolerant equivalent above in `compute` (line N)". That number
  //     was written before #3967 split the job in two and pointed, after the
  //     split, at a COMMENT line in `compute`'s banner — a citation that
  //     reads as precise and is not. `check-doc-code-paths.mjs` polices
  //     backticked PATH citations in `.md`/`.ts`/`.tsx`, and none of that
  //     reaches a bare `(line N)` inside a `.yml` comment, so this file's
  //     one self-citation is pinned here: the cited line must actually be
  //     the tolerant `git fetch … || true`, and must actually be inside
  //     `compute`. Same argument as the rest of this guard — the #3672 issue
  //     it descends from is about a comment that went stale unnoticed.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const lines = src.split('\n')
    const anchor = lines.findIndex((l) => /tolerant equivalent above in `compute`/.test(l))
    const citation =
      anchor === -1 ? null : /\(line (\d+)\)/.exec(lines.slice(anchor, anchor + 3).join('\n'))
    const citedLine = citation === null ? null : lines[Number(citation[1]) - 1]
    const compute = splitJobs(src).compute
    const inCompute =
      citation !== null &&
      compute !== undefined &&
      Number(citation[1]) > compute.headerLine &&
      Number(citation[1]) <= compute.headerLine + compute.body.length
    expect(
      "pr-overlap.yml's `(line N)` self-citation points at `compute`'s tolerant `git fetch … || true`",
      citedLine !== null && inCompute && /git fetch .*\|\| true/.test(citedLine),
      `anchor line ${anchor + 1}, citation ${citation?.[1] ?? '(none)'}, cited text: ${JSON.stringify(citedLine)}`,
    )
  }

  // 16. A JOB HEADER WITH A TRAILING COMMENT IS STILL A JOB HEADER — the
  //     mirror of assertion 13. Two assertions again, and for the same
  //     reason: the second alone would not say why. Read without stripping
  //     the comment, `  post: # …` is not a header, `post`'s body folds into
  //     the untrusted `compute` above it, the merged job reads as
  //     `contents: read`, and the write-scoped job's fork-content checkout is
  //     never inspected.
  {
    const jobs = splitJobs(JOB_HEADER_WITH_A_TRAILING_COMMENT)
    expect(
      'a job header carrying a trailing comment is still a job header',
      JSON.stringify(Object.keys(jobs)) === JSON.stringify(['compute', 'post']),
      JSON.stringify(Object.keys(jobs)),
    )
    const r = checkTrustBoundary(JOB_HEADER_WITH_A_TRAILING_COMMENT)
    expect(
      'and the write-scoped job it names keeps its unpinned checkout, and is flagged',
      r.violation === true &&
        r.unsafeWriteCheckouts.length === 1 &&
        r.unsafeWriteCheckouts[0]?.job === 'post' &&
        r.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(r),
    )
  }

  // 17. A COLUMN-0 COMMENT IS NOT THE END OF THE BLOCK IT SITS IN, asserted
  //     on both scanners that made that assumption: `splitJobs` (which would
  //     drop every job below the banner from conditions 3 and 4) and
  //     `extractOnBlock` (which would drop every trigger below it from
  //     conditions 1 and 2). The line numbers are checked too, since the fix
  //     keeps the comment in the job body precisely so the
  //     `headerLine + offset` arithmetic stays exact across it.
  {
    const jobs = splitJobs(COLUMN_ZERO_COMMENT_BETWEEN_JOBS)
    expect(
      'a flush-left banner between two jobs does not end the `jobs:` block',
      JSON.stringify(Object.keys(jobs)) === JSON.stringify(['compute', 'post']),
      JSON.stringify(Object.keys(jobs)),
    )
    const r = checkTrustBoundary(COLUMN_ZERO_COMMENT_BETWEEN_JOBS)
    const cited = COLUMN_ZERO_COMMENT_BETWEEN_JOBS.split('\n')[r.unsafeWriteCheckouts[0]?.line - 1]
    expect(
      'the job below it is still inspected, and the cited line is its checkout step',
      r.violation === true &&
        r.unsafeWriteCheckouts.length === 1 &&
        r.unsafeWriteCheckouts[0]?.job === 'post' &&
        /uses: actions\/checkout@/.test(cited ?? ''),
      `${JSON.stringify(r.unsafeWriteCheckouts)} cited: ${JSON.stringify(cited)}`,
    )

    const on = checkTrustBoundary(COLUMN_ZERO_COMMENT_INSIDE_THE_ON_BLOCK)
    expect(
      'a flush-left banner inside `on:` does not hide a `pull_request_target` declared below it',
      on.dangerous === true && on.violation === true && on.headRefs.length === 1,
      JSON.stringify(on),
    )
    expect(
      'and conditions 1+2 are what caught it — nothing else in that fixture is a violation',
      on.unsafeWriteCheckouts.length === 0 && on.secretsInUntrustedJobs.length === 0,
      JSON.stringify(on),
    )
  }

  // 18. `toJSON(secrets)` IS A SECRET REFERENCE. Condition 4 is framed as
  //     closing the one-line edit; this is the one-line edit in the spelling
  //     that hands over every secret at once, and an accessor-shaped regex
  //     cannot see it. Conditions 1-3 stay green on this fixture, as with
  //     assertion 10's PAT.
  {
    const r = checkTrustBoundary(TOJSON_SECRETS_IN_UNTRUSTED_JOB)
    expect(
      '`${{ toJSON(secrets) }}` in the untrusted job IS flagged by condition 4',
      r.violation === true &&
        r.secretsInUntrustedJobs.length === 1 &&
        r.secretsInUntrustedJobs[0]?.job === 'compute' &&
        /toJSON\(secrets\)/.test(r.secretsInUntrustedJobs[0]?.text ?? ''),
      JSON.stringify(r),
    )
    expect(
      'and by condition 4 alone — trigger, permissions and checkout are untouched',
      r.dangerous === false && r.headRefs.length === 0 && r.unsafeWriteCheckouts.length === 0,
      JSON.stringify(r),
    )
  }

  // 19. THE COMMENT STRIP DOES NOT SWALLOW A QUOTED `#`. This is the one
  //     caller where over-stripping loses a violation rather than inventing
  //     one, so the fixture asserts both directions at once: the secret
  //     behind `'#'` is found, and the secret in a real trailing comment on
  //     the next step is still not — exactly one hit, not zero and not two.
  {
    const r = checkTrustBoundary(SECRET_BEHIND_A_QUOTED_HASH)
    expect(
      'a secret after a quoted `#` on the same line is still found',
      r.violation === true &&
        r.secretsInUntrustedJobs.length === 1 &&
        (r.secretsInUntrustedJobs[0]?.text ?? '').startsWith("echo '#' && curl "),
      JSON.stringify(r.secretsInUntrustedJobs),
    )
    // …and the unit behind it, in both directions, since the fixture above
    // can only show the composite. Left column is the line, right is what
    // `stripComment` must keep of it.
    const stripCases = [
      // A `#` inside a quoted scalar is content, not a comment opener — the
      // two the naive version got wrong, in both quote styles.
      [`run: echo '#' && x \${{ secrets.A }}`, `run: echo '#' && x \${{ secrets.A }}`],
      ['run: echo "a # b" # gone', 'run: echo "a # b" '],
      // A `#` not preceded by whitespace is part of the plain scalar.
      ['ref: abc#not-a-comment', 'ref: abc#not-a-comment'],
      // …and the two it got right, which must stay right.
      [`run: x # \${{ secrets.A }}`, 'run: x '],
      ['  # a whole-line comment', '  '],
    ]
    const wrong = stripCases
      .map(([line, want]) => ({ line, want, got: stripComment(line) }))
      .filter((c) => c.got !== c.want)
    expect(
      '`stripComment` keeps a `#` inside a quoted scalar and cuts a real trailing comment',
      wrong.length === 0,
      JSON.stringify(wrong),
    )
  }

  // 20. #4148's OWN FALSIFICATION: a `run:`-step `gh pr checkout` in a
  //     write-scoped job, with NO `actions/checkout` anywhere and NO `ref:`
  //     line anywhere — every condition prior to this fix stayed green on it.
  {
    const r = checkTrustBoundary(WRITE_SCOPED_JOB_GH_PR_CHECKOUT_IN_RUN_STEP)
    expect(
      '`gh pr checkout` in a `run:` step, in a write-scoped job, IS flagged (condition 3)',
      r.violation === true &&
        r.unsafeWriteCheckouts.length === 1 &&
        r.unsafeWriteCheckouts[0]?.job === 'post' &&
        r.unsafeWriteCheckouts[0]?.ref === null &&
        r.unsafeWriteCheckouts[0]?.runCheckoutLine !== null,
      JSON.stringify(r),
    )
    const rendered = renderVerdict(r)
    expect(
      'the rendered message points at the `run:` step, not a nonexistent `ref:`',
      rendered.exitCode === 1 &&
        rendered.lines.some((l) => l.includes('`post`') && /run:.*checks out PR content/.test(l)),
      JSON.stringify(rendered),
    )

    // The sibling shape: `git fetch … refs/pull/… ` + `git checkout
    // FETCH_HEAD` split across two lines of one `run: |` block scalar.
    const gitFetch = checkTrustBoundary(WRITE_SCOPED_JOB_GIT_FETCH_CHECKOUT_IN_RUN_STEP)
    expect(
      '`git fetch … refs/pull/… ` + `git checkout FETCH_HEAD` in a `run:` step is ALSO flagged',
      gitFetch.violation === true &&
        gitFetch.unsafeWriteCheckouts.length === 1 &&
        gitFetch.unsafeWriteCheckouts[0]?.job === 'post',
      JSON.stringify(gitFetch),
    )

    // Condition 1+2's half: `pull_request_target`, no write-scoped job at
    // all, and the only checkout is a `run:`-step `gh pr checkout` — old
    // `findHeadCheckoutRefs` had no `ref:` line to find.
    const dangerous = checkTrustBoundary(DANGEROUS_TARGET_WITH_RUN_STEP_CHECKOUT)
    expect(
      'a `run:`-step `gh pr checkout` under `pull_request_target`, in a job with NO write scope, is flagged',
      dangerous.violation === true &&
        dangerous.dangerous === true &&
        dangerous.runStepCheckouts.length === 1 &&
        dangerous.runStepCheckouts[0]?.job === 'compute' &&
        dangerous.unsafeWriteCheckouts.length === 0,
      JSON.stringify(dangerous),
    )
    const dangerousRendered = renderVerdict(dangerous)
    expect(
      'the rendered message for the dangerous-trigger fixture names the job and cites #4148',
      dangerousRendered.exitCode === 1 &&
        dangerousRendered.lines.some((l) => l.includes('`compute`') && l.includes('#4148')),
      JSON.stringify(dangerousRendered),
    )

    // Negative control: an ORDINARY base-branch `git fetch`, the exact idiom
    // the real `post` job already uses, must NOT be flagged — proves the
    // fetch pattern is anchored on `refs/pull/`, not on the bare word `fetch`.
    const ordinary = checkTrustBoundary(WRITE_SCOPED_JOB_ORDINARY_BASE_FETCH_IS_FINE)
    expect(
      'an ordinary `git fetch` of the base branch (no refs/pull/) is NOT flagged',
      ordinary.violation === false,
      JSON.stringify(ordinary),
    )

    // A comment merely NAMING `gh pr checkout` is not the shape being used.
    const commented = checkTrustBoundary(RUN_STEP_CHECKOUT_MENTIONED_ONLY_IN_A_COMMENT)
    expect(
      'a comment mentioning `gh pr checkout` (never run) is NOT flagged',
      commented.violation === false,
      JSON.stringify(commented),
    )
  }

  // 21. THE EVASIONS THE #4148 REVIEW FOUND against the first cut of
  //     `RUN_STEP_CHECKOUT_PATTERNS`. Every fixture in this block was GREEN
  //     against the anchored patterns that shipped in the draft, and each
  //     reaches exactly the fork-authored content the guard exists to keep
  //     out of a privileged job — so each is pinned here, with the
  //     over-broadening each fix invites pinned alongside it.
  {
    const globalFlag = checkTrustBoundary(WRITE_SCOPED_JOB_GH_GLOBAL_FLAG_BEFORE_PR_CHECKOUT)
    expect(
      '`gh -R <repo> pr checkout` — a GLOBAL FLAG before the subcommand — is flagged',
      globalFlag.violation === true && globalFlag.unsafeWriteCheckouts.length === 1,
      JSON.stringify(globalFlag),
    )

    const folded = checkTrustBoundary(WRITE_SCOPED_JOB_FOLDED_SCALAR_FETCH)
    expect(
      'a FOLDED `run: >` scalar splitting `git fetch … refs/pull/…` across source lines is flagged',
      folded.violation === true &&
        folded.unsafeWriteCheckouts.length === 1 &&
        folded.unsafeWriteCheckouts[0]?.runCheckoutLine !== null,
      JSON.stringify(folded),
    )

    const worktree = checkTrustBoundary(WRITE_SCOPED_JOB_WORKTREE_FROM_FETCH_HEAD)
    expect(
      '`git worktree add … FETCH_HEAD` (no `checkout` verb, no `refs/pull/` ref) is flagged',
      worktree.violation === true && worktree.unsafeWriteCheckouts.length === 1,
      JSON.stringify(worktree),
    )

    // The verb sweep. One fixture above pins the mechanism; this pins the
    // ALTERNATION — every verb that materialises `FETCH_HEAD` in a tree is
    // in it, and the read-only inspections are NOT. Asserted through
    // `checkTrustBoundary` on a real fixture rather than against the regex
    // directly, so it cannot pass while the wiring is broken.
    const inWorktreeFixture = (cmd) =>
      checkTrustBoundary(
        WRITE_SCOPED_JOB_WORKTREE_FROM_FETCH_HEAD.replace(
          'git worktree add /tmp/pr FETCH_HEAD',
          cmd,
        ),
      ).violation
    const materialising = [
      'git checkout FETCH_HEAD',
      'git switch --detach FETCH_HEAD',
      'git restore --source FETCH_HEAD .',
      'git reset --hard FETCH_HEAD',
      'git merge --no-edit FETCH_HEAD',
      'git rebase FETCH_HEAD',
      'git cherry-pick FETCH_HEAD',
      'git worktree add /tmp/pr FETCH_HEAD',
      'git pull origin FETCH_HEAD',
    ]
    const missed = materialising.filter((cmd) => inWorktreeFixture(cmd) !== true)
    expect(
      'every git verb that MATERIALISES a fetched FETCH_HEAD is flagged, not only `checkout`',
      missed.length === 0,
      `missed: ${JSON.stringify(missed)}`,
    )

    const readOnly = checkTrustBoundary(WRITE_SCOPED_JOB_READ_ONLY_FETCH_HEAD_INSPECTION_IS_FINE)
    expect(
      'a READ-ONLY `git rev-parse FETCH_HEAD` after an ordinary base fetch is NOT flagged',
      readOnly.violation === false,
      JSON.stringify(readOnly),
    )

    // `merge_commit_sha` — conditions 1+2's blind spot, in a job with no
    // write scope so ONLY conditions 1+2 can answer.
    const mergeSha = checkTrustBoundary(DANGEROUS_TARGET_WITH_MERGE_COMMIT_SHA)
    expect(
      '`ref: …merge_commit_sha` under `pull_request_target` is flagged by conditions 1+2',
      mergeSha.violation === true &&
        mergeSha.headRefs.length === 1 &&
        mergeSha.unsafeWriteCheckouts.length === 0,
      JSON.stringify(mergeSha),
    )
    expect(
      'and the rendered `ref:` line is printed once, not doubled',
      renderVerdict(mergeSha).lines.some((l) => /ref: \$\{\{/.test(l) && !/ref: ref:/.test(l)),
      JSON.stringify(renderVerdict(mergeSha)),
    )

    // The laundering case: a BASE-pinned `ref:` — condition 3's one accepted
    // shape — with `repository:` pointing at the fork.
    const laundered = checkTrustBoundary(WRITE_SCOPED_JOB_BASE_PINNED_BUT_FORK_REPOSITORY)
    expect(
      'a base-pinned `ref:` does NOT launder a checkout whose `repository:` is the fork',
      laundered.violation === true &&
        laundered.unsafeWriteCheckouts.length === 1 &&
        laundered.unsafeWriteCheckouts[0]?.forkRepository === true,
      JSON.stringify(laundered),
    )
    expect(
      'and the message says WHY a base-pinned ref did not save it',
      renderVerdict(laundered).lines.some((l) => /repository:.*fork/.test(l)),
      JSON.stringify(renderVerdict(laundered)),
    )

    // NEGATIVE CONTROL for `FORK_REPOSITORY_PATTERNS`: the SAME fixture with
    // `repository:` naming THIS repo is base-pinned and safe, so the new
    // condition must not simply red on the presence of a `repository:` key.
    const ownRepository = checkTrustBoundary(
      WRITE_SCOPED_JOB_BASE_PINNED_BUT_FORK_REPOSITORY.replace(
        'repository: ${{ github.event.pull_request.head.repo.full_name }}',
        'repository: ${{ github.repository }}',
      ),
    )
    expect(
      '`repository: ${{ github.repository }}` (this repo) with a base-pinned ref is NOT flagged',
      ownRepository.violation === false,
      JSON.stringify(ownRepository),
    )
  }

  // 22. #4183 CONDITION 6 IS NOT VACUOUS: a write-scoped job whose only
  //     checkout is hidden behind a LOCAL COMPOSITE ACTION — class 1 from
  //     #4183's own body, invisible to conditions 1-5 by construction (see
  //     the fixture's own comment). THE FALSIFICATION: every condition
  //     BEFORE condition 6 existed would have printed OK on this file.
  {
    const local = checkTrustBoundary(WRITE_SCOPED_JOB_LOCAL_COMPOSITE_ACTION)
    expect(
      'a write-scoped job `uses:`-ing a LOCAL composite action is flagged by condition 6',
      local.violation === true && local.untrustedActionsInWriteScopedJobs.length === 1,
      JSON.stringify(local),
    )
    expect(
      'no OTHER condition sees it — condition 6 alone is what fires',
      local.headRefs.length === 0 &&
        local.runStepCheckouts.length === 0 &&
        local.unsafeWriteCheckouts.length === 0 &&
        local.secretsInUntrustedJobs.length === 0,
      JSON.stringify(local),
    )
    expect(
      'the offending job and the local action path are both named',
      local.untrustedActionsInWriteScopedJobs[0]?.job === 'post' &&
        local.untrustedActionsInWriteScopedJobs[0]?.target ===
          './.github/actions/prepare-pr-content',
      JSON.stringify(local.untrustedActionsInWriteScopedJobs),
    )
    const rendered = renderVerdict(local)
    expect(
      'main()-style output names the local action path',
      rendered.exitCode === 1 &&
        rendered.lines.some((l) => l.includes('./.github/actions/prepare-pr-content')),
      JSON.stringify(rendered),
    )

    // The sibling shape: an unreviewed THIRD-PARTY action.
    const thirdParty = checkTrustBoundary(WRITE_SCOPED_JOB_THIRD_PARTY_ACTION)
    expect(
      'a write-scoped job `uses:`-ing an unreviewed third-party action is flagged',
      thirdParty.violation === true &&
        thirdParty.untrustedActionsInWriteScopedJobs.length === 1 &&
        thirdParty.untrustedActionsInWriteScopedJobs[0]?.target === 'some-org/checkout-ish@v1',
      JSON.stringify(thirdParty),
    )

    // NEGATIVE CONTROL 1: the real allowlist, in the real shape — must NOT
    // be flagged, or condition 6 breaks the split it exists to protect.
    const allowlisted = checkTrustBoundary(WRITE_SCOPED_JOB_ONLY_ALLOWLISTED_ACTIONS)
    expect(
      'a write-scoped job using ONLY the allowlisted actions is NOT flagged',
      allowlisted.violation === false && allowlisted.untrustedActionsInWriteScopedJobs.length === 0,
      JSON.stringify(allowlisted),
    )

    // NEGATIVE CONTROL 2: the IDENTICAL local-action step, in a job with NO
    // write scope. Proves condition 6 is scoped to write-scoped jobs, not
    // every `uses:` in the file.
    const readOnly = checkTrustBoundary(READ_ONLY_JOB_LOCAL_COMPOSITE_ACTION_IS_FINE)
    expect(
      'the SAME local composite action in a job with NO write scope is NOT flagged by condition 6',
      readOnly.violation === false && readOnly.untrustedActionsInWriteScopedJobs.length === 0,
      JSON.stringify(readOnly),
    )
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return 2
  }
  console.log('self-test: all assertions passed')
  return 0
}

// Guarded so an external script can `import { checkTrustBoundary, renderVerdict, ... }`
// from this file (e.g. to run the guard against a one-off fixture and prove
// a new assertion is not vacuous) without this module's own CLI dispatch
// running — and `process.exit`-ing — as a side effect of the import.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exit(process.argv.includes('--self-test') ? runSelfTest() : main())
}
