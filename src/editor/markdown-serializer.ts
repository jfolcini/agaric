/**
 * Markdown serializer for the agaric content format.
 *
 * Converts between ProseMirror JSON documents and a locked Markdown subset:
 *   blocks: # heading  ```code```
 *   marks:  **bold**  *italic*  `code`  [text](url)
 *   tokens: #[ULID]  [[ULID]]  ((ULID))
 *
 * Zero external dependencies. O(n) in both directions.
 *
 * This file is the public-API barrel for the split implementation.
 * Every existing
 * `import { ... } from '@/editor/markdown-serializer'` continues to resolve here.
 */
export * from '@/editor/markdown-common'
export * from '@/editor/markdown-parse'
export * from '@/editor/markdown-serialize'
