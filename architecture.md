---
id: muse-pet-architecture
type: architecture-design
status: active
title: Muse Pet — 系统架构与多进程设计
parent: muse-pet-goal
---

# Muse Pet — 系统架构与多进程设计

> Electron 多窗口架构、主进程网络反向代理与 Meta Muse Avatar 状态联动驱动体系。

## Drivers

- **桌面无感与极速交互**：宠物需 7x24h 常驻桌面角落，背景完全透明且低功耗；对话面板需要毫秒级唤醒，呼出与收起不阻塞宠物动效。
- **Meta 鉴权与反向代理**：`muse.ai` 依赖 Meta 账号体系与复杂 Cookie/Session，需规避 Web 端跨域和防逆向检测，保证通信稳定性。
- **状态联动**：对话交互与宠物形象深度绑定（提问时宠物进入思考态、流式返回时宠物进入说话态、空闲时随机呼吸微动作）。

## Architecture Topology

```
+------------------------------------------------------------------------+
|                          Electron Main Process                         |
|  +--------------------+  +----------------------+  +----------------+  |
|  | Window Manager     |  | Session & Auth Store |  | Muse API Client|  |
|  | - PetWindow        |  | - safeStorage        |  | - Reverse Proxy|  |
|  | - ChatWindow       |  | - Cookie Interceptor |  | - SSE Stream   |  |
|  | - AuthWindow       |  +----------------------+  +----------------+  |
|  +--------------------+  +------------------------------------------+  |
|  | Tray & Hotkey Hub  |  | IPC Event Router & State Synchronizer    |  |
+--+--------------------+--+------------------------------------------+--+
             |                                    |
             | IPC (contextBridge)                | IPC (contextBridge)
             v                                    v
+-----------------------------+      +-----------------------------------+
|   Pet Renderer (React/Vite) |      |    Chat Renderer (React/Vite)     |
| - Meta Avatar Player/Stream |      | - Streaming Markdown Conversation |
| - State Machine (Idle/Talk) | <--> | - Session History & Model Toggle  |
| - Drag & Click-through Hit  |      | - Fast Hotkey Panel Focus         |
+-----------------------------+      +-----------------------------------+
```

## Decisions

### 1. 多窗口隔离模型 (Pet Window + Chat Window + Auth Window)
- **Pet Window**：尺寸为 `300 × 420`（内部角色画布展示区 `224 × 224` 锁定 `shrink-0` 防止被顶部气泡或插件挂件挤压裁切），设置 `transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`，默认开启 `setIgnoreMouseEvents(true, { forward: true })` 鼠标穿透转发。渲染层通过实时抠图掩码（`bgMaskRef`）与气泡/挂件/模式切换胶囊几何边界进行 **像素级 Alpha 命中检测**：只有当鼠标悬停在人物不透明轮廓像素、活动冒泡气泡、模式切换按钮或挂件上时才捕获鼠标事件（支持按住人物轮廓拖拽移动位置或单击呼出终端），人物四周的透明背景与上方空白区完全穿透到底层桌面窗口，绝不遮挡周围点击。
- **Chat Window (Spotlight / Liquid Glass Terminal HUD)**：宽幅独立窗口（默认 `640 × 560`，最小 `460 × 380`），默认隐藏。支持通过鼠标拖拽窗口四边、四角及右下角斜纹手柄 8 方向自由缩放大小（或点击左上角绿灯 `+` / 双击标题栏一键放大/还原），并将调整后的宽高与坐标自动持久化在 `userData/chat_bounds.json`。全局快捷键（`Alt + Space`）或点击桌面宠物触发显隐，首次在主屏幕中上方黄金视觉位（水平居中、距顶约 16%）弹出。默认采用 **100% 不透明曜石纯黑（Obsidian Solid）** 基底搭配 Apple Liquid Glass 顶部高光折射边（避免底层桌面干扰阅读），并支持在 `/settings`（或通过 `/solid`、`/glass`、`/theme` 命令与不透明度滑块 `45%~100%`）自由切换并持久化窗口材质与透明度。支持 `Esc` 键一键收起、macOS 红黄绿交通灯控制、`luna ❯` 终端提示符、`/sync` 云端历史同步与 `↑`/`↓` 历史命令回溯。
- **Auth Window**：独立的临时 Webview 窗口，仅在用户首次登录或凭证过期时调出，加载 `https://muse.ai`。统一伪装标准 Chrome User-Agent 规避反爬，监听 `session.fromPartition('persist:meta_muse').webRequest.onCompleted`，自动提取 Meta 核心认证 Cookie，保存后立即自毁；若加载失败注入带一键重试的故障排查诊断页。
- **Proxy Manager**：统一代理调度体系，应用启动时默认激活 Windows 系统代理（`mode: 'system'`），支持自定义 fixed_servers 代理规则并提供实时测速与手动 Cookie 录入兜底。

