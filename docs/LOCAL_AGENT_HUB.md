# 🔌 Muse Local Agent Hub — Integration Guide

> Connect any local application, script, download manager, or background worker to **Muse Pet** so your AI companion (`Luna`) can discover, query, and control it from your **desktop or mobile phone**.

---

## Table of Contents
1. [Overview & Architecture](#-overview--architecture)
2. [Quickstart (60-Second Integration)](#-quickstart-60-second-integration)
3. [Core Concepts](#-core-concepts)
   - [App Manifest & Tool Definitions](#1-app-manifest--tool-definitions)
   - [Risk Levels & Approval Hierarchy](#2-risk-levels--approval-hierarchy)
   - [Task Lifecycle & State Machine](#3-task-lifecycle--state-machine)
   - [Event Stream & WebSockets](#4-event-stream--websockets)
4. [Complete API Reference](#-complete-api-reference)
   - [Registration & Heartbeat](#http-registration--heartbeat)
   - [Task Execution & Polling](#http-task-execution)
   - [WebSocket Event Channel](#websocket-channel)
5. [Code Examples](#-code-examples)
   - [Node.js / JavaScript](#nodejs--javascript)
   - [Python](#python)
   - [cURL / Shell](#curl--bash)
6. [Testing & Debugging](#-testing--debugging)

---

## 📖 Overview & Architecture

**Muse Local Agent Hub** runs an embedded HTTP REST and WebSocket server inside the Muse Pet Electron main process at:

```
HTTP Base: http://127.0.0.1:19840
WS   Base: ws://127.0.0.1:19840/ws
```

When an application registers with the Hub:
1. **Tool Discovery**: Its declared tools and parameters are injected into Luna's cloud conversation via `[MUSE_LOCAL_TOOLS]`.
2. **Bidirectional Dispatch**:
   - You (or Luna on your mobile phone) can say *"Check my download queue"* or *"Start rendering scene A"*.
   - Luna emits a structured `local_tool` instruction, which the Hub translates into a `task.dispatched` event sent to your software over WebSocket.
3. **Proactive Notifications**: Your software can push a `task.completed` event when done—triggering a celebratory speech bubble above your desktop Pet and notifying your mobile phone.

```text
┌────────────────────────────┐              ┌───────────────────────────┐
│     Your Application       │              │         Muse Pet          │
│   (Python / Node / C#)     │              │    (Local Agent Hub)      │
│                            │   Register   │                           │
│  1. POST /api/v1/register  ├─────────────►│ - Issues sessionToken     │
│                            │              │ - Registers capabilities  │
│  2. Connect WS /ws         ├─────────────►│ - Establishes event bus   │
│                            │              │                           │
│  3. Wait for Luna tasks    │◄─────────────┤ Dispatches task via WS    │
│                            │              │                           │
│  4. Send progress / result ├─────────────►│ - Updates TaskManager     │
│                            │              │ - Shows Pet speech bubble │
│                            │              │ - Feeds result back to AI │
└────────────────────────────┘              └───────────────────────────┘
```

---

## ⚡ Quickstart (60-Second Integration)

Here is a minimal, complete integration script using Node.js:

```javascript
// my-app.js
const HUB = 'http://127.0.0.1:19840'
const APP_ID = 'com.example.hello'
const SECRET = 'my-app-secret-12345'

async function run() {
  // 1. Register tools
  const reg = await (await fetch(`${HUB}/api/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      name: 'Hello Tool',
      version: '1.0.0',
      description: 'A sample tool that greets the user',
      secret: SECRET,
      tools: [{
        toolId: 'say_hello',
        name: '打招呼',
        description: '向指定名字打招呼',
        category: 'action',
        riskLevel: 'read-only',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } }
        }
      }]
    })
  })).json()

  console.log('Registered with Hub:', reg.data.sessionToken)

  // 2. Connect WebSocket to receive commands
  const ws = new WebSocket(`ws://127.0.0.1:19840/ws?appId=${APP_ID}&secret=${SECRET}`)

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'task.dispatched') {
      const { taskId, payload } = msg
      console.log('Received task from Luna:', payload.toolId, payload.parameters)

      // Execute work and reply with completion
      ws.send(JSON.stringify({
        type: 'task.completed',
        taskId,
        payload: { result: `你好，${payload.parameters?.name || '主人'}！` }
      }))
    }
  }

  // 3. Heartbeat loop
  setInterval(() => {
    fetch(`${HUB}/api/v1/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.data.sessionToken}`,
        'X-App-Id': APP_ID
      },
      body: JSON.stringify({ status: 'active', activeTasks: 0 })
    }).catch(() => {})
  }, 20000)
}

run()
```

Run this with `node my-app.js` while Muse Pet is open. In ChatWindow, type `/hub`—your tool will appear instantly under the connected apps list!

---

## 🧠 Core Concepts

### 1. App Manifest & Tool Definitions

When your application boots, it describes its capabilities to the Hub:

```typescript
interface AppManifest {
  appId: string           // Unique identifier (3-80 chars: a-z, 0-9, ., _, -)
  name: string            // Human-readable title
  version: string         // Semantic version
  description: string     // Clear explanation so Luna knows WHEN to call your app
  secret: string          // Secret key (min 8 chars) used to verify WebSocket and recover tokens
  icon?: string           // Base64 or local image URL
  tools: ToolDefinition[] // Array of exposed actions/queries
}

interface ToolDefinition {
  toolId: string          // Unique per app (e.g., "list_queue", "start_render")
  name: string            // Friendly name
  description: string     // Detailed instructions for the LLM
  category: 'query' | 'action' | 'vision' | 'system'
  riskLevel: 'read-only' | 'write-safe' | 'write-dangerous'
  inputSchema: Record<string, any>  // JSON Schema for arguments
  outputSchema?: Record<string, any>
  requiresApproval?: boolean        // Force human approval card in terminal
}
```

### 2. Risk Levels & Approval Hierarchy

Muse Pet enforces a strict safety ladder so external software cannot mutate user files without consent:

| Risk Level | Meaning | Behavior |
|---|---|---|
| `read-only` | Passive status queries, telemetry, screen reads | **Auto-allowed** immediately |
| `write-safe` | Benign mutations (e.g. adding a download URL, resuming a queue) | Auto-allowed if user clicked **[信任 (Trusted)]** in `/hub`; otherwise renders an authorization card |
| `write-dangerous` | Deleting files, killing processes, executing scripts | **Always prompts** an inline `[Allow / Deny]` card in the terminal |

### 3. Task Lifecycle & State Machine

Every dispatched task moves through a deterministic state machine:

```text
              [create]
                 │
                 ▼
             pending ───► awaiting_approval ───► cancelled (user denied)
                 │               │
                 ▼               ▼ (user approved)
              running ◄──────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
    completed           failed
```

- Tasks report real-time progress via `task.progress` events: `{ percentage: 45, message: "Downloaded 450/1000 MB" }`.
- Finished tasks store their structured `result` and timestamp.
- If your application disconnects unexpectedly, active tasks are automatically marked `cancelled` with reason `"app went offline"`.

### 4. Event Stream & WebSockets

The WebSocket connection (`ws://127.0.0.1:19840/ws`) is a full-duplex communication pipeline:
- **Hub → App**: Delivers `task.dispatched` and `task.approval_required`.
- **App → Hub**: Emits `task.progress`, `task.completed`, `task.failed`, and custom proactive events.

---

## 📡 Complete API Reference

### HTTP: Registration & Heartbeat

#### 1. Register Application
`POST /api/v1/register`
- **Auth**: None (identified by payload `secret`).
- **Body**: Complete `AppManifest` JSON.
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "sessionToken": "eyJwIjoie1wiYXBwSW...==",
      "hubVersion": 1,
      "heartbeatTimeoutMs": 75000
    }
  }
  ```

#### 2. Heartbeat Ping
`POST /api/v1/heartbeat`
- **Headers**:
  ```http
  Authorization: Bearer <sessionToken>
  X-App-Id: <appId>
  ```
- **Body**:
  ```json
  {
    "status": "active", // "active" | "busy" | "paused"
    "activeTasks": 2
  }
  ```
- **Response**: `{"ok": true, "data": {"online": true}}`

#### 3. Unregister Application
`DELETE /api/v1/register/:appId`
- **Headers**: `Authorization: Bearer <sessionToken>`, `X-App-Id: <appId>`
- **Response**: `{"ok": true}`

#### 4. Query Available Tools (Public Discovery)
`GET /api/v1/tools`
- Returns all tools across all currently online applications.

---

### HTTP: Task Execution

#### 1. Dispatch a Task Manually
`POST /api/v1/tasks`
- **Headers**: `Authorization: Bearer <sessionToken>`, `X-App-Id: <appId>`
- **Body**:
  ```json
  {
    "toolId": "start_render",
    "parameters": { "scene": "intro.blend" },
    "priority": "high"
  }
  ```
- **Response (Allowed)**: `{"ok": true, "data": {"taskId": "tsk_...", "status": "running"}}`
- **Response (Gated)**: `{"ok": true, "data": {"taskId": "tsk_...", "status": "awaiting_approval"}}`

#### 2. Query Task Status
`GET /api/v1/tasks/:taskId`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "taskId": "tsk_mwg6emws_48c8390d",
      "appId": "com.example.downloader",
      "toolId": "list_queue",
      "status": "completed",
      "progress": { "percentage": 100 },
      "result": { "activeCount": 1, "items": [...] },
      "createdAt": 1794646789000,
      "completedAt": 1794646790500
    }
  }
  ```

---

### WebSocket Channel

**Connect**: `ws://127.0.0.1:19840/ws?appId=<appId>&secret=<secret>`

#### Incoming Message: Task Dispatched
```json
{
  "eventId": "evt_12345",
  "sourceAppId": "hub",
  "type": "task.dispatched",
  "timestamp": 1794646789000,
  "payload": {
    "taskId": "tsk_abc123",
    "toolId": "export_pdf",
    "parameters": { "dpi": 300 }
  }
}
```

#### Outgoing Message: Task Progress
```json
{
  "type": "task.progress",
  "taskId": "tsk_abc123",
  "payload": {
    "percentage": 50,
    "message": "Processing page 5 of 10"
  }
}
```

#### Outgoing Message: Task Completed
```json
{
  "type": "task.completed",
  "taskId": "tsk_abc123",
  "payload": {
    "result": {
      "outputFilePath": "C:\\Exports\\doc.pdf",
      "pageCount": 10
    }
  }
}
```

#### Outgoing Message: Proactive Event (Pet Bubble Notification)
You can push proactive events that notify the desktop pet directly:
```json
{
  "type": "event",
  "payload": {
    "type": "task.completed",
    "message": "Render completed in 4m 12s!"
  }
}
```

---

## 💻 Code Examples

### Python

```python
import json
import time
import threading
import urllib.request
import websocket # pip install websocket-client

HUB_URL = "http://127.0.0.1:19840"
APP_ID = "com.python.worker"
SECRET = "python-secret-987654"

# 1. Register with Hub
manifest = {
    "appId": APP_ID,
    "name": "Python Data Processor",
    "version": "1.0.0",
    "description": "Runs local Pandas / NumPy statistical data crunching",
    "secret": SECRET,
    "tools": [{
        "toolId": "calculate_stats",
        "name": "统计计算",
        "description": "计算数值列表的均值、中位数和标准差",
        "category": "query",
        "riskLevel": "read-only",
        "inputSchema": {
            "type": "object",
            "properties": { "numbers": { "type": "array" } }
        }
    }]
}

req = urllib.request.Request(
    f"{HUB_URL}/api/v1/register",
    data=json.dumps(manifest).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
res = json.loads(urllib.request.urlopen(req).read().decode("utf-8"))
token = res["data"]["sessionToken"]
print("Connected to Hub! Token:", token[:16])

# 2. WebSocket listener
def on_message(ws, message):
    data = json.loads(message)
    if data.get("type") == "task.dispatched":
        task_id = data["payload"]["taskId"]
        numbers = data["payload"]["parameters"].get("numbers", [1, 2, 3, 4, 5])
        avg = sum(numbers) / len(numbers)
        
        # Report completion
        ws.send(json.dumps({
            "type": "task.completed",
            "taskId": task_id,
            "payload": { "result": { "mean": avg, "count": len(numbers) } }
        }))
        print(f"Task {task_id} completed: mean={avg}")

ws = websocket.WebSocketApp(
    f"ws://127.0.0.1:19840/ws?appId={APP_ID}&secret={SECRET}",
    on_message=on_message
)
ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
ws_thread.start()

# 3. Heartbeat loop
while True:
    time.sleep(20)
    try:
        hb_req = urllib.request.Request(
            f"{HUB_URL}/api/v1/heartbeat",
            data=json.dumps({"status": "active", "activeTasks": 0}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", "X-App-Id": APP_ID}
        )
        urllib.request.urlopen(hb_req)
    except Exception as e:
        print("Heartbeat err:", e)
```

---

## 🛠️ Testing & Debugging

1. **Terminal UI Management (`/hub`)**:
   - Press `Alt + Space` to summon ChatWindow.
   - Click the **`/hub`** button in the header or type `/hub`.
   - You can see your application's status (在线/离线), test-call any tool directly, and toggle trust permissions.

2. **Run the Builtin Demo**:
   Inside this repository, run:
   ```bash
   node examples/third-party-app.cjs
   ```
   This simulates a multi-threaded download manager that registers with the Hub, reports mock download progress, and completes tasks dispatched by Luna.
