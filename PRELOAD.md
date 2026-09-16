File: package.json

{
	"name": "pi-context-compress",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"description": "Independent Pi session range compression and context tools.",
	"license": "MIT",
	"engines": {
		"node": ">=22.19.0"
	},
	"exports": {
		".": "./src/index.ts",
		"./protocol": "./src/protocol.ts",
		"./range-compression": "./src/range-compression.ts"
	},
	"pi": {
		"extensions": ["./src/index.ts"]
	},
	"files": ["src", "README.md", "PROTOCOL.md"],
	"scripts": {
		"test": "vitest run",
		"check": "npm run typecheck && npm run lint",
		"typecheck": "tsc --noEmit",
		"lint": "biome check .",
		"format": "biome check --write .",
		"knip": "knip"
	},
	"dependencies": {
		"minimatch": "10.2.6",
		"yargs-parser": "22.0.0"
	},
	"peerDependencies": {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		"typebox": "*"
	},
	"devDependencies": {
		"@biomejs/biome": "1.9.4",
		"@earendil-works/pi-ai": "0.84.3",
		"@earendil-works/pi-coding-agent": "0.84.3",
		"@earendil-works/pi-tui": "0.84.3",
		"@types/node": "22.20.1",
		"@types/yargs-parser": "21.0.3",
		"knip": "6.35.1",
		"typebox": "1.3.7",
		"typescript": "5.9.3",
		"vitest": "4.1.11"
	},
	"knip": {
		"entry": ["src/index.ts", "src/protocol.ts", "src/range-compression.ts", "tests/**/*.test.ts"],
		"project": ["src/**/*.ts"]
	}
}


File: tsconfig.json

{
	"compilerOptions": {
		"target": "ES2023",
		"lib": ["ES2023"],
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"allowImportingTsExtensions": true,
		"isolatedModules": true,
		"verbatimModuleSyntax": true,
		"skipLibCheck": true,
		"noEmit": true,
		"types": ["node"]
	},
	"include": ["src/**/*.ts", "tests/**/*.ts"]
}


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/custom-provider.md

# Custom Providers

Extensions can register custom model providers via `pi.registerProvider()`. This enables:

- **Proxies** - Route requests through corporate proxies or API gateways
- **Custom endpoints** - Use self-hosted or private model deployments
- **OAuth/SSO** - Add authentication flows for enterprise providers
- **Custom APIs** - Implement streaming for non-standard LLM APIs

## Example Extensions

See these complete provider examples:

- [`examples/extensions/custom-provider-anthropic/`](../examples/extensions/custom-provider-anthropic/)
- [`examples/extensions/custom-provider-gitlab-duo/`](../examples/extensions/custom-provider-gitlab-duo/)

## Table of Contents

- [Example Extensions](#example-extensions)
- [Quick Reference](#quick-reference)
- [Override Existing Provider](#override-existing-provider)
- [Register New Provider](#register-new-provider)
- [Unregister Provider](#unregister-provider)
- [OAuth Support](#oauth-support)
- [Custom Streaming API](#custom-streaming-api)
- [Context Overflow Errors](#context-overflow-errors)
- [Testing Your Implementation](#testing-your-implementation)
- [Config Reference](#config-reference)
- [Model Definition Reference](#model-definition-reference)

## Quick Reference

Extensions can register either a complete pi-ai `Provider` or use the legacy provider-config form. Prefer a complete provider when custom authentication, filtering, refresh, or streaming behavior is required. Pi composes `models.json` overrides above registered native providers.

```typescript
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(createProvider({
    id: "native-local",
    name: "Native Local",
    baseUrl: "http://localhost:8080/v1",
    auth: {
      apiKey: {
        name: "Local server API key",
        async login(interaction) {
          return {
            type: "api_key",
            key: await interaction.prompt({ type: "secret", message: "API key" })
          };
        },
        async resolve({ credential }) {
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: "stored API key" }
            : undefined;
        }
      }
    },
    models: [],
    api: openAICompletionsApi()
  }));

  // Legacy provider-config form:
  // Override baseUrl for existing provider
  pi.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // Register new provider with models
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
```

The extension factory can also be `async`. For dynamic model discovery, fetch and register models in the factory instead of `session_start`. pi waits for the factory before startup continues, so the provider is available during interactive startup and to `pi --list-models`.

## Override Existing Provider

The simplest use case: redirect an existing provider through a proxy.

```typescript
// All Anthropic requests now go through your proxy
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Add custom headers to OpenAI requests
pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// Both baseUrl and headers
pi.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "$CORP_AUTH_TOKEN"  // env var or literal
  }
});
```

When only `baseUrl` and/or `headers` are provided (no `models`), all existing models for that provider are preserved with the new endpoint.

## Register New Provider

To add a completely new provider, specify `models` along with the required configuration.

If the model list comes from a remote endpoint, use an async extension factory:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

This registers the fetched models before startup finishes.

```typescript
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",  // env var reference
  api: "openai-completions",  // which streaming API to use
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,        // supports extended thinking
      input: ["text", "image"],
      cost: {
        input: 3.0,           // $/million tokens
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75
      },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

When `models` is provided, it **replaces** all existing models for that provider.

`apiKey` and custom header values use the same config value syntax as `models.json`: `!command` at the start executes a command for the whole value, `$ENV_VAR` and `${ENV_VAR}` interpolate environment variables, `$$` emits a literal `$`, and `$!` emits a literal `!`.

## Unregister Provider

Use `pi.unregisterProvider(name)` to remove a provider that was previously registered via `pi.registerProvider(name, ...)`:

```typescript
// Register
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Later, remove it
pi.unregisterProvider("my-llm");
```

Unregistering removes that provider's dynamic models, API key fallback, OAuth provider registration, and custom stream handler registrations. Any built-in models or provider behavior that were overridden are restored.

Calls made after the initial extension load phase are applied immediately, so no `/reload` is required.

### API Types

The `api` field determines which streaming implementation is used:

| API | Use for |
|-----|---------|
| `anthropic-messages` | Anthropic Claude API and compatibles |
| `openai-completions` | OpenAI Chat Completions API and compatibles |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `mistral-conversations` | Native Mistral Chat Completions streaming |
| `google-generative-ai` | Google Generative AI API |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |

Most OpenAI-compatible providers work with `openai-completions`. Use model-level `thinkingLevelMap` for model-specific thinking levels, and `compat` for provider quirks. The `xhigh` and `max` levels are opt-in, require non-null map entries, and may be separated by unsupported holes:

```typescript
models: [{
  id: "custom-model",
  // ...
  reasoning: true,
  thinkingLevelMap: {              // map pi levels to provider values; null hides unsupported levels
    minimal: null,
    low: null,
    medium: null,
    high: "default",
    xhigh: null,
    max: "max"
  },
  compat: {
    supportsDeveloperRole: false,   // use "system" instead of "developer"
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",   // instead of "max_completion_tokens"
    requiresToolResultName: true,   // tool results need name field
    thinkingFormat: "qwen",        // top-level enable_thinking: true
    cacheControlFormat: "anthropic" // Anthropic-style cache_control markers
  }
}]
```

Use `openrouter` for OpenRouter-style `reasoning: { effort }` controls. Use `together` for Together-style `reasoning: { enabled }` controls; with `supportsReasoningEffort`, it also sends `reasoning_effort`. Use `qwen-chat-template` for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking` and need `preserve_thinking`.
Use `cacheControlFormat: "anthropic"` for OpenAI-compatible providers that expose Anthropic-style prompt caching via `cache_control` on the system prompt, last tool definition, and last user, assistant, or tool-result text content.

For Anthropic-compatible providers using `api: "anthropic-messages"`, set `compat.forceAdaptiveThinking: true` on models or providers whose upstream model requires adaptive thinking (`thinking.type: "adaptive"` plus `output_config.effort`). Built-in adaptive Claude models set this automatically. Set `compat.allowEmptySignature: true` only for providers that emit empty thinking signatures and expect `signature: ""` on replay.

> Migration note: Mistral moved from `openai-completions` to `mistral-conversations`.
> Use `mistral-conversations` for native Mistral models.
> If you intentionally route Mistral-compatible/custom endpoints through `openai-completions`, set `compat` flags explicitly as needed.

### Auth Header

If your provider expects `Authorization: Bearer <key>` but doesn't use a standard API, set `authHeader: true`:

```typescript
pi.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  authHeader: true,  // adds Authorization: Bearer header
  api: "openai-completions",
  models: [...]
});
```

The key is resolved for each request. An explicit request `Authorization` header takes precedence over the generated value.

## OAuth Support

Add OAuth/SSO authentication that integrates with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const method = await callbacks.onSelect({
        message: "Select login method:",
        options: [
          { id: "browser", label: "Browser OAuth" },
          { id: "device", label: "Device code" }
        ]
      });
      if (!method) throw new Error("Login cancelled");

      let code: string;
      if (method === "device") {
        callbacks.onDeviceCode({
          userCode: "ABCD-1234",
          verificationUri: "https://sso.corp.com/device",
          intervalSeconds: 5,
          expiresInSeconds: 900
        });
        code = await pollDeviceCodeUntilComplete();
      } else {
        callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });
        code = await callbacks.onPrompt({ message: "Enter SSO code:" });
      }

      // Exchange for tokens (your implementation)
      const tokens = await exchangeCodeForTokens(code);

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
      const tokens = await refreshAccessToken(credentials.refresh, signal);
      return {
        refresh: tokens.refreshToken ?? credentials.refresh,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    }
  }
});
```

After registration, users can authenticate via `/login corporate-ai`.

### OAuthLoginCallbacks

The `callbacks` object provides UI-neutral interactions for the provider-owned flow:

```typescript
interface OAuthLoginCallbacks {
  // Open URL in browser (for OAuth redirects)
  onAuth(params: { url: string }): void;

  // Show device code (for device authorization flow)
  onDeviceCode(params: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;

  // Show transient progress
  onProgress?(message: string): void;

  // Prompt user for input (for manual token entry)
  onPrompt(params: { message: string }): Promise<string>;

  // Show an interactive selector, e.g. to choose browser OAuth vs device code
  onSelect(params: {
    message: string;
    options: { id: string; label: string }[];
  }): Promise<string | undefined>;
}
```

### OAuthCredentials

Credentials are persisted in `~/.pi/agent/auth.json`:

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token (for refreshToken())
  access: string;    // Access token (returned by getApiKey())
  expires: number;   // Expiration timestamp in milliseconds
}
```

## Custom Streaming API

For providers with non-standard APIs, implement `streamSimple`. Study the existing API implementations before writing your own:

**Reference implementations:**
- [anthropic-messages.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/anthropic-messages.ts) - Anthropic Messages API
- [mistral-conversations.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/mistral-conversations.ts) - Mistral Conversations API
- [openai-completions.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/openai-completions.ts) - OpenAI Chat Completions
- [openai-responses.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/openai-responses.ts) - OpenAI Responses API
- [google-generative-ai.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/google-generative-ai.ts) - Google Generative AI
- [bedrock-converse-stream.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/bedrock-converse-stream.ts) - AWS Bedrock

### Stream Pattern

All providers follow the same pattern:

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

function streamMyProvider(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    // Initialize output message
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      // Push start event
      stream.push({ type: "start", partial: output });

      // Make API request and process response...
      // Push content events as they arrive and set stopReason from the terminal event.
      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      // Push done event
      stream.push({
        type: "done",
        reason: output.stopReason,
        message: output
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
```

### Event Types

Push events via `stream.push()` in this order:

1. `{ type: "start", partial: output }` - Stream started

2. Content events (repeatable, track `contentIndex` for each block):
   - `{ type: "text_start", contentIndex, partial }` - Text block started
   - `{ type: "text_delta", contentIndex, delta, partial }` - Text chunk
   - `{ type: "text_end", contentIndex, content, partial }` - Text block ended
   - `{ type: "thinking_start", contentIndex, partial }` - Thinking started
   - `{ type: "thinking_delta", contentIndex, delta, partial }` - Thinking chunk
   - `{ type: "thinking_end", contentIndex, content, partial }` - Thinking ended
   - `{ type: "toolcall_start", contentIndex, partial }` - Tool call started
   - `{ type: "toolcall_delta", contentIndex, delta, partial }` - Tool call JSON chunk
   - `{ type: "toolcall_end", contentIndex, toolCall, partial }` - Tool call ended

3. `{ type: "done", reason, message }` or `{ type: "error", reason, error }` - Stream ended

The `partial` field in each event contains the current `AssistantMessage` state. Update `output.content` as you receive data, then include `output` as the `partial`.

### Content Blocks

Add content blocks to `output.content` as they arrive:

```typescript
// Text block
output.content.push({ type: "text", text: "" });
stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

// As text arrives
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// When block completes
stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
```

### Tool Calls

Tool calls require accumulating JSON and parsing:

```typescript
// Start tool call
output.content.push({
  type: "toolCall",
  id: toolCallId,
  name: toolName,
  arguments: {}
});
stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });

// Accumulate JSON
let partialJson = "";
partialJson += jsonDelta;
try {
  block.arguments = JSON.parse(partialJson);
} catch {}
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// Complete
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: { type: "toolCall", id, name, arguments: block.arguments },
  partial: output
});
```

### Usage and Cost

Update usage from API response and calculate cost:

```typescript
output.usage.input = response.usage.input_tokens;
output.usage.output = response.usage.output_tokens;
output.usage.cacheRead = response.usage.cache_read_tokens ?? 0;
output.usage.cacheWrite = response.usage.cache_write_tokens ?? 0;
output.usage.totalTokens = output.usage.input + output.usage.output +
                           output.usage.cacheRead + output.usage.cacheWrite;
calculateCost(model, output.usage);
```

### Context Overflow Errors

When a request exceeds the model's context window, pi can recover automatically by compacting the conversation and retrying. This recovery only kicks in if pi recognizes the failure as an overflow.

Detection runs on the finalized assistant message:

- `stopReason === "error"`
- `errorMessage` matches one of pi's known overflow patterns (see [`packages/ai/src/utils/overflow.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts))

If your provider returns overflow errors with a message pi does not recognize, normalize the error from the same extension that registers the provider. Use a `message_end` handler to rewrite the assistant message so its `errorMessage` starts with a phrase pi recognizes. The generic fallback `context_length_exceeded` is the safest choice.

```typescript
const MY_PROVIDER_OVERFLOW_PATTERN = /your provider's overflow phrase/i;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-provider", { /* ... */ });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (
      message.provider !== "my-provider" &&
      ctx.model?.provider !== "my-provider"
    )
      return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!MY_PROVIDER_OVERFLOW_PATTERN.test(errorMessage)) return;

    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });
}
```

`message_end` runs before pi tracks the assistant message for auto-compaction, so the rewritten `errorMessage` is what pi checks. With this in place, pi will:

1. Detect the overflow from `errorMessage`.
2. Drop the failed assistant message from live context.
3. Run compaction.
4. Retry the request once.

Guard the rewrite carefully:

- Scope it to your provider (`message.provider` and `ctx.model?.provider`) so unrelated errors from other providers are untouched.
- Match a provider-specific pattern, not pi's generic overflow patterns. Rewriting rate-limit or throttling errors (`rate limit`, `too many requests`) would falsely trigger compaction instead of pi's normal retry-with-backoff path.
- Skip when `errorMessage` already includes `context_length_exceeded` so the handler is idempotent.

### Registration

Register your stream function:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider
});
```

## Testing Your Implementation

Test your provider against the same test suites used by built-in providers. Copy and adapt these test files from [packages/ai/test/](https://github.com/earendil-works/pi-mono/tree/main/packages/ai/test):

| Test | Purpose |
|------|---------|
| `stream.test.ts` | Basic streaming, text output |
| `tokens.test.ts` | Token counting and usage |
| `abort.test.ts` | AbortSignal handling |
| `empty.test.ts` | Empty/minimal responses |
| `context-overflow.test.ts` | Context window limits |
| `image-limits.test.ts` | Image input handling |
| `unicode-surrogate.test.ts` | Unicode edge cases |
| `tool-call-without-result.test.ts` | Tool call edge cases |
| `image-tool-result.test.ts` | Images in tool results |
| `total-tokens.test.ts` | Total token calculation |
| `cross-provider-handoff.test.ts` | Context handoff between providers |

Run tests with your provider/model pairs to verify compatibility.

## Config Reference

```typescript
interface ProviderConfig {
  /** Display name for the provider in UI such as /login. */
  name?: string;

  /** API endpoint URL. Required when defining models. */
  baseUrl?: string;

  /** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or !command. Required when defining models (unless oauth). */
  apiKey?: string;

  /** API type for streaming. Required at provider or model level when defining models. */
  api?: Api;

  /** Custom streaming implementation for non-standard APIs. */
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;

  /** Custom headers to include in requests. Values use the same resolution syntax as apiKey. */
  headers?: Record<string, string>;

  /** If true, adds Authorization: Bearer header with the resolved API key. */
  authHeader?: boolean;

  /** Models to register. If provided, replaces all existing models for this provider. */
  models?: ProviderModelConfig[];

  /** OAuth provider for /login support. */
  oauth?: {
    name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
  };
}
```

## Model Definition Reference

```typescript
interface ProviderModelConfig {
  /** Model ID (e.g., "claude-sonnet-4-20250514"). */
  id: string;

  /** Display name (e.g., "Claude 4 Sonnet"). */
  name: string;

  /** API type override for this specific model. */
  api?: Api;

  /** API endpoint URL override for this specific model. */
  baseUrl?: string;

  /** Whether the model supports extended thinking. */
  reasoning: boolean;

  /** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;

  /** Supported input types. */
  input: ("text" | "image")[];

  /** Cost per million tokens (for usage tracking). */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };

  /** Maximum context window size in tokens. */
  contextWindow: number;

  /** Maximum output tokens. */
  maxTokens: number;

  /** Custom headers for this specific model. */
  headers?: Record<string, string>;

  /** Compatibility settings for the selected API. */
  compat?: {
    // openai-completions
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    supportsFinishReason?: boolean;
    supportsStrictMode?: boolean;
    supportsOpenAIGrammarTools?: boolean; // openai-completions/openai-responses; false falls back to normal function tools
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
    chatTemplateKwargs?: Record<string, string | number | boolean | null | { "$var": "thinking.enabled" | "thinking.effort" | "thinking.budget"; omitWhenOff?: boolean }>;
    chatTemplateArgs?: Record<string, string | number | boolean | null | { "$var": "thinking.enabled" | "thinking.effort" | "thinking.budget"; omitWhenOff?: boolean }>;
    thinkingTokenBudgetField?: "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";
    supportsThinkingTokenBudget?: boolean;
    cacheControlFormat?: "anthropic";
    sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
    sendSessionAffinityHeaders?: boolean;

    // anthropic-messages
    supportsEagerToolInputStreaming?: boolean;
    supportsLongCacheRetention?: boolean;
    sendSessionAffinityHeaders?: boolean;
    supportsCacheControlOnTools?: boolean;
    forceAdaptiveThinking?: boolean;
    allowEmptySignature?: boolean;
    supportsStrictTools?: boolean;
  };
}
```

`openrouter` sends `reasoning: { effort }`. `deepseek` sends `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` when enabled. `together` sends `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` is for DashScope-style top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking` and need `preserve_thinking`. Use `chat-template` for configurable `chat_template_kwargs`, for example DeepSeek V3.x behind vLLM with `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }`. Use `thinkingFormat: "baseten"` with `chatTemplateArgs` when the provider expects toggle values under `chat_template_args` and optionally supports top-level `reasoning_effort`.
`thinkingTokenBudgetField` sends a clamped per-level thinking budget as a top-level request field (`thinking_token_budget` on vLLM, `thinking_budget` on Qwen/SGLang, `thinking_budget_tokens` on llama.cpp). `supportsThinkingTokenBudget: true` is an alias for the vLLM field name. Do not combine it with `reasoning_effort` on DashScope Qwen models.
`cacheControlFormat: "anthropic"` applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/environment-variables.md

# Environment Variables

Pi uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the Pi process.
- Pi sets process markers so child processes can identify Pi as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
- `PI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.

Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Pi session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi. `PI_PROVIDER` and `PI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).

`PI_SERVER_DIR` and `PI_SERVER_ID` apply only to the source-only [experimental remote harness](development.md#experimental-remote-harness), not distributed builds.


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/extensions.md

> pi can create extensions. Ask it to build one for your use case.

# Extensions

Extensions are TypeScript modules that extend pi's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more.

> **Placement for /reload:** Put extensions in `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local) for auto-discovery. Use `pi -e ./path.ts` only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

**Key capabilities:**
- **Custom tools** - Register tools the LLM can call via `pi.registerTool()`
- **Event interception** - Block or modify tool calls, inject context, customize compaction
- **User interaction** - Prompt users via `ctx.ui` (select, confirm, input, notify)
- **Custom UI components** - Full TUI components with keyboard input via `ctx.ui.custom()` for complex interactions
- **Custom commands** - Register commands like `/mycommand` via `pi.registerCommand()`
- **Session persistence** - Store state that survives restarts via `pi.appendEntry()`
- **Custom rendering** - Control how tool calls/results and messages appear in TUI

**Example use cases:**
- Permission gates (confirm before `rm -rf`, `sudo`, etc.)
- Git checkpointing (stash at each turn, restore on branch)
- Path protection (block writes to `.env`, `node_modules/`)
- Custom compaction (summarize conversation your way)
- Conversation summaries (see `summarize.ts` example)
- Interactive tools (questions, wizards, custom dialogs)
- Stateful tools (todo lists, connection pools)
- External integrations (file watchers, webhooks, CI triggers)
- Games while you wait (see `snake.ts` example)

See [examples/extensions/](../examples/extensions/) for working implementations.

## Table of Contents

- [Quick Start](#quick-start)
- [Extension Locations](#extension-locations)
- [Available Imports](#available-imports)
- [Writing an Extension](#writing-an-extension)
  - [Extension Styles](#extension-styles)
- [Events](#events)
  - [Lifecycle Overview](#lifecycle-overview)
  - [Resource Events](#resource-events)
  - [Session Events](#session-events)
  - [Agent Events](#agent-events)
  - [Model Events](#model-events)
  - [Tool Events](#tool-events)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI Methods](#extensionapi-methods)
- [State Management](#state-management)
- [Custom Tools](#custom-tools)
  - [Dynamic Tool Loading](#dynamic-tool-loading)
- [Custom UI](#custom-ui)
- [Error Handling](#error-handling)
- [Mode Behavior](#mode-behavior)
- [Examples Reference](#examples-reference)

## Quick Start

Create `~/.pi/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // React to events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test with `--extension` (or `-e`) flag:

```bash
pi -e ./my-extension.ts
```

## Extension Locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Extensions are auto-discovered from trusted locations. Project-local `.pi/extensions` entries load only after the project is trusted.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

Additional paths via `settings.json`:

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

To share extensions via npm or git as pi packages, see [packages.md](packages.md).

## Available Imports

| Package | Purpose |
|---------|---------|
| `@earendil-works/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@earendil-works/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@earendil-works/pi-tui` | TUI components for custom rendering |

npm dependencies work too. Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically.

For distributed pi packages installed with `pi install` (npm or git), runtime deps must be in `dependencies`. Package installation uses production installs (`npm install --omit=dev`) by default, so `devDependencies` are not available at runtime; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers.

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.

## Writing an Extension

An extension exports a default factory function that receives `ExtensionAPI`. The factory can be synchronous or asynchronous:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui for user interaction
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // Footer status
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

If the factory returns a `Promise`, pi awaits it before continuing startup. That means async initialization completes before `session_start`, before `resources_discover`, and before provider registrations queued via `pi.registerProvider()` are flushed.

### Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration or dynamically discovering available models.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

This pattern makes the fetched models available during normal startup and to `pi --list-models`.

### Long-lived resources and shutdown

Extension factories may run in invocations that never start a session. Do not start background resources such as processes, sockets, file watchers, or timers from the factory.

Defer background resource startup until `session_start` or the command/tool/event that needs the resource. Register an idempotent `session_shutdown` handler to close any session-scoped resources you start.

### Extension Styles

**Single file** - simplest, for small extensions:

```
~/.pi/agent/extensions/
└── my-extension.ts
```

**Directory with index.ts** - for multi-file extensions:

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies** - for extensions that need npm packages:

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # Declares dependencies and entry points
    ├── package-lock.json
    ├── node_modules/   # After npm install
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Run `npm install` in the extension directory, then imports from `node_modules/` work automatically.

## Events

### Lifecycle Overview

```
pi starts
  │
  ├─► project_trust (user/global and CLI extensions only, before project resources load)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_headers (can mutate headers)     |
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  ├─► agent_end                                            │
  └─► agent_settled (no retry/compaction/follow-up left)   │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork or /clone
  ├─► session_before_fork (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/name or pi.setSessionName()
  └─► session_info_changed

/compact or auto-compaction
  ├─► session_before_compact (can cancel or customize)
  ├─► session_compact (success)
  └─► session_compact_failed (failure or abort)

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or Ctrl+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, pi.setThinkingLevel())
  └─► thinking_level_select

exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### Startup Events

#### project_trust

Fired before pi decides whether to trust a project with dynamic configs (`.pi` or `.agents/skills`). It runs during startup and when session replacement (for example `/resume`) enters a cwd whose trust has not been resolved in the current process. Only user/global extensions and CLI `-e` extensions participate; project-local extensions are not loaded until after trust is resolved.

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd - current working directory
  // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

A `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. A user/global or CLI extension that returns `"yes"` or `"no"` owns the decision; the first yes/no decision wins and suppresses the built-in trust prompt. Use `remember: true` to persist a yes/no decision; otherwise it applies only to the current process. Return `"undecided"` to let later handlers or the built-in trust flow decide. Check `ctx.hasUI` before prompting. If no handler returns yes/no, normal trust resolution continues: saved `trust.json` decisions apply first, then `defaultProjectTrust` controls whether pi asks, trusts, or declines by default.

### Resource Events

#### resources_discover

Fired after `session_start` so extensions can contribute additional skill, prompt, and theme paths.
The startup path uses `reason: "startup"`. Reload uses `reason: "reload"`.

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd - current working directory
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### Session Events

See [Session Format](session-format.md) for session storage internals and the SessionManager API.

#### session_start

Fired when a session is started, loaded, or reloaded.

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - present for "new", "resume", and "fork"
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

#### session_info_changed

Fired when the current session display name is set via `/name`, RPC, or `pi.setSessionName()`.

```typescript
pi.on("session_info_changed", async (event, ctx) => {
  // event.name - current normalized name, or undefined if cleared
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

#### session_before_switch

Fired before starting a new session (`/new`) or switching sessions (`/resume`).

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" or "resume"
  // event.targetSessionFile - session we're switching to (only for "resume")

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

After a successful switch or new-session action, pi emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "new" | "resume"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_fork

Fired when forking via `/fork` or cloning via `/clone`.

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId - ID of the selected entry
  // event.position - "before" for /fork, "at" for /clone
  return { cancel: true }; // Cancel fork/clone
  // OR
  return { skipConversationRestore: true }; // Reserved for future conversation restore control
});
```

After a successful fork or clone, pi emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "fork"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_compact / session_compact / session_compact_failed

Fired on compaction. See [compaction.md](compaction.md) for details.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - the saved compaction
  // event.fromExtension - whether extension provided it
  // event.reason - "manual" (/compact), "threshold", or "overflow"
  // event.willRetry - whether the aborted turn is retried after compaction (overflow recovery)
});

pi.on("session_compact_failed", async (event, ctx) => {
  // event.reason - "manual" (/compact), "threshold", or "overflow"
  // event.errorMessage - present for non-abort failures
  // event.aborted - true for cancelled/aborted compactions
  // event.willRetry - whether the aborted turn would have retried after compaction
  // event.fromExtension - whether extension-provided compaction content was being used
});
```

#### session_before_tree / session_tree

Fired on `/tree` navigation. See [Sessions](sessions.md) for tree navigation concepts.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // OR provide custom summary:
  return {
    summary: {
      summary: "...",
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: {},
    },
  };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### session_shutdown

Fired before a started session runtime is torn down. Use this to clean up resources opened from `session_start` or other session-scoped hooks.

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
  // Cleanup, save state, etc.
});
```

### Agent Events

#### before_agent_start

Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt.

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .customPrompt - any custom system prompt (from --system-prompt, SYSTEM.md, or custom templates)
  //   .selectedTools - tools currently active in the prompt
  //   .toolSnippets - one-line descriptions for each tool
  //   .promptGuidelines - custom guideline bullets
  //   .appendSystemPrompt - text from --append-system-prompt flags
  //   .cwd - working directory
  //   .contextFiles - AGENTS.md files and other loaded context files
  //   .skills - loaded skills

  return {
    // Inject a persistent message (stored in session, sent to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Replace the system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

The `systemPromptOptions` field gives extensions access to the same structured data Pi uses to build the system prompt. This lets you inspect what Pi has loaded — custom prompts, guidelines, tool snippets, context files, skills — without re-discovering resources or re-parsing flags. Use it when your extension needs to make deep, informed changes to the system prompt while respecting user-provided configuration.

Inside `before_agent_start`, `event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again.

#### agent_start / agent_end / agent_settled

`agent_start` fires when a low-level agent run begins. `agent_end` fires when that run ends, but Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages. Use `agent_settled` for status integrations that need to know Pi will not continue running automatically.

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages - messages from this low-level run
});

pi.on("agent_settled", async (_event, ctx) => {
  // ctx.isIdle() is true here unless another extension started a new run.
});
```

#### ui_prompt_start / ui_prompt_end

Notification-only lifecycle events for blocking user-facing extension UI prompts. They fire around `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.editor()`, and `ctx.ui.custom()` so host/status integrations can report "waiting for user" instead of just "running".

Nested or overlapping prompts are coalesced into one outer waiting span. Handlers are invoked best-effort and are not awaited before showing or closing the prompt.

```typescript
pi.on("ui_prompt_start", async (event, ctx) => {
  // event.reason === "ui_prompt"
  // event.kind: "select" | "confirm" | "input" | "editor" | "custom"
  // event.title: prompt title when available
});

pi.on("ui_prompt_end", async (event, ctx) => {
  // Pi is no longer waiting on that UI prompt span.
});
```

#### turn_start / turn_end

Fired for each turn (one LLM response + tool calls).

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

Fired for message lifecycle updates.

- `message_start` and `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming updates.
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`.

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});

pi.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent (token-by-token stream event)
});

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

Fired for tool execution lifecycle updates.

In parallel tool mode:
- `tool_execution_start` is emitted in assistant source order during the preflight phase
- `tool_execution_update` events may interleave across tools
- `tool_execution_end` is emitted in tool completion order after each tool is finalized
- final `toolResult` message events are still emitted later in assistant source order

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

Fired before each LLM call. Modify messages non-destructively. See [Session Format](session-format.md) for message types.

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_headers

Fired after the outgoing HTTP headers are assembled. Use it to add, override, or remove request headers.

Handlers mutate `event.headers` in place. Set a key to a string to add or override it, or to `null` to delete it.

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  // Add or override — e.g. a session id for gateway tracing/attribution
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();

  // Drop a tracking header pi adds for this call
  event.headers["X-OpenRouter-Title"] = null;
});
```

Runs once per provider request; retries reuse the same headers rather than re-firing the hook.

#### before_provider_request

Fired after the provider-specific payload is built, right before the request is sent. Handlers run in extension load order. Returning `undefined` keeps the payload unchanged. Returning any other value replaces the payload for later handlers and for the actual request.

This hook can rewrite provider-level system instructions or remove them entirely. Those payload-level changes are not reflected by `ctx.getSystemPrompt()`, which reports Pi's system prompt string rather than the final serialized provider payload.

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

This is mainly useful for debugging provider serialization and cache behavior.

#### after_provider_response

Fired after an HTTP response is received and before its stream body is consumed. Handlers run in extension load order.

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

Header availability depends on provider and transport. Providers that abstract HTTP responses may not expose headers.

### Model Events

#### model_select

Fired when the model changes via `/model` command, model cycling (`Ctrl+P`), or session restore.

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

Use this to update UI elements (status bars, footers) or perform model-specific initialization when the active model changes.

#### thinking_level_select

Fired when the thinking level changes. This is notification-only; handler return values are ignored.

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Use this to update extension UI when `pi.setThinkingLevel()`, model changes, or built-in thinking-level controls change the active thinking level.

### Tool Events

#### tool_call

Fired after `tool_execution_start`, before the tool executes. **Can block.** Use `isToolCallEventType` to narrow and get typed inputs.

Before `tool_call` runs, pi waits for previously emitted Agent events to finish draining through `AgentSession`. This means `ctx.sessionManager` is up to date through the current assistant tool-calling message.

In the default parallel tool execution mode, sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results from that same assistant message in `ctx.sessionManager`.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution.

Behavior guarantees:
- Mutations to `event.input` affect the actual tool execution
- Later `tool_call` handlers see mutations made by earlier handlers
- No re-validation is performed after your mutation
- Return values from `tool_call` control blocking via `{ block: true, reason?: string, terminate?: boolean }`
- `terminate` only applies to a blocked call; the agent stops early only when every finalized result in the batch is terminating

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit", etc.
  // event.toolCallId
  // event.input - tool parameters (mutable)

  // Built-in tools: no type params needed
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### Typing custom tool input

Custom tools should export their input type:

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

Use `isToolCallEventType` with explicit type parameters:

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // typed
  }
});
```

#### tool_result

Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. **Can modify result.**

