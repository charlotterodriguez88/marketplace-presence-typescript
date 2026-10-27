# Node.js Property Document Presence with Loss-Tolerant Collaborative Cursor Fan-Out

Treat cursor coordinates as disposable hints, but treat room membership as recoverable state. For a Node.js property-management editor, that split is the most useful answer to the presence API question: fan out the newest cursor position without retries, attach a monotonically increasing sequence to each participant's updates, and rebuild the active roster from a snapshot after reconnect. Do not give every presence field the same delivery guarantee. It adds machinery, makes stale motion more likely to arrive, and solves the wrong problem.

**Short answer:** use one room per document, authorize entry on the server, keep durable lease text outside the presence path, and expose a small transport-neutral envelope. Cursor movement may be coalesced or dropped. Join, leave, and profile changes need an authoritative snapshot plus ordered deltas. This design keeps a notebook prototype honest because the evaluator can inject loss, duplication, and reordering before any transport or hosting choice becomes permanent.

## What presence API approach should a collaborative document use for cursors?

A leasing specialist moving a caret through a renewal clause can generate updates far faster than another person can interpret them. Delivering an old coordinate after a new one is actively harmful: the remote caret jumps backward. The correct guarantee is therefore "latest valid sample wins," not "every sample arrives." A sequence number lets the receiver reject late or duplicated samples without asking the server to retain a cursor history.

The roster is different. If an asset manager reconnects after switching networks, a missed `leave` can leave a phantom avatar beside the security-deposit paragraph. The client needs a fresh room snapshot, then deltas that are newer than that snapshot. This is convergence, not durable event replay.

That distinction is small. It carries the design.

| State | Example | Fan-out rule | Reconnect behavior |
|---|---|---|---|
| Document content | Lease clause text | Use the editor's document synchronization path | Reload or reconcile durable document state |
| Cursor hint | `{anchor: 418, head: 423}` | Coalesce; discard older sequence values | Publish the current cursor again |
| Member state | User display label and editing status | Ordered delta after authorization | Replace local roster with a snapshot |
| Typing hint | Editing `renewal_terms` | Expire locally if updates stop | Start absent; wait for a new hint |

Presence must never become the source of truth for the lease itself. A cursor can disappear with no business loss. A rent figure cannot.

## A transport-neutral presence core

The runnable example below models the receiver, where delivery bugs become visible. It is Python because the same reducer can sit in an eval harness and be exercised independently of a Node.js gateway. The wire contract is plain JSON, so the production service can implement the identical rules without importing editor or transport concerns.

```python
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Participant:
    sequence: int = -1
    cursor: dict[str, int] | None = None
    profile: dict[str, str] = field(default_factory=dict)


class PresenceRoom:
    def __init__(self, document_id: str) -> None:
        self.document_id = document_id
        self.snapshot_version = -1
        self.members: dict[str, Participant] = {}

    def replace_snapshot(self, message: dict[str, Any]) -> bool:
        version = int(message["version"])
        if version < self.snapshot_version:
            return False

        self.snapshot_version = version
        self.members = {
            item["participant_id"]: Participant(
                sequence=int(item["sequence"]),
                cursor=item.get("cursor"),
                profile=item.get("profile", {}),
            )
            for item in message["members"]
        }
        return True

    def apply_cursor(self, message: dict[str, Any]) -> bool:
        participant_id = message["participant_id"]
        participant = self.members.get(participant_id)
        if participant is None:
            return False

        sequence = int(message["sequence"])
        if sequence <= participant.sequence:
            return False

        participant.sequence = sequence
        participant.cursor = message["cursor"]
        return True


room = PresenceRoom("lease-4821")
room.replace_snapshot({
    "version": 17,
    "members": [{
        "participant_id": "reviewer-7",
        "sequence": 40,
        "cursor": {"anchor": 418, "head": 423},
        "profile": {"label": "Lease review"},
    }],
})

assert room.apply_cursor({
    "participant_id": "reviewer-7",
    "sequence": 42,
    "cursor": {"anchor": 501, "head": 501},
})
assert not room.apply_cursor({
    "participant_id": "reviewer-7",
    "sequence": 41,
    "cursor": {"anchor": 470, "head": 470},
})
assert room.members["reviewer-7"].cursor == {"anchor": 501, "head": 501}
```

The production envelope should also carry the room identifier and an authenticated participant identifier. Keep display labels out of authorization decisions; they are presentation data. At the gateway, verify that the session may view the property document before admitting it to the room, and derive the participant identifier from that session rather than trusting a client-supplied value.

