// 用 magpie 自带的 bun 跑：验证 bun:sqlite 读 Cookies + DPAPI 解密整条链路。
// 建一个合成 Cookies 库（真库被客户端独占锁着），不解真实数据。
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { _internal } from "../lib/windows.mjs";

const localStatePath = join(process.env.LOCALAPPDATA, "DoubaoWork", "User Data", "Local State");
const localState = JSON.parse(await readFile(localStatePath, "utf8"));
const raw = Buffer.from(localState.os_crypt.encrypted_key, "base64");
const key = await _internal.dpapiUnprotect(raw.subarray(5).toString("base64"), false);

const dir = await mkdtemp(join(tmpdir(), "dw-cookies-"));
const profileDir = join(dir, "Default");
await mkdir(join(profileDir, "Network"), { recursive: true });
const dbPath = join(profileDir, "Network", "Cookies");

const db = new Database(dbPath);
db.run("CREATE TABLE meta (key TEXT, value TEXT)");
db.run("INSERT INTO meta VALUES ('version','24')");
db.run(`CREATE TABLE cookies (
  host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
  path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER)`);

function seal(value) {
  const nonce = Buffer.from("0123456789ab", "binary");
  const plain = Buffer.concat([Buffer.alloc(32, 0x22), Buffer.from(value, "utf8")]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "binary"), nonce, body, cipher.getAuthTag()]);
}

db.run("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?)",
  [".doubao.com", "sessionid", "", seal("real-looking-session"), "/", 0, 1, 1]);
db.run("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?)",
  [".doubao.com", "s_v_web_id", "plain-value", null, "/", 17945401510000000, 1, 1]);
db.run("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?)",
  [".example.com", "other", "", seal("should-be-filtered"), "/", 0, 1, 1]);
db.close();

const cookies = await _internal.readCookies(profileDir, localState, dir);
const names = cookies.map((c) => c.key).sort();
assert.deepEqual(names, ["s_v_web_id", "sessionid"]);
assert.equal(cookies.find((c) => c.key === "sessionid").value, "real-looking-session");
assert.equal(cookies.find((c) => c.key === "s_v_web_id").value, "plain-value");
const expires = cookies.find((c) => c.key === "s_v_web_id").expires;
// expires_utc 是 1601 起的微秒：17945401510000000/1e6 - 11644473600
assert.ok(Math.abs(expires - 6300927910) < 1, String(expires));

await writeFile(join(dir, "ok.txt"), "ok");
await rm(dir, { recursive: true, force: true });
console.log("COOKIE CHAIN OK");
