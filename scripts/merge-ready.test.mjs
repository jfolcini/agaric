import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Drives scripts/merge-ready.sh against recorded `gh api` responses for PR #6820, trimmed to the
// fields the script reads. The recording is of a merged PR: `state` is patched to `open` and
// `mergeable_state` to `clean`, and the main-side compare is the one up to the commit before the
// merge, so the green case reads as the PR did when it was ready. Every other case is the green
// recording with one response changed.

const SCRIPT = join(import.meta.dirname, 'merge-ready.sh')
const GREEN = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'merge-ready', 'pr-6820.json'), 'utf8'),
)

const R = 'repos/jfolcini/agaric'
const HEAD = '6646bcdbf8f745909be86879e87af7f222e5f8e3'
const ROUTE = {
  pr: `${R}/pulls/6820`,
  checks: `${R}/commits/${HEAD}/check-runs?per_page=100`,
  files: `${R}/pulls/6820/files?per_page=100`,
  reviews: `${R}/pulls/6820/reviews?per_page=100`,
  mainFiles: `${R}/compare/07294ed635a0a0235bae47127f9553f89bec53ff...main?per_page=100`,
  ci: `${R}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=10`,
}

// A stand-in `gh`: `gh api [--paginate] <path>` prints the recorded response for <path> and exits
// 1, like an HTTP error, when there is none.
const FAKE_GH = `#!/usr/bin/env bash
path="\${@: -1}"
jq -ce --arg p "$path" '.[$p]' "$ROUTES_FILE" || { echo "gh: no route for $path" >&2; exit 1; }
`

