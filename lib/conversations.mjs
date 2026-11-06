import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderError } from "./errors.mjs";
import { deleteAttachments } from "./attachments.mjs";

const active = new Set();
const recordSchema = z.object({ localId: z.string().regex(/^local_[a-f0-9]{32}$/), bot: z.string().min(1), conversationId: z.string().regex(/^[1-9]\d*$/).optional(), attachments: z.array(z.string().min(1)).optional(), startedAt: z.number(), pid: z.number().int().positive(), retry: z.boolean().optional(), uncertainUntil: z.number().optional() }).strict();

async function im(session, path, cmd, key, body) {
  const response = await session.request(path, {
    cmd, sequence_id: randomUUID(), channel: 2, version: "1", uplink_body: { [key]: body },
  }, AbortSignal.timeout(30000), {}, { "Content-Type": "application/json; encoding=utf-8" });
  const data = await response.json();
  if (data.status_code !== 0) throw new ProviderError(`豆包会话接口失败：${data.status_desc || "未知错误"}（${data.status_code}）`, 502, "conversation_api_error");
  if (!data.downlink_body) throw new ProviderError("豆包会话接口缺少响应数据。", 502, "invalid_conversation_response");
  return data.downlink_body;
}

async function findOwned(session, record) {
  let cursor = "0";
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await im(session, "/im/chain/recent_conv", 3200, "pull_recent_conv_chain_uplink_body", {
      api_version: 1, conv_version: Number(cursor), direction: cursor === "0" ? 3 : 1, limit: 50, message_count_per_conv: 0,
      option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: true, need_coco_bot: true },
    });
    const chain = data.pull_recent_conv_chain_downlink_body;
    if (chain?.user_id !== session.uid) throw new ProviderError("临时对话清理账号校验失败。", 401, "account_changed");
    if (!Array.isArray(chain?.cells) || typeof chain.has_more !== "boolean") throw new ProviderError("豆包历史列表格式发生变化。", 502, "invalid_conversation_response");
    for (const cell of chain.cells) {
      const conversation = cell.conversation;
      if (conversation?.conv_extra?.local_conversation_id === record.localId) {
        if (conversation.bot_id !== record.bot || !/^[1-9]\d*$/.test(conversation.conversation_id)) throw new ProviderError("临时对话归属校验失败。", 502, "conversation_ownership_error");
        return conversation.conversation_id;
      }
    }
    if (!chain.has_more) return undefined;
    cursor = String(chain.next_conv_version);
    if (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || seen.has(cursor)) throw new ProviderError("豆包历史列表分页游标无效。", 502, "invalid_conversation_response");
    seen.add(cursor);
  }
  throw new ProviderError("临时对话恢复超过历史查询范围，清理记录已保留。", 502, "conversation_cleanup_failed");
}

async function removeOwned(session, record) {
  const id = record.conversationId || await findOwned(session, record);
  if (!id) return false;
  const data = await im(session, "/im/conversation/batch_del_user_conv", 4171, "batch_delete_user_conversation_uplink_body", {
    conversation_id: [id], delete_all: false, conversation_type: 3,
  });
  const result = data.batch_delete_user_conversation_downlink_body?.result;
  if (!result || typeof result[id] !== "boolean") throw new ProviderError("豆包未确认临时对话的删除结果。", 502, "conversation_cleanup_failed");
  if (!result[id] && await findOwned(session, record)) throw new ProviderError("豆包未删除临时对话，清理记录已保留。", 502, "conversation_cleanup_failed");
  return true;
}

async function removeResources(session, record) {
  const results = await Promise.allSettled([removeOwned(session, record), deleteAttachments(session, record.attachments)]);
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join("；"));
  return results[0].value;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export class ConversationLease {
  constructor(session, body, { directory } = {}) {
    if (!session.uid || !session.profile) throw new Error("临时对话必须绑定已验证的桌面账号。");
    // 固定本次登录的 Cookie 对象，其他调用刷新桌面账号时不会改变清理账号。
    this.session = Object.assign(Object.create(Object.getPrototypeOf(session)), session);
    const owner = createHash("sha256").update(`${session.profile}:${session.uid}`).digest("hex");
    this.directory = directory || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "doubao-work-magpie", "conversations", owner);
    this.record = recordSchema.parse({ localId: body.client_meta.local_conversation_id, bot: session.bot, startedAt: Date.now(), pid: process.pid });
    this.file = join(this.directory, `${this.record.localId}.json`);
  }

  async persist() {
    const temp = `${this.file}.${randomUUID()}.part`;
    await writeFile(temp, JSON.stringify(this.record), { mode: 0o600, flag: "wx" });
    await rename(temp, this.file);
  }

  async begin() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^local_[a-f0-9]{32}\.json$/.test(name)) continue;
      const file = join(this.directory, name);
      if (active.has(file)) continue;
      let raw;
      try { raw = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const record = recordSchema.parse(JSON.parse(raw));
      if (`${record.localId}.json` !== name || record.bot !== this.record.bot) throw new Error("临时对话恢复记录归属不匹配。");
      if (!record.retry && Date.now() - record.startedAt < 300000 && processAlive(record.pid)) continue;
      const removed = await removeResources(this.session, record);
      if (!removed && record.uncertainUntil > Date.now()) continue;
      try { await unlink(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    active.add(this.file);
    try { await this.persist(); this.started = true; }
    catch (error) { active.delete(this.file); throw error; }
  }

  async observe(event, data) {
    if (event !== "SSE_ACK") return;
    const meta = data.ack_client_meta;
    if (meta?.local_conversation_id !== this.record.localId || meta.conversation_type !== 3 || !/^[1-9]\d*$/.test(meta.conversation_id))
      throw new ProviderError("豆包确认的临时对话与本次请求不匹配。", 502, "conversation_ownership_error");
    if (this.record.conversationId && this.record.conversationId !== meta.conversation_id) throw new ProviderError("豆包返回了多个临时对话标识。", 502, "conversation_ownership_error");
    if (!this.record.conversationId) {
      this.record.conversationId = meta.conversation_id;
      await this.persist();
    }
  }

  async addAttachment(uri) {
    if (!this.started || this.cleanup) throw new Error("附件必须登记到正在处理的请求。");
    this.record.attachments = [...new Set([...(this.record.attachments || []), uri])];
    await this.persist();
  }

  async finish(originalError) {
    if (!this.started) return;
    this.cleanup ??= (async () => {
      try {
        const removed = await removeResources(this.session, this.record);
        if (!removed && originalError && (!(originalError instanceof ProviderError) || ["incomplete_stream", "invalid_stream"].includes(originalError.code))) {
          this.record.uncertainUntil = Date.now() + 180000;
          throw new Error("请求在确认会话之前中断，已保留本次标识供后续请求核查。");
        }
        await unlink(this.file);
      } catch (cause) {
        this.record.retry = true;
        const errors = [cause];
        try { await this.persist(); } catch (error) { errors.push(error); }
        if (originalError) errors.push(originalError);
        throw new ProviderError(`临时资源清理失败：${errors.map(error => error.message).join("；")}`, 502, "conversation_cleanup_failed", { cause: new AggregateError(errors) });
      } finally { active.delete(this.file); }
    })();
    return this.cleanup;
  }
}
