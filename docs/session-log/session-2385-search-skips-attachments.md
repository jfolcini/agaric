# Session 2385 — Docs: search does not look inside attachments

On 2026-10-17 the maintainer reshaped #5364 and #5410:
- a transcript is a Markdown attachment (`.transcript.md`) on the audio's block;
- a summary is page content or a `.summary.md` attachment;
- meetings, transcripts and summaries are produced outside Agaric and uploaded
  by an agent.

`fts_blocks` indexes block content only, so the words of a transcript
attachment are not found by search. The maintainer chose to document that
limit for now rather than index attachment text.

`docs/SEARCH.md` says so where it introduces Find across pages, and
`docs/architecture/search.md` says so in the FTS pipeline section. No code
changed; no suites ran.

Dictation and read-aloud through each OS went to #5745. A GNOME
speech extension and an outside meeting pipeline were drafted as ideas for the
maintainer's own notes.
