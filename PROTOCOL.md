# Compression interface v1

Channels:

- Request: `pi-context-compress/v1/request`
- Result: `pi-context-compress/v1/result`

The exported schemas in `packages/extension/src/protocol.ts` define the data contract. No caller needs a private module import.

## Request transport

Emit `{ request, context }` on the request channel. `context` is the public Pi command context for the requested session. It is a temporary capability for Pi UI and tree navigation. Do not serialize or persist it.

`request` contains `v: 1`, `requestId`, `sessionId`, `operationId`, `runId`, `action`, and `batch`. The batch contains only `planId`, `batchId`, `structuralRevision`, `fileRevision`, and `bitmap`. Hash fields are full lowercase SHA-256 values.

The service handles only sessions it has observed through Pi lifecycle events. Requests with invalid schemas or unknown session IDs are ignored. A client must validate requests and bound its service-availability wait.

## Operations

| Action | Behavior |
| --- | --- |
| `prepare` | Requires `anchorEntryId` and `lastSettledEntryId`. Selects a valid execution range after the queued task message. Drafts a summary. `review` defaults to `true`. Returns `prepared` or `cancelled` without session mutation. |
| `apply` | Requires the same operation, run, and batch snapshot as preparation. Rechecks the session range and applies the saved summary. |
| `cancel` | Drops a prepared operation. A mutation already in progress returns `busy`. An applied operation returns `applied`; cancellation does not undo it. |
| `status` | Reports an applied marker for the run, plan, and batch, or the prepared state for the operation. Otherwise returns `missing`. |

Results repeat `requestId`, `sessionId`, and `operationId`. Status is `prepared`, `applied`, `cancelled`, `missing`, or `failed`. Failures use fixed codes, not source text or file paths. Applied results include the durable compression details.

Duplicate preparation and apply requests do not repeat the review or mutation. Applied markers are read from the active branch. A new process can report an already applied batch even if the caller lost the last operation ID. Prepared summaries are held only in memory; after restart, prepare and review again if no applied marker exists.

## Ownership

The caller must revalidate its task snapshot after review and before `apply`. Compression does not know whether a task was completed successfully and does not change task checkboxes.

Apply preserves the exact queued task message and approved summary on the active branch. It retains the original entries off that branch. Markers store IDs, revisions, bitmap, range boundaries, and a source hash, not future tasks or plan paths. `/undo` recognizes both these markers and the prior Workstream compression markers.
