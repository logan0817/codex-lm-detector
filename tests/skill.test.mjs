import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute, optionsFor } from '../scripts/check.mjs';
import { createReport, completeReport, loadEngine, renderReport, readReport, prepareReportDirectory, saveReport, scoreSamples, reportRoot, verifyArtifacts } from '../scripts/core.mjs';
import { prepareFresh, readSource, runSamples } from '../scripts/codex/probes.mjs';
import { candidatePaths, resolveRuntime, sourceThread } from '../scripts/codex/runtime.mjs';
import { AppServer } from '../scripts/codex/app-server.mjs';
import { CheckError } from '../scripts/codex/errors.mjs';
import { formatProbability, presentationFor } from '../scripts/presentation.mjs';
import { renderCard, resultOutput } from '../scripts/card.mjs';
import { install } from '../install.mjs';

const source = { id: 'current-thread', model: 'gpt-test', modelProvider: 'private-provider',
  cwd: '/private/project', reasoningEffort: 'high', originator: 'Codex Desktop' };
const engine = await loadEngine();
const challenges = engine.sdk.generateChallenges(3);
const sessions = challenges.map((challenge, i) => ({ id: `probe-${i}`, challengeId: challenge.id,
  count: challenge.expected_count, prompt: challenge.prompt }));
// 仅用于 SDK 调用一致性和错误路径的人工测试序列，不作为模型归因证据。
const samples = sessions.map((session, i) => ({ ...session,
  text: JSON.stringify(Array.from({ length: session.count }, (_, n) => (n * 137 + i * 53) % 355 + 1)),
  error: null, usage: { input: 20, output: 30, cachedInput: 10 }, elapsedMs: 1,
}));

async function temporary(t) {
  const root = process.env.TEST_TMP_DIRECTORY || tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'codex-lm-detector-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeApp(mode = 'complete') {
  const app = new EventEmitter();
  app.calls = [];
  app.request = async (method, params) => {
    app.calls.push({ method, params });
    if (method !== 'turn/start') return {};
    const id = `turn-${params.threadId}`;
    const notify = (method, more) => app.emit('notification', { method, params: { threadId: params.threadId, ...more } });
    if (mode !== 'hang') setTimeout(() => {
      notify('turn/started', { turn: { id } });
      if (mode === 'tool') notify('item/started', { item: { type: 'commandExecution' } });
      else if (mode === 'rate') notify('error', { willRetry: false, error: { message: '429 Too Many Requests sk-private' } });
      else {
        notify('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: '[1,2,3]' } });
        notify('turn/completed', { turn: { id, status: 'completed' } });
        // 用量允许比完成通知稍晚，但仍在同一轮监听期间接收。
        notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 7, outputTokens: 9, cachedInputTokens: 0 } } });
      }
    }, 2);
    return { turn: { id } };
  };
  return app;
}

test('官方 SDK、参考库与清单完整，可离线生成三条不重复长度挑战', async () => {
  await verifyArtifacts();
  assert.equal(challenges.length, 3);
  assert.equal(new Set(challenges.map(item => item.expected_count)).size, 3);
  assert.ok(challenges.every(item => item.expected_count >= 292 && item.expected_count <= 332));
  assert.ok(engine.models.length > 0);
});

test('包装评分与直接 SDK 结果完全一致，失败样本不参与评分', () => {
  const failed = { ...samples[0], error: { code: 'TOOL_ATTEMPT' } };
  const input = [failed, ...samples.slice(1)];
  assert.deepEqual(scoreSamples(input, engine.detector), engine.detector.analyze(samples.slice(1).map(item => ({
    text: item.text, expected_count: item.count,
  }))));
  assert.equal(scoreSamples([failed], engine.detector), null);
});

test('当前任务缺失或配置字段不全时停止，不猜测最近任务', async () => {
  assert.throws(() => sourceThread(undefined, {}), { code: 'NO_CURRENT_THREAD' });
  assert.equal(sourceThread(undefined, { CODEX_THREAD_ID: 'trusted-thread' }), 'trusted-thread');
  await assert.rejects(readSource({ request: async () => ({ thread: { ...source, reasoningEffort: undefined } }) }, source.id), { code: 'MISSING_EFFORT' });
  await assert.rejects(readSource({ request: async () => ({ thread: { ...source, id: 'other' } }) }, source.id), { code: 'WRONG_THREAD' });
});

test('临时会话保留模型、provider和推理档位，并关闭模型回退', async () => {
  let n = 0;
  const app = { request: async (method, params) => {
    assert.equal(method, 'thread/start');
    assert.equal(params.allowProviderModelFallback, false);
    assert.equal(params.model, source.model);
    assert.equal(params.modelProvider, source.modelProvider);
    assert.equal(params.config.model_reasoning_effort, source.reasoningEffort);
    assert.equal(params.cwd, source.cwd);
    return { thread: { id: `fresh-${n++}`, ephemeral: true }, model: source.model,
      modelProvider: source.modelProvider, reasoningEffort: source.reasoningEffort, cwd: source.cwd };
  } };
  const actual = await prepareFresh(app, source, challenges);
  assert.deepEqual(actual.map(item => item.prompt), challenges.map(item => item.prompt));
  const wrong = { request: async () => ({ thread: { id: 'fresh', ephemeral: true }, model: 'other' }) };
  await assert.rejects(prepareFresh(wrong, source, challenges), { code: 'SETTINGS_CHANGED' });
});

