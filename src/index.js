import { Plugin } from "@opencode/plugin";
import { Bot, InlineKeyboard } from "grammy";
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

function splitMessage(text, maxLength = 3800) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let sliceIndex = remaining.lastIndexOf("\n", maxLength);
    if (sliceIndex === -1 || sliceIndex < maxLength / 2) sliceIndex = maxLength;
    chunks.push(remaining.slice(0, sliceIndex));
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  return chunks;
}

export default Plugin.define({
  id: "telegram",
  async setup(ctx) {
    debugLog(`setup() for directory: ${ctx.location.directory}`);

    // 每个加载位置都会实例化一次插件；仅主位置启动 Bot（受配置锁单例保护）
    if (ctx.location.directory !== homedir()) {
      debugLog(`Skipping bot start for non-home location: ${ctx.location.directory}`);
      return () => {};
    }

    if (!tryAcquireLock()) {
      debugLog("Failed to acquire lock: another instance is already running.");
      return () => {};
    }

    const config = loadConfig();
    if (!config) {
      debugLog("Skipped: telegram.json is missing or invalid.");
      return () => {};
    }

    const { token, allowedUsers } = config;
    const bot = new Bot(token);
    const allowed = new Set(allowedUsers);
    const chatSessions = new Map(); // chatId -> sessionID
    const sessionToChats = new Map(); // sessionID -> Set<chatId>
    const sentMessageIds = new Set(); // 已推送到 Telegram 的 assistant 消息 ID（去重）
    const pendingSend = new Set();

    function bindChat(chatId, sessionID) {
      chatSessions.set(chatId, sessionID);
      if (!sessionToChats.has(sessionID)) sessionToChats.set(sessionID, new Set());
      sessionToChats.get(sessionID).add(chatId);
    }

    function chatsForSession(sessionID) {
      const set = sessionToChats.get(sessionID);
      if (set) return [...set];
      const chats = [];
      for (const [chatId, sid] of chatSessions) {
        if (sid === sessionID) chats.push(chatId);
      }
      return chats;
    }

    function extractAssistantText(msg) {
      if (!msg) return "";
      if (typeof msg.text === "string" && msg.text) return msg.text;
      if (Array.isArray(msg.content)) {
        return msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      }
      return "";
    }

    // 将一条 assistant 回复推送到所有绑定了该会话的 Telegram 聊天
    async function pushAssistantToChats(sessionID, msgID, chats) {
      if (!chats.length) return 0;
      const lockKey = msgID || sessionID;
      if (sentMessageIds.has(lockKey) || pendingSend.has(lockKey)) return 0;
      pendingSend.add(lockKey);

      try {
        const history = await ctx.session.context({ sessionID });
        const messages = Array.isArray(history) ? history : history?.data || history?.messages || [];
        const msg = msgID
          ? messages.find((m) => m.id === msgID)
          : [...messages].reverse().find((m) => m.type === "assistant" && m.time?.completed);
        const text = extractAssistantText(msg);
        if (!text) return 0;

        sentMessageIds.add(lockKey);
        let pushed = 0;
        for (const chatId of chats) {
          for (const chunk of splitMessage(text)) {
            await bot.api.sendMessage(chatId, chunk).catch((e) => debugLog("push error: " + e.message));
          }
          pushed++;
        }
        debugLog(`[push] session=${sessionID.slice(-8)} msg=${(msgID || "?").slice(-8)} chats=${pushed}`);
        return pushed;
      } finally {
        pendingSend.delete(lockKey);
      }
    }

    async function getActiveSession(chatId) {
      let sessionID = chatSessions.get(chatId);
      if (sessionID) {
        try {
          const s = await ctx.session.get({ sessionID });
          if (s) return sessionID;
        } catch {}
      }

      try {
        const list = await ctx.session.list({ directory: ctx.location.directory, limit: 1 });
        const items = list?.data || list?.items || (Array.isArray(list) ? list : []);
        if (items.length > 0) {
          sessionID = items[0].id;
          bindChat(chatId, sessionID);
          return sessionID;
        }
      } catch (e) {
        debugLog("List sessions error: " + e.message);
      }

      const created = await ctx.session.create({ title: "Telegram remote session" });
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
      const sessionID = chatSessions.get(tgCtx.chat.id) || "(none yet)";
      await tgCtx.reply(
        `🖥 *OpenCode status*\n` +
          `• Directory: \`${ctx.location.directory}\`\n` +
          `• Bound session: \`${sessionID}\`\n` +
          `• Plugin state: running`,
        { parse_mode: "Markdown" }
      );
    });

    bot.command("new", async (tgCtx) => {
      try {
        const created = await ctx.session.create({ title: "Telegram remote session" });
        bindChat(tgCtx.chat.id, created.id);
        await tgCtx.reply(`✨ New session created: \`${created.id}\``, { parse_mode: "Markdown" });
      } catch (err) {
        await tgCtx.reply(`❌ Failed to create session: ${err.message}`);
      }
    });

    bot.command("current", async (tgCtx) => {
      try {
        const list = await ctx.session.list({ directory: ctx.location.directory, limit: 1 });
        const items = list?.data || list?.items || (Array.isArray(list) ? list : []);
        if (items.length === 0) {
          return tgCtx.reply("No sessions found.");
        }
        const current = items[0];
        bindChat(tgCtx.chat.id, current.id);
        const title = current.title || "untitled";
        await tgCtx.reply(
          `🔗 *Attached to the desktop's current window!*\n` +
            `• Title: *${title}*\n` +
            `• ID: \`${current.id}\`\n\n` +
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
      try {
        const list = await ctx.model.list();
        if (Array.isArray(list) && list.length > 0) {
          return list.map((m) => ({ providerID: m.providerID, id: m.id, name: m.name || m.id }));
        }
      } catch (e) {
        debugLog("ctx.model.list error: " + e.message);
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

      // /model <keyword> — 模糊匹配并直接切换
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
          return tgCtx.reply(`✅ Model switched to: \`${matched.id}\``, { parse_mode: "Markdown" });
        } catch (err) {
          return tgCtx.reply(`❌ Failed to switch model: ${err.message}`);
        }
      }

      // /model — 弹出按钮列表
      const keyboard = new InlineKeyboard();
      let text = "🤖 *Choose a model:*\n\n";
      models.forEach((m, idx) => {
        const shortName = m.id.split("/").pop() || m.id;
        text += `${idx + 1}. \`${m.id}\`\n`;
        keyboard.text(shortName, `m:${idx}`);
        if ((idx + 1) % 2 === 0) keyboard.row();
      });
      await tgCtx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    });

    bot.command("sessions", async (tgCtx) => {
      try {
        const list = await ctx.session.list({ directory: ctx.location.directory, limit: 10 });
        const items = list?.data || list?.items || (Array.isArray(list) ? list : []);
        if (items.length === 0) {
          return tgCtx.reply("No sessions yet. Send /new to create one.");
        }

        const currentId = chatSessions.get(tgCtx.chat.id);
        const keyboard = new InlineKeyboard();
        let message = "📋 *Sessions:*\n\n";

        for (const s of items) {
          const isCurrent = s.id === currentId;
          const marker = isCurrent ? " *(bound)*" : "";
          const title = s.title || "untitled";
          message += `• \`${s.id.slice(0, 8)}\` ${title}${marker}\n`;
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
      const sessionID = chatSessions.get(tgCtx.chat.id);
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
        await tgCtx.reply(`🔄 Switched to session: \`${targetId}\``, { parse_mode: "Markdown" });
        await tgCtx.editMessageReplyMarkup({ reply_markup: undefined });
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
          await tgCtx.reply(`✅ Model switched to: \`${selected.id}\``, { parse_mode: "Markdown" });
          await tgCtx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch (err) {
          await tgCtx.answerCallbackQuery({ text: "Switch failed" });
          await tgCtx.reply(`❌ Failed to switch model: ${err.message}`);
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

        // 正常情况下回复已由事件流推送；此处为兜底（事件订阅路径失效时仍可回复）
        const history = await ctx.session.context({ sessionID });
        const messages = Array.isArray(history) ? history : history?.data || history?.messages || [];
        debugLog(`[reply] context messages=${messages.length}`);

        let replyMsg = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.type === "assistant" && msg.time?.completed) {
            replyMsg = msg;
            break;
          }
        }
        const replyContent = extractAssistantText(replyMsg) || "(no text response)";
        const msgID = replyMsg?.id || "";
        if (msgID && sentMessageIds.has(msgID)) {
          debugLog(`[reply] already pushed by event path, msg=${msgID.slice(-8)}`);
          return;
        }

        const chunks = splitMessage(replyContent);
        for (const chunk of chunks) {
          await tgCtx.reply(chunk);
        }
        if (msgID) sentMessageIds.add(msgID);
      } catch (err) {
        if (typingInterval) clearInterval(typingInterval);
        debugLog("Prompt execution error: " + err.message);
        await tgCtx.reply(`⚠️ Error: ${err.message}`);
      }
    });

    // ---- 订阅 OpenCode 事件流：把桌面端产生的回复实时推送到绑定的聊天 ----
    const eventController = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.text.ended"],
          signal: eventController.signal,
        })) {
          try {
            const d = event?.data ?? event?.properties ?? event;
            const sessionID = d?.sessionID;
            const msgID = d?.assistantMessageID || d?.messageID;
            if (!sessionID) continue;
            const chats = chatsForSession(sessionID);
            if (chats.length === 0) continue;
            debugLog(`[event] session.text.ended session=${sessionID.slice(-8)} msg=${(msgID || "?").slice(-8)} chats=${chats.length}`);
            await pushAssistantToChats(sessionID, msgID, chats);
          } catch (e) {
            debugLog("event dispatch error: " + e.message);
          }
        }
      } catch (e) {
        debugLog("event subscribe error: " + (e.stack || e.message));
      }
    })();

    debugLog("Starting Telegram Bot polling (primary instance)...");
    bot.start({
      drop_pending_updates: false,
      onStart: (botInfo) => {
        debugLog(`Bot @${botInfo.username} polling active!`);
      },
    }).catch((err) => {
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
