import { BASE, DesktopSession, readAuth } from "./lib/session.mjs";
import { chat } from "./lib/chat.mjs";
import { normalizeQuota } from "./lib/quota.mjs";
import { ProviderError } from "./lib/errors.mjs";
import { magpieModels } from "./lib/models.mjs";
import { icon } from "./lib/icon.mjs";

const PROVIDER = "doubao-work";

export const DoubaoWorkPlugin = async () => {
  const sessions = new Map();
  function sessionFor(auth) {
    const binding = readAuth(auth);
    const key = `${binding.profile}:${binding.uid}`;
    if (!sessions.has(key)) sessions.set(key, new DesktopSession(binding));
    return sessions.get(key);
  }
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { name: "豆包工作", npm: "@ai-sdk/openai-compatible", api: `${BASE}/v1`, models: {} };
      for (const id of ["doubao-work", "doubao-work-thinking"]) delete cfg.provider[PROVIDER].models?.[id];
    },
    auth: {
      provider: PROVIDER, maxConcurrency: 1, icon,
      methods: [{
        type: "api", keyless: true, label: "导入豆包工作桌面登录",
        prompts: [{ type: "text", key: "profile", message: "桌面配置名称（auto 使用当前配置）", placeholder: "auto",
          validate: value => /^(auto|Default|Profile \d+)$/.test(value || "auto") ? undefined : "请输入 auto、Default 或 Profile 加数字。" }],
        async authorize(inputs, { signal } = {}) {
          const session = new DesktopSession({ profile: inputs?.profile || "auto" });
          await session.ready(signal);
          const binding = { version: 1, profile: session.profile, uid: session.uid };
          const key = JSON.stringify(binding);
          sessions.set(`${binding.profile}:${binding.uid}`, session);
          return { type: "success", key, metadata: { email: `${session.name} · ${session.profile}`, uid: session.uid, profile: session.profile } };
        },
      }],
      async loader(getAuth) {
        return { baseURL: `${BASE}/v1`, apiKey: "doubao-work-local-session", async fetch(input, init) { return chat(sessionFor(await getAuth()), input, init); } };
      },
      async usage(getAuth) {
        const session = sessionFor(await getAuth());
        try {
          await session.ready();
          const overview = await session.json("/alice/commerce/sale/subscription/overview/", { product_line: "membership" });
          const summary = await session.json("/alice/commerce/sale/subscription/quota/summary/", { product_line: "membership" });
          return normalizeQuota(overview, summary, session.name);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          return { error: error.message, windows: [], ...(error.signIn ? { signIn: error.signIn } : {}) };
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        return magpieModels(await sessionFor(auth).models(undefined, true));
      },
    },
  };
};