In parallel tool mode, `tool_result` and `tool_execution_end` may interleave in tool completion order, while final `toolResult` message events are still emitted later in assistant source order.

`tool_result` handlers chain like middleware:
- Handlers run in extension load order
- Each handler sees the latest result after previous handler changes
- Handlers can return partial patches (`content`, `details`, `isError`, or `usage`); omitted fields keep their current values

Use `ctx.signal` for nested async work inside the handler. This lets Esc cancel model calls, `fetch()`, and other abort-aware operations started by the extension.

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError, event.usage

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false, usage: nestedModelUsage };
});
```

### User Bash Events

#### user_bash

Fired when user executes `!` or `!!` commands. **Can intercept.**

```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Provide custom operations (e.g., SSH)
  return { operations: remoteBashOps };

  // Option 2: Wrap pi's built-in local bash backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // Option 3: Full replacement - return result directly
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### Input Events

#### input

Fired when user input is received, after extension commands are checked but before skill and template expansion. The event sees the raw input text, so `/skill:foo` and `/template` are not yet expanded.

**Processing order:**
1. Extension commands (`/cmd`) checked first - if found, handler runs and input event is skipped
2. `input` event fires - can intercept, transform, or handle
3. If not handled: skill commands (`/skill:name`) expanded to skill content
4. If not handled: prompt templates (`/template`) expanded to template content
5. Agent processing begins (`before_agent_start`, etc.)

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   undefined when idle, "steer" for mid-stream interrupts,
  //   "followUp" for messages queued until the agent finishes

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Route by source: skip processing for extension-injected messages
  if (event.source === "extension") return { action: "continue" };

  // Intercept skill commands before expansion
  if (event.text.startsWith("/skill:")) {
    // Could transform, block, or let pass through
  }

  return { action: "continue" };  // Default: pass through to expansion
});
```

**Results:**
- `continue` - pass through unchanged (default if handler returns nothing)
- `transform` - modify text/images, then continue to expansion
- `handled` - skip agent entirely (first handler to return this wins)

Transforms chain across handlers. See [input-transform.ts](../examples/extensions/input-transform.ts) and [input-transform-streaming.ts](../examples/extensions/input-transform-streaming.ts) for `streamingBehavior`-aware routing.

## ExtensionContext

All handlers receive `ctx: ExtensionContext`.

### ctx.ui

UI methods for user interaction. See [Custom UI](#custom-ui) for full details.

### ctx.mode

Current run mode: `"tui"`, `"rpc"`, `"json"`, or `"print"`. Use `ctx.mode === "tui"` to guard terminal-only features such as `custom()`, component factories, terminal input, and direct TUI rendering.

### ctx.hasUI

`true` in TUI and RPC modes. `false` in print mode (`-p`) and JSON mode. Use this to guard dialog methods (`select`, `confirm`, `input`, `editor`) and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`) that work in both TUI and RPC modes. In RPC mode, some TUI-specific methods are no-ops or return defaults (see [rpc.md](rpc.md#extension-ui-protocol)).

### ctx.cwd

Current working directory.

Use `CONFIG_DIR_NAME` instead of hardcoding `.pi` when constructing project-local config paths. Rebranded distributions can use a different config directory name.

```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
    // ...
  });
}
```

### ctx.isProjectTrusted()

Returns whether project-local trust is active for the current session context. This includes temporary trust decisions and CLI trust overrides, not just saved decisions in the global trust store.

Use this before reading project-local extension configuration that should only be honored for trusted projects.

### ctx.sessionManager

Read-only access to session state. See [Session Format](session-format.md) for the full SessionManager API and entry types.

For `tool_call`, this state is synchronized through the current assistant message before handlers run. In parallel tool execution mode it is still not guaranteed to include sibling tool results from the same assistant message.

```typescript
ctx.sessionManager.getEntries()             // All entries
ctx.sessionManager.getBranch()              // Current branch
ctx.sessionManager.buildContextEntries()    // Active branch entries with compaction applied
ctx.sessionManager.getLeafId()              // Current leaf entry ID
```

### ctx.modelRegistry / ctx.model / ctx.thinkingLevel / ctx.scopedModels

Access to models, providers, and resolved authentication. `ctx.modelRegistry.getProvider(id)` returns the effective pi-ai provider, while `getProviderAuth(id)` resolves its current API key, headers, base URL, and provider-scoped environment without requiring a loaded model. `ctx.model` is the active model, and `ctx.thinkingLevel` is its current effective thinking level.

`ctx.scopedModels` is the read-only list of models scoped to the current session — the same set the `/scoped-models` command shows. It is resolved at session start from the `--models` CLI flag and the `enabledModels` setting (matched against the available catalogue with minimatch on `provider/modelId` or a bare `modelId`). It is empty when no scoping is configured, meaning every available model is usable. Each entry is `{ model, thinkingLevel? }`, where `thinkingLevel` is set only when a pattern pinned it (e.g. `anthropic/*:high`). Use it to populate a model picker that mirrors the built-in one instead of enumerating the whole catalogue via `ctx.modelRegistry.getAvailable()`.

### ctx.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:
- `fetch(..., { signal: ctx.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`ctx.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events, extension commands, and shortcuts fired while pi is idle.

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Control flow helpers. `ctx.isIdle()` is false while Pi is processing an agent run, automatic retry, auto-compaction retry, or queued continuation.

### ctx.shutdown()

Request a graceful shutdown of pi.

- **Interactive mode:** Deferred until the agent becomes idle (after processing all queued steering and follow-up messages).
- **RPC mode:** Deferred until the next idle state (after completing the current command response, when waiting for the next command).
- **Print mode:** No-op. The process exits automatically when all prompts are processed.

Emits `session_shutdown` event to all extensions before exiting. Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
pi.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages.

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

Trigger compaction without awaiting completion. Use `onComplete` and `onError` for follow-up actions.

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    ctx.ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

### ctx.getSystemPrompt()

Returns Pi's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
pi.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

## ExtensionCommandContext

Command handlers receive `ExtensionCommandContext`, which extends `ExtensionContext` with session control methods. These are only available in commands because they can deadlock if called from event handlers.

### ctx.getSystemPromptOptions()

Returns the base inputs Pi currently uses to build the system prompt.

```typescript
const options = ctx.getSystemPromptOptions();
const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
```

This has the same shape and mutability as `before_agent_start` `event.systemPromptOptions`: custom prompt, active tools, tool snippets, prompt guidelines, appended system prompt text, cwd, loaded context files, and loaded skills. It may include full context file contents, so treat it as sensitive extension-local data and avoid exposing it through command lists, logs, or autocomplete metadata.

This reports the current base prompt inputs. It does not include per-turn `before_agent_start` chained system-prompt changes, later `context` event message mutations, or `before_provider_request` payload rewrites.

### ctx.waitForIdle()

Wait for the agent to fully settle, including automatic retries, auto-compaction retries, and queued continuations:

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### ctx.newSession(options?)

Create a new session:

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

Options:
- `parentSession`: parent session file to record in the new session header
- `setup`: mutate the new session's `SessionManager` before `withSession` runs
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

### ctx.fork(entryId, options?)

Fork from a specific entry, creating a new session file:

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    ctx.ui.notify("Now in the forked session", "info");
  },
});
if (result.cancelled) {
  // An extension cancelled the fork
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // An extension cancelled the clone
}
```

Options:
- `position`: `"before"` (default) forks before the selected user message, restoring that prompt into the editor
- `position`: `"at"` duplicates the active path through the selected entry without restoring editor text
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

### ctx.navigateTree(targetId, options?)

Navigate to a different point in the session tree:

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false, // true = replace default prompt entirely
  label: "review-checkpoint",
});
```

Options:
- `summarize`: Whether to generate a summary of the abandoned branch
- `customInstructions`: Custom instructions for the summarizer
- `replaceInstructions`: If true, `customInstructions` replaces the default prompt instead of being appended
- `label`: Label to attach to the branch summary entry (or target entry if not summarizing)

### ctx.switchSession(sessionPath, options?)

Switch to a different session file:

```typescript
const result = await ctx.switchSession("/path/to/session.jsonl", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in the replacement session");
  },
});
if (result.cancelled) {
  // An extension cancelled the switch via session_before_switch
}
```

Options:
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

To discover available sessions, use the static `SessionManager.list()` or `SessionManager.listAll()` methods:

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

pi.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "Pick session:",
      sessions.map(s => s.file),
    );
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (ctx) => {
          ctx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### Session replacement lifecycle and footguns

`withSession` receives a fresh `ReplacedSessionContext`, which extends `ExtensionCommandContext` with async `sendMessage()` and `sendUserMessage()` helpers bound to the replacement session.

Lifecycle and footguns:
- `withSession` runs only after the old session has emitted `session_shutdown`, the old runtime has been torn down, the replacement session has been rebound, and the new extension instance has already received `session_start`.
- The callback still executes in the original closure, not inside the new extension instance. That means your old extension instance may already have run its shutdown cleanup before `withSession` starts.
- Captured old `pi` / old command `ctx` session-bound objects are stale after replacement and will throw if used. Use only the `ctx` passed to `withSession` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = ctx.sessionManager` before replacement, `sm` is still the old `SessionManager` object. Do not reuse it after replacement.
- Code in `withSession` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.

Safe pattern:

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the replacement session";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

Unsafe pattern:

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        pi.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

Run the same reload flow as `/reload`.

```typescript
pi.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, themes, and context files",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

Important behavior:
- `await ctx.reload()` emits `session_shutdown` for the current extension runtime
- It then reloads resources and emits `session_start` with `reason: "reload"` and `resources_discover` with reason `"reload"`
- The currently running command handler still continues in the old call frame
- Code after `await ctx.reload()` still runs from the pre-reload version
- Code after `await ctx.reload()` must not assume old in-memory extension state is still valid
- After the handler returns, future commands/events/tool calls use the new extension version

For predictable behavior, treat reload as terminal for that handler (`await ctx.reload(); return;`).

Tools run with `ExtensionContext`, so they cannot call `ctx.reload()` directly. Use a command as the reload entrypoint, then expose a tool that queues that command as a follow-up user message.

Example tool the LLM can call to trigger reload:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, themes, and context files",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI Methods

### pi.on(event, handler)

Subscribe to events. See [Events](#events) for event types and return values.

### pi.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom Tools](#custom-tools) for full details.

`pi.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `pi.getAllTools()` and are callable by the LLM without `/reload`.

Use `pi.setActiveTools()` to enable or disable tools (including dynamically added tools) at runtime.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active.

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

See [dynamic-tools.ts](../examples/extensions/dynamic-tools.ts) for a full example.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional compatibility shim. Runs before schema validation.
    // Return the current schema shape, for example to fold legacy fields
    // into the modern parameter object.
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### pi.sendMessage(message, options?)

Inject a custom message into the session. Custom messages participate in LLM context. For durable TUI-only content that should not be sent to the LLM, use [`pi.appendEntry()`](#piappendentrycustomtype-data) with [`pi.registerEntryRenderer()`](#piregisterentryrenderercustomtype-renderer).

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**Options:**
- `deliverAs` - Delivery mode:
  - `"steer"` (default) - Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
  - `"followUp"` - Waits for agent to finish. Delivered only when agent has no more tool calls.
  - `"nextTurn"` - Queued for next user prompt. Does not interrupt or trigger anything.
- `triggerTurn: true` - If agent is idle, trigger an LLM response immediately. Only applies to `"steer"` and `"followUp"` modes (ignored for `"nextTurn"`).

### pi.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()` which sends custom messages, this sends an actual user message that appears as if typed by the user. Always triggers a turn.

```typescript
// Simple text message
pi.sendUserMessage("What is 2+2?");

// With content array (text + images)
pi.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
pi.sendUserMessage("And then summarize", { deliverAs: "followUp" });

// Opt in to extension command dispatch and skill/prompt template expansion
pi.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

**Options:**
- `deliverAs` - Required when agent is streaming:
  - `"steer"` - Queues the message for delivery after the current assistant turn finishes executing its tool calls
  - `"followUp"` - Waits for agent to finish all tools
- `expandPromptTemplates` - Dispatch extension commands and expand skill commands and prompt templates. Defaults to `false`.

When not streaming, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, throws an error.

See [send-user-message.ts](../examples/extensions/send-user-message.ts) for a complete example.

### pi.appendEntry(customType, data?)

Persist extension data. Custom entries do NOT participate in LLM context. In interactive mode, they can also render inside the chat transcript when paired with `pi.registerEntryRenderer()`.

```typescript
pi.appendEntry("my-state", { count: 42 });
pi.appendEntry("status-card", { title: "Indexed files", count: 17 });

// Restore on reload
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

### pi.setSessionName(name)

Set the session display name (shown in session selector instead of first message).

```typescript
pi.setSessionName("Refactor auth module");
```

### pi.getSessionName()

Get the current session name, if set.

```typescript
const name = pi.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### pi.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation (shown in `/tree` selector).

```typescript
// Set a label
pi.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
pi.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = ctx.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

### pi.registerCommand(name, options)

Register a command.

If multiple extensions register the same command name, pi keeps them all and assigns numeric invocation suffixes in load order, for example `/review:1` and `/review:2`.

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`:

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### pi.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list matches the RPC `get_commands` ordering: extensions first, then templates, then skills.

```typescript
const commands = pi.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

Each entry has this shape:

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

Use `sourceInfo` as the canonical provenance field. Do not infer ownership from command names or from ad hoc path parsing.

Built-in interactive commands (like `/model` and `/settings`) are not included here. They are handled only in interactive
mode and would not execute if sent via `prompt`.

### pi.registerMessageRenderer(customType, renderer)

Register a custom TUI renderer for custom messages with your `customType`. Custom messages are created with `pi.sendMessage()` and participate in LLM context. See [Custom UI](#custom-ui).

### pi.registerMarkdownTransformer(transformer)

Register a transformer for the Markdown in normal user text, assistant text, and thinking blocks. Transformers run in extension load order, and each transformer receives the Markdown returned by the previous transformer. After the chain finishes, Pi renders the transformed content with its built-in renderer.

The transformer receives the Markdown string and a context with:

- `messageType` — `"user"`, `"assistant"`, or `"assistant-thinking"`
- `isStreaming` — `true` for partial assistant updates; `false` for user, finalized assistant, and restored messages
- `availableWidth` — exact terminal columns available for the transformed Markdown content

Return the transformed Markdown:

```typescript
pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});
```

If a transformer throws, Pi keeps the Markdown produced so far and continues with the next transformer. The hook is display-only: the original message remains unchanged in the session and model context. It runs for new user messages, assistant streaming updates, restored session messages, and terminal width changes, so transformers should remain synchronous and inexpensive.

### pi.registerEntryRenderer(customType, renderer)

Register a custom TUI renderer for custom entries with your `customType`. Custom entries are created with `pi.appendEntry()` and do not participate in LLM context.

```typescript
import { Box, Text } from "@earendil-works/pi-tui";

pi.registerEntryRenderer("status-card", (entry, { expanded }, theme) => {
  const data = entry.data as { title: string; count: number };
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(`${theme.bold(data.title)}: ${data.count}`));
  if (expanded) {
    box.addChild(new Text(theme.fg("dim", JSON.stringify(data, null, 2))));
  }
  return box;
});

pi.appendEntry("status-card", { title: "Indexed files", count: 17 });
```

### pi.registerShortcut(shortcut, options)

Register a keyboard shortcut. See [keybindings.md](keybindings.md) for the shortcut format and built-in keybindings.

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!");
  },
});
```

### pi.registerFlag(name, options)

Register a CLI flag.

```typescript
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (pi.getFlag("plan")) {
  // Plan mode enabled
}
```

### pi.exec(command, args, options?)

Execute a shell command.

```typescript
const result = await pi.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

Manage active tools. This works for both built-in tools and dynamically registered tools. `pi.getActiveTools()` returns the active tool names as `string[]`; `pi.getAllTools()` returns metadata for all configured tools.

```typescript
const active = pi.getActiveTools(); // ["read", "bash", ...]
const all = pi.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
pi.setActiveTools([...new Set([...active, "my_custom_tool"])]); // Keep current tools and enable my_custom_tool
pi.setActiveTools(["read", "bash"]); // Switch to read-only
```

`pi.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ customTools })`
- extension source metadata for tools registered by extensions

### pi.setModel(model)

Set the model for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured `defaultProvider` or `defaultModel` used by new sessions. Returns `false` if authentication is not configured for the model's provider. See [models.md](models.md) for configuring custom models.

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

Get the current thinking level. Level is clamped to model capabilities (non-reasoning models always use "off"). Changes emit `thinking_level_select`.

`pi.setThinkingLevel()` changes the thinking level for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured default used by new sessions.

```typescript
const current = pi.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
pi.setThinkingLevel("high");
```

### pi.events

Shared event bus for communication between extensions:

```typescript
pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
```

### pi.registerProvider(name, config)

Register or override a model provider dynamically. Useful for proxies, custom endpoints, or team-wide model configurations.

Calls made during the extension factory function are queued and applied once the runner initialises. Calls made after that — for example from a command handler following a user setup flow — take effect immediately without requiring a `/reload`.

Dynamic providers can implement `refreshModels`. Pi calls it during model refresh, publishes the returned list synchronously through the provider, and passes the canonical credential/stored-catalog/network/signal context. The extension decides whether to persist catalog metadata through generation-checked `context.publish({ persist: entry })`; live servers such as llama.cpp can return models without persisting them.

`context.signal` is always a concrete signal and provider callbacks must pass it to blocking I/O. Public `ModelRuntime.refresh()` and `ModelRegistry.refresh()` calls accept an optional signal and are unbounded when it is omitted; extensions and applications choose their own deadlines. Cancellation stops the caller waiting even if a provider ignores the signal, but cooperation is still required to stop the underlying work.

Extensions that need native provider auth, filtering, refresh, or stream behavior can register a complete `Provider` from `@earendil-works/pi-ai`. The provider becomes the composition base and `models.json` overrides still apply above it.

```typescript
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";

const provider = createProvider({
  id: "local-server",
  name: "Local Server",
  baseUrl: "http://localhost:8080/v1",
  auth: {
    apiKey: {
      name: "Local server setup",
      async login(interaction) {
        return {
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        };
      },
      async resolve({ credential }) {
        return credential?.key
          ? { auth: { apiKey: credential.key }, source: "stored API key" }
          : undefined;
      },
    },
  },
  models: [],
  api: openAICompletionsApi(),
});

pi.registerProvider(provider);

// Register a new provider with custom models
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // env var reference
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Register a live llama.cpp catalog without persisting discovered models
pi.registerProvider("llama.cpp", {
  baseUrl: "http://localhost:8080/v1",
  apiKey: "local",
  api: "openai-completions",
  async refreshModels({ signal }) {
    const response = await fetch("http://localhost:8080/v1/models", { signal });
    const { data } = await response.json();
    return data.map(({ id }) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384
    }));
  }
});

// Override baseUrl for an existing provider (keeps all models)
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Register provider with OAuth support for /login
pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // Custom OAuth flow
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials, signal) {
      signal.throwIfAborted();
      // Refresh logic
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});
```

The object form accepts a complete pi-ai `Provider`, including native `auth`, `getModels`, `refreshModels`, `filterModels`, `stream`, and `streamSimple` behavior.

**Legacy config options:**
- `name` - Display name for the provider in UI such as `/login`.
- `baseUrl` - API endpoint URL. Required when defining models.
- `apiKey` - API key literal, environment interpolation (`$ENV_VAR` or `${ENV_VAR}`), or leading `!command`. Required when defining models (unless `oauth` provided). `$$` escapes `$`, and `$!` escapes a literal `!` without triggering command execution.
- `api` - API type: `"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`, etc.
- `headers` - Custom headers to include in requests.
- `authHeader` - If true, adds `Authorization: Bearer` header automatically.
- `models` - Array of model definitions. If provided, replaces all existing models for this provider. Model definitions can set `baseUrl` to override the provider endpoint for that model.
- `refreshModels` - Async dynamic discovery callback. Its returned models replace extension-provided models. `context.stored` contains the persisted provider snapshot; use generation-checked `context.publish({ persist: entry })` only when updated catalog data should persist. Use `persist: null` to delete that snapshot.
- `oauth` - OAuth provider config for `/login` support. When provided, the provider appears in the login menu.
- `streamSimple` - Custom streaming implementation for non-standard APIs.

See [custom-provider.md](custom-provider.md) for advanced topics: custom streaming APIs, OAuth details, model definition reference.

### pi.unregisterProvider(name)

Remove a previously registered provider and its models. Built-in models that were overridden by the provider are restored. Has no effect if the provider was not registered.

Like `registerProvider`, this takes effect immediately when called after the initial load phase, so a `/reload` is not required.

```typescript
pi.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    pi.unregisterProvider("my-proxy");
  },
});
```

## State Management

Extensions with state should store it in tool result `details` for proper branching support:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

## Custom Tools

Register tools the LLM can call via `pi.registerTool()`. Tools appear in the system prompt and can have custom rendering.

Use `promptSnippet` for a short one-line entry in the `Available tools` section in the default system prompt. If omitted, custom tools are left out of that section.

Use `promptGuidelines` to add tool-specific bullets to the default system prompt `Guidelines` section. These bullets are included only while the tool is active (for example, after `pi.setActiveTools([...])`).

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix or grouping. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

Note: Some models are idiots and include the @ prefix in tool path arguments. Built-in tools strip a leading @ before resolving paths. If your custom tool accepts a path, normalize a leading @ as well.

If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in `edit` and `write`. This matters because tool calls run in parallel by default. Without the queue, two tools can read the same old file contents, compute different updates, and then whichever write lands last overwrites the other.

Example failure case: your custom tool edits `foo.ts` while built-in `edit` also changes `foo.ts` in the same assistant turn. If your tool does not participate in the queue, both can read the original `foo.ts`, apply separate changes, and one of those changes is lost.

Pass the real target file path to `withFileMutationQueue()`, not the raw user argument. Resolve it to an absolute path first, relative to `ctx.cwd` or your tool's working directory. For existing files, the helper canonicalizes through `realpath()`, so symlink aliases for the same file share one queue. For new files, it falls back to the resolved absolute path because there is nothing to `realpath()` yet.

Queue the entire mutation window on that target path. That includes read-modify-write logic, not just the final write.

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Tool Definition

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Use StringEnum for Google compatibility
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // Stream progress updates
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Run commands via pi.exec (captured from extension closure)
    const result = await pi.exec("some-command", [], { signal });

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM
      details: { data: result },                   // For rendering & state
      // usage: nestedModelResponse.usage,          // Optional nested LLM usage
      // Optional: stop after this tool batch when every finalized tool result
      // in the batch also returns terminate: true.
      terminate: true,
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**Usage accounting:** If a tool makes nested LLM calls, return their combined `Usage` as `usage`. Pi persists it on the tool result and includes it in footer, `/session`, and RPC session totals. `tool_result` handlers can inspect or replace this value.

**Signaling errors:** To mark a tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an error from `execute`. Returning a value never sets the error flag regardless of what properties you include in the return object.

**Early termination:** Return `terminate: true` from `execute()` to hint that the automatic follow-up LLM call should be skipped after the current tool batch. This only takes effect when every finalized tool result in that batch is terminating. See [examples/extensions/structured-output.ts](../examples/extensions/structured-output.ts) for a minimal example where the agent ends on a final structured-output tool call.

```typescript
// Correct: throw to signal an error
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**Important:** Use `StringEnum` from `@earendil-works/pi-ai` for string enums. `Type.Union`/`Type.Literal` doesn't work with Google's API.

**Argument preparation:** `prepareArguments(args)` is optional. If defined, it runs before schema validation and before `execute()`. Use it to mimic an older accepted input shape when pi resumes an older session whose stored tool call arguments no longer match the current schema. Return the object you want validated against `parameters`. Keep the public schema strict. Do not add deprecated compatibility fields to `parameters` just to keep old resumed sessions working.

Example: an older session may contain an `edit` tool call with top-level `oldText` and `newText`, while the current schema only accepts `edits: [{ oldText, newText }]`.

```typescript
pi.registerTool({
  name: "edit",
  label: "Edit",
  description: "Edit a single file using exact text replacement",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params now matches the current schema
    return {
      content: [{ type: "text", text: `Applying ${params.edits.length} edit block(s)` }],
      details: {},
    };
  },
});
```

### Overriding Built-in Tools

Extensions can override built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) by registering a tool with the same name. Interactive mode displays a warning when this happens.

```bash
# Extension's read tool replaces built-in read
pi -e ./tool-override.ts
```

Alternatively, use `--no-builtin-tools` to start without any built-in tools while keeping extension tools enabled:
```bash
# No built-in tools, only extension tools
pi --no-builtin-tools -e ./my-extension.ts
```

See [examples/extensions/tool-override.ts](../examples/extensions/tool-override.ts) for a complete example that overrides `read` with logging and access control.

**Rendering:** Built-in renderer inheritance is resolved per slot. Execution override and rendering override are independent. If your override omits `renderCall`, the built-in `renderCall` is used. If your override omits `renderResult`, the built-in `renderResult` is used. If your override omits both, the built-in renderer is used automatically (syntax highlighting, diffs, etc.). This lets you wrap built-in tools for logging or access control without reimplementing the UI.

**Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. If your override should keep those prompt instructions, define them on the override explicitly.

**Your implementation must match the exact result shape**, including the `details` type. The UI and session logic depend on these shapes for rendering and state tracking.

Built-in tool implementations:
- [read.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts) - `BashToolDetails`
- [powershell.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/powershell.ts) - `PowerShellToolDetails`
- [edit.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [write.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/write.ts)
- [grep.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/ls.ts) - `LsToolDetails`

### Remote Execution

Built-in tools support pluggable operations for delegating to remote systems (SSH, containers, etc.):

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

// Create tool with custom operations
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// Register, checking flag at execution time
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

**Operations interfaces:** `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `PowerShellOperations`, `LsOperations`, `GrepOperations`, `FindOperations`

For `user_bash`, extensions can reuse pi's local shell backend via `createLocalBashOperations()` instead of reimplementing local process spawning, shell resolution, and process-tree termination.

The `bash` and `powershell` tools also support a spawn hook to adjust the command, cwd, or env before execution:

```typescript
import { createBashTool } from "@earendil-works/pi-coding-agent";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

`createBashTool()` and `createPowerShellTool()` expose the current session to commands through `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. Injection happens before `spawnHook`, so hooks receive these values in `env` and preserve them when they spread the existing environment as above. Set `exposeSessionEnvironment: false` to disable them:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
});
```

See [Shell tool session environment](environment-variables.md#shell-tool-session-environment) for variable semantics. See [examples/extensions/ssh.ts](../examples/extensions/ssh.ts) for a complete SSH example with `--ssh` flag.

### Output Truncation

**Tools MUST truncate their output** to avoid overwhelming the LLM context. Large outputs can cause:
- Context overflow errors (prompt too long)
- Compaction failures
- Degraded model performance

The built-in limit is **50KB** (~10k tokens) and **2000 lines**, whichever is hit first. Use the exported truncation utilities:

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (good for file reads, search results)
  truncateTail,      // Keep last N lines/bytes (good for logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size (e.g., "50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@earendil-works/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // Apply truncation
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // Write full output to temp file
    const tempFile = writeTempFile(output);

    // Inform the LLM where to find complete output
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**Key points:**
- Use `truncateHead` for content where the beginning matters (search results, file reads)
- Use `truncateTail` for content where the end matters (logs, command output)
- Always inform the LLM when output is truncated and where to find the full version
- Document the truncation limits in your tool's description

See [examples/extensions/truncated-tool.ts](../examples/extensions/truncated-tool.ts) for a complete example wrapping `rg` (ripgrep) with proper truncation.

### Multiple Tools

One extension can register multiple tools with shared state:

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;

  pi.registerTool({ name: "db_connect", ... });
  pi.registerTool({ name: "db_query", ... });
  pi.registerTool({ name: "db_close", ... });

  pi.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### Custom Rendering

Tools can provide `renderCall` and `renderResult` for custom TUI display. See [tui.md](tui.md) for the full component API and [tool-execution.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) for how tool rows are composed.

By default, tool output is wrapped in a `Box` that handles padding and background. A defined `renderCall` or `renderResult` must return a `Component`. If a slot renderer is not defined, `tool-execution.ts` uses fallback rendering for that slot.

Set `renderShell: "self"` when the tool should render its own shell instead of using the default `Box`. This is useful for tools that need complete control over framing or background behavior, for example large previews that must stay visually stable after the tool settles.

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` and `renderResult` each receive a `context` object with:
- `args` - the current tool call arguments
- `state` - shared row-local state across `renderCall` and `renderResult`
- `lastComponent` - the previously returned component for that slot, if any
- `invalidate()` - request a rerender of this tool row
- `toolCallId`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`

Use `context.state` for cross-slot shared state. Keep slot-local caches on the returned component instance when you want to reuse and mutate the same component across renders.

#### renderCall

Renders the tool call or header:

```typescript
import { Text } from "@earendil-works/pi-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

Renders the tool result or output:

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

If a slot intentionally has no visible content, return an empty `Component` such as an empty `Container`.

#### Keybinding Hints

Use `keyHint()` to display keybinding hints that respect the active keybinding configuration:

```typescript
import { keyHint } from "@earendil-works/pi-coding-agent";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded) {
    text += ` (${keyHint("app.tools.expand", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

Available functions:
- `keyHint(keybinding, description)` - Formats a configured keybinding id such as `"app.tools.expand"` or `"tui.select.confirm"`
- `keyText(keybinding)` - Returns the raw configured key text for a keybinding id
- `rawKeyHint(key, description)` - Format a raw key string

Use namespaced keybinding ids:
- Coding-agent ids use the `app.*` namespace, for example `app.tools.expand`, `app.editor.external`, `app.session.rename`
- Shared TUI ids use the `tui.*` namespace, for example `tui.select.confirm`, `tui.select.cancel`, `tui.input.tab`

For the exhaustive list of keybinding ids and defaults, see [keybindings.md](keybindings.md). `keybindings.json` uses those same namespaced ids.

Custom editors and `ctx.ui.custom()` components receive `keybindings: KeybindingsManager` as an injected argument. They should use that injected manager directly instead of calling `getKeybindings()` or `setKeybindings()`.

#### Best Practices

- Use `Text` with padding `(0, 0)`. The default Box handles padding.
- Use `\n` for multi-line content.
- Handle `isPartial` for streaming progress.
- Support `expanded` for detail on demand.
- Keep default view compact.
- Read `context.args` in `renderResult` instead of copying args into `context.state`.
- Use `context.state` only for data that must be shared across call and result slots.
- Reuse `context.lastComponent` when the same component instance can be updated in place.
- Use `renderShell: "self"` only when the default boxed shell gets in the way. In self-shell mode the tool is responsible for its own framing, padding, and background.

#### Fallback

If a slot renderer is not defined or throws:
- `renderCall`: Shows the tool name
- `renderResult`: Shows raw text from `content`

### Dynamic Tool Loading

Extensions can register many tools while keeping only a small initial set active. A tool can then add more tools with `pi.setActiveTools()` during execution. Pi detects purely additive changes, records the newly available tool names on that tool result, and applies the updated active set before the next model request.

This works with every model. Models with native deferred-loading support preserve the stable prompt prefix and load the new definitions at the tool-result position. Other models use the fallback described below.

The lifecycle is:

1. Register every tool with `pi.registerTool()` so it appears in `pi.getAllTools()`.
2. Keep loader tools, such as `search_tools`, active and leave searchable tools inactive.
3. During loader execution, call `pi.setActiveTools([...currentTools, ...matchingTools])`. The change must be additive: do not remove currently active tools in the same call.
4. Pi records which tools were added on the loader's tool result.
5. Before the next model response, Pi exposes the added definitions using native deferred loading when supported, or the normal active tool list otherwise.

You do not need to return provider-specific tool references or mark the loader as a special search tool. The active-tool change is the signal. Names passed to `pi.setActiveTools()` must already be registered; unknown names are ignored.

#### Models with native deferred loading

- **Anthropic**
  - **Models:** Sonnet, Opus, Fable version 4.5 or newer (without Haiku)
  - **Native representation:** Deferred definitions use `defer_loading`; the load point uses `tool_reference` content.
- **OpenAI**
  - **Models:** `gpt-5.4` and newer family
  - **Native representation:** Pi adds completed client `tool_search_call` and `tool_search_output` items at the load point.

For a verified custom model or proxy, native handling can be enabled with `compat.supportsToolReferences: true` for `anthropic-messages`, or `compat.supportsToolSearch: true` for `openai-responses` and `openai-codex-responses`. Leave these disabled unless the endpoint and model accept the corresponding native protocol.

#### Fallback behavior

For all other models and providers, dynamic activation still works: Pi sends the complete current active tool list normally on the next request. The model can call the newly activated tools, but adding their definitions may invalidate the provider's cached prompt prefix.

Pi also uses this safe fallback when the active set is not purely additive, such as replacing one group of tools with another. Tool removals therefore work, but they do not use deferred loading.

For the best cache behavior, keep the loader tool active for the whole session and add tools instead of replacing the active set. Also note that activating a tool with `promptSnippet` or `promptGuidelines` rebuilds the system prompt; that system-prompt change can invalidate the prefix even when the provider supports deferred schemas. Lazily loaded tools should usually rely on their tool `description` and omit active-only prompt metadata.

#### Search tool example

The following extension registers two searchable tools, removes them from the initial active set, and keeps only `search_tools` as their loader. The example uses simple keyword matching, but the search implementation could use BM25, embeddings, a remote catalog, or project-specific routing.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCHABLE_TOOL_NAMES = new Set(["lookup_weather", "search_issues"]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lookup_weather",
    label: "Lookup Weather",
    description: "Look up the current weather for a city",
    parameters: Type.Object({ city: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Weather for ${params.city}: sunny` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_issues",
    label: "Search Issues",
    description: "Search project issues by keyword",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `No open issues matching ${params.query}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description: "Search for and enable tools relevant to a task",
    promptSnippet: "Search for additional tools when the active tools cannot perform the task",
    promptGuidelines: [
      "Use search_tools when a task requires a capability that is not currently available.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or task to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params) {
      const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const matches = pi.getAllTools()
        .filter((tool) => SEARCHABLE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          tool,
          score: terms.reduce(
            (score, term) =>
              score + (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit ?? 3)
        .map((match) => match.tool.name);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No tools found for: ${params.query}` }],
          details: { matches: [] },
        };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [{
          type: "text",
          text: added.length > 0
            ? `Loaded tools: ${added.join(", ")}`
            : `Matching tools already active: ${matches.join(", ")}`,
        }],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    // Keep searchable tools registered but initially inactive. Preserve built-ins
    // and tools owned by other extensions, and keep the loader itself active.
    const initialTools = pi.getActiveTools().filter(
      (name) => !SEARCHABLE_TOOL_NAMES.has(name),
    );
    pi.setActiveTools([...new Set([...initialTools, "search_tools"])]);
  });
}
```

When `search_tools` adds a match, the model receives that definition on the immediately following request. On a native-capable model the definition is anchored after the search result without changing the initial tool-schema prefix. On other models it appears in the normal tool list on that same following request.

## Custom UI

Extensions can interact with users via `ctx.ui` methods and customize how messages/tools render.

**For custom components, see [tui.md](tui.md)** which has copy-paste patterns for:
- Selection dialogs (SelectList)
- Async operations with cancel (BorderedLoader)
- Settings toggles (SettingsList)
- Status indicators (setStatus)
- Working message, visibility, and indicator during streaming (`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`)
- Widgets above/below editor (setWidget)
- Autocomplete providers layered on top of built-in slash/path completion (addAutocompleteProvider)
- Custom footers (setFooter)

### Dialogs

```typescript
// Select from options
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled text");

// Notification (non-blocking)
ctx.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

#### Timed Dialogs with Countdown

Dialogs support a `timeout` option that auto-dismisses with a live countdown display:

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // User confirmed
} else {
  // User cancelled or timed out
}
```

**Return values on timeout:**
- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` returns `undefined`

#### Manual Dismissal with AbortSignal

For more control (e.g., to distinguish timeout from user cancel), use `AbortSignal`:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Dialog timed out
} else {
  // User cancelled (pressed Escape or selected "No")
}
```

See [examples/extensions/timed-confirm.ts](../examples/extensions/timed-confirm.ts) for complete examples.

### Widgets, Status, and Footer

```typescript
// Status in footer (persistent until cleared)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);  // Clear

// Working loader (shown during streaming)
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();  // Restore default
ctx.ui.setWorkingVisible(false);  // Hide the built-in working loader row entirely
ctx.ui.setWorkingVisible(true);   // Show the built-in working loader row

// Working indicator (shown during streaming)
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // Static dot
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] });  // Hide indicator
ctx.ui.setWorkingIndicator();  // Restore default spinner

// Widget above editor (default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// Widget below editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);  // Clear

// Custom footer (replaces built-in footer entirely)
ctx.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);  // Restore built-in footer

// Terminal title
ctx.ui.setTitle("pi - my-project");

// Editor text
ctx.ui.setEditorText("Prefill text");
const current = ctx.ui.getEditorText();

// Paste into editor (triggers paste handling, including collapse for large content)
ctx.ui.pasteToEditor("pasted content");

// Stack custom autocomplete behavior on top of the built-in provider
ctx.ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#2983", label: "#2983", description: "Extension API for autocomplete" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// Tool output expansion
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// Custom editor (vim mode, emacs mode, etc.)
ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ctx.ui.setEditorComponent(undefined);  // Restore default editor

// Theme management (see themes.md for creating themes)
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");  // Load without switching
const result = ctx.ui.setTheme("light");  // Switch by name
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
ctx.ui.setTheme(lightTheme!);  // Or switch by Theme object
ctx.ui.theme.fg("accent", "styled text");  // Access current theme
```

Custom working-indicator frames are rendered verbatim. If you want colors, add them to the frame strings yourself, for example with `ctx.ui.theme.fg(...)`.

### Autocomplete Providers

Use `ctx.ui.addAutocompleteProvider()` to stack custom autocomplete logic on top of the built-in slash-command and path provider. Set `triggerCharacters` for custom natural triggers such as `$`.

Typical pattern:

- inspect the text before the cursor
- return your own suggestions when your extension-specific syntax matches
- otherwise delegate to `current.getSuggestions(...)`
- delegate `applyCompletion(...)` unless you need custom insertion behavior

```typescript
pi.on("session_start", (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#2983", label: "#2983", description: "Extension API for registering custom @ autocomplete providers" },
          { value: "#2753", label: "#2753", description: "Reload stale resource settings" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

See [github-issue-autocomplete.ts](../examples/extensions/github-issue-autocomplete.ts) for a complete example that preloads the latest open GitHub issues with `gh issue list` and filters them locally for fast `#...` completion. It requires GitHub CLI (`gh`) and a GitHub repository checkout.

### Custom Components

For complex UI, use `ctx.ui.custom()`. This temporarily replaces the editor with your component until `done()` is called:

```typescript
import { Text, Component } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("Press Enter to confirm, Escape to cancel", 1, 1);

  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };

  return text;
});

if (result) {
  // User pressed Enter
}
```

The callback receives:
- `tui` - TUI instance (for screen dimensions, focus management)
- `theme` - Current theme for styling
- `keybindings` - App keybinding manager (for checking shortcuts)
- `done(value)` - Call to close component and return value

See [tui.md](tui.md) for the full component API.

#### Overlay Mode (Experimental)

Pass `{ overlay: true }` to render the component as a floating modal on top of existing content, without clearing the screen:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

For advanced positioning (anchors, margins, percentages, responsive visibility), pass `overlayOptions`. Use `onHandle` to control focus or visibility programmatically:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (handle) => {
      handle.focus(); // focus this overlay and bring it to the visual front
      // handle.unfocus({ target: editorComponent }); // release input to a specific component
      // handle.setHidden(true/false); // toggle visibility
      // handle.hide(); // permanently remove
    }
  }
);
```

A focused visible overlay can reclaim input after temporary non-overlay custom UI closes. If you intentionally want another component to keep input while the overlay stays visible, call `handle.unfocus({ target })`. Passing `{ target: null }` releases the overlay without focusing another component.

See [tui.md](tui.md) for the full `OverlayOptions` and `OverlayHandle` API and [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts) for examples.

### Custom Editor

Replace the main input editor with a custom implementation (vim mode, emacs mode, etc.):

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return;
    }
    super.handleInput(data);  // App keybindings + text editing
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**Key points:**
- Extend `CustomEditor` (not base `Editor`) to get app keybindings (escape to abort, ctrl+d, model switching)
- Call `super.handleInput(data)` for keys you don't handle
- Custom editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to use the built-in editor-border spinner instead.
- Factory receives `tui`, `theme`, and `keybindings` from the app
- Use `ctx.ui.getEditorComponent()` before `setEditorComponent()` to wrap the previously configured custom editor
- Pass `undefined` to restore default: `ctx.ui.setEditorComponent(undefined)`

To compose with another extension that already replaced the editor, capture the previous factory before setting yours:

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

See [tui.md](tui.md) Pattern 7 for a complete example with mode indicator.

### Message and Entry Rendering

Register a custom renderer for messages with your `customType`. Use message renderers for content that should participate in LLM context:

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, outputPad, 0);
});
```

Messages are sent via `pi.sendMessage()`:

```typescript
pi.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

For TUI-only content that should not be sent to the LLM, render custom entries instead:

```typescript
pi.registerEntryRenderer("my-card", (entry, options, theme) => {
  return new Text(theme.fg("accent", JSON.stringify(entry.data)));
});

pi.appendEntry("my-card", { status: "done" });
```

### Theme Colors

All render functions receive a `theme` object. See [themes.md](themes.md) for creating custom themes and the full color palette.

```typescript
// Foreground colors
theme.fg("toolTitle", text)   // Tool names
theme.fg("accent", text)      // Highlights
theme.fg("success", text)     // Success (green)
theme.fg("error", text)       // Errors (red)
theme.fg("warning", text)     // Warnings (yellow)
theme.fg("muted", text)       // Secondary text
theme.fg("dim", text)         // Tertiary text

// Text styles
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

For syntax highlighting in custom tool renderers:

```typescript
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";

// Highlight code with explicit language
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// Auto-detect language from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

## Error Handling

- Extension errors are logged, agent continues
- `tool_call` errors block the tool (fail-safe)
- Tool `execute` errors must be signaled by throwing; the thrown error is caught, reported to the LLM with `isError: true`, and execution continues

## Mode Behavior

| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|------|------------|-------------|-------|
| Interactive | `"tui"` | `true` | Full TUI with terminal rendering |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs and notifications via JSON protocol; `custom()` returns `undefined`. See [rpc.md](rpc.md) |
| JSON (`--mode json`) | `"json"` | `false` | Event stream to stdout; UI methods are no-ops |
| Print (`-p`) | `"print"` | `false` | Extensions run but can't prompt |

Use `ctx.mode === "tui"` before TUI-specific features (`custom()`, component factories, terminal input). Use `ctx.hasUI` before dialog and notification methods that work in both TUI and RPC modes.

## Examples Reference

All examples in [examples/extensions/](../examples/extensions/).

| Example | Description | Key APIs |
|---------|-------------|----------|
| **Tools** |||
| `hello.ts` | Minimal tool registration | `registerTool` |
| `question.ts` | Tool with user interaction | `registerTool`, `ui.select` |
| `questionnaire.ts` | Multi-step wizard tool | `registerTool`, `ui.custom` |
| `todo.ts` | Stateful tool with persistence | `registerTool`, `appendEntry`, `renderResult`, session events |
| `dynamic-tools.ts` | Register tools after startup and during commands | `registerTool`, `session_start`, `registerCommand` |
| `structured-output.ts` | Final structured-output tool with `terminate: true` | `registerTool`, terminating tool results |
| `truncated-tool.ts` | Output truncation example | `registerTool`, `truncateHead` |
| `tool-override.ts` | Override built-in read tool | `registerTool` (same name as built-in) |
| **Commands** |||
| `pirate.ts` | Modify system prompt per-turn | `registerCommand`, `before_agent_start` |
| `summarize.ts` | Conversation summary command | `registerCommand`, `ui.custom` |
| `handoff.ts` | Cross-provider model handoff | `registerCommand`, `ui.editor`, `ui.custom` |
| `qna.ts` | Q&A with custom UI | `registerCommand`, `ui.custom`, `setEditorText` |
| `send-user-message.ts` | Inject user messages | `registerCommand`, `sendUserMessage` |
| `reload-runtime.ts` | Reload command and LLM tool handoff | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| `shutdown-command.ts` | Graceful shutdown command | `registerCommand`, `shutdown()` |
| **Events & Gates** |||
| `permission-gate.ts` | Block dangerous commands | `on("tool_call")`, `ui.confirm` |
| `project-trust.ts` | Decide or defer project trust from a user/global or CLI extension | `on("project_trust")`, trust UI, required trust result |
| `protected-paths.ts` | Block writes to specific paths | `on("tool_call")` |
| `confirm-destructive.ts` | Confirm session changes | `on("session_before_switch")`, `on("session_before_fork")` |
| `dirty-repo-guard.ts` | Warn on dirty git repo | `on("session_before_*")`, `exec` |
| `input-transform.ts` | Transform user input | `on("input")` |
| `input-transform-streaming.ts` | Streaming-aware input transform | `on("input")`, `streamingBehavior` |
| `model-status.ts` | React to model changes | `on("model_select")`, `setStatus` |
| `provider-payload.ts` | Inspect payloads and provider response headers | `on("before_provider_request")`, `on("after_provider_response")` |
| `system-prompt-header.ts` | Display system prompt info | `on("agent_start")`, `getSystemPrompt` |
| `claude-rules.ts` | Load rules from files | `on("session_start")`, `on("before_agent_start")` |
| `prompt-customizer.ts` | Add context-aware tool guidance using `systemPromptOptions` | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| `file-trigger.ts` | File watcher triggers messages | `sendMessage` |
| **Compaction & Sessions** |||
| `custom-compaction.ts` | Custom compaction summary | `on("session_before_compact")` |
| `trigger-compact.ts` | Trigger compaction manually | `compact()` |
| `git-checkpoint.ts` | Git stash on turns | `on("turn_start")`, `on("session_before_fork")`, `exec` |
| `git-merge-and-resolve.ts` | Fetch, merge, and resolve conflicts | `on("agent_end")`, `exec`, `sendUserMessage` |
| `auto-commit-on-exit.ts` | Commit on shutdown | `on("session_shutdown")`, `exec` |
| **UI Components** |||
| `status-line.ts` | Footer status indicator | `setStatus`, session events |
| `working-indicator.ts` | Customize the streaming working indicator | `setWorkingIndicator`, `registerCommand` |
| `github-issue-autocomplete.ts` | Add `#1234` issue completions on top of built-in autocomplete by preloading recent open issues from `gh issue list` | `addAutocompleteProvider`, `on("session_start")`, `exec` |
| `custom-footer.ts` | Replace footer entirely | `registerCommand`, `setFooter` |
| `custom-header.ts` | Replace startup header | `on("session_start")`, `setHeader` |
| `modal-editor.ts` | Vim-style modal editor | `setEditorComponent`, `CustomEditor` |
| `rainbow-editor.ts` | Custom editor styling | `setEditorComponent` |
| `widget-placement.ts` | Widget above/below editor | `setWidget` |
| `overlay-test.ts` | Overlay components | `ui.custom` with overlay options |
| `overlay-qa-tests.ts` | Comprehensive overlay tests | `ui.custom`, all overlay options |
| `notify.ts` | Simple notifications | `ui.notify` |
| `timed-confirm.ts` | Dialogs with timeout | `ui.confirm` with timeout/signal |
| `mac-system-theme.ts` | Auto-switch theme | `setTheme`, `exec` |
| **Complex Extensions** |||
| `plan-mode/` | Full plan mode implementation | All event types, `registerCommand`, `registerShortcut`, `registerFlag`, `setStatus`, `setWidget`, `sendMessage`, `setActiveTools` |
| `preset.ts` | Saveable presets (model, tools, thinking) | `registerCommand`, `registerShortcut`, `registerFlag`, `setModel`, `setActiveTools`, `setThinkingLevel`, `appendEntry` |
| `tools.ts` | Toggle tools on/off UI | `registerCommand`, `setActiveTools`, `SettingsList`, session events |
| **Remote & Sandbox** |||
| `ssh.ts` | SSH remote execution | `registerFlag`, `on("user_bash")`, `on("before_agent_start")`, tool operations |
| `interactive-shell.ts` | Persistent shell session | `on("user_bash")` |
| `sandbox/` | Sandboxed tool execution | Tool operations |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM | Tool operations, built-in tool overrides, `on("user_bash")` |
| `subagent/` | Spawn sub-agents | `registerTool`, `exec` |
| **Games** |||
| `snake.ts` | Snake game | `registerCommand`, `ui.custom`, keyboard handling |
| `space-invaders.ts` | Space Invaders game | `registerCommand`, `ui.custom` |
| `doom-overlay/` | Doom in overlay | `ui.custom` with overlay |
| **Providers** |||
| `custom-provider-anthropic/` | Custom Anthropic proxy | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo integration | `registerProvider` with OAuth |
| **Messages & Communication** |||
| `message-renderer.ts` | Custom message rendering | `registerMessageRenderer`, `sendMessage` |
| `entry-renderer.ts` | TUI-only custom entry rendering | `registerEntryRenderer`, `appendEntry` |
| `event-bus.ts` | Inter-extension events | `pi.events` |
| **Session Metadata** |||
| `session-name.ts` | Name sessions for selector | `setSessionName`, `getSessionName` |
| `bookmark.ts` | Bookmark entries for /tree | `setLabel` |
| **Misc** |||
| `inline-bash.ts` | Inline bash in tool calls | `on("tool_call")` |
| `bash-spawn-hook.ts` | Adjust bash command, cwd, and env before execution | `createBashTool`, `spawnHook` |
| `with-deps/` | Extension with npm dependencies | Package structure with `package.json` |


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/packages.md

> pi can help you create pi packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Pi Packages

Pi packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `pi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Pi Package](#creating-a-pi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # show installed packages from settings
pi update                   # update pi only
pi update --all             # update pi, update packages, and reconcile pinned git refs
pi update --extensions      # update packages and reconcile pinned git refs only
pi update --models          # refresh model catalogs only
pi update --self            # update pi only
pi update --self --force    # reinstall pi even if current
pi update npm:@foo/bar      # update one package
pi update --extension npm:@foo/bar
```

These commands manage pi packages and `pi update` can update the pi CLI installation. For experimental installer-managed installations, `pi update` installs the exact checked version into a staged, lockfile-backed release and activates it only after verification, leaving the current release intact if the update fails. Managed installations do not support `--force`; rerun the installer to repair one. To uninstall pi itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.pi/agent/settings.json`). Use `-l` to write to project settings (`.pi/settings.json`) instead. Project settings can be shared with your team, and pi installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## Package Sources

Pi accepts three source types in settings and `pi install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`pi update --extensions`, `pi update --all`).
- User installs go under `~/.pi/agent/npm/`.
- Project installs go under `.pi/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `pi update --extensions` and `pi update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `pi install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project).
- When reconciliation changes the checkout, pi resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
pi install git:git@github.com:user/repo

# ssh:// protocol format
pi install ssh://git@github.com/user/repo

# With version ref
pi install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, pi loads resources using package rules.

## Creating a Pi Package

Add a `pi` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`. Positive manifest globs discover visible paths in lexical order. List dot-prefixed paths directly. If a glob would need to continue through a symlink, list the symlinked resource root directly.

### Gallery Metadata

The [package gallery](https://pi.dev/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `pi` manifest is present, pi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When pi installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Pi bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

Other pi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Pi loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `pi config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `pi config` starts in global settings (`~/.pi/agent/settings.json`); press Tab to switch between global and project-local modes. Use `pi config -l` to start in project overrides (`.pi/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/rpc.md

# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@earendil-works/pi-coding-agent` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Starting RPC Mode

```bash
pi --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`. `bash_execution_update` events also include the `id` of their originating `bash` command.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `pi.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current operation and wait for the session to become idle before responding.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### clear_queue

Remove queued steering and follow-up messages and return their text.

```json
{"type": "clear_queue"}
```

Response:
```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction"],
    "followUp": ["Summarize when finished"]
  }
}
```

To implement interactive Esc behavior, send `clear_queue` before `abort`, then restore the returned text in the client editor. `abort` continues queued messages when they remain in the session.

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model) object or `null`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose both.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Include an `id` to associate streamed `bash_execution_update` events with this command.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
```json
{"type": "get_entries", "since": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `pi --mode rpc` process.

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.pi/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.pi/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.pi/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `pi.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.pi/agent/`)
  - `"project"`: Project-level (`./.pi/agent/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do not generally include an `id` field; `bash_execution_update` includes the `id` of its originating `bash` command when one was provided.

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | One low-level agent run completes (may still be followed by retry, compaction, or queued continuations) |
| `agent_settled` | Agent run is fully settled; no automatic retry, compaction retry, or queued continuation remains |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

Emitted after the full session-level run settles. At this point Pi will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains a delta event without a cumulative message snapshot.

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started (includes `id` and `toolName`) |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

The top-level `usage` field contains the latest cumulative provider-reported usage. It may remain
zero until completion when a provider does not report usage during streaming.

Example starting a tool call:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_abc123","toolName":"write"}}
```

`message_update` intentionally omits the former cumulative `message` field and
`assistantMessageEvent.partial`. Clients that need a live partial message must assemble it
from `message_start` and subsequent events using `contentIndex`. Treat `message_end.message`
as authoritative. For tool calls, `toolcall_start` provides the call `id` and `toolName`;
buffer `toolcall_delta.delta` for arguments. `toolcall_end.toolCall` contains the completed
call.

### bash_execution_update

Emitted once for each output chunk from a direct `bash` command. `id` matches the command's `id`, allowing clients to associate output with the correct command.

Events stream all output while the command runs, even if the final `bash` response's `output` is truncated.

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when compaction or branch-summary summarization retries after a transient provider error. These events use the same retry settings as automatic assistant-turn retries.

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

For branch summaries, `source` is `"branchSummary"` and no `reason` is present.

```json
{
  "type": "summarization_retry_finished"
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "pi - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` is optional and reports nested LLM work performed by the tool. When present, it contributes to session token and cost totals.

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("pi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/session-format.md

# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Where `<path>` is the working directory with `/` replaced by `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Source Files

Source on GitHub ([pi-mono](https://github.com/earendil-works/pi-mono)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (from pi-ai)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  usage?: Usage;      // Nested LLM work performed by the tool
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

The exported pi-ai `StopReason` type also includes `"pending"`, but that value is reserved for partial messages in streaming events. Terminal `done`/`error` messages replace it with a completion reason before pi persists the assistant message, so `"pending"` should never appear in session JSONL.

### Extended Message Types (from pi-coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Newer harness-generated compactions embed the retained post-compaction context directly on the entry, instead of `firstKeptEntryId`:

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","tokensBefore":50000,"retainedTail":[{"role":"user","content":"latest request"},{"role":"assistant","content":[{"type":"text","text":"latest reply"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}]}
```

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `retainedTail`: Materialized `AgentMessage[]` kept after compaction. This is optional only for backward compatibility with older sessions. Newer harness-generated compactions include it so we can rebuild context from this checkpoint without walking older entries before the compaction entry.
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)
- `firstKeptEntryId`: for compatibility with old entry format.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` walks from the current leaf to the root, producing the active entry list while honoring compaction:

1. Collects all entries on the path
2. If a `CompactionEntry` is on the path:
   - Includes the compaction entry first
   - If `retainedTail` is present, it acts as a self-contained checkpoint and entries after the compaction are included
   - Otherwise entries from `firstKeptEntryId` to the compaction are included
   - Then entries after compaction are included
3. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionContext()` builds on that entry list to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `compaction` -> `compactionSummary` plus `retainedTail` when present
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `custom` -> no context message

This makes newer compactions act like self-contained checkpoints. `retainedTail` is optional only so older sessions that only store `firstKeptEntryId` continue to load correctly.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?)` - List all sessions across all projects

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildContextEntries()` - Get active branch entries with compaction applied
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk


File: /home/entropybender/3rd/pi/packages/coding-agent/docs/tui.md

> pi can create TUI components. Ask it to build one for your use case.

# TUI Components

Extensions and custom tools can render custom TUI components for interactive user interfaces. This page covers the component system and available building blocks.

**Source:** [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)

## Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| Method | Description |
|--------|-------------|
| `render(width)` | Return array of strings (one per line). Each line **must not exceed `width`**. |
| `handleInput?(data)` | Receive keyboard input when component has focus. |
| `handleMouse?(event)` | Receive normalized pointer input in fullscreen mode. |
| `wantsKeyRelease?` | If true, component receives key release events (Kitty protocol). Default: false. |
| `invalidate()` | Clear cached render state. Called on theme changes. |

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines. If you emit multi-line text with styling, reapply styles per line or use `wrapTextWithAnsi()` so styles are preserved for each wrapped line.

## Focusable Interface (IME Support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // Emit marker right before the fake cursor
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

When a `Focusable` component has focus, TUI:
1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor only when `showHardwareCursor` is enabled

The cursor remains hidden by default. This keeps the fake cursor rendering, while still positioning the hardware cursor for terminals that track IME candidate windows with hidden cursors. Some terminals require a visible hardware cursor for IME positioning; enable it with the renderer's `showHardwareCursor` constructor argument or `setShowHardwareCursor(true)`. Pi also maps `PI_HARDWARE_CURSOR=1` to this setting before it creates its renderer. The `Editor` and `Input` built-in components already implement this interface.

### Container Components with Embedded Inputs

When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child. Otherwise, the hardware cursor won't be positioned correctly for IME input.

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Focusable implementation - propagate to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position on screen.

## Using Components

**In extensions** via `ctx.ui.custom()`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    new MyComponent({
      theme,
      keybindings,
      onChange: () => tui.requestRender(),
      onSelect: (value) => done(value),
      onCancel: () => done(null),
    })
  );
});
```

**In custom tools** via `ctx.ui.custom()`:

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    new MyComponent({
      theme,
      keybindings,
      onChange: () => tui.requestRender(),
      onSelect: (value) => done(value),
      onCancel: () => done(null),
    })
  );
  // Use result...
}
```

## Overlays

Overlays render components on top of existing content without clearing the screen. Pass `{ overlay: true }` to `ctx.ui.custom()`:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

For positioning and sizing, use `overlayOptions`:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // Size: number or percentage string
      width: "50%",          // 50% of terminal width
      minWidth: 40,          // minimum 40 columns
      maxHeight: "80%",      // max 80% of terminal height

      // Position: anchor-based (default: "center")
      anchor: "right-center", // 9 positions: center, top-left, top-center, etc.
      offsetX: -2,            // offset from anchor
      offsetY: 0,

      // Or percentage/absolute positioning
      row: "25%",            // 25% from top
      col: 10,               // column 10

      // Margins
      margin: 2,             // all sides, or { top, right, bottom, left }

      // Responsive: hide on narrow terminals
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
    // Get handle for programmatic focus and visibility control
    onHandle: (handle) => {
      // handle.focus() - focus this overlay and bring it to the visual front
      // handle.unfocus() - release input to normal fallback
      // handle.unfocus({ target }) - release input to a specific component or null
      // handle.setHidden(true/false) - toggle visibility
      // handle.hide() - permanently remove
    },
  }
);
```

### Overlay Focus

A focused visible overlay keeps input ownership across temporary non-overlay UI. If an overlay opens another `ctx.ui.custom()` component without `{ overlay: true }`, that replacement UI receives input while it is active; when it closes, the focused overlay can reclaim input.

Use `handle.unfocus()` when a visible overlay should stop owning input and let TUI fall back to another visible capturing overlay or the previous focus target. Use `handle.unfocus({ target })` when a specific component should receive input while the overlay stays visible. Passing `{ target: null }` intentionally leaves no focused component until focus is set again.

### Overlay Lifecycle

Overlay components are disposed when closed. Don't reuse references - create fresh instances:

```typescript
// Wrong - stale reference
let menu: MenuComponent;
await ctx.ui.custom((_, __, ___, done) => {
  menu = new MenuComponent(done);
  return menu;
}, { overlay: true });
setActiveComponent(menu);  // Disposed

// Correct - re-call to re-show
const showMenu = () => ctx.ui.custom((_, __, ___, done) => 
  new MenuComponent(done), { overlay: true });

await showMenu();  // First show
await showMenu();  // "Back" = just call again
```

See [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts) for comprehensive examples covering anchors, margins, stacking, responsive visibility, and animation.

## Built-in Components

Import from `@earendil-works/pi-tui`:

```typescript
import { Text, Box, Container, Spacer, Markdown } from "@earendil-works/pi-tui";
```

### Text

Multi-line text with word wrapping.

```typescript
const text = new Text(
  "Hello World",    // content
  1,                // paddingX (default: 1)
  1,                // paddingY (default: 1)
  (s) => bgGray(s)  // optional background function
);
text.setText("Updated");
```

### Box

Container with padding and background color.

```typescript
const box = new Box(
  1,                // paddingX
  1,                // paddingY
  (s) => bgGray(s)  // background function
);
box.addChild(new Text("Content", 0, 0));
box.setBgFn((s) => bgBlue(s));
```

### Container

Groups child components vertically.

```typescript
const container = new Container();
container.addChild(component1);
container.addChild(component2);
container.removeChild(component1);
```

### Spacer

Empty vertical space.

```typescript
const spacer = new Spacer(2);  // 2 empty lines
```

### Markdown

Renders markdown with syntax highlighting.

```typescript
const md = new Markdown(
  "# Title\n\nSome **bold** text",
  1,        // paddingX
  1,        // paddingY
  theme     // MarkdownTheme (see below)
);
md.setText("Updated markdown");
```

### Image

Renders images in supported terminals (Kitty, iTerm2, Ghostty, WezTerm, Warp).

```typescript
const image = new Image(
  base64Data,   // base64-encoded image
  "image/png",  // MIME type
  theme,        // ImageTheme
  { maxWidthCells: 80, maxHeightCells: 24 }
);
```

## Keyboard Input

Use `matchesKey()` for key detection:

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

handleInput(data: string) {
  if (matchesKey(data, Key.up)) {
    this.selectedIndex--;
  } else if (matchesKey(data, Key.enter)) {
    this.onSelect?.(this.selectedIndex);
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
  } else if (matchesKey(data, Key.ctrl("c"))) {
    // Ctrl+C
  }
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):
- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

## Mouse Input

Fullscreen mode routes normalized press, release, click, move, drag, and wheel events to components and overlays. Return `{ handled: true }` to suppress default behavior, `capture: true` to retain drag/release ownership, `focus: true` to request keyboard focus, and `render: true` when a hover or release visibly changes the component. Press, click, drag, and wheel render by default; no-op move/release events do not.

```typescript
import { MouseRegion } from "@earendil-works/pi-tui";

const clickable = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

Unhandled wheel input scrolls the nearest `ScrollView`; unhandled primary-button drags retain transcript selection. OSC 8 links take precedence over parent click regions. `Input`, `Editor`, `SelectList`, and `SettingsList` include fullscreen mouse behavior. Regular mode does not capture mouse input because the terminal owns its scrollback.

## Line Width

**Critical:** Each line from `render()` must not exceed the `width` parameter.

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

render(width: number): string[] {
  // Truncate long lines
  return [truncateToWidth(this.text, width)];
}
```

Utilities:
- `visibleWidth(str)` - Get display width (ignores ANSI codes)
- `truncateToWidth(str, width, ellipsis?)` - Truncate with optional ellipsis
- `wrapTextWithAnsi(str, width)` - Word wrap preserving ANSI codes

## Creating Custom Components

Example: Interactive selector

```typescript
import {
  matchesKey, Key,
  truncateToWidth, visibleWidth
} from "@earendil-works/pi-tui";

class MySelector {
  private items: string[];
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  
  public onSelect?: (item: string) => void;
  public onCancel?: () => void;

  constructor(items: string[]) {
    this.items = items;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.items[this.selected]);
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.items.map((item, i) => {
      const prefix = i === this.selected ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Usage in an extension:

```typescript
pi.registerCommand("pick", {
  description: "Pick an item",
  handler: async (_args, ctx) => {
    const items = ["Option A", "Option B", "Option C"];
    const selected = await ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
      const selector = new MySelector(items);
      selector.onSelect = done;
      selector.onCancel = () => done(null);

      return {
        render: (width) => selector.render(width),
        handleInput: (data) => {
          selector.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => selector.invalidate(),
      };
    });

    if (selected !== null) {
      ctx.ui.notify(`Selected: ${selected}`, "info");
    }
  }
});
```

## Theming

Components accept theme objects for styling.

**In `renderCall`/`renderResult`**, use the `theme` parameter:

```typescript
renderResult(result, options, theme, context) {
  // Use theme.fg() for foreground colors
  return new Text(theme.fg("success", "Done!"), 0, 0);
  
  // Use theme.bg() for background colors
  const styled = theme.bg("toolPendingBg", theme.fg("accent", "text"));
}
```

**Foreground colors** (`theme.fg(color, text)`):

| Category | Colors |
|----------|--------|
| General | `text`, `accent`, `muted`, `dim`, `searchMatchText` |
| Status | `success`, `error`, `warning` |
| Borders | `border`, `borderAccent`, `borderMuted` |
| Messages | `userMessageText`, `customMessageText`, `customMessageLabel` |
| Tools | `toolTitle`, `toolOutput` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| Thinking | `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax` |
| Modes | `bashMode` |

**Background colors** (`theme.bg(color, text)`):

`selectedBg`, `searchMatchBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

**For Markdown**, use `getMarkdownTheme()`:

```typescript
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

renderResult(result, options, theme, context) {
  const mdTheme = getMarkdownTheme();
  return new Markdown(result.details.markdown, 0, 0, mdTheme);
}
```

**For custom components**, define your own theme interface:

```typescript
interface MyTheme {
  selected: (s: string) => string;
  normal: (s: string) => string;
}
```

## Debug logging

Set `PI_TUI_WRITE_LOG` to capture the raw ANSI stream written to stdout.

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx packages/tui/test/chat-simple.ts
```

## Performance

Cache rendered output when possible:

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // ... compute lines ...
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Call `invalidate()` when state changes, then use the injected `tui.requestRender()` to trigger re-render.

## Invalidation and Theme Changes

When the theme changes, the TUI calls `invalidate()` on all components to clear their caches. Components must properly implement `invalidate()` to ensure theme changes take effect.

### The Problem

If a component pre-bakes theme colors into strings (via `theme.fg()`, `theme.bg()`, etc.) and caches them, the cached strings contain ANSI escape codes from the old theme. Simply clearing the render cache isn't enough if the component stores the themed content separately.

**Wrong approach** (theme colors won't update):

```typescript
class BadComponent extends Container {
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    // Pre-baked theme colors stored in Text component
    this.content = new Text(theme.fg("accent", message), 1, 0);
    this.addChild(this.content);
  }
  // No invalidate override - parent's invalidate only clears
  // child render caches, not the pre-baked content
}
```

### The Solution

Components that build content with theme colors must rebuild that content when `invalidate()` is called:

```typescript
class GoodComponent extends Container {
  private message: string;
  private content: Text;

  constructor(message: string) {
    super();
    this.message = message;
    this.content = new Text("", 1, 0);
    this.addChild(this.content);
    this.updateDisplay();
  }

  private updateDisplay(): void {
    // Rebuild content with current theme
    this.content.setText(theme.fg("accent", this.message));
  }

  override invalidate(): void {
    super.invalidate();  // Clear child caches
    this.updateDisplay(); // Rebuild with new theme
  }
}
```

### Pattern: Rebuild on Invalidate

For components with complex content:

```typescript
class ComplexComponent extends Container {
  private data: SomeData;

  constructor(data: SomeData) {
    super();
    this.data = data;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();  // Remove all children

    // Build UI with current theme
    this.addChild(new Text(theme.fg("accent", theme.bold("Title")), 1, 0));
    this.addChild(new Spacer(1));

    for (const item of this.data.items) {
      const color = item.active ? "success" : "muted";
      this.addChild(new Text(theme.fg(color, item.label), 1, 0));
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
```

### When This Matters

This pattern is needed when:

1. **Pre-baking theme colors** - Using `theme.fg()` or `theme.bg()` to create styled strings stored in child components
2. **Syntax highlighting** - Using `highlightCode()` which applies theme-based syntax colors
3. **Complex layouts** - Building child component trees that embed theme colors

This pattern is NOT needed when:

1. **Using theme callbacks** - Passing functions like `(text) => theme.fg("accent", text)` that are called during render
2. **Simple containers** - Just grouping other components without adding themed content
3. **Stateless render** - Computing themed output fresh in every `render()` call (no caching)

## Common Patterns

These patterns cover the most common UI needs in extensions. **Copy these patterns instead of building from scratch.**

### Pattern 1: Selection Dialog (SelectList)

For letting users pick from a list of options. Use `SelectList` from `@earendil-works/pi-tui` with `DynamicBorder` for framing.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("pick", {
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "opt1", label: "Option 1", description: "First option" },
      { value: "opt2", label: "Option 2", description: "Second option" },
      { value: "opt3", label: "Option 3" },  // description is optional
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // Top border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      // Title
      container.addChild(new Text(theme.fg("accent", theme.bold("Pick an Option")), 1, 0));

      // SelectList with theme
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      // Help text
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

      // Bottom border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
      };
    });

    if (result) {
      ctx.ui.notify(`Selected: ${result}`, "info");
    }
  },
});
```

**Examples:** [preset.ts](../examples/extensions/preset.ts), [tools.ts](../examples/extensions/tools.ts)

### Pattern 2: Async Operation with Cancel (BorderedLoader)

For operations that take time and should be cancellable. `BorderedLoader` shows a spinner and handles escape to cancel.

```typescript
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

pi.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Fetching data...");
      loader.onAbort = () => done(null);

      // Do async work
      fetchData(loader.signal)
        .then((data) => done(data))
        .catch(() => done(null));

      return loader;
    });

    if (result === null) {
      ctx.ui.notify("Cancelled", "info");
    } else {
      ctx.ui.setEditorText(result);
    }
  },
});
```

**Examples:** [qna.ts](../examples/extensions/qna.ts), [handoff.ts](../examples/extensions/handoff.ts)

### Pattern 3: Settings/Toggles (SettingsList)

For toggling multiple settings. Use `SettingsList` from `@earendil-works/pi-tui` with `getSettingsListTheme()`.

```typescript
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("settings", {
  handler: async (_args, ctx) => {
    const items: SettingItem[] = [
      { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
      { id: "color", label: "Color output", currentValue: "on", values: ["on", "off"] },
    ];

    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Settings")), 1, 1));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          // Handle value change
          ctx.ui.notify(`${id} = ${newValue}`, "info");
        },
        () => done(undefined),  // On close
        { enableSearch: true }, // Optional: enable fuzzy search by label
      );
      container.addChild(settingsList);

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => settingsList.handleInput?.(data),
      };
    });
  },
});
```

**Examples:** [tools.ts](../examples/extensions/tools.ts)

### Pattern 4: Persistent Status Indicator

Show status in the footer that persists across renders. Good for mode indicators.

```typescript
// Set status (shown in footer)
ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● active"));

// Clear status
ctx.ui.setStatus("my-ext", undefined);
```

**Examples:** [status-line.ts](../examples/extensions/status-line.ts), [plan-mode/index.ts](../examples/extensions/plan-mode/index.ts), [preset.ts](../examples/extensions/preset.ts)

### Pattern 4b: Working Indicator Customization

Customize the inline working indicator shown while pi is streaming a response.

```typescript
// Static indicator
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });

// Custom animated indicator
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});

// Hide the indicator entirely
ctx.ui.setWorkingIndicator({ frames: [] });

// Restore pi's default spinner
ctx.ui.setWorkingIndicator();
```

This only affects the normal streaming working indicator. Compaction and retry loaders keep their built-in styling. Custom frames are rendered verbatim, so extensions must add their own colors when needed.

**Examples:** [working-indicator.ts](../examples/extensions/working-indicator.ts)

### Pattern 5: Widgets Above/Below Editor

Show persistent content above or below the input editor. Good for todo lists, progress.

```typescript
// Simple string array (above editor by default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Render below the editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });

// Or with theme
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item, i) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return {
    render: () => lines,
    invalidate: () => {},
  };
});

// Clear
ctx.ui.setWidget("my-widget", undefined);
```

**Examples:** [plan-mode/index.ts](../examples/extensions/plan-mode/index.ts)

### Pattern 6: Custom Footer

Replace the footer. `footerData` exposes data not otherwise accessible to extensions.

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()), // reactive
}));

ctx.ui.setFooter(undefined); // restore default
```

Token stats available via `ctx.sessionManager.getBranch()` and `ctx.model`.

**Examples:** [custom-footer.ts](../examples/extensions/custom-footer.ts)

### Pattern 7: Custom Editor (vim mode, etc.)

Replace the main input editor with a custom implementation. Useful for modal editing (vim), different keybindings (emacs), or specialized input handling.

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): void {
    // Escape: switch to normal mode, or pass through for app handling
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        return;
      }
      // In normal mode, escape aborts agent (handled by CustomEditor)
      super.handleInput(data);
      return;
    }

    // Insert mode: pass everything to CustomEditor
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // Normal mode: vim-style navigation
    switch (data) {
      case "i": this.mode = "insert"; return;
      case "h": super.handleInput("\x1b[D"); return; // Left
      case "j": super.handleInput("\x1b[B"); return; // Down
      case "k": super.handleInput("\x1b[A"); return; // Up
      case "l": super.handleInput("\x1b[C"); return; // Right
    }
    // Pass unhandled keys to super (ctrl+c, etc.), but filter printable chars
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Add mode indicator to bottom border (use truncateToWidth for ANSI-safe truncation)
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      // Pass "" as ellipsis to avoid adding "..." when truncating
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Factory receives the TUI, theme, and keybindings from the app
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**Key points:**

- **Extend `CustomEditor`** (not base `Editor`) to get app keybindings (escape to abort, ctrl+d to exit, model switching, etc.)
- **Call `super.handleInput(data)`** for keys you don't handle
- **Working status**: custom editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to use the built-in editor-border spinner instead.
- **Factory pattern**: `setEditorComponent` receives a factory function that gets `tui`, `theme`, and `keybindings`
- **Pass `undefined`** to restore the default editor: `ctx.ui.setEditorComponent(undefined)`

**Examples:** [modal-editor.ts](../examples/extensions/modal-editor.ts)

## Key Rules

1. **Always use theme from callback** - Don't import theme directly. Use `theme` from the `ctx.ui.custom((tui, theme, keybindings, done) => ...)` callback.

2. **Always type DynamicBorder color param** - Write `(s: string) => theme.fg("accent", s)`, not `(s) => theme.fg("accent", s)`.

3. **Call tui.requestRender() after state changes** - In `handleInput`, call `tui.requestRender()` after updating state.

4. **Return the three-method object** - Custom components need `{ render, invalidate, handleInput }`.

5. **Use existing components** - `SelectList`, `SettingsList`, `BorderedLoader` cover 90% of cases. Don't rebuild them.

## Examples

- **Selection UI**: [examples/extensions/preset.ts](../examples/extensions/preset.ts) - SelectList with DynamicBorder framing
- **Async with cancel**: [examples/extensions/qna.ts](../examples/extensions/qna.ts) - BorderedLoader for LLM calls
- **Settings toggles**: [examples/extensions/tools.ts](../examples/extensions/tools.ts) - SettingsList for tool enable/disable
- **Status indicators**: [examples/extensions/plan-mode/index.ts](../examples/extensions/plan-mode/index.ts) - setStatus and setWidget
- **Working indicator**: [examples/extensions/working-indicator.ts](../examples/extensions/working-indicator.ts) - setWorkingIndicator
- **Custom footer**: [examples/extensions/custom-footer.ts](../examples/extensions/custom-footer.ts) - setFooter with stats
- **Custom editor**: [examples/extensions/modal-editor.ts](../examples/extensions/modal-editor.ts) - Vim-like modal editing
- **Snake game**: [examples/extensions/snake.ts](../examples/extensions/snake.ts) - Full game with keyboard input, game loop
- **Custom tool rendering**: [examples/extensions/todo.ts](../examples/extensions/todo.ts) - renderCall and renderResult


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/agent-session.ts

/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings();

		if (
			!model ||
			model.contextWindow <= 0 ||
			!shouldCompact(estimateContextTokens(context.messages).tokens, model.contextWindow, settings)
		) {
			return context;
		}

		await this._runAutoCompaction("threshold", false);
		return {
			...context,
			messages: this.agent.state.messages.slice(),
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash and custom messages before the new prompt
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.agent.state.messages.push(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamFunction,
			env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					env,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Case 1: remove the failed or truncated message from agent state, compact, and
			// retry once. The message remains in session history but is excluded from retry context.
			this._overflowRecoveryAttempted = true;
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;
		let fromExtension = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this._emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					env,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this._emitSessionCompactFailed({
					reason,
					aborted: true,
					willRetry: false,
					fromExtension,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				const formattedErrorMessage =
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: formattedErrorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage: formattedErrorMessage,
					aborted: false,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/messages.ts

/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/session-manager.ts

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ImageContent, type Message, type TextContent, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { APP_NAME, getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, undefined/false if pi-generated (backward compatible) */
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** Usage from the LLM call that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, false if pi-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// Skip malformed lines
		return null;
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// Validate session header before repairing the file.
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	if (pending) appendFileSync(resolvedFilePath, "\n");
	return entries;
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			const entries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);

			// If file was empty, initialize it with a valid session header. If it was
			// non-empty but did not parse as a pi session, fail without modifying it.
			if (entries.length === 0) {
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			this._loadEntries(entries);
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;

		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
		} else {
			this.newSession(options);
			this.fileEntries = this.fileEntries.concat(entries);
		}

		this._buildIndex();
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		if (!hasAssistant) {
			if (this.flushed) {
				appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
			} else {
				// Mark as not flushed so when assistant arrives, all entries get written
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			const fd = openSync(this.sessionFile, "wx");
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const fromId = this.leafId ?? "root";
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		const pathWithoutLabels: SessionEntry[] = [];
		const replacementByLabelId = new Map<string, string>();
		const pendingLabelIds: string[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") {
				pendingLabelIds.push(entry.id);
				continue;
			}
			for (const labelId of pendingLabelIds) {
				replacementByLabelId.set(labelId, entry.id);
			}
			pendingLabelIds.length = 0;
			pathWithoutLabels.push(
				entry.type === "compaction"
					? {
							...entry,
							parentId: pathParentId,
							firstKeptEntryId: replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId,
						}
					: { ...entry, parentId: pathParentId },
			);
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Only write the file now if it contains an assistant message.
			// Otherwise defer to _persist(), which creates the file on the
			// first assistant response, matching the newSession() contract
			// and avoiding the duplicate-header bug when _persist()'s
			// no-assistant guard later resets flushed to false.
			const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is only a discovery optimization. A full load remains
				// authoritative for legacy files with very large headers or prefixes.
				preloadedFileEntries = loadEntriesFromFile(resolvedPath);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

		// Copy all non-header entries from source
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
		);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/extensions/index.ts

/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
export type { SourceInfo } from "../source-info.ts";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.ts";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// App keybindings (for custom editors)
	AppKeybinding,
	AutocompleteProviderFactory,
	// Events - Tool (ToolCallEvent types)
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	// Context
	CompactOptions,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	EditToolCallEvent,
	EditToolResultEvent,
	// Message and Entry Rendering
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionMode,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepToolCallEvent,
	GrepToolResultEvent,
	InlineExtension,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	// Events - Message
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	PowerShellToolCallEvent,
	PowerShellToolResultEvent,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	// Tool execution mode
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.ts";
// Type guards
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/extensions/loader.ts

/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import * as _bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import type { KeyId } from "@earendil-works/pi-tui";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary, isBundledNode } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @earendil-works/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { readPiManifest } from "../pi-manifest.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

/** Modules available to extensions via virtualModules (for compiled binaries) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@earendil-works/pi-ai": _bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": _bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": _bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": _bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

const isNodeSeaBinary =
	("sea" in process.features && process.features.sea === true) ||
	process.getBuiltinModule("node:sea")?.isSea() === true;
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";

/**
 * Get aliases for jiti (used in built Node.js mode).
 * In compiled binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai/compat");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");
	const piAiProvidersEntry = resolveWorkspaceOrImport(
		"ai/dist/providers/all.js",
		"@earendil-works/pi-ai/providers/all",
	);

	_aliases = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiCompatEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai": piAiCompatEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		"@mariozechner/pi-ai/compat": piAiCompatEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai": piAiCompatEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

interface ExtensionCacheToken {
	cwd: string;
	generation: number;
}

export function clearExtensionCache(): void {
	extensionCache.clear();
	extensionCacheCwd = undefined;
	extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
	const resolvedCwd = resolvePath(cwd);
	if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
		clearExtensionCache();
	}
	extensionCacheCwd = resolvedCwd;
	return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(r) => r.provider.id !== name,
			);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return (
		cacheToken !== undefined &&
		extensionCacheCwd === cacheToken.cwd &&
		extensionCacheGeneration === cacheToken.generation
	);
}

async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// Compiled binaries and the bundled Node distribution use embedded modules.
		// Source TypeScript reuses host modules and root tsconfig paths. Unbundled
		// Node builds use dist aliases.
		...(isBunBinary || isNodeSeaBinary || isBundledNode
			? { virtualModules: VIRTUAL_MODULES, tryNative: false }
			: isTypeScriptSourceRuntime
				? { virtualModules: VIRTUAL_MODULES, tsconfigPaths: true }
				: { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function initializeExtension(
	factory: ExtensionFactory,
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<Extension> {
	const extension = createExtension(extensionPath, resolvedPath);
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const resolvedCwd = resolvePath(cwd);
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	useCache = false,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			cacheToken,
		);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}

export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/extensions/runner.ts

/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UIPromptKind,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const ext of extensionsResult.extensions) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private uiPromptDepth = 0;
	private activeUIPrompt: { kind: UIPromptKind; title?: string } | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
		this.mode = mode;
	}

	private wrapUIPromptContext(ui: ExtensionUIContext): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
		};
	}

	private withUIPrompt<T>(kind: UIPromptKind, title: string | undefined, run: () => Promise<T>): Promise<T> {
		const outerPrompt = this.uiPromptDepth++ === 0;
		if (outerPrompt) {
			this.activeUIPrompt = { kind, title };
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}

		const finish = () => {
			if (--this.uiPromptDepth > 0) return;
			this.uiPromptDepth = 0;

			const prompt = this.activeUIPrompt ?? { kind, title };
			this.activeUIPrompt = undefined;
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: prompt.kind,
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};

		try {
			return run().finally(finish);
		} catch (err) {
			finish();
			throw err;
		}
	}

	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		queueMicrotask(() => {
			void this.emit(event);
		});
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("user_bash");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);
					if (handlerResult) {
						return handlerResult as UserBashEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
				}
			}
		}

		return undefined;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_headers");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await handler(event, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		let currentSystemPrompt = systemPrompt;
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return currentSystemPrompt;
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) {
							messages.push(result.message);
						}
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							systemPromptModified = true;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await handler(event, ctx);
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/extensions/types.ts

/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ConstrainedSamplingConfig,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	ProviderHeaders,
	RefreshModelsContext,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	PowerShellToolDetails,
	PowerShellToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI Context
// ============================================================================

/** Options for extension UI dialogs. */
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
}

/** Placement for extension widgets. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for extension widgets. */
export interface ExtensionWidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	placement?: WidgetPlacement;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Show or hide the built-in interactive working loader row during streaming. */
	setWorkingVisible(visible: boolean): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so extensions must add their own colors.
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
	setHiddenThinkingLabel(label?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** Set a custom footer component, or undefined to restore the built-in footer.
	 *
	 * The factory receives a FooterDataProvider for data not otherwise accessible:
	 * git branch and extension statuses from setStatus(). Context usage is on
	 * ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), model info on ctx.model.
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** Called with the overlay handle after the overlay is shown. Use to control visibility. */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** Paste text into the editor, triggering paste handling (collapse for large content). */
	pasteToEditor(text: string): void;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/** Get the current text from the core input editor. */
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** Stack additional autocomplete behavior on top of the built-in provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * Set a custom editor component via factory function.
	 * Pass undefined to restore the default editor.
	 *
	 * The factory receives:
	 * - `theme`: EditorTheme for styling borders and autocomplete
	 * - `keybindings`: KeybindingsManager for app-level keybindings
	 *
	 * For full app keybinding support (escape, ctrl+d, model switching, etc.),
	 * extend `CustomEditor` from `@earendil-works/pi-coding-agent` and call
	 * `super.handleInput(data)` for keys you don't handle.
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** Get the currently configured custom editor factory, or undefined when using the default editor. */
	getEditorComponent(): EditorFactory | undefined;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with their names and file paths. */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** Load a theme by name without switching to it. Returns undefined if not found. */
	getTheme(name: string): Theme | undefined;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
	mode: ExtensionMode;
	/** Whether dialog-capable UI is available (true in TUI and RPC modes) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model<any> | undefined;
	/** Models scoped to this session (resolved from `--models` /
	 *  `enabledModels` settings against the available catalogue). Same set
	 *  the `/scoped-models` command shows. Empty when no scoping is
	 *  configured (all available models are usable). Read-only snapshot. */
	scopedModels: readonly ScopedModel[];
	/** Current thinking level, when provided by the session runtime. */
	thinkingLevel?: ThinkingLevel;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Whether project-local trust is active for this context. */
	isProjectTrusted(): boolean;
	/** The current abort signal, or undefined when the agent is not streaming. */
	signal: AbortSignal | undefined;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown pi and exit. Available in all contexts. */
	shutdown(): void;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Trigger compaction without awaiting completion. */
	compact(options?: CompactOptions): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get the current base system-prompt construction options. */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Fork from a specific entry, creating a new session file. */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Reload extensions, skills, prompts, themes, and context files. */
	reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	showImages: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
}

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
	promptSnippet?: string;
	/** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox) */
	parameters: TParams;
	/** Optional provider-side constrained sampling request for this tool. Set false to explicitly disable it, equivalent to leaving it undefined. */
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
	renderShell?: "default" | "self";

	/** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;

	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// Startup/Resource Events
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
	type: "session_start";
	/** Why this session start happened. */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	previousSessionFile?: string;
}

/** Fired when the current session metadata changes. */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** Current normalized session name. Undefined when the name is cleared. */
	name: string | undefined;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	willRetry: boolean;
	signal: AbortSignal;
}

/** Fired after context compaction succeeds */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	willRetry: boolean;
}

/** Fired after context compaction fails or is aborted */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** Error text when compaction failed for a non-abort reason. */
	errorMessage?: string;
	/** True when compaction was cancelled or aborted. */
	aborted: boolean;
	/** True when the aborted turn would have been retried after this compaction (overflow recovery) */
	willRetry: boolean;
	/** True when the failing compaction content came from a session_before_compact handler. */
	fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** Destination session file when shutting down due to session replacement. */
	targetSessionFile?: string;
}

/** Preparation data for tree navigation */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** Custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Label to attach to the branch summary entry */
	label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/**
 * Fired after request headers are assembled, before the provider HTTP call.
 * Handlers mutate `headers` in place (e.g. to inject tracing/session headers);
 * the return value is ignored. A `null` value deletes that header.
 */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

/** Fired after a provider response is received and before the response stream is consumed. */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** The raw user prompt text (after expansion). */
	prompt: string;
	/** Images attached to the user prompt, if any. */
	images?: ImageContent[];
	/** The fully assembled system prompt string. */
	systemPrompt: string;
	/** Structured options used to build the system prompt. Extensions can inspect this to understand what Pi loaded without re-discovering resources. */
	systemPromptOptions: BuildSystemPromptOptions;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run. */
export interface AgentSettledEvent {
	type: "agent_settled";
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Fired when Pi starts waiting on a blocking user-facing extension UI prompt. */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** Fired when Pi is no longer waiting on a blocking user-facing extension UI prompt. */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

// ============================================================================
// Model Events
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Source of user input */
export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
	type: "input";
	/** The input text */
	text: string;
	/** Attached images, if any */
	images?: ImageContent[];
	/** Where the input came from */
	source: InputSource;
	/** How the input will be delivered during streaming, or undefined when idle */
	streamingBehavior?: "steer" | "followUp";
}

/** Result from input event handler */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: PowerShellToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	/** Usage from the tool execution itself, if available. */
	usage?: Usage;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface PowerShellToolResultEvent extends ToolResultEventBase {
	toolName: "powershell";
	details: PowerShellToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
	| BashToolResultEvent
	| PowerShellToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// Type guards for ToolResultEvent
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isPowerShellToolResult(e: ToolResultEvent): e is PowerShellToolResultEvent {
	return e.toolName === "powershell";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "powershell", event: ToolCallEvent): event is PowerShellToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** Union of all event types */
export type ExtensionEvent =
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
	/** Custom operations to use for execution */
	operations?: BashOperations;
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	/** Override custom instructions for summarization */
	customInstructions?: string;
	/** Override whether customInstructions replaces the default prompt */
	replaceInstructions?: boolean;
	/** Override label to attach to the branch summary entry */
	label?: string;
}

// ============================================================================
// Message and Entry Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
	/** Horizontal padding configured by the outputPad setting. */
	outputPad: number;
}

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

export interface EntryRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 */
export interface ExtensionAPI {
	// =========================================================================
	// Event Subscription
	// =========================================================================

	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** Register a transformer for user and assistant Markdown before Pi renders it in the interactive transcript. */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** Register a custom renderer for CustomEntry. Custom entries do not participate in LLM context. */
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/** Send a custom message to the session. */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 * Set expandPromptTemplates to dispatch extension commands and expand skill commands and prompt templates.
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// Session Metadata
	// =========================================================================

	/** Set the session display name (shown in session selector). */
	setSessionName(name: string): void;

	/** Get the current session name, if set. */
	getSessionName(): string | undefined;

	/** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
	setLabel(entryId: string, label: string | undefined): void;

	/** Execute a shell command. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];

	/** Get all configured tools with parameter schema, prompt guidelines, and source metadata. */
	getAllTools(): ToolInfo[];

	/** Set the active tools by name. */
	setActiveTools(toolNames: string[]): void;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// Model and Thinking Level
	// =========================================================================

	/**
	 * Set the model for the current session without changing the configured default for new sessions.
	 * Returns false if authentication is not configured for the model's provider.
	 */
	setModel(model: Model<any>): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel;

	/**
	 * Set the thinking level (clamped to model capabilities) for the current session without changing the configured default
	 * for new sessions.
	 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `oauth` is provided: registers OAuth provider for /login support.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * During initial extension load this call is queued and applied once the
	 * runner has bound its context. After that it takes effect immediately, so
	 * it is safe to call from command handlers or event callbacks without
	 * requiring a `/reload`.
	 *
	 * @example
	 * // Register a new provider with custom models
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes all models belonging to the named provider and restores any
	 * built-in models that were overridden by it. Has no effect if the provider
	 * is not currently registered.
	 *
	 * Like `registerProvider`, this takes effect immediately when called after
	 * the initial load phase.
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Configuration for registering a provider via pi.registerProvider(). */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or leading !command. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/**
	 * Optional streamSimple handler for custom APIs.
	 * Implementations must invoke `options.onPayload` before sending the provider request and use any
	 * returned replacement payload. They must invoke `options.onResponse` after receiving the response
	 * and before consuming its body, matching built-in providers.
	 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/**
	 * Refresh this provider's model list. The returned list replaces extension-provided models.
	 * Use context.publish({ persist: entry }) when the catalog should persist across sessions.
	 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	oauth?: {
		/** Display name for the provider in login UI. */
		name: string;
		/** Whether access through this auth method is backed by a provider subscription. */
		isSubscription?: boolean;
		/** @deprecated Retained for source compatibility; canonical auth flows ignore it. */
		usesCallbackServer?: boolean;
		/** Run the login flow, return credentials to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** Refresh expired credentials, return updated credentials to persist. */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		getApiKey(credentials: OAuthCredentials): string;
		/** Legacy synchronous credential-dependent model projection. */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4-20250514"). */
	id: string;
	/** Display name (e.g., "Claude 4 Sonnet"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** API endpoint URL override for this model. */
	baseUrl?: string;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Per-million-token cost rates and optional request-wide input pricing tiers. */
	cost: Model<Api>["cost"];
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| {
			/** Display name shown as `<inline:name>` in the startup Extensions list. */
			name: string;
			factory: ExtensionFactory;
			/** Omit this extension from the startup Extensions list. */
			hidden?: boolean;
	  };

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * Shared state created by loader, used during registration and runtime.
 * Contains flag values (defaults set during registration, CLI values set after).
 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** Legacy provider-config registrations queued during extension loading, processed when runner binds. */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** Native pi-ai provider registrations queued during extension loading, processed when runner binds. */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** Throws when this extension instance is stale after runtime replacement. */
	assertActive: () => void;
	/** Marks this extension instance as stale after runtime replacement or reload. */
	invalidate: (message?: string) => void;
	/** Retain an event-bus subscription until this runtime is invalidated. */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * Register or unregister a provider.
	 *
	 * Before bindCore(): queues registrations / removes from queue.
	 * After bindCore(): calls ModelRegistry directly for immediate effect.
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * Action implementations for pi.* API methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * Actions for ExtensionContext (ctx.* in event handlers).
 * Required by all modes.
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

/**
 * Actions for ExtensionCommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where extension commands are invokable.
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items. */
export interface Extension {
	path: string;
	resolvedPath: string;
	hidden?: boolean;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	markdownTransformer?: MarkdownTransformer;
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** Result of loading extensions. */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	/** Shared runtime - actions are throwing stubs until runner.initialize() */
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}


File: /home/entropybender/3rd/pi/packages/coding-agent/src/core/extensions/wrapper.ts

/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = runner.getActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}


File: src/ambient.ts

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BAND_THRESHOLDS, type Band, aggregateConsumers, band, deriveState, fmtTokens } from "./context.ts";

type PiTheme = ExtensionContext["ui"]["theme"];

interface GaugeInput {
	tokens: number | null;
	window?: number;
	barWidth?: number;
}

function bandText(theme: PiTheme, value: Band, text: string): string {
	if (value === "red") return theme.fg("error", text);
	if (value === "filling") return theme.fg("warning", text);
	return theme.fg("success", text);
}

export function renderGauge(input: GaugeInput, theme: PiTheme): string {
	const barWidth = input.barWidth ?? 30;
	if (input.tokens === null || !input.window || input.window <= 0) {
		return `${theme.fg("dim", "CONTEXT")} ${theme.fg("dim", "░".repeat(barWidth))} ${theme.fg(
			"dim",
			"estimating… (awaiting next turn)",
		)}`;
	}
	const pct = (input.tokens / input.window) * 100;
	const value = band(pct);
	const fill = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const ticks = new Set(
		[BAND_THRESHOLDS.healthy, BAND_THRESHOLDS.filling, BAND_THRESHOLDS.red].map((threshold) =>
			Math.min(barWidth - 1, Math.round((threshold / 100) * barWidth)),
		),
	);
	let barText = "";
	for (let index = 0; index < barWidth; index++) {
		const character = index < fill ? "█" : ticks.has(index) ? "┊" : "░";
		barText += index < fill ? bandText(theme, value, character) : theme.fg("dim", character);
	}
	const label = `${fmtTokens(input.tokens)} / ${fmtTokens(input.window)} · ${bandText(
		theme,
		value,
		`${pct.toFixed(1)}% ${value}`,
	)}`;
	return `${theme.fg("dim", "CONTEXT")} ${barText} ${label}`;
}

let warnedRed = false;
let lastPct: number | null = null;
let lastConsumers = new Map<string, number>();
const TREND_PTS = 3;
const ATTRIBUTE_PTS = 5;

export function resetAmbient(): void {
	warnedRed = false;
	lastPct = null;
	lastConsumers = new Map();
}

function trendMarker(pct: number, consumers: Map<string, number>): string {
	let marker = "";
	if (lastPct !== null) {
		const delta = pct - lastPct;
		if (delta >= ATTRIBUTE_PTS) {
			let topKey = "";
			let topGrowth = 0;
			for (const [key, tokens] of consumers) {
				const growth = tokens - (lastConsumers.get(key) ?? 0);
				if (growth > topGrowth) {
					topGrowth = growth;
					topKey = key;
				}
			}
			marker = topKey ? ` ▲ +${Math.round(delta)}% (${topKey})` : ` ▲ +${Math.round(delta)}%`;
		} else if (delta >= TREND_PTS) marker = " ▲";
	}
	lastPct = pct;
	lastConsumers = consumers;
	return marker;
}

function nudgeOnRed(ctx: ExtensionContext, value: Band): void {
	if (value === "red" && !warnedRed) {
		warnedRed = true;
		ctx.ui.notify(
			"context crossed 40% of the window — consider /merge, /compress, /crop, or /branch (F5.3)",
			"warning",
		);
	}
	if (value !== "red") warnedRed = false;
}

export function refreshAmbient(ctx: ExtensionContext): void {
	let state: ReturnType<typeof deriveState> | undefined;
	try {
		state = deriveState(ctx);
	} catch {}
	const branch = state?.currentFork?.data.name ?? "trunk";
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	const slice = state?.contextEntries;
	const consumers = slice
		? new Map(aggregateConsumers(slice).map((consumer) => [consumer.key, consumer.tokens] as const))
		: undefined;
	let gaugeTokens: number | null = null;
	let pct: number | null = null;
	if (usage && usage.percent !== null && usage.tokens !== null && usage.tokens > 0) {
		gaugeTokens = usage.tokens;
		pct = usage.percent;
	}
	const trend = pct !== null && consumers ? trendMarker(pct, consumers) : "";
	let gaugeText = "ctx —";
	if (pct !== null) {
		const value = band(pct);
		gaugeText = `ctx ${pct.toFixed(1)}% ${value}${trend}`;
		nudgeOnRed(ctx, value);
	} else if (usage) gaugeText = "ctx est…";
	ctx.ui.setStatus("ctree", `⎇ ${branch} · ${gaugeText}`);
	ctx.ui.setTitle(`${basename(ctx.cwd)}${branch !== "trunk" ? ` (${branch})` : ""} (pi)`);
	if (ctx.mode === "tui" && window && window > 0) {
		const gauge = renderGauge({ tokens: gaugeTokens, window, barWidth: 28 }, ctx.ui.theme);
		ctx.ui.setWidget("ctree-gauge", [` ${gauge}${trend}`], { placement: "aboveEditor" });
	}
}

export function registerAmbient(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		resetAmbient();
		refreshAmbient(ctx);
	});
	pi.on("turn_end", (_event, ctx) => refreshAmbient(ctx));
	pi.on("session_tree", (_event, ctx) => refreshAmbient(ctx));
	pi.on("session_before_compact", (_event, ctx) => {
		ctx.ui.notify(
			"heads-up: /compact replaces source material with a lossy summary — pi-context-compress prefers /branch + /merge (decision records), /compress (reviewed range summaries), or /crop. Continuing anyway (F5.4).",
			"warning",
		);
	});
}


File: src/branches.ts

import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import parseArgs from "yargs-parser";
import { refreshAmbient } from "./ambient.ts";
import { type ForkInfo, type SessionState, decisionsOnPath, deriveState, serializeEntries } from "./context.ts";
import { DRAFT_SYSTEM_PROMPT, type DraftFn, draftUserPrompt, modelKey, resolveModel } from "./draft.ts";
import {
	CTREE_CLOSE,
	CTREE_DECISION,
	CTREE_FORK,
	compressionDetails,
	ctreeCloseData,
	ctreeCropData,
	ctreeDecisionDetails,
	ctreeForkData,
	ctreeRangeCompactData,
} from "./protocol.ts";

export interface DecisionDraft {
	branchName: string;
	dateIso: string;
	model: string;
	branchId: string;
	outcome: string;
	why: string[];
	assumptions?: string;
	changes?: string;
	gotchas?: string;
	openQuestions?: string;
	confidence?: string;
	rejected?: { name: string; reason: string }[];
}

export interface DecisionArgs {
	export: boolean;
	exportPath?: string;
}

type MergeMode = "squash" | "no-llm" | "discard" | "tournament";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const ARGUMENT_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;
let modelReferences: string[] = [];

function siblingForks(forks: ForkInfo[], forkEntryId: string): ForkInfo[] {
	const selected = forks.find((fork) => fork.entryId === forkEntryId);
	if (!selected) return [];
	return forks.filter(
		(fork) =>
			fork.entryId !== forkEntryId && fork.status === "open" && fork.data.parentEntryId === selected.data.parentEntryId,
	);
}

function branchEntries(state: SessionState, forkEntryId: string): SessionEntry[] {
	const forkIndex = state.branch.findIndex((entry) => entry.id === forkEntryId);
	if (forkIndex === -1) return [];
	const afterFork = new Set(state.branch.slice(forkIndex + 1).map((entry) => entry.id));
	return state.contextEntries.filter((entry) => afterFork.has(entry.id));
}

function rememberModels(ctx: ExtensionContext): void {
	modelReferences = ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`);
}

export function resetModelCompletions(): void {
	modelReferences = [];
}

export function modelCompletions(argumentPrefix: string): { value: string; label: string }[] | null {
	const parts = argumentPrefix.split(/\s+/);
	if (parts.length < 2) return null;
	const prefix = (parts.at(-1) ?? "").toLowerCase();
	const matches = modelReferences.filter((reference) => {
		const modelId = reference.slice(reference.indexOf("/") + 1);
		return reference.toLowerCase().startsWith(prefix) || modelId.toLowerCase().startsWith(prefix);
	});
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

export function renderDecisionRecord(draft: DecisionDraft): string {
	const lines: string[] = [
		`## Decision: ${draft.branchName}`,
		`**Date:** ${draft.dateIso} · **Model:** ${draft.model} · **Branch:** ${draft.branchId}`,
		`**Outcome:** ${draft.outcome}`,
		"**Why:**",
		...draft.why.map((reason) => `- ${reason}`),
		`**Assumptions:** ${draft.assumptions ?? "—"}`,
		`**Changes:** ${draft.changes ?? "none"}`,
		`**Gotchas:** ${draft.gotchas ?? "—"}`,
		`**Open questions:** ${draft.openQuestions ?? "—"}`,
		`**Confidence / revisit-if:** ${draft.confidence ?? "—"}`,
	];
	if (draft.rejected?.length) {
		lines.push("### Rejected alternatives");
		for (const rejected of draft.rejected) lines.push(`- **${rejected.name}:** ${rejected.reason}`);
	}
	return `${lines.join("\n")}\n`;
}

export function exportDecisionsMarkdown(records: readonly string[], project?: string): string {
	const title = `# Decision records${project ? ` — ${project}` : ""}`;
	const meta = `_${records.length} record${records.length === 1 ? "" : "s"} · exported by pi-context-compress_`;
	if (records.length === 0) {
		return `${title}\n\n${meta}\n\n_(none yet — \`/merge\` → squash creates them.)_\n`;
	}
	return `${title}\n\n${meta}\n\n${records.map((record) => record.trim()).join("\n\n---\n\n")}\n`;
}

export function parseDecisionArgs(args: string): DecisionArgs {
	const parsed = parseArgs(args, {
		string: ["export"],
		configuration: ARGUMENT_CONFIGURATION,
	});
	const hasExport = Object.hasOwn(parsed, "export");
	const optionPath = typeof parsed.export === "string" ? parsed.export.trim() : "";
	const positionalPath = parsed._[0] === undefined ? "" : String(parsed._[0]);
	return {
		export: hasExport,
		exportPath: optionPath || positionalPath || undefined,
	};
}

export function notifyDecisions(ctx: ExtensionContext): void {
	const decisions = decisionsOnPath(ctx.sessionManager.getBranch());
	if (decisions.length === 0) {
		ctx.ui.notify("no decision records on this trunk yet — /merge → squash creates them (F7)", "info");
		return;
	}
	const lines = [...decisions].reverse().map((decision) => {
		const details = ctreeDecisionDetails(decision);
		const text = contentText(decision.content, "\n");
		const outcome = text.split("\n").find((line) => line.startsWith("**Outcome:**")) ?? text.split("\n")[0] ?? "";
		return `◆ ${details?.branchName ?? "decision"} (${decision.timestamp.slice(0, 10)}) ${outcome.replace("**Outcome:**", "").trim()}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

export function exportDecisions(ctx: ExtensionContext, path: string | undefined): void {
	const decisions = decisionsOnPath(ctx.sessionManager.getBranch());
	const markdown = exportDecisionsMarkdown(
		decisions.map((decision) => contentText(decision.content, "\n")),
		basename(ctx.cwd),
	);
	const outputPath = resolve(ctx.cwd, path || "ctree-decisions.md");
	try {
		writeFileSync(outputPath, markdown, "utf8");
	} catch (error) {
		ctx.ui.notify(`could not write ${outputPath}: ${(error as Error).message}`, "error");
		return;
	}
	ctx.ui.notify(
		`wrote ${decisions.length} decision record${decisions.length === 1 ? "" : "s"} → ${outputPath}`,
		"info",
	);
}

export async function branchHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const [name, modelRef] = args.trim().split(/\s+/).filter(Boolean);
	if (!name) {
		ctx.ui.notify("usage: /branch <name> [model] — e.g. /branch fix-flaky-test haiku-4.5", "warning");
		return;
	}
	if (!NAME_RE.test(name)) {
		ctx.ui.notify(`branch name "${name}" — use letters, digits, dot, dash, underscore`, "error");
		return;
	}

	await ctx.waitForIdle();
	const state = deriveState(ctx);
	if (state.forks.some((fork) => fork.status === "open" && fork.data.name === name)) {
		ctx.ui.notify(`an open branch named "${name}" already exists — /merge it first or pick another name`, "error");
		return;
	}

	const branchModel = modelRef ? resolveModel(ctx, modelRef) : undefined;
	if (modelRef && !branchModel) {
		ctx.ui.notify(`unknown model "${modelRef}" — try provider/id (e.g. anthropic/claude-haiku-4-5)`, "error");
		return;
	}

	const trunkModel = modelKey(ctx.model);
	pi.appendEntry(CTREE_FORK, {
		v: 1,
		name,
		parentEntryId: ctx.sessionManager.getLeafId(),
		trunkModel,
		branchModel: modelKey(branchModel),
		createdAt: Date.now(),
		status: "open",
	});
	const forkId = ctx.sessionManager.getLeafId();
	if (forkId) pi.setLabel(forkId, name);

	if (branchModel) {
		const changed = await pi.setModel(branchModel);
		if (!changed) ctx.ui.notify(`no API key for ${modelKey(branchModel)} — staying on ${trunkModel}`, "warning");
	}

	refreshAmbient(ctx);
	ctx.ui.notify(
		`⎇ branched: ${name}${branchModel ? ` on ${modelKey(branchModel)}` : ""} — /merge squashes it back to this point`,
		"info",
	);
}

function parseMergeArgs(args: string): { mode?: MergeMode; pick: boolean; note: string } {
	const parsed = parseArgs(args, {
		boolean: ["squash", "no-llm", "discard", "tournament", "pick"],
		configuration: ARGUMENT_CONFIGURATION,
	});
	const mode = parsed.squash
		? "squash"
		: parsed["no-llm"]
			? "no-llm"
			: parsed.discard
				? "discard"
				: parsed.tournament
					? "tournament"
					: undefined;
	return { mode, pick: parsed.pick === true, note: parsed._.map(String).join(" ") };
}

async function pickMode(
	ctx: ExtensionCommandContext,
	fork: ForkInfo,
	siblings: ForkInfo[],
): Promise<MergeMode | undefined> {
	const options = [
		"squash — draft a decision record with the branch model, you confirm/edit",
		"squash --no-llm — write the decision record yourself",
		"discard — return to the label, inject nothing, mark rejected",
		siblings.length > 0
			? `tournament — winner record + epitaphs for ${siblings.length} sibling(s), ONE combined node`
			: "tournament — (needs open siblings sharing this label — none found)",
	];
	const choice = await ctx.ui.select(`Merge branch '${fork.data.name}'?`, options);
	if (choice === undefined) return undefined;
	if (choice.startsWith("squash —")) return "squash";
	if (choice.startsWith("squash --no-llm")) return "no-llm";
	if (choice.startsWith("discard")) return "discard";
	if (choice.startsWith("tournament")) return siblings.length > 0 ? "tournament" : undefined;
	return undefined;
}

function recordTemplate(fork: ForkInfo, model: string | undefined): string {
	return renderDecisionRecord({
		branchName: fork.data.name,
		dateIso: new Date().toISOString().slice(0, 10),
		model: model ?? "—",
		branchId: fork.entryId,
		outcome: "",
		why: ["", ""],
	});
}

function siblingTail(ctx: ExtensionCommandContext, sibling: ForkInfo): SessionEntry[] {
	return ctx.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.id !== sibling.entryId &&
				ctx.sessionManager.getBranch(entry.id).some((parent) => parent.id === sibling.entryId),
		);
}

async function epitaphFor(draft: DraftFn, ctx: ExtensionCommandContext, sibling: ForkInfo): Promise<string> {
	const serialized = serializeEntries(siblingTail(ctx, sibling), { perEntryCap: 800 }).slice(0, 8000);
	try {
		const text = await draft(
			ctx,
			sibling.data.branchModel,
			"You write one-line epitaphs for rejected engineering approaches. Output ONE line, ≤120 chars, format: <reason it was rejected>.",
			`Branch "${sibling.data.name}" lost a tournament. Its transcript:\n---\n${serialized}\n---\nWhy was it rejected? One line.`,
		);
		return text.split("\n", 1)[0]?.slice(0, 160) ?? "rejected";
	} catch {
		const manual = await ctx.ui.input(`epitaph for rejected '${sibling.data.name}' (one line)`, "why it lost");
		return manual?.trim() || "rejected in tournament";
	}
}

async function restoreTrunkModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, fork: ForkInfo): Promise<void> {
	const trunkRef = fork.data.trunkModel;
	if (!trunkRef || trunkRef === modelKey(ctx.model)) return;
	const model = resolveModel(ctx, trunkRef);
	if (!model) {
		ctx.ui.notify(`could not resolve trunk model ${trunkRef} — staying on ${modelKey(ctx.model)}`, "warning");
		return;
	}
	const changed = await pi.setModel(model);
	if (!changed) ctx.ui.notify(`no API key for ${trunkRef} — staying on ${modelKey(ctx.model)}`, "warning");
}

export async function mergeHandler(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	draftFn: DraftFn,
): Promise<void> {
	await ctx.waitForIdle();
	const state = deriveState(ctx);
	const fork = state.currentFork;
	if (!fork || !state.leafId) {
		ctx.ui.notify("no open branch at or above the current leaf — /branch <name> first (F2.1)", "error");
		return;
	}
	const siblings = siblingForks(state.forks, fork.entryId);
	const parsed = parseMergeArgs(args);
	const mode = parsed.mode ?? (parsed.pick ? await pickMode(ctx, fork, siblings) : "squash");
	if (!mode) {
		ctx.ui.notify("merge cancelled — nothing written", "info");
		return;
	}
	if (mode === "tournament" && siblings.length === 0) {
		ctx.ui.notify("tournament needs ≥1 open sibling branch sharing this label (F2.4)", "error");
		return;
	}

	const branchModelRef = fork.data.branchModel ?? modelKey(ctx.model);
	if (mode === "discard") {
		const note = parsed.note || (await ctx.ui.input("optional one-line note for the close marker", "dead end"));
		const navigation = await ctx.navigateTree(fork.entryId, { summarize: false });
		if (navigation.cancelled) {
			ctx.ui.notify("merge aborted — navigation cancelled, nothing written", "warning");
			return;
		}
		pi.appendEntry(CTREE_CLOSE, {
			v: 1,
			forkEntryId: fork.entryId,
			status: "discarded",
			note: note?.trim() || undefined,
			prevLeafId: state.leafId,
		});
		await restoreTrunkModel(pi, ctx, fork);
		refreshAmbient(ctx);
		ctx.ui.notify(`⎇ discarded ${fork.data.name} — back at the label, nothing injected (history kept)`, "info");
		return;
	}

	const template = recordTemplate(fork, branchModelRef);
	let draft: string;
	if (mode === "no-llm") {
		draft = template;
	} else {
		ctx.ui.notify(`drafting decision record with ${branchModelRef ?? "current model"}…`, "info");
		try {
			draft = await draftFn(
				ctx,
				fork.data.branchModel,
				DRAFT_SYSTEM_PROMPT,
				draftUserPrompt(
					fork.data.name,
					template,
					serializeEntries(branchEntries(state, fork.entryId), { perEntryCap: 2000 }),
					parsed.note || undefined,
				),
			);
		} catch (error) {
			ctx.ui.notify(
				`drafting failed (${(error as Error).message}) — falling back to manual template (--no-llm)`,
				"warning",
			);
			draft = template;
		}
	}

	const rejected: { name: string; reason: string }[] = [];
	if (mode === "tournament") {
		for (const sibling of siblings) {
			rejected.push({ name: sibling.data.name, reason: await epitaphFor(draftFn, ctx, sibling) });
		}
		const lines = [draft.trimEnd()];
		if (!draft.includes("### Rejected alternatives")) lines.push("### Rejected alternatives");
		for (const item of rejected) lines.push(`- **${item.name}:** ${item.reason}`);
		draft = `${lines.join("\n")}\n`;
	}

	const confirmed = await ctx.ui.editor(
		`Decision record — review/edit; closing without saving aborts the merge ('${fork.data.name}')`,
		draft,
	);
	if (confirmed === undefined || confirmed.trim() === "") {
		ctx.ui.notify("merge aborted — no record confirmed, nothing written", "info");
		return;
	}

	const navigation = await ctx.navigateTree(fork.entryId, { summarize: false });
	if (navigation.cancelled) {
		ctx.ui.notify("merge aborted — navigation cancelled, nothing written", "warning");
		return;
	}
	pi.sendMessage(
		{
			customType: CTREE_DECISION,
			content: confirmed,
			display: true,
			details: { v: 1, forkEntryId: fork.entryId, branchName: fork.data.name, siblings: rejected },
		},
		{ triggerTurn: false },
	);
	const decisionEntryId = ctx.sessionManager.getLeafId() ?? undefined;
	pi.appendEntry(CTREE_CLOSE, {
		v: 1,
		forkEntryId: fork.entryId,
		status: "squashed",
		decisionEntryId,
		prevLeafId: state.leafId,
	});
	for (const item of rejected) {
		const sibling = siblings.find((candidate) => candidate.data.name === item.name);
		if (sibling) {
			pi.appendEntry(CTREE_CLOSE, {
				v: 1,
				forkEntryId: sibling.entryId,
				status: "rejected",
				note: item.reason,
			});
		}
	}
	await restoreTrunkModel(pi, ctx, fork);
	refreshAmbient(ctx);
	ctx.ui.notify(
		mode === "tournament"
			? `⎇ tournament: ${fork.data.name} won — 1 combined record, ${rejected.length} epitaph(s), siblings closed`
			: `⎇ squashed ${fork.data.name} → decision record on trunk · branch history kept`,
		"info",
	);
}

interface UndoStep {
	target: string;
	describe: string;
}

function lastUndo(state: SessionState): UndoStep | undefined {
	if (!state.leafId) return undefined;
	const branchIds = new Set(state.branch.map((entry) => entry.id));
	for (let index = state.entries.length - 1; index >= 0; index--) {
		const entry = state.entries[index];
		if (!entry || !branchIds.has(entry.id)) continue;
		const compression = compressionDetails(entry);
		if (compression) {
			return { target: compression.sourceLeafId, describe: "restore the batch execution before compression" };
		}
		const close = ctreeCloseData(entry);
		if (close?.prevLeafId) {
			const name = state.forks.find((fork) => fork.entryId === close.forkEntryId)?.data.name ?? "branch";
			const action = close.status === "discarded" ? "re-open discarded" : "re-open";
			return {
				target: close.prevLeafId,
				describe: `${action} '${name}' at its leaf — the close marker stays in history`,
			};
		}
		const crop = ctreeCropData(entry);
		if (crop) {
			const count = crop.stubbed.length + (crop.dropped?.length ?? 0);
			return {
				target: crop.sourceLeafId,
				describe: `restore ${count} cropped item${count === 1 ? "" : "s"} — back to before the crop`,
			};
		}
		const range = ctreeRangeCompactData(entry);
		if (range) {
			const count = range.selectedEntryIds.length;
			return {
				target: range.sourceLeafId,
				describe: `restore compressed message range (${count} entr${count === 1 ? "y" : "ies"}) — summary and marker stay in off-path history`,
			};
		}
		const fork = ctreeForkData(entry);
		if (fork?.parentEntryId) {
			return { target: fork.parentEntryId, describe: `undo /branch '${fork.name}' — back to where you branched` };
		}
	}
	return undefined;
}

export async function undoHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const step = lastUndo(deriveState(ctx));
	if (!step) {
		ctx.ui.notify("nothing to undo — no pi-context-compress mutation on the current branch", "info");
		return;
	}
	const confirmed = await ctx.ui.confirm("Undo last change", `↩ ${step.describe}? (nothing is deleted — append-only)`);
	if (!confirmed) {
		ctx.ui.notify("undo cancelled — nothing changed", "info");
		return;
	}
	const navigation = await ctx.navigateTree(step.target, { summarize: false });
	if (navigation.cancelled) {
		ctx.ui.notify("undo aborted — navigation cancelled, nothing changed", "warning");
		return;
	}
	refreshAmbient(ctx);
	ctx.ui.notify(`↩ undone — ${step.describe}`, "info");
}

export function registerBranch(pi: ExtensionAPI): void {
	const refreshModels = (_event: unknown, ctx: ExtensionContext): void => rememberModels(ctx);
	pi.on("session_start", refreshModels);
	pi.on("model_select", refreshModels);
	pi.registerCommand("branch", {
		description: "pi-context-compress: label this point and branch off (optionally onto a cheaper model)",
		handler: (args, ctx) => branchHandler(pi, ctx, args),
		getArgumentCompletions: modelCompletions,
	});
}

export function registerMerge(pi: ExtensionAPI, draft: DraftFn): void {
	pi.registerCommand("merge", {
		description: "pi-context-compress: close the open branch — squash (default) | --pick | --discard | --tournament",
		handler: (args, ctx) => mergeHandler(pi, ctx, args, draft),
		getArgumentCompletions: (prefix) => {
			const flags = ["--squash", "--no-llm", "--discard", "--tournament", "--pick"];
			const last = prefix.split(/\s+/).pop() ?? "";
			const matches = flags.filter((flag) => flag.startsWith(last));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
	});
}

export function registerUndo(pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "pi-context-compress: revert the last mutation (re-open a branch / restore a crop) — append-only",
		handler: (_args, ctx) => undoHandler(pi, ctx),
	});
}


File: src/context.ts

import { type UserMessage, contentText } from "@earendil-works/pi-ai";
import type {
	CustomMessageEntry,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
	CTREE_CROP_TAIL,
	CTREE_DECISION,
	CTREE_RANGE_TAIL,
	type CtreeCloseStatus,
	type CtreeForkData,
	ctreeCloseData,
	ctreeForkData,
} from "./protocol.ts";

export type SessionManagerView = ExtensionContext["sessionManager"];

export interface SessionSnapshot {
	sessionId: string;
	entries: SessionEntry[];
	branch: SessionEntry[];
	contextEntries: SessionEntry[];
	tree: SessionTreeNode[];
	leafId: string | null;
}

export function snapshotSession(session: SessionManagerView): SessionSnapshot {
	return {
		sessionId: session.getSessionId(),
		entries: session.getEntries(),
		branch: session.getBranch(),
		contextEntries: session.buildContextEntries(),
		tree: session.getTree(),
		leafId: session.getLeafId(),
	};
}

export function snapshotEntry(snapshot: SessionSnapshot, entryId: string): SessionEntry | undefined {
	return snapshot.entries.find((entry) => entry.id === entryId);
}

type ForkStatus = "open" | CtreeCloseStatus;

export interface ForkInfo {
	entryId: string;
	data: CtreeForkData;
	status: ForkStatus;
}

export interface SessionState extends SessionSnapshot {
	forks: ForkInfo[];
	currentFork: ForkInfo | undefined;
}

function extractForks(session: SessionManagerView): ForkInfo[] {
	const entries = session.getEntries();
	const closes = new Map<string, CtreeCloseStatus>();
	for (const entry of entries) {
		const close = ctreeCloseData(entry);
		if (close) closes.set(close.forkEntryId, close.status);
	}

	const forks: ForkInfo[] = [];
	for (const entry of entries) {
		const data = ctreeForkData(entry);
		if (!data) continue;
		forks.push({
			entryId: entry.id,
			data,
			status: closes.get(entry.id) ?? "open",
		});
	}
	return forks;
}

export function nearestOpenFork(branch: readonly SessionEntry[], forks: ForkInfo[]): ForkInfo | undefined {
	const byId = new Map(forks.map((fork) => [fork.entryId, fork]));
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		const fork = byId.get(entry.id);
		if (fork?.status === "open") return fork;
	}
	return undefined;
}

export function decisionsOnPath(branch: readonly SessionEntry[]): CustomMessageEntry[] {
	return branch.filter(
		(entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === CTREE_DECISION,
	);
}

export function deriveState(ctx: ExtensionContext): SessionState {
	const snapshot = snapshotSession(ctx.sessionManager);
	const forks = extractForks(ctx.sessionManager);
	return { ...snapshot, forks, currentFork: nearestOpenFork(snapshot.branch, forks) };
}

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contentChars(content: UserMessage["content"]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
	}
	return chars;
}

function messageChars(message: SessionMessageEntry["message"]): number {
	switch (message.role) {
		case "user":
			return contentChars(message.content);
		case "assistant": {
			let chars = 0;
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
			}
			return chars;
		}
		case "toolResult":
			return contentChars(message.content);
		case "bashExecution":
			return message.excludeFromContext ? 0 : message.command.length + message.output.length;
		case "custom":
			return contentChars(message.content);
		case "branchSummary":
			return message.summary.length;
		case "compactionSummary":
			return message.summary.length;
		default:
			return 0;
	}
}

function entryChars(entry: SessionEntry): number {
	if (entry.type === "message") return messageChars(entry.message);
	switch (entry.type) {
		case "custom_message":
			return contentChars(entry.content);
		case "branch_summary":
			return entry.summary.length;
		case "compaction":
			return entry.summary.length;
		default:
			return 0;
	}
}

export function estimateEntryTokens(entry: SessionEntry): number {
	return Math.ceil(entryChars(entry) / CHARS_PER_TOKEN);
}

export type Band = "low" | "healthy" | "filling" | "red";

export const BAND_THRESHOLDS = { healthy: 5, filling: 15, red: 40 } as const;

export function band(percent: number): Band {
	if (percent < BAND_THRESHOLDS.healthy) return "low";
	if (percent < BAND_THRESHOLDS.filling) return "healthy";
	if (percent <= BAND_THRESHOLDS.red) return "filling";
	return "red";
}

export function fmtTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		switch (message.role) {
			case "user":
				return `user: ${contentText(message.content, "\n")}`;
			case "assistant": {
				const parts: string[] = [];
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim()) parts.push(block.text);
					else if (block.type === "toolCall") parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
				}
				return parts.length ? `assistant: ${parts.join("\n")}` : undefined;
			}
			case "toolResult":
				return `[${message.toolName}]: ${contentText(message.content, "\n")}`;
			case "bashExecution":
				return message.excludeFromContext ? undefined : `[bash $ ${message.command}]: ${message.output}`;
			case "custom":
				return `[${message.customType}]: ${contentText(message.content, "\n")}`;
			case "branchSummary":
				return `[branch summary]: ${message.summary}`;
			case "compactionSummary":
				return `[compaction summary]: ${message.summary}`;
			default:
				return undefined;
		}
	}
	switch (entry.type) {
		case "custom_message":
			return `[${entry.customType}]: ${contentText(entry.content, "\n")}`;
		case "branch_summary":
			return `[branch summary]: ${entry.summary}`;
		case "compaction":
			return `[compaction summary]: ${entry.summary}`;
		default:
			return undefined;
	}
}

export interface SerializeOptions {
	perEntryCap?: number;
}

export function serializeEntries(entries: readonly SessionEntry[], options: SerializeOptions = {}): string {
	const parts: string[] = [];
	for (const entry of entries) {
		let text = serializeEntry(entry);
		if (text === undefined) continue;
		if (options.perEntryCap !== undefined && text.length > options.perEntryCap) {
			text = `${text.slice(0, options.perEntryCap)}…(truncated)`;
		}
		parts.push(text);
	}
	return parts.join("\n\n");
}

export interface ConsumerRow {
	key: string;
	tokens: number;
	entries: number;
	share: number;
}

function consumerBucket(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message;
		switch (message.role) {
			case "user":
				return "user messages";
			case "assistant":
				return "assistant messages";
			case "toolResult":
				return message.toolName;
			case "bashExecution":
				return "bash";
			case "custom":
				return "extension messages";
			case "branchSummary":
				return "branch summaries";
			case "compactionSummary":
				return "compaction summary";
			default:
				return "other";
		}
	}
	switch (entry.type) {
		case "custom_message":
			if (entry.customType === CTREE_DECISION) return "decision records";
			if (entry.customType === CTREE_CROP_TAIL) return "crop stubs";
			if (entry.customType === CTREE_RANGE_TAIL) return "range summaries";
			return "extension messages";
		case "branch_summary":
			return "branch summaries";
		case "compaction":
			return "compaction summary";
		default:
			return "other";
	}
}

export function aggregateConsumers(entries: readonly SessionEntry[]): ConsumerRow[] {
	const buckets = new Map<string, { tokens: number; entries: number }>();
	let total = 0;
	for (const entry of entries) {
		const tokens = estimateEntryTokens(entry);
		if (tokens === 0) continue;
		total += tokens;
		const key = consumerBucket(entry);
		const aggregate = buckets.get(key) ?? { tokens: 0, entries: 0 };
		aggregate.tokens += tokens;
		aggregate.entries += 1;
		buckets.set(key, aggregate);
	}
	return [...buckets.entries()]
		.map(([key, value]) => ({
			key,
			tokens: value.tokens,
			entries: value.entries,
			share: total === 0 ? 0 : value.tokens / total,
		}))
		.sort((left, right) => right.tokens - left.tokens);
}


File: src/crop.ts

import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { refreshAmbient } from "./ambient.ts";
import { type SessionSnapshot, estimateEntryTokens, fmtTokens, serializeEntry, snapshotEntry } from "./context.ts";
import { CTREE_CROP, CTREE_CROP_TAIL, type CtreeCropDrop, type CtreeCropStub } from "./protocol.ts";
import { type RewritePlan, applyRewrite, candidateByEntryId, prepareRewrite, rangeCandidates } from "./rewrite.ts";

export interface CropCandidate {
	entryId: string;
	tool: string;
	arg?: string;
	estTokens: number;
	ageTurns: number;
	protected: boolean;
}

export interface AutoRules {
	minTokens?: number;
	olderThanTurns?: number;
	keep?: string[];
}

export interface CropPlan extends RewritePlan {
	reclaimTokens: number;
	stubs: CtreeCropStub[];
	dropped: CtreeCropDrop[];
}

export interface ContextTurn {
	userId: string;
	label: string;
	entryIds: string[];
	estTokens: number;
}

const PRIMARY_ARG_KEYS = ["path", "file_path", "url", "command", "query", "name"];
const KEEP_MATCH_OPTIONS = { dot: true, matchBase: true } as const;

function firstLine(text: string, max = 80): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isAnswerEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	return role === "assistant" || role === "toolResult" || role === "bashExecution";
}

function primaryArg(snapshot: SessionSnapshot, entry: SessionMessageEntry): string | undefined {
	const message = entry.message;
	if (message.role === "bashExecution") return message.command.slice(0, 60);
	if (message.role !== "toolResult") return undefined;
	const parent = entry.parentId ? snapshotEntry(snapshot, entry.parentId) : undefined;
	if (!parent || parent.type !== "message" || parent.message.role !== "assistant") return undefined;
	for (const block of parent.message.content) {
		if (block.type !== "toolCall" || block.id !== message.toolCallId) continue;
		const args = block.arguments ?? {};
		for (const key of PRIMARY_ARG_KEYS) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) return value.slice(0, 60);
		}
		const first = Object.values(args).find((value) => typeof value === "string" && value.length > 0);
		return typeof first === "string" ? first.slice(0, 60) : undefined;
	}
	return undefined;
}

function toolNameOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	if (entry.message.role === "toolResult") return entry.message.toolName;
	if (entry.message.role === "bashExecution") return entry.message.excludeFromContext ? undefined : "bash";
	return undefined;
}

export function cropCandidates(snapshot: SessionSnapshot): CropCandidate[] {
	const assistantsAfter: number[] = new Array(snapshot.contextEntries.length).fill(0);
	let count = 0;
	for (let index = snapshot.contextEntries.length - 1; index >= 0; index--) {
		assistantsAfter[index] = count;
		const entry = snapshot.contextEntries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") count += 1;
	}

	const latestPerTool = new Map<string, string>();
	for (const entry of snapshot.contextEntries) {
		const tool = toolNameOf(entry);
		if (tool) latestPerTool.set(tool, entry.id);
	}

	const candidates: CropCandidate[] = [];
	snapshot.contextEntries.forEach((entry, index) => {
		if (entry.type !== "message") return;
		const tool = toolNameOf(entry);
		if (!tool) return;
		candidates.push({
			entryId: entry.id,
			tool,
			arg: primaryArg(snapshot, entry),
			estTokens: estimateEntryTokens(entry),
			ageTurns: assistantsAfter[index] ?? 0,
			protected: latestPerTool.get(tool) === entry.id,
		});
	});
	return candidates;
}

export function autoSelect(candidates: CropCandidate[], rules: AutoRules): string[] {
	const minTokens = rules.minTokens ?? 10_000;
	const olderThan = rules.olderThanTurns ?? 2;
	const keep = rules.keep ?? [];
	return candidates
		.filter((candidate) => !candidate.protected)
		.filter((candidate) => candidate.estTokens >= minTokens)
		.filter((candidate) => candidate.ageTurns > olderThan)
		.filter(
			(candidate) =>
				!keep.some(
					(pattern) =>
						minimatch(candidate.tool, pattern, KEEP_MATCH_OPTIONS) ||
						(candidate.arg !== undefined && minimatch(candidate.arg, pattern, KEEP_MATCH_OPTIONS)),
				),
		)
		.map((candidate) => candidate.entryId);
}

function prepareMarkedRange(
	snapshot: SessionSnapshot,
	firstEntryId: string | undefined,
	lastEntryId: string | undefined,
	invalidGroupMessage: string,
): RewritePlan {
	if (!firstEntryId || !lastEntryId) throw new Error("nothing marked");
	const groupsByEntryId = candidateByEntryId(rangeCandidates(snapshot));
	const firstGroup = groupsByEntryId.get(firstEntryId);
	const lastGroup = groupsByEntryId.get(lastEntryId);
	if (!firstGroup || !lastGroup) throw new Error(invalidGroupMessage);
	return prepareRewrite(snapshot, firstGroup.startEntryId, lastGroup.endEntryId);
}

export function planCrop(snapshot: SessionSnapshot, markedIds: string[]): CropPlan {
	const position = new Map(snapshot.contextEntries.map((entry, index) => [entry.id, index]));
	const croppable = new Set(cropCandidates(snapshot).map((candidate) => candidate.entryId));
	for (const id of markedIds) {
		if (!position.has(id)) throw new Error(`entry ${id} is not on the current path`);
		if (!croppable.has(id)) throw new Error(`entry ${id} is not croppable (only tool/MCP results are)`);
	}

	const ordered = [...markedIds].sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
	const rewrite = prepareMarkedRange(
		snapshot,
		ordered[0],
		ordered.at(-1),
		"marked crop entry is not in a safe rewrite group",
	);
	const stubs: CtreeCropStub[] = ordered.map((id) => {
		const entry = snapshotEntry(snapshot, id);
		if (!entry || entry.type !== "message") throw new Error(`entry ${id} is not a message`);
		let body: string;
		if (entry.message.role === "bashExecution") body = entry.message.output;
		else if (entry.message.role === "toolResult") body = contentText(entry.message.content, "\n");
		else throw new Error(`entry ${id} is not a tool result`);
		return {
			entryId: id,
			tool: toolNameOf(entry) ?? "tool",
			arg: primaryArg(snapshot, entry),
			estTokens: estimateEntryTokens(entry),
			sha8: createHash("sha256").update(body).digest("hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
		reclaimTokens: stubs.reduce((total, stub) => total + stub.estTokens, 0),
		stubs,
		dropped: [],
	};
}

export function contextTurns(snapshot: SessionSnapshot): ContextTurn[] {
	const turns: ContextTurn[] = [];
	let current: ContextTurn | null = null;
	for (const entry of snapshot.contextEntries) {
		if (entry.type === "message" && entry.message.role === "user") {
			current = {
				userId: entry.id,
				label: firstLine(contentText(entry.message.content, "\n")),
				entryIds: [entry.id],
				estTokens: estimateEntryTokens(entry),
			};
			turns.push(current);
		} else if (current && isAnswerEntry(entry)) {
			current.entryIds.push(entry.id);
			current.estTokens += estimateEntryTokens(entry);
		} else {
			current = null;
		}
	}
	return turns;
}

export function planRemoveTurns(snapshot: SessionSnapshot, userIds: string[]): CropPlan {
	const position = new Map(snapshot.contextEntries.map((entry, index) => [entry.id, index]));
	const byUser = new Map(contextTurns(snapshot).map((turn) => [turn.userId, turn]));
	for (const id of userIds) {
		if (!byUser.has(id)) throw new Error(`entry ${id} is not a user question (only whole turns can be removed)`);
	}
	const ordered = [...userIds].sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
	const firstTurn = ordered[0] ? byUser.get(ordered[0]) : undefined;
	const lastTurn = ordered.at(-1) ? byUser.get(ordered.at(-1) as string) : undefined;
	const rewrite = prepareMarkedRange(
		snapshot,
		firstTurn?.entryIds[0],
		lastTurn?.entryIds.at(-1),
		"marked turn is not in a safe rewrite group",
	);
	const dropped: CtreeCropDrop[] = ordered.map((userId) => {
		const turn = byUser.get(userId) as ContextTurn;
		const body = turn.entryIds
			.map((id) => serializeEntry(snapshotEntry(snapshot, id) as SessionEntry) ?? "")
			.join("\n");
		return {
			userId,
			entryIds: turn.entryIds,
			label: turn.label,
			estTokens: turn.estTokens,
			sha8: createHash("sha256").update(body).digest("hex").slice(0, 8),
		};
	});
	return {
		...rewrite,
		reclaimTokens: dropped.reduce((total, drop) => total + drop.estTokens, 0),
		stubs: [],
		dropped,
	};
}

function stubLine(stub: CtreeCropStub): string {
	return `[cropped: ${stub.tool}${stub.arg ? ` ${stub.arg}` : ""}, ~${fmtTokens(stub.estTokens)}, ${stub.sha8}]`;
}

function dropLine(drop: CtreeCropDrop): string {
	return `[dropped turn — ${drop.entryIds.length} entries, ~${fmtTokens(drop.estTokens)}, recoverable: ${drop.sha8}]`;
}

export function renderReconstruction(plan: CropPlan): string {
	const stubbed = new Map(plan.stubs.map((stub) => [stub.entryId, stub]));
	const dropFirst = new Map(plan.dropped.map((drop) => [drop.entryIds[0] as string, drop]));
	const droppedIds = new Set(plan.dropped.flatMap((drop) => drop.entryIds));
	const header =
		plan.dropped.length === 0
			? `[pi-context-compress/crop: rebuilt context after cropping ${plan.stubs.length} entries, ~${fmtTokens(
					plan.reclaimTokens,
				)} tokens reclaimed. Originals preserved on the previous branch (leaf ${plan.sourceLeafId}).]`
			: `[pi-context-compress/crop: rebuilt context after ${[
					`removing ${plan.dropped.length} turn${plan.dropped.length === 1 ? "" : "s"}`,
					plan.stubs.length ? `cropping ${plan.stubs.length} entr${plan.stubs.length === 1 ? "y" : "ies"}` : "",
				]
					.filter(Boolean)
					.join(" + ")}, ~${fmtTokens(
					plan.reclaimTokens,
				)} tokens reclaimed. Originals preserved on the previous branch (leaf ${plan.sourceLeafId}).]`;
	const parts: string[] = [];
	for (const entry of plan.selectedEntries) {
		const drop = dropFirst.get(entry.id);
		if (drop) {
			parts.push(dropLine(drop));
			continue;
		}
		if (droppedIds.has(entry.id)) continue;
		const stub = stubbed.get(entry.id);
		parts.push(stub ? stubLine(stub) : (serializeEntry(entry) ?? ""));
	}
	if (plan.continuationSerialized.trim()) parts.push(plan.continuationSerialized);
	return `${header}\n\n${parts.filter(Boolean).join("\n\n")}\n`;
}

export async function applyCropPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: CropPlan): Promise<void> {
	const details = {
		v: 1 as const,
		sourceLeafId: plan.sourceLeafId,
		stubbed: plan.stubs,
		...(plan.dropped.length ? { dropped: plan.dropped } : {}),
	};
	try {
		const applied = await applyRewrite(pi, ctx, plan, {
			messages: [
				{
					customType: CTREE_CROP_TAIL,
					content: renderReconstruction(plan),
					display: true,
					details,
				},
			],
			marker: { customType: CTREE_CROP, data: details },
		});
		if (!applied) {
			ctx.ui.notify("crop aborted — navigation cancelled, nothing written", "warning");
			return;
		}
	} catch (error) {
		ctx.ui.notify(`${(error as Error).message} re-run /crop (nothing written)`, "warning");
		return;
	}
	refreshAmbient(ctx);
	ctx.ui.notify(cropAppliedMessage(plan), "info");
}

function cropAppliedMessage(plan: CropPlan): string {
	const parts: string[] = [];
	if (plan.dropped.length) parts.push(`removed ${plan.dropped.length} turn${plan.dropped.length === 1 ? "" : "s"}`);
	if (plan.stubs.length) {
		parts.push(`cropped ${plan.stubs.length} entr${plan.stubs.length === 1 ? "y" : "ies"} → stubs`);
	}
	return `✂ ${parts.join(" + ") || "nothing"} · ~${fmtTokens(plan.reclaimTokens)} reclaimed · originals on the previous branch`;
}


File: src/draft.ts

/** Decision-record drafting through Pi's public model registry. */

import { type Model, contentText } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens } from "./context.ts";

export type DraftFn = (
	ctx: ExtensionCommandContext,
	modelRef: string | undefined,
	system: string,
	user: string,
	signal?: AbortSignal,
) => Promise<string>;

export function modelKey(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function resolveModel(ctx: ExtensionContext, reference: string): Model<any> | undefined {
	if (reference.includes("/")) {
		const [provider, ...modelId] = reference.split("/");
		return ctx.modelRegistry.find(provider ?? "", modelId.join("/"));
	}
	const models = ctx.modelRegistry.getAll();
	const exact = models.find((model) => model.id === reference);
	if (exact) return exact;
	const matches = models.filter((model) => model.id.includes(reference));
	return matches.length === 1 ? matches[0] : undefined;
}

export const DRAFT_SYSTEM_PROMPT = [
	"You write terse engineering decision records for a coding-agent session.",
	"Output ONLY the markdown record, no preamble. Target 1,000–2,000 tokens.",
	"Be specific: real file paths, real failure modes, real numbers from the transcript.",
].join("\n");

const RANGE_COMPRESSION_SYSTEM_PROMPT = [
	"Summarize one user-selected range from a coding-agent session.",
	"Return summary text only. Do not add a preamble, analysis, or comments about summarizing.",
	"Preserve all information that later work can depend on:",
	"- the user's intent, requirements, and constraints",
	"- decisions, alternatives, and rejected approaches with their reasons",
	"- exact file paths, identifiers, symbols, versions, and important values",
	"- commands and important output needed to understand or repeat the work",
	"- errors, failed attempts, and their known causes",
	"- external side effects, including files, services, messages, and remote changes",
	"- validation state: what was tested, what passed, what failed, and what was not run",
	"- unfinished work, blockers, and the next concrete action",
	"Do not invent results or remove uncertainty. State unknown or unverified facts clearly.",
].join("\n");

export const realDraft: DraftFn = async (ctx, modelRef, system, user, signal) => {
	const model: Model<any> | undefined = (modelRef ? resolveModel(ctx, modelRef) : undefined) ?? ctx.model;
	if (!model) throw new Error("no model available for drafting");
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: system,
			messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
		},
		{ signal },
	);
	const text = contentText(response.content, "\n").trim();
	if (!text) throw new Error("model returned an empty draft");
	return text;
};

export function draftUserPrompt(branchName: string, template: string, serialized: string, extra?: string): string {
	return [
		`Squash-merge the branch "${branchName}" into a decision record using EXACTLY this template:`,
		"",
		template,
		extra ? `Additional instructions from the user: ${extra}` : "",
		"",
		"Branch transcript (tool outputs truncated):",
		"---",
		serialized,
		"---",
	]
		.filter(Boolean)
		.join("\n");
}

/** Build the summary request with the complete selected source and no per-message truncation. */
function rangeCompressionUserPrompt(selectedSerialized: string, instructions?: string): string {
	if (!selectedSerialized.trim()) throw new Error("the selected range has no serializable source text");
	return [
		"Summarize the complete selected session range below.",
		instructions?.trim() ? `Additional instructions from the user:\n${instructions.trim()}` : "",
		"<selected-session-range>",
		selectedSerialized,
		"</selected-session-range>",
	]
		.filter(Boolean)
		.join("\n\n");
}

function assertRangeSummaryFits(ctx: ExtensionCommandContext, userPrompt: string): void {
	if (!ctx.model) throw new Error("cannot check the selected range size because no current model is available");
	const contextWindow = ctx.model.contextWindow;
	const modelRef = `${ctx.model.provider}/${ctx.model.id}`;
	if (!contextWindow || contextWindow <= 0) {
		throw new Error(
			`cannot check the selected range size because ${modelRef} does not report a context window; select a smaller range or choose a model with context metadata`,
		);
	}
	const inputTokens = estimateTextTokens(`${RANGE_COMPRESSION_SYSTEM_PROMPT}\n${userPrompt}`);
	const summaryOutputReserveTokens = Math.min(4096, ctx.model.maxTokens);
	const requiredTokens = inputTokens + summaryOutputReserveTokens;
	if (requiredTokens > contextWindow) {
		throw new Error(
			`selected range is too large for ${modelRef}: the prompt needs ~${inputTokens} input tokens plus ${summaryOutputReserveTokens} reserved output tokens, but the context window is ${contextWindow}; select a smaller range with /compress or switch the current model`,
		);
	}
}

/** Draft with the current model by leaving DraftFn's model reference undefined. */
export async function draftRangeSummary(
	draft: DraftFn,
	ctx: ExtensionCommandContext,
	selectedSerialized: string,
	instructions?: string,
	signal?: AbortSignal,
): Promise<string> {
	const userPrompt = rangeCompressionUserPrompt(selectedSerialized, instructions);
	assertRangeSummaryFits(ctx, userPrompt);
	return draft(ctx, undefined, RANGE_COMPRESSION_SYSTEM_PROMPT, userPrompt, signal);
}


File: src/index.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmbient } from "./ambient.ts";
import { registerBranch, registerMerge, registerUndo } from "./branches.ts";
import { realDraft } from "./draft.ts";
import { registerCrop, registerDecisionRenderer, registerPanel } from "./panel.ts";
import { registerCompressionServices, registerRangeCompress } from "./range-compression.ts";

export default function piContextCompress(api: ExtensionAPI): void {
	registerBranch(api);
	registerMerge(api, realDraft);
	registerCrop(api);
	registerRangeCompress(api);
	registerCompressionServices(api);
	registerPanel(api, realDraft);
	registerUndo(api);
	registerAmbient(api);
	registerDecisionRenderer(api);
}


File: src/panel.ts

import { basename } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	TreeSelectorComponent,
	getMarkdownTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type TUI,
	Text,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import parseArgs from "yargs-parser";
import { renderGauge } from "./ambient.ts";
import { branchHandler, exportDecisions, mergeHandler, notifyDecisions, parseDecisionArgs } from "./branches.ts";
import {
	type ForkInfo,
	type SessionSnapshot,
	aggregateConsumers,
	decisionsOnPath,
	deriveState,
	estimateEntryTokens,
	fmtTokens,
	nearestOpenFork,
	serializeEntry,
} from "./context.ts";
import {
	type ContextTurn,
	type CropCandidate,
	type CropPlan,
	applyCropPlan,
	autoSelect,
	contextTurns,
	cropCandidates,
	planCrop,
	planRemoveTurns,
} from "./crop.ts";
import type { DraftFn } from "./draft.ts";
import {
	CTREE_DECISION,
	type CtreeDecisionDetails,
	ctreeDecisionDetails,
	parseCtreeDecisionDetails,
} from "./protocol.ts";

type PiTheme = ExtensionContext["ui"]["theme"];
type NativeTree = ReturnType<ExtensionContext["sessionManager"]["getTree"]>;

export type PanelView = "tree" | "crop" | "consumers" | "decisions" | "inspect";

export interface PanelInput extends SessionSnapshot {
	forks: ForkInfo[];
	project: string;
	sessionName?: string;
	model?: string;
	contextWindow?: number;
	usageTokens?: number | null;
	dryRun?: boolean;
	initialView?: PanelView;
	premark?: string[];
}

type PanelAction =
	| { type: "close" }
	| { type: "jump"; entryId: string }
	| { type: "branch"; entryId: string }
	| { type: "merge" }
	| { type: "crop-apply"; plan: CropPlan; dryRun: boolean };

interface CropFlags {
	auto: boolean;
	dryRun: boolean;
	apply: boolean;
	top: boolean;
	minTokens?: number;
	olderThan?: number;
	keep: string[];
}

const CROP_ARGUMENT_CONFIGURATION = {
	"boolean-negation": false,
	"camel-case-expansion": false,
	"parse-numbers": false,
	"unknown-options-as-args": true,
} as const;

export interface PanelOpenOptions {
	initialView?: PanelView;
	premark?: string[];
	dryRun?: boolean;
}

export interface ContextPanelOptions {
	input: PanelInput;
	tui: TUI;
	theme: PiTheme;
	onAction: (action: PanelAction) => void;
	onNotify?: (message: string) => void;
	maxBody?: number;
}

class PanelController {
	view: PanelView;
	cropMode: "result" | "turn" = "result";
	readonly marks = new Set<string>();
	readonly turnMarks = new Set<string>();
	armedId: string | undefined;
	inspectId: string | undefined;
	inspectOffset = 0;

	constructor(readonly input: PanelInput) {
		this.view = input.initialView ?? "tree";
		for (const id of input.premark ?? []) this.marks.add(id);
	}

	setView(view: PanelView): void {
		this.view = view;
		this.armedId = undefined;
		this.inspectOffset = 0;
	}

	sectionTitle(): string | undefined {
		switch (this.view) {
			case "tree": {
				const title = "TRUNK + BRANCHES · est tokens (~chars/4)";
				return this.input.sessionName ? `SESSION ${this.input.sessionName} · ${title}` : title;
			}
			case "crop": {
				if (this.cropMode === "turn") {
					const reclaim = contextTurns(this.input)
						.filter((turn) => this.turnMarks.has(turn.userId))
						.reduce((total, turn) => total + turn.estTokens, 0);
					return `REMOVE WHOLE TURNS — question + its answers drop together · reclaim ~${fmtTokens(reclaim)} · originals kept on the previous branch`;
				}
				const candidates = cropCandidates(this.input);
				const reclaim = candidates
					.filter((candidate) => this.marks.has(candidate.entryId))
					.reduce((total, candidate) => total + candidate.estTokens, 0);
				return `CROP — TOOL/MCP RESULTS ON THIS BRANCH · reclaim ~${fmtTokens(reclaim)} · stubs land on a new branch point, originals untouched`;
			}
			case "consumers":
				return "TOKENS BY SOURCE — CURRENT BRANCH CONTEXT";
			case "decisions":
				return "DECISION RECORDS ON TRUNK (newest first)";
			case "inspect":
				return undefined;
		}
	}

	footerHelp(): string {
		switch (this.view) {
			case "tree":
				return "↑↓/jk move · ⏎ jump · ←→ fold · b branch · m merge · c crop · i inspect · D decisions · u consumers · q close";
			case "crop":
				return this.cropMode === "turn"
					? "space mark whole turn · ⏎ apply → new branch point · t results mode · esc back · q close"
					: "space mark · a auto · ⏎ apply → new branch point · t turn mode · esc back · q close";
			case "consumers":
				return "↑↓/jk move · c crop the big ones · esc back · q close";
			case "decisions":
				return "↑↓/jk move · ⏎ jump to record · esc back · q close";
			case "inspect":
				return "↑↓/jk scroll · c crop this entry · esc back · q close";
		}
	}
}

function selectTheme(theme: PiTheme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function currentTurnId(input: PanelInput, turns: readonly ContextTurn[]): string | undefined {
	return turns.find((turn) => turn.entryIds.includes(input.leafId ?? ""))?.userId;
}

function decorateTree(nodes: NativeTree, forks: readonly ForkInfo[]): NativeTree {
	const byId = new Map(forks.map((fork) => [fork.entryId, fork]));
	return nodes.map((node) => {
		const fork = byId.get(node.entry.id);
		return {
			...node,
			label: fork ? `${fork.data.name} · ${fork.status}` : node.label,
			children: decorateTree(node.children, forks),
		};
	});
}

export class ContextPanel {
	focused = false;
	readonly opts: ContextPanelOptions;
	readonly controller: PanelController;
	private body: Component & { dispose?(): void };
	private treeSelector: TreeSelectorComponent | undefined;
	private cropList: SettingsList | undefined;
	private lastNotify: string | undefined;

	constructor(opts: ContextPanelOptions) {
		this.opts = opts;
		this.controller = new PanelController(opts.input);
		this.body = new Text("", 0, 0);
		this.body = this.createBody();
	}

	private notify(message: string): void {
		this.lastNotify = message;
		this.opts.onNotify?.(message);
		this.opts.tui.requestRender();
	}

	private selectedTreeEntryId(): string | undefined {
		return this.treeSelector?.getTreeList().getSelectedNode()?.entry.id ?? this.opts.input.leafId ?? undefined;
	}

	private createTree(): TreeSelectorComponent {
		const selector = new TreeSelectorComponent(
			decorateTree(this.opts.input.tree, this.opts.input.forks),
			this.opts.input.leafId,
			Math.max(10, (this.opts.maxBody ?? 26) * 2),
			(entryId) => this.opts.onAction({ type: "jump", entryId }),
			() => this.opts.onAction({ type: "close" }),
			undefined,
			this.controller.inspectId ?? this.opts.input.leafId ?? undefined,
			"all",
		);
		this.treeSelector = selector;
		return selector;
	}

	private resultSettings(): SettingsList {
		const candidates = cropCandidates(this.opts.input);
		const items: SettingItem[] = candidates.map((candidate) => {
			const marked = this.controller.marks.has(candidate.entryId);
			const currentValue = marked ? "crop" : candidate.protected ? "protected" : "keep";
			return {
				id: candidate.entryId,
				label: `⚙ [${candidate.tool}${candidate.arg ? ` ${candidate.arg}` : ""}] · ~${fmtTokens(candidate.estTokens)} · ${candidate.ageTurns}t`,
				description: candidate.protected
					? "Latest result for this tool. Select crop twice to override protection."
					: undefined,
				currentValue,
				values: candidate.protected ? ["protected", "crop"] : ["keep", "crop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			getSettingsListTheme(),
			(id, value) => {
				const candidate = candidates.find((item) => item.entryId === id);
				if (!candidate) return;
				if (candidate.protected && value === "crop" && this.controller.armedId !== id) {
					this.controller.armedId = id;
					list.updateValue(id, "protected");
					this.notify(`${candidate.tool} is the latest result of its tool — space again to crop it anyway (F3.3)`);
					return;
				}
				if (value === "crop") this.controller.marks.add(id);
				else this.controller.marks.delete(id);
				this.controller.armedId = undefined;
				list.updateValue(id, this.controller.marks.has(id) ? "crop" : candidate.protected ? "protected" : "keep");
				this.opts.tui.requestRender();
			},
			() => this.switchView("tree"),
		);
		this.cropList = list;
		return list;
	}

	private turnSettings(): SettingsList {
		const turns = contextTurns(this.opts.input);
		const protectedId = currentTurnId(this.opts.input, turns);
		const items: SettingItem[] = turns.map((turn) => {
			const isProtected = turn.userId === protectedId;
			return {
				id: turn.userId,
				label: `● user: ${turn.label} · ${turn.entryIds.length} entries · ~${fmtTokens(turn.estTokens)}`,
				description: isProtected ? "The current turn cannot be removed." : undefined,
				currentValue: this.controller.turnMarks.has(turn.userId) ? "drop" : isProtected ? "protected" : "keep",
				values: isProtected ? ["protected"] : ["keep", "drop"],
			};
		});
		const list = new SettingsList(
			items,
			this.opts.maxBody ?? 26,
			getSettingsListTheme(),
			(id, value) => {
				if (id === protectedId) {
					list.updateValue(id, "protected");
					this.notify("that's the current turn (you're in it) — can't remove it");
					return;
				}
				if (value === "drop") this.controller.turnMarks.add(id);
				else this.controller.turnMarks.delete(id);
				this.opts.tui.requestRender();
			},
			() => this.switchView("tree"),
		);
		this.cropList = list;
		return list;
	}

	private createConsumers(): SelectList {
		const consumers = aggregateConsumers(this.opts.input.contextEntries);
		const largest = Math.max(1, ...consumers.map((consumer) => consumer.tokens));
		const items: SelectItem[] = consumers.map((consumer) => ({
			value: consumer.key,
			label: `${consumer.key} · ${consumer.entries} ${consumer.entries === 1 ? "entry" : "entries"} · ${(consumer.share * 100).toFixed(0)}%`,
			description: `${fmtTokens(consumer.tokens).padStart(7)} ${"▰".repeat(Math.max(1, Math.round((consumer.tokens / largest) * 28)))}`,
		}));
		const list = new SelectList(items, this.opts.maxBody ?? 26, selectTheme(this.opts.theme));
		list.onCancel = () => this.switchView("tree");
		return list;
	}

	private createDecisions(): Container {
		const decisions = [...decisionsOnPath(this.opts.input.branch)].reverse();
		const forks = new Map(this.opts.input.forks.map((fork) => [fork.entryId, fork]));
		const detailsById = new Map<string, string>();
		const items: SelectItem[] = decisions.map((decision) => {
			const details = ctreeDecisionDetails(decision);
			const fork = details ? forks.get(details.forkEntryId) : undefined;
			const model = fork?.data.branchModel ?? fork?.data.trunkModel ?? "—";
			const text = contentText(decision.content, "\n");
			const outcome =
				text
					.split("\n")
					.find((line) => line.startsWith("**Outcome:**"))
					?.replace("**Outcome:**", "")
					.trim() ??
				text.split("\n")[0] ??
				"";
			const lines = [
				`${decision.timestamp.slice(0, 10)} · drafted by ${model} · branch ${details?.forkEntryId ?? "—"} · human-confirmed ✓`,
				outcome,
				...(details?.siblings ?? []).map((sibling) => `✗ ${sibling.name} — ${sibling.reason}`),
			];
			detailsById.set(decision.id, lines.join("\n"));
			return { value: decision.id, label: `◆ ${details?.branchName ?? "decision"}` };
		});
		if (items.length === 0) {
			items.push({ value: "", label: "(no decision records on this trunk yet — /merge → squash creates them)" });
		}
		const list = new SelectList(items, Math.max(3, (this.opts.maxBody ?? 26) - 5), selectTheme(this.opts.theme));
		const detail = new Text("", 2, 0);
		const showDetails = (item: SelectItem): void => {
			detail.setText(detailsById.get(item.value) ?? "");
			this.opts.tui.requestRender();
		};
		if (items[0]) showDetails(items[0]);
		list.onSelectionChange = showDetails;
		list.onSelect = (item) => {
			if (item.value) this.opts.onAction({ type: "jump", entryId: item.value });
		};
		list.onCancel = () => this.switchView("tree");
		const container = new Container();
		container.addChild(list);
		container.addChild(detail);
		return Object.assign(container, {
			handleInput: (data: string) => list.handleInput(data),
		});
	}

	private createInspect(): Component {
		const entry = this.controller.inspectId
			? this.opts.input.entries.find((candidate) => candidate.id === this.controller.inspectId)
			: undefined;
		if (!entry) return new Text("(nothing selected)", 0, 0);
		const tokens = estimateEntryTokens(entry);
		const tool =
			entry.type === "message" && entry.message.role === "toolResult" ? ` · tool ${entry.message.toolName}` : "";
		const meta = `id ${entry.id} · type ${entry.type}${tool} · ~${fmtTokens(tokens)} tokens (${(
			tokens * 4
		).toLocaleString("en-US")} chars) · parent ${entry.parentId ?? "—"}`;
		const lines = (serializeEntry(entry) ?? "(no content)").split("\n");
		const visible = lines.slice(
			this.controller.inspectOffset,
			this.controller.inspectOffset + (this.opts.maxBody ?? 26),
		);
		return new Markdown(`${meta}\n\n\`\`\`text\n${visible.join("\n")}\n\`\`\``, 0, 0, getMarkdownTheme());
	}

	private createBody(): Component & { dispose?(): void } {
		this.treeSelector = undefined;
		this.cropList = undefined;
		switch (this.controller.view) {
			case "tree":
				return this.createTree();
			case "crop":
				return this.controller.cropMode === "turn" ? this.turnSettings() : this.resultSettings();
			case "consumers":
				return this.createConsumers();
			case "decisions":
				return this.createDecisions();
			case "inspect":
				return this.createInspect();
		}
	}

	private switchView(view: PanelView): void {
		this.controller.setView(view);
		this.body.dispose?.();
		this.body = this.createBody();
		this.lastNotify = undefined;
		this.opts.tui.requestRender();
	}

	private delegate(data: string): void {
		this.body.handleInput?.(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
		this.opts.tui.requestRender();
	}

	private applyCrop(): void {
		try {
			if (this.controller.cropMode === "turn") {
				if (this.controller.turnMarks.size === 0) {
					this.notify("no turns marked — space to mark a whole Q&A turn");
					return;
				}
				this.opts.onAction({
					type: "crop-apply",
					plan: planRemoveTurns(this.opts.input, [...this.controller.turnMarks]),
					dryRun: this.opts.input.dryRun ?? false,
				});
				return;
			}
			if (this.controller.marks.size === 0) {
				this.notify("nothing marked — space to mark entries");
				return;
			}
			this.opts.onAction({
				type: "crop-apply",
				plan: planCrop(this.opts.input, [...this.controller.marks]),
				dryRun: this.opts.input.dryRun ?? false,
			});
		} catch (error) {
			this.notify((error as Error).message);
		}
	}

	handleInput(data: string): void {
		if (data === "q") {
			this.opts.onAction({ type: "close" });
			return;
		}
		const isEscape = matchesKey(data, "escape");
		const isEnter = matchesKey(data, "enter");
		if (this.controller.view === "tree") {
			if (data === "c") {
				this.switchView("crop");
				return;
			}
			if (data === "D") {
				this.switchView("decisions");
				return;
			}
			if (data === "u") {
				this.switchView("consumers");
				return;
			}
			if (data === "m") {
				this.opts.onAction({ type: "merge" });
				return;
			}
			if (data === "b") {
				const entryId = this.selectedTreeEntryId();
				if (entryId) this.opts.onAction({ type: "branch", entryId });
				return;
			}
			if (data === "i") {
				this.controller.inspectId = this.selectedTreeEntryId();
				this.switchView("inspect");
				return;
			}
			this.delegate(data);
			return;
		}
		if (isEscape) {
			this.switchView("tree");
			return;
		}
		if (this.controller.view === "crop") {
			if (data === "c") {
				this.switchView("tree");
				return;
			}
			if (data === "t") {
				this.controller.cropMode = this.controller.cropMode === "result" ? "turn" : "result";
				this.switchView("crop");
				return;
			}
			if (data === "a" && this.controller.cropMode === "result") {
				const ids = autoSelect(cropCandidates(this.opts.input), {});
				for (const id of ids) {
					this.controller.marks.add(id);
					this.cropList?.updateValue(id, "crop");
				}
				this.notify(`--auto marked ${ids.length} (protected skipped) — review, then ⏎ to apply`);
				return;
			}
			if (isEnter) {
				this.applyCrop();
				return;
			}
			this.delegate(data);
			return;
		}
		if (this.controller.view === "consumers") {
			if (data === "c") {
				this.switchView("crop");
				return;
			}
			this.delegate(data);
			return;
		}
		if (this.controller.view === "decisions") {
			this.delegate(data);
			return;
		}
		if (this.controller.view !== "inspect") return;
		if (data === "j" || matchesKey(data, "down")) this.controller.inspectOffset += 1;
		else if (data === "k" || matchesKey(data, "up")) {
			this.controller.inspectOffset = Math.max(0, this.controller.inspectOffset - 1);
		} else if (data === "c") {
			const id = this.controller.inspectId;
			if (id && cropCandidates(this.opts.input).some((candidate) => candidate.entryId === id)) {
				this.controller.marks.add(id);
				this.controller.cropMode = "result";
				this.switchView("crop");
				this.notify("pre-marked from inspector — review, then ⏎ to apply");
				return;
			}
			this.notify("only tool/MCP results are croppable (F3.3)");
			return;
		} else return;
		this.body = this.createInspect();
		this.opts.tui.requestRender();
	}

	render(width: number): string[] {
		const input = this.opts.input;
		const currentFork = nearestOpenFork(input.branch, input.forks);
		const session = input.sessionName ? ` · ${input.sessionName}` : "";
		const frame = new Container();
		frame.addChild(
			new Text(
				` ${this.opts.theme.fg("accent", this.opts.theme.bold("pi-context-compress"))} ${this.opts.theme.fg("dim", `· ${this.controller.view}`)}  ${input.project}${this.opts.theme.fg("dim", session)} ${this.opts.theme.fg("success", `⎇ ${currentFork?.data.name ?? "trunk"}`)}${input.model ? this.opts.theme.fg("dim", ` · ${input.model}`) : ""}`,
				0,
				0,
			),
		);
		frame.addChild(
			new Text(
				` ${renderGauge(
					{
						tokens: input.usageTokens ?? null,
						window: input.contextWindow,
						barWidth: Math.min(30, Math.max(10, width - 50)),
					},
					this.opts.theme,
				)}`,
				0,
				0,
			),
		);
		frame.addChild(new Text(this.opts.theme.fg("dim", "─".repeat(Math.max(0, width))), 0, 0));
		const title = this.controller.sectionTitle();
		if (title) frame.addChild(new Text(` ${this.opts.theme.fg("dim", title)}`, 0, 0));
		frame.addChild(this.body);
		if (this.controller.view === "decisions") {
			frame.addChild(
				new Text(
					this.opts.theme.fg("dim", " (epitaphs keep the trunk model from re-proposing rejected approaches — G3)"),
					0,
					0,
				),
			);
		}
		frame.addChild(new Text(this.opts.theme.fg("dim", "─".repeat(Math.max(0, width))), 0, 0));
		frame.addChild(new Text(this.lastNotify ? ` ${this.opts.theme.fg("warning", this.lastNotify)}` : "", 0, 0));
		frame.addChild(new Text(` ${this.opts.theme.fg("dim", this.controller.footerHelp())}`, 0, 0));
		return frame.render(width).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.body.invalidate();
	}

	dispose(): void {
		this.body.dispose?.();
	}
}

export function buildPanelInput(ctx: ExtensionContext, opts: PanelOpenOptions = {}): PanelInput {
	const usage = ctx.getContextUsage();
	const state = deriveState(ctx);
	return {
		sessionId: state.sessionId,
		entries: state.entries,
		branch: state.branch,
		contextEntries: state.contextEntries,
		tree: state.tree,
		forks: state.forks,
		leafId: state.leafId,
		project: basename(ctx.cwd),
		sessionName: ctx.sessionManager.getSessionName(),
		model: ctx.model?.id,
		contextWindow: ctx.model?.contextWindow ?? usage?.contextWindow,
		usageTokens: usage?.tokens,
		dryRun: opts.dryRun,
		initialView: opts.initialView,
		premark: opts.premark,
	};
}

async function openPanel(ctx: ExtensionContext, opts: PanelOpenOptions = {}): Promise<PanelAction | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("the context panel needs pi's interactive TUI (ui.custom unavailable in this mode)", "warning");
		return undefined;
	}
	const input = buildPanelInput(ctx, opts);
	const action = await ctx.ui.custom<PanelAction>(
		(tui, theme, _keybindings, done) => {
			const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
			return new ContextPanel({
				input,
				tui,
				theme,
				maxBody: Math.max(8, (rows ?? 34) - 9),
				onAction: done,
			});
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "100%" } },
	);
	return action;
}

function parseCropFlags(args: string): CropFlags {
	const parsed = parseArgs(args, {
		array: ["keep"],
		boolean: ["auto", "dry-run", "apply", "top"],
		number: ["min-tokens", "older-than"],
		string: ["keep"],
		configuration: CROP_ARGUMENT_CONFIGURATION,
	});
	const keep = parsed.keep === undefined ? [] : (Array.isArray(parsed.keep) ? parsed.keep : [parsed.keep]).map(String);
	return {
		auto: parsed.auto === true,
		dryRun: parsed["dry-run"] === true,
		apply: parsed.apply === true,
		top: parsed.top === true,
		minTokens: typeof parsed["min-tokens"] === "number" ? parsed["min-tokens"] : undefined,
		olderThan: typeof parsed["older-than"] === "number" ? parsed["older-than"] : undefined,
		keep,
	};
}

function notifyDryRun(ctx: ExtensionCommandContext, plan: CropPlan): void {
	const lines = plan.stubs.map((stub) => `${stub.tool}${stub.arg ? ` ${stub.arg}` : ""} ~${fmtTokens(stub.estTokens)}`);
	ctx.ui.notify(
		`(dry-run) would crop ${plan.stubs.length}: ${lines.join(" · ")} — reclaim ~${fmtTokens(plan.reclaimTokens)}; nothing written`,
		"info",
	);
}

export async function cropHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	await ctx.waitForIdle();
	const flags = parseCropFlags(args);
	const state = deriveState(ctx);
	if (!state.leafId) {
		ctx.ui.notify("empty session — nothing to crop", "warning");
		return;
	}
	const candidates = cropCandidates(state);
	if (candidates.length === 0) {
		ctx.ui.notify("no tool/MCP results on this branch — nothing to crop", "info");
		return;
	}

	if (flags.top) {
		const unprotected = candidates.filter((candidate) => !candidate.protected);
		if (unprotected.length === 0) {
			ctx.ui.notify("every candidate is its tool's latest result (protected) — open /crop to double-mark", "info");
			return;
		}
		const top = unprotected.reduce((left, right) => (right.estTokens > left.estTokens ? right : left));
		const confirmed = await ctx.ui.confirm(
			"Crop the biggest result",
			`✂ ${top.tool}${top.arg ? ` ${top.arg}` : ""} ~${fmtTokens(top.estTokens)} → crop this result? (original stays recoverable)`,
		);
		if (!confirmed) {
			ctx.ui.notify("crop cancelled — nothing written", "info");
			return;
		}
		const plan = planCrop(state, [top.entryId]);
		if (flags.dryRun) return notifyDryRun(ctx, plan);
		await applyCropPlan(pi, ctx, plan);
		return;
	}

	if (flags.apply && !flags.auto) {
		ctx.ui.notify("--apply needs --auto rules (interactive review applies from the panel)", "error");
		return;
	}
	const premark = flags.auto
		? autoSelect(candidates, {
				minTokens: flags.minTokens,
				olderThanTurns: flags.olderThan,
				keep: flags.keep,
			})
		: [];
	if (flags.auto && flags.apply) {
		if (premark.length === 0) {
			ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — nothing to crop", "info");
			return;
		}
		const plan = planCrop(state, premark);
		if (flags.dryRun) return notifyDryRun(ctx, plan);
		await applyCropPlan(pi, ctx, plan);
		return;
	}
	if (flags.auto && premark.length === 0) {
		ctx.ui.notify("--auto matched nothing (protected/latest results are skipped) — opening review anyway", "info");
	}
	const action = await openPanel(ctx, { initialView: "crop", premark, dryRun: flags.dryRun });
	if (!action || action.type !== "crop-apply") return;
	if (action.dryRun) return notifyDryRun(ctx, action.plan);
	await applyCropPlan(pi, ctx, action.plan);
}

