# 软件理解与只读探索协议（muse-software/1）

本协议让 Muse 按任务阅读软件概览、发现动态资源、查询实际状态。第三方适配器负责提供可信数据与受限入口；Muse 根据每次结果决定下一步读取。第一版只读，不进行 GUI 操作、代码执行、文件写入或开发任务启动。

现有 Hub 注册、会话 token、心跳与 WebSocket 派发保持不变。`AppManifest.exploration` 是可选扩展；不声明时继续使用原有单次工具调用。

## 1. 注册三个通用入口

```ts
const manifest = {
  appId: 'thinkrail.session-manager',
  name: 'ThinkRail 开发工作台',
  version: '2.0.0',
  description: '理解 ThinkRail 的项目、工作区、会话与 Agent 任务，按需查询真实运行状态。',
  keywords: ['thinkrail', '会话', '任务', '工作区'],
  secret: process.env.MUSE_HUB_SECRET, // 保留你已注册应用的原 secret，不要生成示例固定密钥
  exploration: {
    version: 1,
    overviewToolId: 'software_overview',
    discoverToolId: 'software_discover',
    readToolId: 'software_read',
  },
  tools: explorationAdapter.tools,
}
```

三个 ID 必须不同，必须对应已注册的 `read-only` 工具，而且不能设置 `requiresApproval: true`。原有写工具可以继续注册，但不能进入本次只读探索链。

入口的具体 `toolId` 可以改名；Muse 使用声明中的映射。参考 schemas 见可运行测试覆盖的 [ThinkRail 适配器示例](../examples/thinkrail-software-exploration.ts)。

| 入口 | 建议参数 | 返回内容 |
|---|---|---|
| overview | `{}` | 软件用途、概念关系、使用流程、限制、目录入口 |
| discover | `{parentRef?, query?, cursor?}` | 当前可发现的指南、集合、实体与只读查询，及分页游标 |
| read | `{ref, arguments?}` | 指定资源的实际数据或说明，以及继续查询的资源引用 |

这些是通用读取入口。新增项目、会话或只读查询，可以通过目录返回新 ref，不需要为每个业务动作新增静态工具。**ref 是适配器解释的标识符，不是允许 Muse 打开任意文件或执行 shell 的 URL。**

## 2. 统一响应封装

```json
{
  "protocol": "muse-software/1",
  "kind": "overview",
  "status": "ok",
  "source": { "id": "thinkrail:software-guide", "kind": "documentation" },
  "observedAt": "2026-11-16T10:00:00.000Z",
  "data": {
    "purpose": "用于协调 coding agent 的开发工作台",
    "concepts": {
      "project": "项目",
      "workspace": "工作环境",
      "session": "对话与 Agent 会话",
      "task": "会话的计划项"
    },
    "limitations": ["只读；计划完成比例不是执行百分比"]
  },
  "references": [
    { "ref": "thinkrail:sessions", "title": "当前会话与任务", "kind": "query",
      "inputSchema": {
        "type": "object",
        "properties": { "status": { "type": "string", "enum": ["all", "active"] } }
      }
    }
  ]
}
```

字段约束：

- `protocol` 固定为 `muse-software/1`。
- `kind` 与调用入口对应：overview → `overview`，discover → `directory`，read → `resource`。
- `status`：`ok`、`unsupported` 或 `unavailable`。`ok` 必须带 `data`。
- `source.id` 是有意义的数据源名称，不含凭据；`source.kind` 为 `live`、`documentation` 或 `cache`。
- `observedAt` 为实际读取时间的 ISO 时间字符串。缓存数据应说明其采集时间和时效，不冒充当前实时状态。
- `references` 可省略，最多 30 项。每项包含 `ref`、`title`、`kind`（`guide`、`collection`、`entity`、`query`）；可附 `description`、`inputSchema`。
- `nextCursor` 可省略、为字符串或 null。分页内容必须由适配器限定大小。
- 整个响应是有界 JSON，最大 256000 字节、嵌套深度最多 32。建议每页返回 5–10 项精简摘要，不把完整会话日志、代码或图片编码塞入软件探索响应。

必须区分以下三种情况：

```ts
// 真正查询成功但没有运行会话：
{ status: 'ok', data: { total: 0, sessions: [] }, /* 其余封装字段 */ }

// 还没有实现这种资源或参数：
{ status: 'unsupported', data: { message: '适配器尚未支持此查询' }, /* 其余字段 */ }

// ThinkRail 服务离线、超时或数据源不可用：
{ status: 'unavailable', data: { message: '暂时无法获取真实状态' }, /* 其余字段 */ }
```

