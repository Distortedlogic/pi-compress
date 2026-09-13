# pi-context-compress

`pi-context-compress` adds selected-range compression and context tools to Pi. It uses Pi public APIs and keeps session history append-only.

## Manual range compression

Run `/compress` in the interactive Pi TUI. You can add summary instructions after the command.

```text
/compress Keep exact commands and unresolved errors.
```

The command uses this sequence:

1. It waits for the session to become idle.
2. It shows legal start entries on the active context path.
3. It shows legal end entries from the selected start to the next protected boundary.
4. It asks you to confirm the normalized range and the current summary model.
5. It drafts a summary with the current model. A Pi loading view is active during this model call.
6. It opens the summary in an editor. You must approve non-empty text.
7. It revalidates the range, navigates without a Pi branch summary, adds the range tail, and adds the range marker.

The command does not delete or change the original entries. The original range stays on the previous branch at the source leaf shown in the range header. Use `/undo` to return to that source leaf.

## Direct API

Import `compressRange` from the public range-compression entry point. Tree navigation requires an `ExtensionCommandContext`, such as the context of an extension command.

```typescript
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compressRange } from "pi-context-compress/range-compression";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("compress-known-range", {
    description: "Compress a known active-context range",
    handler: async (args, ctx) => {
      const [startEntryId, endEntryId] = args.trim().split(/\s+/);
      if (!startEntryId || !endEntryId) {
        ctx.ui.notify("Usage: /compress-known-range <start-entry-id> <end-entry-id>", "warning");
        return;
      }

      const outcome = await compressRange(pi, ctx, {
        operationId: randomUUID(),
        startEntryId,
        endEntryId,
        review: false,
      });

      ctx.ui.notify(`Range compression: ${outcome.status}`, "info");
    },
  });
}
```

Automated callers must set `review: false` explicitly. Set `review: true` when a user must approve the generated summary.

See [PROTOCOL.md](PROTOCOL.md) for the generic in-process event protocol.

## Pi compaction

Pi's native `ctx.compact()` compacts the whole context. Selected-range compression does not call it.
