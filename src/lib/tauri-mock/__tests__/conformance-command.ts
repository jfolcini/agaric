/**
 * #4670 — the MUTATING-command leg of the #763 conformance harness (TS /
 * tauri-mock side). Twin of
 * `src-tauri/tests/command_integration/conformance_command.rs`, which carries
 * the rationale.
 *
 * A fixture op carrying `"via": "command"` is replayed through the mock's
 * handler like any other, but its RETURN VALUE — or its refusal, the
 * `AppErrorKind` plus the `ValidationCode` — is projected into the same row
 * tokens the Rust runner recorded in the fixture's `expected_ops`. `op_refs` is
 * never read (the two stacks' device ids differ); a list-valued field becomes
 * one `<field>-><id>` token per element.
 *
 * Keep {@link RETURN_SHAPE} in lockstep with the Rust `RETURN_SHAPE`, exactly
 * as `WIRE` in `conformance-query.ts` mirrors `run_step`.
 */

import { idToken } from '@/lib/tauri-mock/__tests__/conformance-query'
import { dispatch } from '@/lib/tauri-mock/handlers'

export interface CommandOpStep {
  command: string
  args: Record<string, unknown>
  /** Opt this op into the command leg. The only value is `"command"`. */
  via?: 'command'
  /** Required with `via`; unique within the fixture. */
  name?: string
  /** The `AppErrorKind` wire string the command is expected to refuse with. */
  expect_error?: string
  /** The `ValidationCode` the refusal carries; `expect_error: "validation"` only. */
  expect_code?: string
  comment?: string
}

export interface CommandRecord {
  name: string
  returns: string[]
  error: string | null
  code: string | null
}

interface ReturnShape {
  idKey: string
  attrs: readonly string[]
  lists: readonly string[]
}

/** MUST match `RETURN_SHAPE` in the Rust twin. */
const RETURN_SHAPE: Readonly<Record<string, ReturnShape>> = {
  delete_block: {
    idKey: 'block_id',
    attrs: ['deleted_at', 'descendants_affected'],
    lists: ['affected_page_ids'],
  },
  purge_block: { idKey: 'block_id', attrs: ['purged_count'], lists: [] },
}

/** Mirror of `project_return`: the row token, then one arrow per list element. */
export function projectReturn(command: string, response: unknown): string[] {
  const shape = RETURN_SHAPE[command]
  if (!shape) {
    throw new Error(
      `conformance op '${command}' has no RETURN_SHAPE entry in the TS runner (add it here ` +
        `and the matching arm in conformance_command.rs)`,
    )
  }
  const row = (response ?? {}) as Record<string, unknown>
  const out = [idToken(row, shape.idKey, shape.attrs)]
  for (const field of shape.lists) {
    const ids = row[field]
    if (!Array.isArray(ids)) continue
    for (const id of ids) out.push(`${field}->${typeof id === 'string' ? id : '<not-a-string>'}`)
  }
  return out
}

/** A declaration key as the wire string it must be; `null` when absent. */
function declared(
  at: string,
  step: CommandOpStep,
  key: 'expect_error' | 'expect_code',
): string | null {
  const raw: unknown = (step as unknown as Record<string, unknown>)[key]
  if (raw == null) return null
  if (typeof raw !== 'string') {
    throw new Error(`${at}: \`${key}\` must be a wire string, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/**
 * The #3946 declaration discipline over a command outcome, mirror of
 * `check_declaration` in the Rust twin: both arms or neither, for the kind AND
 * for the `ValidationCode`.
 */
export function checkDeclaration(
  at: string,
  declaredKind: string | null,
  declaredCode: string | null,
  actualKind: string | null,
  actualCode: string | null,
): void {
  if (declaredKind === null && actualKind !== null) {
    throw new Error(
      `${at}: the command REFUSED with \`${actualKind}\`, and the op did not declare it. ` +
        `Add "expect_error": "${actualKind}" plus a "comment", or correct the op's args.`,
    )
  }
  if (declaredKind !== null && actualKind === null) {
    throw new Error(
      `${at}: the op declares "expect_error": "${declaredKind}" but the command SUCCEEDED.`,
    )
  }
  if (declaredKind !== null && actualKind !== null && declaredKind !== actualKind) {
    throw new Error(
      `${at}: the op declares "expect_error": "${declaredKind}" but the command refused ` +
        `with \`${actualKind}\`.`,
    )
  }
  if (declaredCode !== null && declaredKind !== 'validation') {
    throw new Error(
      `${at}: \`expect_code\` is a ValidationCode, so it accompanies "expect_error": ` +
        `"validation" only`,
    )
  }
  if (declaredCode === null && actualCode !== null) {
    throw new Error(
      `${at}: the refusal carries ValidationCode \`${actualCode}\`, and the op did not ` +
        `declare it. Add "expect_code": "${actualCode}".`,
    )
  }
  if (declaredCode !== null && actualCode === null) {
    throw new Error(
      `${at}: the op declares "expect_code": "${declaredCode}" but the refusal carries no code.`,
    )
  }
  if (declaredCode !== null && actualCode !== null && declaredCode !== actualCode) {
    throw new Error(
      `${at}: the op declares "expect_code": "${declaredCode}" but the refusal carries ` +
        `\`${actualCode}\`.`,
    )
  }
}

/**
 * Dispatch one `via: "command"` op, enforce its declarations, and build its
 * record with raw ids (the caller relabels once the canonical order is final).
 *
 * Only an `AppError`-shaped throw counts as a refusal — the discipline of
 * `runQuerySteps`: a bare `Error` is a MOCK BUG and re-throws.
 */
export function runCommandOp(
  step: CommandOpStep,
  args: Record<string, unknown>,
  fixtureName: string,
): CommandRecord {
  if (typeof step.name !== 'string') {
    throw new Error(
      `fixture '${fixtureName}': a \`via: "command"\` op (command '${step.command}') must ` +
        `carry a string \`name\`, or its record cannot be named in any diff`,
    )
  }
  const at = `fixture '${fixtureName}' op '${step.name}' (command '${step.command}')`
  let returns: string[] = []
  let error: string | null = null
  let code: string | null = null
  try {
    returns = projectReturn(step.command, dispatch(step.command, args))
  } catch (err) {
    const rejection = err as Record<string, unknown> | null
    const kind = rejection?.['kind']
    if (typeof kind !== 'string') throw err
    error = kind
    const raw = rejection?.['code']
    code = typeof raw === 'string' ? raw : null
  }
  checkDeclaration(
    at,
    declared(at, step, 'expect_error'),
    declared(at, step, 'expect_code'),
    error,
    code,
  )
  return { name: step.name, returns, error, code }
}
