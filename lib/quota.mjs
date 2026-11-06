import { ProviderError } from "./errors.mjs";

function number(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
  if (!Number.isFinite(result) || result < 0) throw new ProviderError("豆包额度响应包含无效数值。", 502, "invalid_quota");
  return result;
}

function time(value) {
  const n = number(value);
  return n ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : undefined;
}

export function normalizeQuota(overview, summary, user) {
  const sections = [
    ["window_limit_section", "订阅额度"],
    ["incentive_quota_section", "活动赠送额度"],
    ["enterprise_window_limit_section", "企业额度"],
  ].filter(([key]) => (summary[key]?.window_limit_groups?.length ?? 0) > 0);
  const subscription = overview.current_subscription || summary.current_subscription;
  const windows = sections.flatMap(([key, label]) => {
    const section = summary[key];
    const alternativeAvailable = sections.some(([other]) => other !== key && summary[other].usage_exhausted === false);
    return section.window_limit_groups.flatMap(group => (group.window_limits || []).map((window, index) => {
      const amount = number(window.used_amount), limit = number(window.total_amount);
      const used = number(window.used_percent);
      const expires = time(window.end_time);
      return {
        name: `${group.feature_group_name || label}${group.window_limits.length > 1 ? ` · 窗口 ${window.window_type ?? index + 1}` : ""}`,
        ...(used === undefined ? {} : { used }),
        ...(amount === undefined ? {} : { amount }),
        ...(limit === undefined ? {} : { limit }),
        unit: "额度",
        display: amount !== undefined && limit !== undefined ? `${amount} / ${limit} 额度` : "服务端未提供计数",
        // 活动额度到期后不会自动补充，使用 runsOutAt 表示失效时间。
        ...(expires ? key === "incentive_quota_section" ? { runsOutAt: expires, runsOut: limit === undefined || amount === undefined ? undefined : Math.max(0, limit - amount) } : { resetsAt: expires } : {}),
        aside: section.usage_exhausted === true && alternativeAvailable,
      };
    }));
  });
  const unsupportedPackages = ["package_entitlement_groups", "quota_package_entitlement_groups", "enterprise_package_entitlement_groups"]
    .some(key => (summary[key]?.length ?? 0) > 0);
  return {
    plan: subscription?.display?.short_name || subscription?.display?.product_name || "豆包工作",
    user,
    ...(subscription?.end_time ? { until: time(subscription.end_time) } : {}),
    windows,
    ...(unsupportedPackages ? { error: "账号包含额外额度包，其字段尚未验证；当前显示服务端已识别的额度窗口。" } : {}),
  };
}
