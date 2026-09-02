// #3962 — which COPY of a tracked file is a guard judging?
//
// A corpus-scanning guard has two different files to choose from for every
// path, and they disagree whenever the working tree is dirty relative to the
// index (during an agent-driven session, most of the time):
//
//   * the STAGED INDEX — what `git commit` is about to write;
//   * the WORKING TREE — what is on disk right now.
//
// Both citation guards enumerated paths with `git ls-files` (the index) and
// then read their bodies with `readFileSync` (the working tree). Mixing the
// two sources is how a pre-commit verdict comes to describe content that is
// not being committed, in both directions:
//
//   * FALSE GREEN — the violation is staged, the author then fixes it on
//     disk without `git add`. The guard reads the fixed copy, exits 0, and
//     the broken content is committed. This is the exact failure the guard
//     exists to prevent, and it fails silently.
//   * FALSE RED — the fix is staged and a later working-tree edit
//     reintroduces the violation. The commit is blocked over a file the
//     author already fixed.
//
// ─── How the source is chosen ─────────────────────────────────────────────
//
// Explicitly, via the flags below, following the convention already
// established by `scripts/test-related-ts.sh` / `test-related-rust.sh`:
// `--cached` (the index) versus an explicit alternative, named at the call
// site rather than sniffed.
//
//   --cached     read the staged index (`git cat-file` on the index blob)
//   --worktree   read the working tree (`readFileSync`)
//   neither      AUTO — see below
//
// AUTO requires the exported index to be THIS tree's. `GIT_INDEX_FILE` merely
// being SET is not the question; whose index it names is. A guard rooted in
// one tree while a commit runs in another has no correct guess available, so
// it makes none and exits 2 (`isAmbiguousSource`). This rule and its Python
// twin in `guard_file_source.py` are one rule, and are kept in step by the
// same fail-closed scenarios in `runSourceScenarios` — before it was ported
// here, a foreign `GIT_INDEX_FILE` made the two helpers answer OPPOSITELY
// for the same situation: Python exit 2, Node "read the staged index" of a
// repository it was not judging.
//
// AUTO exists because the two prek invocations that must behave differently
// share ONE `entry` line in prek.toml: the hooks are registered at
// `stages = ["pre-commit"]`, and `prek run --all-files` (CI, `push.sh`
// Phase A) runs that same stage with that same entry. A flag baked into the
// entry cannot separate them, so exactly one bit has to come from the
// runtime — and the issue is right that picking the WRONG bit is how this
// gets subtly wrong again. Measured, in a throwaway repo, on prek 0.3.8:
//
//   real `git commit`      PRE_COMMIT=1   GIT_INDEX_FILE=.git/index
//   prek run --all-files   PRE_COMMIT=1   (no GIT_INDEX_FILE)
//   prek run               PRE_COMMIT=1   (no GIT_INDEX_FILE)
//
// So `PRE_COMMIT` — the variable one would reach for first — is set in all
// three modes and cannot discriminate. `GIT_INDEX_FILE` is not a correlate
// of "probably a commit": it is git NAMING THE INDEX IT IS ABOUT TO COMMIT,
// exported per githooks(5) to a hook it is running. Reading that index is
// therefore reading the object git just pointed at, not a guess about
// intent. When it is absent there is no commit in flight, nothing is "about
// to be committed", and the tree in front of the caller is the subject —
// which is what a manual run and CI's `--all-files` both want.
//
// Whichever way it resolves, the guard PRINTS the source it used with any
// non-clean verdict, so a surprising red is one line away from explaining
// itself. `--print-source` reports it without scanning.
//
// ─── Which TREE is judged, and the one documented exception ───────────────
//
// THE RULE, stated once, here, because this is the file a guard author of
// either language reaches for when they need to know which copy they are
// reading: A GUARD JUDGES THE TREE THAT CONTAINS IT. Its root is its own
// `scripts/..` (`import.meta.dirname` / `Path(__file__).parent.parent`),
// never a root derived from the process cwd. That is the contract
// `scripts/pr-merge-result-check.sh` is built on — it runs each ratchet guard
// out of the MERGED WORKTREE's own `scripts/` precisely so the copy's
// location states which tree to judge. `check-table-ownership.py`,
// `check-raw-tx.py`, `check-dynamic-sql.py` and `check-command-arity.py` are
// all spelled this way.
//
// THE EXCEPTION, also stated once, here rather than a paragraph apiece in the
// files that take it. FIVE guards root themselves at `git rev-parse
// --show-toplevel` from the process cwd instead — every consumer of this
// helper, and no others:
//
//   scripts/check-md-link-targets.mjs
//   scripts/check-doc-code-paths.mjs
//   scripts/check-architecture-citations.mjs
//   scripts/check-dead-symbol-citations.mjs
//   scripts/check-remove-after-markers.mjs
//
// The self-tests that remain drive themselves through `runSourceScenarios`
// (or their own fixtures built on the same helper), which spawns the guard INSIDE
// a throwaway fixture with `cwd` set to it; a script-anchored root would send
// them scanning the real repository from there and passing for entirely the
// wrong reason. The Python guards solved the same problem by copying the
// guard into the fixture (`scripts/test-py-guard-file-source.sh`,
// `pr-merge-result-check.sh`), which is the better answer and the one to
// adopt if these five ever need it.
//
// They take the exception through ONE function — `repoRootFromCwd` below —
// rather than five private copies of `execSync('git rev-parse
// --show-toplevel')`. That mattered (#4192): every copy asked the question
// under the AMBIENT environment, so a leaked git context could redirect the
// root itself, BEFORE the ownership probe #4061 added was ever consulted.
// The Python guards are immune to that vector for free, being anchored at
// `SCRIPT_DIR.parent` rather than at anything git answers; the Node side
// buys the same immunity by scrubbing the redirect variables for that one
// call. Which is why the exception is now a shared function: a rule with
// five implementations is five rules.
//
// None is in `RATCHET_GUARDS`, so none is ever run against a tree other than
// the caller's. A NEW guard copies the rule, not the exception — and if it
// must take the exception, it says so by adding itself to the list above and
// calling `repoRootFromCwd`, rather than by growing another private
// explanation and another private `show-toplevel`.
//
// THE LIST IS LOAD-BEARING, not decorative: `repoRoot` below is a required
// option precisely so that a consumer which forgets to say which tree it
// judges fails loudly instead of silently resolving AUTO. Two of the guards
// above were missed on the first pass of exactly that change, and their own
// self-tests — not review — are what caught it.
//
// ─── Deletions and absent files ───────────────────────────────────────────
//
// Enumeration was ALREADY index-based (`git ls-files` reads the index), so
// the two cases that look like they need special handling mostly resolve
// themselves — but they resolve DIFFERENTLY, and the difference is the
// reason this helper enumerates with `ls-files -s` rather than plain
// `ls-files`:
//
//   * STAGED DELETION — a `git rm`'d path is gone from the index, so
//     `ls-files` never lists it and no source ever tries to read it. There
//     is nothing to crash on. (Note this is the OPPOSITE of prek's own
//     changed-file set, which also omits deletions but by dropping them
//     from a list the guard would otherwise have had to read. This helper
//     does not depend on prek's file list at all — it depends on the index,
//     which is why `pass_filenames = false` on both hooks is load-bearing.)
//   * STAGED, ABSENT FROM THE WORKING TREE — `git add`ed and then deleted
//     from disk, or added inside a directory the author has since moved.
//     `ls-files` lists it and `readFileSync` throws ENOENT, which the old
//     code swallowed with `continue` — a silent skip of a file that IS
//     being committed, i.e. another false green. Under `--cached` it is
//     read from the index and judged.
//   * UNMERGED (a conflict in progress) — the path has stages 1/2/3 and no
//     stage 0, so `git show :<path>` fails with "path ... is unmerged".
//     Rather than let that surface as an opaque crash that blocks a
//     legitimate commit, such a path falls back to the working tree, which
//     is where the conflict markers the author is resolving actually live.
//     git refuses to commit with unmerged paths anyway, so this verdict is
//     advisory either way.
//   * GITLINK (mode 160000, a submodule) — has no blob to read. Skipped,
//     as the working tree would effectively skip it too (it is a directory).
//   * SYMLINK (mode 120000) — the index blob is the LINK TARGET PATH; the
//     working tree read follows the link and returns the target's content.
//     The index answer is the one that matches "what is being committed",
//     and is what `--cached` returns. No tracked `*.md`/`*.rs`/`*.ts`/
//     `*.tsx` symlink exists today; this is stated so the divergence is a
//     decision rather than a surprise.
//
// Not on that list, because neither has a correct per-path answer: a
// `cat-file --batch` response that does not have the shape git documents,
// and a `<oid> missing` for a blob the index names (a damaged object store).
// Both THROW and the guard exits 2, rather than abandoning the rest of the
// chunk or re-aiming at the working tree — which is how the invariant above
// ("every enumerated path is read from some source, or the guard says so")
// stays true, and true about the source the guard PRINTS. See
// `parseBatchStream`.
//
// ─── Cost ─────────────────────────────────────────────────────────────────
//
// One `git show` per path would be ~2,900 process spawns for the citation
// guards' corpus. Instead the blob SHAs come out of the single `ls-files -s`
// call and the bodies stream through `git cat-file --batch` in chunks, so
// the index path costs a handful of processes rather than thousands.
// Measured on this repo: the scanned corpus is 2,938 files / ~45 MB, and one
// unchunked `cat-file --batch` over all of it takes ~0.6 s — the same order
// as the guard's existing ~0.55 s working-tree run.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, normalize, resolve as resolvePath, sep } from 'node:path'

