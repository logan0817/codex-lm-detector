const TITLES = {
  completed: '检测完成 · 已生成候选排名',
  partial: '已生成部分样本排名',
  unscorable: '本次无法生成有效排名',
  error: '检测未完成',
  cancelled: '检测已取消',
};

const plain = value => String(value ?? '未知').replace(/[\r\n\t]/g, ' ').slice(0, 200);
const inline = value => plain(value).replace(/[\\`*_{}\[\]<>!|]/g, '\\$&');
export const formatCount = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : '未返回';
const target = file => String(file).replaceAll('\\', '/').replace(/[<>\r\n]/g, value => encodeURIComponent(value));

export function formatProbability(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  if (value > 0.999) return '>99.9%';
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(1)}%`;
}

export function presentationFor(report) {
  const analysis = report.analysis;
  const ranked = ['scored', 'partial'].includes(analysis?.decision);
  const calibrated = analysis?.decision === 'scored' && analysis.used_outputs === 3
    && analysis.probability_status === 'reference_calibrated';
  let status;
  let detail;
  if (report.cancelled) {
    status = 'cancelled';
    detail = '本次不作指纹判断，已返回的样本和用量保留在报告中。';
  } else if (report.error) {
    status = report.error.code === 'SOURCE_CHANGED' ? 'unscorable' : 'error';
    detail = `${plain(report.error.code)} · ${plain(report.error.message)}`;
  } else if (!ranked) {
    const failure = report.samples?.find(sample => sample.error)?.error;
    status = analysis?.decision === 'not_model' || (analysis && !failure) ? 'unscorable' : 'error';
    detail = analysis?.decision === 'not_model'
      ? '上游判定数字序列不像语言模型回答，本次不提供排名。'
      : '没有足够的有效回答，本次无法排名。';
    if (failure) detail += ` ${plain(failure.code)} · ${plain(failure.message)}`;
  } else if (analysis.decision === 'partial' || analysis.used_outputs !== 3) {
    status = 'partial';
    detail = `本次仅有 ${formatCount(analysis.used_outputs)}/3 条有效样本；已保留候选排名，概率需要三条有效样本，暂不计算。`;
    if (!report.expectedInReference) detail += ' 所选型号未单独收录，仅展示近似候选。';
  } else {
    status = 'completed';
    detail = !report.expectedInReference
      ? '所选型号未单独收录，仅展示近似候选，暂不判断是否匹配。'
      : analysis.prediction === report.source.model
        ? '第一候选与所选型号一致；这表示数字指纹接近，不能确认后台模型身份。'
        : '第一候选与所选型号不同；结果不能确认后台模型身份，也不能据此认定换模。';
    if (!calibrated) detail += ' 上游未提供校准概率，本次仅展示排名。';
  }
  const showRanking = ranked && !report.cancelled && !report.error;
  const top = showRanking ? analysis.results?.[0] : null;
  // 身份证据不足不等于库内校准概率不可用。
  const showProbability = showRanking && calibrated;
  const probabilityReason = analysis?.used_outputs < 3
    ? `有效样本不足（${formatCount(analysis.used_outputs)}/3）`
    : !calibrated ? '上游未提供校准概率' : '上游未返回该候选概率';
  const probability = showProbability ? formatProbability(top?.probability) : null;
  const results = showRanking ? (analysis.results || []).slice(0, 5).map(item => ({
    model: plain(item.model), probability: showProbability ? formatProbability(item.probability) : null,
  })) : [];
  const sampleCount = showRanking ? analysis.used_outputs
    : report.samples?.some(sample => !sample.error && typeof sample.text === 'string') ? null : 0;
  const usage = report.usage || {};
  const usageCoverage = usage.knownSamples > 0 && usage.knownSamples < 3
    ? `仅 ${formatCount(usage.knownSamples)}/3 条返回用量` : '';
  return { status, title: TITLES[status], detail, probability, probabilityReason, sampleCount, results, usageCoverage,
    candidate: showRanking ? top?.model || analysis.prediction : null,
    samples: sampleCount === null ? '未判定' : `${formatCount(sampleCount)}/3`,
    input: formatCount(usage.input), output: formatCount(usage.output),
    errors: report.samples?.filter(sample => sample.error).map(sample => plain(sample.error.code)) || [] };
}

export function reportLink(file) {
  return file ? `[查看完整报告](<${target(file)}>)` : '';
}

export function renderReport(report, file, replay = false) {
  const view = presentationFor(report);
  const lines = [];
  if (replay) lines.push('**历史检测报告离线复查 · 未发起新请求**');
  lines.push(`**Codex LM Detector · ${view.title}**`, inline(view.detail));
  if (report.source?.model) {
    lines.push(`所选模型：**${inline(report.source.model)}**（${inline(report.source.effort || '默认')}）`);
  }
  if (view.candidate) {
    lines.push(`最接近候选：**${inline(view.candidate)}**`
      + (view.probability ? ` · 库内相对概率 **${view.probability}**` : ''));
  }
  if (view.results.length) {
    lines.push(['| 前五名候选 | 库内相对概率 |', '| --- | ---: |',
      ...view.results.map(item => `| ${inline(item.model)} | ${item.probability || inline(view.probabilityReason)} |`)].join('\n'));
  }
  const coverage = view.usageCoverage ? `（${view.usageCoverage}）` : '';
  lines.push(`有效样本 **${view.samples}** · 输入 Token **${view.input}** / 输出 Token **${view.output}**${coverage}`);
  if (view.candidate && view.errors.length) lines.push(`未完成样本：${view.errors.map(inline).join('、')}。`);
  if (file) lines.push(reportLink(file));
  lines.push('仅比较当前配置的新请求；库内相对概率不代表后台模型身份或能力。');
  return lines.join('\n\n');
}
