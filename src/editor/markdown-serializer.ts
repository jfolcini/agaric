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
 * This file is the public-API barrel for the split implementation
 * (REVIEW-LATER MAINT-117). Every existing
 * `import { ... } from './markdown-serializer'` continues to resolve here.
 */
export * from './markdown-common'
export * from './markdown-parse'
export * from './markdown-serialize'