### 2. 主进程通信桥接与会话管理 (Browser-in-Browser Relay & Session Store)
- **通信收口（隐藏 BrowserWindow 桥接）**：`muse.ai` 采用 Meta Hatch 架构（基于 `/api/hatch/*` 与 `Noise_XX_25519` 加密 WebSocket 通道及 TLS/JA3 指纹校验）。主进程 `MuseClient` 维护一个共享 `persist:meta_muse` 分区的隐藏 `BrowserWindow` 实例，直接利用真实 Chromium 环境与页面内置的 Hatch Composer/Noise 通道收发消息，避免外部请求被风控拦截。
- **防风控与协议伪装**：`AuthWindow` 与隐藏 `museWindow` 共享 `persist:meta_muse` 分区并注入标准桌面 Chrome User-Agent，仅当检测到核心登录态 Cookie `hatch_sess` 时判定鉴权成功。
- **加密存储**：Meta 登录会话与 Cookie 在 `app.whenReady()` 之后使用 Electron 原生 `safeStorage` 进行操作系统级别的对称加密存储与恢复，杜绝明文凭证泄漏与启动时序导致的解密失败。
- **流式分发、富媒体附件与云端双向同步**：主进程从隐藏 `museWindow` 实时轮询新增的助手回复增量文本，一边向下游转发至 Chat 渲染进程，一边向 Pet 渲染进程同步推送 `pet:speech-bubble` 实时冒泡文案与未读角标提醒；同时自动从 `muse.ai` 的 `[data-message-item="true"]` 节点提取并后台监听云端会话历史（针对因窗口隐藏而处于懒加载骨架屏状态的 `[data-testid^="hatch-chat-attachment-presentation-"]` 媒体组件主动触发 React 可见性回调，将聊天内的 `blob:` 图片与动作预览视频转换并持久化缓存至 `userData/media_cache/`，供 `ChatWindow` 内联展示及全屏 Lightbox 预览），持久化至本地 `userData/chat_history.json` 并通过 `chat:messages-synced` 与 `ChatWindow` 保持双向同步。

### 3. Meta Avatar 状态驱动与本地缓存机制
- 建立状态机：`IDLE`（待机呼吸）、`LISTENING`（面板打开等待输入）、`THINKING`（正在向 Muse 请求）、`TALKING`（正在流式接收文本并合成口型/动作）、`ERROR`（异常或断网提示）。
- **多状态视频提取、持久化缓存与实时换装热更新**：`MuseClient` 从隐藏 `museWindow` 排除聊天消息内部后的主舞台 `video[data-hatch-avatar-layer]` 及其 React Fiber 状态中提取用户的专属虚拟形象高清静态图（WebP）与多状态 720p 循环视频（`default`、`working`、`resume`）及智能体名称（如 `Luna`），持久化缓存至 `userData/avatar_cache/` 并记录资产签名 `avatarSignature`。后台轮询与对话结束时自动比对主舞台 `avatarSignature`，一旦检测到用户在 `muse.ai` 更换服装或形象，立即触发强制重新提取并通过 `avatar:assets-updated` 与 `auth:status-changed` 实时热更新桌面宠物与终端头像。
- **双窗口同步呈现、透明人物抠图与三模全身/动态景别切换**：
  - 由于 `muse.ai` 的 `avatar.webp`（`1600 × 1600`）是从头到脚的完整全身立绘，而 `default.mp4`/`working.mp4`/`resume.mp4`（`720 × 720`）为腰部以上的半身循环视频，`PetWindow` 支持三种持久化展示模式（`smart` 智能联动：待机时展示完整全身立绘、思考/说话时自动切换半身动态视频；`full` 常驻全身立绘；`video` 常驻半身动态视频），可在桌宠头顶悬停胶囊或终端 `/settings` 面板一键切换。
  - `PetWindow` 采用 `400 × 400` 离屏长宽比自适应内缩留白（`CANVAS_PAD = 10`）与 30fps `<canvas>` 实时四边界连通域洪水填充（`min >= 242 && max - min <= 12` 紧缩白底阈值）加边缘反算去白边（Color Unmixing），将纯白摄影棚背景完全抠除为透明（`alpha = 0`）同时完整保留人物眼白、高光与浅色衣摆，头顶至鞋底零裁切悬浮展示；`ChatWindow` 同步对小尺寸圆形头像采用 `object-cover object-[50%_10%]` 面部聚焦对齐（支持点击放大预览 1600px 全身图），并在 `/settings` 中使用 `object-contain` 展示完整全身立绘。

