# 🧩 Muse Pet Plugin Development Guide

> Learn how to develop **Self-Modifying UI & Widget Plugins** to customize the appearance of `ChatWindow` and `PetWindow`, mount interactive desktop widgets, and build extensible workflows.

---

## Table of Contents
1. [Plugin Paradigms in Muse Pet](#-plugin-paradigms-in-muse-pet)
2. [UI & Widget Plugin Architecture (`MusePlugin`)](#-ui--widget-plugin-architecture)
3. [The Sandboxed `sdk` Runtime](#-the-sandboxed-sdk-runtime)
4. [Authoring Methods](#-authoring-methods)
   - [Method 1: Conversational Prompting with Luna](#method-1-conversational-prompting-with-luna)
   - [Method 2: Manual Authoring via Code Block](#method-2-manual-authoring-via-code-block)
5. [Complete Examples](#-complete-examples)
   - [Example 1: Interactive Mini Countdown / Pomodoro Widget](#example-1-interactive-mini-countdown--pomodoro-widget)
   - [Example 2: Cyberpunk Neon Glass Theme](#example-2-cyberpunk-neon-glass-theme)
   - [Example 3: Pet Aura / Floating Particle Halo](#example-3-pet-aura--floating-particle-halo)
6. [Best Practices, Safety & Rollback](#-best-practices-safety--rollback)

---

## 🎯 Plugin Paradigms in Muse Pet

Muse Pet features two distinct extension systems tailored for different needs:

| Plugin Type | Purpose | Primary Location | Language / Tech |
|---|---|---|---|
| **UI & Widget Plugins** (`MusePlugin`) | Reshaping the terminal appearance, adding floating desktop timers, memo notes, sound meters, and pet visual effects | Injected into `ChatWindow` & `PetWindow` DOM | CSS, HTML5, JavaScript (`sdk`) |
| **Local Agent Hub Integrations** | Connecting external local tools (downloaders, compilers, game engines, scripts) to Luna's tool discovery | Local HTTP/WS (`127.0.0.1:19840`) | Any language (Python, Node, Go, Rust). See [Local Agent Hub Guide](./LOCAL_AGENT_HUB.md) |

This guide focuses on **UI & Widget Plugins (`MusePlugin`)**.

---

## 🏗️ UI & Widget Plugin Architecture

A `MusePlugin` is a declarative, hot-reloadable bundle containing scoped styling and interactive components that get mounted dynamically across both application windows:

```typescript
interface MusePlugin {
  id: string              // Unique identifier (e.g., "plg-widget-pomodoro")
  name: string            // Friendly display title
  description: string     // Purpose and user-facing explanation
  type: 'theme' | 'widget'// "theme" replaces active color/glass styling; "widget" mounts side-by-side
  chatCss?: string        // Injected into ChatWindow <style> tag
  petCss?: string         // Injected into PetWindow <style> tag
  chatHtml?: string       // HTML mounted inside ChatWindow dock (#muse-plugin-dock)
  chatJs?: string         // JS executed inside ChatWindow sandbox
  petHtml?: string        // HTML mounted inside PetWindow widget container
  petJs?: string          // JS executed inside PetWindow sandbox
  enabled: boolean        // Live toggle state
  createdAt: number       // Epoch timestamp
}
```

### Window Mounting Target Locations
- **`ChatWindow`**: HTML elements in `chatHtml` are mounted into the top widget dock (`#muse-plugin-dock`) right beneath the titlebar and above the message list.
- **`PetWindow`**: HTML elements in `petHtml` are mounted inside the floating pet viewport, positioned safely around the transparent character avatar.
- **Theme Mutual Exclusion**: Themes (`type: "theme"`) are mutually exclusive. Activating a new theme automatically deactivates any existing theme, preventing CSS conflicts.

---

## 🧰 The Sandboxed `sdk` Runtime

When `chatJs` or `petJs` runs, the host injects a clean, sandboxed `sdk` object directly into your script's execution scope. Widgets do not have access to Node.js `process` or Electron APIs, ensuring safe execution.

### Available `sdk` Methods

#### 1. `sdk.storage` — Cross-Session Persistence
Persists key-value state across app restarts under the plugin's namespace:
```javascript
// Save state
sdk.storage.set('focus_count', '5');

// Retrieve state (always returns string or empty string)
const count = Number(sdk.storage.get('focus_count') || 0);
```

#### 2. `sdk.notify(title, body)` — Desktop Notification
Sends a non-intrusive notification:
```javascript
sdk.notify('⏰ 番茄钟结束', '休息 5 分钟，起来活动喝水吧！');
```

#### 3. `sdk.playBeep()` — Audio Feedback
Generates a pleasant 880Hz acoustic sine-wave chime using the Web Audio API without needing external `.mp3` files:
```javascript
sdk.playBeep();
```

#### 4. `sdk.addReminder(minutes, label)` — Speech Bubble Reminder
Schedules a local timer that automatically triggers a speech bubble above your desktop Pet when due:
```javascript
sdk.addReminder(25, '番茄专注完成！');
```

#### 5. `sdk.sendCommand(commandText)` — Terminal Dispatcher
Sends a text command into the terminal prompt on behalf of the user:
```javascript
// Automatically run system inspection
sdk.sendCommand('/sys');
```

#### 6. `container` — Root DOM Element
Reference to your widget's container element in the dock:
```javascript
const btn = container.querySelector('#start-btn');
btn.addEventListener('click', () => { ... });
```

---

## ✍️ Authoring Methods

### Method 1: Conversational Prompting with Luna

The easiest way to build a plugin is to simply tell Luna what you want in plain language:

- *"把终端换成樱花微醺粉色主题，给桌宠加上樱花花瓣流光"*
- *"在终端上方挂载一个小闹钟，支持点选 5 分钟、15 分钟倒计时"*
- *"加一个随手便利贴，能记住我输入的内容，重启不丢失"*

Luna will automatically synthesize a complete ````muse-plugin` JSON structure and send it in chat. An inline **Plugin Installation Card** will appear in the conversation with one-click **[启用 / 停用]** and **[卸载并回滚]** buttons.

---

### Method 2: Manual Authoring via Code Block

You can also paste a raw ````muse-plugin` code block directly into the chat prompt. The terminal will immediately recognize and hot-mount it.

Format:
````markdown
```muse-plugin
{
  "id": "plg-my-widget",
  "name": "我的自定义挂件",
  "type": "widget",
  "description": "挂件功能说明",
  "chatHtml": "<div class=\"my-widget\">Hello World</div>",
  "chatCss": ".my-widget { padding: 4px; color: #38bdf8; }",
  "chatJs": "console.log('Widget mounted!');"
}
```
````

---

## 💡 Complete Examples

### Example 1: Interactive Mini Countdown / Pomodoro Widget

This widget mounts a compact countdown timer into `ChatWindow` with preset minute buttons, remaining time badge, and sound chime on completion:

```json
{
  "id": "plg-widget-mini-alarm",
  "name": "⏰ 灵动小闹钟与倒计时挂件",
  "type": "widget",
  "description": "在终端顶部挂载实时时钟与交互式倒计时（支持快捷倒计时、响铃与桌宠冒泡提醒）",
  "chatCss": "\n    .muse-alarm-widget {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      padding: 6px 12px;\n      background: rgba(14, 165, 233, 0.08);\n      border-bottom: 1px solid rgba(56, 189, 248, 0.25);\n      font-family: var(--font-terminal, monospace);\n      font-size: 11.5px;\n      color: #bae6fd;\n    }\n    .muse-alarm-controls {\n      display: flex;\n      align-items: center;\n      gap: 6px;\n    }\n    .muse-alarm-btn {\n      padding: 2px 7px;\n      border-radius: 5px;\n      background: rgba(255, 255, 255, 0.08);\n      border: 1px solid rgba(255, 255, 255, 0.15);\n      color: #e0f2fe;\n      cursor: pointer;\n      font-size: 10.5px;\n    }\n    .muse-alarm-btn:hover {\n      background: rgba(56, 189, 248, 0.25);\n      border-color: #38bdf8;\n    }\n  ",
  "chatHtml": "\n    <div class=\"muse-alarm-widget\">\n      <div>⏰ 专注倒计时</div>\n      <div class=\"muse-alarm-controls\">\n        <button class=\"muse-alarm-btn\" data-mins=\"5\">5m</button>\n        <button class=\"muse-alarm-btn\" data-mins=\"15\">15m</button>\n        <button class=\"muse-alarm-btn\" data-mins=\"25\">25m</button>\n        <span id=\"cd-display\" style=\"color:#fde047;margin-left:6px;\">未定时</span>\n      </div>\n    </div>\n  ",
  "chatJs": "\n    const display = container.querySelector('#cd-display');\n    let timer = null;\n    container.querySelectorAll('.muse-alarm-btn').forEach(btn => {\n      btn.addEventListener('click', () => {\n        const mins = Number(btn.dataset.mins);\n        let remaining = mins * 60;\n        clearInterval(timer);\n        display.textContent = mins + ' 分钟倒计时中...';\n        timer = setInterval(() => {\n          remaining--;\n          const m = Math.floor(remaining / 60);\n          const s = remaining % 60;\n          display.textContent = m + ':' + (s < 10 ? '0' : '') + s;\n          if (remaining <= 0) {\n            clearInterval(timer);\n            display.textContent = '时间到啦！';\n            sdk.playBeep();\n            sdk.notify('⏰ 倒计时结束', mins + ' 分钟时间到了，起来活动一下吧！');\n          }\n        }, 1000);\n      });\n    });\n  "
}
```

---

### Example 2: Cyberpunk Neon Glass Theme

This theme restyles both the `ChatWindow` terminal and the desktop `PetWindow` into a glowing cyan-and-magenta synthwave aesthetic:

```json
{
  "id": "plg-theme-cyberpunk",
  "name": "⚡ 赛博朋克霓虹电光主题",
  "type": "theme",
  "description": "赛博电光青与霓虹紫双色流光边框、深空蓝紫基底与桌宠能量光晕",
  "chatCss": "\n    .liquid-glass-shell {\n      background: linear-gradient(135deg, rgba(13, 10, 28, 0.96) 0%, rgba(20, 10, 35, 0.98) 100%) !important;\n      border: 1px solid rgba(236, 72, 153, 0.45) !important;\n      box-shadow: 0 0 25px rgba(236, 72, 153, 0.25), 0 0 50px rgba(6, 182, 212, 0.2) !important;\n    }\n    .font-terminal {\n      color: #67e8f9 !important;\n      text-shadow: 0 0 8px rgba(6, 182, 212, 0.6) !important;\n    }\n    .liquid-glass-pill {\n      border-color: rgba(236, 72, 153, 0.4) !important;\n      color: #f472b6 !important;\n    }\n  ",
  "petCss": "\n    .pet-canvas-container {\n      filter: drop-shadow(0 0 16px rgba(236, 72, 153, 0.65)) drop-shadow(0 0 30px rgba(6, 182, 212, 0.45)) !important;\n    }\n    .speech-bubble {\n      background: rgba(15, 10, 30, 0.95) !important;\n      border: 1px solid #ec4899 !important;\n      color: #67e8f9 !important;\n      box-shadow: 0 0 15px rgba(236, 72, 153, 0.4) !important;\n    }\n  "
}
```

---

### Example 3: Pet Aura / Floating Particle Halo

Adds an animated cosmic starlight halo around your desktop Pet that shifts intensity during thinking/streaming states:

```json
{
  "id": "plg-widget-pet-halo",
  "name": "✨ 桌宠霓虹星环与能量光晕",
  "type": "widget",
  "description": "在桌宠角色身后挂载旋转的星光光环与能量粒子环",
  "petCss": "\n    @keyframes spin-halo {\n      from { transform: translate(-50%, -50%) rotate(0deg); }\n      to { transform: translate(-50%, -50%) rotate(360deg); }\n    }\n    .pet-halo {\n      position: absolute;\n      top: 52%;\n      left: 50%;\n      width: 220px;\n      height: 220px;\n      border-radius: 50%;\n      border: 2px dashed rgba(56, 189, 248, 0.55);\n      box-shadow: 0 0 20px rgba(56, 189, 248, 0.35), inset 0 0 20px rgba(168, 85, 247, 0.3);\n      animation: spin-halo 12s linear infinite;\n      pointer-events: none;\n      z-index: 0;\n    }\n  ",
  "petHtml": "\n    <div class=\"pet-halo\"></div>\n  "
}
```

---

## 🛡️ Best Practices, Safety & Rollback

### 1. Pointer Events & Transparency
- If you author widgets in `PetWindow`, remember that transparent areas use **pixel-accurate alpha hit-testing**.
- Always add `pointer-events: none;` on decorative layers (like halos, auras, or particles) so they don't accidentally capture mouse clicks meant to pass through to your desktop.

### 2. Scoped CSS
- Use unique, descriptive class names (e.g. `.muse-myplugin-*`) or target existing theme variables (`--font-terminal`, `.liquid-glass-shell`).
- Never overwrite global reset properties like `* { margin: 0; }` which would distort other UI elements.

### 3. Immediate Rollback (`/reset-ui`)
- If a plugin's CSS accidentally breaks the layout or makes text unreadable:
  - Type `/reset-ui` in the terminal prompt.
  - Or press `Esc` to summon the terminal, click `/settings`, and click **[一键重置恢复默认]**.
  - All injected CSS, HTML, and JS cleanups are instantly unmounted, restoring pristine factory defaults.
