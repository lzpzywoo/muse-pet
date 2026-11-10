---
id: muse-pet-goal
type: goal-and-requirements
status: active
title: Muse Pet — Windows 桌面 AI 伴侣
---

# Muse Pet — Windows 桌面 AI 伴侣

> 将 Meta Muse 个人智能体化身为常驻 Windows 桌面的轻量动态伴侣，随时呼出对话与灵感协作。

## Overview

Muse Pet 是专为 Windows 用户打造的桌面 AI 虚拟伴侣客户端。它突破 Meta Muse（muse.ai）目前仅支持 Web 与 macOS 的平台限制，通过逆向对接 Web 端通信接口并在本地原生重构交互界面，以透明背景、无边框的动态悬浮宠物形态常驻 Windows 桌面。用户既可享受桌面挂件的萌宠微动作陪伴，又能在任何时候通过快捷键呼出对话面板，完成与 Muse 智能体的深度对话与任务协作。

## Problem

Meta 官方发布的个人 AI 智能体 Muse 仅覆盖了 iOS、macOS 以及浏览器 Web 端，尚未提供官方 Windows 客户端。对于 Windows 用户而言：
1. **使用流程割裂**：必须依赖浏览器标签页常驻，无法像 macOS 原生应用一样随时随地轻量呼出。
2. **缺乏桌面沉浸感与陪伴感**：Web 界面单调扁平，缺少生动的桌面角色化身与视觉互动反馈。
3. **交互链路长**：想要提问或协作时需要切换窗口、定位标签页，打断正常的工作心流。

## Capabilities

首个实用版本（MVP）及扩展能力涵盖以下核心特性：

- **桌面透明悬浮宠物**：无边框、背景完全透明的置顶小窗，自由拖拽移动；展示用户在 Meta Muse 中配置的官方专属 Avatar（支持闲置待机、思考中、说话中等动态状态切片/流、实时冒泡回复提醒以及换装实时热更新）。
- **全局快捷键与呼出面板**：支持自定义全局热键（如 `Alt + Space`），毫秒级呼出/隐藏现代 macOS Terminal 风格液态玻璃对话面板，焦点即刻进入输入框。
- **Meta Muse 逆向通信与会话保持**：本地重绘高颜值聊天流，后台逆向打通 muse.ai Web 端接口，支持文本流式传输、富媒体（图片/动作预览视频）接收与全屏预览、会话上下文延续与历史记录双向同步。
- **本地工具桥与电脑小秘书系统（Local Secretary Agent）**：
  - **Gmail 与网页助手**：支持按自然语言或 `/gmail`、`/web` 指令自动打开 Gmail 高级搜索筛选页与任意网页，并在受控浏览器中提取邮件列表或页面正文交由 Luna 提炼摘要与待办。
  - **桌面截屏与屏幕视觉感知**：支持一键截取当前桌面（`/screen`）上传给 Luna 进行多模态看图分析。
  - **本地文件、剪贴板与系统控制**：支持搜索/读取本地文件、读写剪贴板、查看电脑实时硬件/进程负载（`/sys`）以及执行本地 PowerShell 脚本。
  - **终端分级授权安全控制**：只读与打开操作免确认直达；执行脚本、修改文件或结束进程等写操作在终端内弹出 **`[批准执行 Allow / 拒绝 Deny]`** 授权卡片，用户批准后方可执行。
- **官方账号一键登录**：内置独立的官方登录窗口，用户完成 Meta 账号扫码/密码登录后，自动捕获 Session/Cookie 凭据安全保存在本地，免除频繁手动鉴权。
- **系统托盘与桌面状态控制**：系统托盘常驻图标，右键提供置顶切换、显示/隐藏宠物、重登账号、开机自启等实用设置。

## Tech Notes

- **框架选型**：Electron + React + TypeScript + Vite + Tailwind CSS。
- **多窗口架构设计**：
  - `Pet Window`（宠物挂件）：`transparent: true`, `frame: false`, `alwaysOnTop: true`，开启透明像素穿透与拖拽，专注展示 Meta Avatar 动效。
  - `Chat Window`（对话面板）：独立的卡片式浮窗，跟随宠物或屏幕居中弹出，负责流畅的 Markdown 流式对话渲染。
  - `Auth Window`（登录捕获窗）：仅在未登录或凭据过期时按需调起，基于 Electron `session.cookies` 自动拦截会话。
- **Meta Avatar 同步机制**：登录后读取 muse.ai 用户 Profile 与 Avatar 配置，将其前端组件对应的动态素材（动态 WebP/视频流/帧切片）接入 Pet Window 进行状态驱动渲染。
- **接口逆向与通信协议**：主进程内建 HTTP/WebSocket 转发客户端，统一注入 Meta 鉴权凭证与防检测 Headers，解决 Web 端跨域与接口变更维护问题。

## Alternatives Considered

- **Tauri v2 + Rust**：虽然内存占用和体积有显著优势，但在逆向 Webview 深度注入、Cookie/Session 自动嗅探与复杂多透明窗口状态同步上生态库成本较高，首发 MVP 选 Electron 最稳健。
- **官方网页直接包壳（纯 Webview 包装）**：直接显示 muse.ai 网页无法提供透明桌宠的灵动感与快捷键即时响应体验，违背了“Desktop Pet”的初衷。
- **V-Pet / Live2D 通用开源桌宠方案**：无法直接映射用户在 Meta Muse 中由 AI 实时生成与定制的专属 Avatar 形象。


## Non-Goals

- **暂不引入无确认的全自动 GUI 键鼠代操**：所有具有破坏或修改风险的本地系统操作均须经过终端分级授权确认，避免失控误操作。
- **暂不实现多宠物数值养成系统**：初版不引入饥饿度、喂食成长等重度游戏化机制，保持 AI 工具的高效与轻量。

