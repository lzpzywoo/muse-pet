# 🛠️ 第三方 Local Agent Hub 开发与接入指南

> 本文档面向希望将本地桌面软件（如 **ThinkRail**、下载器、自动化脚本、后台进程等）接入 **Muse Pet (Local Agent Hub)** 的开发者。
> 帮助你设计**易于被 Luna 自然语言识别并精准调用的 Hub 服务**，并以 **ThinkRail 会话任务管理** 为例，提供读取真实工作区会话的完整解决方案。

---

## 目录
1. [意图识别与元数据命名规范（黄金法则）](#1-意图识别与元数据命名规范黄金法则)
2. [为什么你之前“找不到”或“查不到”？问题复盘](#2-为什么你之前找不到或查不到问题复盘)
3. [ThinkRail 真实会话数据接入方案](#3-thinkrail-真实会话数据接入方案)
4. [完整的 ThinkRail Hub 示例代码](#4-完整的-thinkrail-hub-示例代码)
5. [常见问答 (FAQ)](#5-常见问答-faq)

---

## 1. 意图识别与元数据命名规范（黄金法则）

当你在聊天终端询问 Luna（例如：“查看下 thinkrail 目前的会话任务”）时，系统会自动在本地已注册且在线的 Hub 应用中寻找匹配项。
为了让意图识别器（`shouldIncludeHubTools`）和 LLM（Luna）能够精准定位并调用你的工具，请遵守以下规范：

### (1) AppManifest 关键字段规范

```typescript
export interface AppManifest {
  // 建议包含产品品牌或专属域名，例如 'thinkrail.session-manager' 或 'com.thinkrail.agent'
  appId: string;

  // 必须包含用户会直呼的产品名与核心功能！
  // 推荐：'ThinkRail 会话与任务管理器'
  // 不推荐：'会话与任务管理器'（缺少 ThinkRail 关键词，用户只提 thinkrail 时无法匹配）
  name: string;

  // 描述产品与应用场景，务必提及相关的技术名词（如 ThinkRail, 会话, 任务, 进程, PR）
  description: string;

  // 【新增】关键词列表（强烈推荐配置！大小写不敏感）
  // 声明用户可能提到的别名、缩写、英文名和核心概念
  keywords?: string[]; // 例如: ['thinkrail', 'session', '会话', '任务', '工作区']

  secret: string;
  tools: ToolDefinition[];
}
```

### (2) Tool 命名与描述规范

Luna 依靠 `tool.name` 与 `tool.description` 决定何时调用工具，意图匹配器也会提取工具名词：

1. **`toolId`**：简洁的蛇形命名，如 `list_sessions`、`query_progress`、`cancel_task`。
2. **`name`**：动宾短语，如 `查看会话列表`、`查询会话进度`、`创建并执行任务`。
   - 意图匹配器会自动拆分提取核心动词宾语（例如从 `查看所有会话列表` 提取出 `会话列表`）。
3. **`description`**：**至关重要**。不仅说明工具做什么，还要说明**在用户问什么时调用**。
   - 推荐：`获取 ThinkRail 当前各项目、工作区正在进行的会话任务清单与状态。当用户询问“ThinkRail在跑什么任务”“有哪些会话”“当前进度”时调用。`
4. **`riskLevel`**：
   - `read-only`：只读查询（如获取列表、查看进度），直接放行，免用户点击批准。
   - `write-safe`：安全的写操作（如发送宠物气泡、新建任务），用户可在 Hub 面板中一键信任。
   - `write-dangerous`：高风险变更（如删除会话、修改磁盘），每次调用需桌面弹窗授权。

---

## 2. 为什么你之前“找不到”或“查不到”？问题复盘

你在开发 `thinkrail/examples/muse-session-manager` 时遇到了两个典型问题：

### 问题 A：问“查看下 thinkrail 会话任务”，Luna 说“直接看不到，建议跑 powershell”
- **根本原因**：
  - 你的注册信息中 `appId: "com.muse.session-manager"`，`name: "会话与任务管理器"`，工具名为 `创建并执行会话任务`、`查看所有会话列表`。
  - **没有任何字段包含 "thinkrail"**！
  - 用户提问：“查看下 thinkrail 目前的会话任务”。
  - 意图匹配器发现没有包含 `com.muse.session-manager`，也没有 `thinkrail` 相关的注册项，因此判定为普通聊天，**没有将工具注入给 Luna**。
  - Luna 在不知情的情况下，只能建议用户通过本地 PowerShell 脚本去磁盘上查找。
- **解决方式**：
  - 将 `name` 改为 `ThinkRail 会话与任务管理器`。
  - 在 `keywords` 中加入 `['thinkrail', 'session', '任务', '会话']`。
  - 优化后的意图匹配器不仅会匹配 `keywords`，还会自动匹配 `description` 中的英文名词与工具复合名词。

### 问题 B：显式调用 `/hub list_sessions:` 后，返回 `{"total": 0, "sessions": []}`
- **根本原因**：
  - 查阅 `thinkrail/examples/muse-session-manager/session-manager.ts`：原先的示例是一个 **纯内存演示（In-Memory Mock）**。
  - 它在内存里维护了一个 `Map<string, SessionExecutionInternal>`，只有先调用 `create_and_run_session` 创建了模拟任务，`sessions` 才有数据。
  - 它并没有去读取真实的 ThinkRail 客户端、工作区目录或系统进程。

---

## 3. ThinkRail 真实会话数据接入方案

ThinkRail（或基于 pi / coding agent 的工作区）在运行时，其真实会话与任务通常保存在磁盘的工作区目录中，或者可以通过运行中的进程检测。

### 方案 1：读取 `~/.thinkrail` 工作区与会话元数据（推荐，最稳定）

在 Windows / macOS / Linux 上，ThinkRail 的工作区默认位于：
- Windows: `C:\Users\<用户名>\.thinkrail`
- Unix: `~/.thinkrail`

核心数据目录：
- `~/.thinkrail/worktrees/`：保存各个项目的 git worktree 工作区。
- `~/.thinkrail/sessions/` 或 各工作区下的 `.thinkrail/context/`：保存活跃的 `TASK-*.md` 任务规格。
- 检查本地进程：是否存在 `pi.exe` 或 `thinkrail.exe` 正在运行。

### 方案 2：提供一键扫描并返回格式化摘要

在 `list_sessions` 工具中：
1. 扫描当前运行中的 `thinkrail` / `pi` 进程。
2. 遍历 `~/.thinkrail/worktrees/` 下的项目与最近更新的工作区。
3. 如果项目下有 `.thinkrail/context/TASK-*.md`，读取其标题与状态（draft / in_progress / done）。
4. 将合并后的真实会话列表返回给 Luna。

---

## 4. 完整的 ThinkRail Hub 示例代码

你可以直接参考或替换 `thinkrail/examples/muse-session-manager/` 中的配置与实现：

### 4.1 更新注册清单 (`tools.ts`)

```typescript
import type { ToolDefinition } from './types';

export const THINKRAIL_HUB_MANIFEST = {
  appId: 'thinkrail.session-manager',
  name: 'ThinkRail 会话与任务管理器',
  version: '1.1.0',
  description: '提供 ThinkRail 真实工作区会话扫描、运行中任务状态查询与多步骤任务协同。',
  keywords: ['thinkrail', 'session', '会话', '任务', '工作区', 'pi'],
  secret: 'thinkrail-hub-secret-2026',
};

export const THINKRAIL_TOOLS: ToolDefinition[] = [
  {
    toolId: 'list_sessions',
    name: '查看所有会话列表',
    description: '获取 ThinkRail 当前各项目、工作区正在进行的会话任务清单与状态。当用户询问“ThinkRail在跑什么任务”“有哪些会话”“当前进度”时调用。',
    category: 'query',
    riskLevel: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'running', 'active', 'recent'],
          default: 'all',
          description: '状态筛选条件',
        },
        limit: {
          type: 'number',
          default: 10,
          description: '最多返回数量',
        },
      },
    },
  },
  {
    toolId: 'query_session_progress',
    name: '查询会话进度与详情',
    description: '根据会话 ID 或任务名称查询 ThinkRail 目标会话的详细执行步骤、已修改文件与执行日志。',
    category: 'query',
    riskLevel: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 ID 或工作区名称',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    toolId: 'send_pet_bubble',
    name: '发送桌面宠物气泡提醒',
    description: '在 Muse 桌面宠物上方弹出一则气泡提示文字，通知用户任务已就绪或需关注。',
    category: 'action',
    riskLevel: 'write-safe',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '气泡文本内容',
        },
      },
      required: ['message'],
    },
  },
];
```

### 4.2 读取真实数据的 `session-manager.ts` 实现片段

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface RealThinkRailSession {
  id: string;
  projectName: string;
  workspaceName: string;
  status: 'running' | 'idle' | 'completed';
  currentTaskTitle?: string;
  lastActiveTime: number;
}

export class ThinkRailRealSessionReader {
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(os.homedir(), '.thinkrail');
  }

  public async getRealSessions(): Promise<RealThinkRailSession[]> {
    const sessions: RealThinkRailSession[] = [];
    const worktreesDir = path.join(this.baseDir, 'worktrees');

    if (!fs.existsSync(worktreesDir)) {
      return sessions;
    }

    try {
      const projects = fs.readdirSync(worktreesDir, { withFileTypes: true });
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        const projPath = path.join(worktreesDir, proj.name);
        const wss = fs.readdirSync(projPath, { withFileTypes: true });

        for (const ws of wss) {
          if (!ws.isDirectory()) continue;
          const wsPath = path.join(projPath, ws.name);
          const stat = fs.statSync(wsPath);

          // 检查是否有活跃的 TASK-*.md
          let taskTitle = '';
          const contextDir = path.join(wsPath, '.thinkrail', 'context');
          if (fs.existsSync(contextDir)) {
            const files = fs.readdirSync(contextDir);
            const taskFile = files.find(f => f.startsWith('TASK-') && f.endsWith('.md'));
            if (taskFile) {
              const content = fs.readFileSync(path.join(contextDir, taskFile), 'utf8');
              const titleMatch = content.match(/title:\s*(.+)/);
              if (titleMatch) taskTitle = titleMatch[1].trim();
            }
          }

          sessions.push({
            id: `${proj.name}/${ws.name}`,
            projectName: proj.name,
            workspaceName: ws.name,
            status: Date.now() - stat.mtimeMs < 10 * 60 * 1000 ? 'running' : 'idle',
            currentTaskTitle: taskTitle || '常规工作区',
            lastActiveTime: stat.mtimeMs,
          });
        }
      }
    } catch (err) {
      console.error('扫描 ThinkRail 工作区失败:', err);
    }

    // 按最近活跃时间倒序
    return sessions.sort((a, b) => b.lastActiveTime - a.lastActiveTime);
  }
}
```

### 4.3 在 `router.ts` 中分派真实结果

```typescript
// router.ts 的 list_sessions 处理函数：
const reader = new ThinkRailRealSessionReader();

router.handle('list_sessions', async (params) => {
  const realSessions = await reader.getRealSessions();
  return {
    ok: true,
    total: realSessions.length,
    sessions: realSessions.slice(0, Number(params.limit) || 10),
    summary: realSessions.length > 0
      ? `检测到 ${realSessions.length} 个 ThinkRail 工作区，最新活跃：${realSessions[0].projectName} (${realSessions[0].currentTaskTitle})`
      : '未检测到活跃的 ThinkRail 工作区或会话。',
  };
});
```

---

## 5. 常见问答 (FAQ)

### Q1: 注册后在 Muse Pet 哪里能看到我的 Hub 应用？
- 在 Muse Pet 桌面端聊天窗口中输入 `/hub`，即可打开 **Local Agent Hub** 管理面板。
- 面板中会展示所有已接入的本地软件、在线状态、心跳延时、工具列表与最近任务执行记录。

### Q2: 怎么在手机端远程调用我的本地 Hub？
- 在手机端 Meta Muse 聊天中，直接给你的伴侣发送自然语言指令（例如：“查看下 thinkrail 目前的会话任务”或发送 `/hub tools`）。
- 伴侣会自动通过云端协议下发 `local_tool` 调用指令，Muse Pet 监听到后将任务派发给你本地的 Hub 服务执行，并将结果自动同步回复给手机端！

### Q3: 为什么建议使用 `keywords`？
- 用户习惯使用各种非标准的表述（如只说 `thinkrail`、只说 `会话`、或者说 `session`）。
- 在 `AppManifest` 中配置 `keywords` 后，Muse Pet 会将其纳入意图索引，即使提问没有命中完整工具名，也能智能激活工具挂载。
