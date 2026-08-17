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

─── Cost ───────────────────────────────────────────────────────────────

One `git cat-file blob <sha>` spawn per file read from the index, cached
per path. That is affordable precisely because of the AUTO rule: the
whole-tree runs (`prek run --all-files`, CI, a manual invocation) have no
`GIT_INDEX_FILE` and so never take this path at all. The index path only
runs inside a real commit hook, where the file list is the commit's
changed set — tens of files, not thousands.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

SOURCE_INDEX = "index"
SOURCE_WORKTREE = "worktree"


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
    itself resolves it.

    Both `--absolute-git-dir` and `--git-common-dir` are accepted: in a
    linked worktree the index lives under
    `…/.git/worktrees/<name>/index` while the object store is shared, and
    both spellings have to count as "this repository". A `root` that is not
    a git repository at all answers False — a commit in flight somewhere,
    over a tree that is not a repository, is precisely the case with no
    right answer.
    """
    path = Path(index_file)
    if not path.is_absolute():
        path = Path.cwd() / path
    path = Path(os.path.normpath(path))
    for flag in ("--absolute-git-dir", "--git-common-dir"):
        try:
            out = subprocess.run(
                ["git", "-C", str(root), "rev-parse", flag],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            return False
        if out.returncode != 0 or not out.stdout.strip():
            continue
        git_dir = Path(out.stdout.strip())
        if not git_dir.is_absolute():
            git_dir = root / git_dir
        git_dir = Path(os.path.normpath(git_dir))
        if path == git_dir or git_dir in path.parents:
            return True
    return False


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
    be). Belonging decides, and nothing else is stripped — a foreign
    `GIT_DIR`/`GIT_WORK_TREE` is out of scope here and would already have
    made `root` itself wrong.
    """
    out = dict(env)
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
        self._blobs: dict[str, str | None] = {}

    # -- index plumbing ---------------------------------------------------

    def _entries(self) -> dict[str, tuple[str, str]]:
        """rel -> (mode, sha) for every stage-0 index entry.

        `-z` rather than plain `ls-files -s`: NUL-separated records mean a
        path containing a quote, a backslash or a newline arrives intact
        instead of C-quoted, and a path that cannot be parsed is a path
        that cannot be scanned. Unmerged paths (stages 1/2/3, no stage 0)
        are deliberately absent, so `read` falls back to the conflicted
        copy on disk — which is where the markers the author is resolving
        actually live.
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
            for record in out.stdout.split(b"\0"):
                if not record or b"\t" not in record:
                    continue
                meta, _, raw_path = record.partition(b"\t")
                parts = meta.split(b" ")
                if len(parts) < 3 or parts[2] != b"0":
                    continue
                entries[raw_path.decode("utf-8", "surrogateescape")] = (
                    parts[0].decode(),
                    parts[1].decode(),
                )
            self._index = entries
        return self._index

    def _blob(self, rel: str) -> str | None:
        if rel in self._blobs:
            return self._blobs[rel]
        entry = self._entries().get(rel)
        text: str | None = None
        # mode 160000 is a gitlink (submodule): no blob to read, and the
        # working tree would effectively skip it too (it is a directory).
        if entry is not None and entry[0] != "160000":
            out = subprocess.run(
                ["git", "cat-file", "blob", entry[1]],
                cwd=self.repo_root,
                env=self.env,
                capture_output=True,
                check=False,
            )
            if out.returncode == 0:
                text = out.stdout.decode("utf-8", "replace")
        self._blobs[rel] = text
        return text

    # -- public API -------------------------------------------------------

    def exists(self, rel: str) -> bool:
        """Is `rel` present in the source being judged?

        Under the index that means "will be in the commit"; under the
        working tree it means "is a file on disk right now".
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

        A path with no stage-0 index entry (unmerged, or simply not in the
        index) falls back to the working tree under the index source, so
        it is still JUDGED rather than silently skipped.
        """
        if self.source == SOURCE_INDEX:
            text = self._blob(rel)
            if text is not None:
                return text
            if rel in self._entries():
                # Present in the index but its blob would not come back:
                # a damaged object store. Judge the copy on disk rather
                # than report a file nobody scanned as clean.
                pass
        try:
            return (self.repo_root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None


def build(argv: list[str], env, repo_root: Path, extra_flags: tuple[str, ...] = ()) -> FileSource:
    """`resolve_source` + `FileSource`, the two-line call every guard makes."""
    source, why = resolve_source(argv, env, repo_root, extra_flags)
    return FileSource(repo_root, source, why)
