export class CheckError extends Error {
  constructor(code, message) { super(message); this.name = 'CheckError'; this.code = code; }
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CheckError('CANCELLED', '检测已取消。');
}

// Protocol errors can contain URLs, credentials or excerpts from the parent task.
// Expose a bounded local error category, never an arbitrary server error string.
export function rpcError(method, error) {
  const message = String(error?.message || '');
  if (/429|rate.?limit|too many requests/i.test(message))
    return new CheckError('RATE_LIMITED', '当前渠道限流（429）；本次未完成，不自动重试。');
  if (/in.progress|inprogress|busy/i.test(message))
    return new CheckError('THREAD_BUSY', '当前任务尚无可供检测的已完成轮次，请在这一轮完成后再检测。');
  if (/not found|no.*thread|unknown thread/i.test(message))
    return new CheckError('THREAD_NOT_FOUND', '此 Codex 运行时无法读取当前任务，请核对客户端及 CODEX_HOME。');
  if (/unauthori|authentic|401|login/i.test(message))
    return new CheckError('AUTH_REQUIRED', '当前 Codex 渠道需要重新登录；检测工具不会收集账号或密钥。');
  return new CheckError('PROTOCOL_ERROR', `Codex 未完成 ${method}（错误码 ${Number(error?.code) || '未知'}），当前版本或配置可能不兼容。`);
}

export function inferenceError(error) {
  const message = String(error?.message || '');
  if (/429|rate.?limit|too many requests/i.test(message))
    return { code: 'RATE_LIMITED', message: '当前渠道限流（429），本条样本无效。' };
  if (/quota|usage.?limit|insufficient.?credit/i.test(message))
    return { code: 'QUOTA_EXHAUSTED', message: '当前渠道额度不足，本条样本无效。' };
  if (/401|unauthori|authentic|login/i.test(message))
    return { code: 'AUTH_REQUIRED', message: '当前渠道需要登录或认证，本条样本无效。' };
  return { code: 'INFERENCE_FAILED', message: '渠道没有完成本次模型请求。' };
}