There is an intentional omission: the reducer does not buffer updates for unknown participants. Buffering seems friendly in a notebook, but it creates a second partial roster with unclear lifetime rules. Reject the update, request or await a snapshot, and make that event visible in telemetry.

## How should fan-out failure change the API?

Expose delivery classes in behavior, even if they share a connection. Cursor messages get bounded queues and latest-value coalescing per participant. When a slow subscriber falls behind, replace its pending cursor sample. Roster changes advance a room version; if the client observes a gap, it stops applying roster deltas and asks for a snapshot. The API contract is clearer when recovery is a named state transition rather than a hopeful reconnect callback.

Backpressure is the pivotal test. An unbounded queue converts one slow browser tab into memory growth on the Node.js process. A bounded queue forces the team to define what may be dropped. For cursor traffic, that answer is straightforward. For membership, discard the incomplete delta stream and recover from authoritative current state.

Peer delivery can also be considered, but it changes the trust and network model. WebRTC defines peer connections and data channels, including configuration for ordered delivery and retransmission limits. Those controls fit ephemeral cursor samples, yet a property editor still needs signaling, access control, and a way to establish current membership. A central room service is often the simpler operational boundary when authorization and roster convergence matter more than avoiding a relay. This is a decision rule, not a product recommendation.

Teams arriving here through a search for a Liveblocks alternative should compare the contract before comparing SDK surfaces. The self-managed room approach has real limitations: the team owns connection draining, authorization enforcement, capacity tests, and snapshot recovery. It is a poor fit when nobody can operate a long-lived gateway or when the editor needs richer collaborative primitives immediately. A managed presence service may then be the more appropriate category, while peer data channels may suit small rooms that already have signaling and accept a different trust boundary. The trade-off is ownership of failure handling, not the number of client methods.

**Do not promise exactly-once cursor delivery.** The receiver cannot use that promise to make a stale coordinate useful. Spend the complexity budget on identity, snapshots, queue bounds, and observable recovery instead.

## Test the guarantee before choosing infrastructure

I would keep the evaluation deterministic and cheap enough to run on every change. Feed the reducer a snapshot at version 17, cursor sequences `40, 42, 41, 42`, and a roster-version gap. The expected result is one current cursor at sequence 42 plus a snapshot request after the gap. Then permute the cursor sequence order, duplicate samples, delete samples, and reconnect with an empty local room. No model call belongs in this loop, so there is no prompt cost and no fuzzy pass condition.

Four invariants do most of the work:

1. A participant's accepted cursor sequence never decreases.
2. A snapshot replaces local membership instead of merging unknown leftovers.
3. An unauthorized session never joins a document room or publishes presence.
4. Queue size remains bounded when one subscriber stops reading.

The first two are pure reducer tests. The third belongs at the gateway boundary. The fourth requires an integration test with a deliberately stalled consumer and a measurable queue limit. Also record rejected stale updates, snapshot requests, active room members, and dropped cursor samples. Aggregate them by room or service boundary, not by raw document content; lease text and resident details do not belong in presence logs.

Avoid turning update frequency into a magic constant copied from a demo. Measure end-to-end cursor age under representative room sizes and constrained clients, then choose coalescing and publish intervals against a user-visible target. The key metric is the age of the latest rendered sample, not the percentage of intermediate samples delivered.

## Ship the boundary, then watch recovery

Deploy the presence gateway independently from durable document writes, while preserving authorization at both boundaries. During rollout, cap room occupancy and per-connection queue memory, reject oversized envelopes, and include a schema version so incompatible clients fail visibly. A rolling deployment should be tested with clients reconnecting across old and new processes; the acceptance criterion is a clean snapshot replacement, not uninterrupted socket identity.

The operational checklist is short in prose. Confirm that expired sessions lose room access, stalled consumers cannot grow memory without bound, and a restarted process causes clients to rebuild their rosters. Alert on sustained snapshot-request growth because it can reveal ordering gaps or reconnect churn. Sample cursor-drop metrics without logging coordinates. Finally, run the loss-and-reordering evaluator in CI and again against the deployed gateway, since a correct reducer cannot compensate for an unbounded transport adapter.

The durable decision is the contract: disposable motion, convergent membership, and separate document state. With those guarantees written down, a Node.js team can replace a relay, gateway, or peer transport without rewriting editor behavior. More importantly, the property manager sees the latest collaborator position instead of a perfect history of where that cursor used to be.

## Sources

- https://www.w3.org/TR/webrtc/
