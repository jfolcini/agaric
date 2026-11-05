# Session 3573 — Evernote code blocks import as code

This picks up #6032's section 3 test gaps. A coverage survey checked each listed path against the tests:
- covered: ENEX `<hr>` and strike, a real-backend ENEX image resource, a real-backend JEX PDF resource and `:/id` note link;
- loses no text: ENEX `<ol>`, blockquote and duplicate titles, and plain-Markdown TOML/JSON front matter and setext headings, which are documented as read as text;
- has real-backend cover: the mocked `DataTab` paths, through `e2e-tauri/import-formats.e2e.ts`.

One path did lose content: Evernote's code block, a `<div>` styled `-en-codeblock:true` (`--en-codeblock` in Evernote 10) holding a `<div>` per line. Nothing read it, so each line became a paragraph, its indentation collapsed, and the shared grammar read a `#word` as a tag and a `TODO` line as a task.

- Fix: `transformEnmlDom` turns such a div into `<pre><code>` holding one line per child div, with nbsp as a space. Turndown's fence rule then fences it, lengthening the fence past any backtick run inside.
- Ran: `enex-import`, `jex-import` and the property tests (the two new cases shown red, and the fix falsified twice), typecheck, oxlint and oxfmt. The new e2e-tauri `it` in `import-formats.e2e.ts` was not run locally (it needs a native build).