export function registerCrop(pi: ExtensionAPI): void {
	pi.registerCommand("crop", {
		description:
			"pi-context-compress: surgically stub out huge tool/MCP results (--top for the biggest; interactive; --auto --apply --dry-run)",
		handler: (args, ctx) => cropHandler(pi, ctx, args),
		getArgumentCompletions: (prefix) => {
			const flags = ["--top", "--auto", "--apply", "--dry-run", "--min-tokens", "--older-than", "--keep"];
			const last = prefix.split(/\s+/).pop() ?? "";
			const matches = flags.filter((flag) => flag.startsWith(last));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
	});
}

async function executePanelAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	action: PanelAction | undefined,
	draft: DraftFn,
): Promise<void> {
	if (!action || action.type === "close") return;
	switch (action.type) {
		case "jump": {
			const navigation = await ctx.navigateTree(action.entryId, { summarize: false });
			if (!navigation.cancelled) ctx.ui.notify(`jumped — context now ends at ${action.entryId}`, "info");
			return;
		}
		case "branch": {
			if (action.entryId !== ctx.sessionManager.getLeafId()) {
				const navigation = await ctx.navigateTree(action.entryId, { summarize: false });
				if (navigation.cancelled) return;
			}
			const name = await ctx.ui.input("branch name", "fix-flaky-test");
			if (!name?.trim()) return;
			const model = await ctx.ui.input("branch model (empty = keep current)", "");
			await branchHandler(pi, ctx, `${name.trim()}${model?.trim() ? ` ${model.trim()}` : ""}`);
			return;
		}
		case "merge":
			await mergeHandler(pi, ctx, "", draft);
			return;
		case "crop-apply":
			if (action.dryRun) {
				ctx.ui.notify(`(dry-run) would crop ${action.plan.stubs.length} — nothing written`, "info");
				return;
			}
			await applyCropPlan(pi, ctx, action.plan);
	}
}

