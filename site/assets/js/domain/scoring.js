// 评分引擎：纯函数，不读全局状态、不碰 DOM。
// 输入 = (病例, 答卷, 规则表)，输出 = 总分 + 每个模块的覆盖/惩罚明细，
// 因此可以在不启动网页的情况下被 node:test 直接验证。
'use strict';

import { caseItems, digest, norm } from './case.js';

export const MODULE_LABEL = { history: '病史', physical: '体格', aux: '辅助', diagnosis: '诊断', treatment: '治疗' };
export const MODULE_ORDER = ['history', 'physical', 'aux', 'diagnosis', 'treatment'];
const EMPTY = new Set();

// 内置兜底表：仅在 site/rules/official-rule.json 缺失时使用（结构缺失 ≠ 内容不合法，
// 后者必须拒绝启动，见 normalizeRules 与 README）。数值必须与规则文件逐项一致。
export const BUILTIN_RULES_VERSION = 'builtin-0.2.0';
export const DEFAULT_RULES = {
  ruleVersion: BUILTIN_RULES_VERSION,
  status: 'placeholder-curve',
  // 权重沿用官网口径：治疗不计入满分门槛
  weights: { history: 10, physical: 10, aux: 70, diagnosis: 10, treatment: 0 },

  // ⚠️ 占位惩罚曲线。limits 里的 standard/reasonable/max 与 cost* 都是官网真实阈值，
  // 但官网「超过合理线之后每超一项扣几分」的曲线并不在生成数据里。
  // 实测到真实曲线后改的是 site/rules/official-rule.json，不要改这张表，更不要改下面的计算。
  excess: { from: 'reasonable', to: 'max', maxFraction: 1 },
  overdiagnosis: { perItem: 0.25, maxFraction: 1 },
  combine: 'max',   // 同一模块的多条超额惩罚取最重的一条，避免次数与花费双重惩罚

  // 证据判读（支持/不支持）先作为独立维度输出，不参与总分——官网未给出它的分值。
  evidence: { weight: 0 },
};

// 规则表外置后的形状补齐：文件可以只写它想覆盖的字段，其余落回内置默认，
// 并把「哪些字段其实来自兜底」原样报告出去——评分卡要能说明自己跑的是哪套数。
export function normalizeRules(raw) {
  const fromBuiltin = [];
  const base = DEFAULT_RULES;
  const src = raw || {};
  const pick = (sec, def) => {
    const v = src[sec] == null ? {} : src[sec];
    const out = {};
    for (const k of Object.keys(def)) {
      if (v[k] == null) { out[k] = def[k]; fromBuiltin.push(`${sec}.${k}`); }
      else out[k] = v[k];
    }
    return out;
  };
  const scalar = (key, def) => {
    if (src[key] == null) { fromBuiltin.push(key); return def; }
    return src[key];
  };
  return {
    rules: {
      ruleVersion: src.ruleVersion == null ? base.ruleVersion : src.ruleVersion,
      status: src.status == null ? base.status : src.status,
      weights: pick('weights', base.weights),
      excess: pick('excess', base.excess),
      overdiagnosis: pick('overdiagnosis', base.overdiagnosis),
      combine: scalar('combine', base.combine),
      evidence: pick('evidence', base.evidence),
    },
    fromBuiltin,
  };
}

const canonicalRules = r => JSON.stringify([
  r.weights.history, r.weights.physical, r.weights.aux, r.weights.diagnosis, r.weights.treatment,
  r.excess.from, r.excess.to, r.excess.maxFraction,
  r.overdiagnosis.perItem, r.overdiagnosis.maxFraction, r.combine, r.evidence.weight,
]);

// 只摘要「会改变分数的量」，不含 ruleVersion/status——版本号是人写的标签，
// 摘要负责回答「这份成绩单是不是由当前这套数算出来的」。
export function rulesDigest(rules) { return digest(canonicalRules(rules)); }

export function formatWeights(rules) {
  return MODULE_ORDER.map(k => `${MODULE_LABEL[k]}${rules.weights[k] == null ? 0 : rules.weights[k]}%`).join(' · ');
}

export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function pickedSetOf(answer, sec) { return (answer.picked && answer.picked[sec]) || EMPTY; }

