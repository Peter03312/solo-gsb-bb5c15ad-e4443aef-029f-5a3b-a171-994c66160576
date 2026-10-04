'use strict';

// 所有时刻均以「当日 00:00 起的分钟数」表示，输入输出统一为 HH:MM。

function pad2(n) { return String(n).padStart(2, '0'); }

function timeToMin(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minToTime(v) {
  if (v === null || v === undefined) return null;
  const m = ((v % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * 拓扑排序 + 环检测（DFS，确定性顺序：按 id 升序）。
 * cues: [{id}], deps: [{from, to}]（from 为前置，to 为后项）
 * 返回 { order: [id], cycle: [id, ...] | null }
 */
function topoAnalyze(cues, deps) {
  const ids = cues.map((c) => c.id).sort((a, b) => a - b);
  const adj = new Map();
  ids.forEach((id) => adj.set(id, []));
  for (const d of deps) {
    if (adj.has(d.from) && adj.has(d.to)) adj.get(d.from).push(d.to);
  }
  adj.forEach((list) => list.sort((a, b) => a - b));

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;

  function dfs(u) {
    if (cycle) return;
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx).concat(v);
        return;
      }
      if (color.get(v) === WHITE) dfs(v);
      if (cycle) return;
    }
    stack.pop();
    color.set(u, BLACK);
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id);
    if (cycle) break;
  }

  if (cycle) return { order: null, cycle };

  const order = [];
  const done = new Set();
  function visit(u) {
    if (done.has(u)) return;
    for (const v of adj.get(u)) visit(v);
    done.add(u);
    order.push(u);
  }
  ids.forEach(visit); // post-order：反转后保证前置在前、后项在后
  order.reverse();
  return { order, cycle: null };
}

function halfOpenOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 发布前计划校验。
 * cues: [{id, code, position, plannedStart, duration}]
 * deps: [{from, to}]
 * 返回 { ok, errors: [{ type, message, codes: [] }] }
 */
