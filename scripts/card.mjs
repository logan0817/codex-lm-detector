import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { presentationFor, renderReport, reportLink } from './presentation.mjs';

const escape = value => String(value ?? '').slice(0, 600).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const ICONS = {
  completed: 'chart-column', partial: 'circle-dashed', unscorable: 'info',
  error: 'circle-alert', cancelled: 'circle-stop',
};

export async function renderCard(report, replay = false) {
  const view = presentationFor(report);
  const template = await readFile(new URL('../assets/result-card.html', import.meta.url), 'utf8');
  const facts = [];
  if (report.source?.model) {
    facts.push(`<dt>所选模型</dt><dd>${escape(report.source.model)} <span class="result-secondary">· ${escape(report.source.effort || '默认')}</span></dd>`);
  }
  if (view.candidate) facts.push(`<dt>最接近候选</dt><dd class="result-strong">${escape(view.candidate)}</dd>`);
  if (view.probability) facts.push(`<dt>库内相对概率</dt><dd>${escape(view.probability)} <span class="result-secondary">· 不代表身份确认</span></dd>`);
  const table = view.results.length ? `<table class="result-table" aria-label="前五名候选及库内相对概率">
    <thead><tr><th scope="col">前五名候选</th><th scope="col">库内相对概率</th></tr></thead>
    <tbody>${view.results.map(item => `<tr><td>${escape(item.model)}</td><td>${escape(item.probability || view.probabilityReason)}</td></tr>`).join('')}</tbody>
  </table>` : '';
  const values = {
    STATUS: view.status, ICON: ICONS[view.status], TITLE: escape(view.title), DETAIL: escape(view.detail),
    FACTS: facts.length ? `<dl class="result-facts">${facts.join('')}</dl>` : '', TABLE: table,
    SAMPLES: escape(view.samples), INPUT: escape(view.input), OUTPUT: escape(view.output),
    ISSUES: view.candidate && view.errors.length ? `<p class="result-note">未完成样本：${escape(view.errors.join('、'))}。</p>` : '',
    COVERAGE: view.usageCoverage ? `<p class="result-note">${escape(view.usageCoverage)}</p>` : '',
    HISTORY: replay ? '历史结果 · 未发起新请求' : '本次检测结果',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error('未知的结果卡片字段。');
    return values[key];
  });
}

export async function resultOutput(result, { env = process.env, terminal = Boolean(process.stdout.isTTY) } = {}) {
  const { report, file, replay = false } = result;
  if (result.saveError) {
    const json = JSON.stringify(report, null, 2);
    const fence = '`'.repeat(Math.max(3, ...(json.match(/`+/g) || []).map(run => run.length + 1)));
    return `${renderReport(report, null, replay)}\n\n报告保存失败。请将下方完整 JSON 保存为 .json 文件后复查，无需重新检测。\n\n${fence}json\n${json}\n${fence}`;
  }
  const thread = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  const desktop = /desktop/i.test(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || report.source?.originator || '');
  if (!desktop || terminal || !/^[a-zA-Z0-9_-]{8,128}$/.test(thread || '')) return renderReport(report, file, replay);
  try {
    const html = await renderCard(report, replay);
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n, i) => i ? String(n).padStart(2, '0') : String(n));
    const directory = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'visualizations', ...date, thread);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const card = path.join(directory, `codex-lm-detector-${randomUUID()}.html`);
    await writeFile(card, html, { flag: 'wx', mode: 0o600 });
    const reference = `visualize${JSON.stringify({ path: card.replaceAll('\\', '/') })}`;
    return [reference, reportLink(file)].filter(Boolean).join('\n\n');
  } catch {
    return '卡片暂不可用，以下为文字结果。\n\n' + renderReport(report, file, replay);
  }
}
