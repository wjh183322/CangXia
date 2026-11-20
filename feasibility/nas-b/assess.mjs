import caseManifest from './case-manifest.json' with { type: 'json' };
import {
  assertSameRun, attachmentIndex, cacheStates, normalizeAttachmentIndex, validateCaseEvidence, validateImageDigest
} from './src/evidence.mjs';

export const manifest = caseManifest;
const statuses = ['passed', 'failed', 'blocked', 'unrun'];
const statusName = { passed: '通过', failed: '失败', blocked: '受阻', unrun: '未测', pending: '待验收' };
const conclusionName = { feasible: '核心可行', conditional: '有条件', 'not-feasible': '不通过' };
const findingName = {
  'auth-verification-failed': '真实账号核验或必要人工验证失败',
  'missing-core-fields': '核心来源或字段缺失',
  'partial-page': '正式页半提交',
  'skipped-page': '游标跳过未完整提交的页',
  'unauthorized-access': '越过独占或访问控制',
  'stale-generation-write': '旧代际写入正式资料',
  'false-download-completion': '下载假报完成',
  'wrong-deletion': '误删文件',
  'volume-identity-mismatch': '数据卷身份混淆',
  'production-touched': '触碰生产资料',
  'sustained-playback-degradation': '合理资源下持续影响浏览或播放'
};
const releaseGateName = {
  'windows-product': '成品 Windows 界面与操作',
  'windows-business': '成品业务对照',
  'windows-latency': '成品 Windows 局域网列表、封面、播放和混合负载',
  'two-windows': '两台真实 Windows 的独占与交接',
  'windows-sleep': '真实 Windows 休眠与恢复',
  'actual-wan': '真实异地及 Tailscale 路径',
  'migration-and-rollback': '完整迁移彩排及回退'
};
const migration = {
  id: 'MIGRATION', kinds: ['migration-rehearsal'], checks: ['migration-rehearsed', 'rollback-rehearsed']
};
const sleep = { id: 'LOCK-06', kinds: ['two-windows'], checks: ['sleep-resumed'] };
const takeWorst = values => ['failed', 'blocked', 'unrun', 'passed'].find(value => values.includes(value)) ?? 'unrun';

function resultFor(row, entry) {
  if (entry.status !== 'passed') return { status: entry.status };
  const missingChecks = (row.checks ?? []).filter(check => !entry.checks.includes(check));
  const missingMeasurements = Object.keys(row.measurements ?? {}).filter(name => entry.measurements[name] === undefined);
  if (row.requireImageDigest && !entry.imageDigest) missingChecks.push('image-digest');
  if (row.requireWanPath && !entry.wanPath) missingChecks.push('tailscale-direct-or-relay');
  if (missingChecks.length || missingMeasurements.length) {
    return { status: 'blocked', missingChecks, missingMeasurements };
  }
  const missedTargets = Object.entries(row.measurements ?? {}).filter(([name, rule]) => {
    const value = entry.measurements[name];
    return (rule.positive && value <= 0) || value < (rule.min ?? 0) || value > (rule.max ?? Infinity);
  }).map(([name]) => name);
  if (missedTargets.length) return { status: 'failed', missedTargets };
  return row.requireImageDigest ? { status: 'passed', imageDigest: entry.imageDigest } : { status: 'passed' };
}

function latestResult(row, relevant) {
  if (!relevant.length) return { status: 'unrun' };
  const latest = relevant.at(-1).timestamp;
  // At the same observation time, a pass cannot hide a submitted failure.
  const outcomes = relevant.filter(entry => entry.timestamp === latest).map(entry => resultFor(row, entry));
  const outcome = outcomes.find(result => result.status === takeWorst(outcomes.map(item => item.status)));
  if (outcome.status === 'passed' && new Set(outcomes.map(item => item.imageDigest)).size > 1) {
    return { status: 'blocked', missingChecks: ['unambiguous-image-digest'] };
  }
  return outcome;
}