export const SOURCE_INDEX = 'index'
export const SOURCE_WORKTREE = 'worktree'

/** Human-readable name for a source, for the line guards print on failure. */
export function describeSource(source) {
  return source === SOURCE_INDEX ? 'staged index' : 'working tree'
}

// Raised from Node's 1 MB default: `git ls-files -s -z` emits ~500 KB over
// 4,606 tracked paths today. An ENOBUFS overflow does not match
// /not a git repository/i, so it would be re-thrown and surface as an
// exit-2 invocation error that fails every commit, rather than silently
// disabling the guard — loud, but still a self-inflicted outage. 64 MB is
// ~130x the current output.
export const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024

// `cat-file --batch` is chunked so peak memory is bounded by the chunk, not
// by the corpus: 500 paths at this repo's ~15 KB mean is ~7.5 MB per call,
// and the 64 MB ceiling tolerates a chunk of unusually large files. Measured
// on this repo's 2,938-file corpus the largest chunk is 14 MB, ~4.5x under
// the ceiling.
//
// Exported and overridable per call ONLY so a self-test can drive the
// chunk-boundary path without building a 500-file fixture: the multi-record
// framing below is the one place in this file where a one-character slip
// (`off += size` instead of `size + 1`) silently under-reports every file
// after the first, and a fixture that holds a single file cannot see it.
export const CAT_FILE_CHUNK = 500
const CAT_FILE_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Does `indexFile` name an index of the repository at `repoRoot`?
 *
 * The Node twin of `guard_file_source.py`'s `_index_belongs_to`, and
 * deliberately the same shape:
 *
 *   * a RELATIVE `GIT_INDEX_FILE` (`.git/index` — what an ordinary `git
 *     commit` exports) is resolved against the process cwd, because that is
 *     how git itself resolves it;
 *   * the question is asked of `--absolute-git-dir` and NOTHING ELSE — see
 *     below;
 *   * a `repoRoot` that is not a git repository at all answers false — a
 *     commit in flight somewhere, over a tree that is not a repository, is
 *     precisely the case with no right answer.
 *
 * ─── One git dir, not two — correcting the #4048 probe ─────────────────────
 *
 * This used to accept a path under EITHER `--absolute-git-dir` or
 * `--git-common-dir`, on the stated grounds that "in a linked worktree the
 * index lives under `…/.git/worktrees/<name>/index` while the object store is
 * shared, so both spellings are this repository". The premise is true and the
 * conclusion does not follow: in a linked worktree `--absolute-git-dir` IS
 * `…/.git/worktrees/<name>`, which already contains that index — and every
 * index of a repository lives in its `$GIT_DIR`, including the
 * `index.lock`/`next-index-<pid>.lock` temp indexes git exports for
 * `git commit -a` and `git commit -- <path>`. So the common-dir arm never
 * accepted anything the git-dir arm would have refused for a good reason.
 *
 * What it DID accept is every OTHER worktree's index, because
 * `…/.git` is the common dir of the main checkout and of all its linked
 * worktrees alike. Measured on git 2.43, in a scratch repo with two linked
 * worktrees, before this change: a commit in flight in worktree B was
 * accepted as belonging to worktree A. That is the mis-attributed verdict
 * this module exists to prevent, in the direction that fails SILENTLY — the
 * guard reads a sibling tree's index, finds nothing staged there, and exits 0
 * over the violation actually being committed.
 *
 * ─── …and containment alone is not enough either ──────────────────────────
 *
 * A linked worktree's git dir is NESTED INSIDE the main one
 * (`<main>/.git/worktrees/<name>`), so "under `--absolute-git-dir`" still
 * accepts a worktree's index as the MAIN checkout's — the same false accept
 * one level up, and the live shape in this repo, where an agent runs a guard
 * in the main checkout while a commit is in flight in a worktree. The
 * reserved segments below are git's own layout contract:
 * `$GIT_DIR/worktrees/<name>` is a linked worktree's git dir and
 * `$GIT_DIR/modules/<name>` a submodule's, so an index under either belongs
 * to THAT repository and never to this root. (For a linked worktree root the
 * git dir already IS `…/worktrees/<name>`, and git does not nest further, so
 * the same one rule reads correctly from both sides. The worktree arm is
 * pinned by scenario 10; the submodule arm is the identical layout rule, not
 * a second mechanism.)
 *
 * ─── An inherited GIT_DIR outranks -C too (#4061) ──────────────────────────
 *
 * `-C repoRoot` tells THIS `git` command where to look — but an ambient
 * `GIT_DIR` outranks it (measured on git 2.43: `GIT_DIR=<other>/.git git -C
 * <root> rev-parse --absolute-git-dir` answers about `<other>`, not `root`).
 * So with both `GIT_DIR` and `GIT_INDEX_FILE` exported from ANOTHER
 * repository — exactly what a real commit hook leaves in the environment of
 * that repository — the leaked `GIT_DIR` made this probe answer about that
 * other repository, and `indexFile` (also naming a path under that same
 * leaked git dir) then compared EQUAL to it: a false ACCEPT of a foreign
 * index as belonging to `repoRoot`, silently defeating the exit-2 refusal
 * `isAmbiguousSource` exists to raise.
 *
 * The probe below therefore runs under its OWN scrubbed copy of the
 * environment, not the ambient one `execFileSync` would otherwise inherit —
 * asking "what repository is at this path" is a question no ambient git
 * context should get to answer on `repoRoot`'s behalf. `gitEnv` still binds
 * the rest of the environment its OWN `git` calls run under, and
 * `GIT_INDEX_FILE` is still the one variable it decides by BELONGING — kept
 * when this probe (now honest about `repoRoot`) says it is this tree's,
 * dropped when it says otherwise. What is no longer true of that function is
 * "and strips nothing else": since #4191 it removes the whole of
 * `GIT_REDIRECT_VARS` unconditionally, because those re-aim its
 * `ls-files`/`cat-file` exactly as they re-aimed this probe. Measured before
 * this fix, in a two-repository scratch fixture with `GIT_DIR` and
 * `GIT_INDEX_FILE` both exported from the second: AUTO accepted the foreign
 * index as belonging to the first, and the guard exited 0 over a staged
 * violation it never read. Pinned in scenario 9 of `runSourceScenarios` and
 * section 5 of `scripts/test-py-guard-file-source.sh`.
 */
const NESTED_GIT_DIRS = new Set(['worktrees', 'modules'])

// ─── The variables that RE-AIM git, and the one that INFORMS it (#4191) ────
//
// Every name below merely points git at a directory it would otherwise
// DISCOVER for itself. That is what makes removing them safe, and it is the
// whole distinction this module draws between a leaked git context and a
// legitimate one: with `cwd` at the tree being judged, ordinary discovery
// finds that tree's own git dir and answers identically, so scrubbing is a
// no-op when the ambient context is honest and corrective when it is not.
// There is no need to sniff which case we are in — measured on git 2.43:
//
//   * an ordinary `git commit` in a main checkout exports NO `GIT_DIR` at
//     all (only `GIT_INDEX_FILE=.git/index`, relative, with the hook's cwd
//     fixed at the work-tree toplevel — git chdirs the hook to the toplevel
//     even for a commit issued from a SUBDIRECTORY, so the relative form
//     always resolves against the tree being committed);
//   * a `git commit` in a LINKED WORKTREE exports an absolute
//     `GIT_DIR=<main>/.git/worktrees/<name>` — which is exactly what
//     `git -C <that worktree> rev-parse --absolute-git-dir` answers with
//     the variable removed;
//   * so does a checkout whose `.git` is a GITFILE rather than a directory
//     (`git init --separate-git-dir`, and every submodule): an absolute
//     `GIT_DIR` in a MAIN checkout, and equally redundant, because
//     discovery reads the same target out of the gitfile. "A main checkout
//     exports none" is true of the ordinary shape and not of every one, so
//     the argument rests on redundancy rather than on absence;
//   * a relative `GIT_DIR=.git` (the shape older git and some hook runners
//     export) resolves against the git process's cwd, and this module's own
//     `git` calls all run with `cwd` at `repoRoot`, so it resolves to the
//     same directory discovery finds.
//
// The invariant has one honest counterexample, not a shape any of the four
// above, and not one this repo uses: a DETACHED WORK TREE (`git
// --git-dir=X --work-tree=Y <command>`, the bare-dotfiles-repo shape), where
// `Y` carries no `.git` of its own. There `GIT_WORK_TREE` is not redundant
// with discovery — discovery has nothing under `Y` to find. Verified (git
// 2.43): with `GIT_DIR`/`GIT_WORK_TREE` scrubbed and `cwd` at such a `Y`,
// `git rev-parse --show-toplevel` answers "not a git repository" when `Y`
// sits nowhere near another repo — `repoRootFromCwd` swallows that into
// `cwd` itself (its documented fail-open) and `listTrackedEntries` returns
// `null`, the same silent "nothing to report" this module gives an
// extracted tarball. Worse when `Y` is nested inside an unrelated repo:
// discovery does not fail, it finds the ANCESTOR — `--show-toplevel`
// answers with the wrong repository's root, and a guard judges that tree
// instead, quietly, with no error to notice. Not a shape this repo's guards
// ever run in, and the four measured shapes above really are redundant, so
// this does not change what the scrub list removes — but the invariant
// above is stated unconditionally, and this is the case where it is false.
//
// `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are ONE
// mechanism in two variables — git's `receive-pack` quarantine exports the
// pair together — and re-aim the OBJECT STORE the same way the others re-aim
// the git dir: the alternates git would otherwise use are discovered from
// `<gitdir>/objects/info/alternates`. Scrubbing one and keeping the other
// would leave a half-configured store, and the half left behind is not
// harmless. Measured on git 2.43: `git cat-file` does NOT verify that an
// object's body hashes to the name it was asked for, and an alternate is
// consulted for any oid the primary store lacks — so a leaked
// `GIT_ALTERNATE_OBJECT_DIRECTORIES` can serve an ATTACKER-CHOSEN body for
// an oid `git ls-files -s` names, through `cat-file blob` and `cat-file
// --batch` alike. Reproduced against `check-raw-tx.py --cached` over a
// staged violation whose loose object had been removed: exit 2 (the
// fail-closed "damaged object store" refusal) became exit 0, over a forged
// clean body. Pinned in section 5c of `scripts/test-py-guard-file-source.sh`
// and in `verifyLeakedGitContext` (./git-scratch-guard.mjs).
//
// Scrubbing the pair is not costless in every direction, only every
// direction that matters HERE: a guard run as a server-side `pre-receive` /
// `update` hook has its incoming objects held in exactly this quarantine, so
// scrubbing it there makes those objects invisible too. That failure is
// FAIL-CLOSED (`cat-file` misses, this module's own `GitError`, exit 2 with
// the cause named) rather than the fail-open a leaked alternate risks in a
// pre-commit guard, so it is safe — this module has no server-side hook
// consumer today, but the asymmetry is worth being honest about: the pair is
// not only ever a hostile leak, just one whose one legitimate use this list
// does not attempt to accommodate.
//
// ─── …and what is deliberately NOT here, each measured rather than argued
//
// The test for membership is "can it change what a guard READS about the
// tree in front of it", not "is it a `GIT_` variable", so the near misses
// are recorded rather than swept in:
//
//   * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_COUNT` /
//     `GIT_CONFIG_PARAMETERS` — config injection cannot re-aim these calls:
//     git IGNORES `core.worktree` and `core.bare` from anywhere other than
//     the repository's own config, and all three spellings were measured to
//     leave `rev-parse --show-toplevel` and `ls-files` answering about the
//     tree at `cwd`. `cat-file blob` applies no filters, and `ls-files -z`
//     is not affected by `core.quotePath`. Scrubbing them would also be a
//     REGRESSION, not a no-op: a fixture that deliberately isolates itself
//     with `GIT_CONFIG_GLOBAL` would find the guard reading the developer's
//     real `~/.gitconfig` instead.
//   * `GIT_PREFIX` — exported to every hook (measured, `sub/` for a commit
//     issued from `sub/`), and consumed by nothing here: `ls-files`,
//     `cat-file` and `rev-parse --show-toplevel` all answered identically
//     with it set to a bogus value.
//   * `GIT_CEILING_DIRECTORIES` / `GIT_DISCOVERY_ACROSS_FILESYSTEM` — these
//     bound the UPWARD walk rather than aiming it, so the worst either can
//     do is truncate or extend the ANCESTRY of `cwd`; neither can name an
//     unrelated repository. Measured: a ceiling covering the parent (or the
//     root itself) leaves `--show-toplevel` and `ls-files` unchanged when
//     `cwd` IS the toplevel, which is the only shape a guard runs in. They
//     are also the one class where removal is NOT provably a no-op —
//     `git_scratch_guard` (./git-scratch-guard.sh) SETS a ceiling on
//     purpose — so they stay, and the invariant above stays true of every
//     name that is here.
//
// `GIT_INDEX_FILE` is deliberately ABSENT from the list, in both of its
// roles. For `indexBelongsTo` it is the value under TEST rather than ambient
// context to strip (and `rev-parse --absolute-git-dir` never consults it).
// For `gitEnv` it is the one variable here that is NOT redundant with
// discovery: a commit in flight names a temp index — `.git/index.lock` for
// `git commit -a`, `.git/next-index-<pid>.lock` for `git commit -- <path>`
// (both measured) — that appears nowhere in git's layout and cannot be
// re-derived. It is therefore KEPT when it belongs to the tree being judged
// and dropped when it does not, which is `gitEnv`'s ownership rule below.
//
// The Node twin of `_GIT_REDIRECT_VARS` in `guard_file_source.py`; the two
// lists are identical, which is the point — a divergence between them is the
// same class of bug as #4062. Exported (unlike the Python name's leading
// underscore) so `scripts/test-py-guard-file-source.sh` can import this
// exact list and diff it against the Python one at test time, rather than
// trusting the "identical" claim in these two comments to stay true.
export const GIT_REDIRECT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]

