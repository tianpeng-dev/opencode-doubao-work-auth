import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { replyDeltas } from "../lib/reply-stream.mjs";
import { prepareRequest, decodeReply } from "../lib/protocol.mjs";
import { chat } from "../lib/chat.mjs";

let cache;
const priorCache = process.env.XDG_CACHE_HOME;
before(async () => {
  const parent = resolve(process.env.DOUBAO_WORK_TEST_DIR || "../../.scratch/unit");
  await mkdir(parent, { recursive: true });
  cache = await mkdtemp(join(parent, "stream-"));
  process.env.XDG_CACHE_HOME = cache;
});
after(async () => {
  if (priorCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = priorCache;
  await rm(cache, { recursive: true, force: true });
});

const tool = { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const base = { model: "doubao-work-lite", messages: [{ role: "user", content: "读取资料" }], tools: [tool], stream: true };
const context = extra => prepareRequest({ ...base, ...extra });
// 模拟上游内容分块，仅验证转发顺序和协议约束，不代表真实账号延迟。
async function* pieces(parts) { for (const part of parts) yield typeof part === "string" ? { content: part } : part; }
async function collect(parts, extra) {
  const results = [];
  for await (const item of replyDeltas(pieces(parts), context(extra))) results.push(item);
  return results;
}

test("携带工具定义的普通正文在上游结束前逐块返回", async () => {
  let ended = false;
  async function* source() { yield { content: "首字" }; yield { content: "后续" }; ended = true; }
  const iterator = replyDeltas(source(), context());
  assert.deepEqual((await iterator.next()).value, { content: "首字" });
  assert.equal(ended, false);
  assert.deepEqual((await iterator.next()).value, { content: "后续" });
  assert.equal(ended, false);
  assert.deepEqual((await iterator.next()).value, { finish_reason: "stop" });
  assert.equal(ended, true);
});

test("JSON 正文增量保留中文、转义和跨块表情且不泄漏工具参数", async () => {
  const content = '你好🙂\n路径 C:\\a\\b 和 "引号"';
  const raw = JSON.stringify({ content, tool_calls: [{ name: "read_file", arguments: { path: "private-argument" } }] }).replace("🙂", "\\ud83d\\ude42");
  const rows = await collect(raw.split(""));
  assert.equal(rows.filter(row => row.content).map(row => row.content).join(""), content);
  assert.ok(rows.filter(row => row.content).length > 5);
  for (const row of rows) if (row.content) assert.equal(new TextDecoder().decode(new TextEncoder().encode(row.content)), row.content);
  const calls = rows.filter(row => row.tool_calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_calls[0].function.arguments, '{"path":"private-argument"}');
  assert.equal(rows.at(-1).finish_reason, "tool_calls");
});

test("工具调用直到上游结束和清理完成才提交，正文提前返回", async () => {
  let cleaned = false;
  async function* source() {
    try {
      yield { content: '{"content":"我来读取' };
      yield { content: '","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}' };
    } finally { cleaned = true; }
  }
  const iterator = replyDeltas(source(), context({ tool_choice: "required" }));
  assert.deepEqual((await iterator.next()).value, { content: "我来读取" });
  assert.equal(cleaned, false);
  assert.equal((await iterator.next()).value.tool_calls[0].function.name, "read_file");
  assert.equal(cleaned, true);
  assert.equal((await iterator.next()).value.finish_reason, "tool_calls");
});

test("工具属性顺序变化和嵌套 content 不改变公开正文", async () => {
  const alternate = { type: "function", function: { name: "echo", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } };
  const raw = '{"tool_calls":[{"name":"echo","arguments":{"content":"内部参数"}}],"content":"公开正文"}';
  const rows = await collect([...raw], { tools: [alternate] });
  assert.equal(rows.map(row => row.content || "").join(""), "公开正文");
  assert.equal(rows.find(row => row.tool_calls).tool_calls[0].function.arguments, '{"content":"内部参数"}');
});

test("无效或未完成的调用不发送 tool_calls 或成功结束", async () => {
  for (const raw of [
    '{"content":"说明","tool_calls":[{"name":"other","arguments":{}}]}',
    '{"content":"说明","tool_calls":[{"name":"read_file","arguments":{"path":3}}]}',
    '{"content":"说明","tool_calls":[',
    '{"content":"说明","tool_calls":[]} trailing',
    '{"content":"说明","content":"另一条","tool_calls":[]}',
    '{"content":42,"tool_calls":[]}',
    '{"content":"说明","tool_calls":[],"unknown":true}',
  ]) {
    const rows = [];
    await assert.rejects(async () => { for await (const row of replyDeltas(pieces([...raw]), context())) rows.push(row); }, { code: "invalid_tool_response" });
    assert.equal(rows.some(row => row.tool_calls || row.finish_reason), false);
  }
});

test("跨块 Markdown 普通代码正常转发，工具格式包装明确失败", async () => {
  for (const raw of ["```js\nconst answer = 42;\n```", "<text>普通文字</text>", "`行内代码`", "``", "```json\n42\n```", "普通回答"]) {
    const rows = await collect([...raw]);
    assert.equal(rows.map(row => row.content || "").join(""), raw);
    assert.equal(decodeReply(raw, context()).content, raw);
  }
  for (const raw of ['```json\n{"content":"a","tool_calls":[]}\n```', '<tool_call>{}</tool_call>', '[1]'])
    await assert.rejects(collect([...raw]), { code: "invalid_tool_response" });
});

test("必选工具和命名工具完整验证后才提交", async () => {
  await assert.rejects(collect(["普通答复"], { tool_choice: "required" }), { code: "invalid_tool_response" });
  await assert.rejects(collect(['{"content":"a","tool_calls":[]}'], { tool_choice: "required" }), { code: "invalid_tool_response" });
  const valid = '{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}';
  const rows = await collect([...valid], { tool_choice: { type: "function", function: { name: "read_file" } }, parallel_tool_calls: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool_calls.length, 1);
});

test("可见思考立即转发，JSON Schema 正文校验后提交", async () => {
  let done = false;
  async function* source() { yield { reasoning_content: "检查字段" }; yield { content: '{"ok":' }; yield { content: "true}" }; done = true; }
  const iterator = replyDeltas(source(), context({ tools: undefined, response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object", properties: { ok: { const: true } }, required: ["ok"] } } } }));
  assert.deepEqual((await iterator.next()).value, { reasoning_content: "检查字段" });
  assert.equal(done, false);
  assert.deepEqual((await iterator.next()).value, { content: '{"ok":true}' });
  assert.equal(done, true);
});

test("转发中取消或格式失败均关闭上游迭代器", async () => {
  let cleaned = 0;
  async function* source() { try { yield { content: '{"content":"首字' }; yield { content: '" BAD' }; } finally { cleaned++; } }
  const iterator = replyDeltas(source(), context());
  assert.deepEqual((await iterator.next()).value, { content: "首字" });
  await iterator.return();
  assert.equal(cleaned, 1);
  const bad = replyDeltas(source(), context());
  await bad.next();
  await assert.rejects(bad.next(), { code: "invalid_tool_response" });
  assert.equal(cleaned, 2);
});

function upstreamFixture({ cleanupFails = false } = {}) {
  let controller, signal, deleted = false;
  const encoder = new TextEncoder();
  const event = (name, data) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const chunk = text => event("STREAM_CHUNK", { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [{ block_id: "text", block_type: 10000, content: { text_block: { text } } }] } }] });
  const session = {
    uid: randomUUID(), profile: "Default", bot: "test-bot", ready: async () => {},
    models: async () => new Map([[base.model, { model_item_key: "seed-lite-7b", levels: { low: 3 }, defaultEffort: "low", model_extra_params: {}, agentMode: 1, modeId: "3", item_id: 10001 }]]),
    request: async (path, body, incoming) => {
      if (path === "/im/conversation/batch_del_user_conv") {
        assert.equal(incoming.aborted, false);
        deleted = true;
        if (cleanupFails) throw new Error("模拟删除服务不可用");
        return Response.json({ status_code: 0, downlink_body: { batch_delete_user_conversation_downlink_body: { result: { "123": true } } } });
      }
      assert.equal(path, "/chat/completion");
      signal = incoming;
      return new Response(new ReadableStream({ start(value) {
        controller = value;
        incoming.addEventListener("abort", () => controller.error(incoming.reason), { once: true });
        controller.enqueue(event("SSE_ACK", { ack_client_meta: { conversation_id: "123", conversation_type: 3, local_conversation_id: body.client_meta.local_conversation_id } }));
        controller.enqueue(chunk('{"content":"首字'));
      } }), { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  return {
    session, get deleted() { return deleted; }, get aborted() { return signal.aborted; },
    finish() { controller.enqueue(chunk('","tool_calls":[]}')); controller.enqueue(event("SSE_REPLY_END", { end_type: 3 })); controller.close(); },
  };
}

test("完整 HTTP 流在上游结束前返回正文，取消使用独立信号删除会话", { timeout: 3000 }, async () => {
  const fixture = upstreamFixture();
  const messages = [{ role: "user", content: "第一问" }, { role: "assistant", content: "第一答" }, ...base.messages];
  const response = await chat(fixture.session, "https://www.doubao.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...base, messages }) });
  assert.equal(response.status, 200);
  assert.equal(fixture.deleted, false);
  const reader = response.body.getReader();
  await reader.read();
  assert.match(new TextDecoder().decode((await reader.read()).value), /首字/);
  await reader.cancel();
  assert.equal(fixture.aborted, true);
  assert.equal(fixture.deleted, true);
});

test("已发送首字后清理失败输出 SSE 错误并保留失败状态", { timeout: 3000 }, async () => {
  const fixture = upstreamFixture({ cleanupFails: true });
  const messages = [{ role: "user", content: "第一问" }, { role: "assistant", content: "第一答" }, ...base.messages];
  const response = await chat(fixture.session, "https://www.doubao.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...base, messages }) });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let data = decoder.decode((await reader.read()).value) + decoder.decode((await reader.read()).value);
  fixture.finish();
  while (true) { const item = await reader.read(); if (item.done) break; data += decoder.decode(item.value); }
  assert.match(data, /首字/);
  assert.match(data, /conversation_cleanup_failed/);
  assert.match(data, /模拟删除服务不可用/);
  assert.doesNotMatch(data, /\[DONE\]|"finish_reason":"stop"/);
});
