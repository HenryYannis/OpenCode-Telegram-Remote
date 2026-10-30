# ⚡️ opencode-telegram-remote

**A Telegram remote control for [OpenCode](https://opencode.ai) — chat with any window from your phone, and get desktop replies pushed back in real time.**

> 把手机变成 OpenCode 的遥控器：无缝接管电脑窗口、双向实时同步、手机上切换模型和会话。

[中文说明见下方](#-中文说明)

---

## Why this plugin?

Other Telegram integrations for OpenCode are either **standalone bridge processes** or **plugins built for the V1 API that no longer load on OpenCode V2**. This plugin is a **native OpenCode V2 plugin** (`Plugin.define` + plugin context APIs) and adds the one thing nobody else has: **true bidirectional sync between the desktop window and your phone.**

| Capability | This plugin | Typical bridge |
| :--- | :--- | :--- |
| Install as an OpenCode plugin (no extra process) | ✅ | ❌ separate Node process |
| Chat from phone → executed in OpenCode | ✅ | ✅ |
| **Desktop replies auto-pushed to phone** | ✅ real-time via event stream | mostly ❌ |
| `/current` — attach phone to the desktop's *current* window | ✅ | ❌ |
| Switch AI models from phone (`/model` + buttons) | ✅ | varies |
| Switch / create sessions from phone | ✅ | varies |
| Lifecycle bound to OpenCode itself | ✅ | ❌ |

## Install

Requires **OpenCode V2** (2.2+). In `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-telegram-remote"]
}
```

or install from Git:

```sh
opencode plugin add github:<you>/opencode-telegram-remote
```

## Configure

Create `~/.config/opencode/telegram.json`:

```json
{
  "token": "<your-bot-token-from-BotFather>",
  "allowedUsers": [<your-numeric-telegram-user-id>]
}
```

- Get the token from [@BotFather](https://t.me/BotFather) (`/newbot`).
- Get your user ID from [@userinfobot](https://t.me/userinfobot).
- ⚠️ **Keep `allowedUsers` filled** — anyone not in the list is rejected. You are handing out shell-level access to your machine.

## Commands

| Command | Action |
| :--- | :--- |
| *(plain text)* | Send a prompt to the bound session |
| `/current` | Attach to the desktop's current active window |
| `/model` | List models (tappable buttons); `/model <keyword>` fuzzy-switch |
| `/sessions` | List recent sessions, switch with inline buttons |
| `/new` | Create a new session |
| `/abort` | Interrupt the running task |
| `/status` | Show bound session & working directory |
| `/start` | Help |

## How the desktop→phone sync works

The plugin subscribes to OpenCode's server event stream via `ctx.event.subscribe`:

```
Desktop reply finished
   ↓ OpenCode broadcasts
session.text.ended (sessionID + assistantMessageID)
   ↓ plugin looks up chats bound to that session
fetches the final message text → splits to ≤4096 chars
   ↓
bot.api.sendMessage → your phone
```

A dedupe registry (`sentMessageIds`) guarantees the same assistant message is never delivered twice across the two delivery paths (event push + fallback fetch after `wait()`).

## Notes & limits

- Text only (no photos/voice yet — PRs welcome).
- One bot per machine (singleton lock); multi-location OpenCode loads are de-duplicated automatically.
- The plugin follows your `opencode.json` providers for `/model`; if parsing config fails it falls back to `ctx.model.list()`.

## License

MIT © 2026 HenryYannis

---

## 🇨🇳 中文说明

**把手机变成 OpenCode 的遥控器。**

- 手机发消息 → 电脑上的 OpenCode 执行 → 回复发回手机；
- **电脑窗口里的回复，实时自动推送到手机**（订阅 `session.text.ended` 事件流，带去重）；
- `/current` 一键把手机接入电脑当前正在聊的窗口，两边无缝交替；
- `/model` 在手机上点按钮切换模型；`/sessions` 切换会话;`/new`、`/abort`、`/status` 齐全；
- 纯插件形态：跑在 OpenCode 进程内，随 OpenCode 启停，**不需要任何独立常驻进程**。

安装：在 `~/.config/opencode/opencode.json` 里加 `"plugins": ["opencode-telegram-remote"]`，再创建 `~/.config/opencode/telegram.json` 填入 BotFather 的 token 和你的数字 user ID 白名单即可。
