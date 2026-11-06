import { createParser } from "eventsource-parser";
import { ProviderError, upstreamError } from "./errors.mjs";

export async function* readDoubao(response, signal, observe = async () => {}) {
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) throw upstreamError(await response.json());
  if (!response.body) throw new ProviderError("豆包返回了空事件流。", 502, "empty_stream");
  const reader = response.body.getReader(), decoder = new TextDecoder(), queue = [], blocks = new Map();
  const parser = createParser({ onEvent: event => queue.push(event), onError: error => { throw error; } });
  let finished = false, content = "", lastChunk;
  function* update(messageId, updates, operation = 2) {
    for (const block of updates || []) {
      if (!block.block_id) throw new ProviderError("豆包内容块缺少标识。", 502, "invalid_stream");
      const key = `${messageId}:${block.block_id}`, prior = blocks.get(key), type = block.patch_type || operation;
      if (type === 3 || block.is_deleted) {
        if (prior?.text) throw new ProviderError("豆包删除了已发送的内容。", 502, "replaced_stream");
        blocks.delete(key); continue;
      }
      if (![1, 2].includes(type)) throw new ProviderError(`未知内容块操作 ${type}。`, 502, "invalid_stream");
      const current = { ...prior, ...block, text: prior?.text || "" };
      blocks.set(key, current);
      const text = block.content?.text_block?.text;
      if (text === undefined) continue;
      if (typeof text !== "string") throw new ProviderError("豆包文本字段类型发生变化。", 502, "invalid_stream");
      const next = type === 1 ? current.text + text : text;
      if (!next.startsWith(current.text)) throw new ProviderError("豆包改写了已发送的内容。", 502, "replaced_stream");
      const delta = next.slice(current.text.length);
      current.text = next;
      let parent = current, reasoning = current.block_type === 10040;
      const visited = new Set();
      while (parent.parent_id) {
        if (visited.has(parent.parent_id)) throw new ProviderError("豆包内容块父级循环。", 502, "invalid_stream");
        visited.add(parent.parent_id);
        parent = blocks.get(`${messageId}:${parent.parent_id}`);
        if (!parent) throw new ProviderError("豆包内容块缺少父级。", 502, "invalid_stream");
        reasoning ||= parent.block_type === 10040;
      }
      if (delta) {
        if (!reasoning) content += delta;
        yield { [reasoning ? "reasoning_content" : "content"]: delta };
      }
    }
  }
  try {
    while (!finished) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      parser.feed(chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }));
      for (const event of queue.splice(0)) {
        if (event.event === "gateway-error") throw new ProviderError(event.data, 502, "gateway_error");
        const data = JSON.parse(event.data || "{}");
        await observe(event.event, data);
        if (event.event === "STREAM_ERROR" || data.error_code || data.error_details?.has_error) throw upstreamError({ ...data, message: data.error_msg || data.error_details?.error_message });
        if (event.event === "SSE_REPLY_END" && data.end_type === 3) { finished = true; break; }
        if (event.event === "FETCH_STREAM") throw new ProviderError("豆包要求异步任务流，当前同步请求未完成。", 502, "unexpected_async_stream");
        if (event.event === "FULL_MSG_NOTIFY" && data.message?.user_type === 2) yield* update(data.message.message_id, data.message.content_block);
        if (event.event === "STREAM_MSG_NOTIFY") yield* update(data.meta.message_id, data.content.content_block);
        if (event.event === "STREAM_CHUNK") {
          for (const patch of data.patch_op || []) if (patch.patch_object === 1) {
            yield* update(data.message_id, patch.patch_value.content_block, patch.patch_type);
            if (patch.patch_value.content_block?.length === 1) lastChunk = { message: data.message_id, block: patch.patch_value.content_block[0] };
          }
        }
        if (event.event === "CHUNK_DELTA") {
          if (!lastChunk || !lastChunk.block.content?.text_block) throw new ProviderError("豆包增量缺少文本块上下文。", 502, "invalid_stream");
          yield* update(lastChunk.message, [{ ...lastChunk.block, patch_type: 1, content: { text_block: data } }], 1);
        }
      }
      if (chunk.done) break;
    }
    if (!finished) throw new ProviderError("豆包事件流提前结束。", 502, "incomplete_stream");
    if (!content) throw new ProviderError("豆包事件流没有回复正文。", 502, "empty_stream");
    if (content.trim() === "出了点问题，请稍后重试。") throw new ProviderError(content, 502, "upstream_task_error");
  } finally {
    try { await reader.cancel(); }
    catch (error) { if (!signal?.aborted || !["AbortError", "TimeoutError"].includes(error.name)) throw error; }
    finally { reader.releaseLock(); }
  }
}