function latencyResult(row, attempts) {
  // Startup can fail before a cache state is known. Each state needs a newer result for this client kind.
  const scopes = cacheStates.map(scope => latestResult(row, attempts.filter(entry =>
    entry.cacheState === scope || (entry.cacheState === undefined && entry.status !== 'passed'))));
  const missingScopes = cacheStates.filter(scope => !attempts.some(entry => entry.cacheState === scope));
  const status = takeWorst(scopes.map(scope => scope.status));
  return {
    status: status === 'unrun' ? 'blocked' : status, missingScopes,
    missingChecks: [...new Set(scopes.flatMap(scope => scope.missingChecks ?? []))],
    missingMeasurements: [...new Set(scopes.flatMap(scope => scope.missingMeasurements ?? []))],
    missedTargets: [...new Set(scopes.flatMap(scope => scope.missedTargets ?? []))]
  };
}

function caseResult(row, attempts) {
  const relevant = attempts.filter(entry => row.kinds.includes(entry.kind) &&
    (row.id !== 'AUTH-03' || !entry.checks.includes('challenge-not-observed')));
  if (!row.requireCacheStates || !relevant.length) return latestResult(row, relevant);
  // A complete scope must come from the same type of client.
  const results = [...new Set(relevant.map(entry => entry.kind))]
    .map(kind => latencyResult(row, relevant.filter(entry => entry.kind === kind)));
  return results.find(result => result.status === 'passed') ??
    results.find(result => result.status === takeWorst(results.map(item => item.status)));
}

function assessCase(row, attempts, findings) {
  const outcome = caseResult(row, attempts);
  if (findings.length) outcome.status = 'failed';
  return { ...row, ...outcome, attempts };
}

function challengeUncovered(attempts) {
  const live = attempts.filter(entry => entry.kind === 'nas-live');
  return live.length > 0 && live.every(entry => entry.status === 'passed' && entry.checks.includes('challenge-not-observed')) &&
    latestResult({ checks: ['controlled-verification'] }, attempts.filter(entry => entry.kind === 'nas-fault')).status === 'passed';
}

function collectFindings(entries) {
  const findings = new Map();
  for (const entry of entries) {
    const { caseId, kind, status, timestamp } = entry;
    const codes = [...entry.blockers];
    if (kind === 'nas-live' && status === 'failed' && ['AUTH-01', 'AUTH-03'].includes(caseId)) {
      codes.push('auth-verification-failed');
    }
    for (const code of codes) {
      findings.set(caseId + '/' + code, { caseId, code, kind, timestamp });
    }
  }
  return [...findings.values()];
}

function reconcileDeployment(cases, policy) {
  const approved = policy.approvedImageDigest === undefined ? undefined : validateImageDigest(policy.approvedImageDigest);
  const deployment = cases.filter(row => ['DEPLOY-01', 'DEPLOY-03'].includes(row.id));
  const passed = deployment.filter(row => row.status === 'passed');
  const [pulled, reviewed] = passed;
  let missing;
  if (passed.length === 1) missing = 'matching-nas-and-registry-evidence';
  if (passed.length === 2 && (!pulled.imageDigest || pulled.imageDigest !== reviewed.imageDigest)) {
    missing = 'matching-image-digest';
  }
  if (approved && passed.some(row => row.imageDigest !== approved)) missing = 'approved-image-digest';
  if (!missing) return;
  for (const row of passed) {
    row.status = 'blocked';
    row.missingChecks = [missing];
  }
}

function matchIndexes(entries, indexes) {
  const available = new Map(indexes.map(normalizeAttachmentIndex).filter(Boolean).map(index => [index.name, index]));
  const matched = new Map();
  for (const entry of entries) {
    const expected = attachmentIndex(entry);
    const actual = available.get(expected.name);
    if (actual && actual.caseId === expected.caseId && actual.kind === expected.kind && actual.timestamp === expected.timestamp) {
      matched.set(expected.name, expected);
    }
  }
  return [...matched.values()];
}

