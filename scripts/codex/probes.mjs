import { CheckError, inferenceError, throwIfCancelled } from './errors.mjs';

export async function readSource(app, id, { signal } = {}) {
  throwIfCancelled(signal);
  const t = (await app.request('thread/read', { threadId: id, includeTurns: false }, 30_000, { signal }))?.thread;
  throwIfCancelled(signal);
  if (!t || t.id !== id) throw new CheckError('WRONG_THREAD', 'Codex 返回了另一任务，已停止检测。');
  for (const k of ['model', 'modelProvider', 'cwd'])
    if (typeof t[k] !== 'string' || !t[k]) throw new CheckError('MISSING_SETTINGS', `无法读取当前任务的 ${k}，已停止检测。`);
  if (!Object.hasOwn(t, 'reasoningEffort') || (t.reasoningEffort !== null && typeof t.reasoningEffort !== 'string'))
    throw new CheckError('MISSING_EFFORT', '当前运行时没有提供推理档位，无法保证检测的是相同配置。');
  return t;
}
export async function prepareFresh(app, source, challenges, { signal } = {}) {
  const threads = [];
  for (let i = 0; i < 3; i++) {
    throwIfCancelled(signal);
    const r = await app.request('thread/start', {
      ephemeral: true, model: source.model, modelProvider: source.modelProvider,
      cwd: source.cwd, allowProviderModelFallback: false,
      ...(source.reasoningEffort ? { config: { model_reasoning_effort: source.reasoningEffort } } : {}),
      sandbox: 'read-only', approvalPolicy: 'untrusted',
    }, 45_000, { signal });
    throwIfCancelled(signal);
    const t = r?.thread;
    if (!t || !t.ephemeral || !t.id || t.path || t.forkedFromId || t.id === source.id || t.turns?.length)
      throw new CheckError('WRONG_SESSION', 'Codex 没有创建无历史的临时检测会话，已停止检测。');
    if (r.model !== source.model || r.modelProvider !== source.modelProvider || r.reasoningEffort !== source.reasoningEffort || r.cwd !== source.cwd)
      throw new CheckError('SETTINGS_CHANGED', '临时会话的模型、渠道、目录或档位发生变化，已停止检测。');
    threads.push({ id: t.id, model: r.model, provider: r.modelProvider, effort: r.reasoningEffort, boundary: null });
  }
  if (new Set(threads.map(t => t.id)).size !== 3) throw new CheckError('DUPLICATE_SESSION', 'Codex 没有提供三个独立检测会话。');
  return threads.map((thread, index) => ({ ...thread, count: challenges[index].expected_count, prompt: challenges[index].prompt, challengeId: challenges[index].id }));
}

const MESSAGE_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'hookPrompt']);
export async function runSamples(app, forks, { timeoutMs = 180_000, progress = () => {}, signal } = {}) {
  const startTime = Date.now();
  const deadline = new AbortController();
  const startSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const states = forks.map(f => ({ ...f, turnId: null, text: null, usage: null, error: null, done: false, other: [], startedAt: null }));
  const byId = new Map(states.map(f => [f.id, f]));
  const interrupts = [];
  const interrupt = f => {
    if (f.turnId) interrupts.push(app.request('turn/interrupt', { threadId: f.id, turnId: f.turnId }, 3000).catch(() => {}));
  };
  let resolveAll;
  const allDone = new Promise(resolve => { resolveAll = resolve; });
  function finish(f, error = null) {
    if (f.done) return;
    f.done = true; f.error = error; f.elapsedMs = Date.now() - (f.startedAt || startTime);
    if (!f.text && !error) f.text = f.other.join('\n') || null;
    if (!f.text && !f.error) f.error = { code: 'NO_FINAL_ANSWER', message: '模型未返回完整的最终答案。' };
    if (f.error) interrupt(f);
    progress(states.filter(x => x.done).length, states.length);
    if (states.every(x => x.done)) resolveAll();
  }
  const handle = ({ method, params = {} }) => {
    if (method === '_server_request' && !params.threadId) {
      states.forEach(f => finish(f, { code: 'TOOL_REQUEST', message: '探针请求了工具或授权，样本无效。' })); return;
    }
    const f = byId.get(params.threadId); if (!f) return;
    if (method === 'turn/started') {
      const id = params.turn?.id;
      if (f.done || (f.turnId && f.turnId !== id)) {
        if (id) interrupts.push(app.request('turn/interrupt', { threadId: f.id, turnId: id }, 3000).catch(() => {}));
        return;
      }
      f.turnId = id;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last;
      if (usage) f.usage = { input: usage.inputTokens, cachedInput: usage.cachedInputTokens, output: usage.outputTokens };
    }
    if (f.done) return;
    if (method === 'item/started' && !MESSAGE_ITEMS.has(params.item?.type)) {
      finish(f, { code: 'TOOL_ATTEMPT', message: '模型尝试调用工具，样本无效。' });
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = params.item;
      if (['final_answer', 'final'].includes(item.phase)) f.text = item.text;
      else if (!item.phase) f.other.push(item.text || '');
    } else if (method === 'turn/completed' && (!f.turnId || f.turnId === params.turn?.id)) {
      finish(f, params.turn?.status === 'completed' ? null : { code: 'TURN_FAILED', message: '探针未正常完成。' });
    } else if (method === 'error' && !params.willRetry) {
      finish(f, inferenceError(params.error));
    } else if (method === '_server_request') {
      finish(f, { code: 'TOOL_REQUEST', message: '探针请求了工具或授权，样本无效。' });
    }
  };
  const closed = () => states.forEach(f => finish(f, { code: 'SERVER_EXITED', message: '检测进程提前退出。' }));
  const cancel = () => states.forEach(f => finish(f, { code: 'CANCELLED', message: '检测已取消。' }));
  app.on('notification', handle); app.on('closed', closed); signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    states.forEach(f => finish(f, { code: 'PROBE_TIMEOUT', message: '等待模型答案超时。' }));
    // 总时限也结束在途的启动等待；中断请求仍使用独立的清理时限。
    deadline.abort();
  }, timeoutMs);
  try {
    if (signal?.aborted) cancel();
    for (const f of states) {
      if (f.done) continue;
      f.startedAt = Date.now();
      try {
        const r = await app.request('turn/start', { threadId: f.id, input: [{ type: 'text', text: f.prompt }] }, Math.min(30_000, timeoutMs), { signal: startSignal });
        const id = r?.turn?.id;
        if (!id || (f.turnId && f.turnId !== id)) finish(f, { code: 'WRONG_TURN', message: 'Codex 返回了不一致的检测轮次。' });
        else { f.turnId = id; if (f.done && f.error) interrupt(f); }
      } catch (e) { finish(f, { code: e.code || 'START_FAILED', message: '未能启动本次探针。' }); }
    }
    await allDone;
    await Promise.allSettled(interrupts);
  } finally {
    clearTimeout(timer); app.off('notification', handle); app.off('closed', closed); signal?.removeEventListener('abort', cancel);
  }
  return states.map(({ done, other, startedAt, ...f }) => f);
}