async function runPanel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: DraftFn,
	opts: PanelOpenOptions = {},
): Promise<void> {
	while (true) {
		const action = await openPanel(ctx, opts);
		if (!action || action.type === "close") return;
		await executePanelAction(pi, ctx, action, draft);
	}
}

export function registerPanel(pi: ExtensionAPI, draft: DraftFn): void {
	pi.registerCommand("panel", {
		description: "pi-context-compress: full-screen context panel (tree · crop · consumers · decisions)",
		handler: (_args, ctx) => runPanel(pi, ctx, draft),
	});
	pi.registerShortcut("ctrl+q", {
		description: "pi-context-compress: open the context panel",
		handler: () => pi.sendUserMessage("/panel", { expandPromptTemplates: true }),
	});
	pi.registerCommand("decisions", {
		description:
			"pi-context-compress: decision records on the current trunk (F7) — --export [path] for portable markdown",
		handler: async (args, ctx) => {
			const parsed = parseDecisionArgs(args);
			if (parsed.export) {
				exportDecisions(ctx, parsed.exportPath);
				return;
			}
			if (ctx.mode !== "tui") {
				notifyDecisions(ctx);
				return;
			}
			await runPanel(pi, ctx, draft, { initialView: "decisions" });
		},
		getArgumentCompletions: (prefix) =>
			"--export".startsWith(prefix.split(/\s+/).pop() ?? "") ? [{ value: "--export", label: "--export" }] : null,
	});
}

