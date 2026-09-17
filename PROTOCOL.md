# Compression Interfaces

## Direct completed-batch operation

Use `compressCompletedBatch` for completed task batches. It is a direct in-process function call. It does not use request or result event channels.

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { compressCompletedBatch } from "pi-compress/range-compression";
import type { BatchSnapshot } from "pi-compress/protocol";

async function compressBatch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  batch: BatchSnapshot,
  anchorEntryId: string,
  lastSettledEntryId: string,
) {
  return compressCompletedBatch(pi, ctx, {
    runId: "task-run-id",
    batch,
    operationId: "compression-operation-id",
    anchorEntryId,
    lastSettledEntryId,
    review: false,
  });
}
```

Set `review: true` to open the generated summary in the editor before apply. The function runs batch range preparation, summary generation, optional review, and apply in order.

The promise resolves with `CompressionDetails` after a successful apply. It resolves with `undefined` when the user cancels review or when session navigation is cancelled. Model, range-validation, session-change, navigation, and persistence errors reject the promise with the same error object. The function does not convert these errors to status objects or failure codes.

Callers must use the real `ExtensionCommandContext` from an extension command. They must treat `undefined` as cancellation and decide how to report or stop their operation. They can catch a rejection for cleanup, but they must rethrow the same value when the failure must remain visible.

## Range compression event service

The generic range-compression protocol uses Pi's in-process event bus. Load the main `pi-compress` extension before you use this protocol.

### Channels

- Request: `pi-compress/v1/range/request`
- Result: `pi-compress/v1/range/result`

Import the channel constants and schemas from `pi-compress/protocol`.

### Transport

The event value has this shape:

```typescript
{
  request: RangeCompressionRequest;
  context: ExtensionCommandContext;
}
```

This transport is in-process. `context` contains functions and is not part of the serializable request schema. Do not send this transport through JSON, RPC, or a network boundary.

Range application navigates the session tree. You must supply a real `ExtensionCommandContext`. Extension command handlers receive this context. Normal event handlers receive only `ExtensionContext`. Do not cast that context. A normal event handler must queue or invoke its own extension command first. The command handler can then emit the request with its command context.

### Requests

All request objects are exact. Extra fields fail validation.

A prepare request has these fields:

```typescript
{
  v: 1;
  action: "prepare";
  requestId: string;
  sessionId: string;
  operationId: string;
  startEntryId: string;
  endEntryId: string;
  review: boolean;
  anchorEntryId?: string;
  instructions?: string;
}
```

`review` is required. Automated callers must set `review: false` explicitly.

Apply, cancel, and status requests have this shape:

```typescript
{
  v: 1;
  action: "apply" | "cancel" | "status";
  requestId: string;
  sessionId: string;
  operationId: string;
}
```

Use a new `requestId` for correlation. Keep the same `operationId` for all requests for one range operation.

### Results

Every accepted request produces one result with the same request, session, and operation identifiers.

```typescript
{
  v: 1;
  requestId: string;
  sessionId: string;
  operationId: string;
  status: "prepared" | "applied" | "cancelled" | "missing" | "failed";
}
```

Only an `applied` result has `details: CtreeRangeCompactData`. Only a `failed` result has a failure `code`.

### Event-bus example

Subscribe to the result channel before you emit the request.

```typescript
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  RANGE_COMPRESSION_REQUEST,
  RANGE_COMPRESSION_RESULT,
  RangeCompressionResultSchema,
  type RangeCompressionResult,
  type RangeCompressionTransport,
} from "pi-compress/protocol";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prepare-range", {
    description: "Prepare a selected range through the event service",
    handler: async (args, ctx) => {
      const [startEntryId, endEntryId] = args.trim().split(/\s+/);
      if (!startEntryId || !endEntryId) return;

      const requestId = randomUUID();
      const operationId = randomUUID();

      await new Promise<void>((resolve) => {
        const unsubscribe = pi.events.on(RANGE_COMPRESSION_RESULT, (value) => {
          if (!Value.Check(RangeCompressionResultSchema, value)) return;
          const result = value as RangeCompressionResult;
          if (result.requestId !== requestId) return;

          unsubscribe();
          ctx.ui.notify(`Range preparation: ${result.status}`, "info");
          resolve();
        });

        const transport: RangeCompressionTransport = {
          request: {
            v: 1,
            action: "prepare",
            requestId,
            sessionId: ctx.sessionManager.getSessionId(),
            operationId,
            startEntryId,
            endEntryId,
            review: false,
          },
          context: ctx,
        };

        pi.events.emit(RANGE_COMPRESSION_REQUEST, transport);
      });
    },
  });
}
```

Send a later `apply` request with the same `sessionId` and `operationId`. Subscribe with its new `requestId` before you emit it.

### Idempotency and cancellation

Prepared range work is keyed by `sessionId:operationId`.

- An identical in-flight request, without its `requestId`, receives the prior outcome.
- A different prepare request for the same operation key fails with `operation_conflict`.
- A repeated request for an operation that is already on the active branch returns `applied` with its stored details.
- A cancel request aborts pending summary generation and removes prepared work.
- Session shutdown aborts pending preparation and removes its service state.
- An apply mutation cannot be cancelled after it starts. A concurrent mutation fails with `busy`.

### Range safety

The service uses the same range planner as `/compress` and direct completed-batch compression.

A complete assistant tool-call group and its contiguous tool results form one atomic candidate. A range cannot start, end, or cross these protected boundaries:

- context-inert metadata: custom entries, model changes, thinking-level changes, labels, and session information
- compaction entries and branch summaries
- decision records
- incomplete user turns
- incomplete tool-call groups
- orphan tool results
- entries that have no preceding anchor

Before tree navigation, the service checks the session ID, source leaf, selected entry IDs, continuation entry IDs, and source hash again. It then calls `ctx.navigateTree(..., { summarize: false })`. It adds the summary tail and marker after successful navigation. It never edits a session JSONL file.

The original entries stay on the previous branch. The stored source leaf supports append-only recovery.

### Failure codes

| Code | Meaning |
| --- | --- |
| `invalid_request` | The request or current session state cannot start the operation. |
| `operation_conflict` | The operation key already has different prepare data. |
| `session_changed` | The supplied session or planned source state changed. |
| `compression_failed` | Summary generation or range application failed. |
| `not_prepared` | Apply was requested before successful preparation. |
| `busy` | Another request or session mutation is in progress. |

### Pi compaction

Pi's native `ctx.compact()` performs whole-context compaction. This selected-range protocol does not use it.
