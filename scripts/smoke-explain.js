'use strict';
// 前端冒烟测试：在 jsdom 中加载真实 index.html + app.js，mock fetch 跑通现场/回看渲染与解释弹窗。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = '';

function makeV(overrides = {}) {
  const cues = [
    { id: 1, code: 'L1', title: '灯光1', position: '灯光', plannedStart: 1140, duration: 5,
      plannedStartText: '19:00', schedStartText: '19:00', schedEndText: '19:08',
      actualStartText: '19:00', actualEndText: '19:08', estimatedEndText: null,
      status: 'DONE', delayed: false, rowVer: 3, corrections: [], skip: null, handover: null },
    { id: 4, code: 'L2', title: '灯光2', position: '灯光', plannedStart: 1150, duration: 8,
      plannedStartText: '19:10', schedStartText: '19:15', schedEndText: '19:23',
      actualStartText: null, actualEndText: null, estimatedEndText: null,
      status: 'PENDING', delayed: true, rowVer: 1, corrections: [], skip: null, handover: null },
    { id: 2, code: 'S1', title: '音乐1', position: '音响', plannedStart: 1145, duration: 3,
      plannedStartText: '19:05', schedStartText: '19:08', schedEndText: '19:15',
      actualStartText: '19:08', actualEndText: null, estimatedEndText: '19:15',
      status: 'RUNNING', delayed: false, rowVer: 2, corrections: [], skip: null, handover: null },
    { id: 6, code: 'L3', title: '灯光3', position: '灯光', plannedStart: 1160, duration: 4,
      plannedStartText: '19:20', schedStartText: null, schedEndText: null,
      actualStartText: null, actualEndText: null, estimatedEndText: null,
      status: 'SKIPPED', delayed: false, rowVer: 2, corrections: [],
      skip: { reason: '设备故障', skippedBy: '舞监', skippedAt: '2026-10-04 20:00:00', rootCode: 'S1', rootCueRef: 2 }, handover: null },
    { id: 3, code: 'P1', title: '道具1', position: '道具', plannedStart: 1145, duration: 6,
      plannedStartText: '19:05', schedStartText: '19:05', schedEndText: '19:11',
      actualStartText: null, actualEndText: null, estimatedEndText: null,
      status: 'PENDING', delayed: false, rowVer: 1, corrections: [], skip: null, handover: null },
  ];
  return {
    id: 1, versionNo: 1, note: '测试版', createdAt: '2026-10-04 19:00:00', isLatest: true,
    cues, conflicts: [], orderProblem: null, deputies: [], ...overrides,
  };
}

const explainDelayed = {
  versionId: 1, versionNo: 1, isLatest: true,
  target: { cueRef: 4, code: 'L2', title: '灯光2', position: '灯光', status: 'PENDING',
    plannedStartText: '19:10', plannedEndText: '19:18', schedStartText: '19:15', schedEndText: '19:23',
    actualStartText: null, actualEndText: null, estimatedEndText: null, duration: 8, delayed: true },
  plannedStartText: '19:10', schedStartText: '19:15', delayed: true, explainable: true, needsDelay: true,
  summary: '排期开始由原计划开始 19:10 顺延至 19:15，由 1 条直接前置约束决定。',
  ruleText: '重算规则：开始 = max(原计划开始，各未跳过前置的重算结束)；已跳过前置不构成约束。',
  decisiveCount: 1,
  decisiveTrees: [{
    cueRef: 2, code: 'S1', title: '音乐1', position: '音响', status: 'RUNNING',
    plannedStartText: '19:05', plannedEndText: '19:08', schedStartText: '19:08', schedEndText: '19:15',
    actualStartText: '19:08', actualEndText: null, estimatedEndText: '19:15', duration: 3, delayed: false,
    endSource: 'estimate', endSourceLabel: '预计结束', endBasisText: '结束取登记的预计结束 19:15',
    depth: 0, upstream: [], leaf: true, leafReason: '已实际开始，结束由实际开始与时长/预计结束确定，为现场事实来源',
  }],
  otherPreds: [{ cueRef: 9, code: 'X1', title: '弱前置', position: '道具', status: 'PENDING',
    plannedStartText: '19:00', plannedEndText: '19:05', schedStartText: '19:00', schedEndText: '19:05',
    actualStartText: null, actualEndText: null, estimatedEndText: null, duration: 5, delayed: false,
    note: '结束 19:05 不晚于原计划开始，不改变开始时刻' }],
  skippedPreds: [], activePredCount: 2,
};

const explainOnTime = {
  ...explainDelayed,
  target: { ...explainDelayed.target, code: 'P1', schedStartText: '19:05', delayed: false },
  schedStartText: '19:05', delayed: false, needsDelay: false,
  summary: '排期开始仍为原计划开始 19:05：未跳过前置的结束均未推后开始时刻，无需顺延。',
  decisiveCount: 0, decisiveTrees: [],
  otherPreds: [{ ...explainDelayed.otherPreds[0] }],
};

const explainSkipped = {
  versionId: 1, versionNo: 1, isLatest: true,
  target: { cueRef: 6, code: 'L3', status: 'SKIPPED', plannedStartText: '19:20', schedStartText: null, title: '灯光3', position: '灯光' },
  plannedStartText: '19:20', schedStartText: null, delayed: false,
  explainable: false, status: 'SKIPPED', reason: '该项已被舞监标记为跳过（不再执行），不产生待执行排期，无顺延来源',
};

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});
const { window } = dom;

