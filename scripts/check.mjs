#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectCurrent, sameSettings } from './codex/connect.mjs';
import { readSource, prepareFresh, runSamples } from './codex/probes.mjs';
import { CheckError, throwIfCancelled } from './codex/errors.mjs';
import { loadEngine, createReport, completeReport, prepareReportDirectory, saveReport, readReport } from './core.mjs';
import { resultOutput } from './card.mjs';

export function optionsFor(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    json: { type: 'boolean' }, text: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    thread: { type: 'string' }, codex: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    output: { type: 'string' }, input: { type: 'string' },
  } });
  if (values.help) return { command: 'help' };
  if (values.json && values.text) throw new CheckError('ARGUMENT', '--json 和 --text 不能同时使用。');
  const command = positionals[0] || 'check';
  if (positionals.length > 1 || !['check', 'doctor'].includes(command)) {
    throw new CheckError('ARGUMENT', '仅支持 check（默认）或 doctor。');
  }
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 600) {
    throw new CheckError('ARGUMENT', '--timeout 必须是 5–600 秒。');
  }
  if (values.input && (command !== 'check' || values.thread || values.codex || values.output)) {
    throw new CheckError('ARGUMENT', '--input 只用于离线复查，不能与连接或输出目录参数组合。');
  }
  return { ...values, timeout, command };
}

export async function execute(options, {
  connect = connectCurrent, load = loadEngine, read = readSource,
  prepare = prepareFresh, sample = runSamples, save = saveReport, prepareOutput = prepareReportDirectory,
  progress = () => {}, signal,
} = {}) {
  const engine = await load();
  if (options.input) {
    const report = await readReport(options.input, engine);
    completeReport(report, report.samples, engine);
    return { report, file: options.input, replay: true };
  }
  throwIfCancelled(signal);
  if (options.command !== 'doctor') await prepareOutput(options.output);
  throwIfCancelled(signal);
  const { app, source, runtime } = await connect({ ...options, signal });
  const report = createReport(source, engine);
  try {
    throwIfCancelled(signal);
    if (options.command === 'doctor') {
      return { doctor: true, source: report.source, expectedInReference: report.expectedInReference,
        engine: engine.identity, runtime: runtime.file };
    }
    const challenges = engine.sdk.generateChallenges(3);
    const sessions = await prepare(app, source, challenges, { signal });
    throwIfCancelled(signal);
    if (!sameSettings(source, await read(app, source.id, { signal }))) {
      throw new CheckError('SOURCE_CHANGED', '采样前任务配置发生变化，已停止。');
    }
    throwIfCancelled(signal);
    progress(0, 3);
    const samples = await sample(app, sessions, { timeoutMs: options.timeout * 1000, progress, signal });
    report.cancelled = Boolean(signal?.aborted || samples.some(item => item.error?.code === 'CANCELLED'));
    // 先保留已完成样本和用量；配置复查失败不能丢掉它们。
    report.error = { code: 'VERIFYING_SETTINGS', message: '尚未完成配置复查。' };
    completeReport(report, samples, engine);
    if (!report.cancelled && !sameSettings(source, await read(app, source.id, { signal }))) {
      report.error = { code: 'SOURCE_CHANGED', message: '检测期间任务配置发生变化，不作指纹判断。' };
    } else {
      report.error = null;
    }
    completeReport(report, samples, engine);
  } catch (error) {
    report.cancelled = signal?.aborted || error.code === 'CANCELLED';
    report.error = publicError(error);
  } finally {
    await app.close();
  }
  try {
    const file = await save(report, options.output);
    return { report, file, replay: false };
  } catch {
    return { report, file: null, replay: false,
      saveError: { code: 'REPORT_SAVE_FAILED', message: '报告保存失败，完整检测结果已随本次输出返回，请保留 report 字段。' } };
  }
}

function publicError(error) {
  return error instanceof CheckError
    ? { code: error.code, message: error.message }
    : { code: 'LOCAL_ERROR', message: '本地执行失败，请检查完整包、Node 版本和文件读写权限。' };
}

async function main() {
  let options;
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) {
      throw new CheckError('NODE_VERSION', '需要 Node.js 22 或更高版本。');
    }
    options = optionsFor(process.argv.slice(2));
    if (options.command === 'help') {
      console.log('node scripts/check.mjs [check|doctor] [--json|--text] [--timeout 180] [--output 报告目录]\n'
        + '离线复查：node scripts/check.mjs --input 报告.json\n'
        + '兼容性诊断：--codex 可执行文件绝对路径；--thread 可信的当前任务ID。无需 API 配置。');
      return;
    }
    const result = await execute(options, {
      signal: cancel.signal,
      progress: (done, total) => process.stderr.write(`数字探针：${done}/${total} 已完成\n`),
    });
    if (result.doctor) {
      console.log(JSON.stringify({ ...result, inferenceRequests: 0 }, null, 2));
      return;
    }
    console.log(options.json ? JSON.stringify(result, null, 2)
      : await resultOutput(result, { terminal: options.text || Boolean(process.stdout.isTTY) }));
    if (result.report.cancelled) process.exitCode = 130;
    else if (result.saveError || result.report.error || !['scored', 'partial'].includes(result.report.analysis?.decision)) process.exitCode = 1;
  } catch (error) {
    const detail = cancel.signal.aborted ? { code: 'CANCELLED', message: '检测已取消。' } : publicError(error);
    console.log(options?.json || process.argv.slice(2).includes('--json') ? JSON.stringify({ error: detail })
      : await resultOutput({ report: { error: detail, cancelled: detail.code === 'CANCELLED' } }, { terminal: options?.text || Boolean(process.stdout.isTTY) }));
    process.exitCode = detail.code === 'CANCELLED' ? 130 : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry === await realpath(fileURLToPath(import.meta.url))) await main();
