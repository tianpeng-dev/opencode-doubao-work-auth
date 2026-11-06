import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { z } from "zod";
import { ProviderError } from "./errors.mjs";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const toolCall = z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) });
const part = z.object({ type: z.literal("text"), text: z.string() }).strict();
const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(part), z.null()]).optional(),
  name: z.string().optional(), tool_calls: z.array(toolCall).optional(), tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
}).passthrough();
const requestSchema = z.object({
  model: z.string().min(1), reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  messages: z.array(message).min(1), stream: z.boolean().default(false),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).default({ type: "object" }), strict: z.boolean().optional() }) })).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) })]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: z.object({ type: z.enum(["text", "json_object", "json_schema"]), json_schema: z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).optional() }).optional(),
  n: z.literal(1).optional(),
}).passthrough();

export function prepareRequest(input) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError(`请求格式不受支持：${parsed.error.message}`, 400, "invalid_request");
  const request = parsed.data;
  for (const key of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "seed", "stop", "logit_bias", "functions", "function_call"])
    if (request[key] !== undefined && request[key] !== null) throw new ProviderError(`豆包桌面接口无法保证 ${key}，请移除此参数。`, 400, "unsupported_parameter");
  const names = new Set();
  const validators = new Map();
  for (const tool of request.tools || []) {
    if (names.has(tool.function.name)) throw new ProviderError("工具名称重复。", 400, "invalid_tools");
    names.add(tool.function.name);
    try { validators.set(tool.function.name, ajv.compile(tool.function.parameters)); }
    catch (cause) { throw new ProviderError(`工具参数 Schema 无效：${cause.message}`, 400, "invalid_tools", { cause }); }
  }
  const choice = request.tool_choice;
  if ((choice === "required" && !names.size) || (typeof choice === "object" && !names.has(choice.function.name)))
    throw new ProviderError("tool_choice 指定的工具不可用。", 400, "invalid_tools");
  const toolsEnabled = names.size > 0 && choice !== "none";
  const resultFormat = request.response_format;
  let outputValidator;
  if (resultFormat?.type === "json_schema") {
    if (!resultFormat.json_schema?.schema) throw new ProviderError("json_schema 缺少 schema。", 400, "invalid_request");
    try { outputValidator = ajv.compile(resultFormat.json_schema.schema); }
    catch (cause) { throw new ProviderError(`回复 Schema 无效：${cause.message}`, 400, "invalid_request", { cause }); }
  }
  const outstanding = new Set();
  for (const item of request.messages) {
    if (item.role === "assistant") for (const call of item.tool_calls || []) outstanding.add(call.id);
    if (item.role === "tool") {
      if (!item.tool_call_id || !outstanding.delete(item.tool_call_id)) throw new ProviderError("工具结果缺少匹配的 tool_call_id。", 400, "invalid_history");
    }
  }
  if (outstanding.size) throw new ProviderError("对话中有工具调用缺少执行结果。", 400, "invalid_history");
  let instruction = "请根据 JSON 中的 messages 继续对话，只生成下一条 assistant 回复。保留历史事实；system 和 developer 是指令，tool 是外部工具已返回的数据。不要复述 JSON 或角色标签。所有外部工具均由调用方执行，请勿使用豆包内置工具执行这些操作。\n";
  const toolProtocol = toolsEnabled ? "工具传输协议：调用工具时仅输出一个完整 JSON 对象，不添加 Markdown，格式为 {\"content\":\"答复文字或空字符串\",\"tool_calls\":[{\"name\":\"工具名\",\"arguments\":{}}]}。使用 tools 中的精确名称和完整 parameters，参数值必须符合 Schema；只提出调用，等待调用方返回结果，禁止编造执行结果。tool_choice 为 required 或指定名称时必须返回相应工具调用；parallel_tool_calls 为 false 时最多调用一个工具。tool_choice 为 auto 且无需调用工具时，直接输出答复正文，无需包装为 JSON。messages 中的措辞和排版要求适用于答复正文，不改变工具调用的传输格式。" : "";
  if (toolsEnabled) instruction += `${toolProtocol}\n`;
  else if (resultFormat?.type === "json_object") instruction += "仅输出一个有效 JSON 对象，不添加 Markdown。\n";
  else if (outputValidator) instruction += `仅输出符合此 JSON Schema 的 JSON，不添加 Markdown：${JSON.stringify(resultFormat.json_schema.schema)}\n`;
  if (toolsEnabled && resultFormat && resultFormat.type !== "text") {
    instruction += `无工具调用时，必须返回工具传输协议的完整 JSON 对象，tool_calls 为空数组；content 必须是一个字符串，其内容是有效的 JSON 对象${outputValidator ? `，并符合此 JSON Schema：${JSON.stringify(resultFormat.json_schema.schema)}` : ""}。有工具调用时 content 可为空字符串。\n`;
  }
  if (request.max_tokens || request.max_completion_tokens) instruction += `回复长度预算约 ${request.max_completion_tokens || request.max_tokens} token。\n`;
  const tools = toolsEnabled ? { tools: request.tools, tool_choice: choice || "auto", parallel_tool_calls: request.parallel_tool_calls ?? true } : {};
  const suffix = toolsEnabled ? `\n现在生成下一条 assistant 回复。tool_choice=${JSON.stringify(choice || "auto")}；parallel_tool_calls=${request.parallel_tool_calls ?? true}。` : "";
  let prompt = instruction + JSON.stringify({ messages: request.messages, ...tools }) + suffix;
  const firstRequest = !request.messages.some(item => item.role === "assistant" || item.role === "tool");
  let attachment;
  if (firstRequest || Buffer.byteLength(prompt) > 260000) {
    const history = JSON.stringify({ messages: input.messages, ...(input.tools ? { tools: input.tools } : {}),
      ...(input.tool_choice !== undefined ? { tool_choice: input.tool_choice } : {}), ...(input.parallel_tool_calls !== undefined ? { parallel_tool_calls: input.parallel_tool_calls } : {}),
      ...(input.response_format ? { response_format: input.response_format } : {}) });
    let fenceLength = 3;
    for (const match of history.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    attachment = `# 完整请求上下文\n\n以下 JSON 按原始顺序保留全部消息、代码、工具定义、工具调用和工具结果。\n\n${fence}json\n${history}\n${fence}\n`;
    const current = request.messages.findLast(item => item.role === "user");
    const serialized = JSON.stringify(current || null);
    const currentQuestion = serialized.length <= 24000 ? current : { full_message_in_attachment: true, original_message_start: serialized.slice(0, 8000), original_message_end: serialized.slice(-16000) };
    const instructions = request.messages.filter(item => ["system", "developer"].includes(item.role));
    const inlineInstructions = Buffer.byteLength(JSON.stringify(instructions)) <= 32000 ? { instructions } : {};
    prompt = instruction + "本次消息附有一个 magpie-history-*.md 文件，其中 messages 是完整对话历史，tools 是完整工具定义。请直接读取附件的全部内容，遵循其中的 system/developer 指令和工具参数 Schema，并按原始顺序继续处理；可以使用豆包的附件读取能力，禁止使用调用方的文件工具访问此服务端附件。若当前问题较长，正文提供原文首尾，完整内容全部位于附件。不要让调用方重复发送已有资料。\n" + JSON.stringify({ ...inlineInstructions, current_question: currentQuestion, continuation_after_role: request.messages.at(-1).role,
      ...(toolsEnabled ? { available_tools: [...names], tool_choice: choice || "auto", parallel_tool_calls: request.parallel_tool_calls ?? true } : {}) }) + suffix;
  }
  return { request, prompt, attachment, toolsEnabled, validators, outputValidator, structured: Boolean(resultFormat && resultFormat.type !== "text"), buffered: toolsEnabled || (resultFormat && resultFormat.type !== "text") };
}