/**
 * A copy of `env` with the path-redirect variables above removed.
 *
 * The one spelling of "ask git about the directory in front of you, not
 * about wherever an inherited environment points" — used by the ownership
 * probe (#4061), by `gitEnv` for the guard's own enumeration and blob reads
 * (#4191), and by `repoRootFromCwd` for the `--show-toplevel` call the five
 * cwd-anchored guards root themselves on (#4192). Those were three separate
 * exposures of one question, and they had three different answers before
 * this existed.
 *
 * `GIT_INDEX_FILE` survives this call untouched — see the list's own note.
 */
export function scrubGitRedirects(env = process.env) {
  const out = { ...env }
  for (const name of GIT_REDIRECT_VARS) delete out[name]
  return out
}

/**
 * The repository root containing `cwd`, for a guard that takes the
 * documented cwd-anchored EXCEPTION to "a guard judges the tree that
 * contains it" (see the header).
 *
 * `git rev-parse --show-toplevel` is asked under a SCRUBBED environment
 * (#4192). Unscrubbed, a leaked git context redirects the answer before any
 * later ownership check can be consulted, so the guard roots itself in
 * another repository and every subsequent decision — which files to
 * enumerate, which copies to read, which verdict to print — is about that
 * repository. Measured on git 2.43, from a cwd inside repo A:
 *
 *   GIT_DIR=<B>/.git GIT_WORK_TREE=<B> git rev-parse --show-toplevel  -> B
 *   GIT_DIR=<B>/.git git rev-parse --show-toplevel, B having
 *     core.worktree set                                               -> B
 *
 * (A bare `GIT_DIR=<B>/.git` alone answers A — the work tree defaults to
 * cwd — which is why this was invisible until someone looked for it, and
 * why "it resolved correctly the one time I tried" is not evidence.)
 *
 * Falls back to `cwd` when git cannot answer at all — an extracted tarball,
 * git missing from PATH — which is the fail-open every one of these guards
 * has always had for "not a git repository".
 */