export function registerDecisionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CtreeDecisionDetails>(CTREE_DECISION, (message, options, theme) => {
		const details = parseCtreeDecisionDetails(message.details);
		const content = contentText(message.content, "\n");
		const body = content.split("\n");
		const container = new Container();
		container.addChild(
			new Text(
				`${theme.fg("accent", "◆")} ${theme.fg("accent", details?.branchName ?? "decision")} ${theme.fg(
					"dim",
					"— decision record (squash-merged branch)",
				)}`,
				0,
				0,
			),
		);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${message.timestamp ? new Date(message.timestamp).toISOString().slice(0, 10) : ""}${message.timestamp ? " · " : ""}human-confirmed ✓`,
				),
				0,
				0,
			),
		);
		if (options.expanded) container.addChild(new Markdown(content, 2, 0, getMarkdownTheme()));
		else {
			container.addChild(new Text(`  ${body.find((line) => line.startsWith("**Outcome:**")) ?? body[0] ?? ""}`, 0, 0));
			container.addChild(new Text(theme.fg("dim", "  (expand to see the full record)"), 0, 0));
		}
		for (const sibling of details?.siblings ?? []) {
			container.addChild(new Text(`  ${theme.fg("error", `✗ ${sibling.name} — ${sibling.reason}`)}`, 0, 0));
		}
		return container;
	});
}


File: src/protocol.ts

import type {
	CustomEntry,
	CustomMessageEntry,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const exact = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1 });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const CompressionOperationProperties = {
	v: Type.Literal(1),
	requestId: Id,
	sessionId: Id,
	operationId: Id,
};
const CompressionStatusSchema = Type.Union([
	Type.Literal("prepared"),
	Type.Literal("applied"),
	Type.Literal("cancelled"),
	Type.Literal("missing"),
	Type.Literal("failed"),
]);
const CompressionFailureCodeSchema = Type.Union([
	Type.Literal("invalid_request"),
	Type.Literal("operation_conflict"),
	Type.Literal("session_changed"),
	Type.Literal("compression_failed"),
	Type.Literal("not_prepared"),
	Type.Literal("busy"),
]);

export const CTREE_FORK = "ctree/fork";
export const CTREE_CLOSE = "ctree/close";
export const CTREE_DECISION = "ctree/decision";
export const CTREE_CROP = "ctree/crop";
export const CTREE_CROP_TAIL = "ctree/crop-tail";
export const CTREE_RANGE_COMPACT = "ctree/range-compact";
export const CTREE_RANGE_TAIL = "ctree/range-tail";
export const RANGE_COMPRESSION_REQUEST = "pi-context-compress/v1/range/request";
export const RANGE_COMPRESSION_RESULT = "pi-context-compress/v1/range/result";

export const CtreeCloseStatusSchema = Type.Union([
	Type.Literal("squashed"),
	Type.Literal("rejected"),
	Type.Literal("discarded"),
]);
export type CtreeCloseStatus = Static<typeof CtreeCloseStatusSchema>;

export const CtreeForkDataSchema = Type.Object({
	v: Type.Literal(1),
	name: Type.String(),
	parentEntryId: Type.Union([Type.String(), Type.Null()]),
	trunkModel: Type.Optional(Type.String()),
	branchModel: Type.Optional(Type.String()),
	createdAt: Type.Number(),
	status: Type.Literal("open"),
});
export type CtreeForkData = Static<typeof CtreeForkDataSchema>;

export const CtreeCloseDataSchema = Type.Object({
	v: Type.Literal(1),
	forkEntryId: Type.String(),
	status: CtreeCloseStatusSchema,
	decisionEntryId: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	prevLeafId: Type.Optional(Type.String()),
});
export type CtreeCloseData = Static<typeof CtreeCloseDataSchema>;

export const CtreeCropStubSchema = Type.Object({
	entryId: Type.String(),
	tool: Type.String(),
	arg: Type.Optional(Type.String()),
	estTokens: Type.Number(),
	sha8: Type.String(),
});
export type CtreeCropStub = Static<typeof CtreeCropStubSchema>;

export const CtreeCropDropSchema = Type.Object({
	userId: Type.String(),
	entryIds: Type.Array(Type.String()),
	label: Type.String(),
	estTokens: Type.Number(),
	sha8: Type.String(),
});
export type CtreeCropDrop = Static<typeof CtreeCropDropSchema>;

export const CtreeCropDataSchema = Type.Object({
	v: Type.Literal(1),
	sourceLeafId: Type.String(),
	stubbed: Type.Array(CtreeCropStubSchema),
	dropped: Type.Optional(Type.Array(CtreeCropDropSchema)),
});
export type CtreeCropData = Static<typeof CtreeCropDataSchema>;

export const CtreeDecisionSiblingSchema = Type.Object({
	name: Type.String(),
	reason: Type.String(),
});

export const CtreeDecisionDetailsSchema = Type.Object({
	v: Type.Literal(1),
	forkEntryId: Type.String(),
	branchName: Type.String(),
	siblings: Type.Optional(Type.Array(CtreeDecisionSiblingSchema)),
});
export type CtreeDecisionDetails = Static<typeof CtreeDecisionDetailsSchema>;

export const CtreeRangeCompactDataSchema = Type.Object({
	v: Type.Literal(1),
	operationId: Type.Optional(Type.String()),
	sourceLeafId: Type.String(),
	anchorId: Type.String(),
	startEntryId: Type.String(),
	endEntryId: Type.String(),
	selectedEntryIds: Type.Array(Type.String()),
	selectedEstTokens: Type.Number(),
	summaryEstTokens: Type.Number(),
	reclaimedEstTokens: Type.Number(),
	summaryModel: Type.String(),
	sourceSha8: Type.String(),
});
export type CtreeRangeCompactData = Static<typeof CtreeRangeCompactDataSchema>;
export type CtreeRangeTailDetails = CtreeRangeCompactData;

export const RangeCompressionStatusSchema = CompressionStatusSchema;
export type RangeCompressionStatus = Static<typeof RangeCompressionStatusSchema>;

export const RangeCompressionFailureCodeSchema = CompressionFailureCodeSchema;
export type RangeCompressionFailureCode = Static<typeof RangeCompressionFailureCodeSchema>;

export const RangeCompressionRequestSchema = Type.Union([
	Type.Object(
		{
			...CompressionOperationProperties,
			action: Type.Literal("prepare"),
			startEntryId: Id,
			endEntryId: Id,
			review: Type.Boolean(),
			anchorEntryId: Type.Optional(Id),
			instructions: Type.Optional(Type.String()),
		},
		exact,
	),
	Type.Object({ ...CompressionOperationProperties, action: Type.Literal("apply") }, exact),
	Type.Object({ ...CompressionOperationProperties, action: Type.Literal("cancel") }, exact),
	Type.Object({ ...CompressionOperationProperties, action: Type.Literal("status") }, exact),
]);
export type RangeCompressionRequest = Static<typeof RangeCompressionRequestSchema>;
export type RangeCompressionPrepareRequest = Extract<RangeCompressionRequest, { action: "prepare" }>;
export type RangeCompressionApplyRequest = Extract<RangeCompressionRequest, { action: "apply" }>;
export type RangeCompressionCancelRequest = Extract<RangeCompressionRequest, { action: "cancel" }>;
export type RangeCompressionStatusRequest = Extract<RangeCompressionRequest, { action: "status" }>;

export const RangeCompressionResultSchema = Type.Union([
	Type.Object({ ...CompressionOperationProperties, status: Type.Literal("prepared") }, exact),
	Type.Object(
		{
			...CompressionOperationProperties,
			status: Type.Literal("applied"),
			details: CtreeRangeCompactDataSchema,
		},
		exact,
	),
	Type.Object({ ...CompressionOperationProperties, status: Type.Literal("cancelled") }, exact),
	Type.Object({ ...CompressionOperationProperties, status: Type.Literal("missing") }, exact),
	Type.Object(
		{
			...CompressionOperationProperties,
			status: Type.Literal("failed"),
			code: CompressionFailureCodeSchema,
		},
		exact,
	),
]);
export type RangeCompressionResult = Static<typeof RangeCompressionResultSchema>;
export type RangeCompressionPreparedResult = Extract<RangeCompressionResult, { status: "prepared" }>;
export type RangeCompressionAppliedResult = Extract<RangeCompressionResult, { status: "applied" }>;
export type RangeCompressionCancelledResult = Extract<RangeCompressionResult, { status: "cancelled" }>;
export type RangeCompressionMissingResult = Extract<RangeCompressionResult, { status: "missing" }>;
export type RangeCompressionFailedResult = Extract<RangeCompressionResult, { status: "failed" }>;

export interface RangeCompressionTransport {
	request: RangeCompressionRequest;
	context: ExtensionCommandContext;
}

export const COMPRESSION_REQUEST = "pi-context-compress/v1/request";
export const COMPRESSION_RESULT = "pi-context-compress/v1/result";
export const COMPRESSION_ENTRY = "pi-context-compress/compression";
export const QUEUED_TASK_TAIL = "pi-context-compress/queued-task";
export const COMPRESSION_TAIL = "pi-context-compress/summary";
export const LEGACY_COMPRESSION_ENTRY = "pi-workstream/compression";

export const BatchSnapshotSchema = Type.Object(
	{
		planId: Hash,
		batchId: Hash,
		structuralRevision: Hash,
		fileRevision: Hash,
		bitmap: Type.Array(Type.Boolean()),
	},
	exact,
);
export type BatchSnapshot = Static<typeof BatchSnapshotSchema>;

export const CompressionDetailsSchema = Type.Object(
	{
		v: Type.Literal(2),
		runId: Id,
		planId: Hash,
		batchId: Hash,
		operationId: Id,
		structuralRevision: Hash,
		fileRevision: Hash,
		preCompletionBitmap: Type.Array(Type.Boolean()),
		sourceLeafId: Id,
		preTaskAnchorId: Id,
		taskMessageEntryId: Id,
		startEntryId: Id,
		endEntryId: Id,
		selectedEntryIds: Type.Array(Id),
		sourceSha256: Hash,
	},
	exact,
);
export type CompressionDetails = Static<typeof CompressionDetailsSchema>;

export const CompressionRequestSchema = Type.Object(
	{
		...CompressionOperationProperties,
		runId: Id,
		action: Type.Union([
			Type.Literal("prepare"),
			Type.Literal("apply"),
			Type.Literal("cancel"),
			Type.Literal("status"),
		]),
		batch: BatchSnapshotSchema,
		anchorEntryId: Type.Optional(Id),
		lastSettledEntryId: Type.Optional(Id),
		review: Type.Optional(Type.Boolean()),
	},
	exact,
);
export type CompressionRequest = Static<typeof CompressionRequestSchema>;

export const CompressionResultSchema = Type.Object(
	{
		...CompressionOperationProperties,
		status: CompressionStatusSchema,
		details: Type.Optional(CompressionDetailsSchema),
		code: Type.Optional(CompressionFailureCodeSchema),
	},
	exact,
);
export type CompressionResult = Static<typeof CompressionResultSchema>;

function isCustomEntry(entry: SessionEntry, customType: string): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === customType;
}

function isCustomMessageEntry(entry: SessionEntry, customType: string): entry is CustomMessageEntry {
	return entry.type === "custom_message" && entry.customType === customType;
}

export function ctreeForkData(entry: SessionEntry): CtreeForkData | undefined {
	return isCustomEntry(entry, CTREE_FORK) && Value.Check(CtreeForkDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCloseData(entry: SessionEntry): CtreeCloseData | undefined {
	return isCustomEntry(entry, CTREE_CLOSE) && Value.Check(CtreeCloseDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCropData(entry: SessionEntry): CtreeCropData | undefined {
	return isCustomEntry(entry, CTREE_CROP) && Value.Check(CtreeCropDataSchema, entry.data) ? entry.data : undefined;
}

export function ctreeCropTailDetails(entry: SessionEntry): CtreeCropData | undefined {
	return isCustomMessageEntry(entry, CTREE_CROP_TAIL) && Value.Check(CtreeCropDataSchema, entry.details)
		? entry.details
		: undefined;
}

export function parseCtreeDecisionDetails(value: unknown): CtreeDecisionDetails | undefined {
	return Value.Check(CtreeDecisionDetailsSchema, value) ? value : undefined;
}

export function ctreeDecisionDetails(entry: SessionEntry): CtreeDecisionDetails | undefined {
	return isCustomMessageEntry(entry, CTREE_DECISION) ? parseCtreeDecisionDetails(entry.details) : undefined;
}

export function isCtreeRangeCompactEntry(entry: SessionEntry): entry is CustomEntry {
	return isCustomEntry(entry, CTREE_RANGE_COMPACT);
}

export function isCtreeRangeTailEntry(entry: SessionEntry): entry is CustomMessageEntry {
	return isCustomMessageEntry(entry, CTREE_RANGE_TAIL);
}

export function ctreeRangeCompactData(entry: SessionEntry): CtreeRangeCompactData | undefined {
	return isCtreeRangeCompactEntry(entry) && Value.Check(CtreeRangeCompactDataSchema, entry.data)
		? entry.data
		: undefined;
}

export function ctreeRangeTailDetails(entry: SessionEntry): CtreeRangeTailDetails | undefined {
	return isCtreeRangeTailEntry(entry) && Value.Check(CtreeRangeCompactDataSchema, entry.details)
		? entry.details
		: undefined;
}

export function compressionDetails(entry: SessionEntry): CompressionDetails | undefined {
	if (!isCustomEntry(entry, COMPRESSION_ENTRY) && !isCustomEntry(entry, LEGACY_COMPRESSION_ENTRY)) {
		return undefined;
	}
	return Value.Check(CompressionDetailsSchema, entry.data) ? entry.data : undefined;
}

export function compressionTailDetails(entry: SessionEntry): CompressionDetails | undefined {
	if (!isCustomMessageEntry(entry, QUEUED_TASK_TAIL) && !isCustomMessageEntry(entry, COMPRESSION_TAIL)) {
		return undefined;
	}
	return Value.Check(CompressionDetailsSchema, entry.details) ? entry.details : undefined;
}


File: src/range-compression.ts

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contentText } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	type SessionMessageEntry,
	type SessionTreeNode,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { refreshAmbient } from "./ambient.ts";
import { estimateTextTokens, fmtTokens, serializeEntry, snapshotSession } from "./context.ts";
import { draftRangeSummary, realDraft } from "./draft.ts";
import {
	type BatchSnapshot,
	COMPRESSION_ENTRY,
	COMPRESSION_REQUEST,
	COMPRESSION_RESULT,
	COMPRESSION_TAIL,
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CompressionDetails,
	type CompressionRequest,
	CompressionRequestSchema,
	type CompressionResult,
	CompressionResultSchema,
	type CtreeRangeCompactData,
	QUEUED_TASK_TAIL,
	RANGE_COMPRESSION_REQUEST,
	RANGE_COMPRESSION_RESULT,
	type RangeCompressionFailureCode,
	type RangeCompressionRequest,
	RangeCompressionRequestSchema,
	type RangeCompressionResult,
	RangeCompressionResultSchema,
	type RangeCompressionTransport,
	compressionDetails as batchCompressionDetails,
	ctreeRangeCompactData,
} from "./protocol.ts";
import {
	type RangeCandidate,
	type RewritePlan,
	applyRewrite,
	prepareRewrite,
	rangeCandidates,
	revalidateRewrite,
	sourceSha8,
} from "./rewrite.ts";

export interface RangeCompressionTarget {
	readonly operationId: string;
	readonly startEntryId: string;
	readonly endEntryId: string;
	readonly anchorEntryId?: string;
	readonly instructions?: string;
	readonly signal?: AbortSignal;
}

export interface RangeCompressionInput extends RangeCompressionTarget {
	readonly review: boolean;
}

export interface PreparedRangeCompression {
	readonly plan: RewritePlan;
	readonly summary: string;
	readonly summaryModel: string;
	readonly operationId: string;
}

export interface CompressionPlan extends RewritePlan {
	operationId: string;
	preTaskAnchorId: string;
	taskMessageEntryId: string;
	taskMessage: string;
}

interface PreparedBatchCompression {
	readonly plan: CompressionPlan;
	readonly summary: string;
}

export type RangeCompressionOutcome = { status: "applied"; details: CtreeRangeCompactData } | { status: "cancelled" };

type RangePhase = "start" | "end";

type ManualPreparationResult =
	| { status: "prepared"; prepared: PreparedRangeCompression }
	| { status: "cancelled" }
	| { status: "failed"; error: string };

type RangeCompressionServiceOutcome =
	| { status: "prepared" }
	| { status: "applied"; details: CtreeRangeCompactData }
	| { status: "cancelled" }
	| { status: "missing" }
	| { status: "failed"; code: RangeCompressionFailureCode };

type BatchCompressionServiceOutcome = Pick<CompressionResult, "status" | "details" | "code">;
type CompressionOperationOutcome = RangeCompressionServiceOutcome | BatchCompressionServiceOutcome;
type AppliedCompressionOutcome =
	| { status: "applied"; details: CtreeRangeCompactData }
	| { status: "applied"; details: CompressionDetails };
type CompressionApplyOutcome = AppliedCompressionOutcome | { status: "cancelled" };

type PreparedCompression =
	| { readonly kind: "range"; readonly value: PreparedRangeCompression }
	| { readonly kind: "batch"; readonly value: PreparedBatchCompression };

type NormalizedCompressionRequest =
	| { readonly kind: "range"; readonly request: RangeCompressionRequest }
	| { readonly kind: "batch"; readonly request: CompressionRequest };

type NormalizedRangeCompressionRequest = Extract<NormalizedCompressionRequest, { kind: "range" }>;
type NormalizedBatchCompressionRequest = Extract<NormalizedCompressionRequest, { kind: "batch" }>;

interface PreparingCompressionOperation {
	readonly phase: "preparing";
	readonly token: symbol;
	readonly request: NormalizedCompressionRequest;
	readonly promise: Promise<CompressionOperationOutcome>;
	readonly controller: AbortController;
}

interface PreparedCompressionOperation {
	readonly phase: "prepared";
	readonly request: NormalizedCompressionRequest;
	readonly prepared: PreparedCompression;
}

interface ApplyingCompressionOperation {
	readonly phase: "applying";
	readonly token: symbol;
	readonly request: NormalizedCompressionRequest;
	readonly promise: Promise<CompressionOperationOutcome>;
}

interface CancelledCompressionOperation {
	readonly phase: "cancelled";
	readonly request: NormalizedCompressionRequest;
}

type CompressionOperationState =
	| PreparingCompressionOperation
	| PreparedCompressionOperation
	| ApplyingCompressionOperation
	| CancelledCompressionOperation;

interface RangeSelectorProjection {
	tree: SessionTreeNode[];
	entryIds: string[];
}

class InvalidRangeCompressionRequestError extends Error {}

class RangeCompressionSessionChangedError extends Error {}

function assertStableSession(ctx: ExtensionCommandContext, sessionId: string, sourceLeafId: string | null): void {
	if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		throw new RangeCompressionSessionChangedError("The session changed during range compression.");
	}
	if (ctx.hasPendingMessages()) {
		throw new InvalidRangeCompressionRequestError("Range compression cannot run while messages are pending.");
	}
}

function indexTreeNodes(tree: readonly SessionTreeNode[]): Map<string, SessionTreeNode> {
	const byId = new Map<string, SessionTreeNode>();
	const pending = [...tree];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node) continue;
		byId.set(node.entry.id, node);
		pending.push(...node.children);
	}
	return byId;
}

function buildLinearSelectorProjection(
	ctx: ExtensionCommandContext,
	entryIds: readonly string[],
): RangeSelectorProjection {
	const activeEntryIds = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
	const treeNodes = indexTreeNodes(ctx.sessionManager.getTree());
	const sourceNodes = entryIds.flatMap((entryId) => {
		if (!activeEntryIds.has(entryId)) return [];
		const node = treeNodes.get(entryId);
		return node ? [node] : [];
	});
	let child: SessionTreeNode | undefined;
	for (let index = sourceNodes.length - 1; index >= 0; index--) {
		const source = sourceNodes[index];
		if (!source) continue;
		child = {
			entry: source.entry,
			children: child ? [child] : [],
			label: source.label,
			labelTimestamp: source.labelTimestamp,
		};
	}
	return {
		tree: child ? [child] : [],
		entryIds: sourceNodes.map((node) => node.entry.id),
	};
}

function buildStartSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
): RangeSelectorProjection {
	const entryIds = candidates.filter((candidate) => !candidate.protected).map((candidate) => candidate.startEntryId);
	return buildLinearSelectorProjection(ctx, entryIds);
}

function buildEndSelectorProjection(
	ctx: ExtensionCommandContext,
	candidates: readonly RangeCandidate[],
	startCandidateIndex: number,
): RangeSelectorProjection {
	const entryIds: string[] = [];
	for (let index = startCandidateIndex; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (!candidate || candidate.protected) break;
		entryIds.push(candidate.endEntryId);
	}
	return buildLinearSelectorProjection(ctx, entryIds);
}

async function selectNativeEntry(
	ctx: ExtensionCommandContext,
	phase: RangePhase,
	projection: RangeSelectorProjection,
	initialSelectedId: string,
): Promise<string | undefined> {
	ctx.ui.notify(
		phase === "start" ? "Select the first entry of the range" : "Select the last entry of the range",
		"info",
	);
	return ctx.ui.custom<string | undefined>(
		(
			tui: { terminal: { rows: number } },
			_theme: unknown,
			_keybindings: unknown,
			done: (entryId: string | undefined) => void,
		) =>
			new TreeSelectorComponent(
				projection.tree,
				projection.entryIds.at(-1) ?? null,
				tui.terminal.rows,
				(entryId) => done(entryId),
				() => done(undefined),
				undefined,
				initialSelectedId,
				"default",
			),
	);
}

export function renderRangeTail(plan: RewritePlan, approvedSummary: string): string {
	const summary = approvedSummary.trim();
	if (!summary) throw new Error("approved range summary is empty");
	const header = `[pi-context-compress/range: summarized ${plan.selectedEntryIds.length} entries, ~${fmtTokens(
		plan.selectedEstTokens,
	)} tokens, source ${sourceSha8(plan)}. Originals preserved at leaf ${plan.sourceLeafId}.]`;
	const parts = [header, summary];
	if (plan.continuationSerialized.trim()) {
		parts.push("[unchanged continuation after compressed range]", plan.continuationSerialized);
	}
	return `${parts.join("\n\n")}\n`;
}

function compressionDetails(
	plan: RewritePlan,
	summary: string,
	summaryModel: string,
	operationId: string,
): CtreeRangeCompactData {
	const summaryEstTokens = estimateTextTokens(summary);
	return {
		v: 1,
		operationId,
		sourceLeafId: plan.sourceLeafId,
		anchorId: plan.anchorId,
		startEntryId: plan.startEntryId,
		endEntryId: plan.endEntryId,
		selectedEntryIds: [...plan.selectedEntryIds],
		selectedEstTokens: plan.selectedEstTokens,
		summaryEstTokens,
		reclaimedEstTokens: plan.selectedEstTokens - summaryEstTokens,
		summaryModel,
		sourceSha8: sourceSha8(plan),
	};
}

export async function prepareRangeCompression(
	ctx: ExtensionCommandContext,
	target: RangeCompressionTarget,
): Promise<PreparedRangeCompression> {
	const sessionId = ctx.sessionManager.getSessionId();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	target.signal?.throwIfAborted();
	await ctx.waitForIdle();
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);

	const model = ctx.model;
	if (!model) throw new InvalidRangeCompressionRequestError("No current model is available for range compression.");
	const snapshot = snapshotSession(ctx.sessionManager);
	let plan: RewritePlan;
	try {
		plan = prepareRewrite(snapshot, target.startEntryId, target.endEntryId, {
			anchorId: target.anchorEntryId,
		});
	} catch (error) {
		throw new InvalidRangeCompressionRequestError(error instanceof Error ? error.message : String(error));
	}
	const summary = (await draftRangeSummary(realDraft, ctx, plan.source, target.instructions, target.signal)).trim();
	if (!summary) throw new Error("The model returned an empty range summary.");
	target.signal?.throwIfAborted();
	assertStableSession(ctx, sessionId, sourceLeafId);
	let validatedPlan: RewritePlan;
	try {
		validatedPlan = revalidateRewrite(ctx, plan);
	} catch (error) {
		throw new RangeCompressionSessionChangedError(error instanceof Error ? error.message : String(error));
	}
	return {
		plan: validatedPlan,
		summary,
		summaryModel: `${model.provider}/${model.id}`,
		operationId: target.operationId,
	};
}

export async function reviewRangeCompression(
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<PreparedRangeCompression | undefined> {
	const summary = (await ctx.ui.editor("Review selected range summary", prepared.summary))?.trim();
	if (!summary) return undefined;
	return { ...prepared, summary };
}

export async function applyPreparedRangeCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prepared: PreparedRangeCompression,
): Promise<CtreeRangeCompactData | undefined> {
	await ctx.waitForIdle();
	if (ctx.hasPendingMessages()) {
		throw new InvalidRangeCompressionRequestError("Range compression cannot run while messages are pending.");
	}
	let plan: RewritePlan;
	try {
		plan = revalidateRewrite(ctx, prepared.plan);
	} catch (error) {
		throw new RangeCompressionSessionChangedError(error instanceof Error ? error.message : String(error));
	}
	const details = compressionDetails(plan, prepared.summary, prepared.summaryModel, prepared.operationId);
	const applied = await applyRewrite(pi, ctx, plan, {
		messages: [
			{
				customType: CTREE_RANGE_TAIL,
				content: renderRangeTail(plan, prepared.summary),
				display: true,
				details,
			},
		],
		marker: { customType: CTREE_RANGE_COMPACT, data: details },
	});
	return applied ? details : undefined;
}

export async function compressRange(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	input: RangeCompressionInput,
): Promise<RangeCompressionOutcome> {
	const prepared = await prepareRangeCompression(ctx, input);
	const approved = input.review ? await reviewRangeCompression(ctx, prepared) : prepared;
	if (!approved) return { status: "cancelled" };
	const details = await applyPreparedRangeCompression(pi, ctx, approved);
	return details ? { status: "applied", details } : { status: "cancelled" };
}

function isQueuedTaskMessage(entry: SessionEntry): entry is SessionMessageEntry {
	return (
		entry.type === "message" &&
		entry.message.role === "user" &&
		contentText(entry.message.content, "\n").startsWith("[Queued task]\n\n")
	);
}

export function prepareCompression(
	ctx: ExtensionContext,
	batchStartEntryId: string,
	lastSettledEntryId: string,
	operationId: string = randomUUID(),
): CompressionPlan {
	const entries = ctx.sessionManager.getBranch();
	const markerIndex = entries.findIndex((entry) => entry.id === batchStartEntryId);
	const endIndex = entries.findIndex((entry) => entry.id === lastSettledEntryId);
	const sourceLeafId = ctx.sessionManager.getLeafId();
	if (markerIndex === -1 || endIndex <= markerIndex || !sourceLeafId) {
		throw new Error("The completed batch session range is not available.");
	}
	const taskMessageIndex = entries.findIndex(
		(entry, index) => index > markerIndex && index <= endIndex && isQueuedTaskMessage(entry),
	);
	if (taskMessageIndex === -1) throw new Error("The queued batch message is not available.");
	const startIndex = entries.findIndex(
		(entry, index) =>
			index > taskMessageIndex && index <= endIndex && entry.type === "message" && entry.message.role === "assistant",
	);
	if (startIndex === -1) throw new Error("The completed batch has no assistant execution range.");
	const selectedIds = new Set(entries.slice(startIndex, endIndex + 1).map((entry) => entry.id));
	const snapshot = snapshotSession(ctx.sessionManager);
	const endpoint = rangeCandidates(snapshot).findLast((candidate) => selectedIds.has(candidate.endEntryId));
	const startEntry = entries[startIndex];
	if (!endpoint || !startEntry) throw new Error("The execution range is not available.");
	const rewrite = prepareRewrite(snapshot, startEntry.id, endpoint.endEntryId, { anchorId: batchStartEntryId });
	const taskMessageEntry = entries[taskMessageIndex];
	if (!taskMessageEntry || !isQueuedTaskMessage(taskMessageEntry) || taskMessageEntry.message.role !== "user") {
		throw new Error("The queued batch message is invalid.");
	}
	return {
		...rewrite,
		operationId,
		preTaskAnchorId: batchStartEntryId,
		taskMessageEntryId: taskMessageEntry.id,
		taskMessage: contentText(taskMessageEntry.message.content, "\n"),
	};
}

export async function applyCompression(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runId: string,
	batch: BatchSnapshot,
	compression: CompressionPlan,
	summary: string,
): Promise<CompressionDetails> {
	const details: CompressionDetails = {
		v: 2,
		runId,
		planId: batch.planId,
		batchId: batch.batchId,
		operationId: compression.operationId,
		structuralRevision: batch.structuralRevision,
		fileRevision: batch.fileRevision,
		preCompletionBitmap: [...batch.bitmap],
		sourceLeafId: compression.sourceLeafId,
		preTaskAnchorId: compression.preTaskAnchorId,
		taskMessageEntryId: compression.taskMessageEntryId,
		startEntryId: compression.startEntryId,
		endEntryId: compression.endEntryId,
		selectedEntryIds: [...compression.selectedEntryIds],
		sourceSha256: compression.sourceSha256,
	};
	const applied = await applyRewrite(pi, ctx, compression, {
		messages: [
			{
				customType: QUEUED_TASK_TAIL,
				content: compression.taskMessage,
				display: true,
				details,
			},
			{
				customType: COMPRESSION_TAIL,
				content: summary.trim(),
				display: true,
				details,
			},
		],
		marker: { customType: COMPRESSION_ENTRY, data: details },
	});
	if (!applied) throw new Error("Compression navigation was cancelled.");
	return details;
}

function compressionOnBranch(
	ctx: ExtensionContext,
	runId: string,
	planId: string,
	batchId: string,
): CompressionDetails | undefined {
	for (const entry of ctx.sessionManager.getBranch().reverse()) {
		const details = batchCompressionDetails(entry);
		if (details?.runId === runId && details.planId === planId && details.batchId === batchId) {
			return structuredClone(details);
		}
	}
	return undefined;
}

function normalizeRangeCompressionRequest(request: RangeCompressionRequest): NormalizedRangeCompressionRequest {
	return { kind: "range", request };
}

function normalizeBatchCompressionRequest(request: CompressionRequest): NormalizedBatchCompressionRequest {
	return { kind: "batch", request };
}

function cloneNormalizedCompressionRequest(request: NormalizedCompressionRequest): NormalizedCompressionRequest {
	return request.kind === "range"
		? normalizeRangeCompressionRequest(structuredClone(request.request))
		: normalizeBatchCompressionRequest(structuredClone(request.request));
}

function compressionOperationKey(request: NormalizedCompressionRequest): string {
	return `${request.kind}:${request.request.sessionId}:${request.request.operationId}`;
}

function comparableCompressionRequest(request: NormalizedCompressionRequest): unknown {
	const { requestId: _requestId, ...value } = request.request;
	return { kind: request.kind, request: value };
}

function sameCompressionRequest(left: NormalizedCompressionRequest, right: NormalizedCompressionRequest): boolean {
	return isDeepStrictEqual(comparableCompressionRequest(left), comparableCompressionRequest(right));
}

function appliedRangeCompression(ctx: ExtensionCommandContext, operationId: string): CtreeRangeCompactData | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		const details = ctreeRangeCompactData(entry);
		if (details?.operationId === operationId) return structuredClone(details);
	}
	return undefined;
}

function isCompressionContext(value: unknown): value is ExtensionCommandContext {
	if (!value || typeof value !== "object") return false;
	const context = value as Partial<ExtensionCommandContext>;
	return (
		typeof context.sessionManager?.getSessionId === "function" &&
		typeof context.waitForIdle === "function" &&
		typeof context.navigateTree === "function"
	);
}

class CompressionOperationCoordinator {
	private readonly operations = new Map<string, CompressionOperationState>();

	constructor(private readonly pi: ExtensionAPI) {}

	clearSession(sessionId: string): void {
		for (const [key, state] of this.operations) {
			if (state.request.request.sessionId !== sessionId) continue;
			if (state.phase === "preparing") state.controller.abort();
			this.operations.delete(key);
		}
	}

	execute(
		request: NormalizedRangeCompressionRequest,
		ctx: ExtensionCommandContext,
	): Promise<RangeCompressionServiceOutcome>;
	execute(
		request: NormalizedBatchCompressionRequest,
		ctx: ExtensionCommandContext,
	): Promise<BatchCompressionServiceOutcome>;
	async execute(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
	): Promise<CompressionOperationOutcome> {
		const input = request.request;
		if (ctx.sessionManager.getSessionId() !== input.sessionId) {
			return { status: "failed", code: "session_changed" };
		}
		const applied = this.appliedOutcome(request, ctx);
		if (applied) return applied;

		const key = compressionOperationKey(request);
		const state = this.operations.get(key);
		if (input.action === "cancel") {
			if (this.hasApplyingOperation(input.sessionId)) return { status: "failed", code: "busy" };
			if (state?.phase === "preparing") state.controller.abort();
			this.operations.set(key, { phase: "cancelled", request });
			return { status: "cancelled" };
		}
		if (state?.phase === "cancelled") return { status: "cancelled" };

		if (state?.phase === "preparing" || state?.phase === "applying") {
			if (sameCompressionRequest(state.request, request)) return state.promise;
			if (state.phase === "preparing" && state.request.request.action === "prepare" && input.action === "prepare") {
				return { status: "failed", code: "operation_conflict" };
			}
			return { status: "failed", code: "busy" };
		}

		if (input.action === "status") return { status: state?.phase === "prepared" ? "prepared" : "missing" };
		if (input.action === "prepare") {
			if (state?.phase === "prepared") {
				return sameCompressionRequest(state.request, request)
					? { status: "prepared" }
					: { status: "failed", code: "operation_conflict" };
			}
			if (!this.canPrepare(request, ctx)) return { status: "failed", code: "invalid_request" };
			return this.startPreparation(request, ctx, key);
		}

		if (state?.phase !== "prepared" || state.prepared.kind !== request.kind) {
			return { status: "failed", code: "not_prepared" };
		}
		if (this.hasApplyingOperation(input.sessionId)) return { status: "failed", code: "busy" };
		if (request.kind === "batch" && (!ctx.isIdle() || ctx.hasPendingMessages())) {
			return { status: "failed", code: "session_changed" };
		}
		return this.startApply(request, ctx, key, state);
	}

	private appliedOutcome(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
	): AppliedCompressionOutcome | undefined {
		if (request.kind === "range") {
			const details = appliedRangeCompression(ctx, request.request.operationId);
			return details ? { status: "applied", details } : undefined;
		}
		const details = compressionOnBranch(
			ctx,
			request.request.runId,
			request.request.batch.planId,
			request.request.batch.batchId,
		);
		return details ? { status: "applied", details } : undefined;
	}

	private canPrepare(request: NormalizedCompressionRequest, ctx: ExtensionCommandContext): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.model) return false;
		return request.kind === "range" || !!(request.request.anchorEntryId && request.request.lastSettledEntryId);
	}

	private hasApplyingOperation(sessionId: string): boolean {
		for (const state of this.operations.values()) {
			if (state.phase === "applying" && state.request.request.sessionId === sessionId) return true;
		}
		return false;
	}

	private isCurrentOperation(key: string, phase: "preparing" | "applying", token: symbol): boolean {
		const state = this.operations.get(key);
		return state?.phase === phase && state.token === token;
	}

	private startPreparation(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
		key: string,
	): Promise<CompressionOperationOutcome> {
		const controller = new AbortController();
		const token = Symbol();
		const promise = (async (): Promise<CompressionOperationOutcome> => {
			await Promise.resolve();
			try {
				const prepared = await this.prepareOperation(request, ctx, controller.signal);
				if (controller.signal.aborted || !this.isCurrentOperation(key, "preparing", token)) {
					return { status: "cancelled" };
				}
				if (!prepared) {
					this.operations.set(key, { phase: "cancelled", request });
					return { status: "cancelled" };
				}
				if (
					ctx.sessionManager.getSessionId() !== request.request.sessionId ||
					ctx.sessionManager.getLeafId() !== prepared.value.plan.sourceLeafId
				) {
					this.operations.delete(key);
					return { status: "failed", code: "session_changed" };
				}
				this.operations.set(key, {
					phase: "prepared",
					request: cloneNormalizedCompressionRequest(request),
					prepared,
				});
				return { status: "prepared" };
			} catch (error) {
				const isCurrent = this.isCurrentOperation(key, "preparing", token);
				if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					if (isCurrent) this.operations.set(key, { phase: "cancelled", request });
					return { status: "cancelled" };
				}
				if (isCurrent) this.operations.delete(key);
				return this.failureOutcome(error, request, ctx);
			}
		})();
		const preparing: PreparingCompressionOperation = {
			phase: "preparing",
			token,
			request,
			promise,
			controller,
		};
		this.operations.set(key, preparing);
		return promise;
	}

	private async prepareOperation(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
		signal: AbortSignal,
	): Promise<PreparedCompression | undefined> {
		if (request.kind === "range") {
			const input = request.request;
			if (input.action !== "prepare") throw new Error("Range compression preparation requires prepare.");
			const value = await prepareRangeCompression(ctx, {
				operationId: input.operationId,
				startEntryId: input.startEntryId,
				endEntryId: input.endEntryId,
				anchorEntryId: input.anchorEntryId,
				instructions: input.instructions,
				signal,
			});
			const approved = input.review ? await reviewRangeCompression(ctx, value) : value;
			return approved ? { kind: "range", value: approved } : undefined;
		}

		const input = request.request;
		if (!input.anchorEntryId || !input.lastSettledEntryId) {
			throw new InvalidRangeCompressionRequestError("The batch compression request is incomplete.");
		}
		const target = prepareCompression(ctx, input.anchorEntryId, input.lastSettledEntryId, input.operationId);
		const range = await prepareRangeCompression(ctx, {
			operationId: input.operationId,
			startEntryId: target.startEntryId,
			endEntryId: target.endEntryId,
			anchorEntryId: target.anchorId,
			signal,
		});
		let summary = range.summary;
		if (input.review !== false) {
			summary = (await ctx.ui.editor("Review completed batch summary", summary))?.trim() ?? "";
		}
		if (!summary) return undefined;
		return {
			kind: "batch",
			value: {
				plan: { ...target, ...range.plan },
				summary,
			},
		};
	}

	private startApply(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
		key: string,
		prepared: PreparedCompressionOperation,
	): Promise<CompressionOperationOutcome> {
		const token = Symbol();
		const promise = (async (): Promise<CompressionOperationOutcome> => {
			await Promise.resolve();
			try {
				const outcome = await this.applyOperation(request, ctx, prepared.prepared);
				if (outcome.status === "cancelled") {
					if (this.isCurrentOperation(key, "applying", token)) {
						this.operations.set(key, { phase: "cancelled", request });
					}
					return outcome;
				}
				if (this.isCurrentOperation(key, "applying", token)) this.operations.delete(key);
				return outcome;
			} catch (error) {
				if (this.isCurrentOperation(key, "applying", token)) this.operations.set(key, prepared);
				return this.failureOutcome(error, request, ctx);
			}
		})();
		const applying: ApplyingCompressionOperation = { phase: "applying", token, request, promise };
		this.operations.set(key, applying);
		return promise;
	}

	private async applyOperation(
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
		prepared: PreparedCompression,
	): Promise<CompressionApplyOutcome> {
		if (request.kind === "range" && prepared.kind === "range") {
			const details = await applyPreparedRangeCompression(this.pi, ctx, prepared.value);
			return details ? { status: "applied", details } : { status: "cancelled" };
		}
		if (request.kind === "batch" && prepared.kind === "batch") {
			const details = await applyCompression(
				this.pi,
				ctx,
				request.request.runId,
				request.request.batch,
				prepared.value.plan,
				prepared.value.summary,
			);
			return { status: "applied", details };
		}
		throw new Error("Compression operation kind changed.");
	}

	private failureOutcome(
		error: unknown,
		request: NormalizedCompressionRequest,
		ctx: ExtensionCommandContext,
	): CompressionOperationOutcome {
		if (
			error instanceof RangeCompressionSessionChangedError ||
			ctx.sessionManager.getSessionId() !== request.request.sessionId
		) {
			return { status: "failed", code: "session_changed" };
		}
		return error instanceof InvalidRangeCompressionRequestError
			? { status: "failed", code: "invalid_request" }
			: { status: "failed", code: "compression_failed" };
	}
}

function registerCoordinatorShutdown(pi: ExtensionAPI, coordinator: CompressionOperationCoordinator): void {
	pi.on("session_shutdown", (_event, ctx) => {
		coordinator.clearSession(ctx.sessionManager.getSessionId());
	});
}

function registerRangeCompressionAdapter(pi: ExtensionAPI, coordinator: CompressionOperationCoordinator): void {
	pi.events.on(RANGE_COMPRESSION_REQUEST, async (value: unknown) => {
		const transport = value as Partial<RangeCompressionTransport> | undefined;
		if (!transport || !Value.Check(RangeCompressionRequestSchema, transport.request)) return;
		const request = transport.request;
		let outcome: RangeCompressionServiceOutcome;
		try {
			outcome = isCompressionContext(transport.context)
				? await coordinator.execute(normalizeRangeCompressionRequest(request), transport.context)
				: { status: "failed", code: "session_changed" };
		} catch {
			outcome = { status: "failed", code: "compression_failed" };
		}
		const result = {
			v: 1,
			requestId: request.requestId,
			sessionId: request.sessionId,
			operationId: request.operationId,
			...outcome,
		} satisfies RangeCompressionResult;
		if (Value.Check(RangeCompressionResultSchema, result)) pi.events.emit(RANGE_COMPRESSION_RESULT, result);
	});
}

function registerBatchCompressionAdapter(pi: ExtensionAPI, coordinator: CompressionOperationCoordinator): void {
	pi.events.on(COMPRESSION_REQUEST, async (value: unknown) => {
		const transport = value as { request?: unknown; context?: unknown } | undefined;
		if (!transport || !Value.Check(CompressionRequestSchema, transport.request)) return;
		const request = transport.request;
		let outcome: BatchCompressionServiceOutcome;
		try {
			outcome = isCompressionContext(transport.context)
				? await coordinator.execute(normalizeBatchCompressionRequest(request), transport.context)
				: { status: "failed", code: "session_changed" };
		} catch {
			outcome = { status: "failed", code: "compression_failed" };
		}
		const result: CompressionResult = {
			v: 1,
			requestId: request.requestId,
			sessionId: request.sessionId,
			operationId: request.operationId,
			...outcome,
		};
		if (Value.Check(CompressionResultSchema, result)) pi.events.emit(COMPRESSION_RESULT, result);
	});
}

export function registerRangeCompressionService(pi: ExtensionAPI): void {
	const coordinator = new CompressionOperationCoordinator(pi);
	registerCoordinatorShutdown(pi, coordinator);
	registerRangeCompressionAdapter(pi, coordinator);
}

export function registerBatchCompression(pi: ExtensionAPI): void {
	const coordinator = new CompressionOperationCoordinator(pi);
	registerCoordinatorShutdown(pi, coordinator);
	registerBatchCompressionAdapter(pi, coordinator);
}

export function registerCompressionServices(pi: ExtensionAPI): void {
	const coordinator = new CompressionOperationCoordinator(pi);
	registerCoordinatorShutdown(pi, coordinator);
	registerRangeCompressionAdapter(pi, coordinator);
	registerBatchCompressionAdapter(pi, coordinator);
}

async function prepareWithLoader(
	ctx: ExtensionCommandContext,
	target: Omit<RangeCompressionTarget, "signal">,
	summaryModel: string,
	preview: RewritePlan,
): Promise<PreparedRangeCompression | undefined> {
	const result = await ctx.ui.custom<ManualPreparationResult>(
		(tui, theme, _keybindings, done) => {
			const rangeDetails = `summary model ${summaryModel} · ${preview.selectedEntryIds.length} selected entries · ~${fmtTokens(preview.selectedEstTokens)} source tokens`;
			const loader = new BorderedLoader(tui, theme, `Drafting range summary · ${rangeDetails}`);
			let finished = false;
			const finish = (value: ManualPreparationResult): void => {
				if (finished) return;
				finished = true;
				done(value);
			};
			loader.onAbort = () => finish({ status: "cancelled" });
			void prepareRangeCompression(ctx, { ...target, signal: loader.signal }).then(
				(prepared) => finish({ status: "prepared", prepared }),
				(error: unknown) =>
					finish(
						loader.signal.aborted
							? { status: "cancelled" }
							: { status: "failed", error: error instanceof Error ? error.message : String(error) },
					),
			);
			return loader;
		},
		{ overlay: false },
	);
	if (result.status === "failed") {
		ctx.ui.notify(`range summary failed: ${result.error} (nothing written)`, "error");
		return undefined;
	}
	if (result.status === "cancelled") {
		ctx.ui.notify("range compression cancelled — nothing written", "info");
		return undefined;
	}
	return result.prepared;
}

export async function rangeCompressHandler(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("range compression selection requires Pi's interactive TUI", "warning");
		return;
	}
	const instructions = args.trim() || undefined;
	await ctx.waitForIdle();
	if (ctx.hasPendingMessages()) {
		ctx.ui.notify("range compression cannot start while messages are pending", "warning");
		return;
	}
	const snapshot = snapshotSession(ctx.sessionManager);
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !ctx.sessionManager.getEntry(sourceLeafId)) {
		ctx.ui.notify("empty session — nothing to compress", "warning");
		return;
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("no current model is available for the range summary", "error");
		return;
	}
	const summaryModel = `${model.provider}/${model.id}`;
	const candidates = rangeCandidates(snapshot);
	const startProjection = buildStartSelectorProjection(ctx, candidates);
	const firstInitialId = startProjection.entryIds.at(-1);
	if (!firstInitialId) {
		ctx.ui.notify("no legal active-context range starts are available", "warning");
		return;
	}

	const firstEntryId = await selectNativeEntry(ctx, "start", startProjection, firstInitialId);
	if (firstEntryId === undefined) return;
	if (!startProjection.entryIds.includes(firstEntryId)) {
		ctx.ui.notify("the selected range start is not available; run /compress again", "warning");
		return;
	}
	if (ctx.sessionManager.getSessionId() !== snapshot.sessionId || ctx.sessionManager.getLeafId() !== sourceLeafId) {
		ctx.ui.notify("the session changed while the range selector was open; run /compress again", "warning");
		return;
	}

	const startCandidateIndex = candidates.findIndex(
		(candidate) => !candidate.protected && candidate.startEntryId === firstEntryId,
	);
	if (startCandidateIndex === -1) {
		ctx.ui.notify("the selected range start is no longer valid; run /compress again", "warning");
		return;
	}
	const endProjection = buildEndSelectorProjection(ctx, candidates, startCandidateIndex);
	const secondInitialId = endProjection.entryIds[0];
	if (!secondInitialId) {
		ctx.ui.notify("no legal range ends are available after the selected start", "warning");
		return;
	}

	const endEntryId = await selectNativeEntry(ctx, "end", endProjection, secondInitialId);
	if (endEntryId === undefined) return;
	if (!endProjection.entryIds.includes(endEntryId)) {
		ctx.ui.notify("the selected range end is not available; run /compress again", "warning");
		return;
	}

	let preview: RewritePlan;
	try {
		const fresh = snapshotSession(ctx.sessionManager);
		if (fresh.sessionId !== snapshot.sessionId || fresh.leafId !== sourceLeafId) {
			throw new Error("the session changed while the range selector was open");
		}
		preview = prepareRewrite(fresh, firstEntryId, endEntryId);
	} catch (error) {
		ctx.ui.notify(`Invalid range: ${(error as Error).message}. Run /compress again.`, "warning");
		return;
	}
	const startEntry = ctx.sessionManager.getEntry(preview.startEntryId);
	const endEntry = ctx.sessionManager.getEntry(preview.endEntryId);
	const startLabel = startEntry
		? (serializeEntry(startEntry)?.split("\n", 1)[0] ?? startEntry.type)
		: preview.startEntryId;
	const endLabel = endEntry ? (serializeEntry(endEntry)?.split("\n", 1)[0] ?? endEntry.type) : preview.endEntryId;
	const confirmed = await ctx.ui.confirm(
		"Compress selected range",
		[
			`Start: ${preview.startEntryId} · ${startLabel}`,
			`End: ${preview.endEntryId} · ${endLabel}`,
			`${preview.selectedEntryIds.length} entries · ~${fmtTokens(preview.selectedEstTokens)} tokens`,
			`Summary model: ${summaryModel}`,
			"The generated summary will open for required review.",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("range compression cancelled — nothing written", "info");
		return;
	}
	if (
		ctx.sessionManager.getSessionId() !== snapshot.sessionId ||
		ctx.sessionManager.getLeafId() !== sourceLeafId ||
		`${ctx.model?.provider}/${ctx.model?.id}` !== summaryModel
	) {
		ctx.ui.notify("the session or model changed during confirmation; run /compress again", "warning");
		return;
	}

	const operationId = randomUUID();
	const prepared = await prepareWithLoader(
		ctx,
		{
			operationId,
			startEntryId: preview.startEntryId,
			endEntryId: preview.endEntryId,
			anchorEntryId: preview.anchorId,
			instructions,
		},
		summaryModel,
		preview,
	);
	if (!prepared) return;
	const approved = await reviewRangeCompression(ctx, prepared);
	if (!approved) {
		ctx.ui.notify("range compression cancelled during summary review — nothing written", "info");
		return;
	}
	try {
		const details = await applyPreparedRangeCompression(pi, ctx, approved);
		if (!details) {
			ctx.ui.notify("range compression cancelled during navigation — nothing written", "warning");
			return;
		}
		refreshAmbient(ctx);
		ctx.ui.notify(
			`compressed range: selected ~${fmtTokens(details.selectedEstTokens)} · summary ~${fmtTokens(details.summaryEstTokens)} · reclaimed ~${fmtTokens(details.reclaimedEstTokens)} tokens · originals kept at ${details.sourceLeafId}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`selected range is no longer valid: ${(error as Error).message} (nothing written)`, "warning");
	}
}

