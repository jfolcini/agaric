import { describe, expect, it } from 'vitest'

import type { BugReport } from '@/lib/bindings'
import { formatOpLog, formatReportBody } from '@/lib/bug-report'

const METADATA: BugReport = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: '12345678-9abc-4def-8123-456789abcdef',
  recent_errors: [],
  retry_queue: null,
}

const OP_LOG: NonNullable<BugReport['op_log']> = {
  by_op_type: [
    { op_type: 'create_block', rows: 4, payload_bytes: 512 },
    { op_type: 'edit_block', rows: 900, payload_bytes: 5_242_880 },
  ],
  table_bytes: 8192,
  index_bytes: 4096,
}

describe('formatOpLog (#6563)', () => {
  it('puts the table and index sizes first, then op types by payload bytes', () => {
    expect(formatOpLog(OP_LOG)).toBe(
      'table 8.0 KB, indexes 4.0 KB; edit_block 900 rows / 5.0 MB, create_block 4 rows / 512 B',
    )
  })

  it('says empty for an op log with no rows', () => {
    expect(formatOpLog({ by_op_type: [], table_bytes: 4096, index_bytes: 0 })).toBe(
      'table 4.0 KB, indexes 0 B; empty',
    )
  })
})

describe('formatReportBody op-log line (#6563)', () => {
  it('renders the line when the backend reported the op log', () => {
    const body = formatReportBody({ metadata: { ...METADATA, op_log: OP_LOG }, description: '' })
    expect(body).toContain(`- **Op log:** ${formatOpLog(OP_LOG)}`)
  })

  it('omits the line when the op log is absent', () => {
    expect(formatReportBody({ metadata: METADATA, description: '' })).not.toContain('Op log')
  })
})
