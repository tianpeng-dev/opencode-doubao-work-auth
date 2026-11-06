import { randomUUID } from "node:crypto";
import { prepareRequest, decodeReply, upstreamBody } from "./protocol.mjs";
import { readDoubao } from "./modern-stream.mjs";
import { selectModel } from "./models.mjs";
import { ProviderError, errorResponse } from "./errors.mjs";
import { BASE } from "./session.mjs";
import { ConversationLease } from "./conversations.mjs";
import { prepareHistoryUpload, uploadHistory } from "./attachments.mjs";
import { replyDeltas } from "./reply-stream.mjs";

export async function chat(session, input, init = {}) {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== BASE || url.pathname !== "/v1/chat/completions" || req.method !== "POST")
    return errorResponse(new ProviderError("插件仅支持 POST /v1/chat/completions。", 400, "unsupported_endpoint"));
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(180000)]);
  let lease;
  try {
    let body;
    try { body = await req.json(); }
    catch (cause) { throw new ProviderError(`请求不是有效 JSON：${cause.message}`, 400, "invalid_json", { cause }); }
    const context = prepareRequest(body);
    await session.ready(signal);
    const [catalog, uploadToken] = await Promise.all([session.models(signal), context.attachment ? prepareHistoryUpload(session, signal) : undefined]);
    const selected = selectModel(catalog, context.request);
    const upstream = upstreamBody(session, context, selected);
    lease = new ConversationLease(session, upstream);
    await lease.begin();
    if (context.attachment) upstream.messages[0].content_block.unshift(await uploadHistory(lease.session, context.attachment, upstream.messages[0].local_message_id, lease, signal, uploadToken));
    const response = await session.request("/chat/completion", upstream, signal, {}, { Accept: "text/event-stream" });
    async function* tracked() {
      let failure;
      try { yield* readDoubao(response, signal, (event, data) => lease.observe(event, data)); }
      catch (error) { failure = error; throw error; }
      finally { await lease.finish(failure); }
    }
    const source = tracked();
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000), model = context.request.model;
    let content = "", reasoning = "";
    if (!context.request.stream) {
      for await (const delta of source) { content += delta.content || ""; reasoning += delta.reasoning_content || ""; }
      const message = decodeReply(content, context);
      if (reasoning) message.reasoning_content = reasoning;
      const reason = message.tool_calls ? "tool_calls" : "stop";
      return Response.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: reason }] });
    }
    const iterator = replyDeltas(source, context);
    // 先取得首个有效块，便于把开始阶段的服务端错误作为 HTTP 错误返回。
    const first = await iterator.next();
    async function* live() {
      try {
        yield { role: "assistant", content: "" };
        if (!first.done) yield first.value;
        yield* iterator;
      } finally { await iterator.return(); }
    }
    return sseResponse(live(), { id, created, model }, abort, () => iterator.return());
  } catch (error) {
    abort.abort();
    try { await lease?.finish(error); }
    catch (cleanupError) { return errorResponse(cleanupError); }
    return errorResponse(error);
  }
}

function sseResponse(iterator, meta, abort, close) {
  const encoder = new TextEncoder();
  let canceled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (canceled) return;
        if (done) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
        const finish = value.finish_reason || null;
        const delta = finish ? {} : { ...value };
        if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }));
        const chunk = { ...meta, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      } catch (error) {
        abort.abort();
        if (canceled) return;
        if (error instanceof ProviderError) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message, type: error.code, code: error.code } })}\n\n`));
          controller.close();
        } else controller.error(error);
      }
    },
    async cancel() {
      canceled = true;
      abort.abort();
      try { await iterator.return(); await close(); }
      catch (error) { if (!["AbortError", "TimeoutError"].includes(error.name)) throw error; }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
}
