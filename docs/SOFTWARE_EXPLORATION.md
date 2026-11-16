# Software Understanding & Read-Only Exploration Protocol (`muse-software/1`)

This protocol enables Muse Pet to dynamically discover, understand, and query integrated applications on demand (e.g. ThinkRail). Rather than requiring every discrete business query to be statically hardcoded into the initial tool catalog, the external application exposes entry points for software overview, dynamic directories, and bounded resource reads. Muse progressively explores and queries live state based on returned evidence.

The first implementation phase is **read-only**: it does not perform GUI manipulation, shell code execution, arbitrary file writes, or trigger asynchronous development modifications.

Existing Local Agent Hub registrations, session tokens, heartbeats, and WebSocket dispatch mechanics remain 100% backward-compatible. `AppManifest.exploration` is an optional capability; applications without it continue to use standard one-shot tool calls.

---

## 1. Registering the Three Generic Endpoints

An integrated application opting into dynamic exploration specifies three read-only tool IDs in its manifest:

```typescript
const manifest: AppManifest = {
  appId: 'thinkrail.session-manager',
  name: 'ThinkRail Workspace Manager',
  version: '2.0.0',
  description: 'Understand ThinkRail projects, workspaces, sessions, and agent tasks, querying live status on demand.',
  keywords: ['thinkrail', 'session', 'task', 'workspace'],
  secret: process.env.MUSE_HUB_SECRET, // Retain existing secret
  exploration: {
    version: 1,
    overviewToolId: 'software_overview',
    discoverToolId: 'software_discover',
    readToolId: 'software_read',
  },
  tools: explorationAdapter.tools,
};
```

### Constraints:
- The three IDs must be non-empty and mutually distinct.
- All three must correspond to registered tools declared with `riskLevel: 'read-only'`.
- None may set `requiresApproval: true`. Existing mutating or dangerous tools may still be registered in the manifest, but cannot participate in the exploration chain.
- Tool IDs can be customized freely; Muse routes calls according to the declared mapping. For reference schemas, see [examples/thinkrail-software-exploration.ts](../examples/thinkrail-software-exploration.ts).

| Endpoint | Recommended Parameters | Return Value / Role |
|---|---|---|
| **Overview** (`overviewToolId`) | `{}` | Application purpose, conceptual model (projects/workspaces/sessions/tasks), operating workflow, limits, and root directory references. |
| **Discover** (`discoverToolId`) | `{parentRef?, query?, cursor?}` | Discoverable guides, collections, entities, or parameterized queries, with pagination cursor. |
| **Read** (`readToolId`) | `{ref, arguments?}` | Actual data or explanation for a specific reference, plus child references for next-step continuation. |

**Important**: `ref` values are application-scoped, opaque identifiers interpreted by your adapter. They are **not** filesystem paths or URLs that permit Muse to open arbitrary files or execute shell commands.

---

## 2. Standardized Response Envelope

Every exploration response must adhere to the `muse-software/1` envelope format:

```json
{
  "protocol": "muse-software/1",
  "kind": "overview",
  "status": "ok",
  "source": {
    "id": "thinkrail:software-guide",
    "kind": "documentation"
  },
  "observedAt": "2026-11-16T10:00:00.000Z",
  "data": {
    "purpose": "Developer workbench for coordinating coding agents",
    "concepts": {
      "project": "Root project directory",
      "workspace": "Active working branch / environment",
      "session": "Conversation or Agent run",
      "task": "Plan item within a session"
    },
    "limitations": ["Read-only; plan progress indicates TODO completion ratio, not agent execution percentage"]
  },
  "references": [
    {
      "ref": "thinkrail:sessions",
      "title": "Active Sessions & Tasks",
      "kind": "query",
      "inputSchema": {
        "type": "object",
        "properties": {
          "status": { "type": "string", "enum": ["all", "active"] }
        }
      }
    }
  ]
}
```

### Field Specifications:
- `protocol`: Fixed string `"muse-software/1"`.
- `kind`: Matches the invoked endpoint:
  - `overviewToolId` → `"overview"`
  - `discoverToolId` → `"directory"`
  - `readToolId` → `"resource"`