export function repoRootFromCwd(cwd = process.cwd(), env = process.env) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: scrubGitRedirects(env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || cwd
  } catch {
    return cwd
  }
}

export function indexBelongsTo(indexFile, repoRoot, env = process.env) {
  const indexPath = normalize(resolvePath(indexFile))
  // `env`, not the module reaching for `process.env` on its own: `gitEnv`
  // scrubs the `env` object it was PASSED, and this probe is the other half
  // of the same belonging rule (#4061) — the module should not disagree with
  // itself about which environment is authoritative. Both call sites below
  // already receive `process.env` in production, so this changes nothing
  // observable there; it only stops a future caller that passes a
  // DIFFERENT `env` (a self-test driving a fixture, say) from having this
  // probe silently answer about the ambient one instead.
  const probeEnv = scrubGitRedirects(env)
  let out
  try {
    out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: probeEnv,
    }).trim()
  } catch {
    return false
  }
  if (!out) return false
  // ARGUMENT ORDER IS LOAD-BEARING: `path.resolve` walks its arguments RIGHT
  // TO LEFT and stops at the first absolute one, so `resolve(out, repoRoot)`
  // — which is what this line said from #4048 until this change — discards
  // `out` entirely and
  // yields `repoRoot`. In an ordinary checkout the index sits inside the work
  // tree (`<root>/.git/index`), so the comparison below still answered TRUE
  // and the slip was invisible; in a linked worktree the index lives under
  // the MAIN repository's `.git`, outside the root, and every citation guard
  // exited 2 on every commit. The base comes first.
  const gitDir = normalize(resolvePath(repoRoot, out))
  if (indexPath === gitDir) return true
  if (!indexPath.startsWith(`${gitDir}${sep}`)) return false
  return !NESTED_GIT_DIRS.has(indexPath.slice(gitDir.length + 1).split(sep)[0])
}

