export class ProviderError extends Error {
  constructor(message, status = 502, code = "upstream_error", options = {}) {
    super(message, options);
    this.status = status;
    this.code = code;
    if (status === 401) this.signIn = "expired";
  }
}

export function errorResponse(error) {
  if (!(error instanceof ProviderError)) throw error;
  const headers = error.signIn ? { "X-Magpie-Sign-In": error.signIn } : {};
  return Response.json({ error: { message: error.message, type: error.code, code: error.code } }, { status: error.status, headers });
}

export function upstreamError(body, status = 502) {
  const code = body.code ?? body.error_code ?? body.error?.code ?? "upstream_error";
  const message = body.message || body.msg || body.error?.message || "豆包请求失败";
  if (/未登录|登录失效|登录过期|login required|not login|session expired/i.test(message)) status = 401;
  else if (/限流|频繁|rate limit|too many/i.test(message)) status = 429;
  else if (/额度.*不足|额度.*用完|quota.*exhaust/i.test(message)) status = 429;
  return new ProviderError(`${message}（${code}）`, status, String(code));
}
