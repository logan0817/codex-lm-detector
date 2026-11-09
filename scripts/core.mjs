import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CheckError } from './codex/errors.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SCHEMA = 'codex-lm-detector/v1';
const ARTIFACTS = [
  'vendor/lmfpd-sdk/index.mjs',
  'vendor/data/unified_bank.json',
  'vendor/data/shared_detector.bin',
];

export async function verifyArtifacts(root = ROOT) {
  const provenance = JSON.parse(await readFile(path.join(root, 'vendor/provenance.json'), 'utf8'));
  for (const name of ARTIFACTS) {
    const bytes = await readFile(path.join(root, name));
    if (createHash('sha256').update(bytes).digest('hex') !== provenance.artifacts?.[name]) {
      throw new CheckError('ASSET_INTEGRITY', '官方 SDK 或参考数据与打包记录不符，请恢复完整 Skill。');
    }
  }
  return provenance;
}

export async function loadEngine() {
  const provenance = await verifyArtifacts();
  const sdk = await import(pathToFileURL(path.join(ROOT, ARTIFACTS[0])).href);
  const detector = await sdk.loadDetector({ source: path.join(ROOT, 'vendor/data') });
  const bank = JSON.parse(await readFile(path.join(ROOT, 'vendor/data/unified_bank.json'), 'utf8'));
  return {
    sdk, detector, models: bank.models.map(model => model.id),
    identity: {
      sdkVersion: provenance.sdk.version,
      dataVersion: provenance.data.version,
      bankBuiltAt: detector.builtAt,
      detectorSha256: provenance.artifacts['vendor/data/shared_detector.bin'],
    },
  };
}

export function publicSource(source) {
  return {
    model: source.model,
    provider: source.modelProvider,
    effort: source.reasoningEffort,
    originator: source.originator,
  };
}

export function scoreSamples(samples, detector) {
  const accepted = samples.filter(sample => !sample.error && typeof sample.text === 'string');
  return accepted.length
    ? detector.analyze(accepted.map(sample => ({ text: sample.text, expected_count: sample.count })))
    : null;
}

export function createReport(source, engine) {
  return {
    schema: SCHEMA,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    engine: { ...engine.identity },
    source: publicSource(source),
    sampling: 'codex-native-fresh-sessions',
    expectedInReference: engine.models.includes(source.model),
    samples: [], analysis: null, error: null, cancelled: false,
    usage: { input: null, output: null, cachedInput: null, knownSamples: 0 },
  };
}

export function completeReport(report, samples, engine) {
  report.analysis = null;
  // 不保存父任务标识、工作目录或原始服务端错误；数字探针保留以便复查。
  report.samples = samples.map(sample => ({
    challengeId: sample.challengeId,
    prompt: sample.prompt,
    count: sample.count,
    text: sample.text,
    error: sample.error,
    usage: sample.usage,
    elapsedMs: sample.elapsedMs,
  }));
  const known = samples.filter(sample =>
    Number.isFinite(sample.usage?.input) && Number.isFinite(sample.usage?.output));
  if (known.length) {
    report.usage = {
      input: known.reduce((sum, sample) => sum + sample.usage.input, 0),
      output: known.reduce((sum, sample) => sum + sample.usage.output, 0),
      cachedInput: known.every(sample => Number.isFinite(sample.usage.cachedInput))
        ? known.reduce((sum, sample) => sum + sample.usage.cachedInput, 0) : null,
      knownSamples: known.length,
    };
  }
  if (!report.error && !report.cancelled) report.analysis = scoreSamples(report.samples, engine.detector);
  return report;
}

export function reportRoot(env = process.env, platform = process.platform, home = homedir()) {
  const configured = env.CODEX_LM_DETECTOR_HOME || env.LM_DETECTOR_HOME;
  if (configured) return path.resolve(configured);
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData/Local'), 'codex-lm-detector');
  if (platform === 'darwin') return p.join(home, 'Library/Application Support/codex-lm-detector');
  return p.join(env.XDG_STATE_HOME || p.join(home, '.local/state'), 'codex-lm-detector');
}

export async function prepareReportDirectory(directory) {
  const root = path.resolve(directory || path.join(reportRoot(), 'reports'));
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await access(root, constants.W_OK);
  } catch {
    throw new CheckError('OUTPUT_UNAVAILABLE', '报告目录不可用，请检查路径和写入权限；尚未发起模型测试请求。');
  }
  return root;
}

export async function saveReport(report, directory) {
  const root = path.resolve(directory || path.join(reportRoot(), 'reports'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${report.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

export async function readReport(file, engine) {
  const bytes = await readFile(file);
  if (bytes.length > 4_000_000) throw new CheckError('INVALID_REPORT', '报告超过 4 MB，已拒绝读取。');
  const report = JSON.parse(bytes.toString('utf8'));
  if (![SCHEMA, 'lm-detector-codex/v1'].includes(report?.schema) || typeof report.source?.model !== 'string'
      || !Array.isArray(report.samples) || ![0, 3].includes(report.samples.length)
      || report.samples.some(sample => !Number.isSafeInteger(sample.count) || sample.count < 1
        || (sample.text !== null && typeof sample.text !== 'string'))
      || typeof report.cancelled !== 'boolean'
      || !report.engine || typeof report.createdAt !== 'string') {
    throw new CheckError('INVALID_REPORT', '不是受支持的 codex-lm-detector 检测报告。');
  }
  if (report.engine?.detectorSha256 !== engine.identity.detectorSha256
      || report.engine?.sdkVersion !== engine.identity.sdkVersion) {
    throw new CheckError('ENGINE_CHANGED', '报告与当前 SDK 或参考库版本不同，请用原版本复查。');
  }
  report.expectedInReference = engine.models.includes(report.source.model);
  return report;
}

export { renderReport } from './presentation.mjs';
