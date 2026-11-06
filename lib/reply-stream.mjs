import { JSONParser } from "@streamparser/json";
import { decodeReply, toolReplyKind } from "./protocol.mjs";
import { ProviderError } from "./errors.mjs";

class ToolReplyStream {
  constructor(context) {
    this.context = context;
    this.raw = "";
    this.sent = "";
    this.kind = "pending";
  }

  push(text) {
    this.raw += text;
    let input = text;
    if (this.kind === "pending") {
      this.kind = toolReplyKind(this.raw);
      input = this.raw;
      if (this.kind === "json") {
        this.parser = new JSONParser({ paths: ["$.content"], emitPartialTokens: true, emitPartialValues: true });
        this.parser.onValue = ({ key, stack, value, partial }) => {
          if (key !== "content" || stack.length !== 1) return;
          if (partial && value === undefined) return;
          if (typeof value !== "string") throw new ProviderError("工具回复的 content 必须是字符串。", 502, "invalid_tool_response");
          if (this.contentComplete) throw new ProviderError("工具回复包含重复的 content 字段。", 502, "invalid_tool_response");
          if (!value.startsWith(this.sent)) throw new ProviderError("豆包改写了已发送的回复正文。", 502, "invalid_tool_response");
          this.content = value;
          this.contentComplete = !partial;
        };
      }
    }
    if (this.kind === "pending") return "";
    if (this.kind === "invalid") throw new ProviderError("豆包未遵守工具回复格式：需要普通文字或完整 JSON 工具对象。", 502, "invalid_tool_response");
    if (this.kind === "plain") {
      if (this.context.request.tool_choice === "required" || typeof this.context.request.tool_choice === "object")
        throw new ProviderError("豆包没有返回要求的工具调用。", 502, "invalid_tool_response");
      this.content = this.raw;
    } else {
      try { this.parser.write(input); }
      catch (cause) {
        if (cause instanceof ProviderError) throw cause;
        throw new ProviderError(`豆包未遵守工具回复格式：${cause.message}`, 502, "invalid_tool_response", { cause });
      }
    }
    // UTF-16 的高位代理字符留到下一块，避免 SSE 编码时损坏表情。
    let content = this.content || "";
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    const delta = content.slice(this.sent.length);
    this.sent = content;
    return delta;
  }

  finish() {
    const message = decodeReply(this.raw, this.context);
    if (!(message.content || "").startsWith(this.sent)) throw new ProviderError("最终正文与已发送内容不一致。", 502, "invalid_tool_response");
    return { content: (message.content || "").slice(this.sent.length), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  }
}

export async function* replyDeltas(source, context) {
  const tools = context.toolsEnabled && !context.structured ? new ToolReplyStream(context) : undefined;
  let buffered = "";
  for await (const delta of source) {
    if (delta.reasoning_content) yield { reasoning_content: delta.reasoning_content };
    if (!delta.content) continue;
    if (tools) {
      const content = tools.push(delta.content);
      if (content) yield { content };
    } else if (context.buffered) buffered += delta.content;
    else yield { content: delta.content };
  }
  // source 完成意味着上游结束且临时资源已清理。此时才提交完整工具调用。
  const message = tools ? tools.finish() : context.buffered ? decodeReply(buffered, context) : {};
  if (message.content || message.tool_calls) yield { ...(message.content ? { content: message.content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  yield { finish_reason: message.tool_calls ? "tool_calls" : "stop" };
}