let fetchIndex = 0;
window.fetch = (url, opts) => {
  const u = String(url);
  let payload = null;
  if (u === '/api/me') payload = { user: { id: 1, username: 'sm', role: 'sm', position: null, displayName: '舞监' }, positions: ['灯光', '音响', '道具'] };
  else if (u === '/api/live') payload = { version: makeV() };
  else if (u === '/api/live/deputies') payload = { versionId: 1, deputies: [], positions: ['灯光'], operators: [] };
  else if (u === '/api/versions') payload = { versions: [{ id: 1, versionNo: 1, note: '测试版', createdAt: 'x', regCount: 1, skipCount: 1, cueCount: 5 }] };
  else if (/\/api\/versions\/1\?/.test(u) || u.endsWith('/api/versions/1')) payload = makeV({ isLatest: true });
  else if (u.includes('/explain')) {
    fetchIndex += 1;
    payload = fetchIndex === 1 ? explainDelayed : explainOnTime;
  } else {
    payload = {};
  }
  return Promise.resolve({
    status: 200, ok: true,
    json: () => Promise.resolve(payload),
  });
};

window.eval(appjs);

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

setTimeout(async () => {
  const doc = window.document;
  // boot 自动以舞监登录并加载草稿页
  await new Promise((r) => setTimeout(r, 30));
  // 切到现场页
  const liveTab = [...doc.querySelectorAll('#tabs button')].find((b) => b.dataset.tab === 'live');
  liveTab.click();
  await new Promise((r) => setTimeout(r, 30));

  const liveRows = [...doc.querySelectorAll('#live-tbody tr')];
  assert(liveRows.length === 5, '现场表格渲染 5 行');
  const l2row = liveRows.find((r) => r.dataset.cue === '4');
  assert(/排期来源/.test(l2row.innerHTML), '未开始顺延项 L2 行出现「排期来源」按钮');
  const l1row = liveRows.find((r) => r.dataset.cue === '1');
  assert(!/排期来源/.test(l1row.innerHTML), '已完成项 L1 行不出现「排期来源」按钮');
  const s1row = liveRows.find((r) => r.dataset.cue === '2');
  assert(!/排期来源/.test(s1row.innerHTML), '已开始项 S1 行不出现「排期来源」按钮');
  const l3row = liveRows.find((r) => r.dataset.cue === '6');
  assert(!/排期来源/.test(l3row.innerHTML), '已跳过项 L3 行不出现「排期来源」按钮');
  const p1row = liveRows.find((r) => r.dataset.cue === '3');
  assert(/排期来源/.test(p1row.innerHTML), '未开始未顺延项 P1 行也出现「排期来源」按钮');

  // 打开 L2 解释（第一次返回 delayed）
  l2row.querySelector('button[data-act="open-explain"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const modal = doc.getElementById('modal-body');
  assert(/顺延至 19:15/.test(modal.textContent), '弹窗显示顺延结论');
  assert(/预计结束/.test(modal.textContent), '弹窗显示来源节点标记「预计结束」');
  assert(/S1/.test(modal.textContent), '弹窗包含上游 S1');
  assert(/不决定最终时刻|不改变开始时刻/.test(modal.textContent), '弹窗显示非决定性前置');
  assert(!/无需顺延/.test(modal.textContent), '顺延场景不误显无需顺延');

  // 刷新解释 → 第二次返回 ontime
  doc.getElementById('explain-refresh').click();
  await new Promise((r) => setTimeout(r, 50));
  assert(/无需顺延/.test(modal.textContent), '刷新后显示无需顺延结论');

  doc.getElementById('explain-close').click();

  // 切到版本页回看（isLatest=true 但走 detail 容器）
  const verTab = [...doc.querySelectorAll('#tabs button')].find((b) => b.dataset.tab === 'versions');
  verTab.click();
  await new Promise((r) => setTimeout(r, 30));
  doc.querySelector('button[data-act="view-version"]').click();
  await new Promise((r) => setTimeout(r, 30));
  const detailRows = [...doc.querySelectorAll('#version-detail tbody tr')];
  assert(detailRows.length === 5, '回看表格渲染 5 行');
  const dL2 = detailRows.find((r) => r.textContent.includes('L2'));
  assert(/排期来源/.test(dL2.innerHTML), '回看页未开始项出现「排期来源」按钮');

  // 已跳过目标 → explainable false 的渲染
  window.fetch = () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(explainSkipped) });
  const dL3 = detailRows.find((r) => r.textContent.includes('L3'));
  // L3 已跳过 → 无按钮；改为直接以 P1 行按钮触发但 fetch 返回 skipped 结果（模拟期间被跳过）
  const dP1 = detailRows.find((r) => r.textContent.includes('P1'));
  dP1.querySelector('button[data-act="open-explain"]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert(/无顺延来源/.test(modal.textContent), '目标已跳过时弹窗显示明确结论');
  doc.getElementById('explain-close').click();

  // 接口错误时弹窗给出明确提示且不抛出
  window.fetch = () => Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ message: '提示项不存在于该版本' }) });
  dP1.querySelector('button[data-act="open-explain"]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert(/提示项不存在于该版本/.test(modal.textContent), '404 时弹窗显示明确错误结果');

  console.log('\n全部前端冒烟用例通过');
  process.exit(0);
}, 100);
