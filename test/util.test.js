import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asMessageList,
  asModelList,
  asSessionList,
  createDeliveryTracker,
  createSessionBindings,
  escapeMd,
  normalizeModels,
  splitMessage,
  textEndedLockKey,
} from "../src/util.js";

describe("splitMessage", () => {
  it("returns a single chunk when under the limit", () => {
    assert.deepEqual(splitMessage("hello", 10), ["hello"]);
  });

  it("splits on newlines when possible", () => {
    const text = "aaa\nbbb\nccc";
    assert.deepEqual(splitMessage(text, 5), ["aaa", "bbb", "ccc"]);
  });

  it("hard-splits when no good newline exists", () => {
    assert.deepEqual(splitMessage("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  });
});

describe("escapeMd", () => {
  it("escapes Telegram legacy Markdown metacharacters", () => {
    assert.equal(escapeMd("a_b*c`d[e"), "a\\_b\\*c\\`d\\[e");
  });

  it("stringifies nullish values", () => {
    assert.equal(escapeMd(null), "");
    assert.equal(escapeMd(undefined), "");
  });
});

describe("API shape helpers", () => {
  it("asSessionList accepts V2 { data } and bare arrays", () => {
    assert.deepEqual(asSessionList({ data: [{ id: "1" }] }), [{ id: "1" }]);
    assert.deepEqual(asSessionList([{ id: "2" }]), [{ id: "2" }]);
    assert.deepEqual(asSessionList(null), []);
  });

  it("asModelList accepts V2 { data } shape", () => {
    assert.deepEqual(asModelList({ location: {}, data: [{ id: "m" }] }), [{ id: "m" }]);
    assert.deepEqual(asModelList([{ id: "m" }]), [{ id: "m" }]);
  });

  it("asMessageList accepts array / data / messages", () => {
    assert.deepEqual(asMessageList([{ id: "a" }]), [{ id: "a" }]);
    assert.deepEqual(asMessageList({ data: [{ id: "b" }] }), [{ id: "b" }]);
    assert.deepEqual(asMessageList({ messages: [{ id: "c" }] }), [{ id: "c" }]);
  });

  it("normalizeModels prefers modelID and skips disabled", () => {
    const models = normalizeModels({
      data: [
        { providerID: "openai", modelID: "gpt-4.1", id: "x", name: "GPT", enabled: true },
        { providerID: "openai", modelID: "old", id: "old", enabled: false },
        { providerID: "anthropic", id: "claude", enabled: true },
      ],
    });
    assert.deepEqual(models, [
      { providerID: "openai", id: "gpt-4.1", name: "GPT" },
      { providerID: "anthropic", id: "claude", name: "claude" },
    ]);
  });
});

describe("createSessionBindings", () => {
  it("unbinds the previous session when rebinding a chat", () => {
    const { bindChat, chatsForSession, sessionForChat } = createSessionBindings();
    bindChat(1, "s1");
    bindChat(1, "s2");
    assert.equal(sessionForChat(1), "s2");
    assert.deepEqual(chatsForSession("s1"), []);
    assert.deepEqual(chatsForSession("s2"), [1]);
  });
});

describe("createDeliveryTracker", () => {
  it("dedupes the same lock key across pending and delivered", () => {
    const d = createDeliveryTracker();
    assert.equal(d.tryBegin("m1:0"), true);
    assert.equal(d.tryBegin("m1:0"), false);
    d.markDelivered("m1:0", "m1");
    d.end("m1:0");
    assert.equal(d.tryBegin("m1:0"), false);
    assert.equal(d.isMessageDeliveredOrPending("m1"), true);
  });

  it("allows multiple ordinals for the same assistant message", () => {
    const d = createDeliveryTracker();
    assert.equal(d.tryBegin("m1:0"), true);
    d.markDelivered("m1:0", "m1");
    d.end("m1:0");
    assert.equal(d.tryBegin("m1:1"), true);
    d.markDelivered("m1:1", "m1");
    d.end("m1:1");
  });

  it("treats in-flight segment keys as pending for wait fallback", () => {
    const d = createDeliveryTracker();
    assert.equal(d.tryBegin("m9:0"), true);
    assert.equal(d.isMessageDeliveredOrPending("m9"), true);
    d.end("m9:0");
  });
});

describe("textEndedLockKey", () => {
  it("prefers msgID:ordinal", () => {
    assert.equal(textEndedLockKey("abc", 2), "abc:2");
    assert.equal(textEndedLockKey("abc", undefined), "abc:0");
    assert.equal(textEndedLockKey(null, 0), null);
  });
});
