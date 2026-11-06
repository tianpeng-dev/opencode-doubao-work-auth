import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import { prepareRequest, decodeReply, upstreamBody } from "../lib/protocol.mjs";
import { normalizeQuota } from "../lib/quota.mjs";
import { readDoubao } from "../lib/modern-stream.mjs";
import { parseModels, selectModel, magpieModels } from "../lib/models.mjs";
import { DesktopSession } from "../lib/session.mjs";
import { chat } from "../lib/chat.mjs";
import { ProviderError, upstreamError } from "../lib/errors.mjs";

const base = { model: "doubao-work-auto", messages: [{ role: "user", content: "测试" }] };
const mockClient = { deviceId: "123456789012345", webId: "1234567890123456789", teaUuid: "123456789012345", chromiumVersion: "147.0.7727.149" };
// 模拟菜单仅隔离网络；真实模型权限由 live 测试查询。
const mockMenu = () => ({ entry_list: [{ action_bar_key: "coco_deep_thinking", active_switch_conf: { use_menu_conf_v2: true, menu_conf_v2: { use_mode_model_list: true, mode_list: { item_list: [{ mode_id: "3", agent_mode: 1, default_conversation_mode: "office", model_list: { item_list: [[9, "9", "自动"], [10001, "seed-lite-7b", "豆包 2.1 Lite"], [5, "5", "豆包 2.1 Pro"]].map(([item_id, model_item_key, name]) => ({ item_id, model_item_key, name, model_extra_params: { total_window_size: "256000" }, reasoning_effort_config: { default_level: 5, option_list: [3, 4, 5].map(level => ({ level, name: String(level) })) } })) } }] } } } }] });
const catalog = parseModels(mockMenu());
const tool = { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };

test("完整保留 system、developer 和历史消息", () => {
  const messages = [{ role: "system", content: "S" }, { role: "developer", content: "D" }, { role: "user", content: "U" }, { role: "assistant", content: "A" }, { role: "user", content: "V" }];
  const context = prepareRequest({ ...base, messages });
  assert.ok(context.prompt.includes(JSON.stringify(messages)));
});

test("首次请求将原始消息和完整工具定义放入附件", () => {
  const fullTool = { ...tool, custom_metadata: { tag: "保留" } };
  const input = { ...base, tools: [fullTool], tool_choice: "auto", parallel_tool_calls: false };
  const context = prepareRequest(input);
  const attachment = JSON.parse(context.attachment.slice(context.attachment.indexOf("{"), context.attachment.lastIndexOf("}") + 1));
  assert.deepEqual(attachment, { messages: input.messages, tools: input.tools, tool_choice: "auto", parallel_tool_calls: false });
  assert.equal(context.prompt.split("工具传输协议：").length, 2);
  assert.ok(context.prompt.includes("read_file"));
  assert.ok(context.prompt.includes("测试"));
  assert.ok(!context.prompt.includes(JSON.stringify([fullTool])));
});

test("首次请求及超过阈值的后续历史使用附件", () => {
  const shorter = prepareRequest({ ...base, messages: [{ role: "user", content: "a".repeat(235000) }] });
  assert.ok(shorter.attachment.includes("a".repeat(235000)));
  const followup = prepareRequest({ ...base, messages: [{ role: "user", content: "第一问" }, { role: "assistant", content: "第一答" }, { role: "user", content: "下一问" }] });
  assert.equal(followup.attachment, undefined);
  const longer = prepareRequest({ ...base, messages: [{ role: "user", content: "b".repeat(270000) }] });
  assert.ok(longer.attachment.includes("b".repeat(270000)));
});

test("不支持的图片和采样参数在发送前失败", () => {
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }), { status: 400 });
  assert.throws(() => prepareRequest({ ...base, temperature: 0.5 }), { status: 400 });
});