/**
 * The environment a guard's own `git` calls should run under — the Node twin
 * of `guard_file_source.py`'s `git_env`, and the other half of the ownership
 * rule.
 *
 * `cwd` does NOT decide which index git reads: an ambient `GIT_INDEX_FILE`
 * outranks it. So a guard reading the staged index of `repoRoot` while some
 * OTHER repository's index is exported would enumerate that other repository,
 * with `cwd=repoRoot` making it look otherwise. Without this, porting the
 * AUTO rule alone would only move the divergence — AUTO would refuse a
 * foreign index while an EXPLICIT `--cached` still read it.
 *
 * ─── …and an ambient GIT_DIR outranks `cwd` in exactly the same way (#4191)
 *
 * This function used to leave the rest of the environment exactly as given,
 * on the stated grounds that "a foreign `GIT_DIR`/`GIT_WORK_TREE` in `env`
 * is out of scope for this function". It was not: `GIT_DIR` re-aims the very
 * `git ls-files` this env is built for. Measured on git 2.43, from a cwd
 * inside repo A: `GIT_DIR=<B>/.git git -C <A> ls-files` lists B's tracked
 * paths, not A's — `-C` and `cwd` both lose to it. So a leaked `GIT_DIR`
 * made `listTrackedEntries` enumerate the OTHER repository's index while
 * `cwd=repoRoot` made it look otherwise, and the guard reported a verdict
 * about a tree it never opened. Worse than the `GIT_INDEX_FILE` half it sat
 * next to: `GIT_DIR` alone was enough (`ls-files` falls back to that git
 * dir's own default index once a foreign `GIT_INDEX_FILE` is stripped), so
 * it corrupted `--worktree` and `--cached` alike, for every source mode
 * rather than only under AUTO. Reproduced against
 * `check-dead-symbol-citations.mjs` in a two-repository fixture: exit 0,
 * empty stderr, over a violation sitting in both the index and the working
 * tree of the tree under judgement.
 *
 * The redirect variables are therefore scrubbed here too, unconditionally —
 * see `GIT_REDIRECT_VARS` for why that does not need to distinguish a
 * hostile leak from an honest one, and why `GIT_INDEX_FILE` is the one
 * variable that DOES get a belonging test rather than a blanket removal.
 * Belonging still decides which index is read; nothing about a real commit
 * hook's environment changes, because the hook's `GIT_DIR` — when it exports
 * one at all — names the same directory `cwd=repoRoot` already discovers.
 *
 * That leaves `indexBelongsTo`'s OWN probe (#4061) as the second half of the
 * same rule rather than the whole of it: before that fix, "belonging
 * decides" was true in name only — a `GIT_DIR` exported alongside a foreign
 * `GIT_INDEX_FILE` could make the probe answer about that foreign repository
 * and accept its index as `repoRoot`'s.
 */