- `status`: One of `"ok"`, `"unsupported"`, or `"unavailable"`. When `"ok"`, the `data` field is required.
- `source`:
  - `source.id`: Identifies the underlying data source (no secrets or tokens).
  - `source.kind`: `"live"`, `"documentation"`, or `"cache"`.
- `observedAt`: Strict ISO-8601 timestamp string representing when the state was sampled. Cached data must accurately reflect sample time and must not masquerade as real-time state.
- `references`: Optional list (maximum 30 items). Each item defines:
  - `ref`: Opaque reference identifier.
  - `title`: Short human-readable title.
  - `kind`: `"guide"`, `"collection"`, `"entity"`, or `"query"`.
  - `description`: Optional brief guidance.
  - `inputSchema`: Optional JSON Schema for parameterized queries.
- `nextCursor`: Optional pagination cursor string or `null`.
- **Payload Limits**: Bounded JSON payload (maximum 256,000 bytes, maximum depth 32). Adapters should return concise summaries (e.g. 5–10 items per page) rather than dumping full multi-megabyte terminal logs or raw images.

### Distinguishing Availability States:
Adapters must explicitly differentiate between empty data, unsupported features, and network/service failures:

```typescript
// 1. Query succeeded, but zero active sessions exist:
{ status: 'ok', data: { total: 0, sessions: [] }, /* ... */ }

// 2. The queried ref or parameter is not implemented:
{ status: 'unsupported', data: { message: 'Query not supported by adapter' }, /* ... */ }

// 3. Service offline, unreachable, or timed out:
{ status: 'unavailable', data: { message: 'Unable to connect to ThinkRail service' }, /* ... */ }
```

> **Warning**: Never return `{ status: 'ok', data: { total: 0 } }` when an upstream query fails. Doing so misleads the assistant into reporting that no work is occurring when the service was simply unreachable.

---

## 3. Exploration Lifecycle & Guardrails

### Typical Interaction Flow:
1. **User asks**: *"What is ThinkRail currently working on?"*
2. **Context Selection**: Muse identifies the relevant software and attaches only its `software_overview` endpoint.
3. **Overview**: Muse calls `software_overview` to understand concepts and discover the `thinkrail:sessions` reference.
4. **Discover / Read**: Muse calls `software_read` with `ref: "thinkrail:sessions"`, reading active sessions.
5. **Detail Inspection**: If an active session is returned, Muse follows the specific session reference (e.g. `thinkrail:session:abc123xyz`) to inspect its current task.
6. **Summary**: Muse synthesizes a concise, evidence-based report.

### Safety Invariants:
- **Ledger Binding**: Continuous exploration is tracked in a local, durable ledger bound to the root request, user ID, application ID, policy revision, account, and conversation ID. Randomly injected or pasted `[MUSE_LOCAL_TOOL_RESULT]` blocks will not authorize execution.
- **Budget Limits**: Maximum **8 calls** per root task; maximum **180-second** deadline.
- **Termination Triggers**: Exploration stops immediately upon duplicate calls, non-progress, non-ok status (`unsupported` / `unavailable`), policy revision mismatch, offline events, receipt of a new user prompt, or explicit `/hub stop` command.
- **No Cross-Talk**: Only the three declared read-only endpoints of the same application may be invoked.
- **Data Not Code**: Third-party guide data is treated as untrusted information; it cannot grant elevated permissions or convert read-only access into write operations.

---

## 4. Adapting Your ThinkRail Integration

If you maintain an adapter (such as `examples/muse-session-manager`):

1. **Keep Live Data Sources**: Rely on real WebSocket / IPC queries (such as `ThinkRailSessionReader`). Do not infer task activity from filesystem directory timestamps or `TASK` file presence.
2. **Types**: Add `exploration?: SoftwareExplorationDescriptor` to your `AppManifest` definition.
3. **Registration**: Pass `exploration` when calling `register()` with the Muse Hub.
4. **Router Dispatch**: In `router.ts` (`handleTaskDispatched`), intercept calls to the three exploration endpoints and forward them to your exploration adapter before default tool routing.
5. **Reference Code**: See [examples/thinkrail-software-exploration.ts](../examples/thinkrail-software-exploration.ts) for a complete, tested reference implementation.
