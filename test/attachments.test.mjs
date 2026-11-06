import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import CRC32 from "crc-32";
import { prepareHistoryUpload, uploadHistory, uploadURL, deleteAttachments } from "../lib/attachments.mjs";

// 模拟上传服务只验证协议、凭据范围和异常清理；真实附件读取由账号集成测试验证。
async function fixture({ corrupt = false, failUpload = false } = {}) {
  const jar = new CookieJar(), calls = [], recorded = [], uri = "test-prefix/owned.md";
  await jar.setCookie("session=test; Secure", "https://www.doubao.com");
  const session = { jar, uid: "test-user", bot: "test-bot", json: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("prepare_upload")) return { service_id: "test-service", upload_auth_token: { access_key: "test-key", secret_key: "test-secret", session_token: "test-token" } };
    assert.equal(path, "/alice/resource/register");
    assert.equal(body.scene_id, "154");
    return { [uri]: { resource_id: "test-resource" } };
  }, fetcher: async (input, options) => {
    const url = new URL(input), headers = new Headers(options.headers);
    calls.push({ url, options });
    if (url.hostname === "www.doubao.com") {
      assert.equal(headers.get("Cookie"), "session=test");
      assert.match(headers.get("Authorization"), /^AWS4-HMAC-SHA256 /);
      if (url.searchParams.get("Action") === "ApplyImageUpload") return Response.json({ Result: { UploadAddress: { StoreInfos: [{ StoreUri: uri, Auth: "single-upload-auth" }], UploadHosts: ["tos-test.vodupload.com"], SessionKey: "test-session" } } });
      assert.equal(url.searchParams.get("Action"), "CommitImageUpload");
      return Response.json({ Result: { Results: [{ Uri: uri, UriStatus: 2000 }] } });
    }
    assert.deepEqual(recorded, [uri], "文件正文上传前必须保存清理记录");
    assert.equal(headers.has("Cookie"), false);
    assert.equal(headers.has("X-Amz-Security-Token"), false);
    assert.equal(headers.get("Authorization"), "single-upload-auth");
    if (failUpload) throw new Error("模拟上传中断：E_NETWORK");
    return Response.json({ code: 2000, data: { crc32: corrupt ? "00000000" : (CRC32.buf(options.body) >>> 0).toString(16).padStart(8, "0") } });
  } };
  const lease = { addAttachment: async value => recorded.push(value) };
  return { session, lease, calls, recorded, uri };
}

test("长文本上传逐字保留 UTF-8，注册关联正确消息且凭据不跨主机", async () => {
  const f = await fixture(), text = "# 历史\r\n```js\n🙂中文\n```";
  const block = await uploadHistory(f.session, text, "local-message", f.lease, AbortSignal.timeout(10000));
  const binary = f.calls.find(call => call.url?.hostname.endsWith("vodupload.com"));
  assert.deepEqual(binary.options.body, Buffer.from(text));
  const registration = f.calls.find(call => call.path?.endsWith("register"));
  assert.equal(JSON.parse(registration.body.extra).local_message_id, "local-message");
  assert.equal(registration.body.resource_list[0].meta.file_meta.size, Buffer.byteLength(text));
  assert.equal(block.content.attachment_block.attachments[0].file.uri, f.uri);
  assert.equal(JSON.parse(block.content.attachment_block.attachments[0].src).source, "long_text_paste");
});

test("上传中断或校验和失败时保留 URI，不注册损坏附件", async () => {
  for (const options of [{ failUpload: true }, { corrupt: true }]) {
    const f = await fixture(options);
    await assert.rejects(uploadHistory(f.session, "完整文本", "message", f.lease), options.failUpload ? /E_NETWORK/ : { code: "attachment_checksum_mismatch" });
    assert.deepEqual(f.recorded, [f.uri]);
    assert.equal(f.calls.some(call => call.path?.endsWith("register")), false);
  }
});

test("预先获取的上传凭据用于完成同一次附件上传", async () => {
  const f = await fixture();
  const token = await prepareHistoryUpload(f.session);
  await uploadHistory(f.session, "完整上下文", "message", f.lease, undefined, token);
  assert.equal(f.calls.filter(call => call.path?.endsWith("prepare_upload")).length, 1);
  assert.deepEqual(f.recorded, [f.uri]);
});

test("上传地址拒绝未知主机、协议注入及路径穿越", () => {
  for (const host of ["example.com", "tos-test.vodupload.com.evil.com", "evil.com@tos-test.vodupload.com", "tos-test.vodupload.com/path"])
    assert.throws(() => uploadURL(host, "owned.md"), { code: "invalid_upload_host" });
  assert.throws(() => uploadURL("tos-test.vodupload.com", "../other.md"), { code: "invalid_upload_uri" });
});

test("附件删除必须得到服务端成功确认，错误原文保留", async () => {
  const session = { request: async (_path, body, signal) => {
    assert.equal(signal.aborted, false);
    assert.deepEqual(body, { uris: [{ uri: "owned.md", data_type: "file" }] });
    return Response.json({ code: 123, message: "模拟删除失败" });
  } };
  await assert.rejects(deleteAttachments(session, ["owned.md"]), /模拟删除失败（123）/);
});