export function gitEnv(repoRoot, env = process.env) {
  const out = scrubGitRedirects(env)
  if (out.GIT_INDEX_FILE && !indexBelongsTo(out.GIT_INDEX_FILE, repoRoot, env)) {
    // The pragma below is check-git-fixture-isolation.mjs's per-statement
    // waiver (#4064), replacing the basename exemption this file used to
    // need. It waives rule 1 for THIS LINE only; rule 2 still judges the
    // file, so a fixture built here would still be reported.
    delete out.GIT_INDEX_FILE // not-a-fixture-scrub: drops a FOREIGN index (#4017), builds no fixture
  }
  return out
}

/**
 * Resolve which copy of each file the caller wants read.
 *
 * @param {string[]} argv         full `process.argv` (the node binary and the
 *   script path are skipped; both guards run with `pass_filenames = false`,
 *   so anything after them is a flag the caller typed).
 * @param {object} env
 * @param {object} [opts]
 * @param {string[]} [opts.extraFlags] flags the CALLING guard understands, on
 *   top of the two source flags this module owns.
 * @param {string} opts.repoRoot  the tree being judged. REQUIRED: AUTO cannot
 *   ask whether the exported index is this tree's without it, and defaulting
 *   it would restore the very rule this parameter exists to replace — a
 *   silent one, taken because a call site forgot.
 * @returns {{source: string, why: string}} `why` is quoted verbatim in the
 *   guard's failure output — the mechanism has to be legible from the
 *   verdict, not only from this file.
 * @throws {Error & {isUsageError: true}} if both source flags are given, if
 *   any argument is one this guard does not understand, or if `repoRoot` is
 *   missing.
 * @throws {Error & {isAmbiguousSource: true}} if a commit is in flight in a
 *   DIFFERENT repository than `repoRoot`. See the header: reading that index
 *   would enumerate the committing repository and report the result as a
 *   verdict about this tree, which is the mis-attributed verdict this whole
 *   module is about. Both guards already turn a throw here into an exit-2
 *   invocation error, which is fail-CLOSED — the caller is told to say which
 *   copy it means rather than handed a guess.
 */
export function resolveSource(
  argv = process.argv,
  env = process.env,
  { extraFlags = [], repoRoot } = {},
) {
  // UNKNOWN ARGUMENTS ARE AN ERROR. Ignoring them makes `--cache` — one
  // keystroke short of `--cached` — resolve to AUTO, so the caller who asked
  // for the index silently gets whichever copy AUTO picked. That is the exact
  // failure this module exists to end, arriving through the option parser
  // instead of through the reader: the verdict is clean, the source it
  // actually judged is not the one the caller named, and nothing says so.
  // Rejecting is cheap because neither guard takes a positional argument —
  // both hooks are `pass_filenames = false` (prek.toml), which is what makes
  // "every argument must be a flag I recognise" a safe rule rather than a
  // brittle one.
  const known = new Set(['--cached', '--worktree', ...extraFlags])
  const unknown = argv.slice(2).filter((arg) => !known.has(arg))
  if (unknown.length > 0) {
    const err = new Error(
      `unknown option ${unknown.map((a) => `'${a}'`).join(', ')} — known options: ` +
        `${[...known].join(', ')}`,
    )
    err.isUsageError = true
    throw err
  }
  const cached = argv.includes('--cached')
  const worktree = argv.includes('--worktree')
  if (cached && worktree) {
    const err = new Error('--cached and --worktree are mutually exclusive')
    err.isUsageError = true
    throw err
  }
  if (cached) return { source: SOURCE_INDEX, why: 'explicit --cached' }
  if (worktree) return { source: SOURCE_WORKTREE, why: 'explicit --worktree' }
  const indexFile = env.GIT_INDEX_FILE
  if (!indexFile) {
    return {
      source: SOURCE_WORKTREE,
      why: 'auto: no commit in flight (GIT_INDEX_FILE unset)',
    }
  }
  // Only AUTO needs it, and only with a commit in flight — but a call site
  // that forgot it must not be answered with a guess.
  if (!repoRoot) {
    const err = new Error(
      'resolveSource: AUTO needs `repoRoot` to decide whether the exported GIT_INDEX_FILE ' +
        `(${indexFile}) belongs to the tree being judged — pass it, or say --worktree/--cached`,
    )
    err.isUsageError = true
    throw err
  }
  // SET is not enough — it has to be OUR index. See the header.
  if (indexBelongsTo(indexFile, repoRoot, env)) {
    return {
      source: SOURCE_INDEX,
      why: `auto: git is running a commit hook, GIT_INDEX_FILE=${indexFile}`,
    }
  }
  const err = new Error(
    `a commit is in flight (GIT_INDEX_FILE=${indexFile}) but it belongs to a different ` +
      `repository than the tree being judged (${repoRoot}).\n` +
      '  Reading that index would enumerate the committing repository and report the result ' +
      'as a verdict about this tree.\n' +
      '  Say which copy you mean: --worktree (judge the files on disk) or --cached (judge the ' +
      'staged index).',
  )
  err.isAmbiguousSource = true
  throw err
}