export function registerRangeCompress(pi: ExtensionAPI): void {
	pi.registerCommand("compress", {
		description: "pi-context-compress: select, summarize, review, and replace one active-context range",
		handler: (args, ctx) => rangeCompressHandler(pi, ctx, args),
	});
}


File: src/rewrite.ts

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type SessionSnapshot,
	estimateEntryTokens,
	serializeEntries,
	snapshotEntry,
	snapshotSession,
} from "./context.ts";
import { CTREE_DECISION } from "./protocol.ts";

export interface RangeCandidate {
	startEntryId: string;
	endEntryId: string;
	entryIds: string[];
	pathIndex: number;
	endPathIndex: number;
	protected: boolean;
	protectReason?: string;
}

export interface RewritePlan {
	readonly sessionId: string;
	readonly sourceLeafId: string;
	readonly anchorId: string;
	readonly startEntryId: string;
	readonly endEntryId: string;
	readonly selectedEntryIds: readonly string[];
	readonly continuationEntryIds: readonly string[];
	readonly selectedEntries: readonly SessionEntry[];
	readonly source: string;
	readonly continuationSerialized: string;
	readonly selectedEstTokens: number;
	readonly sourceSha256: string;
}

export interface PrepareRewriteOptions {
	anchorId?: string;
}