export function assessRun({ manifest: matrix = manifest, evidence, policy = {}, indexes = [] }) {
  const entries = evidence.map(validateCaseEvidence).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  for (const entry of entries) assertSameRun(entries[0], entry);

  const attempts = new Map();
  for (const entry of entries) {
    if (!attempts.has(entry.caseId)) attempts.set(entry.caseId, []);
    attempts.get(entry.caseId).push(entry);
  }
  const byId = id => attempts.get(id) ?? [];
  const blockers = collectFindings(entries);
  const cases = matrix.map(row => assessCase(row, byId(row.id), blockers.filter(item => item.caseId === row.id)));
  reconcileDeployment(cases, policy);
  const uncovered = challengeUncovered(byId('AUTH-03')) ? ['AUTH-03'] : [];
  const required = cases.filter(row => row.stage === 'development');
  const pending = required.filter(row => row.status !== 'passed' && !uncovered.includes(row.id)).map(row => row.id);
  const failed = required.some(row => row.status === 'failed');

  const candidateCase = id => cases.find(row => row.id === id);
  const gateOutcome = (id, kind) => {
    const row = candidateCase(id);
    return row ? caseResult({ ...row, kinds: [kind] }, byId(id)).status : 'unrun';
  };
  const gates = {
    'windows-product': candidateCase('COMPAT-01')?.status ?? 'unrun',
    'windows-business': candidateCase('COMPAT-02')?.status ?? 'unrun',
    'windows-latency': takeWorst(['PERF-02', 'PERF-03', 'PERF-04'].map(id => gateOutcome(id, 'windows-product'))),
    'two-windows': takeWorst(Array.from({ length: 6 }, (_, index) => gateOutcome('LOCK-0' + (index + 1), 'two-windows'))),
    'windows-sleep': caseResult(sleep, byId(sleep.id)).status,
    'actual-wan': candidateCase('PERF-06')?.status ?? 'unrun',
    'migration-and-rollback': caseResult(migration, byId(migration.id)).status
  };
  const releasePending = Object.keys(gates).filter(gate => gates[gate] !== 'passed');
  if (policy.requireReleaseForDevelopment === true) pending.push(...releasePending);

  const developmentStatus = blockers.length || failed ? 'blocked' : pending.length ? 'pending' : 'passed';
  const releaseStatus = developmentStatus === 'blocked' || Object.values(gates).includes('failed') ? 'blocked'
    : developmentStatus === 'passed' && !releasePending.length ? 'passed' : 'pending';
  const groups = {};
  for (const row of cases) {
    const group = row.id.split('-')[0];
    groups[group] ??= Object.fromEntries(statuses.map(status => [status, 0]));
    groups[group][row.status]++;
  }
  const [first] = entries;
  const environment = first ? {
    runId: first.runId, revision: first.revision, configFingerprint: first.configFingerprint,
    start: first.timestamp, end: entries.at(-1).timestamp,
    imageDigests: [...new Set(entries.flatMap(entry => entry.imageDigest ?? []))],
    dependencyFingerprints: [...new Set(entries.flatMap(entry => entry.dependencyFingerprint ?? []))]
  } : null;
  return {
    conclusion: { passed: 'feasible', pending: 'conditional', blocked: 'not-feasible' }[developmentStatus],
    development: { status: developmentStatus, pending, uncovered },
    release: { status: releaseStatus, gates, pending: releasePending },
    environment, blockers, groups, cases, indexes: matchIndexes(entries, indexes)
  };
}

function localTime(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium', hour12: false
  }).format(new Date(timestamp));
}

function prettyMeasure(entry) {
  return Object.entries(entry.measurements).map(([name, value]) => name + '=' + value).join('，');
}

