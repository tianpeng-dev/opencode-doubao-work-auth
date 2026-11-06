import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationLease } from "../lib/conversations.mjs";
import { ProviderError } from "../lib/errors.mjs";

// 模拟 IM 接口仅验证清理边界和故障恢复，真实删除由账号集成测试验证。
async function fixture(t) {
  const parent = resolve(process.env.DOUBAO_WORK_TEST_DIR || "../../.scratch/unit");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fail = false, attachmentFailure = false;
  const calls = [], conversations = [];
  const session = { uid: "mock-user", profile: "Default", bot: "mock-bot", request: async (path, body, signal, _params, headers) => {
    assert.equal(signal.aborted, false);
    calls.push({ path, body });
    if (path === "/alice/resource/delete_files") return Response.json(attachmentFailure ? { code: 456, message: "模拟附件删除失败" } : { code: 0 });
    assert.equal(headers["Content-Type"], "application/json; encoding=utf-8");
    if (path === "/im/conversation/batch_del_user_conv") {
      if (fail) throw new ProviderError("测试用网络失败：E_SOCKET", 502, "upstream_error");
      const deletion = body.uplink_body.batch_delete_user_conversation_uplink_body;
      assert.equal(deletion.delete_all, false);
      assert.equal(deletion.conversation_id.length, 1);
      return Response.json({ status_code: 0, downlink_body: { batch_delete_user_conversation_downlink_body: { result: { [deletion.conversation_id[0]]: true } } } });
    }
    assert.equal(path, "/im/chain/recent_conv");
    assert.equal(typeof body.uplink_body.pull_recent_conv_chain_uplink_body.conv_version, "number");
    return Response.json({ status_code: 0, downlink_body: { pull_recent_conv_chain_downlink_body: { user_id: session.uid, cells: conversations.map(conversation => ({ conversation })), has_more: false } } });
  } };
  const localId = `local_${randomUUID().replaceAll("-", "")}`;
  const lease = new ConversationLease(session, { client_meta: { local_conversation_id: localId } }, { directory });
  const ack = { ack_client_meta: { conversation_id: "123", local_conversation_id: localId, conversation_type: 3 } };
  return { directory, session, lease, ack, calls, conversations, setFailure(value) { fail = value; }, setAttachmentFailure(value) { attachmentFailure = value; } };
}

test("只删除 ACK 确认归属的一个会话，重复清理只发送一次", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await f.lease.observe("SSE_ACK", f.ack);
  await Promise.all([f.lease.finish(), f.lease.finish()]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.uplink_body.batch_delete_user_conversation_uplink_body.conversation_id, ["123"]);
  assert.deepEqual(await readdir(f.directory), []);
});

test("其他会话的 ACK 不会被登记或删除", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await assert.rejects(f.lease.observe("SSE_ACK", { ack_client_meta: { ...f.ack.ack_client_meta, local_conversation_id: "unrelated" } }), { code: "conversation_ownership_error" });
  await f.lease.finish();
  assert.ok(f.calls.every(call => call.path !== "/im/conversation/batch_del_user_conv"));
});

test("取消前未收到 ACK 时按完整 local_conversation_id 查找", async t => {
  const f = await fixture(t);
  f.conversations.push({ conversation_id: "999", bot_id: f.session.bot, conv_extra: { local_conversation_id: "other" } });
  f.conversations.push({ conversation_id: "123", bot_id: f.session.bot, conv_extra: { local_conversation_id: f.lease.record.localId } });
  await f.lease.begin();
  await f.lease.finish(new DOMException("请求取消", "AbortError"));
  const deletion = f.calls.find(call => call.path.includes("batch_del"));
  assert.deepEqual(deletion.body.uplink_body.batch_delete_user_conversation_uplink_body.conversation_id, ["123"]);
});

test("清理失败保留恢复记录和原始错误，下次请求先完成清理", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await f.lease.observe("SSE_ACK", f.ack);
  f.setFailure(true);
  await assert.rejects(f.lease.finish(new Error("原请求中断")), error => error.code === "conversation_cleanup_failed" && error.message.includes("E_SOCKET") && error.message.includes("原请求中断"));
  const saved = JSON.parse(await readFile(f.lease.file, "utf8"));
  assert.equal(saved.retry, true);
  assert.equal(saved.conversationId, "123");
  f.setFailure(false);
  const next = new ConversationLease(f.session, { client_meta: { local_conversation_id: `local_${randomUUID().replaceAll("-", "")}` } }, { directory: f.directory });
  await next.begin();
  assert.equal(f.calls.filter(call => call.path.includes("batch_del")).length, 2);
  assert.deepEqual(await readdir(f.directory), [next.record.localId + ".json"]);
  await next.finish();
});

test("并发会话保留各自清理记录，已过期进程记录会被恢复", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await f.lease.observe("SSE_ACK", f.ack);
  const other = new ConversationLease(f.session, { client_meta: { local_conversation_id: `local_${randomUUID().replaceAll("-", "")}` } }, { directory: f.directory });
  await other.begin();
  assert.equal(f.calls.length, 0);
  await other.finish();
  await f.lease.finish();
  const stale = { ...f.lease.record, startedAt: Date.now() - 400000, conversationId: "456" };
  await writeFile(f.lease.file, JSON.stringify(stale));
  const next = new ConversationLease(f.session, { client_meta: { local_conversation_id: `local_${randomUUID().replaceAll("-", "")}` } }, { directory: f.directory });
  await next.begin();
  assert.ok(f.calls.some(call => call.body.uplink_body.batch_delete_user_conversation_uplink_body?.conversation_id[0] === "456"));
  await next.finish();
});

test("会话和附件分别清理，任一失败会保留记录供后续恢复", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await f.lease.addAttachment("owned/history.md");
  await f.lease.observe("SSE_ACK", f.ack);
  f.setAttachmentFailure(true);
  await assert.rejects(f.lease.finish(), /模拟附件删除失败/);
  assert.ok(f.calls.some(call => call.path.includes("batch_del")));
  const record = JSON.parse(await readFile(f.lease.file, "utf8"));
  assert.deepEqual(record.attachments, ["owned/history.md"]);
  f.setAttachmentFailure(false);
  const next = new ConversationLease(f.session, { client_meta: { local_conversation_id: `local_${randomUUID().replaceAll("-", "")}` } }, { directory: f.directory });
  await next.begin();
  assert.equal(f.calls.filter(call => call.path.endsWith("delete_files")).length, 2);
  await next.finish();
  assert.deepEqual(await readdir(f.directory), []);
});

test("确认前断线保留标识，稍后创建的会话按完整标识恢复删除", async t => {
  const f = await fixture(t);
  await f.lease.begin();
  await assert.rejects(f.lease.finish(new DOMException("模拟连接取消", "AbortError")), { code: "conversation_cleanup_failed" });
  const record = JSON.parse(await readFile(f.lease.file, "utf8"));
  assert.ok(record.uncertainUntil > Date.now());
  f.conversations.push({ conversation_id: "123", bot_id: f.session.bot, conv_extra: { local_conversation_id: record.localId } });
  const next = new ConversationLease(f.session, { client_meta: { local_conversation_id: `local_${randomUUID().replaceAll("-", "")}` } }, { directory: f.directory });
  await next.begin();
  assert.ok(f.calls.some(call => call.body.uplink_body?.batch_delete_user_conversation_uplink_body?.conversation_id[0] === "123"));
  await next.finish();
  assert.deepEqual(await readdir(f.directory), []);
});
