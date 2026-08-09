# Session 1281 — the leak was real, the framing was too loud

**Date:** 2026-08-09
**Issues:** #3318 (done); #3684 (filed)
**PRs:** #3685

A single-issue session. #3318 asked for a threat-model entry covering the link-preview
metadata fetch, on the grounds that it is an un-gated outbound request to a host the
user's content chooses. The finding is correct and the entry is now written. What the
session mostly produced, though, is a narrower and better-evidenced version of the
finding than the issue's — because the issue reasoned from the call sites and the code
reasons from the cache.

## What the issue got right

Everything structural. `useLinkPreview.openPreview` really does read an `href` off
whatever `.external-link` the pointer entered and, 150 ms later, hand it to
`fetch_link_metadata`, which reaches `fetch_metadata` and opens a real socket to that
host. The `href` really can come from a note the user never wrote — synced from another
device, imported from a vault, pasted from a web page. No preference gates it: there is
no `link-preview` key in `src/lib/preferences.ts` and no control under
`src/components/settings/`. The threat model really did enumerate two external services
and stop there, and Claim 1 really did list two off-device flows.

It also spotted the right shape for the fix. `src/lib/external-image-policy.ts` already
answers this exact question for images — three states, privacy-first default `click`,
per-host allowlist — and the parallel is close enough that inventing a second vocabulary
would be the wrong move. Filed as #3684.

## What reading the code changed

**The read-receipt is one-shot, not per-view.** The hover path calls `get_link_metadata`
before it calls `fetchLinkMetadata`, and a cached row of *any* age short-circuits the
fetch; eviction happens only on startup, only for `auth_required = 0` rows, and only past
30 days (`cleanup_stale(&write_pool, 30)`). So a host learns the *first* hover on a given
URL precisely, and every subsequent one not at all — at most one beacon per URL per
device per ~30 days. The issue's "a precise 'this specific note was being read at this
timestamp' read-receipt" is true exactly once and then goes quiet. That is still a
finding; it is a different finding from the one the issue describes, and a threat model
that overstated it would be the kind of document reviewers learn to discount.

**There is no fingerprint to speak of.** The issue lists "TLS/User-Agent fingerprint".
The User-Agent is the fixed literal `Agaric/1.0` — no version, no platform. And there is
no cookie jar at all, not merely an empty one: `reqwest` is declared
`default-features = false` in `src-tauri/Cargo.toml` without the `cookies` feature, so
the type that would hold a cookie is not compiled in. The disclosed set is the connecting
IP, the existence of that URL in this vault, and one timestamp. Naming it that precisely
is worth more than the adjective.

**The second hop is already gated, and that is the actual finding.** `favicon_url` comes
back from the fetched page, so it is a *second* attacker-chosen host — and
`LinkPreviewTooltip` already withholds it from `<img src>` until the external-image
policy and per-host allowlist permit it. So the hop to a host the fetched page names is
behind a privacy-first preference, while the hop to the host the note names is behind
nothing. That asymmetry is not a decision anyone made; it is where #1492 stopped. Stating
the finding that way makes #3684 obvious rather than arguable.

**Two triggers the issue does not mention.** The handler is bound to `focusin`, not only
`pointerenter`, so Tab-navigating a document and resting on a link fires the same path
with no pointer involved. And it matches statically-rendered
`<span class="external-link" data-href>` as well as editor `<a>` elements, so it is not
confined to the editing surface.

## What the entry became

Not a bullet. The document's own maintenance rule says a new outbound edge gets a
boundary section first and the `SECURITY.md` prose follows, so the fetch is now **B5**,
with a six-row STRIDE table, an edge in the data-flow diagram, and an entry in Open
questions. Four rows are Mitigated — the #2661 SSRF stack, the parse-don't-render
response handling, the streaming body cap, and the device-local non-synced cache — and
that is the point of the table: the boundary is mostly closed, and writing down *which
parts* is what makes the one open row legible.

Two corrections fell out. B4's preamble asserted that the updater "is the only outbound
network call the application makes that is **not** scoped to LAN sync or to a
user-initiated cloud integration", which has been false since the link preview shipped;
it now claims only that the updater is the only call to a *maintainer-chosen* endpoint.
And Claim 1's evidence bullet now says explicitly that B5 is not a second bounded
exception to `SECURITY.md`'s no-outbound-calls rule — by that rule it is a finding, which
is why it is #3684 and not a new paragraph in the exception list. `SECURITY.md` is
unchanged and stays correct as worded; it only needs revisiting if #3684 is closed
won't-fix.