test('正常采样收取最终回答以及完成后的用量', async () => {
  const app = fakeApp();
  const result = await runSamples(app, sessions, { timeoutMs: 1000 });
  assert.ok(result.every(item => item.text === '[1,2,3]' && !item.error));
  assert.ok(result.every(item => item.usage?.input === 7));
  assert.equal(app.listenerCount('notification'), 0);
});

for (const [mode, code] of [['tool', 'TOOL_ATTEMPT'], ['rate', 'RATE_LIMITED'], ['hang', 'PROBE_TIMEOUT']]) {
  test(`${mode} 样本作废、发起中断且不自动重试`, async () => {
    const app = fakeApp(mode);
    const result = await runSamples(app, sessions, { timeoutMs: mode === 'hang' ? 20 : 1000 });
    assert.ok(result.every(item => item.error.code === code));
    assert.equal(app.calls.filter(item => item.method === 'turn/start').length, 3);
    assert.ok(app.calls.some(item => item.method === 'turn/interrupt'));
    assert.ok(!JSON.stringify(result).includes('sk-private'));
  });
}

test('用户取消使所有在途采样无效，并移除监听器', async () => {
  const app = fakeApp('hang');
  const abort = new AbortController();
  const running = runSamples(app, sessions, { timeoutMs: 1000, signal: abort.signal });
  setTimeout(() => abort.abort(), 2);
  const result = await running;
  assert.ok(result.every(item => item.error.code === 'CANCELLED'));
  assert.equal(app.listenerCount('notification'), 0);
});

for (const mode of ['timeout', 'cancel']) {
  test(`${mode} 结束慢启动的在途RPC，保留已完成样本且不启动后续探针`, { timeout: 2000 }, async t => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = 0;
    const app = new AppServer({ command: '/mock', prefix: [] }, null, { spawnImpl: () => child });
    t.after(() => app.close());
    const abort = new AbortController();
    const calls = [];
    let secondSignal;
    let secondRequest;
    const request = app.request.bind(app);
    app.request = (method, params, timeout, options) => {
      calls.push({ method, params, timeout });
      if (method === 'turn/start' && calls.filter(call => call.method === 'turn/start').length === 2) secondSignal = options.signal;
      return request(method, params, timeout, options);
    };
    child.stdin.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        const reply = result => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
        const notify = (method, params) => child.stdout.write(JSON.stringify({ method,
          params: { threadId: message.params.threadId, ...params } }) + '\n');
        if (message.method === 'turn/interrupt') reply({});
        else if (message.params.threadId === sessions[0].id) {
          setTimeout(() => {
            const turn = { id: 'first-turn', status: 'completed' };
            notify('turn/started', { turn });
            reply({ turn });
            notify('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: '[1,2,3]' } });
            notify('turn/completed', { turn });
          }, 20);
        } else {
          secondRequest = message;
          notify('turn/started', { turn: { id: 'second-turn' } });
          if (mode === 'cancel') setImmediate(() => abort.abort());
        }
      }
    });
    const result = await runSamples(app, sessions, { timeoutMs: 80, signal: abort.signal });
    assert.equal(result[0].text, '[1,2,3]');
    assert.equal(result[0].error, null);
    assert.ok(result.slice(1).every(sample => sample.error.code === (mode === 'timeout' ? 'PROBE_TIMEOUT' : 'CANCELLED')));
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
    assert.equal(secondSignal.aborted, true);
    assert.ok(calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'second-turn'));
    assert.equal(app.pending.size, 0);
    assert.equal(app.listenerCount('notification'), 0);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    child.stdout.write(JSON.stringify({ id: secondRequest.id, result: { turn: { id: 'second-turn' } } }) + '\n');
    assert.equal(app.pending.size, 0);
  });
}

function execution(overrides = {}) {
  let closed = 0;
  const deps = {
    load: async () => engine,
    connect: async () => ({ app: { close: async () => { closed++; } }, source, runtime: { file: '/runtime' } }),
    read: async () => source,
    prepare: async () => sessions,
    sample: async () => samples,
    save: async () => '/test-report.json',
    prepareOutput: async () => {},
    ...overrides,
  };
  return { deps, closed: () => closed };
}

test('doctor 只做连接与引擎检查，不创建临时会话、不采样', async () => {
  const run = execution({ prepare: () => { throw Error('must not prepare'); }, sample: () => { throw Error('must not sample'); },
    prepareOutput: () => { throw Error('must not prepare output'); } });
  const result = await execute({ command: 'doctor' }, run.deps);
  assert.equal(result.doctor, true);
  assert.equal(run.closed(), 1);
});

test('报告路径不可用时在连接及采样前停止，不覆盖已有文件', async t => {
  const dir = await temporary(t);
  const blocked = path.join(dir, 'is-a-file');
  await writeFile(blocked, 'keep');
  const run = execution({ prepareOutput: prepareReportDirectory,
    connect: () => { throw Error('must not connect'); } });
  await assert.rejects(execute({ command: 'check', output: blocked }, run.deps), { code: 'OUTPUT_UNAVAILABLE' });
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
});

