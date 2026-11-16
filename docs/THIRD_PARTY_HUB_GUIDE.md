# 🛠️ Third-Party Local Agent Hub Development & Integration Guide

> This guide is for developers who want to integrate local desktop software (such as **ThinkRail**, download managers, automation scripts, background workers) into **Muse Pet (Local Agent Hub)**.
> It details how to design Hub services that Luna can reliably recognize, discover, and invoke via natural language, using ThinkRail session management as a concrete example.

---

## Table of Contents
1. [Intent Recognition & Metadata Conventions (Golden Rules)](#1-intent-recognition--metadata-conventions-golden-rules)
2. [Troubleshooting Discovery & Intent Routing](#2-troubleshooting-discovery--intent-routing)
3. [Live ThinkRail Integration Architecture](#3-live-thinkrail-integration-architecture)
4. [Complete ThinkRail Hub Reference Code](#4-complete-thinkrail-hub-reference-code)
5. [Frequently Asked Questions (FAQ)](#5-frequently-asked-questions-faq)

---

## 1. Intent Recognition & Metadata Conventions (Golden Rules)

When a user chats with Luna (e.g., *"Check ThinkRail's current session tasks"* or *"What is ThinkRail working on?"*), Muse Pet scans locally registered and online Hub apps.
To ensure the intent evaluator (`shouldIncludeHubTools` / `selectHubIntentAppIds`) and LLM accurately recognize and route to your tools, follow these metadata conventions:

### (1) AppManifest Metadata

```typescript
export interface AppManifest {
  // Use product brand or reverse-domain format, e.g. 'thinkrail.session-manager'
  appId: string;

  // MUST include the human-facing brand name and core function
  // Recommended: 'ThinkRail Session & Task Manager'
  // Avoid: 'Session Manager' (missing product keyword makes natural routing difficult)
  name: string;

  // Describe the software purpose, concepts, and scenarios (e.g. sessions, tasks, agent runs)
  description: string;

  // [Recommended] Keyword list (case-insensitive)
  // Declare aliases, abbreviations, English names, and core domain terms
  keywords?: string[]; // e.g. ['thinkrail', 'session', 'task', 'workspace', 'agent']

  secret: string;
  tools: ToolDefinition[];

  // Optional: Dynamic software exploration capability (see docs/SOFTWARE_EXPLORATION.md)
  exploration?: {
    version: 1;
    overviewToolId: string;
    discoverToolId: string;
    readToolId: string;
  };
}
```

### (2) Tool Naming & Description Guidelines

Luna relies on `tool.name` and `tool.description` to decide when to call a tool, and the intent matcher analyzes tool noun phrases:

1. **`toolId`**: Clean snake_case identifier, e.g., `list_sessions`, `query_session_progress`, `cancel_task`.
2. **`name`**: Action phrase, e.g., `List Active Sessions`, `Query Session Progress`, `Create and Run Task`.
3. **`description`**: **Crucial**. Explain not only what the tool does, but **under which user prompts it should be invoked**:
   - *Example*: `"Queries live ThinkRail projects, workspaces, and active session tasks. Call when the user asks what ThinkRail is working on, queries current progress, or lists active agent sessions."`
4. **`riskLevel`**:
   - `read-only`: Read queries (lists, status, progress). Executed automatically without approval prompts.
   - `write-safe`: Safe state changes (desktop pet bubble, creating non-destructive sessions). Can be pre-approved or trusted.
   - `write-dangerous`: Destructive changes (deleting files, terminating external processes). Triggers an interactive confirmation prompt.

---

## 2. Troubleshooting Discovery & Intent Routing

Two common pitfalls when building custom Hub integrations:

### Case A: User asks about your app, but Luna answers "I don't have access"
- **Root Cause**:
  - `appId` was generic (e.g. `com.muse.session-manager`) and `name` did not contain the user's spoken name (e.g. `Session Manager`).
  - No matching keywords were declared.
  - When the user asked *"Check ThinkRail tasks"*, the intent router found no matching tokens and did not attach the tools.
- **Solution**:
  - Add explicit `keywords: ['thinkrail', 'session', 'task']`.
  - Ensure `name` and `description` include the exact software brand name.

### Case B: Tool call returns empty results (`{"total": 0, "sessions": []}`)
- **Root Cause**:
  - The adapter was using an in-memory mock store without checking real backend services or active processes.
- **Solution**:
  - Connect to the real software daemon (e.g., ThinkRail WebSocket endpoint `ws://localhost:24242/ws` or native IPC).
  - Explicitly return `{ status: 'unavailable' }` if the backend daemon is offline, so Luna can inform the user honestly rather than hallucinating that no tasks exist.

---

## 3. Live ThinkRail Integration Architecture

Never infer task activity solely by filesystem folder modification times (`mtime`), which falsely marks idle workspaces as "running". Instead, query ThinkRail's live service directly:

```
[ ThinkRail Desktop / Daemon (ws://localhost:24242/ws) ]
                         ▲
                         │ WebSocket JSON-RPC (PROTOCOL_VERSION)
                         ▼
[ ThinkRailSessionReader / Router (examples/muse-session-manager) ]
                         ▲
                         │ Local HTTP/WS (127.0.0.1:19840)
                         ▼
[ Muse Pet Electron Core (Local Agent Hub) ]
                         ▲
                         │ Natural Language Chat
                         ▼
                     [ User ]
```

---

## 4. Complete ThinkRail Hub Reference Code

See the working integration implementation in:
- [examples/thinkrail-software-exploration.ts](../examples/thinkrail-software-exploration.ts): Generic read-only exploration adapter.
- [docs/SOFTWARE_EXPLORATION.md](./SOFTWARE_EXPLORATION.md): Dynamic software exploration protocol specification.
- `thinkrail/examples/muse-session-manager/`: Full client, router, and reader implementation.

### Example Registration Snippet (`hub-client.ts`):

```typescript
import { createThinkRailExploration } from './thinkrail-software-exploration';
import { ThinkRailSessionReader } from './thinkrail-reader';

const realSessions = new ThinkRailSessionReader();
const explorationAdapter = createThinkRailExploration(realSessions);

const manifest: AppManifest = {
  appId: 'thinkrail.session-manager',
  name: 'ThinkRail Session & Task Manager',
  version: '2.0.0',
  description: 'Understand ThinkRail projects, workspaces, and live agent sessions. Query progress on demand.',
  keywords: ['thinkrail', 'session', 'task', 'workspace'],
  secret: process.env.MUSE_HUB_SECRET || 'your-secret-key',
  exploration: explorationAdapter.exploration,
  tools: [...explorationAdapter.tools, ...existingTools],
};

await hubClient.register(manifest.tools);
```

---

## 5. Frequently Asked Questions (FAQ)

### Q: Does Muse Pet require third-party tools to be written in TypeScript?
**A**: No. The Local Agent Hub communicates over standard HTTP REST (`http://127.0.0.1:19840`) and WebSockets (`ws://127.0.0.1:19840/ws`). You can write adapters in Python, Go, Rust, C#, or Node.js.

### Q: How can users stop a runaway tool loop?
**A**: Users can type `/hub stop` in the chat window at any time to immediately cancel all active exploration chains and cancel running tasks.