不要在连接失败时返回 `ok: true, total: 0`。Muse 无法从空数组判断“确实没有任务”还是“根本没连上”。

## 3. 探索过程与控制边界

一次典型任务：

1. 用户问“ThinkRail 目前在忙什么”。初始上下文只给匹配软件的概览入口。
2. Muse 调用 overview，理解项目、会话与任务的关系。
3. 根据 overview 返回的目录，调用 discover。
4. 按发现的 ref 读取 active 会话，再按具体 session ref 查询当前任务。
5. Muse 根据实际数据总结；资料不足时说明缺口。

Muse Pet 在本地记录探索根、账号、会话、应用和协议 revision。后续调用必须紧接本地登记的结果回执，并在同一探索范围内；仅仅粘贴一个 `[MUSE_LOCAL_TOOL_RESULT]` 不会开启任意自动执行。

每次任务最多 8 次真实读取，180 秒有效期。重复同一调用、失败、取消、应用离线、协议变化、非 ok 响应、账号/会话变化、新用户请求或发送状态不确定都会停止探索。`/hub stop` 用于停止当前会话中的探索。重启后不会自动恢复历史探索。

普通旧 Hub 结果仍采用单次调用策略；只有声明探索协议的软件才能进入受控连续读取。软件返回的指南是数据，不能覆盖本地权限或把只读升级为写操作。

## 4. ThinkRail 当前项目的修改位置

你现在的 ThinkRail 适配器已经通过 `ThinkRailSessionReader` 查询真实服务。保留这个数据源，不要换成目录扫描或文件修改时间推断。

建议修改：

1. `examples/muse-session-manager/types.ts`：给本地 `AppManifest` 镜像加入 `exploration?: SoftwareExplorationDescriptor`，定义 descriptor 的四个字段。
2. `hub-client.ts`：在注册 manifest 中透传 `exploration`，保留已有 secret、心跳和重连行为。
3. `tools.ts`：加入三个通用只读工具定义。旧 `list_projects` / `list_sessions` 等可以继续保留兼容，但探索初始清单只展示 overview。
4. `router.ts`：在现有分派前处理这三个入口，将参数交给只读探索适配器，使用已有 `sendCompleted(taskId, envelope)` 回传。
5. 依赖现有 `ThinkRailSessionReader.listProjects()` 与 `.list({status, limit, sessionId})`，不直接依赖 ThinkRail 磁盘存储格式。

完整参考实现：[examples/thinkrail-software-exploration.ts](../examples/thinkrail-software-exploration.ts)。该文件在 Muse Pet 仓库引用 `../src/main/hub/sdk-types`；复制到 ThinkRail 后，将类型 import 改为你自己的 `./types` 并补齐 descriptor 类型。

接到现有 router 的示意：

```ts
const explorationAdapter = createThinkRailExploration(this.realSessions)
const entryIds = new Set(explorationAdapter.tools.map(tool => tool.toolId))

// 在 handleTaskDispatched 内，原有业务路由之前：
if (entryIds.has(toolId)) {
  const result = await explorationAdapter.execute(toolId, parameters)
  this.hubClient.sendCompleted(taskId, result)
  return
}
```

这里的 `this.realSessions` 对应你已有的真实查询接口。示例本身不注册 Hub、不打开 ThinkRail 服务、不提供模拟业务状态；你负责把实际 reader 注入进去。

## 5. 验收与尚未接入时的行为

- 未声明 `exploration`：旧工具照常可用，不声称 Muse 已可连续探索。
- 声明无效或入口不是只读：注册失败并报告字段问题，不降级绕过权限。
- 正确声明但未接真实 reader：必须返回 `unavailable`，不能制造“运行中”或“零会话”。
- ThinkRail 使用 TODO 计划进度时明确标为 `planProgress`；没有证据时不推算执行百分比。
- 第三方完成改造后，在同一 Muse 主会话重新问“ThinkRail 目前在忙什么”，观察 overview → discover/read → 最终摘要，确认 appId、数据源和时间一致。
- 自动化 fixture 验证协议与调度，不等于真实 ThinkRail 或 Muse 云端验收。本文交付的是 Muse 侧支持和适配规范，ThinkRail 改造及真实联调需单独完成。

## 6. 会话显示与网页中转限制

只在明确软件请求时按需传递相关概览，后续结果采用有界数据；桌面会将协议显示为工具卡片。当前仍通过 Muse 网页对话中转，云端会保留必要结果报文，无法承诺与原生工具通道一样完全隐藏。不要为了“学习软件”自动扫描无关项目、上传完整日志或长期保存业务会话内容。
