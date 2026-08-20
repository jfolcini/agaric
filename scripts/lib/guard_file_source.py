"""Which COPY of a file is a Python guard judging? (#3962 / #4017)

The Python sibling of `scripts/lib/guard-file-source.mjs`, for the three
guards that take prek's changed-file list and `open()` those paths from
disk: `check-raw-tx.py`, `check-dynamic-sql.py`, `check-command-arity.py`.

─── The defect ─────────────────────────────────────────────────────────

Every one of them receives a list of PATHS and then reads the WORKING
TREE copy of each. During a commit the file that matters is the STAGED
one, and the two disagree whenever the working tree is dirty relative to
the index (during an agent-driven session, most of the time):

  * FALSE GREEN — the violation is staged, the author then fixes it on
    disk without `git add`. The guard reads the fixed copy, exits 0, and
    the broken content is committed. This is the exact failure the guard
    exists to prevent, and it fails silently.
  * FALSE RED — the fix is staged and a later working-tree edit
    reintroduces the violation. The commit is blocked over a file the
    author already fixed.

The exposure is narrower than it first looks, and the honest statement of
it is worth keeping in one place: prek stashes unstaged changes before
running hooks, so during a normal prek-driven commit the working tree
already equals the index. The case that survives the stash is
`git commit -- <path>`, where a violation sits in HEAD and its fix is
staged outside the partial set — and there git exports a
`GIT_INDEX_FILE` naming a `next-index-<pid>.lock` temp index that is the
only correct thing to read.

─── Which TREE is judged (not the same question) ───────────────────────

A guard judges the tree that CONTAINS IT: `REPO_ROOT` is the guard's own
`scripts/..`, never a root derived from the process cwd. That rule is not
a detail, it is the contract `scripts/pr-merge-result-check.sh` is built
on — it runs each ratchet guard out of the MERGED WORKTREE's own
`scripts/` precisely so that the copy's location states which tree to
judge, and `check-table-ownership.py` has always spelled it this way.

Deriving the root from cwd instead was tried and reverted: it made the
guards agree with prek and CI (where cwd IS the repo root) and silently
disagree everywhere else. Measured — a guard invoked as
`<tree>/scripts/check-dynamic-sql.py <tree>/src-tauri/src/foo.rs` from a
different cwd rejected every target as "outside the repository" and
exited 0 over an unbaselined violation. A false green, produced by the
change meant to end false greens. A self-test that wants a guard to judge
a fixture puts the guard IN the fixture, which is what
`scripts/test-py-guard-file-source.sh` and `pr-merge-result-check.sh`
both now do.

The rule, the ONE guard family that does not follow it, and what to do
instead are stated once — in `scripts/lib/guard-file-source.mjs`, under
"Which TREE is judged, and the one documented exception". Not restated
here beyond the paragraph above: a rule written down twice is a rule
that will be true in one place.

─── How the source is chosen ───────────────────────────────────────────

Identical rule to the `.mjs` helper, deliberately — two helpers that
resolve the same question differently are worse than one. "Identical"
names three things, all of which the `.mjs` side now implements:
`_index_belongs_to` (there, `indexBelongsTo`), the exit-2 refusal when a
commit is in flight in a different repository (there, an error carrying
`isAmbiguousSource`, which both callers already render as an exit-2
invocation error), and the binding of the guard's own `git` environment
(there, `gitEnv`).

It was NOT identical when this paragraph was first written: the `.mjs`
AUTO rule keyed on `GIT_INDEX_FILE` merely being SET and bound no env, so
for a foreign index the two helpers answered OPPOSITELY — Python exit 2,
Node "the staged index" of a repository it was not judging, plus a
`--cached` that enumerated that repository from a cwd suggesting
otherwise. Both are ported, and both are held there by the fail-closed
scenarios in `runSourceScenarios` (scenario 9), which are the twin of
section 5 of `scripts/test-py-guard-file-source.sh`. A claim of sameness
is only worth making where something fails when it stops being true.

And only where the situation it is pinned in can tell the two apart.
Scenario 9 and section 5 both use a FOREIGN repository's index — the one
case where every plausible implementation answers False — so they held
the claim in the one situation that could not discriminate, and the two
helpers diverged anyway the moment #4048 gave the `.mjs` side its own
copy of the probe: for a LINKED WORKTREE's own index, Python said True
and Node said False, blocking every worktree commit at exit 2. The
discriminating case is a worktree, so both suites now build one —
`git worktree add` inside the scratch root, section 9 here and scenario
10 there — and assert all three answers: the tree's own index accepted,
a sibling worktree's refused, the main checkout's refused.

A fourth thing was NOT the same and now is (#4046): what a failed blob
read means. Both helpers used to answer "read the working tree copy
instead", while still printing `(judged the staged index)` — the
mis-attributed verdict of #3962, arriving through the reader. Both now
fail closed, for the reason spelled out in `_blob` here and in
`parseBatchStream` there. The two are the same rule stated where each
implementation can violate it, not the same paragraph twice: the shared
half — that an unmerged path is the ONE case whose right answer is the
disk, and that it never reaches the blob read — is stated in `read`.

  --cached     read the staged index (`git cat-file` on the index blob)
  --worktree   read the working tree (`Path.read_text`)
  neither      AUTO: `GIT_INDEX_FILE` naming THIS tree's index -> index;
               unset -> working tree; naming SOMEBODY ELSE's index ->
               exit 2, because there is no correct guess (see
               `AmbiguousSourceError`)

`PRE_COMMIT` is NOT the bit to key on. Measured, in a throwaway repo, on
prek 0.3.8: it is set identically by a real `git commit`, by
`prek run --all-files` (CI, push.sh Phase A) and by a bare `prek run`, so
it cannot discriminate. `GIT_INDEX_FILE` is not a correlate of "probably
a commit": it is git NAMING THE INDEX IT IS ABOUT TO COMMIT, exported per
githooks(5) to a hook it is running.

─── Deletions, and prek's file list ────────────────────────────────────

prek's changed-file set OMITS deletions, which #4017 calls out as its own
gap. It does not need a separate mechanism here, and the reason is worth
stating so nobody adds one:

  * a DELETED file cannot contain a violation, so `check-raw-tx` and
    `check-command-arity` lose nothing by never being handed it;
  * `check-dynamic-sql`'s baseline is the one place a deletion matters —
    an entry naming a file that is going away must be reclaimed — and its
    orphan sweep is already GLOBAL over the baseline rather than over
    prek's list. Under the index source `exists()` answers that sweep
    from the index, so a `git rm --cached` (staged deletion, file still
    sitting on disk) is now seen as the deletion it is. That was
    previously invisible: `Path.is_file()` said yes.

A staged deletion has to be answered the same way by EVERY method, and
for one release it was not: `read` fell back to disk for any path with no
stage-0 entry, so the guard whose sweep had just been taught to see the
deletion read the deleted file's content anyway (#4058). `exists`, `read`
and `list_paths` now answer about one set — see `read` for the three-way
split that gets an unmerged path its disk copy without giving one to a
path that is simply not in the commit.

─── Cost ───────────────────────────────────────────────────────────────

`read()` costs one `git cat-file blob <sha>` spawn per file read from the
index, cached per path. That is affordable precisely because of the AUTO
rule: the whole-tree runs (`prek run --all-files`, CI, a manual invocation)
have no `GIT_INDEX_FILE` and so never take this path at all. For
`check-raw-tx.py` and `check-command-arity.py`, and for
`check-dynamic-sql.py`'s marker check, the index path only runs inside a
real commit hook, where the file list is the commit's changed set — tens of
files, not thousands.

That is NOT true of `check-dynamic-sql.py`'s orphan sweep (#4063): it is
deliberately GLOBAL over the baseline — an entry naming a file that is
going away must be reclaimed, and prek's changed-file list omits deletions
— so under the index it used to cost one `_blob` spawn per baseline entry
(~70 today) on every commit that touches a scanned `.rs` file, independent
of how small that commit is. `read_many` exists for exactly this shape: it
warms the cache for several paths through chunked `git cat-file --batch`
calls — one spawn per `_CAT_FILE_CHUNK` paths rather than one per path —
mirroring `readFromIndex`/`parseBatchStream` in the `.mjs` sibling
verbatim, including the fail-closed handling of a desynchronised stream or
a `missing` object (see `_read_batch`). A caller with more than a handful
of paths to read should call it first; `read()` on each path afterwards is
then a cache hit.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

SOURCE_INDEX = "index"
SOURCE_WORKTREE = "worktree"

# The first path segment under a `$GIT_DIR` at which ANOTHER repository's git
# dir begins: `$GIT_DIR/worktrees/<name>` for a linked worktree,
# `$GIT_DIR/modules/<name>` for a submodule. An index below one of those
# belongs to that repository, never to the root whose `$GIT_DIR` contains it.
# See `_index_belongs_to`; the `.mjs` twin spells this `NESTED_GIT_DIRS`.
_NESTED_GIT_DIRS = frozenset({"worktrees", "modules"})

# ─── The variables that RE-AIM git, and the one that INFORMS it ───────────
#
# Every name below merely points git at a directory it would otherwise
# DISCOVER for itself, whether the caller meant it to or not: they outrank
# `-C root` (#4061, the ownership probe) and they outrank `cwd=root` (#4191,
# the guard's own `ls-files`/`cat-file`). That redundancy is what makes
# removing them safe, and it is the whole distinction this module draws
# between a leaked git context and a legitimate one — with `cwd` at the tree
# being judged, ordinary discovery finds that tree's own git dir and answers
# identically, so scrubbing is a no-op when the ambient context is honest and
# corrective when it is not. There is nothing to sniff. Measured on git 2.43:
# an ordinary `git commit` in a main checkout exports NO `GIT_DIR` at all; a
# commit in a LINKED WORKTREE exports the absolute
# `<main>/.git/worktrees/<name>` that `rev-parse --absolute-git-dir` answers
# with the variable removed; so does a checkout whose `.git` is a GITFILE
# (`git init --separate-git-dir`, and every submodule), which is a MAIN
# checkout exporting an absolute `GIT_DIR` and equally redundant, since
# discovery reads the same target out of the gitfile — the argument rests on
# redundancy, not on absence; and a relative `GIT_DIR=.git` resolves against
# the git process's cwd, which every call here fixes at `root`.
#
# `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are ONE
# mechanism in two variables — git's `receive-pack` quarantine exports the
# pair together — and re-aim the OBJECT STORE the way the others re-aim the
# git dir: the alternates git would otherwise use are discovered from
# `<gitdir>/objects/info/alternates`. Scrubbing one and keeping the other
# leaves a half-configured store, and the half left behind is not harmless.
# Measured on git 2.43: `git cat-file` does NOT verify that an object's body
# hashes to the name it was asked for, and an alternate is consulted for any
# oid the primary store lacks — so a leaked `GIT_ALTERNATE_OBJECT_DIRECTORIES`
# can serve an ATTACKER-CHOSEN body for an oid `git ls-files -s` names,
# through `cat-file blob` and `cat-file --batch` alike. Reproduced against
# `check-raw-tx.py --cached` over a staged violation whose loose object had
# been removed: exit 2 (the fail-closed "damaged object store" refusal) became
# exit 0 over a forged clean body. Pinned in section 5c of
# `scripts/test-py-guard-file-source.sh`.
#
# What is deliberately NOT here, measured rather than argued, because the
# test for membership is "can it change what a guard READS about the tree in
# front of it" and not "is it a `GIT_` variable": `GIT_CONFIG_GLOBAL` /
# `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_COUNT` / `GIT_CONFIG_PARAMETERS` (git
# ignores `core.worktree` and `core.bare` from anywhere but the repository's
# own config, and all three spellings left `--show-toplevel` and `ls-files`
# answering about the tree at `cwd`; scrubbing them would also make a fixture
# that isolates itself with `GIT_CONFIG_GLOBAL` read the developer's real
# `~/.gitconfig` instead); `GIT_PREFIX` (exported to every hook, consumed by
# none of these calls); and `GIT_CEILING_DIRECTORIES` /
# `GIT_DISCOVERY_ACROSS_FILESYSTEM`, which bound the UPWARD walk rather than
# aiming it — the worst either can do is truncate or extend the ANCESTRY of
# `cwd`, never name an unrelated repository, and both were measured inert
# when `cwd` IS the toplevel, which is the only shape a guard runs in.
#
# `GIT_INDEX_FILE` is deliberately ABSENT, in both of its roles. For
# `_index_belongs_to` it is the value under TEST rather than ambient context
# to strip (and `rev-parse --absolute-git-dir` never consults it). For
# `git_env` it is the one variable that is NOT redundant with discovery: a
# commit in flight names a temp index — `.git/index.lock`,
# `.git/next-index-<pid>.lock` — that exists nowhere in git's layout and
# cannot be re-derived, so it is KEPT when it belongs to the tree being
# judged rather than dropped wholesale.
#
# A subset of `GIT_SCRATCH_LEAK_VARS` (`scripts/lib/git-scratch-guard.sh`) —
# that list scrubs a whole fixture's environment for a battery of git
# subcommands; this one scrubs the calls a guard makes about the tree it is
# judging. The Python twin of `GIT_REDIRECT_VARS` in `guard-file-source.mjs`;
# the two lists are identical, which is the point.
_GIT_REDIRECT_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
)


def scrub_git_redirects(env) -> dict:
    """A copy of `env` with the path-redirect variables above removed.

    The one spelling of "ask git about the directory in front of you, not
    about wherever an inherited environment points" — used by the ownership
    probe (#4061) and by `git_env` for the guard's own enumeration and blob
    reads (#4191). Those were two separate exposures of one question, and
    they had two different answers before this existed.

    `GIT_INDEX_FILE` survives this call untouched — see the list's own note.
    """
    out = dict(env)
    for name in _GIT_REDIRECT_VARS:
        out.pop(name, None)
    return out


# `read_many`'s chunk size (#4063), matching `CAT_FILE_CHUNK` in the `.mjs`
# sibling exactly, for the same reason: peak memory is bounded by the
# chunk rather than by however many paths a caller passes, and one spawn per
# chunk of this many paths — rather than one per path — is the whole point.
_CAT_FILE_CHUNK = 500


class UsageError(Exception):
    """A flag this guard does not understand, or two that contradict."""


class AmbiguousSourceError(Exception):
    """A commit is in flight, but not in the tree this guard is judging.

    `GIT_INDEX_FILE` names the index of ONE repository. A guard rooted in a
    DIFFERENT tree — `pr-merge-result-check.sh` runs each guard out of the
    merged worktree's own `scripts/`, against that worktree's files — has no
    business reading it: the two describe unrelated content, and "the staged
    index" is not a meaningful answer for a hypothetical merge that was never
    staged anywhere.

    The old AUTO rule keyed on the variable being SET, not on whose index it
    named, so in that situation it would have enumerated the committing
    repository while reporting a verdict about the merge. There is no correct
    guess available here, so there is no guess: the caller is told to say
    which copy it means with `--worktree` or `--cached`, and the guard exits
    2 until it does.

    This holds UNCONDITIONALLY — not only while the ambient environment
    carries no `GIT_DIR` of its own. It used to hold only in that narrower
    case: `_index_belongs_to`'s ownership probe ran under the ambient
    environment, and an inherited `GIT_DIR` outranks `-C root`, so a
    `GIT_DIR` exported alongside a foreign `GIT_INDEX_FILE` could make the
    probe answer about that foreign repository and accept its index as this
    one's (#4061). The probe now scrubs its own environment of exactly the
    variables that could redirect it, so the guarantee this exception exists
    to state — a foreign index is refused, never silently read — is true
    regardless of what the caller's shell happens to have exported.
    """


class GitError(Exception):
    """`git` could not answer, so the index could not be enumerated.

    This exists because the first draft of `_entries` swallowed a non-zero
    `git ls-files` into an EMPTY index — and an empty index means "no path
    exists in the source", so every file the guard was handed was skipped
    and the guard exited 0. A guard that reports clean without having
    looked is the precise failure this module was written to end, so the
    enumeration fails CLOSED: the caller exits 2 with the cause named.
    Measured while wiring this up: an unreadable `GIT_INDEX_FILE` made
    `check-raw-tx.py` exit 0 over a whole tree it never read.
    """


def _index_belongs_to(index_file: str, root: Path) -> bool:
    """Does `index_file` name an index of the repository at `root`?

    A RELATIVE `GIT_INDEX_FILE` (`.git/index` — what an ordinary `git commit`
    exports) is resolved against the process cwd, because that is how git
    itself resolves it. A `root` that is not a git repository at all answers
    False — a commit in flight somewhere, over a tree that is not a
    repository, is precisely the case with no right answer.

    ─── One git dir, not two — correcting the #4048 probe ──────────────

    This used to accept a path under EITHER `--absolute-git-dir` or
    `--git-common-dir`, on the stated grounds that "in a linked worktree the
    index lives under `…/.git/worktrees/<name>/index` while the object store
    is shared, so both spellings have to count". The premise is true and the
    conclusion does not follow: in a linked worktree `--absolute-git-dir` IS
    `…/.git/worktrees/<name>`, which already contains that index — and every
    index of a repository lives in its `$GIT_DIR`, including the
    `index.lock` / `next-index-<pid>.lock` temp indexes git exports for
    `git commit -a` and `git commit -- <path>`. So the common-dir arm never
    accepted anything the git-dir arm refused for a good reason.

    What it DID accept is every OTHER worktree's index, since `…/.git` is
    the common dir of the main checkout and of all its linked worktrees
    alike. Measured on git 2.43, in a scratch repo with two linked
    worktrees, before this change: worktree B's index was accepted as
    belonging to worktree A. That is a false ACCEPT, and it fails silently
    in the worst direction — the guard reads a sibling tree's index, finds
    nothing staged there, and exits 0 over the violation actually being
    committed.

    …and containment alone is not enough either. A linked worktree's git
    dir is NESTED INSIDE the main one (`<main>/.git/worktrees/<name>`), so
    "under `--absolute-git-dir`" still accepts a worktree's index as the
    MAIN checkout's — the same false accept one level up, and the live
    shape in this repo, where an agent runs a guard in the main checkout
    while a commit is in flight in a worktree. `_NESTED_GIT_DIRS` is git's
    own layout contract: `$GIT_DIR/worktrees/<name>` is a linked worktree's
    git dir and `$GIT_DIR/modules/<name>` a submodule's, so an index under
    either belongs to THAT repository and never to this root. For a linked
    worktree root the git dir already IS `…/worktrees/<name>` and git does
    not nest further, so one rule reads correctly from both sides.

    Measured before the fix, against section 9 of
    `scripts/test-py-guard-file-source.sh`: all three false accepts exited
    0 over a staged violation — a sibling worktree's index, the main
    checkout's index read from a worktree, and a worktree's index read from
    the main checkout. Pinned there, and by scenario 10 of
    `runSourceScenarios`.

    ─── An inherited GIT_DIR outranks -C too (#4061) ────────────────────

    `-C root` tells THIS `git` command where to look — but an ambient
    `GIT_DIR` outranks it (measured on git 2.43: `GIT_DIR=<other>/.git git
    -C <root> rev-parse --absolute-git-dir` answers about `<other>`, not
    `root`). So with both `GIT_DIR` and `GIT_INDEX_FILE` exported from
    ANOTHER repository — exactly what a real commit hook leaves in the
    environment of that repository — the leaked `GIT_DIR` made this probe
    answer about that other repository, and `index_file` (also naming a
    path under that same leaked git dir) then compared EQUAL to it: a false
    ACCEPT of a foreign index as belonging to `root`, silently defeating the
    exit-2 refusal `AmbiguousSourceError` exists to raise.

    The probe's OWN environment is scrubbed of `_GIT_REDIRECT_VARS` before
    this call for exactly that reason — asking "what repository is at this
    path" is a question no ambient git context should get to answer on
    `root`'s behalf. `git_env` still binds the rest of it, and
    `GIT_INDEX_FILE` is still the one variable it decides by BELONGING —
    kept when this probe (now honest about `root`) says it is this tree's,
    dropped when it says otherwise. What is no longer true of that function
    is "and strips nothing else": since #4191 it removes the whole of
    `_GIT_REDIRECT_VARS` unconditionally, because those re-aim its
    `ls-files`/`cat-file` exactly as they re-aimed this probe.

    Measured before this fix, in a two-repository scratch fixture with
    `GIT_DIR` and `GIT_INDEX_FILE` both exported from the second: AUTO
    accepted the foreign index as belonging to the first, and the guard
    exited 0 over a staged violation it never read. Pinned in section 5 of
    `scripts/test-py-guard-file-source.sh` and scenario 9 of
    `runSourceScenarios`.
    """
    path = Path(index_file)
    if not path.is_absolute():
        path = Path.cwd() / path
    path = Path(os.path.normpath(path))
    probe_env = scrub_git_redirects(os.environ)
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--absolute-git-dir"],
            capture_output=True,
            text=True,
            check=False,
            env=probe_env,
        )
    except OSError:
        return False
    if out.returncode != 0 or not out.stdout.strip():
        return False
    git_dir = Path(out.stdout.strip())
    if not git_dir.is_absolute():
        git_dir = root / git_dir
    git_dir = Path(os.path.normpath(git_dir))
    if path == git_dir:
        return True
    if git_dir not in path.parents:
        return False
    return path.relative_to(git_dir).parts[0] not in _NESTED_GIT_DIRS


def git_env(root: Path, env) -> dict:
    """The environment this guard's own `git` calls run under.

    `cwd` does NOT decide which index git reads — an ambient
    `GIT_INDEX_FILE` outranks it. So a guard reading the staged index of
    `root` while some OTHER repository's index is exported would enumerate
    that other repository, with `cwd=root` making it look otherwise. That is
    the #3722/#4015 hazard reaching the reader instead of a fixture.

    `--cached` therefore means "the staged index OF THE TREE BEING JUDGED",
    which is the only reading that is true in both places it is used: a
    commit hook (where the exported index IS this tree's, often a
    `next-index-<pid>.lock` that MUST be honoured) and
    `pr-merge-result-check.sh` (where it is somebody else's and must not
    be). Belonging decides which INDEX is read.

    ─── …and an ambient GIT_DIR outranks `cwd` in exactly the same way ───

    This function used to leave the rest of the environment exactly as
    given, on the stated grounds that "a foreign `GIT_DIR`/`GIT_WORK_TREE`
    in `env` is out of scope for this function". It was not (#4191):
    `GIT_DIR` re-aims the very `git ls-files` this env is built for.
    Measured on git 2.43, from a cwd inside repo A:
    `GIT_DIR=<B>/.git git -C <A> ls-files` lists B's tracked paths, not
    A's — `-C` and `cwd` both lose to it. So a leaked `GIT_DIR` made
    `_entries` enumerate the OTHER repository's index while `cwd=root` made
    it look otherwise, and the guard reported a verdict about a tree it
    never opened. Reproduced against `check-raw-tx.py --cached` in a
    two-repository fixture, with the foreign `GIT_INDEX_FILE` correctly
    stripped by the rule above and `GIT_DIR` alone left in place: exit 0
    over a staged violation, because `ls-files` fell back to that git dir's
    own default index and the path under judgement was simply not in it.

    The redirect variables are therefore scrubbed here too, unconditionally
    — see `_GIT_REDIRECT_VARS` for why that does not need to distinguish a
    hostile leak from an honest one, and why `GIT_INDEX_FILE` is the one
    variable that gets a belonging test rather than a blanket removal.
    Nothing about a real commit hook's environment changes: the hook's
    `GIT_DIR`, when it exports one at all, names the same directory
    `cwd=root` already discovers.

    That leaves `_index_belongs_to`'s OWN probe (#4061) as the second half
    of the same rule rather than the whole of it: before that fix,
    "belonging decides" was true in name only — a `GIT_DIR` exported
    alongside a foreign `GIT_INDEX_FILE` could make the probe answer about
    that foreign repository and accept its index as `root`'s.
    """
    out = scrub_git_redirects(env)
    index_file = out.get("GIT_INDEX_FILE")
    if index_file and not _index_belongs_to(index_file, root):
        del out["GIT_INDEX_FILE"]
    return out


def describe_source(source: str) -> str:
    return "staged index" if source == SOURCE_INDEX else "working tree"


def resolve_source(
    argv: list[str],
    env,
    root: Path,
    extra_flags: tuple[str, ...] = (),
) -> tuple[str, str]:
    """Return `(source, why)` for this invocation.

    UNKNOWN FLAGS ARE AN ERROR. Ignoring them makes `--cache` — one
    keystroke short of `--cached` — resolve to AUTO, so the caller who
    asked for the index silently gets whichever copy AUTO picked. That is
    the exact failure this module exists to end, arriving through the
    option parser instead of through the reader.

    Only arguments starting with `-` are judged: unlike the `.mjs`
    helper's two callers, these three guards are `pass_filenames = true`
    and every other argument is a path.
    """
    flags = [a for a in argv if a.startswith("-")]
    known = {"--cached", "--worktree", *extra_flags}
    unknown = [f for f in flags if f not in known]
    if unknown:
        raise UsageError(
            f"unknown option {', '.join(repr(u) for u in unknown)} — "
            f"known options: {', '.join(sorted(known))}"
        )
    cached = "--cached" in flags
    worktree = "--worktree" in flags
    if cached and worktree:
        raise UsageError("--cached and --worktree are mutually exclusive")
    if cached:
        return SOURCE_INDEX, "explicit --cached"
    if worktree:
        return SOURCE_WORKTREE, "explicit --worktree"
    index_file = env.get("GIT_INDEX_FILE")
    if not index_file:
        return SOURCE_WORKTREE, "auto: no commit in flight (GIT_INDEX_FILE unset)"
    # SET is not enough — it has to be OUR index. See `AmbiguousSourceError`.
    if _index_belongs_to(index_file, root):
        return (
            SOURCE_INDEX,
            f"auto: git is running a commit hook, GIT_INDEX_FILE={index_file}",
        )
    raise AmbiguousSourceError(
        f"a commit is in flight (GIT_INDEX_FILE={index_file}) but it belongs to a "
        f"different repository than the tree being judged ({root}).\n"
        "  Reading that index would enumerate the committing repository and report the "
        "result as a verdict about this tree.\n"
        "  Say which copy you mean: --worktree (judge the files at these paths) or "
        "--cached (judge the staged index)."
    )


class FileSource:
    """Reads repo-relative paths from ONE source, with the index cached.

    Every method takes a REPO-RELATIVE posix path — the same spelling the
    guards already use for their allowlists, baselines and messages — so
    there is no second notion of identity to keep in step.
    """

    def __init__(self, repo_root: Path, source: str, why: str = "", env=None) -> None:
        self.repo_root = repo_root
        self.source = source
        self.why = why
        self.env = git_env(repo_root, os.environ if env is None else env)
        self._index: dict[str, tuple[str, str]] | None = None
        self._unmerged: set[str] = set()
        self._blobs: dict[str, str | None] = {}

    # -- index plumbing ---------------------------------------------------

    def _entries(self) -> dict[str, tuple[str, str]]:
        """rel -> (mode, sha) for every stage-0 index entry.

        `-z` rather than plain `ls-files -s`: NUL-separated records mean a
        path containing a quote, a backslash or a newline arrives intact
        instead of C-quoted, and a path that cannot be parsed is a path
        that cannot be scanned.

        Unmerged paths (stages 1/2/3, no stage 0) are deliberately absent
        from this mapping — they are not part of the commit — but they are
        RECORDED, in `_unmerged`, because "no stage-0 entry" is two
        different facts and `read` owes them different answers (#4058):

          * UNMERGED — a conflict in progress. The conflicted copy on disk
            is where the markers the author is resolving actually live, so
            that is what `read` returns.
          * ABSENT — never staged, or staged for DELETION (`git rm
            --cached`, which leaves the file sitting on disk). It is not in
            the commit, `exists()` says so, and `read` must say so too.

        Collapsing the two onto "fall back to disk" made the two methods
        contradict each other: `exists()` answered the index while `read()`
        handed back the working tree's content for the very path it had
        just called absent.
        """
        if self._index is None:
            try:
                out = subprocess.run(
                    ["git", "ls-files", "-s", "-z"],
                    cwd=self.repo_root,
                    env=self.env,
                    capture_output=True,
                    check=False,
                )
            except OSError as err:  # git missing from PATH, cwd gone, ...
                raise GitError(f"could not run `git ls-files`: {err}") from err
            if out.returncode != 0:
                raise GitError(
                    "`git ls-files -s -z` failed "
                    f"(exit {out.returncode}): "
                    f"{out.stderr.decode('utf-8', 'replace').strip()}"
                )
            entries: dict[str, tuple[str, str]] = {}
            unmerged: set[str] = set()
            for record in out.stdout.split(b"\0"):
                if not record or b"\t" not in record:
                    continue
                meta, _, raw_path = record.partition(b"\t")
                parts = meta.split(b" ")
                if len(parts) < 3:
                    continue
                rel = raw_path.decode("utf-8", "surrogateescape")
                if parts[2] == b"0":
                    entries[rel] = (parts[0].decode(), parts[1].decode())
                else:
                    unmerged.add(rel)
            self._index = entries
            self._unmerged = unmerged
        return self._index

    def _is_unmerged(self, rel: str) -> bool:
        """Does `rel` have conflict stages (1/2/3) and no stage 0?

        Goes through `_entries` so the index is loaded — and so a `git
        ls-files` that could not answer still fails CLOSED here rather than
        reporting "not unmerged" about an index nobody read.
        """
        self._entries()
        return rel in self._unmerged

    def _blob(self, rel: str) -> str | None:
        """`rel`'s STAGED text, or None if the index offers no blob for it.

        NONE MEANS "THE INDEX HAS NO BLOB HERE", NEVER "THE BLOB WOULD NOT
        COME BACK" (#4046). Exactly two things produce None: no stage-0
        entry, and a gitlink (mode 160000, a submodule — no blob to read,
        and the working tree would effectively skip it too, it is a
        directory).

        A `git cat-file` that FAILS raises `GitError` instead, and the
        reasoning is worth keeping because the first draft did the opposite
        — it swallowed every non-zero exit into None and let `read` return
        the working-tree copy under a "judged the staged index" banner.

        A `cat-file` failure has more than one cause (a missing object, a
        corrupt pack, an unreadable object store, the OOM killer, `git`
        itself gone), and the only per-call signal separating them is
        stderr TEXT, which is not a contract. But the distinction that
        actually matters is not made by parsing stderr at all — it is made
        by WHICH BRANCH THE PATH TOOK. The one case where the working-tree
        copy IS the right answer is an unmerged path, and such a path has
        no stage-0 sha, so it never reaches `cat-file`; it is routed to
        disk by `read` before this method would run. Everything left here
        is "the index says this content is being committed, and git cannot
        produce it" — for which the on-disk file is not a substitute but a
        DIFFERENT file's content, offered under a verdict claiming the
        index. There is no benign cause to preserve the fallback for, so it
        fails closed: the callers already turn `GitError` into exit 2 with
        the cause named, which is the only honest answer available.

        The `.mjs` sibling reaches the same verdict by the same reasoning —
        see `readFromIndex`/`parseBatchStream` in
        `scripts/lib/guard-file-source.mjs`, where `<oid> missing` is an
        error rather than a working-tree fallback.
        """
        if rel in self._blobs:
            return self._blobs[rel]
        entry = self._entries().get(rel)
        text: str | None = None
        if entry is not None and entry[0] != "160000":
            out = subprocess.run(
                ["git", "cat-file", "blob", entry[1]],
                cwd=self.repo_root,
                env=self.env,
                capture_output=True,
                check=False,
            )
            if out.returncode != 0:
                raise GitError(
                    f"`git cat-file blob {entry[1]}` failed for '{rel}' "
                    f"(exit {out.returncode}): "
                    f"{out.stderr.decode('utf-8', 'replace').strip()}\n"
                    "  The index names that blob, so this is a damaged or "
                    "unreadable object store — the staged content cannot be "
                    "read.\n"
                    "  Reading the working-tree copy instead would report a "
                    "verdict about a different file's content under a claim of "
                    "having judged the index."
                )
            text = out.stdout.decode("utf-8", "replace")
        self._blobs[rel] = text
        return text

    def read_many(self, rels, chunk_size: int = _CAT_FILE_CHUNK) -> None:
        """Warm the blob cache for several paths at once (#4063).

        A no-op under the working tree: a disk read is already a single
        syscall with no spawn to amortize, so there is nothing here to
        batch. Under the index it is `_blob`'s per-call `git cat-file blob
        <sha>` collapsed into chunked `git cat-file --batch` calls — one
        spawn per `chunk_size` paths, not one per path — so a caller
        that is about to `read()` many paths (`check-dynamic-sql.py`'s
        orphan sweep, global over the baseline: ~70 entries today, one spawn
        each before this existed) can pay for it once up front. `read()`
        afterwards is a cache hit for every path this warmed; it is
        unaffected for any path this did not (already cached, no stage-0
        blob, or not passed here at all).

        `chunk_size` defaults to `_CAT_FILE_CHUNK` and exists as an explicit
        parameter — rather than a module global a caller reaches into — for
        the same reason the `.mjs` sibling threads `chunkSize` through
        `readContents`/`readFromIndex`: "ONLY so a self-test can drive the
        chunk-boundary path" without depending on a private name that could
        be renamed or inlined out from under a monkeypatch.

        Ports `readFromIndex`/`parseBatchStream` from the `.mjs` sibling
        (`scripts/lib/guard-file-source.mjs`) verbatim in behaviour,
        including the fail-closed handling `_read_batch`/`_parse_batch`
        describe: a malformed stream or a `missing` object raises `GitError`
        rather than silently leaving the remainder of the chunk unread.
        """
        if self.source != SOURCE_INDEX:
            return
        entries = self._entries()
        wanted: list[tuple[str, str]] = []
        seen: set[str] = set()
        for rel in rels:
            if rel in seen or rel in self._blobs:
                continue
            seen.add(rel)
            entry = entries.get(rel)
            if entry is None or entry[0] == "160000":
                continue
            wanted.append((rel, entry[1]))
        for i in range(0, len(wanted), chunk_size):
            self._read_batch(wanted[i : i + chunk_size])

    def _read_batch(self, chunk: list[tuple[str, str]]) -> None:
        """Run ONE `git cat-file --batch` over `chunk` and cache every body.

        Split out of `read_many` only so the chunking loop stays readable;
        see `read_many` for what this is for and `_parse_batch` for the
        framing it trusts git to honour.
        """
        stdin = ("\n".join(sha for _, sha in chunk) + "\n").encode("utf-8")
        out = subprocess.run(
            ["git", "cat-file", "--batch"],
            cwd=self.repo_root,
            env=self.env,
            input=stdin,
            capture_output=True,
            check=False,
        )
        if out.returncode != 0:
            raise GitError(
                f"`git cat-file --batch` failed over {len(chunk)} path(s) "
                f"(exit {out.returncode}): "
                f"{out.stderr.decode('utf-8', 'replace').strip()}\n"
                "  The index names these blobs, so this is a damaged or "
                "unreadable object store — the staged content cannot be read."
            )
        self._parse_batch(out.stdout, chunk)

    def _parse_batch(self, data: bytes, chunk: list[tuple[str, str]]) -> None:
        """Walk ONE `cat-file --batch` response against the chunk that made it.

        The Python twin of `parseBatchStream` in the `.mjs` sibling — same
        framing, same two failure modes, same reason each one THROWS rather
        than abandoning the rest of the chunk to a silent skip. See that
        function's docstring for why: in short, a `break` here used to leave
        up to `_CAT_FILE_CHUNK` staged paths absent from `self._blobs` with
        no fallback behind them, which is the loudest possible version of
        the "unscanned file" failure this whole module exists to prevent — a
        guard that exits 0 having read almost nothing. `<oid> missing` is
        thrown too, for the same #4046 reason `_blob` already throws on it:
        the sha came out of the index moments earlier, so the object store
        not having it is damage, not a benign per-file answer, and the
        working-tree copy would be DIFFERENT content offered under a verdict
        claiming the index.
        """
        off = 0
        n = len(chunk)
        for i, (rel, sha) in enumerate(chunk):
            nl = data.find(b"\n", off)
            if nl == -1:
                raise GitError(
                    "`git cat-file --batch` desynchronised: the stream ended "
                    f"before the header for '{rel}'. {n - i} of {n} staged "
                    "path(s) in this batch would have gone unread, so the "
                    "read is abandoned rather than reported clean."
                )
            header = data[off:nl].decode("utf-8", "replace")
            off = nl + 1
            parts = header.split(" ")
            if len(parts) >= 2 and parts[1] == "missing":
                raise GitError(
                    f"`git cat-file --batch`: the index names blob {sha} for "
                    f"'{rel}', but the object store does not have it. The "
                    "staged content cannot be read, and the copy on disk is "
                    "different content — reporting it under a verdict "
                    "claiming the index would be a verdict about a file "
                    "nobody staged, so the read is abandoned rather than "
                    "re-aimed."
                )
            if len(parts) < 3:
                raise GitError(
                    "`git cat-file --batch` desynchronised: header "
                    f"{header!r} for '{rel}' carries no readable size. "
                    f"{n - i} of {n} staged path(s) in this batch would have "
                    "gone unread, so the read is abandoned rather than "
                    "reported clean."
                )
            try:
                size = int(parts[2])
            except ValueError:
                raise GitError(
                    "`git cat-file --batch` desynchronised: header "
                    f"{header!r} for '{rel}' carries no readable size. "
                    f"{n - i} of {n} staged path(s) in this batch would have "
                    "gone unread, so the read is abandoned rather than "
                    "reported clean."
                ) from None
            if off + size > len(data):
                raise GitError(
                    "`git cat-file --batch` desynchronised: the payload for "
                    f"'{rel}' claims {size} bytes but only {len(data) - off} "
                    f"remain. {n - i} of {n} staged path(s) in this batch "
                    "would have gone unread, so the read is abandoned rather "
                    "than reported clean."
                )
            # `size == 0` (a zero-byte tracked file) sets `""` deliberately —
            # see `read`'s note that None is not the empty string. `off`
            # still advances by 1 past the LF git writes after the payload,
            # empty or not.
            if parts[1] == "blob":
                self._blobs[rel] = data[off : off + size].decode("utf-8", "replace")
            off += size + 1

    # -- public API -------------------------------------------------------

    def exists(self, rel: str) -> bool:
        """Is `rel` present in the source being judged?

        Under the index that means "will be in the commit"; under the
        working tree it means "is a file on disk right now".

        `exists`, `read` and `list_paths` answer about the SAME SET, and
        that agreement is pinned by fixtures rather than left to reading:
        a path this returns False for reads as None and is not listed.
        """
        if self.source == SOURCE_INDEX:
            return rel in self._entries()
        return (self.repo_root / rel).is_file()

    def read(self, rel: str) -> str | None:
        """`rel`'s contents from the source, or None if it cannot be read.

        NONE IS NOT THE EMPTY STRING. A zero-byte tracked file reads as
        `""`, and callers must test `is None` rather than truthiness: an
        empty file trivially holds no violation, so conflating the two is
        invisible until the day the file is not empty.

        Under the index there are THREE cases, not two (#4058):

          * a stage-0 entry — the staged blob, or `GitError` if git cannot
            hand it back (see `_blob`); a gitlink reads as None;
          * UNMERGED — no stage-0 entry but conflict stages 1/2/3. Falls
            back to the working tree, which is where the markers the author
            is resolving live, so the path is still JUDGED rather than
            silently skipped. git refuses to commit with unmerged paths
            anyway, so the verdict is advisory either way;
          * ABSENT from the index — None, agreeing with `exists()`.

        That last case used to fall back to disk as well, which made the
        two methods contradict each other on a STAGED DELETION: `git rm
        --cached src-tauri/dynamic-sql-baseline.txt` leaves the file on
        disk, so `exists()` said "not in the commit" while `read()` handed
        back the 68-entry ceiling being deleted, and the ratchet judged the
        commit against a baseline that commit removes.

        AN UNDECODABLE FILE IS LOSSY-DECODED, NOT SKIPPED (#4062). Both
        sources now agree here: `_blob` has always turned invalid UTF-8 into
        U+FFFD replacement characters (`out.stdout.decode("utf-8",
        "replace")`), so a tracked file with a bad byte was SCANNED under
        `--cached` and silently SKIPPED under `--worktree` — the same
        divergence #4048 exists to close, arriving through the decoder
        instead of the source choice. `errors="replace"` here matches `_blob`
        and the `.mjs` sibling (`readFileSync(…, 'utf8')` /
        `Buffer.toString('utf8')` are both lossy-replace on both its
        sources), so `errors="replace"` should make a decode failure
        unreachable here. `UnicodeError` (the broader class, not just
        `UnicodeDecodeError`) stays in the `except` regardless, as a second
        line of defence rather than a claim that no decode path can ever
        raise — `OSError`, a genuinely unreadable file, is the case that
        still must answer None either way. An unscanned file is the failure
        this module exists to prevent; a mangled-but-scanned one is not.
        """
        if self.source == SOURCE_INDEX:
            if rel in self._entries():
                return self._blob(rel)
            if not self._is_unmerged(rel):
                return None
            # UNMERGED — fall through to the conflicted copy on disk.
        try:
            return (self.repo_root / rel).read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeError):
            return None

    def list_paths(self, prefix: str, suffix: str = "") -> list[str]:
        """Repo-relative paths under `prefix` ending in `suffix`, FROM THE SOURCE.

        The enumerator half of the same question `read` answers (#4047 /
        #4060). Two guards scan a whole subtree when handed no file
        arguments, and both used to `rglob` the DISK while reading contents
        from the index — the mixed shape #4017 is about, one level up from
        the reader it fixed. Under `--cached` that missed a file staged but
        deleted from the working tree and judged a `git rm --cached`'d one
        that is not in the commit, which is exactly the pair of answers the
        path-argument branch of those guards already gets right.

        Under the index this lists stage-0 entries only, so it agrees with
        `exists()` by construction: an unmerged path is not in the commit
        and is not enumerated as if it were. Under the working tree it is
        the `rglob` it has always been, including untracked files — "the
        working tree" means what is on disk.

        `prefix` is a repo-relative directory (a trailing `/` is optional);
        `suffix` an extension, or `""` for every file.
        """
        if not prefix.endswith("/"):
            prefix += "/"
        if self.source == SOURCE_INDEX:
            return sorted(
                rel
                for rel in self._entries()
                if rel.startswith(prefix) and rel.endswith(suffix)
            )
        root = self.repo_root / prefix
        if not root.is_dir():
            return []
        return sorted(
            p.relative_to(self.repo_root).as_posix()
            for p in root.rglob(f"*{suffix}")
            if p.is_file()
        )


def build(argv: list[str], env, repo_root: Path, extra_flags: tuple[str, ...] = ()) -> FileSource:
    """`resolve_source` + `FileSource`, the two-line call every guard makes."""
    source, why = resolve_source(argv, env, repo_root, extra_flags)
    return FileSource(repo_root, source, why)