// 只统计确实属于本病例的键：持久化里的陈旧键不得继续影响计数或得分
export function livePicked(caseObj, answer, sec) {
  const known = new Set(caseItems(caseObj.sections, sec).map(i => i.key));
  return [...pickedSetOf(answer, sec)].filter(k => known.has(k));
}

// 覆盖率先保持既有口径：分母为该板块全部条目的分值之和
// （生成数据里非必要项 score=0，因此分母实际等于必要项分值；schema 校验会盯住这个前提）
export function moduleCoverage(caseObj, answer, sec) {
  const items = caseItems(caseObj.sections, sec);
  const picked = pickedSetOf(answer, sec);
  let denom = 0, numer = 0;
  for (const it of items) {
    denom += it.score;
    if (picked.has(it.key) && it.nec) numer += it.score;
  }
  return denom ? numer / denom : 1;
}

export function limitMetrics(caseObj, answer, sec) {
  const L = (caseObj.limits || {})[sec];
  if (!L) return [];
  const out = [];
  if (sec === 'aux') {
    out.push({ metric: 'count', label: '检查次数', value: answer.auxCheckCount || 0, lim: L });
    const cost = caseItems(caseObj.sections, 'aux')
      .filter(i => pickedSetOf(answer, 'aux').has(i.key))
      .reduce((a, i) => a + i.cost, 0);
    out.push({ metric: 'cost', label: '花费', value: cost, lim: { standard: L.costStandard, reasonable: L.costReasonable, max: L.costMax } });
  } else {
    out.push({ metric: 'count', label: sec === 'history' ? '提问数' : sec === 'physical' ? '检查项目数' : '措施数', value: livePicked(caseObj, answer, sec).length, lim: L });
  }
  return out.filter(m => m.lim && m.lim.max);
}

// 超额惩罚：≤ 合理线不扣，合理线→上限之间线性加重，到上限扣满 maxFraction
export function excessFraction(value, lim, rules) {
  const r = rules.excess;
  const from = lim[r.from] == null ? lim[r.to] : lim[r.from];
  const to = lim[r.to];
  if (!to || value <= from) return 0;
  if (to <= from) return r.maxFraction;
  return clamp01((value - from) / (to - from)) * r.maxFraction;
}

export function limitPenalties(caseObj, answer, sec, rules) {
  return limitMetrics(caseObj, answer, sec).map(m => ({
    sec, metric: m.metric, label: m.label, value: m.value,
    from: m.lim.reasonable == null ? m.lim.max : m.lim.reasonable, to: m.lim.max,
    fraction: excessFraction(m.value, m.lim, rules),
  })).filter(p => p.fraction > 0);
}

const synonymsOf = a => (a.synonyms || '').split(/[，,、]/).map(norm).filter(Boolean);

// 「学生写的诊断名 ↔ 标准答案」的匹配只有这一份实现。
// 评分与临床推理链都要用它——两处各写一遍的话，评分算作命中的诊断
// 会在思维链里被算成「标准答案里没有」，同一个答案两种说法。
export function matchStandardDiagnosis(standard, userText) {
  if (userText == null) return false;
  return norm(standard.name) === norm(userText) || synonymsOf(standard).includes(norm(userText));
}
export function findStandard(standards, userText) {
  return (standards || []).find(a => matchStandardDiagnosis(a, userText)) || null;
}
export function findUserText(standards, standard, selected) {
  return (selected || []).find(un => matchStandardDiagnosis(standard, un));
}

export function diagnosisAssessment(caseObj, answer, rules) {
  const answers = caseObj.sections.diagnosis || [];
  const clsMap = answer.diagClass || {};
  const selected = Object.keys(answer.diagMarks || {});
  const findByUser = un => findStandard(answers, un);
  const findUser = a => findUserText(answers, a, selected);

  const totalScore = answers.reduce((s, a) => s + (a.score || 1), 0);
  let hitScore = 0;
  const matched = [];
  for (const a of answers) {
    const un = findUser(a);
    if (!un) continue;
    matched.push({ user: un, answer: a.name });
    if (norm(clsMap[un] || '未分类') === norm(a.cls || '未分类')) hitScore += a.score || 1;
  }
  const coverage = totalScore ? hitScore / totalScore : 1;
  const invalid = selected.filter(un => !findByUser(un));
  const unclassified = selected.filter(un => !clsMap[un]);
  return {
    coverage,
    invalid,
    unclassified,
    matched,
    fraction: Math.min(rules.overdiagnosis.maxFraction, invalid.length * rules.overdiagnosis.perItem),
  };
}

