import { Plugin } from "@opencode/plugin";
import { Bot, InlineKeyboard } from "grammy";
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  asMessageList,
  asSessionList,
  createDeliveryTracker,
  createSessionBindings,
  escapeMd,
  normalizeModels,
  splitMessage,
  textEndedLockKey,
} from "./util.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const LOG_FILE = process.env.TELEGRAM_PLUGIN_DEBUG
  ? join(CONFIG_DIR, "telegram-plugin.log")
  : null;
const LOCK_FILE = join(CONFIG_DIR, "telegram-plugin.lock");

function debugLog(msg) {
  if (!LOG_FILE) return;
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function tryAcquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return false; // 另一个实例正在运行
        } catch {
          // 持锁进程已退出，可重新获取
        }
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function loadConfig() {
  const configPath = join(CONFIG_DIR, "telegram.json");
  try {
    const json = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = json.token;
    const users = Array.isArray(json.allowedUsers) ? json.allowedUsers.map(Number) : [];
    if (!token) throw new Error(`"token" is missing in ${configPath}`);
    if (users.length === 0) throw new Error(`"allowedUsers" must be a non-empty array in ${configPath}`);
    return { token, allowedUsers: users };
  } catch (err) {
    debugLog("Config load error: " + err.message);
    return null;
  }
}

