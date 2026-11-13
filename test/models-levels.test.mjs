import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModels } from "../lib/models.mjs";

function menu(items) {
  return { entry_list: [{ action_bar_key: "coco_deep_thinking", active_switch_conf: { use_menu_conf_v2: true, menu_conf_v2: { use_mode_model_list: true, mode_list: { item_list: [{ mode_id: "3", agent_mode: 1, default_conversation_mode: "office", model_list: { item_list: items } }] } } } }] };
}

const item = (key, name, default_level, options, window = "300000") => ({
  item_id: 9, model_item_key: key, name, model_extra_params: { total_window_size: window },
  reasoning_effort_config: { default_level, option_list: options.map(([level, label]) => ({ level, name: label })) },
});

test("自动模型 3/8/5（8 表示「中」）能正常解析", () => {
  const catalog = parseModels(menu([item("9", "自动", 5, [[3, "低"], [8, "中"], [5, "高"]])]));
  const model = catalog.get("doubao-work-auto");
  assert.deepEqual(model.levels, { low: 3, medium: 8, high: 5 });
  assert.equal(model.defaultEffort, "high");
});

test("六档强度（低/中/高/极高/最高）映射为 low/medium/high/ultra/max", () => {
  const catalog = parseModels(menu([item("person-x", "Kimi K3", 5, [[3, "低"], [4, "中"], [5, "高"], [6, "极高"], [7, "最高"]])]));
  assert.deepEqual(catalog.get("doubao-work-person-x").levels, { low: 3, medium: 4, high: 5, ultra: 6, max: 7 });
});

test("没有「中」的模型（GLM 3/5/7）不会被判无效", () => {
  const catalog = parseModels(menu([item("person-glm", "GLM 5.3", 5, [[3, "低"], [5, "高"], [7, "最高"]])]));
  const model = catalog.get("doubao-work-person-glm");
  assert.deepEqual(model.levels, { low: 3, high: 5, max: 7 });
  assert.equal(model.defaultEffort, "high");
});

test("完全不认识的强度名与编号退化成 level-<n>，不整体失败", () => {
  const catalog = parseModels(menu([item("person-new", "新模型", 11, [[11, "研究员模式"], [12, "极速"]])]));
  const model = catalog.get("doubao-work-person-new");
  assert.deepEqual(model.levels, { "level-11": 11, "level-12": 12 });
  assert.equal(model.defaultEffort, "level-11");
});

test("default_level 不在选项里时退回第一档", () => {
  const catalog = parseModels(menu([item("person-y", "Y", 99, [[3, "低"], [5, "高"]])]));
  assert.equal(catalog.get("doubao-work-person-y").defaultEffort, "low");
});

test("需要升级订阅的模型被跳过，其余照常", () => {
  const upgrade = { ...item("5", "豆包 2.1 Pro", 5, [[3, "低"], [4, "中"], [5, "高"]]), subscribe_config: { need_upgrade: true } };
  const catalog = parseModels(menu([upgrade, item("seed-lite-7b", "豆包 2.1 Lite", 5, [[3, "低"], [4, "中"], [5, "高"]])]));
  assert.equal(catalog.has("doubao-work-pro"), false);
  assert.equal(catalog.get("doubao-work-lite").levels.medium, 4);
});
