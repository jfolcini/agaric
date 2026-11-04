# Session 3392 — review notes from the #6032 import PRs

The follow-up for the non-blocking review notes on #6275, #6276, #6286, #6288,
#6289 and #6305 (#6032 batches A, B and C and items N3, N4, N6, N7 and N10).
Only one note earned a change.

#6289's reviewer: a CSL author with a `family` and no `given`, which some
exporters write for an institution (`{"family": "World Health Organization"}`),
still titled its page by the last word, "Organization 2024", because only a
`literal` author was taken as one name. A CSL `family` is the whole family name,
so the family-only arm now sets the same flag; `{"family": "de la Cruz"}` keeps
its particles too.

Left as they are, with the reason: the diff-scoped mutation survivors on
`enex-import.ts` and `vault-import.ts` were triaged as equivalent in review; a
link to an `.org` file whose `#+TITLE` differs from its file name, and a
`[[Name]]` link to such a file, still miss its page (documented; resolving it
needs the frontend to send the title it renames the page to).

Ran: nextest over the bib, csl and latex filters (55), clippy `--workspace
--all-targets`, `cargo doc`; the new test was red first and red again with the
fix reverted.
