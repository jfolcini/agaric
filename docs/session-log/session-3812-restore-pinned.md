# Session 3812 — the restore is pinned (#6277 G6)

Set out to build #6277 G6: T2, a property test that a ZIP export restored by
a folder import is the space it came from, and T3, the same through the real
backend and the UI's export and import.

What shipped:

- T2, `src-tauri/tests/commands/export_import_proptest.rs`. Each case seeds a
  space of two or three pages through the commands: front matter (a typed
  property, an alias, a tag, `template`), typed, multi-line and ref block
  properties, list styles, tasks with their done dates, block refs and embeds
  across pages, page links, inline and block-scoped files, and the titles
  `a:b` and `Ns/Beta`. It exports every page, drops the title line and points
  each `attachment:<id>` at `assets/<id>/<name>` as the ZIP does, restores the
  definitions as `.agaric/space.json` does, and imports the notes as one folder
  pick ending in `link_import_anchors`. The two spaces must have the same
  snapshot with every id renamed by title and index path, and the restore's
  export must equal the export. 16 cases per run.
- The one defect it found: a ref-typed value naming a note the same folder
  pick imports later was kept as text, so a restore lost every ref whose
  target sorted after the page holding it. `create_note_targets` now makes
  that note's page, as a link to it does, and the note adopts it (#5160 D12).
  A title no note of the pick has still names no page (D11). Pinned by
  `a_folder_ref_value_naming_a_later_note_names_its_page`.
- T3, `e2e-tauri/export-restore.e2e.ts`: a nested page under a namespace with
  a typed property, a dated property, a file and a done task, a template page
  titled with a `:`, and a journal day, exported from Personal through the
  Data tab, unzipped in Node and folder-picked into Work. After navigating
  away and back, each page's tree (depth, text, task state, the kept
  properties and file names) and the definitions' types are equal.
- The #6496 review rename: `read_blocks` destructures `(foreign, file)`.

Shown red: T2 by turning off the ref fix and by dropping `template` from
`FILE_KEYS`; the focused test by turning off the ref fix; T3 by dropping
`template` from `FILE_KEYS`, run alone with `just e2e-real`.

Traps:

- `load_page_subtree` orders by position across the whole page, not depth
  first, so T3 builds the tree from parent links.
- A 200-case local T2 run passes nextest's 120 s limit; 90 cases ran in 46 s
  and passed.
- The real-backend lane runs here after `apt-get install webkit2gtk-driver
  xvfb openbox xdotool dbus` and `cargo install tauri-driver --locked`.
