# Session 2143 — check-baseline-paths runs as .mjs

#5579's last guard. #5599 kept `check-baseline-paths` because four of the
sets it covers have owners that pass with a dangling entry; this ports it
to `scripts/check-baseline-paths.mjs` and deletes the Python.

Equivalence with the Python, checked by a harness kept out of the repo
(stdout, stderr and exit code, each guard in its own scratch repo built
from HEAD), on Node 24 and 22: 30 scenarios, all with the same exit code.
27 are byte-identical. They cover the real tree, a dangling entry in every
extractor kind and base directory, dangling embedded entries, tracked and
untracked undeclared baselines, emptied and missing sources, a renamed
embedded constant, globs, a bad argument, and no git checkout. The other
three differ only in the runtime's own parse-error text, and in one case
where the Python crashed with a traceback on a JSON baseline that is not a
list of objects; the port reports it as a normal unread-set finding.
Two extractor kinds and the `.py` comment marker no declaration used are
gone.

`scripts/check-baseline-paths.test.mjs` runs the guard end to end in a
scratch repo. Dropping the existence check turns four of its tests red;
dropping the undeclared-baseline check turns exactly that test red.

Review notes applied before the PR:

- The helpers that printed Python-shaped errors (`KeyError('fn')`, a
  Python list repr) are gone; the messages are plain JS.
- Embedded sources are read with the same fatal UTF-8 decoder as data
  files, so invalid bytes in one are an unread-set finding.
- Two fail-closed arms no test reached now have one each, shown red
  against their mutation: an embedded literal that is present but empty,
  and a repo that tracks no files.
- `.gitignore` drops its `__pycache__/` entry: no Python file is left in
  the repo to produce one.

With no `.py` left under `scripts/`, `check-git-fixture-isolation.mjs`
went red on its own wiring check ("found ZERO .py file(s)"). Its Python
handling existed only for Python scripts, so it is removed; old and new
give the same verdicts on all 111 scripts.

Ran, Node 24 and 22: the guard (224 paths resolve), its node tests (12),
`check-git-fixture-isolation.mjs`, `check-hook-budget.mjs` (119/140),
`oxfmt`, type-aware `oxlint`, and `prek run --all-files`.