/**
 * Enumerate the index. Returns `{paths, byPath}` where `paths` preserves
 * `git ls-files` order and `byPath` maps each path to `{mode, sha,
 * unmerged}` (`sha` is null for an unmerged path, which has no stage 0).
 *
 * Returns `null` for the deliberate fail-open case — "not a git repository",
 * e.g. running from an extracted tarball. Every OTHER failure (git missing,
 * permission denied, ENOBUFS, ...) is a genuine invocation error and is
 * re-thrown, so a caller can exit 2 with the cause named rather than
 * swallowing it into a silent "clean".
 *
 * `env` IS NOT OPTIONAL IN PRACTICE, and every guard passes `gitEnv(...)`.
 * `cwd` does NOT determine which repository git reads: an ambient
 * `GIT_INDEX_FILE` (what git exports to a pre-commit hook) outranks it for
 * the index, and an ambient `GIT_DIR` outranks it for the repository
 * ITSELF — measured, `GIT_DIR=<B>/.git git -C <A> ls-files` lists B. So
 * `listTrackedEntries(dir)` with no `env` enumerates whatever the ambient
 * context points at while looking like it enumerates `dir`, and it is
 * invisible to `git rev-parse --show-toplevel`, which stays pinned to `dir`.
 * That is the #3722 hazard for a self-test and the #4191 one for a guard;
 * `gitEnv` (here) and `scrubbedGitEnv` (./git-scratch-guard.mjs) are the two
 * envs that close it. Omitted, git's ambient context applies — which no
 * caller should want.
 */
export function listTrackedEntries(repoRoot, { env } = {}) {
  let raw
  try {
    raw = execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
    })
  } catch (err) {
    const stderr = String(err?.stderr ?? '')
    if (/not a git repository/i.test(stderr)) return null
    throw err
  }
  const paths = []
  const byPath = new Map()
  // `-z` rather than plain `ls-files -s`: NUL-separated records mean a path
  // containing a quote, a backslash or a newline arrives intact instead of
  // C-quoted, and a path that cannot be parsed is a path that cannot be
  // scanned.
  for (const record of raw.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, sha, stage] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    let entry = byPath.get(path)
    if (!entry) {
      entry = { mode: null, sha: null, unmerged: false }
      byPath.set(path, entry)
      paths.push(path)
    }
    if (stage === '0') {
      entry.mode = mode
      entry.sha = sha
    } else {
      entry.unmerged = true
    }
  }
  return { paths, byPath }
}

/**
 * Read the bodies of `paths` from the chosen source.
 *
 * @returns {Map<string, string>} path -> contents. A path absent from the
 *   map could not be read from either source and is simply not scanned —
 *   the same tolerance the working-tree reader has always had, except that
 *   under `--cached` an on-disk absence no longer causes it.
 *
 *   PRESENT-WITH-EMPTY-CONTENT IS NOT ABSENT. A zero-byte tracked file
 *   (`<oid> blob 0`) maps to `''`, and callers must test `=== undefined`
 *   rather than truthiness: `if (!body) continue` would silently drop an
 *   empty file out of the scan, which is the "unscanned file" failure this
 *   whole module exists to prevent. An empty file trivially holds no
 *   violation, so the miss is invisible until the day it is not empty.
 *
 * `env` is threaded to `git` for the same reason as in `listTrackedEntries`
 * above — see that note.
 */
export function readContents(
  paths,
  { repoRoot, source, entries, chunkSize = CAT_FILE_CHUNK, env },
) {
  return source === SOURCE_INDEX
    ? readFromIndex(paths, repoRoot, entries, chunkSize, env)
    : readFromWorktree(paths, repoRoot)
}

function readFromWorktree(paths, repoRoot) {
  const bodies = new Map()
  for (const path of paths) {
    try {
      // Unconditional `set`, so a zero-byte file lands as `''` rather than
      // being filtered out by a truthiness test — see `readContents`.
      bodies.set(path, readFileSync(join(repoRoot, path), 'utf8'))
    } catch {
      // Unreadable on disk (staged-but-deleted, permissions, a directory).
      // Skipped, as before.
    }
  }
  return bodies
}

function readFromIndex(paths, repoRoot, entries, chunkSize = CAT_FILE_CHUNK, env) {
  const bodies = new Map()
  const wanted = []
  const fallToWorktree = []
  for (const path of paths) {
    const entry = entries?.byPath?.get(path)
    if (!entry) {
      // Not in the index at all — never staged, or staged for DELETION
      // (`git rm --cached`, which leaves the file on disk). It is not being
      // committed, so under `--cached` it is not read: reading the disk copy
      // would be this source answering about a path it has just been told is
      // absent. Unreachable from the five guards, which enumerate FROM
      // `listTrackedEntries`; stated so the rule is one rule. The Python
      // sibling reaches it (its callers pass prek's path arguments) and
      // answers the same way — `read` in scripts/lib/guard_file_source.py,
      // #4058.
      continue
    }
    if (entry.sha === null) {
      // UNMERGED (stages 1/2/3, no stage 0) — a conflict in progress. The
      // conflicted copy on disk is where the markers the author is resolving
      // live, so it is judged from there rather than crashing the guard. The
      // ONE case whose right answer is the working tree; see the header.
      fallToWorktree.push(path)
      continue
    }
    if (entry.mode === '160000') continue // submodule: no blob to read
    wanted.push({ path, sha: entry.sha })
  }
  for (let i = 0; i < wanted.length; i += chunkSize) {
    const chunk = wanted.slice(i, i + chunkSize)
    // No `encoding`, so this is a Buffer: `cat-file --batch` sizes are in
    // BYTES, and slicing a decoded string would desynchronise the stream on
    // the first multi-byte character.
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      env,
      input: `${chunk.map((e) => e.sha).join('\n')}\n`,
      maxBuffer: CAT_FILE_MAX_BUFFER,
    })
    for (const [path, body] of parseBatchStream(out, chunk)) bodies.set(path, body)
  }
  for (const [path, body] of readFromWorktree(fallToWorktree, repoRoot)) {
    bodies.set(path, body)
  }
  return bodies
}

