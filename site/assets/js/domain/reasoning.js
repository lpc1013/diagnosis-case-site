// 临床推理链：把一份答卷还原成「发现线索 → 提出假设 → 寻找证据 → 排除 / 待排 → 确定诊断」的思维轨迹。
//
// 纯函数：输入 =（病例, 答卷, 可选的问诊步骤），不读 DOM、不读全局状态，
// 因此可以在不启动网页的情况下被 node:test 直接验证。
//
// 它刻意只做「还原」，不做「打分」：评分口径的唯一来源仍是 scoring.js + 规则表。
// 两边共用诊断名匹配（findStandard）与证据判读（judgeEvidence），
// 否则同一个答案会在评分里算命中、在思维链里算「标准答案中没有」。
'use strict';

import { caseItems } from './case.js';
import { findStandard, judgeEvidence, asSet } from './scoring.js';
import { interviewPath } from './interview-engine.js';

export const STAGES = [
  { key: 'clues', label: '发现线索' },
  { key: 'hypotheses', label: '提出假设' },
  { key: 'evidence', label: '寻找证据' },
  { key: 'ruled', label: '排除 / 待排' },
  { key: 'final', label: '确定诊断' },
];

// 分类 → 结论。表外的分类名一律落回「未分类」，不猜学生想说什么。
export const VERDICT_LABEL = {
  confirmed: '确立',
  secondary: '并列（其他诊断）',
  pending: '待排（鉴别诊断）',
  suspected: '疑似',
  unclassified: '未分类',
  spurious: '标准答案中没有',
};
const CLS_TO_VERDICT = { '主要诊断': 'confirmed', '次要诊断': 'secondary', '鉴别诊断': 'pending', '疑似诊断': 'suspected' };

const pickedItems = (caseObj, answer, sec) => {
  const picked = (answer.picked && answer.picked[sec]) || new Set();
  return caseItems(caseObj.sections || {}, sec).filter(i => picked.has(i.key));
};

export function hypothesisTrace(caseObj, answer) {
  const standards = (caseObj.sections || {}).diagnosis || [];
  const marksMap = answer.diagMarks || {};
  const clsMap = answer.diagClass || {};
  return Object.keys(marksMap).map((name, order) => {
    const std = findStandard(standards, name);
    const m = marksMap[name] || {};
    const sup = asSet(m.support), uns = asSet(m.unsupport);
    const j = std ? judgeEvidence(std, sup, uns) : { units: [], marked: 0, correct: 0, accuracy: null };
    const cls = clsMap[name] || null;
    const verdict = !std ? 'spurious' : CLS_TO_VERDICT[cls] || 'unclassified';
    const refutedMore = uns.size > sup.size;
    return {
      order,
      name,
      cls,
      standard: std ? std.name : null,
      standardCls: std ? std.cls || null : null,
      verdict,
      verdictLabel: VERDICT_LABEL[verdict],
      markedSup: sup.size,
      markedUnsup: uns.size,
      // 落在本病例标准依据树上的标记数（标记可能来自依据池，未必命中这棵标准树）
      onTree: j.marked,
      correct: j.correct,
      accuracy: j.accuracy,
      units: j.units,
      markedUnits: j.units.filter(u => u.marked),
      // 「你把它列为主要诊断，但你给它标的不支持证据比支持证据多」——
      // 这是思维自相矛盾，评分不会管它，复盘必须说出来。
      contradiction: verdict === 'confirmed' && refutedMore,
    };
  });
}

function clueList(caseObj, answer, opts) {
  const o = opts || {};
  const out = [];
  const steps = o.steps || [];
  if (steps.length) {
    const iv = interviewPath(steps, o.pickedIdxs || []);
    for (const p of iv.path) {
      for (const l of p.lines) out.push({ src: '病史采集', from: p.q, detail: l, step: p.step });
    }
  } else {
    for (const i of pickedItems(caseObj, answer, 'history')) out.push({ src: '病史采集', from: i.item.q, detail: i.item.reply });
  }
  for (const i of pickedItems(caseObj, answer, 'physical')) out.push({ src: '体格检查', from: i.item.name, detail: i.item.result });
  for (const i of pickedItems(caseObj, answer, 'aux')) {
    out.push({ src: '辅助检查', from: i.item.name, detail: [i.item.result, i.item.unit].filter(Boolean).join(' ') });
  }
  return out;
}

export function buildReasoning(caseObj, answer, opts) {
  const trace = hypothesisTrace(caseObj, answer);
  const standards = (caseObj.sections || {}).diagnosis || [];

  const clues = clueList(caseObj, answer, opts);
  const clueBySrc = {};
  for (const c of clues) clueBySrc[c.src] = (clueBySrc[c.src] || 0) + 1;

  const confirmed = trace.filter(t => t.verdict === 'confirmed');
  const ruled = [];
  for (const t of trace) {
    if (t.verdict === 'pending') ruled.push({ name: t.name, reason: '列为鉴别诊断：待排' });
    else if (t.verdict === 'suspected') ruled.push({ name: t.name, reason: '列为疑似诊断：尚未确立' });
    else if (t.verdict === 'spurious') ruled.push({ name: t.name, reason: '本病例标准答案中没有这个诊断（按过度诊断扣分）' });
    else if (t.contradiction) ruled.push({ name: t.name, reason: `标为主要诊断，但你标的不支持证据（${t.markedUnsup}）多于支持证据（${t.markedSup}）` });
  }
  const unclassified = trace.filter(t => t.verdict === 'unclassified');

  const claimedStandard = new Set(trace.filter(t => t.standard).map(t => t.standard));
  const missed = standards.filter(a => !claimedStandard.has(a.name)).map(a => ({ name: a.name, cls: a.cls || '未分类' }));

  const evidenceMarked = trace.reduce((s, t) => s + t.onTree, 0);
  const evidenceCorrect = trace.reduce((s, t) => s + t.correct, 0);

  const stageItems = {
    clues,
    hypotheses: trace,
    evidence: trace.filter(t => t.markedUnits.length || t.onTree),
    ruled,
    final: confirmed.concat(trace.filter(t => t.verdict === 'secondary')),
  };

  return {
    stages: STAGES.map(s => ({ key: s.key, label: s.label, items: stageItems[s.key] })),
    trace,
    summary: {
      clues: clues.length,
      clueBySrc,
      hypotheses: trace.length,
      confirmed: confirmed.length,
      pending: trace.filter(t => t.verdict === 'pending').length,
      spurious: trace.filter(t => t.verdict === 'spurious').length,
      unclassified: unclassified.length,
      contradictions: trace.filter(t => t.contradiction).length,
      missed: missed.length,
      evidenceMarked,
      evidenceAccuracy: evidenceMarked ? evidenceCorrect / evidenceMarked : null,
    },
    missed,
    unclassified: unclassified.map(t => t.name),
  };
}
