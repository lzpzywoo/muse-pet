<div align="center">

# ✨ Muse Pet

**专为 [Meta Muse (`muse.ai`)](https://muse.ai) 打造的透明桌面 AI 伴侣、液态玻璃快捷终端与本地电脑小秘书**

[![Latest Release](https://img.shields.io/github/v/release/lzpzywoo/muse-pet?style=flat-square&color=38bdf8&label=Release)](https://github.com/lzpzywoo/muse-pet/releases)
[![Electron](https://img.shields.io/badge/Electron-33.2-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-0f172a?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](./LICENSE)

[**English Documentation (README.md)**](./README.md) · [**简体中文**](./README_CN.md) · [**下载 Release 安装包**](https://github.com/lzpzywoo/muse-pet/releases)

</div>

---

## 📖 项目简介

**Muse Pet** 将你在 [`muse.ai`](https://muse.ai) 上创建的专属 AI 角色（如 `Luna`）从浏览器标签页中解放出来，化身为常驻桌面的 **多状态 720p 透明动态立绘桌宠**，并结合了 **Apple Liquid Glass（液态玻璃）风格的 Spotlight 快捷终端（`Alt + Space`）**、**Level-2 本地电脑小秘书（纯净屏幕视觉、Gmail/网页读取、本地文件检索、PowerShell 终端授权执行）** 以及 **自进化界面主题与动态小挂件引擎**。

---

## ✨ 核心功能

### 1. 🎭 原生 Meta Muse 动态立绘提取与像素级穿透
- **多状态 720p 循环视频同步**：自动从已登录的 `muse.ai` 会话中提取角色 `default`（待机呼吸）、`working`（思考）、`resume`（说话）三套 720p MP4 视频与 1600px 高清 WebP 立绘，并持久化缓存在 `userData/avatar_cache/`。
- **30 FPS 实时纯白影棚背景抠图**：在 `<canvas>` 上运行四边界种子 BFS 漫水填充 + 1~2px 边缘色彩反混合（Color Unmixing）算法，实时剥离白色影棚背景与圆形底盘，同时完整保留眼白、牙齿与高光细节。
- **像素级 Alpha 鼠标穿透（绝不遮挡周围点击）**：复用实时抠图掩码（`bgMaskRef`）配合 `setIgnoreMouseEvents(true, { forward: true })`，仅当鼠标悬停在 **人物不透明像素轮廓**、**活动冒泡气泡** 或 **小挂件** 上时才捕获鼠标（支持按住人物轮廓拖动位置或单击呼出终端），周围透明区域 100% 穿透到底层桌面窗口。
- **换装实时热重载**：当你在 `muse.ai` 网页端更换角色的穿搭或发型后，桌面宠物自动检测 `blob:` 签名变化并热更新立绘与视频。

### 2. 🖥️ Spotlight 液态玻璃快捷终端 (`Alt + Space`)
- **全局快捷键一键呼出**：在任意软件中按下 `Alt + Space` 或点击桌面宠物，即可在主屏幕中上方黄金视觉位（水平居中、距顶约 16%）呼出终端；按 `Esc` 键一键收起。
- **8 方向鼠标自由拖拽缩放**：支持拖拽终端窗口四条边、四个圆角或右下角斜纹手柄自由调节宽高（或双击标题栏 / 点击左上角绿灯 `+` 一键放大与还原），窗口尺寸与位置自动记忆在 `userData/chat_bounds.json`。
- **曜石纯黑与液态玻璃自由切换**：默认采用 **100% 不透明曜石纯黑（Obsidian Solid）** 基底防止桌面文字透出干扰阅读，支持 `92%` 深邃碳黑、`72%` 液态玻璃预设及 `45% ~ 100%` 连续不透明度滑块。
- **富媒体与云端双向同步**：自动提取并缓存聊天内图片（`<img>`）与视频（`<video>`），支持终端内联渲染与 Lightbox 大图缩放预览；桌宠头顶实时显示思考、流式输出与新回复冒泡气泡及未读角标。

### 3. 🤖 Level-2 本地电脑小秘书与安全授权控制
- **无闪烁纯净屏幕视觉 (`/screen`)**：截屏瞬间通过系统 DWM `setContentProtection(true)` 自动排除桌宠与终端自身窗口（无闪烁、不隐藏窗口、不丢输入焦点），将干净的 1080p 桌面画面上传给 Luna 进行报错诊断、界面分析与视觉问答。
- **Gmail 邮件与网页助手 (`/gmail`, `/web`)**：内置独立持久化浏览器分区（`persist:secretary_browser`），支持打开并提取未读/重要邮件列表或任意网页正文交由 Luna 归纳总结。
- **本地文件检索与系统遥测 (`/find`, `/read`, `/clip`, `/sys`)**：自然语言搜索并读取本地代码/文档、分析剪贴板内容、实时查询 CPU/内存/磁盘/电池与高占用进程。
- **Human-in-the-Loop PowerShell 授权卡 (`/ps`)**：任何涉及修改系统状态或执行 PowerShell 脚本的操作，均在终端内生成 **[批准执行 Allow / 拒绝 Deny]** 交互式授权卡片，未经用户点击批准绝不后台静默执行。

### 4. ⏰ 主动早间简报与四大一键工作流宏
- **每日早间主动简报 (`/brief`)**：每日首次启动自动汇总系统健康度、今日待办与提醒事项，通过桌宠语音气泡主动问候。
- **自然语言日程提醒与待办 (`/remind`, `/todo`)**：支持倒计时或 `HH:MM` 定点闹钟（如 `/remind 15m 喝水休息` 或直接说 *“10分钟后提醒我开会”*），到点触发系统通知 + 桌宠冒泡提醒。
- **四大场景工作流宏**：
  - `🚀 /work`（上班模式）：一键打开配置的工作网站（Gmail、GitHub 等）与本地软件，并播报今日简报。
  - `🎧 /focus`（专注番茄钟）：开启 25 分钟番茄钟倒计时并自动收起终端进入免打扰状态。
  - `📅 /meeting`（会议准备）：汇总剪贴板/日程要点，并提供一键系统静音授权卡。
  - `🌙 /off`（下班总结）：盘点今日已完成待办，并提供一键锁屏（`LockWorkStation`）授权卡。

### 5. 🧩 自进化界面主题与动态小挂件引擎 (`/plugin`)
- **自然语言改界面 / 装挂件**：直接对 Luna 说 *“帮我加个小闹钟挂件”*、*“切换赛博朋克霓虹主题”*、*“加个随手便签”* 或 *“给桌宠加个呼吸光环”*，即可在终端与桌宠双窗口实时热加载生效。
- **内联控制卡与安全回滚**：每次界面或挂件改动都会生成 **[⚡ 已热加载生效 · 插件控制卡]**，支持随时一键停用、卸载回滚，或输入 `/reset-ui` 恢复默认外观。

---

## ⌨️ 终端指令速查表

| 指令 | 分类 | 功能说明 |
| :--- | :--- | :--- |
| `/brief` | 主动简报 | 生成今日桌面简报（CPU/内存/电量 + 待办事项 + 提醒列表） |
| `/work` | 工作流宏 | 一键开启上班模式（打开预设网站与本地应用 + 播报早间简报） |
| `/focus [分钟]` | 工作流宏 | 开启番茄专注倒计时（默认 25 分钟）并自动收起终端 |
| `/meeting` | 工作流宏 | 整理会议准备要点，并生成系统静音审批卡 |
| `/off` | 工作流宏 | 总结今日待办完成情况，并生成一键锁屏审批卡 |
| `/remind <时间> <内容>` | 日程提醒 | 设置倒计时或定点提醒（例如 `/remind 10m 休息喝水`） |
| `/todo [add\|done\|clear]` | 待办清单 | 查看、添加、完成或清空持久化待办清单 |
| `/plugin <需求描述>` | 自进化 UI | 用自然语言生成并热加载自定义主题或交互式小挂件 |
| `/plugins` | 自进化 UI | 打开 `/settings` 中的已安装主题与小挂件管理面板 |
| `/reset-ui` | 自进化 UI | 一键停用所有自定义主题与挂件，恢复默认液态玻璃外观 |
| `/screen [问题]` | 电脑秘书 | 截取纯净桌面画面（自动隐身桌宠与终端）交由 Luna 视觉分析 |
| `/gmail [过滤词]` | 电脑秘书 | 在持久化秘书浏览器中打开并提取 Gmail 邮件摘要 |
| `/web <网址>` | 电脑秘书 | 打开指定网页并提取正文内容交由 Luna 总结 |
| `/find <关键词>` | 电脑秘书 | 在桌面、文档、下载或工作区检索本地文件 |
| `/read <文件路径>` | 电脑秘书 | 读取本地文本或代码文件并发送给 Luna 分析 |
| `/clip [问题]` | 电脑秘书 | 读取当前系统剪贴板文本并进行翻译、润色或解答 |
| `/sys` | 电脑秘书 | 获取实时系统遥测（CPU、内存、磁盘、电池与 Top 进程） |
| `/ps <脚本>` | 电脑秘书 | 生成 `[批准执行 Allow / 拒绝 Deny]` 终端授权卡以执行 PowerShell |
| `/theme` / `/solid` / `/glass` | 外观材质 | 在曜石纯黑（`100%`）、深邃碳黑（`92%`）与液态玻璃（`72%`）间切换 |
| `/sync` | 云端同步 | 强制同步 `muse.ai` 云端历史消息、富媒体与最新角色立绘 |
| `/settings` | 系统设置 | 打开或关闭可视化设置抽屉（透明度、代理、工作流、插件管理） |
| `/clear` / `/exit` | 终端控制 | 清空终端屏幕或收起隐藏终端窗口（`Esc`） |

---

## 🚀 快速开始

### 方式一：直接下载 Release 免安装版
前往 [**GitHub Releases**](https://github.com/lzpzywoo/muse-pet/releases) 页面下载最新版本的压缩包，解压后直接运行 `Muse Pet.exe` 即可。

### 方式二：从源码构建运行

```bash
# 1. 克隆仓库
git clone https://github.com/lzpzywoo/muse-pet.git
cd muse-pet

# 2. 安装依赖
npm install

# 3. 启动开发模式 (Vite HMR + Electron)
npm run dev

# 4. 生产环境编译与打包
npm run build
npm run dist
```

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。Copyright © 2026 [remy (lzpzywoo)](https://github.com/lzpzywoo)。
