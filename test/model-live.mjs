import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createParser } from "eventsource-parser";
import { DesktopSession } from "../lib/session.mjs";
import { chat } from "../lib/chat.mjs";

const work = resolve(process.env.DOUBAO_WORK_TEST_DIR || "../../.scratch/live");
await mkdir(work, { recursive: true });
process.env.XDG_CACHE_HOME ||= resolve(work, "cache");
const observations = [];
let trace;
const session = new DesktopSession({ profile: process.env.DOUBAO_WORK_PROFILE || "auto" }, { fetcher: async (url, init) => {
  const response = await fetch(url, init);
  if (url.pathname === "/chat/completion") {
    const sent = JSON.parse(init.body);
    const item = { modelKey: sent.option.model_config.model_item_key, effort: sent.option.model_config.reasoning_effort, sentType: sent.option.need_deep_think, receivedTypes: [] };
    observations.push(item);
    trace = (async () => {
      const parser = createParser({ onEvent(event) {
        if (event.event !== "STREAM_MSG_NOTIFY") return;
        const data = JSON.parse(event.data);
        if (data.content?.ext?.need_deep_think !== undefined) item.receivedTypes.push(Number(data.content.ext.need_deep_think));
      } });
      const decoder = new TextDecoder();
      for await (const chunk of response.clone().body) parser.feed(decoder.decode(chunk, { stream: true }));
      parser.feed(decoder.decode());
    })();
  }
  return response;
} });
const catalog = await session.models();
const expected = [["doubao-work-auto", "9", "low", 3], ["doubao-work-lite", "seed-lite-7b", "medium", 4], ["doubao-work-pro", "5", "high", 5]];
const requested = process.env.DOUBAO_WORK_TEST_MODEL;
const selected = requested ? expected.filter(([id]) => id === requested) : expected;
assert.ok(selected.length, "指定的测试模型不存在");
for (const [model, key, reasoning_effort, level] of selected) {
  assert.equal(catalog.get(model).model_item_key, key);
  const response = await chat(session, "https://www.doubao.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, reasoning_effort, messages: [{ role: "user", content: "只回复 MODEL_SELECTION_OK。" }] }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match((await response.json()).choices[0].message.content, /MODEL_SELECTION_OK/);
  await trace;
  const observation = observations.at(-1);
  observation.model = model;
  assert.equal(observation.modelKey, key);
  assert.equal(observation.effort, level);
  assert.ok(observation.receivedTypes.includes(observation.sentType), "服务端未确认所选模型类型");
  console.log(JSON.stringify({ model, passed: true, ...observation }));
}
await writeFile(resolve(work, requested ? `model-report-${requested}.json` : "model-report.json"), JSON.stringify({ time: new Date().toISOString(), observations }, null, 2));
