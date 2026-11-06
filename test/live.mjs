import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import { DoubaoWorkPlugin } from "../index.mjs";

const work = resolve(process.env.DOUBAO_WORK_TEST_DIR || "../../.scratch/live");
await mkdir(work, { recursive: true, mode: 0o700 });
process.env.XDG_CACHE_HOME ||= resolve(work, "cache");
const hooks = await DoubaoWorkPlugin();
const login = await hooks.auth.methods[0].authorize({ profile: process.env.DOUBAO_WORK_PROFILE || "auto" });
assert.equal(login.type, "success");
const auth = { ...login, type: "api" };
const getAuth = async () => auth;
const loader = await hooks.auth.loader(getAuth);
const report = { time: new Date().toISOString(), checks: [] };
function passed(name, details = {}) { report.checks.push({ name, passed: true, ...details }); console.log(JSON.stringify({ name, passed: true, ...details })); }

async function call(body, signal) {
  const response = await loader.fetch("https://www.doubao.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "doubao-work-lite", reasoning_effort: "low", ...body }), signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!body.stream) return (await response.json()).choices[0];
  const events = [];
  const parser = createParser({ onEvent: event => { if (event.data !== "[DONE]") events.push(JSON.parse(event.data)); } });
  const decoder = new TextDecoder();
  for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }));
  parser.feed(decoder.decode());
  for (const event of events) if (event.error) throw new Error(event.error.message);
  return {
    message: {
      content: events.map(event => event.choices[0].delta.content || "").join(""),
      reasoning_content: events.map(event => event.choices[0].delta.reasoning_content || "").join(""),
      tool_calls: events.flatMap(event => event.choices[0].delta.tool_calls || []),
    },
    chunks: events.filter(event => event.choices[0].delta.content).length,
    finish_reason: events.at(-1)?.choices[0].finish_reason,
  };
}

const usage = await hooks.auth.usage(getAuth);
assert.ok(!usage.error, usage.error);
assert.ok(usage.windows.length);
passed("真实订阅额度", { plan: usage.plan, windows: usage.windows.map(({ name, amount, limit, used }) => ({ name, amount, limit, used })) });

const plain = await call({ messages: [{ role: "user", content: "只输出 MAGPIE_STREAM_OK，每个字符保持原样。" }], stream: true });
assert.match(plain.message.content, /MAGPIE_STREAM_OK/);
assert.equal(plain.finish_reason, "stop");
assert.ok(plain.chunks >= 1);
passed("真实流式对话", { contentChunks: plain.chunks });

const history = await call({ messages: [
  { role: "system", content: "任何回复只包含用户指定的代号，不添加其他文字。" },
  { role: "user", content: "记住代号 AZ7Q29。" },
  { role: "assistant", content: "AZ7Q29" },
  { role: "user", content: "现在回复我之前指定的代号。" },
] });
assert.equal(history.message.content.trim(), "AZ7Q29");
passed("system 指令和多轮历史");

const thinking = await call({ model: "doubao-work-pro", reasoning_effort: "high", messages: [{ role: "user", content: "计算 127 乘 43，只给出最终结果。" }], stream: true });
assert.match(thinking.message.content, /5461/);
passed("Pro 高强度推理", { reasoningCharacters: thinking.message.reasoning_content.length });

const secret = randomUUID();
const inputFile = resolve(work, "tool-input.txt"), outputFile = resolve(work, "tool-output.txt");
await writeFile(inputFile, secret, { mode: 0o600 });
const readTool = { type: "function", function: { name: "read_file", description: "读取指定文件的全部内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const toolMessages = [{ role: "user", content: `使用 read_file 读取 ${inputFile}，然后把得到的内容原样告诉我。` }];
const read = await call({ messages: toolMessages, tools: [readTool], tool_choice: "required", parallel_tool_calls: false, stream: true });
assert.equal(read.finish_reason, "tool_calls");
assert.equal(read.message.tool_calls.length, 1);
const tc = read.message.tool_calls[0];
assert.equal(tc.function.name, "read_file");
assert.equal(JSON.parse(tc.function.arguments).path, inputFile);
const result = await readFile(inputFile, "utf8");
const continued = await call({ messages: [...toolMessages, { role: "assistant", content: read.message.content, tool_calls: [tc] }, { role: "tool", tool_call_id: tc.id, content: result }], tools: [readTool], tool_choice: "none" });
assert.ok(continued.message.content.includes(secret));
passed("工具调用、实际文件读取与结果续接");

const writeTool = { type: "function", function: { name: "write_file", description: "写入指定文件", parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"], additionalProperties: false } } };
const written = await call({ messages: [{ role: "user", content: `用 write_file 向 ${outputFile} 写入 MAGPIE_WRITE_OK。` }], tools: [writeTool], tool_choice: { type: "function", function: { name: "write_file" } } });
const writeArgs = JSON.parse(written.message.tool_calls[0].function.arguments);
assert.equal(writeArgs.path, outputFile);
assert.equal(writeArgs.text, "MAGPIE_WRITE_OK");
await writeFile(outputFile, writeArgs.text, { mode: 0o600 });
assert.equal(await readFile(outputFile, "utf8"), "MAGPIE_WRITE_OK");
passed("指定工具与实际文件写入");

const json = await call({ messages: [{ role: "user", content: "返回 ok=true。" }], response_format: { type: "json_schema", json_schema: { name: "check", schema: { type: "object", properties: { ok: { const: true } }, required: ["ok"], additionalProperties: false } } } });
assert.deepEqual(JSON.parse(json.message.content), { ok: true });
passed("JSON Schema 回复");

const abort = new AbortController();
const response = await loader.fetch("https://www.doubao.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "doubao-work-lite", reasoning_effort: "low", stream: true, messages: [{ role: "user", content: "按顺序列出 1 至 500，每个数字单独一行。" }] }), signal: abort.signal });
assert.equal(response.status, 200);
const reader = response.body.getReader();
await reader.read();
abort.abort();
await reader.cancel();
passed("客户端取消真实流式请求", { serverTaskStopped: "未验证" });
await writeFile(resolve(work, "report.json"), JSON.stringify(report, null, 2));
