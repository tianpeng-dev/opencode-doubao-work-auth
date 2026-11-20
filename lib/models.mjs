import { z } from "zod";
import { ProviderError } from "./errors.mjs";

const itemSchema = z.object({
  item_id: z.number().int().nonnegative(), model_item_key: z.string().min(1), name: z.string().min(1),
  model_extra_params: z.record(z.string(), z.unknown()),
  reasoning_effort_config: z.object({ default_level: z.number().int(), option_list: z.array(z.object({ level: z.number().int(), name: z.string() })).min(1) }),
  subscribe_config: z.object({ need_upgrade: z.boolean().optional() }).optional(),
});
const modeSchema = z.object({ mode_id: z.string().min(1), agent_mode: z.number().int(), default_conversation_mode: z.string(), model_list: z.object({ item_list: z.array(itemSchema).min(1) }) });
const ids = { "9": "doubao-work-auto", "seed-lite-7b": "doubao-work-lite", "5": "doubao-work-pro" };

// 服务端的强度编号并不固定：同一个账号里「自动」是 3/8/5（8 表示「中」），
// 其它模型是 3/4/5/6/7，GLM 干脆没有「中」。所以先按 option.name 映射，
// 名字不认识时再退回编号表，仍不认识就保留成 level-<n>，不要因为多一档就整体失败。
const byName = { "低": "low", "中": "medium", "中等": "medium", "标准": "medium", "高": "high", "极高": "ultra", "最高": "max", "超高": "ultra" };
const byLevel = { 3: "low", 4: "medium", 5: "high", 6: "ultra", 7: "max" };

function effortOf(option) {
  const name = typeof option.name === "string" ? option.name.trim() : "";
  return byName[name] ?? byLevel[option.level] ?? `level-${option.level}`;
}

export function parseModels(menu) {
  const conf = menu.entry_list?.find(entry => entry.action_bar_key === "coco_deep_thinking")?.active_switch_conf;
  if (!conf?.use_menu_conf_v2 || !conf.menu_conf_v2?.use_mode_model_list) throw new ProviderError("豆包工作模型菜单格式发生变化。", 502, "invalid_models");
  const raw = conf.menu_conf_v2.mode_list?.item_list?.find(mode => mode.default_conversation_mode === "office");
  const parsed = modeSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError(`豆包工作模型配置无效：${parsed.error.message}`, 502, "invalid_models");
  const mode = parsed.data;
  const catalog = new Map();
  for (const item of mode.model_list.item_list) {
    if (item.subscribe_config?.need_upgrade) continue;
    const id = ids[item.model_item_key] || `doubao-work-${encodeURIComponent(item.model_item_key)}`;
    const levels = Object.fromEntries(item.reasoning_effort_config.option_list.map(option => [effortOf(option), option.level]));
    const defaultOption = item.reasoning_effort_config.option_list
      .find(option => option.level === item.reasoning_effort_config.default_level) ?? item.reasoning_effort_config.option_list[0];
    const defaultEffort = effortOf(defaultOption);
    if (!levels[defaultEffort] || catalog.has(id)) throw new ProviderError("豆包模型的默认强度或标识无效。", 502, "invalid_models");
    const context = item.model_extra_params.total_window_size === undefined ? 0 : Number(item.model_extra_params.total_window_size);
    if (!Number.isSafeInteger(context) || context < 0) throw new ProviderError("豆包返回的模型上下文容量无效。", 502, "invalid_models");
    catalog.set(id, { ...item, id, modeId: mode.mode_id, agentMode: mode.agent_mode, levels, defaultEffort, context });
  }
  if (!catalog.size) throw new ProviderError("当前账号没有可用的豆包工作模型。", 403, "models_unavailable");
  return catalog;
}

export function selectModel(catalog, request) {
  const model = catalog.get(request.model);
  if (!model) throw new ProviderError(`当前账号没有模型 ${request.model}，请重新获取模型。`, 400, "unknown_model");
  const effort = request.reasoning_effort ?? model.defaultEffort;
  if (!(effort in model.levels)) throw new ProviderError(`模型 ${model.name} 不支持推理强度 ${effort}。`, 400, "invalid_reasoning_effort");
  return { ...model, effort, level: model.levels[effort] };
}

export function magpieModels(catalog) {
  return Object.fromEntries([...catalog].map(([id, model]) => [id, {
    id, providerID: "doubao-work", name: model.name,
    api: { id, url: "https://www.doubao.com/v1", npm: "@ai-sdk/openai-compatible" },
    capabilities: { reasoning: true, toolcall: true, attachment: false, temperature: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false }, output: { text: true, image: false, audio: false, video: false, pdf: false } },
    limit: { context: model.context, output: 0 },
    variants: Object.fromEntries(Object.keys(model.levels).map(effort => [effort, { reasoningEffort: effort }])),
    options: {}, headers: {}, status: "active",
  }]));
}
