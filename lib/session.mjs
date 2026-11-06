import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Cookie, CookieJar } from "tough-cookie";
import { z } from "zod";
import { ProviderError, upstreamError } from "./errors.mjs";
import { parseModels } from "./models.mjs";

export const BASE = "https://www.doubao.com";
export const DESKTOP_PARAMS = { aid: "1044603", real_aid: "1044603", device_platform: "web", doubao_device_platform: "desktop", version_code: "20800", language: "zh", samantha_web: "1", "use-olympus-account": "1", channel: "mac_official", client_platform: "pc_client", pkg_type: "release_version", runtime: "web", web_platform: "desktop" };
const execute = promisify(execFile);
const descriptor = z.object({ version: z.literal(1), profile: z.string().regex(/^(Default|Profile \d+)$/), uid: z.string().min(1) });
const clientIdentity = z.object({ deviceId: z.string().regex(/^[1-9]\d*$/), webId: z.string().regex(/^[1-9]\d*$/), teaUuid: z.string().regex(/^[1-9]\d*$/), chromiumVersion: z.string().regex(/^\d+(\.\d+)+$/) });

export function readAuth(auth) {
  if (auth?.type !== "api") throw new ProviderError("请先导入豆包工作桌面账号。", 401, "sign_in_required");
  return descriptor.parse(JSON.parse(auth.key));
}

async function uvPath() {
  if (process.env.DOUBAO_WORK_UV) return process.env.DOUBAO_WORK_UV;
  for (const path of [join(homedir(), ".local/bin/uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]) {
    try { await access(path, constants.X_OK); return path; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return "uv";
}

export async function importDesktop(profile = "auto", signal) {
  const temp = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "doubao-work-magpie", "work");
  const helper = fileURLToPath(new URL("../scripts/desktop_session.py", import.meta.url));
  let result;
  try {
    result = await execute(await uvPath(), ["run", "--no-project", "--script", helper, "--profile", profile, "--temp-dir", temp],
      { signal, timeout: 90000, maxBuffer: 2 * 1024 * 1024, env: process.env });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ProviderError(`读取豆包桌面登录失败：${error.stderr || error.message}`, 401, "desktop_session_error", { cause: error });
  }
  const data = JSON.parse(result.stdout);
  const jar = new CookieJar();
  for (const item of data.cookies) {
    const cookie = new Cookie({ ...item, expires: item.expires ? new Date(item.expires * 1000) : "Infinity" });
    await jar.setCookie(cookie, `${cookie.secure ? "https" : "http"}://${item.domain}${item.path}`);
  }
  return { profile: data.profile, jar, clientVersion: data.clientVersion, clientInfo: clientIdentity.parse(data.clientInfo) };
}

export class DesktopSession {
  constructor(binding, { fetcher = fetch, importer = importDesktop } = {}) {
    this.binding = binding;
    this.fetcher = fetcher;
    this.importer = importer;
    this.readyAt = 0;
  }

  async ready(signal) {
    signal?.throwIfAborted();
    if (Date.now() - this.readyAt < 60000) return;
    // 一个账号内共享刷新；等待者取消不会终止其他请求的刷新。
    this.pending ??= this.initialize().finally(() => { this.pending = undefined; });
    await this.pending;
    signal?.throwIfAborted();
  }

  async initialize() {
    const local = await this.importer(this.binding.profile);
    this.jar = local.jar;
    this.profile = local.profile;
    this.clientVersion = local.clientVersion;
    this.clientInfo = clientIdentity.parse(local.clientInfo);
    this.webId = this.clientInfo.webId;
    const [identity, launch] = await Promise.all([
      this.json("/passport/account/info/v2/", undefined, undefined, { account_sdk_source: "web", sdk_version: "2.2.5" }),
      this.json("/alice/user/launch", {}),
    ]);
    const uid = identity.user_id_str;
    if (!uid || identity.is_visitor_account) throw new ProviderError("豆包工作桌面会话已失效，请登录后重新导入。", 401, "session_expired");
    if (this.binding.uid && this.binding.uid !== uid) throw new ProviderError("桌面配置已切换账号，请重新导入；当前绑定账号不会被替换。", 401, "account_changed");
    this.uid = uid;
    this.name = identity.screen_name || identity.name || this.profile;
    if (!launch.assistant_bot_id) throw new ProviderError("豆包启动响应缺少 assistant_bot_id。", 502, "invalid_launch");
    this.bot = launch.assistant_bot_id;
    this.country = launch.country;
    this.binding = { ...this.binding, profile: this.profile, uid };
    this.readyAt = Date.now();
  }

  async models(signal, force = false) {
    await this.ready(signal);
    if (!force && this.catalog && Date.now() - this.catalogAt < 60000) return this.catalog;
    const menu = await this.json("/alice/slot/action_bar_v3/brief_list", { language_code: "zh", bot_id: this.bot }, signal);
    const catalog = parseModels(menu);
    this.catalog = catalog;
    this.catalogAt = Date.now();
    return catalog;
  }

  async request(path, body, signal, params = {}, extraHeaders = {}) {
    const url = new URL(path, BASE);
    if (url.origin !== BASE) throw new Error("豆包会话请求主机不匹配。");
    const client = this.clientInfo;
    url.search = new URLSearchParams({ ...DESKTOP_PARAMS, ...(this.clientVersion ? { pc_version: this.clientVersion, doubao_pc_version: this.clientVersion } : {}), ...(client ? { web_id: client.webId, device_id: client.deviceId, tea_uuid: client.teaUuid, fp: `verify_${client.deviceId}`, chromium_version: client.chromiumVersion, tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}), ...(this.country ? { region: this.country, sys_region: this.country } : {}), ...params }).toString();
    const timeout = AbortSignal.timeout(180000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(url, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", "Agw-Js-Conv": "str", Origin: BASE, Referer: `${BASE}/`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        Cookie: await this.jar.getCookieString(url.href), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href);
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const error = contentType.includes("json") ? upstreamError(await response.json(), response.status)
        : new ProviderError(`豆包 HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`, response.status);
      if (error.signIn) this.readyAt = 0;
      throw error;
    }
    return response;
  }

  async json(path, body, signal, params) {
    const response = await this.request(path, body, signal, params);
    const result = await response.json();
    if ((result.code !== undefined && result.code !== 0) || (result.message === "error")) throw upstreamError(result.data?.error_code ? result.data : result);
    if (!result.data) throw new ProviderError("豆包响应缺少 data。", 502, "invalid_response");
    return result.data;
  }
}