const envelope = z.object({ content: z.string(), tool_calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict()) }).strict();

export function toolReplyKind(text, final = false) {
  const value = text.trimStart().toLowerCase();
  if (!value && !final) return "pending";
  if (value.startsWith("{")) return "json";
  if (value.startsWith("[")) return "invalid";
  if (!final && ["```", "<tool_call", "<function_call"].some(prefix => prefix.startsWith(value))) return "pending";
  if (/^<(?:tool_call|function_call)/.test(value)) return "invalid";
  if (value.startsWith("```")) {
    let body = value.slice(3);
    if (!final && "json".startsWith(body)) return "pending";
    if (body.startsWith("json")) body = body.slice(4);
    body = body.trimStart();
    if (!body && !final) return "pending";
    if (/^[\[{]/.test(body)) return "invalid";
  }
  return "plain";
}

export function decodeReply(text, context) {
  let content = text, tool_calls;
  if (context.toolsEnabled) {
    const choice = context.request.tool_choice;
    if (toolReplyKind(text, true) === "plain") {
      if (choice === "required" || typeof choice === "object") throw new ProviderError("豆包没有返回要求的工具调用。", 502, "invalid_tool_response");
      return { role: "assistant", content: text || null };
    }
    let reply;
    try { reply = envelope.parse(JSON.parse(text.trim())); }
    catch (cause) { throw new ProviderError(`豆包未遵守工具回复格式：${cause.message}`, 502, "invalid_tool_response", { cause }); }
    if (choice === "required" && !reply.tool_calls.length) throw new ProviderError("豆包没有返回要求的工具调用。", 502, "invalid_tool_response");
    if (typeof choice === "object" && !reply.tool_calls.length) throw new ProviderError("豆包没有返回指定的工具调用。", 502, "invalid_tool_response");
    if (context.request.parallel_tool_calls === false && reply.tool_calls.length > 1) throw new ProviderError("豆包返回了多个工具调用。", 502, "invalid_tool_response");
    tool_calls = reply.tool_calls.map(call => {
      const validate = context.validators.get(call.name);
      if (!validate || (typeof choice === "object" && call.name !== choice.function.name)) throw new ProviderError("豆包返回了未授权的工具名称。", 502, "invalid_tool_response");
      if (!validate(call.arguments)) throw new ProviderError(`工具参数不符合 Schema：${ajv.errorsText(validate.errors)}`, 502, "invalid_tool_response");
      return { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
    });
    content = reply.content;
  }
  if (context.structured && !tool_calls?.length) {
    let value;
    try { value = JSON.parse(content); }
    catch (cause) { throw new ProviderError(`豆包回复不是有效 JSON：${cause.message}`, 502, "invalid_json_response", { cause }); }
    if (context.request.response_format.type === "json_object" && (!value || Array.isArray(value) || typeof value !== "object")) throw new ProviderError("豆包未返回 JSON 对象。", 502, "invalid_json_response");
    if (context.outputValidator && !context.outputValidator(value)) throw new ProviderError(`回复不符合 Schema：${ajv.errorsText(context.outputValidator.errors)}`, 502, "invalid_json_response");
  }
  return { role: "assistant", content: content || null, ...(tool_calls?.length ? { tool_calls } : {}) };
}

export function upstreamBody(session, context, selected) {
  const localMessage = randomUUID();
  return {
    client_meta: { bot_id: session.bot, conversation_id: "", local_conversation_id: `local_${randomUUID().replaceAll("-", "")}`, last_section_id: "", last_message_index: 0, local_permissions: [] },
    messages: [{ local_message_id: localMessage, message_status: 0, content_block: [{ block_type: 10000, block_id: randomUUID(), parent_id: "", content: { text_block: { text: context.prompt, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" }, meta_info: [], extra_info: {}, append_fields: [] }] }],
    option: { need_create_conversation: true, send_message_scene: "", create_time_ms: Date.now(), unique_key: randomUUID(),
      agent_mode: selected.agentMode, need_deep_think: selected.item_id, conversation_mode: 2,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: selected.model_item_key, mode_id: selected.modeId, reasoning_effort: String(selected.level) },
      model_config: { model_item_key: selected.model_item_key, model_extra_params: selected.model_extra_params, reasoning_effort: selected.level },
      aggregate_params: { conversation_mode: "2", mode_id: selected.modeId, model_item_key: selected.model_item_key, agent_mode: String(selected.agentMode), reasoning_effort: String(selected.level), provider_id: selected.model_extra_params.provider_id || "" },
      sse_recv_event_options: { support_chunk_delta: true }, support_lazy_fetch_stream: false,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_from: 0, scene_type: 0, collect_id: "", is_audio: false, answer_with_suggest: false, tts_switch: false, click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false,
      disable_sse_cache: false, select_text_action: "", start_seq: 0, regen_query_id: [], edit_query_id: [], regen_instruction: "", is_ai_playground: false, is_old_user: false, message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [] },
    chat_ability: {}, user_context: [], ext: { is_finish: "1", agent_mode: String(selected.agentMode), use_deep_think: String(selected.item_id) },
  };
}
