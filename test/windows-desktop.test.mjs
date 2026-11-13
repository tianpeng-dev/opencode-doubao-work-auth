import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { _internal } from "../lib/windows.mjs";

const userData = join(process.env.LOCALAPPDATA, "DoubaoWork", "User Data");
const leveldb = join(userData, "Default", "Local Storage", "leveldb");
const localStatePath = join(userData, "Local State");

test("从 leveldb 明文片段取到 web_id 与 user_unique_id", async () => {
  const tokens = await _internal.readClientTokens(leveldb);
  assert.match(tokens.webId, /^[1-9]\d*$/);
  assert.match(tokens.teaUuid, /^[1-9]\d*$/);
  const localState = JSON.parse(await readFile(localStatePath, "utf8"));
  assert.equal(tokens.teaUuid, String(localState.aha.device.device_id));
});

test("用 PowerShell 读到客户端版本与 Chromium 版本", async () => {
  const localState = JSON.parse(await readFile(localStatePath, "utf8"));
  const versions = await _internal.readVersions(
    join(process.env.LOCALAPPDATA, "DoubaoWork", "Application"), localState);
  assert.match(versions.clientVersion, /\d+/);
  assert.match(versions.chromiumVersion, /^\d+(\.\d+)+$/);
});

test("DPAPI 解出 32 字节主密钥，并能解自造的 v10 Cookie", async () => {
  const localState = JSON.parse(await readFile(localStatePath, "utf8"));
  const raw = Buffer.from(localState.os_crypt.encrypted_key, "base64");
  assert.equal(raw.subarray(0, 5).toString("binary"), "DPAPI");
  const key = await _internal.dpapiUnprotect(raw.subarray(5).toString("base64"), false);
  assert.equal(key.length, 32);

  const nonce = Buffer.from("0123456789ab", "binary");
  const plain = Buffer.concat([Buffer.alloc(32, 0x11), Buffer.from("session-value-test", "utf8")]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const blob = Buffer.concat([Buffer.from("v10", "binary"), nonce, body, cipher.getAuthTag()]);
  assert.equal(_internal.decodeCookie(blob, key, true).toString("utf8"), "session-value-test");
});

test("v20（App-Bound）明确拒绝", () => {
  const key = Buffer.alloc(32);
  const blob = Buffer.concat([Buffer.from("v20", "binary"), Buffer.alloc(32)]);
  assert.throws(() => _internal.decodeCookie(blob, key, true), /App-Bound/);
});

test("DPAPI 缓存写入后可以读回，且落盘是密文", async () => {
  const { mkdtemp, readFile: read } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dw-cache-"));
  const payload = { profile: "Default", cookies: [{ key: "sessionid", value: "x" }] };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sealed = await _internal.dpapiProtect(body);
  assert.equal(sealed.includes(Buffer.from("sessionid")), false);
  const back = await _internal.dpapiUnprotect(sealed.toString("base64"), true);
  assert.deepEqual(JSON.parse(back.toString("utf8")), payload);
  assert.ok(dir);
  assert.ok(read);
});