export function renderReport(assessment) {
  const { environment, development, release, groups, cases, indexes, blockers } = assessment;
  const pending = entries => entries.join('、') || '无';
  const lines = [
    '# 藏匣方案 B NAS 可行性报告', '',
    '## 1 结论', '',
    '原型结论：' + conclusionName[assessment.conclusion] + '。正式开发准入：' + statusName[development.status] +
      '。发布准入：' + statusName[release.status] + '。',
    '开发准入缺项：' + pending(development.pending) + '。',
    '真实验证未覆盖：' + pending(development.uncovered) + '。',
    '发布切换须另经用户审阅。', '', '## 2 环境与隔离记录', ''
  ];
  if (environment) lines.push(
    '运行编号：' + environment.runId,
    '源码提交：' + environment.revision,
    '配置指纹：' + environment.configFingerprint,
    '镜像 digest：' + (environment.imageDigests.join('、') || '未录入'),
    '依赖清单指纹：' + (environment.dependencyFingerprints.join('、') || '未录入'),
    'UTC：' + environment.start + ' 至 ' + environment.end,
    'America/New_York：' + localTime(environment.start) + ' 至 ' + localTime(environment.end),
    '现场环境与隔离判据见 ENV、DEPLOY 用例和证据索引。'
  );
  else lines.push('未录入环境或时间。报告时区为 America/New_York。');

  lines.push('', '## 3 样本与基线', '',
    '字段和样本对照见 DATA 用例。证据索引保留采集范围、审核过的检查标记和批准的数值字段。',
    '', '## 4 用例结果', '', '| 组别 | 通过 | 失败 | 受阻 | 未测 |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [name, counts] of Object.entries(groups)) {
    lines.push('| ' + [name, ...statuses.map(status => counts[status])].join(' | ') + ' |');
  }
  lines.push('', '| 编号 | 验证内容 | 通过依据 | 状态 | 已录入尝试及范围 |', '| --- | --- | --- | --- | --- |');
  for (const row of cases) {
    const details = row.attempts.map(entry => entry.kind + ' ' + statusName[entry.status] +
      (entry.checks.length ? '（' + entry.checks.join('、') + '）' : ''));
    if (row.missingChecks?.length) details.push('缺检查：' + row.missingChecks.join('、'));
    if (row.missingMeasurements?.length) details.push('缺测量：' + row.missingMeasurements.join('、'));
    if (row.missingScopes?.length) details.push('缺缓存场景：' + row.missingScopes.join('、'));
    if (row.missedTargets?.length) details.push('未达判据：' + row.missedTargets.join('、'));
    lines.push('| ' + [row.id, row.title, row.expected, statusName[row.status], details.join('；') || '无'].join(' | ') + ' |');
  }

  lines.push('', '## 5 数据完整性专项', '');
  lines.push(...(blockers.length ? blockers.map(entry =>
    '- ' + entry.caseId + ' · ' + findingName[entry.code] + ' · ' + entry.kind + ' · ' + entry.timestamp
  ) : ['当前记录无已确认的阻断项。完整性覆盖情况见 DATA、TX、LOCK、DL 用例。']));
  lines.push('', '## 6 性能专项', '');
  for (const row of cases.filter(row => row.id.startsWith('PERF-'))) {
    const observations = row.attempts.filter(entry => Object.keys(entry.measurements).length)
      .map(entry => [entry.kind, entry.cacheState ?? entry.wanPath, prettyMeasure(entry)].filter(Boolean).join(' '));
    lines.push('- ' + row.id + ' ' + row.title + ' · ' + statusName[row.status] + ' · ' + (observations.join('；') || '无测量值'));
  }
  lines.push('', '## 7 已知问题与证据索引', '',
    '手工记录的范围与判据须按证据复核。当前报告保留同一运行内的安全阻断及复测记录。');
  for (const index of indexes.map(normalizeAttachmentIndex).filter(Boolean)) {
    lines.push('- ' + index.caseId + ' · ' + index.kind + ' · ' + index.timestamp + ' · ' + index.name);
  }
  lines.push('', '## 8 下一阶段准入和回退', '');
  for (const [id, status] of Object.entries(release.gates)) {
    lines.push('- ' + releaseGateName[id] + ' · ' + statusName[status]);
  }
  lines.push('', '## 9 审阅', '', '执行、复核和用户决定待单独确认。');
  return lines.join('\n') + '\n';
}