### 4. 本地工具桥与电脑小秘书系统 (Local Secretary Agent Bridge)
- **前置意图协同与多模态桥接 (`src/main/local-secretary.ts`)**：
  - **主动日程提醒与每日简报 (`startScheduler`, `generateDailyBriefing`)**：将定时闹钟、今日待办、工作流与自定义界面插件持久化保存在 `userData/secretary_state.json`。后台每 3 秒巡检到期提醒，触发 Windows 原生通知（`Notification`）并通过 `onReminderFired` 驱动 `PetWindow` 进入 `talking` 姿态主动冒泡提醒；每日首次唤醒或执行 `/brief` 时汇总今日待办、未读 Gmail 与系统健康度交由 Luna 播报。
  - **自进化界面主题与功能插件引擎 (`MusePlugin` · `synthesizePluginFromRequest` / `extractPluginFromText`)**：支持用户通过自然语言或 `/plugin` 指令让 Luna 实时修改终端与桌宠的主题外观（CSS，如赛博朋克霓虹、黑客帝国 Matrix、樱花微醺、复古琥珀、桌宠霓虹星环）或挂载实用交互小组件（HTML + JS + 受限 `sdk`，如灵动小闹钟与倒计时挂件、终端随手便签贴）。修改支持主题互斥切换与挂件并存，通过 `secretary:state-updated` 与 `plugin:list-updated` 双窗口实时热注入，并在对话流内附带【插件热加载与一键回滚控制卡片】及 `/reset-ui` 一键恢复出厂界面防改坏保障。
  - **四大一键场景工作流宏 (`executeWorkflowMacro`)**：内置 `work`（工作模式）、`focus`（深度专注番茄钟）、`meeting`（会议准备模式）、`off`（收工复盘锁屏模式）四套工作流，支持通过终端 `/settings` 面板或直接用自然语言对 Luna 下令（如“把 https://notion.so 加到我的工作模式里”）动态修改启动网址与本地应用。
  - **浏览器与 Gmail 邮件助手**：将自然语言或 `/gmail` 指令自动转化为 Gmail 高级搜索语法（如 `is:unread`, `from:...`, `newer_than:7d`），一方面调用 `shell.openExternal` 在系统默认浏览器直接打开筛选页，另一方面通过共享 `persist:secretary_browser` 分区的受控窗口提取邮件列表（或网页正文），自动构造 `[MUSE_LOCAL_CONTEXT]` 注入给 Luna 汇总提炼（并在本地消息同步时自动剥离隐藏上下文标签）。
  - **桌面视觉感知 (`/screen`)**：使用 Electron `desktopCapturer` 截取当前主屏幕 1080p 画面。截屏瞬间自动对当前可见的本应用窗口（`ChatWindow` 终端与 `PetWindow` 桌宠）开启 `setContentProtection(true)`（Windows DWM `WDA_EXCLUDEFROMCAPTURE`），在不闪烁、不隐藏窗口且不丢失输入焦点的前提下将终端与桌宠从截屏画面中完全剔除，仅截取干净的底层桌面内容；随后一方面在终端内联回显截图，另一方面通过 `DataTransfer` + React `__reactProps.onChange` 注入隐藏 `museWindow` 的 `<input type="file">`，赋予 Luna 原生多模态看屏能力。
  - **文件、剪贴板与系统状态管家 (`/sys`, `/clip`, `/find`, `/read`)**：提供系统硬件与高占用进程实时快照、剪贴板读写以及桌面/下载/文档目录的快速检索与读取。
- **终端分级授权控制（只读与打开免审，写操作必审）**：
  - 只读感知与打开网页/邮件操作免确认直达；
  - 涉及自定义 PowerShell 执行（`/ps`）、修改文件或结束进程等具有副作用的操作，统一创建 `PendingSecretaryAction` 并在终端消息流中渲染 **终端授权确认卡（Allow / Deny）**（同时支持对任意代码块点击“本地执行”），仅在用户手动批准后才通过 `powershell.exe -NoProfile -NonInteractive` 执行并回显 `stdout/stderr`。

### 5. 代码结构与工程划分
- `src/main/`：主进程代码（`index.ts`, `window-manager.ts`, `muse-client.ts`, `local-secretary.ts`, `session-store.ts`, `ipc-handlers.ts`, `tray.ts`）。
- `src/preload/`：安全 Preload 脚本（`pet.ts`, `chat.ts`），通过 `contextBridge.exposeInMainWorld` 暴露受限且类型完备的 API。
- `src/renderer/`：React 18 + Vite + Tailwind CSS 多页工程（`pet/` 入口与 `chat/` 入口，共享 `components/` 与 `types/`）。

## Invariants

1. **零直接 Node 权限**：所有渲染进程强制配置 `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`。
2. **凭据安全**：禁止向任何渲染进程暴露原始 Session Token 与 Cookie 明文，前端仅获得登录态布尔值与用户基础 Profile（头像 URL、用户名）。
3. **单例应用约束**：采用 `app.requestSingleInstanceLock()` 保证全局仅运行一个客户端实例，重复启动时聚焦现有宠物窗口。
4. **低能耗常驻**：待机无用户交互时，宠物窗口渲染刷新率自动降频，禁止后台死循环轮询。

## Out of scope

- 暂不引入跨平台原生 C++ 扩展，优先依赖 Electron 纯标准 API 保持轻量与易维护。
- 暂不实现离线本地大模型推理，所有智能生成均由 Meta Muse 云端负责。