interface RewriteMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

export interface RewriteOutput {
	messages: readonly RewriteMessage[];
	marker: {
		customType: string;
		data: unknown;
	};
}

function makeCandidate(
	slice: readonly SessionEntry[],
	startIndex: number,
	endPathIndex: number,
	protectReason?: string,
): RangeCandidate {
	const entries = slice.slice(startIndex, endPathIndex + 1);
	const first = entries[0] as SessionEntry;
	const last = entries.at(-1) as SessionEntry;
	return {
		startEntryId: first.id,
		endEntryId: last.id,
		entryIds: entries.map((entry) => entry.id),
		pathIndex: startIndex,
		endPathIndex,
		protected: protectReason !== undefined,
		protectReason,
	};
}

function metadataProtectReason(entry: SessionEntry): string | undefined {
	switch (entry.type) {
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "label":
		case "session_info":
			return "context-inert session metadata";
		default:
			return undefined;
	}
}

export function candidateByEntryId(candidates: readonly RangeCandidate[]): Map<string, RangeCandidate> {
	const byEntryId = new Map<string, RangeCandidate>();
	for (const candidate of candidates) {
		for (const entryId of candidate.entryIds) byEntryId.set(entryId, candidate);
	}
	return byEntryId;
}

export function rangeCandidates(snapshot: SessionSnapshot): RangeCandidate[] {
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !snapshotEntry(snapshot, sourceLeafId)) {
		throw new Error(`source leaf ${sourceLeafId ?? ""} was not found`);
	}
	const slice = snapshot.contextEntries;

	let incompleteUserId: string | undefined;
	for (let index = slice.length - 1; index >= 0; index--) {
		const entry = slice[index];
		if (!entry || entry.type !== "message" || entry.message.role !== "user") continue;
		const hasAssistantAfter = slice
			.slice(index + 1)
			.some((later) => later.type === "message" && later.message.role === "assistant");
		if (!hasAssistantAfter) incompleteUserId = entry.id;
		break;
	}

	const candidates: RangeCandidate[] = [];
	for (let index = 0; index < slice.length; index++) {
		const entry = slice[index];
		if (!entry) continue;

		if (entry.type === "message" && entry.message.role === "assistant") {
			const callIds = entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
			if (callIds.length > 0) {
				let endPathIndex = index;
				const resultIds: string[] = [];
				while (endPathIndex + 1 < slice.length) {
					const next = slice[endPathIndex + 1];
					if (!next || next.type !== "message" || next.message.role !== "toolResult") break;
					resultIds.push(next.message.toolCallId);
					endPathIndex += 1;
				}
				const callSet = new Set(callIds);
				const resultSet = new Set(resultIds);
				const complete =
					callSet.size === callIds.length &&
					resultSet.size === resultIds.length &&
					resultIds.length === callIds.length &&
					callIds.every((id) => resultSet.has(id)) &&
					resultIds.every((id) => callSet.has(id));
				const protectReason = !complete
					? "incomplete assistant tool-call group"
					: entry.parentId
						? undefined
						: "no anchor before this message group";
				candidates.push(makeCandidate(slice, index, endPathIndex, protectReason));
				index = endPathIndex;
				continue;
			}
		}

		const metadataReason = metadataProtectReason(entry);
		let protectReason: string | undefined;
		if (!entry.parentId) protectReason = "no anchor before this message group";
		else if (metadataReason) protectReason = metadataReason;
		else if (entry.id === incompleteUserId) protectReason = "incomplete current user turn";
		else if (entry.type === "custom_message" && entry.customType === CTREE_DECISION) protectReason = "decision record";
		else if (
			entry.type === "message" &&
			entry.message.role === "custom" &&
			entry.message.customType === CTREE_DECISION
		) {
			protectReason = "decision record";
		} else if (
			entry.type === "branch_summary" ||
			entry.type === "compaction" ||
			(entry.type === "message" &&
				(entry.message.role === "branchSummary" || entry.message.role === "compactionSummary"))
		) {
			protectReason = "structural context entry";
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			protectReason = "tool result without its assistant tool call";
		}
		candidates.push(makeCandidate(slice, index, index, protectReason));
	}
	return candidates;
}

function endpointPosition(snapshot: SessionSnapshot, id: string): number {
	if (!snapshotEntry(snapshot, id)) throw new Error(`entry ${id} was not found`);
	const position = snapshot.contextEntries.findIndex((entry) => entry.id === id);
	if (position === -1) throw new Error(`entry ${id} is not on the active context path`);
	return position;
}

export function prepareRewrite(
	snapshot: SessionSnapshot,
	startId: string,
	endId: string,
	options: PrepareRewriteOptions = {},
): RewritePlan {
	const sourceLeafId = snapshot.leafId;
	if (!sourceLeafId || !snapshotEntry(snapshot, sourceLeafId)) {
		throw new Error(`source leaf ${sourceLeafId ?? ""} was not found`);
	}
	const candidates = rangeCandidates(snapshot);
	const startPosition = endpointPosition(snapshot, startId);
	const endPosition = endpointPosition(snapshot, endId);
	if (startPosition > endPosition) throw new Error("range endpoints are not normalized");
	const byEntryId = candidateByEntryId(candidates);
	const firstGroup = byEntryId.get(startId);
	const lastGroup = byEntryId.get(endId);
	if (!firstGroup || !lastGroup) throw new Error("range endpoint is structural-only or missing");
	if (startId !== firstGroup.startEntryId) {
		throw new Error(`range start ${startId} would split a required tool-call group`);
	}
	if (endId !== lastGroup.endEntryId) {
		throw new Error(`range end ${endId} would split a required tool-call group`);
	}

	const firstGroupIndex = candidates.indexOf(firstGroup);
	const lastGroupIndex = candidates.indexOf(lastGroup);
	const blocked = candidates.slice(firstGroupIndex, lastGroupIndex + 1).find((candidate) => candidate.protected);
	if (blocked) {
		throw new Error(`entry ${blocked.startEntryId} is protected: ${blocked.protectReason ?? "not selectable"}`);
	}

	const selectedEntries = snapshot.contextEntries.slice(firstGroup.pathIndex, lastGroup.endPathIndex + 1);
	const continuationEntries = snapshot.contextEntries.slice(lastGroup.endPathIndex + 1);
	const firstEntry = selectedEntries[0];
	if (!firstEntry) throw new Error("range is empty");
	const anchorId = options.anchorId ?? firstEntry.parentId;
	if (!anchorId) throw new Error("range has no entry before it to use as an anchor");
	if (!snapshotEntry(snapshot, anchorId)) throw new Error(`rewrite anchor ${anchorId} was not found`);
	const anchorPosition = snapshot.branch.findIndex((entry) => entry.id === anchorId);
	const startBranchPosition = snapshot.branch.findIndex((entry) => entry.id === firstEntry.id);
	if (anchorPosition === -1 || startBranchPosition <= anchorPosition) {
		throw new Error(`rewrite anchor ${anchorId} is not before the selected range`);
	}
	const source = serializeEntries(selectedEntries);
	if (!source.trim()) throw new Error("selected range has no serializable source");

	return {
		sessionId: snapshot.sessionId,
		sourceLeafId,
		anchorId,
		startEntryId: firstGroup.startEntryId,
		endEntryId: lastGroup.endEntryId,
		selectedEntryIds: selectedEntries.map((entry) => entry.id),
		continuationEntryIds: continuationEntries.map((entry) => entry.id),
		selectedEntries,
		source,
		continuationSerialized: serializeEntries(continuationEntries),
		selectedEstTokens: selectedEntries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		sourceSha256: createHash("sha256").update(source).digest("hex"),
	};
}

export function sourceSha8(plan: RewritePlan): string {
	return plan.sourceSha256.slice(0, 8);
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

export function revalidateRewrite(ctx: ExtensionCommandContext, initial: RewritePlan): RewritePlan {
	if (ctx.sessionManager.getSessionId() !== initial.sessionId) {
		throw new Error("The session changed during rewrite review.");
	}
	if (ctx.sessionManager.getLeafId() !== initial.sourceLeafId) {
		throw new Error("The session leaf changed during rewrite review.");
	}
	if (!ctx.sessionManager.getEntry(initial.anchorId)) {
		throw new Error("The rewrite anchor is no longer available.");
	}
	const fresh = prepareRewrite(snapshotSession(ctx.sessionManager), initial.startEntryId, initial.endEntryId, {
		anchorId: initial.anchorId,
	});
	if (
		!sameIds(fresh.selectedEntryIds, initial.selectedEntryIds) ||
		!sameIds(fresh.continuationEntryIds, initial.continuationEntryIds) ||
		fresh.sourceSha256 !== initial.sourceSha256
	) {
		throw new Error("The rewrite source changed during review.");
	}
	return fresh;
}

export async function applyRewrite(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initial: RewritePlan,
	output: RewriteOutput,
): Promise<boolean> {
	await ctx.waitForIdle();
	const plan = revalidateRewrite(ctx, initial);
	const navigation = await ctx.navigateTree(plan.anchorId, { summarize: false });
	if (navigation.cancelled) return false;
	for (const message of output.messages) pi.sendMessage(message, { triggerTurn: false });
	pi.appendEntry(output.marker.customType, output.marker.data);
	return true;
}


File: TREE.txt

/tmp/pi-context-preload-tree-jOq6I3/paths.txt
├── src
│   ├── ambient.ts
│   ├── branches.ts
│   ├── context.ts
│   ├── crop.ts
│   ├── draft.ts
│   ├── index.ts
│   ├── panel.ts
│   ├── protocol.ts
│   ├── range-compression.ts
│   └── rewrite.ts
├── .tasks
│   └── replace-task-compression-event-bus-with-direct-import.md
├── tests
├── biome.json
├── .gitignore
├── package.json
├── PROTOCOL.md
├── README.md
├── SIMPLIFICATION_TASKLIST.md
└── tsconfig.json