test('最终写入失败仍返回样本、评分和用量，并输出可离线复查的完整JSON', async t => {
  const dir = await temporary(t);
  const blocked = path.join(dir, 'became-a-file');
  await writeFile(blocked, 'keep');
  const run = execution({ save: saveReport });
  const result = await execute({ command: 'check', timeout: 5, output: blocked }, run.deps);
  assert.equal(result.saveError.code, 'REPORT_SAVE_FAILED');
  assert.equal(result.file, null);
  assert.equal(result.report.error, null);
  assert.equal(result.report.samples.length, 3);
  assert.deepEqual(result.report.analysis, scoreSamples(samples, engine.detector));
  assert.equal(result.report.usage.input, 60);
  assert.equal(run.closed(), 1);
  result.report.samples[0].prompt += '\n```json\n````';
  const text = await resultOutput(result, { env: { CODEX_HOME: dir, CODEX_THREAD_ID: 'trusted-thread' }, terminal: false });
  assert.match(text, /报告保存失败/);
  assert.ok(!text.includes('visualize'));
  assert.ok(!text.includes('查看完整报告'));
  assert.ok(text.includes('| 前五名候选 |'));
  const recovery = text.match(/\n(`{3,})json\n([\s\S]*)\n\1$/);
  assert.ok(recovery);
  assert.deepEqual(JSON.parse(recovery[2]), result.report);
  const recoveredFile = path.join(dir, 'recovered.json');
  await writeFile(recoveredFile, recovery[2]);
  const replay = await execute({ input: recoveredFile }, { load: async () => engine,
    connect: () => { throw Error('must not connect'); } });
  assert.deepEqual(replay.report.analysis, result.report.analysis);
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
});

test('检测开始前取消不连接，也不创建报告目录', async () => {
  const cancel = new AbortController();
  cancel.abort();
  const run = execution({ signal: cancel.signal,
    prepareOutput: () => { throw Error('must not prepare output'); },
    connect: () => { throw Error('must not connect'); } });
  await assert.rejects(execute({ command: 'check' }, run.deps), { code: 'CANCELLED' });
});

test('准备第一条临时会话时取消，不再创建后续会话或读取配置，并关闭连接', async () => {
  const cancel = new AbortController();
  let starts = 0;
  let closed = 0;
  const app = { request: async (method, params, timeout, options) => {
    assert.equal(method, 'thread/start');
    assert.equal(options.signal, cancel.signal);
    starts++;
    cancel.abort();
    return { thread: { id: 'first-probe', ephemeral: true }, model: source.model,
      modelProvider: source.modelProvider, reasoningEffort: source.reasoningEffort, cwd: source.cwd };
  }, close: async () => { closed++; } };
  const run = execution({ signal: cancel.signal,
    connect: async options => {
      assert.equal(options.signal, cancel.signal);
      return { app, source, runtime: { file: '/runtime' } };
    }, prepare: prepareFresh,
    read: () => { throw Error('must not read'); }, sample: () => { throw Error('must not sample'); } });
  const result = await execute({ command: 'check', timeout: 5 }, run.deps);
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(result.report.cancelled, true);
  assert.equal(result.report.error.code, 'CANCELLED');
  assert.equal(result.report.analysis, null);
});

test('采样前配置变化时不发模型请求，保留错误结果并关闭连接', async () => {
  const run = execution({ read: async () => ({ ...source, model: 'changed' }), sample: () => { throw Error('must not sample'); } });
  const result = await execute({ command: 'check', timeout: 5 }, run.deps);
  assert.equal(result.report.error.code, 'SOURCE_CHANGED');
  assert.equal(result.report.analysis, null);
  assert.equal(run.closed(), 1);
});

test('采样后配置复查失败仍保留三条回答及用量，但不评分', async () => {
  let reads = 0;
  const run = execution({ read: async () => { if (++reads > 1) throw new CheckError('PROTOCOL_ERROR', '失去连接'); return source; } });
  const { report } = await execute({ command: 'check', timeout: 5 }, run.deps);
  assert.equal(report.samples.length, 3);
  assert.equal(report.usage.input, 60);
  assert.equal(report.analysis, null);
  assert.equal(report.error.code, 'PROTOCOL_ERROR');
});

test('配置变化或取消不保留匹配结论', async () => {
  let reads = 0;
  const run = execution({ read: async () => ++reads > 1 ? { ...source, reasoningEffort: 'low' } : source });
  const { report } = await execute({ command: 'check', timeout: 5 }, run.deps);
  assert.equal(report.error.code, 'SOURCE_CHANGED');
  assert.equal(report.analysis, null);
  const cancelled = createReport(source, engine);
  cancelled.cancelled = true;
  cancelled.analysis = { prediction: 'stale' };
  completeReport(cancelled, samples, engine);
  assert.equal(cancelled.analysis, null);
});

test('报告不包含任务ID、工作目录，文件不覆盖且POSIX权限受限', async t => {
  const dir = await temporary(t);
  const report = completeReport(createReport(source, engine), samples, engine);
  const one = await saveReport(report, dir);
  const two = await saveReport(report, dir);
  assert.notEqual(one, two);
  const text = await readFile(one, 'utf8');
  assert.ok(!text.includes(source.id));
  assert.ok(!text.includes(source.cwd));
  if (process.platform !== 'win32') assert.equal((await stat(one)).mode & 0o777, 0o600);
});

test('错误报告和完整报告均可离线重读，不连接运行时或发请求', async t => {
  const dir = await temporary(t);
  for (const data of [createReport(source, engine), completeReport(createReport(source, engine), samples, engine)]) {
    const file = await saveReport(data, dir);
    assert.equal((await readReport(file, engine)).schema, data.schema);
    const result = await execute({ input: file }, { load: async () => engine,
      connect: () => { throw Error('must not connect'); } });
    assert.equal(result.replay, true);
    assert.ok(renderReport(result.report, file, true).includes('未发起新请求'));
  }
});

test('不同引擎版本的报告拒绝复查', async t => {
  const dir = await temporary(t);
  const report = createReport(source, engine);
  report.engine.sdkVersion = 'other';
  const file = await saveReport(report, dir);
  await assert.rejects(readReport(file, engine), { code: 'ENGINE_CHANGED' });
});

test('新报告使用统一标识，旧版报告仍可离线复查且不改写', async t => {
  const dir = await temporary(t);
  const report = completeReport(createReport(source, engine), samples, engine);
  assert.equal(report.schema, 'codex-lm-detector/v1');
  report.schema = 'lm-detector-codex/v1';
  const file = await saveReport(report, dir);
  const before = await readFile(file, 'utf8');
  const result = await execute({ input: file }, { load: async () => engine,
    connect: () => { throw Error('must not connect'); } });
  assert.equal(result.replay, true);
  assert.deepEqual(result.report.analysis, report.analysis);
  assert.equal(await readFile(file, 'utf8'), before);
  report.schema = 'unrelated/v1';
  await assert.rejects(readReport(await saveReport(report, dir), engine), { code: 'INVALID_REPORT' });
});

test('库外型号不显示相符结论，未知用量不填零', () => {
  const report = completeReport(createReport(source, engine), samples, engine);
  report.analysis = { decision: 'scored', used_outputs: 3, prediction: source.model,
    probability_status: 'reference_calibrated',
    results: [{ model: source.model, probability: 0.9999 }] };
  report.usage = { input: null, output: null, knownSamples: 0 };
  const text = renderReport(report);
  assert.ok(text.includes('未单独收录'));
  assert.ok(text.includes('输入 Token **未返回**'));
  assert.ok(text.includes('>99.9%'));
  assert.ok(!text.includes('第一候选与配置名称一致'));
});

function rankedReport() {
  const report = createReport(source, engine);
  report.expectedInReference = true;
  report.samples = samples;
  report.analysis = { decision: 'scored', used_outputs: 3, prediction: source.model,
    probability_status: 'reference_calibrated',
    evidence: { insufficient: true }, results: [{ model: source.model, probability: 0.9999 }] };
  report.usage = { input: 64411, output: 3920, knownSamples: 3 };
  return report;
}

test('真实SDK完整校准排名在库内和库外均显示概率，同时保留身份判断限制', async () => {
  const report = completeReport(createReport({ ...source, model: engine.models[0] }, engine), samples, engine);
  assert.equal(report.analysis.decision, 'scored');
  assert.equal(report.analysis.used_outputs, 3);
  assert.equal(report.analysis.probability_status, 'reference_calibrated');
  assert.equal(report.analysis.evidence.insufficient, true);
  const probability = formatProbability(report.analysis.results[0].probability);
  assert.ok(probability);
  for (const inReference of [true, false]) {
    report.expectedInReference = inReference;
    report.source.model = inReference ? engine.models[0] : 'not-in-reference';
    const snapshot = structuredClone(report);
    const view = presentationFor(report);
    assert.equal(view.status, 'completed');
    assert.equal(view.probability, probability);
    assert.equal(view.results[0].probability, probability);
    assert.match(view.detail, inReference ? /不能确认后台模型身份/ : /暂不判断是否匹配/);
    const html = await renderCard(report);
    assert.ok(html.includes(probability.replaceAll('>', '&gt;').replaceAll('<', '&lt;')));
    assert.ok(renderReport(report).includes(probability));
    assert.deepEqual(report, snapshot);
  }
});

test('五种展示状态按完成情况选择图标，保留错误优先级且不改变报告', async () => {
  const scenarios = [
    ['completed', 'chart-column', () => {}],
    ['completed', 'chart-column', report => { report.analysis.prediction = 'other'; report.analysis.results[0].model = 'other'; }],
    ['completed', 'chart-column', report => { report.expectedInReference = false; }],
    ['completed', 'chart-column', report => { report.analysis.probability_status = 'unavailable'; }],
    ['partial', 'circle-dashed', report => { report.analysis.decision = 'partial'; report.analysis.used_outputs = 2; }],
    ['partial', 'circle-dashed', report => { report.analysis.decision = 'partial'; report.analysis.used_outputs = 1; report.expectedInReference = false; }],
    ['unscorable', 'info', report => { report.analysis.decision = 'not_model'; }],
    ['unscorable', 'info', report => { report.analysis.decision = 'unscorable'; }],
    ['unscorable', 'info', report => { report.error = { code: 'SOURCE_CHANGED', message: '配置变化' }; }],
    ['error', 'circle-alert', report => { report.error = { code: 'RATE_LIMITED', message: '渠道限流' }; }],
    ['error', 'circle-alert', report => { report.analysis = null; report.samples = samples.map(sample => ({ ...sample, error: { code: 'PROBE_TIMEOUT' } })); }],
    ['cancelled', 'circle-stop', report => { report.cancelled = true; report.error = { code: 'RATE_LIMITED' }; }],
  ];
  for (const [status, icon, change] of scenarios) {
    const report = rankedReport();
    change(report);
    const snapshot = structuredClone(report);
    assert.equal(presentationFor(report).status, status);
    const html = await renderCard(report);
    assert.match(html, new RegExp(`data-status="${status}"`));
    assert.ok(html.includes(`data-lucide="${icon}"`));
    assert.ok(html.includes(presentationFor(report).title));
    if (['completed', 'partial'].includes(status)) assert.ok(html.includes('最接近候选'));
    else assert.ok(!html.includes('最接近候选'));
    assert.deepEqual(report, snapshot);
  }
});

test('完整排名的说明区分候选一致、不同与未收录，不把身份限制当作执行失败', () => {
  const report = rankedReport();
  assert.match(presentationFor(report).detail, /第一候选与所选型号一致/);
  report.analysis.prediction = 'other';
  assert.match(presentationFor(report).detail, /第一候选与所选型号不同.*不能据此认定换模/);
  report.expectedInReference = false;
  assert.match(presentationFor(report).detail, /所选型号未单独收录/);
  report.analysis.probability_status = 'unavailable';
  const view = presentationFor(report);
  assert.equal(view.status, 'completed');
  assert.equal(view.probability, null);
  assert.match(view.detail, /上游未提供校准概率/);
  assert.ok(!renderReport(report).includes('证据不足'));
});

test('样本不全时不显示高百分比，解释失败原因并标明部分用量', () => {
  const report = rankedReport();
  report.analysis.decision = 'partial';
  report.analysis.used_outputs = 2;
  report.samples = [...samples.slice(0, 2), { ...samples[2], error: { code: 'PROBE_TIMEOUT' } }];
  report.usage.knownSamples = 2;
  for (const inReference of [true, false]) {
    report.expectedInReference = inReference;
    const text = renderReport(report);
    assert.match(text, /2\/3 条有效样本/);
    assert.match(text, /PROBE\\_TIMEOUT/);
    assert.match(text, /仅 2\/3 条返回用量/);
    assert.ok(!text.includes('99.9%'));
    assert.ok(!text.includes('第一候选与所选型号一致'));
  }
});

test('失败、取消、配置变化及非模型序列均不展示残留候选', () => {
  for (const change of [
    report => { report.error = { code: 'RATE_LIMITED', message: '渠道限流' }; },
    report => { report.cancelled = true; },
    report => { report.error = { code: 'SOURCE_CHANGED', message: '配置变化' }; },
    report => { report.analysis.decision = 'not_model'; },
    report => { report.analysis.decision = 'unscorable'; },
  ]) {
    const report = rankedReport();
    change(report);
    const text = renderReport(report);
    assert.ok(!text.includes('最接近候选'));
    assert.ok(!text.includes('99.9%'));
    assert.equal(presentationFor(report).candidate, null);
  }
});

test('无法评分的失败报告展示实际原因，保留未知用量', () => {
  const report = createReport(source, engine);
  report.samples = samples.map(sample => ({ ...sample, text: null,
    error: { code: 'RATE_LIMITED', message: '当前渠道限流' } }));
  const text = renderReport(report);
  assert.match(text, /RATE\\_LIMITED/);
  assert.match(text, /当前渠道限流/);
  assert.match(text, /有效样本 \*\*0\/3\*\*/);
  assert.match(text, /输入 Token \*\*未返回\*\*/);
});

test('概率保留极小非零值、上界与未知值的含义', () => {
  assert.equal(formatProbability(0.00001), '<0.1%');
  assert.equal(formatProbability(0), '0.0%');
  assert.equal(formatProbability(0.001), '0.1%');
  assert.equal(formatProbability(0.598), '59.8%');
  assert.equal(formatProbability(0.999), '99.9%');
  assert.equal(formatProbability(1), '>99.9%');
  for (const invalid of [null, undefined, NaN, Infinity, -1, 2]) assert.equal(formatProbability(invalid), null);
});

test('摘要支持纯文字、历史标记、千分位以及含空格的Windows报告链接', () => {
  const report = rankedReport();
  const text = renderReport(report, 'C:\\Users\\Demo User\\reports\\result.json', true);
  assert.ok(!text.includes('!['));
  assert.match(text, /历史检测报告离线复查 · 未发起新请求/);
  assert.match(text, /64,411/);
  assert.match(text, /3,920/);
  assert.match(text, /\[查看完整报告\]\(<C:\/Users\/Demo User\/reports\/result.json>\)/);
  assert.ok(!text.includes('private-provider'));
  assert.ok(text.includes('| 前五名候选 |'));
});

test('展示层转义模型名称中的Markdown，防止额外图片或链接', () => {
  const report = rankedReport();
  report.source.model = '![bad](https://invalid.example/image)\n**heading**';
  report.analysis.prediction = report.source.model;
  report.analysis.results[0].model = report.source.model;
  const text = renderReport(report);
  assert.ok(!text.includes('![bad]'));
  assert.ok(!text.includes('\n**heading**'));
});

test('连接前的错误也显示状态摘要，JSON错误格式保持兼容', () => {
  const args = ['scripts/check.mjs', 'doctor'];
  const env = { ...process.env, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' };
  const failed = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.ok(!failed.stdout.includes('!['));
  assert.match(failed.stdout, /NO\\_CURRENT\\_THREAD/);
  assert.ok(!failed.stdout.includes('所选模型'));
  const json = spawnSync(process.execPath, [...args, '--json'], { env, encoding: 'utf8' });
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error.code, 'NO_CURRENT_THREAD');
  assert.ok(!json.stdout.includes('!['));
});

test('Windows路径候选与记录目录使用原生语义，保留空格', () => {
  const paths = candidatePaths('win32', {}, 'C:\\Users\\Demo User', ['C:\\Program Files\\Codex']);
  assert.ok(paths.includes('C:\\Program Files\\Codex\\codex.exe'));
  assert.ok(paths.includes('C:\\Program Files\\Codex\\node_modules\\@openai\\codex\\bin\\codex.js'));
  assert.equal(reportRoot({ LOCALAPPDATA: 'C:\\Users\\Demo User\\AppData\\Local' }, 'win32', 'C:\\Users\\Demo User'),
    'C:\\Users\\Demo User\\AppData\\Local\\codex-lm-detector');
  assert.equal(reportRoot({}, 'linux', '/home/demo'), '/home/demo/.local/state/codex-lm-detector');
});

test('新配置变量优先，同时兼容旧变量和历史存储位置', async t => {
  const dir = await temporary(t);
  const current = path.join(dir, 'current');
  const legacy = path.join(dir, 'legacy');
  assert.equal(reportRoot({ CODEX_LM_DETECTOR_HOME: current, LM_DETECTOR_HOME: legacy }), current);
  assert.equal(reportRoot({ LM_DETECTOR_HOME: legacy }), legacy);
  assert.equal(reportRoot({}, 'darwin', '/Users/demo'), '/Users/demo/Library/Application Support/codex-lm-detector');
  const resolved = await resolveRuntime(undefined, {
    CODEX_LM_DETECTOR_CODEX_PATH: process.execPath, LM_DETECTOR_CODEX_PATH: path.join(dir, 'missing'),
  });
  assert.equal(resolved.file, await realpath(process.execPath));
  const old = await resolveRuntime(undefined, { LM_DETECTOR_CODEX_PATH: process.execPath });
  assert.equal(old.file, resolved.file);
});

test('app-server采用参数数组、拒绝权限请求，关闭后清除RPC等待', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = 0;
  const runtime = { command: 'C:\\Program Files\\Codex\\codex.exe', prefix: [] };
  let spawned;
  const app = new AppServer(runtime, 'Codex Desktop', { env: {}, spawnImpl: (command, args, opts) => {
    spawned = { command, args, opts }; return child;
  } });
  assert.equal(spawned.command, runtime.command);
  assert.equal(spawned.opts.shell, false);
  const waiting = app.request('test/wait', {}, 1000);
  const rejected = assert.rejects(waiting, { code: 'CLOSED' });
  child.stdout.write(JSON.stringify({ id: 'request-tool', method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  assert.equal(app.serverRequests, 1);
  await app.close();
  await rejected;
  assert.equal(app.pending.size, 0);
});

test('在途RPC取消立即结束等待，迟到响应被忽略，所有结束路径清理取消监听器', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = 0;
  const app = new AppServer({ command: '/mock', prefix: [] }, null, { spawnImpl: () => child });
  const sent = [];
  child.stdin.on('data', bytes => sent.push(JSON.parse(bytes.toString())));
  for (const outcome of ['abort', 'success', 'timeout', 'close']) {
    const cancel = new AbortController();
    const pending = app.request('test/wait', {}, outcome === 'timeout' ? 5 : 30_000, { signal: cancel.signal });
    const id = sent.at(-1).id;
    assert.equal(getEventListeners(cancel.signal, 'abort').length, 1);
    if (outcome === 'abort') {
      const rejected = assert.rejects(pending, { code: 'CANCELLED' });
      cancel.abort();
      await rejected;
      child.stdout.write(JSON.stringify({ id, result: { late: true } }) + '\n');
      await assert.rejects(app.request('must-not-send', {}, 1000, { signal: cancel.signal }), { code: 'CANCELLED' });
      assert.equal(sent.at(-1).id, id);
    } else if (outcome === 'success') {
      child.stdout.write(JSON.stringify({ id, result: { ok: true } }) + '\n');
      assert.deepEqual(await pending, { ok: true });
    } else if (outcome === 'timeout') {
      await assert.rejects(pending, { code: 'RPC_TIMEOUT' });
    } else {
      const rejected = assert.rejects(pending, { code: 'CLOSED' });
      await app.close();
      await rejected;
    }
    assert.equal(app.pending.size, 0);
    assert.equal(getEventListeners(cancel.signal, 'abort').length, 0);
  }
});

test('握手或读取当前任务时取消，真实命令及时关闭子进程并返回130', {
  skip: process.platform === 'win32' ? 'Windows 不支持通过子进程发送可捕获的 POSIX SIGINT；取消由 RPC 测试覆盖。' : false,
}, async t => {
  const dir = await temporary(t);
  for (const stopMethod of ['initialize', 'thread/read']) {
    const runtime = path.join(dir, stopMethod.replaceAll('/', '-') + '.mjs');
    await writeFile(runtime, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === ${JSON.stringify(stopMethod)}) process.kill(process.ppid, 'SIGINT');
  else if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
});
`);
    for (const format of ['--json', '--text']) {
      const result = spawnSync(process.execPath, ['scripts/check.mjs', 'doctor', '--codex', runtime, format], {
        env: { ...process.env, CODEX_THREAD_ID: 'trusted-thread' }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 130, result.stdout + result.stderr);
      if (format === '--json') assert.equal(JSON.parse(result.stdout).error.code, 'CANCELLED');
      else assert.match(result.stdout, /Codex LM Detector · 检测已取消/);
    }
  }
});

test('未知参数和不合理时限在任何请求前拒绝', () => {
  assert.throws(() => optionsFor(['--timeout', '0']), { code: 'ARGUMENT' });
  assert.throws(() => optionsFor(['--input', 'file', '--thread', 'id']), { code: 'ARGUMENT' });
  assert.throws(() => optionsFor(['--api-key', 'secret']));
  assert.throws(() => optionsFor(['--json', '--text']), { code: 'ARGUMENT' });
});

test('安装仅复制运行文件及许可，排除Git和开发文件；已有目录拒绝覆盖', async t => {
  const dir = await temporary(t);
  const target = path.join(dir, '含空格 Skill', 'codex-lm-detector');
  assert.equal(await install(target), target);
  await verifyArtifacts(target);
  assert.deepEqual((await readdir(target)).sort(), [
    'LICENSE', 'SKILL.md', 'THIRD_PARTY_NOTICES.md', 'agents', 'assets', 'references', 'scripts', 'vendor',
  ]);
  const help = spawnSync(process.execPath, [path.join(target, 'scripts/check.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /doctor/);
  const { renderCard: installedRender } = await import(pathToFileURL(path.join(target, 'scripts/card.mjs')).href);
  const report = rankedReport();
  report.expectedInReference = false;
  assert.match(await installedRender(report), /所选型号未单独收录/);
  await rm(path.join(target, 'assets/result-card.html'));
  const { resultOutput: installedOutput } = await import(pathToFileURL(path.join(target, 'scripts/card.mjs')).href);
  report.source.originator = 'Codex Desktop';
  const fallback = await installedOutput({ report }, { env: { CODEX_HOME: dir, CODEX_THREAD_ID: 'test-thread' }, terminal: false });
  assert.match(fallback, /卡片暂不可用/);
  assert.match(fallback, /\| 前五名候选 \|/);
  const marker = path.join(target, 'user-marker');
  await writeFile(marker, 'keep');
  await assert.rejects(install(target), /已经存在/);
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

test('默认安装目录、Skill声明和调用提示均使用codex-lm-detector', async t => {
  const dir = await temporary(t);
  const result = spawnSync(process.execPath, ['install.mjs'], {
    env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const installed = path.join(dir, 'skills/codex-lm-detector');
  await verifyArtifacts(installed);
  assert.match(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), /^name: codex-lm-detector$/m);
  assert.ok(result.stdout.includes('$codex-lm-detector'));
  assert.ok(!result.stdout.includes('$lm-detector'));
  assert.ok((await readFile(path.join(installed, 'agents/openai.yaml'), 'utf8')).includes('$codex-lm-detector'));
});

function addCandidates(report) {
  report.analysis.results = [
    { model: report.source.model, probability: 0.9999 },
    ...Array.from({ length: 5 }, (_, i) => ({ model: `candidate-${i + 2}`, probability: 0.00001 })),
  ];
  return report;
}

test('卡片包含前五名、极小概率与历史标记，不包含原始探针或渠道', async () => {
  const report = addCandidates(rankedReport());
  const snapshot = structuredClone(report);
  const html = await renderCard(report, true);
  assert.equal((html.match(/<tr><td>/g) || []).length, 5);
  assert.ok(html.includes('&gt;99.9%'));
  assert.ok(html.includes('&lt;0.1%'));
  assert.ok(!html.includes('candidate-6'));
  assert.ok(html.includes('历史结果 · 未发起新请求'));
  assert.ok(!html.includes('private-provider'));
  assert.ok(!html.includes(samples[0].prompt));
  assert.ok(!html.includes(samples[0].text));
  assert.ok(!html.includes('{{'));
  assert.deepEqual(report, snapshot);
});

test('卡片对HTML和属性注入转义，超长型号不撑大输出', async () => {
  const report = rankedReport();
  const payload = '"><img src=x onerror="alert(1)"><script>alert(2)</script>';
  report.source.model = payload + 'x'.repeat(10000);
  report.source.effort = payload;
  report.analysis.prediction = payload;
  report.analysis.results[0].model = payload;
  const html = await renderCard(report);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(Buffer.byteLength(html) < 20000);
});

test('卡片内的部分样本与未校准排名不展示高百分比', async () => {
  for (const partial of [true, false]) {
    const report = rankedReport();
    if (partial) {
      report.analysis.decision = 'partial';
      report.analysis.used_outputs = 2;
    } else {
      report.analysis.evidence.insufficient = true;
      report.analysis.probability_status = 'unavailable';
    }
    report.usage.knownSamples = 2;
    const html = await renderCard(report);
    assert.ok(!html.includes('99.9%'));
    const reason = partial ? '有效样本不足（2/3）' : '上游未提供校准概率';
    assert.ok(html.includes(reason));
    assert.ok(renderReport(report).includes(reason));
    assert.ok(!html.includes('不可用'));
    if (partial) assert.ok(html.includes('概率需要三条有效样本'));
    assert.ok(html.includes('仅 2/3 条返回用量'));
  }
});

test('桌面输出只含实际卡片引用和原生报告链接，每次创建独立文件', async t => {
  const dir = await temporary(t);
  const report = addCandidates(rankedReport());
  report.source.originator = 'Codex Desktop';
  const result = { report, file: path.join(dir, '含空格报告.json'), replay: true };
  const env = { CODEX_HOME: dir, CODEX_THREAD_ID: 'trusted-thread-123' };
  const one = await resultOutput(result, { env, terminal: false });
  const two = await resultOutput(result, { env, terminal: false });
  const parse = text => JSON.parse(text.match(/^visualize(.+)/)[1]).path;
  const first = parse(one);
  assert.notEqual(first, parse(two));
  assert.ok(first.startsWith(path.join(dir, 'visualizations').replaceAll('\\', '/')));
  assert.ok(first.includes('/trusted-thread-123/'));
  assert.ok((await readFile(first, 'utf8')).includes('历史结果 · 未发起新请求'));
  assert.ok(one.includes('[查看完整报告]'));
  assert.ok(!one.includes('所选模型'));
  assert.ok(!one.includes('!['));
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o777, 0o600);
});

test('CLI、强制文字及不可信任务标识回退为含前五名的文字，不创建卡片', async t => {
  const dir = await temporary(t);
  for (const [originator, thread, terminal] of [
    ['Codex CLI', 'trusted-thread', false], ['Codex Desktop', 'trusted-thread', true],
    ['Codex Desktop', '../unsafe', false], ['Codex Desktop', '', false],
  ]) {
    const report = addCandidates(rankedReport());
    report.source.originator = originator;
    const text = await resultOutput({ report }, { env: { CODEX_HOME: dir, CODEX_THREAD_ID: thread }, terminal });
    assert.ok(!text.includes('visualize'));
    assert.ok(text.includes('| 前五名候选 |'));
    assert.ok(!text.includes('candidate-6'));
  }
  assert.deepEqual(await readdir(dir), []);
});

test('卡片写入失败时保留完整文字结果，不冒充检测失败', async t => {
  const dir = await temporary(t);
  const blocked = path.join(dir, 'not-a-directory');
  await writeFile(blocked, 'keep');
  const report = addCandidates(rankedReport());
  report.source.originator = 'Codex Desktop';
  const text = await resultOutput({ report }, {
    env: { CODEX_HOME: blocked, CODEX_THREAD_ID: 'trusted-thread' }, terminal: false,
  });
  assert.match(text, /卡片暂不可用/);
  assert.match(text, /\| 前五名候选 \|/);
  assert.match(text, /第一候选与所选型号一致/);
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
});

test('真实命令的卡片、文字和JSON模式共用同一报告，不改变评分或原文件', async t => {
  const dir = await temporary(t);
  const report = completeReport(createReport({ ...source, originator: 'Codex Desktop' }, engine), samples, engine);
  const file = await saveReport(report, path.join(dir, 'reports'));
  const before = await readFile(file, 'utf8');
  const args = ['scripts/check.mjs', '--input', file];
  const env = { ...process.env, CODEX_HOME: dir, CODEX_THREAD_ID: 'trusted-thread-123', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' };
  const card = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.match(card.stdout, /^visualize/);
  const text = spawnSync(process.execPath, [...args, '--text'], { env, encoding: 'utf8' });
  assert.ok(!text.stdout.includes('visualize'));
  assert.match(text.stdout, /历史检测报告离线复查/);
  const json = spawnSync(process.execPath, [...args, '--json'], { env, encoding: 'utf8' });
  const data = JSON.parse(json.stdout);
  assert.equal(data.replay, true);
  assert.deepEqual(data.report.analysis, report.analysis);
  assert.equal(card.status, text.status);
  assert.equal(json.status, card.status);
  assert.equal(await readFile(file, 'utf8'), before);
  const cli = await resultOutput({ report }, { env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex CLI' }, terminal: false });
  assert.ok(!cli.includes('visualize'));
});