/** Runs the script on a copy of the green recording that `change` may edit; `routes` is the copy. */
function run(change, args = ['6820']) {
  const routes = structuredClone(GREEN)
  change?.(routes)
  const dir = mkdtempSync(join(tmpdir(), 'merge-ready-'))
  try {
    writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes))
    writeFileSync(join(dir, 'gh'), FAKE_GH)
    chmodSync(join(dir, 'gh'), 0o755)
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ROUTES_FILE: join(dir, 'routes.json'),
      },
    })
    return { status: r.status, out: r.stdout, err: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The one line of output about `label`. */
const line = (out, label) => {
  const found = out.split('\n').filter((l) => l.includes(label))
  assert.equal(found.length, 1, `expected one "${label}" line in:\n${out}`)
  return found[0]
}

/** Asserts the run failed on exactly the `label` line, with every other check still ok. */
function assertFailsOnly(r, label, detail) {
  assert.equal(r.status, 1, r.out)
  const failing = r.out.split('\n').filter((l) => l.startsWith('FAIL'))
  assert.equal(failing.length, 1, r.out)
  assert.ok(failing[0].includes(label), failing[0])
  if (detail) assert.ok(failing[0].includes(detail), failing[0])
  assert.ok(r.out.includes('not ready to merge'), r.out)
}

const setCheck = (routes, name, patch) => {
  const found = routes[ROUTE.checks].check_runs.find((c) => c.name === name)
  assert.ok(found, `fixture has no check run named ${name}`)
  Object.assign(found, patch)
}

void test('green: every check passes and the exit code is 0', () => {
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.equal(r.out.split('\n').filter((l) => l.startsWith('ok')).length, 8, r.out)
  assert.ok(!r.out.includes('FAIL'), r.out)
  assert.ok(r.out.endsWith('ready to merge\n'), r.out)
  assert.ok(line(r.out, 'main CI').includes('run 43715117315 on 2eff170'), r.out)
})

void test('usage: a missing or non-numeric PR number exits 2 without calling the API', () => {
  for (const args of [[], ['abc'], ['1', '2']]) {
    const r = run(undefined, args)
    assert.equal(r.status, 2, args.join(' '))
    assert.ok(r.err.includes('usage'), r.err)
  }
})

void test('the PR is not open', () => {
  const r = run((routes) => {
    routes[ROUTE.pr].state = 'closed'
  })
  assertFailsOnly(r, 'pull request #6820', 'is closed')
})

for (const name of ['validate / validate-all', 'e2e-tauri-gate', 'dco']) {
  void test(`required check ${name}: failed, pending and missing all fail`, () => {
    const failed = run((routes) => setCheck(routes, name, { conclusion: 'failure' }))
    assertFailsOnly(failed, name, 'failure')

    const pending = run((routes) =>
      setCheck(routes, name, { status: 'in_progress', conclusion: null }),
    )
    assertFailsOnly(pending, name, 'in_progress')

    const missing = run((routes) => {
      const runs = routes[ROUTE.checks].check_runs
      runs.splice(
        runs.findIndex((c) => c.name === name),
        1,
      )
    })
    assertFailsOnly(missing, name, 'no check run')
  })
}

void test('required check: a check that merely contains the name does not count', () => {
  // The recording holds `stop-after-dco` (skipped) next to `dco`; with `dco` gone it must not stand in.
  const r = run((routes) => {
    const runs = routes[ROUTE.checks].check_runs
    runs.splice(
      runs.findIndex((c) => c.name === 'dco'),
      1,
    )
    assert.ok(runs.some((c) => c.name === 'stop-after-dco'))
  })
  assertFailsOnly(r, 'dco', 'no check run')
})

void test('review: approval of an older head sha fails', () => {
  const r = run((routes) => {
    for (const review of routes[ROUTE.reviews]) review.commit_id = 'a'.repeat(40)
  })
  assertFailsOnly(r, 'review', 'aaaaaaa')
})

void test('review: the newest review decides, not an earlier approval', () => {
  const r = run((routes) => {
    routes[ROUTE.reviews].push({
      state: 'CHANGES_REQUESTED',
      commit_id: HEAD,
      submitted_at: '2026-11-15T13:00:00Z',
      user: { login: 'agaric-reviewer[bot]' },
    })
  })
  assertFailsOnly(r, 'review', 'CHANGES_REQUESTED')
})

void test('review: none submitted fails; a pending review does not count', () => {
  const none = run((routes) => {
    routes[ROUTE.reviews] = []
  })
  assertFailsOnly(none, 'review', 'none submitted')

  const pending = run((routes) => {
    routes[ROUTE.reviews] = [
      { state: 'PENDING', commit_id: HEAD, submitted_at: null, user: { login: 'x' } },
    ]
  })
  assertFailsOnly(pending, 'review', 'none submitted')
})

void test('review: a Markdown-only diff needs none, one non-Markdown file brings the requirement back', () => {
  const markdownOnly = (routes) => {
    routes[ROUTE.files] = [
      { filename: 'docs/BUILD.md', status: 'modified', previous_filename: null },
    ]
    routes[ROUTE.reviews] = []
    routes[ROUTE.mainFiles] = { files: [] }
  }
  const skipped = run(markdownOnly)
  assert.equal(skipped.status, 0, skipped.out)
  assert.ok(line(skipped.out, 'review').includes('Markdown only'), skipped.out)

  const mixed = run((routes) => {
    markdownOnly(routes)
    routes[ROUTE.files].push({ filename: 'scripts/x.sh', status: 'added', previous_filename: null })
  })
  assertFailsOnly(mixed, 'review', 'none submitted')
})

void test('mergeable: dirty, unknown and draft fail; behind passes', () => {
  const dirty = run((routes) => {
    routes[ROUTE.pr].mergeable_state = 'dirty'
  })
  assertFailsOnly(dirty, 'mergeable', 'dirty')

  const unknown = run((routes) => {
    routes[ROUTE.pr].mergeable_state = 'unknown'
  })
  assertFailsOnly(unknown, 'mergeable', 'unknown')

  const draft = run((routes) => {
    routes[ROUTE.pr].draft = true
  })
  assertFailsOnly(draft, 'mergeable', 'draft')

  const behind = run((routes) => {
    routes[ROUTE.pr].mergeable_state = 'behind'
  })
  assert.equal(behind.status, 0, behind.out)
})

void test('main moved: a PR file that changed on main names the file; a rename counts under both names', () => {
  const shared = run((routes) => {
    routes[ROUTE.mainFiles].files.push({
      filename: 'src/components/block-tree/use-block-action-orchestration.ts',
      status: 'modified',
      previous_filename: null,
    })
  })
  assertFailsOnly(shared, 'main moved', '1 PR file(s)')
  assert.ok(
    shared.out.includes('        src/components/block-tree/use-block-action-orchestration.ts'),
    shared.out,
  )

  const renamed = run((routes) => {
    routes[ROUTE.mainFiles].files.push({
      filename: 'src/elsewhere/orchestration.ts',
      status: 'renamed',
      previous_filename: 'src/components/block-tree/use-block-action-orchestration.ts',
    })
  })
  assertFailsOnly(renamed, 'main moved', '1 PR file(s)')
})

void test('main CI: a failed newest run fails and is named', () => {
  const r = run((routes) => {
    Object.assign(routes[ROUTE.ci].workflow_runs[0], { conclusion: 'failure' })
  })
  assertFailsOnly(r, 'main CI', 'run 43715117315')
  assert.ok(line(r.out, 'main CI').includes('concluded failure'), r.out)
})

void test('main CI: an in-progress or cancelled run is skipped, the one before it decides', () => {
  const [newest, ...older] = GREEN[ROUTE.ci].workflow_runs
  const inProgress = { ...newest, id: 1, status: 'in_progress', conclusion: null }
  const cancelled = { ...newest, id: 2, conclusion: 'cancelled' }

  const green = run((routes) => {
    routes[ROUTE.ci].workflow_runs = [inProgress, cancelled, newest, ...older]
  })
  assert.equal(green.status, 0, green.out)
  assert.ok(line(green.out, 'main CI').includes(`run ${newest.id}`), green.out)

  // The newest run is still going and the last one that finished was red: that is the answer.
  const red = run((routes) => {
    routes[ROUTE.ci].workflow_runs = [
      inProgress,
      cancelled,
      { ...newest, id: 3, conclusion: 'failure' },
    ]
  })
  assertFailsOnly(red, 'main CI', 'run 3')
})

void test('main CI: no completed run at all fails', () => {
  const r = run((routes) => {
    routes[ROUTE.ci].workflow_runs = []
  })
  assertFailsOnly(r, 'main CI', 'no completed')
})

void test('fail closed: an endpoint that errors fails its check and never reads as nothing wrong', () => {
  const cases = [
    [ROUTE.checks, 'validate / validate-all', 'could not be read'],
    [ROUTE.reviews, 'review', 'could not be read'],
    [ROUTE.mainFiles, 'main moved', 'could not be read'],
    [ROUTE.ci, 'main CI', 'could not be read'],
  ]
  for (const [route, label, detail] of cases) {
    const r = run((routes) => {
      delete routes[route]
    })
    assert.equal(r.status, 1, `${label}\n${r.out}`)
    assert.ok(line(r.out, label).startsWith('FAIL'), r.out)
    assert.ok(r.out.includes(detail), r.out)
  }

  const noPr = run((routes) => {
    delete routes[ROUTE.pr]
  })
  assert.equal(noPr.status, 1, noPr.out)
  assert.ok(noPr.out.includes('could not be read'), noPr.out)
})