function validatePlan(cues, deps) {
  const errors = [];
  const byId = new Map(cues.map((c) => [c.id, c]));

  // 1) 依赖关系环
  const { cycle } = topoAnalyze(cues, deps);
  if (cycle) {
    errors.push({
      type: 'CYCLE',
      codes: cycle.map((id) => (byId.get(id) || {}).code || `#${id}`),
      message: `前置依赖存在环：${cycle.map((id) => (byId.get(id) || {}).code || `#${id}`).join(' → ')}`,
    });
  }

  // 2) 前置项计划结束不晚于后项计划开始
  const depBad = [];
  for (const d of deps) {
    const a = byId.get(d.from);
    const b = byId.get(d.to);
    if (!a || !b) continue;
    if (a.plannedStart + a.duration > b.plannedStart) {
      depBad.push({ a, b });
    }
  }
  if (depBad.length) {
    errors.push({
      type: 'DEP_ORDER',
      codes: [...new Set(depBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: depBad
        .map(({ a, b }) => {
          const aEnd = minToTime(a.plannedStart + a.duration);
          return `前置「${a.code}」计划结束 ${aEnd} 晚于后项「${b.code}」开始 ${minToTime(b.plannedStart)}`;
        })
        .join('；'),
    });
  }

  // 3) 同岗位时段不重叠（半开区间：首尾相接允许）
  const byPosition = new Map();
  for (const c of cues) {
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  const overlapBad = [];
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.plannedStart >= a.plannedStart + a.duration) continue;
        if (halfOpenOverlap(a.plannedStart, a.plannedStart + a.duration,
                            b.plannedStart, b.plannedStart + b.duration)) {
          overlapBad.push({ position, a, b });
        }
      }
    }
  }
  if (overlapBad.length) {
    errors.push({
      type: 'POSITION_OVERLAP',
      codes: [...new Set(overlapBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: overlapBad
        .map(({ position, a, b }) =>
          `岗位「${position}」时段冲突：「${a.code}」(${minToTime(a.plannedStart)}-${minToTime(a.plannedStart + a.duration)}) 与「${b.code}」(${minToTime(b.plannedStart)}-${minToTime(b.plannedStart + b.duration)})`)
        .join('；'),
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 现场联排：结合登记的实际/预计时间重算尚未开始项。
 * publishedCues: [{id(=cueRef), code, title, position, plannedStart, duration}]
 * deps: [{from, to}]（以 cueRef 表示）
 * regs: Map/object keyed by cueRef -> {actualStart, actualEnd, estimatedEnd, skipped, rowVer, updatedBy, updatedAt}
 *
 * 舞监标记为跳过的项：状态 SKIPPED，不产生待执行时段，不参与前置顺延与岗位冲突，
 * 其他项仍按现有前置与登记规则重算。
 * 返回 { cues: [...], conflicts: [{position,a,b,message}], orderProblem: null|message }
 */
function computeLive(publishedCues, deps, regMap) {
  const byId = new Map(publishedCues.map((c) => [c.id, c]));
  const preds = new Map();
  publishedCues.forEach((c) => preds.set(c.id, []));
  for (const d of deps) {
    if (preds.has(d.to) && byId.has(d.from)) preds.get(d.to).push(d.from);
  }

  const { order } = topoAnalyze(
    publishedCues.map((c) => ({ id: c.id })),
    deps.map((d) => ({ from: d.from, to: d.to }))
  );

  const calc = new Map();
  if (!order) {
    return { cues: [], conflicts: [], orderProblem: '已发布数据检测到依赖环，无法重算' };
  }

  for (const id of order) {
    const cue = byId.get(id);
    const r = regMap.get(id) || {};
    const as = r.actualStart ?? null;
    const ae = r.actualEnd ?? null;
    const ee = r.estimatedEnd ?? null;
    const skipped = r.skipped === true || r.skipped === 1;

    let status, schedStart, schedEnd, effStart;

    if (skipped) {
      // 已跳过：只展示，不产生待执行时段；其前置约束对后项不再生效（前置不可执行导致本项一同跳过）
      status = 'SKIPPED';
      schedStart = null;
      schedEnd = null;
    } else if (ae !== null) {
      status = 'DONE';
      schedStart = as;
      schedEnd = ae;
    } else if (as !== null) {
      status = 'RUNNING';
      schedStart = as;
      schedEnd = ee !== null ? ee : as + cue.duration;
    } else {
      status = 'PENDING';
      let start = cue.plannedStart; // 开始时刻不得早于原计划
      for (const p of preds.get(id)) {
        const pc = calc.get(p);
        // 已跳过的前置不计入待执行时段：不约束后项开始
        if (pc && pc.status !== 'SKIPPED') start = Math.max(start, pc.schedEnd);
      }
      effStart = start;
      schedStart = start;
      schedEnd = ee !== null ? ee : start + cue.duration;
    }

    calc.set(id, {
      ...cue,
      status,
      actualStart: as,
      actualEnd: ae,
      estimatedEnd: ee,
      skipped,
      schedStart,
      schedEnd,
      delayed: status === 'PENDING' && schedStart > cue.plannedStart,
      rowVer: r.rowVer ?? 1,
      updatedBy: r.updatedBy ?? null,
      updatedAt: r.updatedAt ?? null,
    });
  }

  // 顺延之后的岗位冲突：跳过项不计入，且至少一方未完成
  const conflicts = [];
  const byPosition = new Map();
  for (const c of calc.values()) {
    if (c.status === 'SKIPPED') continue;
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.schedStart - b.schedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.schedStart >= a.schedEnd) continue;
        if (halfOpenOverlap(a.schedStart, a.schedEnd, b.schedStart, b.schedEnd)
            && (a.status !== 'DONE' || b.status !== 'DONE')) {
          conflicts.push({
            position,
            codes: [a.code, b.code],
            message: `岗位「${position}」执行时段冲突：「${a.code}」(${minToTime(a.schedStart)}-${minToTime(a.schedEnd)}) 与「${b.code}」(${minToTime(b.schedStart)}-${minToTime(b.schedEnd)})`,
          });
        }
      }
    }
  }

  // 按计划开始时间返回，便于现场阅读
  const cues = [...calc.values()].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
  return { cues, conflicts, orderProblem: null };
}

const EXPLAIN_STATUS_LABEL = { PENDING: '未开始', RUNNING: '已开始', DONE: '已完成', SKIPPED: '已跳过' };

/**
 * 排期开始来源解释（只读）。与现场重算共用同一 computeLive 结果，保证与同一版本的重算一致。
 *
 * 以目标项原计划开始为基线：
 * - 列出所有「结束时刻 = 最终最大约束时刻」的直接前置；同一最大时刻由多条路径共同决定时全部展示；
 * - 沿尚未开始的前置逐层追溯其结束时刻来源：实际完成 / 预计结束 / 按时长推算；
 * - 已跳过前置不构成约束（单独列出）；原计划本身决定开始时 decidedByPlan=true（无需顺延）；
 * - 目标已开始 / 已完成 / 已跳过时 applicable=false 并给出明确原因。
 *
 * publishedCues / deps / regMap 与 computeLive 入参相同；
 * cueRef 为目标提示项引用；skipReasons 可选 Map(cueRef -> 跳过原因)，仅用于展示。
 */
function explainSchedule(publishedCues, deps, regMap, cueRef, skipReasons) {
  const live = computeLive(publishedCues, deps, regMap);
  if (live.orderProblem) {
    return { applicable: false, reason: `已发布数据检测到依赖环，无法重算：${live.orderProblem}` };
  }
  const byId = new Map(live.cues.map((c) => [c.id, c]));
  const target = byId.get(cueRef);
  if (!target) return { notFound: true };

  const predsOf = new Map();
  publishedCues.forEach((c) => predsOf.set(c.id, []));
  for (const d of deps) {
    if (predsOf.has(d.to) && byId.has(d.from)) predsOf.get(d.to).push(d.from);
  }

  const brief = (c) => ({
    cueRef: c.id,
    code: c.code,
    title: c.title,
    position: c.position,
    status: c.status,
    statusLabel: EXPLAIN_STATUS_LABEL[c.status] || c.status,
  });

  if (target.status !== 'PENDING') {
    const reason = target.status === 'RUNNING'
      ? `「${target.code}」已于 ${minToTime(target.actualStart)} 实际开始，排期开始即实际开始，无需顺延解释`
      : target.status === 'DONE'
        ? `「${target.code}」已完成（实际开始 ${minToTime(target.actualStart)}，实际完成 ${minToTime(target.actualEnd)}），不存在待解释的排期开始`
        : `「${target.code}」已被舞监标记为跳过，不产生排期开始时刻（已跳过前置不构成约束）`;
    return {
      applicable: false,
      cue: {
        ...brief(target),
        plannedStartText: minToTime(target.plannedStart),
        plannedEndText: minToTime(target.plannedStart + target.duration),
        actualStartText: minToTime(target.actualStart),
        actualEndText: minToTime(target.actualEnd),
      },
      reason,
    };
  }

  // 单个前置的结束时刻来源；未开始且按时长推算时继续向下追溯其重算开始的形成
  function traceNode(p, stack) {
    const node = { ...brief(p), end: p.schedEnd, endText: minToTime(p.schedEnd) };
    if (p.status === 'DONE') {
      node.endSource = 'actual';
      node.endSourceLabel = '实际完成';
      node.endDetail = `实际开始 ${minToTime(p.actualStart)}，实际完成 ${minToTime(p.actualEnd)}`;
    } else if (p.estimatedEnd !== null && p.estimatedEnd !== undefined) {
      node.endSource = 'estimated';
      node.endSourceLabel = '预计结束';
      node.endDetail = `${p.status === 'RUNNING' ? '已开始，' : ''}登记的预计结束 ${minToTime(p.estimatedEnd)}`;
    } else if (p.status === 'RUNNING') {
      node.endSource = 'duration';
      node.endSourceLabel = '按时长推算';
      node.endDetail = `实际开始 ${minToTime(p.actualStart)} + 时长 ${p.duration} 分`;
    } else {
      node.endSource = 'duration';
      node.endSourceLabel = '按时长推算';
      node.endDetail = `重算开始 ${minToTime(p.schedStart)} + 时长 ${p.duration} 分`;
      if (!stack.includes(p.id)) node.start = startExplain(p, stack.concat(p.id));
    }
    return node;
  }

  // 某未开始项的重算开始如何形成：原计划为基线，达到最终最大时刻的直接前置全部列出
  function startExplain(cue, stack) {
    const maxTime = cue.schedStart;
    const decidedByPlan = maxTime === cue.plannedStart;
    const constraints = [];
    const skippedPreds = [];
    const otherPreds = [];
    for (const pid of predsOf.get(cue.id) || []) {
      const p = byId.get(pid);
      if (!p) continue;
      if (p.status === 'SKIPPED') {
        // 已跳过前置不构成约束
        skippedPreds.push({
          ...brief(p),
          skipReason: skipReasons && skipReasons.get(pid) ? String(skipReasons.get(pid)) : null,
        });
      } else if (p.schedEnd === maxTime) {
        // 达到最终最大约束时刻的直接前置：多条路径共同决定时全部展示，不任意取舍
        constraints.push(traceNode(p, stack));
      } else {
        otherPreds.push({ ...brief(p), end: p.schedEnd, endText: minToTime(p.schedEnd) });
      }
    }
    return {
      plannedStart: cue.plannedStart,
      plannedStartText: minToTime(cue.plannedStart),
      schedStart: maxTime,
      schedStartText: minToTime(maxTime),
      decidedByPlan,
      delayed: maxTime > cue.plannedStart,
      constraints,
      skippedPreds,
      otherPreds,
    };
  }

  const start = startExplain(target, [target.id]);
  const delayMinutes = target.schedStart - target.plannedStart;
  const summary = start.decidedByPlan
    ? `「${target.code}」按原计划 ${minToTime(target.plannedStart)} 开始，无需顺延`
      + (start.constraints.length ? `；另有 ${start.constraints.length} 条前置结束时刻恰与原计划相同（未造成顺延）` : '')
    : `「${target.code}」重算开始 ${minToTime(target.schedStart)}，较原计划 ${minToTime(target.plannedStart)} 顺延 ${delayMinutes} 分钟；`
      + `达到最终约束时刻 ${minToTime(target.schedStart)} 的直接前置共 ${start.constraints.length} 条，全部展示`;

  return {
    applicable: true,
    cue: {
      ...brief(target),
      plannedStart: target.plannedStart,
      plannedStartText: minToTime(target.plannedStart),
      plannedEndText: minToTime(target.plannedStart + target.duration),
      duration: target.duration,
      schedStart: target.schedStart,
      schedStartText: minToTime(target.schedStart),
      schedEnd: target.schedEnd,
      schedEndText: minToTime(target.schedEnd),
      estimatedEndText: minToTime(target.estimatedEnd),
      delayed: target.delayed,
    },
    baselineText: minToTime(target.plannedStart),
    maxTimeText: minToTime(target.schedStart),
    delayMinutes,
    decidedByPlan: start.decidedByPlan,
    delayed: start.delayed,
    constraints: start.constraints,
    skippedPreds: start.skippedPreds,
    otherPreds: start.otherPreds,
    summary,
  };
}

module.exports = { timeToMin, minToTime, topoAnalyze, validatePlan, computeLive, explainSchedule };