// 独立维度：证据「支持/不支持」判读。官网未给这一维分值，故只输出、不计入总分。
// 持久化里标记是数组、内存里是 Set，两种形状都可能出现（刷新后 / 提交前各一种）。
export function asSet(v) { return v instanceof Set ? v : new Set(v || []); }

// 逐条比对学生在一个诊断标准依据树上的判读。
// 评分（汇总命中率）与临床推理链（逐条还原）共用这一份，
// 否则两条链会对同一次标记给出不同的对错结论。
export function judgeEvidence(standard, sup, uns) {
  const units = [];
  let marked = 0, correct = 0;
  for (const src of Object.keys((standard && standard.bySrc) || {})) {
    for (const u of standard.bySrc[src]) {
      const k = norm(u.text);
      const s = sup.has(k), t = uns.has(k);
      if (s || t) {
        marked++;
        if ((u.support && s) || (!u.support && t)) correct++;
      }
      units.push({
        src, item: u.item, sub: u.sub, content: u.content,
        standardSupport: !!u.support,
        marked: s ? 'support' : t ? 'unsupport' : null,
      });
    }
  }
  return { units, marked, correct, accuracy: marked ? correct / marked : null };
}

export function evidenceReview(caseObj, answer) {
  const answers = caseObj.sections.diagnosis || [];
  let marked = 0, correct = 0;
  for (const name of Object.keys(answer.diagMarks || {})) {
    const a = findStandard(answers, name);
    if (!a || !a.bySrc) continue;
    const m = answer.diagMarks[name] || {};
    const r = judgeEvidence(a, asSet(m.support), asSet(m.unsupport));
    marked += r.marked;
    correct += r.correct;
  }
  return { marked, correct, accuracy: marked ? correct / marked : null };
}

export function computeScore(caseObj, answer, rules) {
  const R = rules || DEFAULT_RULES;
  const diag = diagnosisAssessment(caseObj, answer, R);
  const breakdown = [];
  const penalties = [];

  for (const sec of MODULE_ORDER) {
    const weightPct = R.weights[sec] == null ? 0 : R.weights[sec];
    let coverage, pens;
    if (sec === 'diagnosis') {
      coverage = diag.coverage;
      pens = diag.fraction > 0
        ? [{ sec, metric: 'overdiagnosis', label: '过度诊断', value: diag.invalid.length, from: 0, to: null, fraction: diag.fraction }]
        : [];
    } else {
      coverage = moduleCoverage(caseObj, answer, sec);
      pens = limitPenalties(caseObj, answer, sec, R);
    }
    const frac = R.combine === 'max'
      ? pens.reduce((a, p) => Math.max(a, p.fraction), 0)
      : clamp01(pens.reduce((a, p) => a + p.fraction, 0));
    const rate = clamp01(coverage * (1 - frac));
    // 分值必须能对上账：模块实际少拿的那部分，只记在「生效的那条」惩罚上。
    // combine='max' 时若每条都记全额，明细里的扣分之和会大于真实扣分。
    for (const p of pens) {
      p.binding = R.combine === 'max' ? p.fraction === frac : true;
      p.points = p.binding ? -(weightPct * coverage * p.fraction) : 0;
      penalties.push(p);
    }
    breakdown.push({
      key: sec,
      label: MODULE_LABEL[sec],
      weight: weightPct + '%',
      weightPct,
      coverage,
      penalty: frac,
      rate,
      points: weightPct * rate,
      lost: weightPct * coverage - weightPct * rate,
      penalties: pens,
    });
  }

  const total = breakdown.reduce((s, b) => s + b.points, 0);
  return {
    total,
    breakdown,
    penalties,
    notes: {
      unclassifiedDiagnoses: diag.unclassified,
      invalidDiagnoses: diag.invalid,
      evidence: evidenceReview(caseObj, answer),
    },
  };
}
