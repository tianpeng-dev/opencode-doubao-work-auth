import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cookie, CookieJar } from "tough-cookie";
import { z } from "zod";
import { ProviderError } from "./errors.mjs";

/** Windows 桌面登录导入：不依赖 Python / uv，只用系统 PowerShell 做 DPAPI。 */

const PROFILE_RE = /^(Default|Profile \d+)$/;
const ENTROPY_B64 = Buffer.from("doubao-work-magpie").toString("base64");
const clientIdentity = z.object({
  deviceId: z.string().regex(/^[1-9]\d*$/),
  webId: z.string().regex(/^[1-9]\d*$/),
  teaUuid: z.string().regex(/^[1-9]\d*$/),
  chromiumVersion: z.string().regex(/^\d+(\.\d+)+$/),
});

export class LockedCookies extends Error {}

function psPath() {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(script, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(psPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`PowerShell 退出码 ${code}：${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function dpapiUnprotect(blobB64, withEntropy, signal) {
  const entropyArg = withEntropy ? `[Convert]::FromBase64String('${ENTROPY_B64}')` : "$null";
  const out = await runPowerShell(
    `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
$p=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blobB64}'), ${entropyArg}, $s)
[Convert]::ToBase64String($p)`, signal);
  if (!out) throw new Error("DPAPI 解密没有返回内容。");
  return Buffer.from(out, "base64");
}

async function dpapiProtect(data, signal) {
  const out = await runPowerShell(
    `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$s=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
$e=[Convert]::FromBase64String('${ENTROPY_B64}')
$p=[System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${data.toString("base64")}'), $e, $s)
[Convert]::ToBase64String($p)`, signal);
  return Buffer.from(out, "base64");
}

async function readVersions(appDir, localState, signal) {
  const app = join(appDir, "DoubaoWork.exe");
  const chromium = join(appDir, "app", "DoubaoWork.exe");
  const out = await runPowerShell(
    `$ErrorActionPreference='SilentlyContinue'
$a=(Get-Item -LiteralPath '${app.replaceAll("'", "''")}').VersionInfo.FileVersion
$c=(Get-Item -LiteralPath '${chromium.replaceAll("'", "''")}').VersionInfo.FileVersion
[pscustomobject]@{ client=$a; chromium=$c } | ConvertTo-Json -Compress`, signal);
  let parsed = {};
  try { parsed = JSON.parse(out); } catch { parsed = {}; }
  const clientVersion = parsed.client || null;
  let chromiumVersion = parsed.chromium || (localState.browser || {}).shortcut_migration_version || null;
  return { clientVersion, chromiumVersion };
}

/** 从 Local Storage 的 .ldb/.log 里取最新的 web_id 与 user_unique_id（明文 JSON 片段）。 */
export async function readClientTokens(leveldbDir) {
  const pattern = /"web_id":"(\d+)"[^}]*?"user_unique_id":"(\d+)"[^}]*?"timestamp":(\d+)/g;
  let best = null;
  let names = [];
  try { names = await readdir(leveldbDir); } catch { throw new Error(`没有 Local Storage：${leveldbDir}`); }
  for (const name of names) {
    if (!name.endsWith(".ldb") && !name.endsWith(".log")) continue;
    let text;
    try { text = (await readFile(join(leveldbDir, name))).toString("latin1"); } catch { continue; }
    for (const match of text.matchAll(pattern)) {
      const [, webId, teaUuid, timestamp] = match;
      const at = Number(timestamp);
      if (!best || at > best.at) best = { webId, teaUuid, at };
    }
  }
  if (!best) throw new ProviderError(
    "当前配置没有豆包工作客户端标识，请打开客户端对话页面后重新导入。", 401, "client_identity_missing");
  return { webId: best.webId, teaUuid: best.teaUuid };
}

async function openCookiesDb(file) {
  let handle;
  let api;
  try {
    const { Database } = await import("bun:sqlite");
    handle = new Database(file, { readonly: true });
    api = "bun";
  } catch {
    const { DatabaseSync } = await import("node:sqlite");
    handle = new DatabaseSync(file, { readOnly: true });
    api = "node";
  }
  return {
    query(sql) { return api === "bun" ? handle.query(sql).all() : handle.prepare(sql).all(); },
    close() { handle.close(); },
  };
}

function decodeCookie(blob, key, hasHashPrefix) {
  const prefix = blob.subarray(0, 3).toString("binary");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new ProviderError(
      `不支持的 Cookie 加密版本：${prefix}（豆包工作可能启用了 App-Bound 加密）。`, 401, "cookie_encryption_unsupported");
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return hasHashPrefix ? plain.subarray(32) : plain;
}

async function readCookies(profileDir, localState, tempDir) {
  let source = null;
  for (const candidate of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]) {
    try { await access(candidate); source ??= candidate; } catch { /* 不存在 */ }
  }
  if (!source) throw new ProviderError(`豆包工作配置中没有 Cookies 数据库：${profileDir}`, 401, "cookies_missing");
  const copy = join(tempDir, `cookies-${Date.now()}.db`);
  try { await copyFile(source, copy); }
  catch (error) {
    if (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES") throw new LockedCookies("locked");
    throw error;
  }
  const db = await openCookiesDb(copy);
  try {
    const meta = db.query("SELECT value FROM meta WHERE key='version'");
    const hasHashPrefix = Boolean(meta[0]) && Number(meta[0].value) >= 24;
    const rows = db.query("SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly FROM cookies");
    const encryptedKeyB64 = localState.os_crypt?.encrypted_key;
    if (!encryptedKeyB64) throw new ProviderError("Local State 缺少 os_crypt。", 401, "os_crypt_missing");
    const raw = Buffer.from(encryptedKeyB64, "base64");
    if (raw.subarray(0, 5).toString("binary") !== "DPAPI") throw new ProviderError("os_crypt 不是 Windows DPAPI 格式。", 401, "os_crypt_format");
    const key = await dpapiUnprotect(raw.subarray(5).toString("base64"), false);
    if (key.length !== 32) throw new ProviderError(`DPAPI 主密钥长度异常：${key.length}`, 401, "master_key_length");
    const cookies = [];
    for (const row of rows) {
      const host = String(row.host_key);
      const bare = host.replace(/^\./, "");
      if (!(bare === "doubao.com" || bare.endsWith(".doubao.com"))) continue;
      let value;
      if (row.encrypted_value && row.encrypted_value.length) {
        const blob = Buffer.from(row.encrypted_value);
        value = decodeCookie(blob, key, hasHashPrefix).toString("utf8");
      } else {
        value = row.value ? String(row.value) : "";
      }
      if (!value) continue;
      cookies.push({
        key: row.name, value, domain: bare, path: row.path || "/",
        secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly),
        expires: row.expires_utc ? Number(row.expires_utc) / 1_000_000 - 11644473600 : null,
        hostOnly: !host.startsWith("."),
      });
    }
    return cookies;
  } finally {
    db.close();
  }
}

function cacheFile() {
  return join(process.env.LOCALAPPDATA || homedir(), "doubao-work-magpie", "session.dpapi");
}

async function cacheRead(profile, signal) {
  let raw;
  try { raw = await readFile(cacheFile()); } catch { throw new Error("没有可用的本地会话缓存。"); }
  const body = await dpapiUnprotect(raw.toString("base64"), true, signal);
  const payload = JSON.parse(body.toString("utf8"));
  if (payload.profile !== profile) throw new ProviderError(
    `缓存属于配置 ${payload.profile}，与请求的 ${profile} 不一致。`, 401, "cache_profile_mismatch");
  return payload;
}

async function cacheWrite(payload, signal) {
  const dir = join(process.env.LOCALAPPDATA || homedir(), "doubao-work-magpie");
  await mkdir(dir, { recursive: true });
  const body = Buffer.from(JSON.stringify({ ...payload, savedAt: new Date().toISOString() }), "utf8");
  await writeFile(cacheFile(), await dpapiProtect(body, signal), { mode: 0o600 });
}

function toJar(cookies) {
  const jar = new CookieJar();
  return (async () => {
    for (const item of cookies) {
      const cookie = new Cookie({ ...item, expires: item.expires ? new Date(item.expires * 1000) : "Infinity" });
      await jar.setCookie(cookie, `${cookie.secure ? "https" : "http"}://${item.domain}${item.path}`);
    }
    return jar;
  })();
}

export const _internal = { readClientTokens, readVersions, runPowerShell, dpapiUnprotect, dpapiProtect, decodeCookie, readCookies, cacheFile };

export async function importWindowsDesktop(profile = "auto", signal) {
  const userData = join(process.env.LOCALAPPDATA || homedir(), "DoubaoWork", "User Data");
  let localState;
  try { localState = JSON.parse(await readFile(join(userData, "Local State"), "utf8")); }
  catch (error) { throw new ProviderError(`读取豆包工作 Local State 失败：${error.message}`, 401, "local_state_missing"); }

  const resolved = profile === "auto" ? localState.profile?.last_used : profile;
  if (!resolved || !PROFILE_RE.test(resolved)) throw new ProviderError("配置名称必须为 auto、Default 或 Profile 加数字。", 400, "invalid_profile");
  const profileDir = join(userData, resolved);

  const tempDir = join(process.env.LOCALAPPDATA || homedir(), "doubao-work-magpie", "work");
  await mkdir(tempDir, { recursive: true });

  try {
    const tokens = await readClientTokens(join(profileDir, "Local Storage", "leveldb"));
    const { clientVersion, chromiumVersion } = await readVersions(
      join(process.env.LOCALAPPDATA || homedir(), "DoubaoWork", "Application"), localState, signal);
    if (!chromiumVersion) throw new ProviderError("无法读取豆包工作 Chromium 版本。", 401, "chromium_version_missing");
    const clientInfo = clientIdentity.parse({
      deviceId: String(localState.aha?.device?.device_id ?? ""),
      webId: tokens.webId, teaUuid: tokens.teaUuid, chromiumVersion,
    });
    const cookies = await readCookies(profileDir, localState, tempDir);
    if (!cookies.some((c) => (c.key === "sessionid" || c.key === "sessionid_ss") && c.value)) {
      throw new ProviderError("该豆包工作配置没有登录会话，请在客户端登录后重新导入。", 401, "no_session_cookie");
    }
    const payload = { profile: resolved, cookies, clientVersion, clientInfo, source: "desktop" };
    try { await cacheWrite(payload, signal); } catch { /* 缓存失败不影响导入 */ }
    return { profile: resolved, jar: await toJar(cookies), clientVersion, clientInfo };
  } catch (error) {
    if (!(error instanceof LockedCookies)) throw error;
    const cached = await cacheRead(resolved, signal).catch((cacheError) => {
      throw new ProviderError(
        "豆包工作正在运行，Cookies 数据库被独占锁定，且没有可用的本地会话缓存。"
        + "请完全退出豆包工作（含托盘图标）后重新导入。", 401, "cookies_locked", { cause: cacheError });
    });
    return {
      profile: cached.profile, jar: await toJar(cached.cookies),
      clientVersion: cached.clientVersion, clientInfo: clientIdentity.parse(cached.clientInfo),
    };
  }
}