export default Plugin.define({
  id: "telegram",
  async setup(ctx) {
    debugLog(`setup() for directory: ${ctx.location.directory}`);

    // OpenCode 会为每个 location 实例化插件；用文件锁保证全局只跑一个 Bot。
    // 不再硬编码仅 home —— CLI 只开项目目录时也能启动。
    if (!tryAcquireLock()) {
      debugLog(`Skipping bot start (lock held) for: ${ctx.location.directory}`);
      return () => {};
    }

    const config = loadConfig();
    if (!config) {
      releaseLock();
      debugLog("Skipped: telegram.json is missing or invalid.");
      return () => {};
    }

    const { token, allowedUsers } = config;
    const bot = new Bot(token);
    const allowed = new Set(allowedUsers);
    const { bindChat, chatsForSession, sessionForChat } = createSessionBindings();
    const delivery = createDeliveryTracker();
    const pendingPermissions = new Map(); // shortKey -> { sessionID, requestID }
    let lastViewedSessionID = null;
    let permSeq = 0;

    function extractAssistantText(msg) {
      if (!msg) return "";
      if (typeof msg.text === "string" && msg.text) return msg.text;
      if (Array.isArray(msg.content)) {
        return msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      }
      return "";
    }

    /** 统一投递：事件路径与 wait 兜底共用 pending/delivered，避免双发。 */
    async function deliverText(chats, text, lockKey, { messageID } = {}) {
      if (!chats.length || !text || !lockKey) return 0;
      if (messageID && delivery.messagesWithPushedText.has(messageID) && lockKey.startsWith("msg:")) {
        return 0;
      }
      if (!delivery.tryBegin(lockKey)) return 0;

      try {
        if (delivery.deliveredKeys.has(lockKey)) return 0;

        let pushed = 0;
        for (const chatId of chats) {
          for (const chunk of splitMessage(text)) {
            await bot.api.sendMessage(chatId, chunk).catch((e) => debugLog("push error: " + e.message));
          }
          pushed++;
        }

        delivery.markDelivered(lockKey, messageID);
        return pushed;
      } finally {
        delivery.end(lockKey);
      }
    }

    async function listRecentSessions({ limit = 10, directory } = {}) {
      const input = { limit, order: "desc" };
      if (directory) input.directory = directory;
      const list = await ctx.session.list(input);
      return asSessionList(list);
    }

    async function resolveCurrentSession() {
      if (lastViewedSessionID) {
        try {
          const s = await ctx.session.get({ sessionID: lastViewedSessionID });
          if (s) return s;
        } catch (e) {
          debugLog("get last viewed session error: " + e.message);
        }
      }

      // 不限 directory：跨项目取最近更新的会话（更接近「当前窗口」）
      try {
        const items = await listRecentSessions({ limit: 1 });
        if (items[0]) return items[0];
      } catch (e) {
        debugLog("list recent sessions error: " + e.message);
      }

      try {
        const items = await listRecentSessions({
          limit: 1,
          directory: ctx.location.directory,
        });
        if (items[0]) return items[0];
      } catch (e) {
        debugLog("list location sessions error: " + e.message);
      }

      return null;
    }

    async function getActiveSession(chatId) {
      let sessionID = sessionForChat(chatId);
      if (sessionID) {
        try {
          const s = await ctx.session.get({ sessionID });
          if (s) return sessionID;
        } catch {}
      }

      const current = await resolveCurrentSession();
      if (current?.id) {
        bindChat(chatId, current.id);
        return current.id;
      }

      const created = await ctx.session.create({
        title: "Telegram remote session",
        location: { directory: ctx.location.directory },
      });
      sessionID = created.id;
      bindChat(chatId, sessionID);
      return sessionID;
    }

    // ---- 鉴权中间件：仅白名单用户可用 ----
    bot.use(async (tgCtx, next) => {
      const userId = tgCtx.from?.id;
      if (!userId || (allowed.size > 0 && !allowed.has(userId))) {
        await tgCtx.reply("⛔️ Unauthorized. This OpenCode instance is private.");
        return;
      }
      await next();
    });

    bot.command("start", async (tgCtx) => {
      const text =
        "👋 Hi! This is your OpenCode remote control.\n\n" +
        "📌 Commands:\n" +
        "• (text) — send a prompt to the bound session\n" +
        "• /current — attach to the desktop's current window\n" +
        "• /model — list & switch the session model\n" +
        "• /sessions — list & switch sessions\n" +
        "• /new — create a new session\n" +
        "• /status — show bound session & directory\n" +
        "• /abort — stop the running task";
      await tgCtx.reply(text);
    });

    bot.command("status", async (tgCtx) => {
      const sessionID = sessionForChat(tgCtx.chat.id) || "(none yet)";
      await tgCtx.reply(
        `🖥 *OpenCode status*\n` +
          `• Directory: \`${escapeMd(ctx.location.directory)}\`\n` +
          `• Bound session: \`${escapeMd(sessionID)}\`\n` +
          `• Last viewed: \`${escapeMd(lastViewedSessionID || "(none)")}\`\n` +
          `• Plugin state: running`,
        { parse_mode: "Markdown" }
      );
    });

    bot.command("new", async (tgCtx) => {
      try {
        const created = await ctx.session.create({
          title: "Telegram remote session",
          location: { directory: ctx.location.directory },
        });
        bindChat(tgCtx.chat.id, created.id);
        await tgCtx.reply(`✨ New session created: \`${escapeMd(created.id)}\``, {
          parse_mode: "Markdown",
        });
      } catch (err) {
        await tgCtx.reply(`❌ Failed to create session: ${err.message}`);
      }
    });

    bot.command("current", async (tgCtx) => {
      try {
        const current = await resolveCurrentSession();
        if (!current) {
          return tgCtx.reply("No sessions found.");
        }
        bindChat(tgCtx.chat.id, current.id);
        const title = current.title || "untitled";
        const directory = current.location?.directory || ctx.location.directory;
        await tgCtx.reply(
          `🔗 *Attached to the desktop's current window!*\n` +
            `• Title: *${escapeMd(title)}*\n` +
            `• ID: \`${escapeMd(current.id)}\`\n` +
            `• Directory: \`${escapeMd(directory)}\`\n\n` +
            `Anything you type now continues in that window — and desktop replies are pushed back here.`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        await tgCtx.reply(`❌ Failed to get the current session: ${err.message}`);
      }
    });

    let cachedModelList = [];

    async function getAvailableModels() {
      try {
        const models = normalizeModels(await ctx.model.list());
        if (models.length > 0) return models;
      } catch (e) {
        debugLog("ctx.model.list error: " + e.message);
      }

      // 回退：从 opencode.json 的 providers.models 覆盖项读取
      try {
        const raw = readFileSync(join(CONFIG_DIR, "opencode.json"), "utf-8");
        const cfg = JSON.parse(raw);
        const models = [];
        for (const [providerID, pData] of Object.entries(cfg.providers || {})) {
          for (const mID of Object.keys(pData.models || {})) {
            models.push({ providerID, id: mID, name: mID });
          }
        }
        if (models.length > 0) return models;
      } catch (e) {
        debugLog("Load models from config error: " + e.message);
      }
      return [];
    }

    bot.command("model", async (tgCtx) => {
      const sessionID = await getActiveSession(tgCtx.chat.id);
      const arg = tgCtx.match?.trim().toLowerCase();

      const models = await getAvailableModels();
      if (models.length === 0) {
        return tgCtx.reply("No models available.");
      }
      cachedModelList = models;

      if (arg) {
        const matched = models.find((m) => m.id.toLowerCase().includes(arg));
        if (!matched) {
          return tgCtx.reply(`❌ No model matches "${arg}". Send /model to see the full list.`);
        }
        try {
          await ctx.session.switchModel({
            sessionID,
            model: { providerID: matched.providerID, id: matched.id },
          });
          return tgCtx.reply(`✅ Model switched to: \`${escapeMd(matched.id)}\``, {
            parse_mode: "Markdown",
          });
        } catch (err) {
          return tgCtx.reply(`❌ Failed to switch model: ${err.message}`);
        }
      }

      const keyboard = new InlineKeyboard();
      let text = "🤖 *Choose a model:*\n\n";
      models.forEach((m, idx) => {
        const shortName = (m.id.split("/").pop() || m.id).slice(0, 64);
        text += `${idx + 1}. \`${escapeMd(m.id)}\`\n`;
        keyboard.text(shortName, `m:${idx}`);
        if ((idx + 1) % 2 === 0) keyboard.row();
      });
      await tgCtx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    });

    bot.command("sessions", async (tgCtx) => {
      try {
        let items = await listRecentSessions({ limit: 10 });
        if (items.length === 0) {
          items = await listRecentSessions({
            limit: 10,
            directory: ctx.location.directory,
          });
        }
        if (items.length === 0) {
          return tgCtx.reply("No sessions yet. Send /new to create one.");
        }

        const currentId = sessionForChat(tgCtx.chat.id);
        const keyboard = new InlineKeyboard();
        let message = "📋 *Sessions:*\n\n";

        for (const s of items) {
          const isCurrent = s.id === currentId;
          const marker = isCurrent ? " *(bound)*" : "";
          const title = s.title || "untitled";
          message += `• \`${escapeMd(s.id.slice(0, 8))}\` ${escapeMd(title)}${marker}\n`;
          if (!isCurrent) {
            keyboard.text(`Switch: ${title.slice(0, 20)}`, `switch:${s.id}`).row();
          }
        }

        await tgCtx.reply(message, {
          parse_mode: "Markdown",
          reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
        });
      } catch (err) {
        await tgCtx.reply(`❌ Failed to list sessions: ${err.message}`);
      }
    });

    bot.command("abort", async (tgCtx) => {
      const sessionID = sessionForChat(tgCtx.chat.id);
      if (!sessionID) {
        return tgCtx.reply("No bound session.");
      }
      try {
        await ctx.session.interrupt({ sessionID, resume: false });
        await tgCtx.reply("⏹ Aborted.");
      } catch (err) {
        await tgCtx.reply(`❌ Failed to abort: ${err.message}`);
      }
    });

    bot.on("callback_query:data", async (tgCtx) => {
      const data = tgCtx.callbackQuery.data;

      if (data.startsWith("switch:")) {
        const targetId = data.slice("switch:".length);
        bindChat(tgCtx.chat.id, targetId);
        await tgCtx.answerCallbackQuery({ text: "Session switched" });
        await tgCtx.reply(`🔄 Switched to session: \`${escapeMd(targetId)}\``, {
          parse_mode: "Markdown",
        });
        await tgCtx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        return;
      }

      if (data.startsWith("m:")) {
        const idx = parseInt(data.slice("m:".length), 10);
        const models = cachedModelList.length > 0 ? cachedModelList : await getAvailableModels();
        const selected = models[idx];
        if (!selected) {
          return tgCtx.answerCallbackQuery({ text: "Selection expired. Send /model again." });
        }

        const chatId = tgCtx.chat?.id;
        if (!chatId) return;

        try {
          const sessionID = await getActiveSession(chatId);
          await ctx.session.switchModel({
            sessionID,
            model: { providerID: selected.providerID, id: selected.id },
          });
          await tgCtx.answerCallbackQuery({ text: `Switched to ${selected.id}` });
          await tgCtx.reply(`✅ Model switched to: \`${escapeMd(selected.id)}\``, {
            parse_mode: "Markdown",
          });
          await tgCtx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        } catch (err) {
          await tgCtx.answerCallbackQuery({ text: "Switch failed" });
          await tgCtx.reply(`❌ Failed to switch model: ${err.message}`);
        }
        return;
      }

      if (data.startsWith("perm:")) {
        // perm:<decision>:<shortKey>
        const parts = data.split(":");
        const decision = parts[1];
        const shortKey = parts[2];
        const pending = pendingPermissions.get(shortKey);
        if (!pending || !["once", "always", "reject"].includes(decision)) {
          return tgCtx.answerCallbackQuery({ text: "Permission expired" });
        }
        pendingPermissions.delete(shortKey);
        try {
          await ctx.permission.reply({
            sessionID: pending.sessionID,
            requestID: pending.requestID,
            decision,
          });
          await tgCtx.answerCallbackQuery({ text: `Permission: ${decision}` });
          await tgCtx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          await tgCtx.reply(`🔐 Permission *${escapeMd(decision)}* for \`${escapeMd(pending.requestID)}\``, {
            parse_mode: "Markdown",
          });
        } catch (err) {
          await tgCtx.answerCallbackQuery({ text: "Reply failed" });
          await tgCtx.reply(`❌ Failed to reply to permission: ${err.message}`);
        }
        return;
      }
    });

    bot.on("message:text", async (tgCtx) => {
      const chatId = tgCtx.chat.id;
      const text = tgCtx.message.text.trim();
      debugLog(`[recv] chat=${chatId} text=${text.slice(0, 60)}`);
      if (!text || text.startsWith("/")) return;

      let sessionID;
      try {
        sessionID = await getActiveSession(chatId);
      } catch (err) {
        return tgCtx.reply(`❌ Failed to initialize session: ${err.message}`);
      }

      let typingInterval = setInterval(() => {
        tgCtx.api.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);
      tgCtx.api.sendChatAction(chatId, "typing").catch(() => {});

      try {
        await ctx.session.prompt({ sessionID, text });
        await ctx.session.wait({ sessionID });

        clearInterval(typingInterval);
        typingInterval = null;

        // 正常情况下回复已由事件流按 text 段推送；此处为兜底
        const history = await ctx.session.context({ sessionID });
        const messages = asMessageList(history);
        debugLog(`[reply] context messages=${messages.length}`);

        let replyMsg = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.type === "assistant" && msg.time?.completed) {
            replyMsg = msg;
            break;
          }
        }
        const msgID = replyMsg?.id || "";
        if (msgID && delivery.isMessageDeliveredOrPending(msgID)) {
          debugLog(`[reply] already pushed by event path, msg=${msgID.slice(-8)}`);
          return;
        }

        const replyContent = extractAssistantText(replyMsg) || "(no text response)";
        const lockKey = msgID ? `msg:${msgID}` : `fallback:${sessionID}:${Date.now()}`;
        const chats = [chatId];
        await deliverText(chats, replyContent, lockKey, { messageID: msgID || undefined });
      } catch (err) {
        if (typingInterval) clearInterval(typingInterval);
        debugLog("Prompt execution error: " + err.message);
        await tgCtx.reply(`⚠️ Error: ${err.message}`);
      }
    });

    // ---- 订阅 OpenCode 事件流 ----
    const eventController = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.text.ended", "session.viewed", "permission.asked"],
          signal: eventController.signal,
        })) {
          try {
            const type = event?.type;
            const d = event?.data ?? event?.properties ?? event;

            if (type === "session.viewed") {
              if (d?.sessionID) {
                lastViewedSessionID = d.sessionID;
                debugLog(`[event] session.viewed ${String(d.sessionID).slice(-8)}`);
              }
              continue;
            }

            if (type === "permission.asked") {
              const sessionID = d?.sessionID;
              const requestID = d?.id;
              if (!sessionID || !requestID) continue;
              const chats = chatsForSession(sessionID);
              if (chats.length === 0) continue;

              permSeq = (permSeq + 1) % 100000;
              const shortKey = String(permSeq);
              pendingPermissions.set(shortKey, { sessionID, requestID });

              const action = d.action || "permission";
              const resources = Array.isArray(d.resources) ? d.resources.join(", ") : "";
              const message = d.message ? `\n${d.message}` : "";
              const keyboard = new InlineKeyboard()
                .text("Allow once", `perm:once:${shortKey}`)
                .text("Always", `perm:always:${shortKey}`)
                .row()
                .text("Reject", `perm:reject:${shortKey}`);

              const body =
                `🔐 *Permission requested*\n` +
                `• Action: \`${escapeMd(action)}\`\n` +
                (resources ? `• Resources: \`${escapeMd(resources.slice(0, 200))}\`\n` : "") +
                `• Session: \`${escapeMd(sessionID)}\`` +
                (message ? `\n${escapeMd(message)}` : "");

              for (const chatId of chats) {
                await bot.api
                  .sendMessage(chatId, body, {
                    parse_mode: "Markdown",
                    reply_markup: keyboard,
                  })
                  .catch((e) => debugLog("permission notify error: " + e.message));
              }
              continue;
            }

            if (type === "session.text.ended") {
              const sessionID = d?.sessionID;
              const msgID = d?.assistantMessageID || d?.messageID;
              const ordinal = d?.ordinal;
              const text = typeof d?.text === "string" ? d.text : "";
              if (!sessionID) continue;
              const chats = chatsForSession(sessionID);
              if (chats.length === 0) continue;

              debugLog(
                `[event] session.text.ended session=${sessionID.slice(-8)} msg=${(msgID || "?").slice(-8)} ord=${ordinal ?? "?"} chats=${chats.length}`
              );

              // 优先用事件自带 text；按 msgID:ordinal 去重，允许多段 text 全部送达
              if (text) {
                const lockKey =
                  textEndedLockKey(msgID, ordinal) || `session:${sessionID}:${Date.now()}`;
                await deliverText(chats, text, lockKey, { messageID: msgID || undefined });
                continue;
              }

              // 事件无 text 时再查 context（兼容旧事件形状）
              if (!msgID || delivery.isMessageDeliveredOrPending(msgID)) continue;
              const history = await ctx.session.context({ sessionID });
              const messages = asMessageList(history);
              const msg = messages.find((m) => m.id === msgID);
              const fallbackText = extractAssistantText(msg);
              if (!fallbackText) continue;
              await deliverText(chats, fallbackText, `msg:${msgID}`, { messageID: msgID });
            }
          } catch (e) {
            debugLog("event dispatch error: " + e.message);
          }
        }
      } catch (e) {
        debugLog("event subscribe error: " + (e.stack || e.message));
      }
    })();

    debugLog(`Starting Telegram Bot polling (primary @ ${ctx.location.directory})...`);
    bot
      .start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          debugLog(`Bot @${botInfo.username} polling active!`);
        },
      })
      .catch((err) => {
        debugLog("Bot polling error: " + (err.stack || err.message));
      });

    return async () => {
      debugLog("Stopping Telegram Bot...");
      eventController.abort();
      releaseLock();
      try {
        await bot.stop();
      } catch {}
    };
  },
});
