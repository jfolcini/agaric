# Session 1396 — the pairing timeout named a cause it could not know

A one-string fix, found while investigating #3952 rather than by working the issue as filed.

## What #3952 actually turned out to be

#3952 (`severity:critical`) says a first-ever pair is mDNS-only, no fallback exists, and
three docs claim one does. Investigation found it **half-stale**:

- **The doc half was already fixed.** Commit `a6ad52914` (#4023) corrected all three claims
  the day after #3952 was filed, plus three more it did not name — including
  `status.manualIpHint`, which rendered directly above the Pair button. #3952 has no
  comments, so nothing recorded that this had happened.
- **The code half is still true**, and duplicates #4037, which carries strictly more
  analysis (version negotiation, QR size, privacy, staleness) and independently rules out
  the third option #3952 proposed.
- **`severity:critical` did not survive scrutiny.** That label means *systemic; blocks or
  undermines the quality gate*. No test is wrong, no invariant is violated, and blast
  radius on a normal home LAN is zero. Re-labelled `severity:high`, and the issue was
  re-scoped in a comment rather than worked as written.

## The defect that was actually worth fixing is not in the issue

#3952 assumes the `MdnsDisabled` event covers this case. It does not. That event fires only
when `MdnsService::new()` returns `Err` — an unusable socket (iOS sandbox, missing Android
multicast lock).

On the networks the issue is really about — AP client isolation, guest WLAN,
multicast-filtering corporate AP, two subnets — **the socket binds fine and the packets are
simply not delivered**. So no `MdnsDisabled` fires, `device.mdnsDisabledHint` never renders,
and the one message that would explain the situation never appears.

What the user gets instead, after the full 300-second `PAIRING_TIMEOUT_SECONDS`:

> No response from the other device. **The pairing code may have expired.**

The code did not expire. That string asserts a single cause the timeout path cannot
distinguish — it fires whether the code expired *or* the two devices never discovered each
other. A user told the code expired does the rational thing and retries with a fresh code,
which fails identically, for ever.

**A confidently wrong diagnosis is worse than a vague one**, because it forecloses the
user's search. The message now names both causes and points at the one they can act on:

> No response from the other device. Either the pairing code expired, or the two devices
> could not find each other on this network — some guest and corporate WiFi networks block
> the discovery pairing needs.

## Test

The existing test pinned the old sentence verbatim, so it had to change. It now pins **both
halves** and explicitly rejects the old single-cause wording, because an assertion on "no
response" alone would let it back in.

Falsified: reverting the string alone reddens
`surfaces a timeout with a retry path when the TTL elapses with no success or rejection`.

## Not done here

The transport gap itself belongs to #4037. One measurement it flags as unresolved is worth
taking before choosing between its options: does a dial with an `EndpointId` and zero direct
addresses fail fast, or hang to `CONNECT_TIMEOUT`? No test asserts it, and the answer shapes
the error handling in every option.
