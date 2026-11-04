# Session 3333 — BibTeX braces, accents and biblatex fields decode on import

#6032 batch A, on the maintainer's Q7 answers (2026-11-04). The BibTeX
importer kept case-protection braces and `~` literally with no warning, ignored
biblatex `journaltitle` and `date` (so Zotero and Better BibLaTeX exports lost
their journal and year, and the page title fell back to the citation key),
ignored `booktitle` (an `@inproceedings` lost the venue its CSL twin keeps as
`container-title`), left `\v{c}` and `\'{\i}` literal, and titled a corporate
author's page by its last word ("Organization} 2024").

`decode_latex` now drops unescaped braces, maps `~` to a space and NFC-normalises
the field. Accents are combining marks over any base, all fifteen marks, `\i`
and `\j` read as `i` and `j`; this replaced the fixed `accented` table. An
unknown command is still kept literal and flagged, with all its braced
arguments: review caught `\href{u}{t}` losing its second pair of braces. Field
precedence is order-independent: `journal` over `journaltitle` over
`booktitle`, `year` over `date`, a date giving its leading four-digit year. A
wholly braced BibTeX author or a CSL `literal` one is one name whose family is
the whole name.

Three unit assertions that pinned the kept braces changed their expected values
with the decision (`bibtex_parses_all_mapped_fields`' title,
`bibtex_author_split_is_brace_aware_and_case_insensitive`'s first name,
`latex_unknown_commands_kept_literal_and_flagged`'s `{DNA}`).

Ran: nextest over the bib, latex and csl filters and the whole engine package,
clippy `--workspace --all-targets`, the `SQLX_OFFLINE` check, `cargo doc`, the
fuzz target's check, both prek stages. The new e2e-tauri case runs in CI.
