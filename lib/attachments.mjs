import aws4 from "aws4";
import CRC32 from "crc-32";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BASE } from "./session.mjs";
import { ProviderError, upstreamError } from "./errors.mjs";

const nonempty = z.string().min(1);
const tokenSchema = z.object({ service_id: nonempty, upload_auth_token: z.object({ access_key: nonempty, secret_key: nonempty, session_token: nonempty }) });
const addressSchema = z.object({ StoreInfos: z.array(z.object({ StoreUri: nonempty, Auth: nonempty })).length(1), UploadHosts: z.array(nonempty).min(1), SessionKey: nonempty, UploadHeader: z.record(z.string(), z.string()).optional() });

async function imagex(session, token, action, params, body, signal) {
  const url = new URL("/top/v1", BASE);
  url.search = new URLSearchParams({ Action: action, Version: "2018-08-01", ServiceId: token.service_id, ...params });
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signed = aws4.sign({ host: url.host, path: url.pathname + url.search, method: payload ? "POST" : "GET", service: "imagex", region: "cn-north-1", body: payload,
    headers: payload ? { "Content-Type": "application/json", "X-Amz-Content-Sha256": createHash("sha256").update(payload).digest("hex") } : {},
    extraHeadersToIgnore: { host: true, "content-type": true, "content-length": true },
  }, { accessKeyId: token.upload_auth_token.access_key, secretAccessKey: token.upload_auth_token.secret_key, sessionToken: token.upload_auth_token.session_token });
  const response = await session.fetcher(url, { method: signed.method, redirect: "error", signal, headers: { ...signed.headers, Cookie: await session.jar.getCookieString(url.href), Origin: BASE, Referer: BASE + "/" }, body: payload });
  const data = await response.json();
  if (data.ResponseMetadata?.Error) {
    const error = data.ResponseMetadata.Error;
    throw upstreamError({ code: error.Code, message: `${action}：${error.Message}` }, response.ok ? 502 : response.status);
  }
  if (!response.ok || !data.Result) throw new ProviderError(`附件 ${action} 响应无效（HTTP ${response.status}）。`, 502, "invalid_attachment_response");
  return data.Result;
}

// 实测 2026-11 的桌面客户端会在字节自家多个中转域之间轮换上传主机：
// 早先的 *.vodupload.com 已不再返回，实际观测到 tos-d-x-lf.douyin.com、tos-d-x-lf.snssdk.com、
// tos-lq-x.bytedancevod.com。白名单按「字节自家域名族」列，遇到新域名时按报错里打印的主机补一条。
const UPLOAD_HOST = /^[a-z0-9-]+\.(vodupload|bytedancevod|snssdk|douyin|byteimg|bytedanceapi|bytedance|volces|ibytedtos|pstatp)\.(com|cn)$/i;

export function uploadURL(host, uri) {
  const url = new URL(`https://${host}`);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !UPLOAD_HOST.test(url.hostname))
    throw new ProviderError(`豆包附件上传主机不在已验证的范围内：${url.hostname}`, 502, "invalid_upload_host");
  if (!/^[a-zA-Z0-9_./-]+$/.test(uri) || uri.split("/").some(part => ["", ".", ".."].includes(part)))
    throw new ProviderError("豆包附件上传 URI 无效。", 502, "invalid_upload_uri");
  url.pathname = `/upload/v1/${uri}`;
  return url;
}

export async function prepareHistoryUpload(session, signal) {
  return tokenSchema.parse(await session.json("/alice/resource/prepare_upload", { tenant_id: "5", scene_id: "154", resource_type: 1 }, signal));
}

export async function uploadHistory(session, text, localMessageId, lease, signal, preparedToken) {
  const bytes = Buffer.from(text), identifier = randomUUID(), name = `magpie-history-${identifier}.md`;
  const token = preparedToken || await prepareHistoryUpload(session, signal);
  const applied = await imagex(session, token, "ApplyImageUpload", { FileSize: String(bytes.length), FileExtension: ".md", NeedFallback: "true", s: randomUUID().replaceAll("-", "") }, undefined, signal);
  const address = addressSchema.parse(applied.UploadAddress), store = address.StoreInfos[0], uri = store.StoreUri;
  const url = uploadURL(address.UploadHosts[0], uri);
  // 在发送文件正文之前登记 URI，上传、注册或请求中断时仍可清理。
  await lease.addAttachment(uri);
  const headers = new Headers(address.UploadHeader);
  headers.delete("Cookie");
  headers.set("Authorization", store.Auth);
  headers.set("Content-CRC32", (CRC32.buf(bytes) >>> 0).toString(16).padStart(8, "0"));
  headers.set("X-Storage-U", encodeURIComponent(session.uid));
  headers.set("Content-Type", "application/octet-stream");
  const response = await session.fetcher(url, { method: "POST", redirect: "error", signal, headers, body: bytes });
  const result = await response.json();
  if (!response.ok || result.code !== 2000) throw upstreamError({ code: result.code, message: result.message || "豆包附件上传失败" }, response.ok ? 502 : response.status);
  if (String(result.data?.crc32).toLowerCase() !== headers.get("Content-CRC32")) throw new ProviderError("豆包附件上传校验和不匹配。", 502, "attachment_checksum_mismatch");
  const committed = await imagex(session, token, "CommitImageUpload", {}, { SessionKey: address.SessionKey }, signal);
  if (!committed.Results?.some(item => item.Uri === uri && item.UriStatus === 2000)) throw new ProviderError("豆包未确认本次附件上传完成。", 502, "attachment_commit_failed");
  const registered = await session.json("/alice/resource/register", { tenant_id: "5", scene_id: "154", resource_list: [{ uri, resource_type: 1, meta: { file_meta: { file_name: name, size: bytes.length, md5: createHash("md5").update(bytes).digest("hex"), identifier, content_type: "text/markdown", parse_extra: {} } } }], extra: JSON.stringify({ bot_id: session.bot, conversation_id: "", local_message_id: localMessageId }) }, signal);
  if (!registered[uri]?.resource_id) throw new ProviderError("豆包没有确认长文本附件注册成功。", 502, "attachment_registration_failed");
  return { block_type: 10052, block_id: randomUUID(), parent_id: "", content: { attachment_block: { attachments: [{ type: 3, identifier, file: { uri, url: "", file_type: 0, name, size: bytes.length }, parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: JSON.stringify({ source: "long_text_paste", version: 1 }) }] }, pc_event_block: "" }, meta_info: [], extra_info: {}, append_fields: [] };
}

export async function deleteAttachments(session, uris) {
  if (!uris?.length) return;
  const response = await session.request("/alice/resource/delete_files", { uris: uris.map(uri => ({ uri, data_type: "file" })) }, AbortSignal.timeout(30000));
  const result = await response.json();
  if (result.code !== 0) throw upstreamError(result);
}
