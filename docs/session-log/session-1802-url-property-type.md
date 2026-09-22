# Session 1802 — a `url` property value type (#4710)

Maintainer-approved this session, migration included. What shipped is the
issue's own recommended shape: a `url` declaration is stored and edited as
text, nothing is validated on write, and the link is decided at render time
by whether the value parses as `http`, `https` or `mailto`. No text→url
conversion path; a user recreates the property.

**Backend.** Migration 0120 recreates `property_definitions` in the 0043
shape (STRICT, data copied verbatim) with `'url'` in the CHECK set — SQLite
cannot alter a CHECK. `declared_type_admits_shape` and the engine's
`validate_declared_type` both say `url` admits `text` only (not `ref`, unlike
`text` and `select`); their agreement is what keeps a declared key writable,
and the `MATRIX` test pins it arm for arm. Registry import and the Loro
projection route `url` through the existing text fall-through; only their
enumerating comments changed. The conformance fixture gains a `url`
declaration and a text value under it, backend-authored; the mock admits the
same vocabulary with the same rejection message.

**Frontend, and the one decision the builders could not make.** The inline
chip carries `{ key, value }` and no definition, so "render a `url`-declared
value as a link" cannot be implemented at the chip without a new, invalidated
definitions cache threaded through four files. The ladder says no: a value
that parses as http/https/mailto is a link whatever its declared type. So the
chip's value zone is byte-identical to before (click-to-edit stays), and a
linkable value gets a trailing open-link `IconButton` that hands the value to
`openUrl` and stops the click before `StaticBlock` moves the roving editor.
`isLinkablePropertyUrl` is an allowlist on the parsed protocol; `javascript:`,
`data:`, `file:` and a control-char-obfuscated `java\tscript:` all parse to a
protocol outside it. A first draft made the value itself the link, which took
away editing for every URL value; the rework kept the value as the edit
trigger. `docs/features/properties.md` and the feature map say the decision
is made on the value.

**Review.** Five trims: a redundant Rust test that had also hijacked the
4399 matrix test's doc comment; a `.trim()` the WHATWG parser already does; a
chip comment that named the wrong consequence of a bubbled click (it moves
the roving editor, it does not open the value editor); a restating assertion
and a test nothing reddens. The reviewer's own falsifications: dropping
`'url'` from the migration's CHECK reddens the 0120 test; deleting
`stopPropagation` reddens the row-click test; widening the protocol regex
reddens six scheme cases.

**Verified.** Rust targeted set 577 passed (property, migration, url,
conformance); full frontend suite in two shards, 838 files, 19,303 passed,
51 skipped, 1 expected fail; mock conformance, coverage and drift suites 976
passed; `oxlint`, `oxfmt`, `tsc -b`, the migration-coverage and
migration→mock guards green. The push verifier runs the full Rust suite.

**The reviewer's blocker, and why every check above missed it.** Adding a
`url` property from either add path failed with a toast and no row: the
three add sites short-circuit to a local draft row only for `text` and
`select` (the backend refuses an empty `value_text`), and `url` fell through
to an empty init `set_property`. The definition was creatable and then
unusable. The three literal conditions are now one exported
`DRAFT_ROW_VALUE_TYPES` set, and a `PagePropertyTable` test drives the
create-def flow with `url` and asserts a draft row and no `set_property`;
dropping `url` from the set reddens it. Nothing earlier could have caught
it: the chip tests render a value that already exists, the conformance
fixture sets a non-empty value, and no test walked the add flow with a new
type. The same push trims the value before `openUrl`, since the parser
tolerates surrounding whitespace and the shell plugin's URL scope does not.