test("0.8 MB 历史和完整工具定义保存到附件", () => {
  const messages = [{ role: "system", content: "HEAD" }, { role: "user", content: "数据".repeat(140000) + "TAIL" }];
  const context = prepareRequest({ ...base, messages, tools: [tool] });
  assert.ok(Buffer.byteLength(context.attachment) > 800000);
  assert.ok(context.attachment.includes(JSON.stringify(messages)));
  assert.ok(context.prompt.includes("HEAD"));
  assert.ok(context.prompt.includes("TAIL"));
  assert.ok(Buffer.byteLength(context.prompt) < 100000);
  assert.ok(context.attachment.includes(JSON.stringify([tool])));
});

test("长历史附件保持工具结果和 Markdown 内容，当前问题完整留在正文", () => {
  const messages = [{ role: "developer", content: "必须遵守执行约束" }, { role: "user", content: "代码```js\n" + "中文🙂".repeat(30000) }, { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, { role: "tool", tool_call_id: "c1", content: "未截断的工具输出\r\n" }, { role: "user", content: "结合资料修改文件并说明改动。" }];
  const context = prepareRequest({ ...base, messages, tools: [tool] });
  const document = JSON.parse(context.attachment.slice(context.attachment.indexOf("{"), context.attachment.lastIndexOf("}") + 1));
  assert.deepEqual(document.messages, messages);
  assert.ok(context.attachment.includes("````json"));
  assert.ok(context.prompt.includes(messages.at(-1).content));
  assert.ok(context.prompt.includes(messages[0].content));
  assert.ok(prepareRequest(base).attachment);
});

test("auto 工具请求可返回普通文字，工具调用仍验证完整格式", () => {
  const context = prepareRequest({ ...base, tools: [tool] });
  for (const content of ["我可以帮你分析这个问题。", "```js\nconst answer = 42;\n```"])
    assert.deepEqual(decodeReply(content, context), { role: "assistant", content });
  for (const content of ['{"content":"a","tool_calls":', '<tool_call>{"name":"read_file"}</tool_call>', '{"content":"a","tool_calls":[{"name":"other","arguments":{}}]}'])
    assert.throws(() => decodeReply(content, context), { code: "invalid_tool_response" });
});

test("工具名称、参数和 tool_choice 都经过验证", () => {
  const context = prepareRequest({ ...base, tools: [tool], tool_choice: "required" });
  const reply = decodeReply('{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"fixture"}}]}', context);
  assert.equal(reply.tool_calls[0].function.name, "read_file");
  assert.throws(() => decodeReply('{"content":"","tool_calls":[]}', context), { status: 502 });
  assert.throws(() => decodeReply('{"content":"","tool_calls":[{"name":"exec","arguments":{}}]}', context), { status: 502 });
  assert.throws(() => decodeReply('{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":3}}]}', context), { status: 502 });
  assert.throws(() => decodeReply("```json\n{}\n```", context), { status: 502 });
});

test("工具历史缺失、重复结果和未声明工具都失败", () => {
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: "tool", tool_call_id: "unknown", content: "abc" }] }), { status: 400 });
  assert.throws(() => prepareRequest({ ...base, tool_choice: "required" }), { status: 400 });
  assert.throws(() => prepareRequest({ ...base, tools: [tool, tool] }), { status: 400 });
});

