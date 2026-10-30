/** Escape dynamic values for Telegram legacy Markdown. */
export function escapeMd(value) {
  return String(value ?? "").replace(/([_*`\[])/g, "\\$1");
}

export function splitMessage(text, maxLength = 3800) {
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

export function asSessionList(list) {
  if (Array.isArray(list)) return list;
  if (Array.isArray(list?.data)) return list.data;
  if (Array.isArray(list?.items)) return list.items;
  return [];
}

export function asModelList(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

export function asMessageList(history) {
  if (Array.isArray(history)) return history;
  if (Array.isArray(history?.data)) return history.data;
  if (Array.isArray(history?.messages)) return history.messages;
  return [];
}

/** chatId ↔ sessionID 双向绑定；换绑时从旧 session 解绑。 */
export function createSessionBindings() {
  const chatSessions = new Map();
  const sessionToChats = new Map();

  function bindChat(chatId, sessionID) {
    const prev = chatSessions.get(chatId);
    if (prev && prev !== sessionID) {
      const prevSet = sessionToChats.get(prev);
      if (prevSet) {
        prevSet.delete(chatId);
        if (prevSet.size === 0) sessionToChats.delete(prev);
      }
    }
    chatSessions.set(chatId, sessionID);
    if (!sessionToChats.has(sessionID)) sessionToChats.set(sessionID, new Set());
    sessionToChats.get(sessionID).add(chatId);
  }

  function chatsForSession(sessionID) {
    const set = sessionToChats.get(sessionID);
    return set ? [...set] : [];
  }

  function sessionForChat(chatId) {
    return chatSessions.get(chatId);
  }

  return { bindChat, chatsForSession, sessionForChat, chatSessions, sessionToChats };
}

/**
 * 推送去重：事件路径（msgID:ordinal）与 wait 兜底（msg:msgID）共用。
 */
export function createDeliveryTracker() {
  const deliveredKeys = new Set();
  const pendingKeys = new Set();
  const messagesWithPushedText = new Set();

  function isMessageDeliveredOrPending(msgID) {
    if (!msgID) return false;
    if (messagesWithPushedText.has(msgID)) return true;
    if (deliveredKeys.has(`msg:${msgID}`) || pendingKeys.has(`msg:${msgID}`)) return true;
    for (const key of pendingKeys) {
      if (key.startsWith(`${msgID}:`)) return true;
    }
    for (const key of deliveredKeys) {
      if (key.startsWith(`${msgID}:`)) return true;
    }
    return false;
  }

  function tryBegin(lockKey) {
    if (deliveredKeys.has(lockKey) || pendingKeys.has(lockKey)) return false;
    pendingKeys.add(lockKey);
    return true;
  }

  function markDelivered(lockKey, messageID) {
    deliveredKeys.add(lockKey);
    if (messageID) messagesWithPushedText.add(messageID);
    if (deliveredKeys.size > 2000) {
      const drop = [...deliveredKeys].slice(0, deliveredKeys.size - 1000);
      for (const k of drop) deliveredKeys.delete(k);
    }
    if (messagesWithPushedText.size > 2000) {
      const drop = [...messagesWithPushedText].slice(0, messagesWithPushedText.size - 1000);
      for (const k of drop) messagesWithPushedText.delete(k);
    }
  }

  function end(lockKey) {
    pendingKeys.delete(lockKey);
  }

  return {
    isMessageDeliveredOrPending,
    tryBegin,
    markDelivered,
    end,
    deliveredKeys,
    pendingKeys,
    messagesWithPushedText,
  };
}

export function textEndedLockKey(msgID, ordinal) {
  if (msgID != null && ordinal != null) return `${msgID}:${ordinal}`;
  if (msgID) return `${msgID}:0`;
  return null;
}

export function normalizeModels(result) {
  return asModelList(result)
    .filter((m) => m && m.enabled !== false)
    .map((m) => {
      const id = m.modelID || m.id;
      return {
        providerID: m.providerID,
        id,
        name: m.name || id,
      };
    })
    .filter((m) => m.providerID && m.id);
}