/**
 * Walk ONE `git cat-file --batch` response against the chunk that produced
 * it, in input order.
 *
 * @param {Buffer} out    the batch response (a Buffer, never a string — see
 *   the call site)
 * @param {Array<{path: string, sha: string}>} chunk the input lines, in order
 * @returns {Map<string, string>} path -> staged contents. There is NO second
 *   channel: every path in the chunk is either read from the index here or
 *   the call throws. See "Why a `missing` object throws too" below.
 * @throws {Error & {isBatchDesync: true}} if the response does not have the
 *   shape `cat-file --batch` documents — see below.
 * @throws {Error & {isMissingObject: true}} if git answers `<oid> missing`
 *   for a blob the index names.
 *
 * Extracted from `readFromIndex` so the desync branches have somewhere to be
 * TESTED from: they cannot be reached through a fixture, because reaching
 * them means git emitting a malformed stream. `runSourceScenarios` feeds this
 * function hand-built buffers instead.
 *
 * ─── Why a malformed stream THROWS rather than falling back ───────────────
 *
 * Both branches below used to `break`, abandoning the remainder of the chunk
 * — up to `CAT_FILE_CHUNK` (500) paths — with those paths absent from
 * `bodies` and no working-tree fallback behind them. That is the silently
 * unscanned file this whole module exists to prevent, arriving through the
 * parser rather than through the source choice, and it is the loudest
 * possible version of it: a guard that exits 0 having read almost nothing.
 * Measured before the fix, on an 8-file fixture with the violation in the
 * last staged file, a truncated stream produced `exit=0` with empty stderr.
 *
 * The alternative — pushing the remainder onto the working-tree fallback, as
 * an unmerged path does — is rejected deliberately:
 *
 *   * An unmerged path is a DOCUMENTED per-file answer from git ("this path
 *     has no stage 0"), and the fallback is a considered verdict on a
 *     specific file: the conflicted copy on disk is what the author is
 *     resolving. A desync is git not honouring the batch protocol at all, so
 *     nothing about the remaining bytes is known — including whether the
 *     paths still line up with the records.
 *   * The guards PRINT the source with the verdict ("judged the staged
 *     index"). Silently reading 499 files from the working tree under that
 *     banner is the mis-attributed verdict #3962 is about, at scale.
 *   * Exit 2 is fail-CLOSED: the commit is blocked and the cause is named.
 *     A fallback is fail-open in the one direction that has burned this repo
 *     — a green that describes content nobody scanned.
 *
 * ─── Why a `missing` object throws too (#4046) ────────────────────────────
 *
 * `<oid> missing` used to join the unmerged paths in the working-tree
 * fallback, on the grounds that it is also a documented per-file answer and
 * that a damaged repository must not mean an unscanned file. Both halves are
 * true and the conclusion still did not follow, because it is the WRONG FILE
 * that gets read: the sha came out of `git ls-files -s` moments earlier, so
 * the index names content that IS being committed and git cannot produce it.
 * The copy on disk is not a degraded version of that content, it is
 * different content — and it would be reported under `(judged the staged
 * index)`, which is the third bullet above with a smaller N.
 *
 * The unmerged path is the one case where the disk copy IS the right answer,
 * and it never reaches here: it has no stage-0 sha, so `readFromIndex` routes
 * it to the working tree without asking `cat-file` at all. Everything that
 * arrives at this branch is a damaged or unreadable object store, which has
 * no correct per-file answer — so it fails closed, and the commit is blocked
 * with the sha named rather than judged against a file nobody staged.
 *
 * `scripts/lib/guard_file_source.py` reaches the same verdict from the same
 * reasoning in `_blob`, one blob per call instead of a batch. Its first draft
 * conflated EVERY `cat-file` failure into this same silent fallback, which is
 * what #4046 was filed about; the two helpers now differ only in framing.
 */
export function parseBatchStream(out, chunk) {
  const bodies = new Map()
  const desync = (detail, i) => {
    const err = new Error(
      `git cat-file --batch desynchronised: ${detail}. ${chunk.length - i} of ${chunk.length} ` +
        'staged path(s) in this batch would have gone unread, so the scan is abandoned rather ' +
        'than reported clean (scripts/lib/guard-file-source.mjs).',
    )
    err.isBatchDesync = true
    return err
  }
  let off = 0
  for (const [i, { path }] of chunk.entries()) {
    const nl = out.indexOf(0x0a, off)
    if (nl === -1) throw desync(`the stream ended before the header for '${path}'`, i)
    const header = out.toString('utf8', off, nl)
    off = nl + 1
    const parts = header.split(' ')
    // `<oid> missing` is the only header with no payload behind it; every
    // other type IS followed by <size> bytes and must be consumed even
    // when it is not a blob, or the next record is read from the middle
    // of this one.
    //
    // A staged entry whose blob is not in the object store means a damaged
    // repository. "Damaged" must not mean "unscanned" — but it must not
    // mean "scanned something else" either, which is what the working-tree
    // fallback here amounted to (#4046, and the section above).
    if (parts[1] === 'missing') {
      const err = new Error(
        `git cat-file --batch: the index names blob ${chunk[i].sha} for '${path}', but the ` +
          'object store does not have it. The staged content cannot be read, and the copy on ' +
          'disk is different content — reporting it under "judged the staged index" would be a ' +
          'verdict about a file nobody staged, so the scan is abandoned rather than ' +
          're-aimed (scripts/lib/guard-file-source.mjs).',
      )
      err.isMissingObject = true
      throw err
    }
    const size = Number(parts[2])
    if (!Number.isFinite(size)) {
      throw desync(`header ${JSON.stringify(header)} for '${path}' carries no readable size`, i)
    }
    // A payload that runs past the end of the response is the same failure
    // one record earlier: `Buffer.toString` would CLAMP to the end of the
    // buffer and hand back a short body as though it were the whole file,
    // which is an unscanned tail rather than an unscanned file — quieter
    // still, and it would only surface as a desync on the NEXT header, if at
    // all.
    if (off + size > out.length) {
      throw desync(
        `the payload for '${path}' claims ${size} bytes but only ${out.length - off} remain`,
        i,
      )
    }
    // `size === 0` (a zero-byte tracked file) sets `''` DELIBERATELY, and
    // must not be guarded behind `if (size)`: an empty file is a file that
    // was read and judged, and dropping it here would make it indexed as
    // "unreadable" — an unscanned path. `off` still advances by 1 past the
    // LF git writes after a zero-length payload.
    if (parts[1] === 'blob') bodies.set(path, out.toString('utf8', off, off + size))
    off += size + 1
  }
  return bodies
}