test("结构化回复执行 JSON Schema 验证", () => {
  const context = prepareRequest({ ...base, response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object", properties: { ok: { const: true } }, required: ["ok"] } } } });
  assert.equal(decodeReply('{"ok":true}', context).content, '{"ok":true}');
  assert.throws(() => decodeReply('{"ok":false}', context), { status: 502 });
});

test("工具与结构化回复可共存，最终回复必须符合 Schema", () => {
  const response_format = { type: "json_schema", json_schema: { name: "result", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } };
  const context = prepareRequest({ ...base, tools: [tool], response_format });
  assert.equal(decodeReply('{"content":"{\\"title\\":\\"示例\\"}","tool_calls":[]}', context).content, '{"title":"示例"}');
  assert.equal(decodeReply('{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}', context).tool_calls[0].function.name, "read_file");
  assert.throws(() => decodeReply('{"content":"{\\"title\\":5}","tool_calls":[]}', context), { code: "invalid_json_response" });
  assert.throws(() => decodeReply('{"content":"普通文字","tool_calls":[]}', context), { code: "invalid_json_response" });
});

const section = (amount, limit, exhausted, extra = {}) => ({ usage_exhausted: exhausted, window_limit_groups: [{ window_limits: [{ used_amount: amount, total_amount: limit, ...extra }] }] });

test("真实额度字段：千位分隔、未知百分比、零时间和替代额度", () => {
  const usage = normalizeQuota({ current_subscription: { display: { short_name: "标准套餐" } } }, {
    window_limit_section: section("0", "2,100", false, { end_time: 0 }),
    incentive_quota_section: section("200", "200", true),
  }, "测试账号");
  assert.equal(usage.windows[0].limit, 2100);
  assert.equal(usage.windows[0].used, undefined);
  assert.equal(usage.windows[0].resetsAt, undefined);
  assert.equal(usage.windows[1].aside, true);
  const exhausted = normalizeQuota({}, { window_limit_section: section("2100", "2100", true), incentive_quota_section: section("200", "200", true) });
  assert.ok(exhausted.windows.every(window => !window.aside));
});

test("赠送额度到期与未知数值准确表示", () => {
  const usage = normalizeQuota({}, { incentive_quota_section: section("76", "200", false, { end_time: 1796032176159 }) });
  assert.equal(usage.windows[0].runsOut, 124);
  assert.ok(usage.windows[0].runsOutAt);
  assert.equal(usage.windows[0].resetsAt, undefined);
  assert.throws(() => normalizeQuota({}, { window_limit_section: section("bad", "200", false) }), { code: "invalid_quota" });
});

// 以下使用明确的模拟流隔离网络，验证协议边界与异常，不代表真实服务集成。
function frame(type, data) { return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; }
function content(text, delta = true) { return { message_id: "answer", patch_op: [{ patch_object: 1, patch_type: delta ? 1 : 2, patch_value: { content_block: [{ block_id: "part", block_type: 10000, content: { text_block: { text } } }] } }] }; }
const end = () => frame("SSE_REPLY_END", { end_type: 3 });
function simulatedStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function collect(response) { const values = []; for await (const value of readDoubao(response)) values.push(value); return values; }

test("SSE 跨字节中文、增量和完整快照不会重复", async () => {
  const values = await collect(simulatedStream(frame("STREAM_CHUNK", content("你")) + frame("STREAM_CHUNK", content("好")) + frame("STREAM_CHUNK", content("你好", false)) + end()));
  assert.equal(values.map(value => value.content).join(""), "你好");
});

test("思考父级内容单独返回，摘要不进入正文", async () => {
  const intro = frame("STREAM_MSG_NOTIFY", { meta: { message_id: "answer" }, content: { content_block: [{ block_id: "think", block_type: 10040 }, { block_id: "child", parent_id: "think", block_type: 10000, content: { text_block: { text: "计算", summary: "正在思考" } } }] } });
  const values = await collect(simulatedStream(intro + frame("STREAM_CHUNK", content("42")) + end()));
  assert.deepEqual(values, [{ reasoning_content: "计算" }, { content: "42" }]);
});

test("SSE 截断、内容改写、空结果和服务端异常立即失败", async () => {
  await assert.rejects(collect(simulatedStream(frame("STREAM_CHUNK", content("a")))), { code: "incomplete_stream" });
  await assert.rejects(collect(simulatedStream(frame("STREAM_CHUNK", content("a")) + frame("STREAM_CHUNK", content("b", false)))), { code: "replaced_stream" });
  await assert.rejects(collect(simulatedStream(end())), { code: "empty_stream" });
  await assert.rejects(collect(simulatedStream(frame("STREAM_ERROR", { error_code: 123, error_msg: "请求频繁" }))), { status: 429 });
});

test("登录异常和模型权限错误保持不同状态", () => {
  assert.equal(upstreamError({ code: 1, message: "登录失效" }).signIn, "expired");
  assert.equal(upstreamError({ code: 2, message: "模型不可用" }, 403).signIn, undefined);
});

test("账号刷新绑定真实 UID，切换桌面账号会拒绝请求", async () => {
  let current = "account-a";
  const importer = async () => ({ profile: "Profile 2", jar: new CookieJar(), clientInfo: mockClient });
  const fetcher = async url => Response.json({ data: url.pathname.includes("passport") ? { user_id_str: current } : { assistant_bot_id: "bot", config: { web_id: "device" } } });
  const a = new DesktopSession({ profile: "Profile 2", uid: "account-a" }, { importer, fetcher });
  await a.ready();
  current = "account-b";
  a.readyAt = 0;
  await assert.rejects(a.ready(), { code: "account_changed", signIn: "expired" });
  const b = new DesktopSession({ profile: "Profile 2", uid: "account-b" }, { importer, fetcher });
  await b.ready();
  assert.equal(b.uid, "account-b");
  assert.equal(a.uid, "account-a");
});

test("账号并发初始化只执行一次", async () => {
  let imports = 0;
  const session = new DesktopSession({ profile: "Default", uid: "u" }, {
    importer: async () => { imports++; return { profile: "Default", jar: new CookieJar(), clientInfo: mockClient }; },
    fetcher: async url => Response.json({ data: url.pathname.includes("passport") ? { user_id_str: "u" } : { assistant_bot_id: "b", config: { web_id: "w" } } }),
  });
  await Promise.all([session.ready(), session.ready(), session.ready()]);
  assert.equal(imports, 1);
});

test("所有请求使用桌面配置的独立设备标识与 web_id", async () => {
  const seen = [];
  const session = new DesktopSession({ profile: "Default" }, {
    importer: async () => ({ profile: "Default", jar: new CookieJar(), clientVersion: "2.32.14", clientInfo: mockClient }),
    fetcher: async url => {
      seen.push(new URL(url));
      return Response.json({ data: url.pathname.includes("passport") ? { user_id_str: "u" } : { assistant_bot_id: "b", config: { web_id: "another-web-context" } } });
    },
  });
  await session.ready();
  await session.json("/alice/message/rate_limit", {});
  assert.equal(session.webId, mockClient.webId);
  assert.equal(seen.length, 3);
  for (const url of seen) {
    assert.equal(url.searchParams.get("device_id"), mockClient.deviceId);
    assert.equal(url.searchParams.get("web_id"), mockClient.webId);
    assert.equal(url.searchParams.get("tea_uuid"), mockClient.teaUuid);
    assert.equal(url.searchParams.get("fp"), `verify_${mockClient.deviceId}`);
    assert.equal(url.searchParams.get("client_platform"), "pc_client");
    assert.equal(url.searchParams.get("chromium_version"), mockClient.chromiumVersion);
  }
});

test("缺失桌面客户端标识时在网络请求前失败", async () => {
  let requests = 0;
  const session = new DesktopSession({ profile: "Default" }, {
    importer: async () => ({ profile: "Default", jar: new CookieJar() }),
    fetcher: async () => { requests++; return Response.json({}); },
  });
  await assert.rejects(session.ready());
  assert.equal(requests, 0);
});

test("auto 导入完成后固定具体配置和 UID", async () => {
  let current = "first";
  const session = new DesktopSession({ profile: "auto" }, {
    importer: async () => ({ profile: "Profile 2", jar: new CookieJar(), clientInfo: mockClient }),
    fetcher: async url => Response.json({ data: url.pathname.includes("passport") ? { user_id_str: current } : { assistant_bot_id: "b", config: { web_id: "w" } } }),
  });
  await session.ready();
  assert.equal(session.binding.profile, "Profile 2");
  assert.equal(session.binding.uid, "first");
  current = "second";
  session.readyAt = 0;
  await assert.rejects(session.ready(), { code: "account_changed" });
});

test("不向未知主机发送会话信息", async () => {
  const session = new DesktopSession({ profile: "Default" });
  await assert.rejects(session.request("https://example.com/leak", {}), /主机不匹配/);
  const response = await chat(session, "https://example.com/v1/chat/completions", { method: "POST", body: JSON.stringify(base) });
  assert.equal(response.status, 400);
});

test("请求取消传递到网络流并删除本次临时对话", async () => {
  let signal, canceled = false;
  let deleted = false;
  const session = {
    ready: async () => {}, bot: "bot", webId: "web", uid: `mock-cancel-${randomUUID()}`, profile: "Default",
    models: async () => catalog,
    request: async (_path, _body, incoming) => {
      if (_path === "/im/conversation/batch_del_user_conv") {
        assert.equal(incoming.aborted, false);
        assert.deepEqual(_body.uplink_body.batch_delete_user_conversation_uplink_body, { conversation_id: ["123"], delete_all: false, conversation_type: 3 });
        deleted = true;
        return Response.json({ status_code: 0, downlink_body: { batch_delete_user_conversation_downlink_body: { result: { "123": true } } } });
      }
      signal = incoming;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(frame("SSE_ACK", { ack_client_meta: { conversation_id: "123", local_conversation_id: _body.client_meta.local_conversation_id, conversation_type: 3 } }) + frame("STREAM_CHUNK", content("first")))); },
        cancel() { canceled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  const messages = [{ role: "user", content: "第一问" }, { role: "assistant", content: "第一答" }, ...base.messages];
  const response = await chat(session, "https://www.doubao.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...base, messages, stream: true }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
  assert.equal(deleted, true);
});

test("实时菜单区分模型并保留独立推理强度", () => {
  assert.deepEqual(Object.values(magpieModels(catalog)).map(model => model.name), ["自动", "豆包 2.1 Lite", "豆包 2.1 Pro"]);
  for (const [id, model] of catalog) {
    const request = { ...base, model: id, reasoning_effort: "medium" };
    const body = upstreamBody({ bot: "desktop-bot" }, prepareRequest(request), selectModel(catalog, request));
    assert.equal(body.client_meta.bot_id, "desktop-bot");
    assert.equal(body.option.model_config.model_item_key, model.model_item_key);
    assert.equal(body.option.model_config.reasoning_effort, 4);
    assert.equal(body.option.need_deep_think, model.item_id);
    assert.equal(body.ext.is_finish, "1");
    assert.equal(body.option.general_task_param, undefined);
    assert.equal(body.ext.general_task_param, undefined);
    assert.equal(body.option.conversation_init_ext.agent_task_param, undefined);
    assert.ok(body.option.unique_key);
  }
  assert.equal(selectModel(catalog, base).level, 5);
  assert.throws(() => selectModel(catalog, { ...base, model: "doubao-work-thinking" }), { code: "unknown_model" });
  assert.throws(() => selectModel(catalog, { ...base, reasoning_effort: "max" }), { code: "invalid_reasoning_effort" });
});

test("模型权限按账号读取，菜单异常明确失败", () => {
  const limited = mockMenu();
  limited.entry_list[0].active_switch_conf.menu_conf_v2.mode_list.item_list[0].model_list.item_list[2].subscribe_config = { need_upgrade: true };
  assert.equal(parseModels(limited).size, 2);
  assert.equal(catalog.size, 3);
  assert.throws(() => parseModels({ entry_list: [] }), { code: "invalid_models" });
});

test("压缩文本增量与用户消息区分处理", async () => {
  const values = await collect(simulatedStream(frame("FULL_MSG_NOTIFY", { message: { user_type: 1, message_id: "user", content_block: [{ block_id: "u", content: { text_block: { text: "不要回显" } } }] } }) + frame("STREAM_CHUNK", content("A")) + frame("CHUNK_DELTA", { text: "B" }) + end()));
  assert.equal(values.map(value => value.content || "").join(""), "AB");
});
