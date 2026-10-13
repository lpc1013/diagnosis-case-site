'use strict';
// 评分引擎回归测试。不启动网页，直接喂 (病例, 答卷, 规则)。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const DOMAIN = p => path.join(__dirname, '..', 'site', 'assets', 'js', 'domain', p);
const { computeScore, DEFAULT_RULES, moduleCoverage, excessFraction, diagnosisAssessment } = require(DOMAIN('scoring.js'));
const { caseItems, keyOf, norm, safeCost } = require(DOMAIN('case.js'));
const { validateCases } = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'data', 'schema.js'));

// 同一问题「呕血?」刻意出现在两个分类下，用于验证键不再碰撞
function fixtureCase() {
  return {
    idx: 0,
    name: '示例病例',
    limits: {
      history: { standard: 5, reasonable: 8, max: 10 },
      physical: { standard: 3, reasonable: 5, max: 6 },
      aux: { standard: 4, reasonable: 6, max: 8, costStandard: 100, costReasonable: 150, costMax: 200 },
      treatment: { standard: 2, reasonable: 3, max: 4 },
    },
    sections: {
      history: [
        { category: '现病史', subs: [
          { name: '主要症状', items: [{ q: '呕血?', reply: '是', necessary: true, score: 2 }, { q: '腹胀?', reply: '无', necessary: true, score: 1 }] },
          { name: '伴随症状', items: [{ q: '腹痛?', reply: '有', necessary: true, score: 1 }, { q: '腹泻?', reply: '无', necessary: false, score: 0 }] },
        ] },
        { category: '既往史', subs: [
          { name: '疾病史', items: [{ q: '呕血?', reply: '既往无', necessary: true, score: 1 }, { q: '手术史?', reply: '无', necessary: true, score: 1 }] },
        ] },
      ],
      physical: [
        { name: '一般检查', items: [{ name: '体温', result: '36.8', necessary: true, score: 1 }, { name: '指甲', result: '正常', necessary: false, score: 0 }] },
      ],
      aux: [
        { name: '化验单', children: [{ name: '血常规', result: 'Hb 90', necessary: true, score: 3, cost: 20 }, { name: '便常规', result: '-', necessary: false, score: 0, cost: 40 }] },
        { name: '影像', children: [{ name: '胃镜', result: '糜烂', necessary: true, score: 4, cost: 120 }] },
      ],
      diagnosis: [
        { name: '急性糜烂出血性胃炎', cls: '主要诊断', score: 5, synonyms: '糜烂性胃炎', bySrc: { 病史采集: [{ text: '呕血', item: '呕血', content: '是', support: true }] } },
        { name: '失血性贫血', cls: '次要诊断', score: 2, bySrc: {} },
      ],
      treatment: [
        { group: '一般治疗', items: [{ name: '禁食', necessary: true, score: 2, scenes: ['急诊'] }, { name: '卧床休息', necessary: false, score: 0, scenes: [] }] },
      ],
    },
  };
}

const TREATMENT_DUP = {
  idx: 9, name: '治疗键碰撞用例', limits: {},
  sections: {
    history: [], physical: [], aux: [], diagnosis: [],
    treatment: [{ group: '操作项', items: [
      { name: '拆石膏', attr: '大）（紧急/门诊', necessary: false, score: 0, scenes: ['急诊'] },
      { name: '拆石膏', attr: '小）（紧急/门诊', necessary: true, score: 3, scenes: ['急诊'] },
    ] }],
  },
};

test('治疗项仅 attr 不同也必须各有各的键（真实四例每例都撞了 3 次）', () => {
  const items = caseItems(TREATMENT_DUP.sections, 'treatment');
  assert.strictEqual(items.length, 2);
  assert.notStrictEqual(items[0].key, items[1].key, '两条「拆石膏」共用了键');
  const picked = { treatment: new Set([items[1].key]), history: new Set(), physical: new Set(), aux: new Set() };
  const r = computeScore(TREATMENT_DUP, { picked, auxCheckCount: 0, diagMarks: {}, diagClass: {} }, DEFAULT_RULES);
  assert.strictEqual(moduleCoverage(TREATMENT_DUP, { picked }, 'treatment'), 1, '只选必要那条就该覆盖满');
  assert.strictEqual(r.breakdown.find(b => b.key === 'treatment').coverage, 1);
});

function answer(c, opts) {
  const picked = {};
  for (const sec of ['history', 'physical', 'aux', 'treatment']) {
    picked[sec] = new Set(caseItems(c.sections, sec).filter(i => opts.pick && opts.pick(sec, i)).map(i => i.key));
  }
  const diagMarks = {};
  const diagClass = {};
  for (const name of (opts.diagnoses || [])) {
    const [n, cls] = Array.isArray(name) ? name : [name, undefined];
    diagMarks[n] = { support: new Set(opts.marks || []), unsupport: new Set() };
    if (cls) diagClass[n] = cls;
  }
  return { picked, auxCheckCount: opts.auxRuns || 0, diagMarks, diagClass, scores: {}, hintDismissed: false, activeDiag: {} };
}

const pickAllNecessary = () => (sec, i) => i.nec;

test('必要项全选 + 正确分类 → 满分 100', () => {
  const c = fixtureCase();
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 2, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const r = computeScore(c, a, DEFAULT_RULES);
  assert.strictEqual(r.total, 100, JSON.stringify(r.breakdown, null, 1));
  assert.deepStrictEqual(r.penalties, []);
});

test('病史同名问题在不同分类下键独立，勾选互不影响', () => {
  const c = fixtureCase();
  const hist = caseItems(c.sections, 'history').filter(i => i.label === '呕血?');
  assert.strictEqual(hist.length, 2, '语料应含两条同名问题');
  assert.notStrictEqual(hist[0].key, hist[1].key, '旧实现下这两条会共用一个键');
  for (const h of hist) assert.ok(h.key.split('|').length === 4, '病史键应含 分类/小节/问题 三段: ' + h.key);

  const a = answer(c, { pick: (sec, i) => sec === 'history' && i.label === '呕血?' && i.key.includes(norm('现病史')) });
  const covered = caseItems(c.sections, 'history').filter(i => a.picked.history.has(i.key)).map(i => i.key);
  assert.strictEqual(covered.length, 1);
});

test('必要线内增加无效检查不提高成绩', () => {
  const c = fixtureCase();
  const base = computeScore(c, answer(c, { pick: pickAllNecessary(), auxRuns: 2, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] }), DEFAULT_RULES);
  const withJunk = computeScore(c, answer(c, {
    pick: (sec, i) => i.nec || i.label === '便常规' || i.label === '腹泻?' || i.label === '卧床休息',
    auxRuns: 3,
    diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']],
  }), DEFAULT_RULES);
  assert.ok(withJunk.total <= base.total, `加无效项后反而升高: ${base.total} -> ${withJunk.total}`);
});

test('超过合理线后，继续增加无效检查必然扣分', () => {
  const c = fixtureCase();
  // 辅助合理线=6 次：做 7 次检测动作就该出现惩罚
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 6, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const at6 = computeScore(c, a, DEFAULT_RULES);
  assert.deepStrictEqual(at6.penalties, [], '恰好等于合理线不应扣分');
  const b = answer(c, { pick: pickAllNecessary(), auxRuns: 7, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const at7 = computeScore(c, b, DEFAULT_RULES);
  assert.ok(at7.total < at6.total, `超合理线未扣分: ${at6.total} -> ${at7.total}`);
  const p = at7.penalties.find(x => x.sec === 'aux' && x.metric === 'count');
  assert.ok(p, '缺少辅助检查次数惩罚条目');
  assert.strictEqual(p.value, 7); assert.strictEqual(p.from, 6); assert.strictEqual(p.to, 8);
  assert.ok(p.points < 0, '惩罚条目必须带负分值以便追溯');
});

test('到硬上限时该模块按超额惩罚归零', () => {
  const c = fixtureCase();
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 8, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const r = computeScore(c, a, DEFAULT_RULES);
  const aux = r.breakdown.find(b => b.key === 'aux');
  assert.strictEqual(aux.penalty, 1);
  assert.strictEqual(aux.points, 0);
});

test('花费超线触发惩罚，且与次数惩罚取最重不叠加', () => {
  const c = fixtureCase();
  // 必要项花费 20+120=140 ≤ 合理线 150；再选一项无关的 便常规(40) => 180 落在 150..200 之间
  const clean = answer(c, { pick: pickAllNecessary(), auxRuns: 1, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const costly = answer(c, { pick: (sec, i) => i.nec || i.label === '便常规', auxRuns: 1, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const r0 = computeScore(c, clean, DEFAULT_RULES);
  const r1 = computeScore(c, costly, DEFAULT_RULES);
  assert.deepStrictEqual(r0.penalties, [], '必要项花费未超线却报了惩罚');
  const cost = r1.penalties.find(p => p.metric === 'cost');
  assert.ok(cost, '花费 180 超过合理线 150 未产生惩罚');
  assert.strictEqual(cost.value, 180);
  assert.strictEqual(cost.from, 150);
  assert.strictEqual(cost.to, 200);
  assert.ok(Math.abs(cost.fraction - 0.6) < 1e-9, '线性惩罚比例不符: ' + cost.fraction);
  const aux = r1.breakdown.find(b => b.key === 'aux');
  assert.strictEqual(aux.penalty, 0.6, '次数惩罚应为 0，最终惩罚等于花费惩罚');
  assert.ok(Math.abs(aux.points - 70 * 0.4) < 1e-9);
});

test('诊断未分类不再被默认成「主要诊断」', () => {
  const c = fixtureCase();
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 1, diagnoses: ['急性糜烂出血性胃炎', '失血性贫血'] });
  const r = computeScore(c, a, DEFAULT_RULES);
  const diag = r.breakdown.find(b => b.key === 'diagnosis');
  assert.ok(diag.coverage < 1, '未分类却拿到满分，说明默认值仍被当成学生选择');
  assert.deepStrictEqual(r.notes.unclassifiedDiagnoses.sort(), ['失血性贫血', '急性糜烂出血性胃炎'].sort());
});

test('过度诊断按占位规则扣分并可在明细里追溯', () => {
  const c = fixtureCase();
  const good = answer(c, { pick: pickAllNecessary(), auxRuns: 1, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const bloated = answer(c, { pick: pickAllNecessary(), auxRuns: 1, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断'], ['冠心病', '主要诊断']] });
  const r1 = computeScore(c, good, DEFAULT_RULES);
  const r2 = computeScore(c, bloated, DEFAULT_RULES);
  assert.ok(r2.total < r1.total, `多写一个不存在的诊断居然不扣分: ${r1.total} -> ${r2.total}`);
  const p = r2.penalties.find(x => x.metric === 'overdiagnosis');
  assert.ok(p && p.value === 1 && p.sec === 'diagnosis');
  assert.deepStrictEqual(r2.notes.invalidDiagnoses, ['冠心病']);
});

test('同义诊断名视为同一诊断，不触发过度诊断', () => {
  const c = fixtureCase();
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 1, diagnoses: [['糜烂性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const r = computeScore(c, a, DEFAULT_RULES);
  assert.deepStrictEqual(r.notes.invalidDiagnoses, []);
  assert.strictEqual(r.total, 100);
});

test('同一组操作无论点选顺序如何都得同一结果', () => {
  const c = fixtureCase();
  const build = reverse => {
    const items = caseItems(c.sections, 'aux').filter(i => i.nec);
    const list = reverse ? items.slice().reverse() : items;
    return { picked: { aux: new Set(list.map(i => i.key)), history: new Set(), physical: new Set(), treatment: new Set() }, auxCheckCount: 2, diagMarks: {}, diagClass: {}, scores: {} };
  };
  assert.strictEqual(computeScore(c, build(false), DEFAULT_RULES).total, computeScore(c, build(true), DEFAULT_RULES).total);
});

test('覆盖分母含非必要项分值的前提会在 schema 校验里报出来', () => {
  const c = fixtureCase();
  c.sections.aux[0].children[1].score = 9;   // 把非必要项写成有分值
  const problems = validateCases([c]);
  assert.ok(problems.some(p => p.code === 'NON_NECESSARY_SCORED'), '应警告满分不可达');
});

test('cost 脏数据被降级为 0 而不是拼进 HTML/累计', () => {
  assert.strictEqual(safeCost('<img src=x>'), 0);
  assert.strictEqual(safeCost('-5'), 0);
  assert.strictEqual(safeCost('12.5'), 12.5);
  assert.strictEqual(safeCost(undefined), 0);
});

test('excessFraction 语义：≤合理线 0，线性到上限封顶', () => {
  const lim = { standard: 4, reasonable: 6, max: 8 };
  assert.strictEqual(excessFraction(6, lim, DEFAULT_RULES), 0);
  assert.strictEqual(excessFraction(7, lim, DEFAULT_RULES), 0.5);
  assert.strictEqual(excessFraction(8, lim, DEFAULT_RULES), 1);
  assert.strictEqual(excessFraction(99, lim, DEFAULT_RULES), 1);
});

test('惩罚系数表可整体替换（实测官网曲线后只改规则）', () => {
  const c = fixtureCase();
  const a = answer(c, { pick: pickAllNecessary(), auxRuns: 7, diagnoses: [['急性糜烂出血性胃炎', '主要诊断'], ['失血性贫血', '次要诊断']] });
  const soft = JSON.parse(JSON.stringify(DEFAULT_RULES));
  soft.excess.maxFraction = 0.2;
  const base = computeScore(c, a, DEFAULT_RULES).total;
  const lenient = computeScore(c, a, soft).total;
  assert.ok(lenient > base && lenient < 100, `规则表没生效: ${base} / ${lenient}`);
});

test('应用状态→答卷投影：跳过这层引擎会读空（曾经真实发生过）', () => {
  const { caseAnswer } = require(DOMAIN('answer.js'));
  const c = fixtureCase();
  // 应用里 picked / auxCheckCount / diagClass / diagMarks 都按病例编号分层
  const appState = {
    cur: 0,
    picked: {
      0: {
        history: new Set(caseItems(c.sections, 'history').filter(i => i.nec).map(i => i.key)),
        physical: new Set(caseItems(c.sections, 'physical').filter(i => i.nec).map(i => i.key)),
        aux: new Set(caseItems(c.sections, 'aux').filter(i => i.nec).map(i => i.key)),
        treatment: new Set(caseItems(c.sections, 'treatment').filter(i => i.nec).map(i => i.key)),
      },
    },
    auxCheckCount: { 0: 1 },
    diagClass: { 0: { '急性糜烂出血性胃炎': '主要诊断', '失血性贫血': '次要诊断' } },
    diagMarks: { 0: { '急性糜烂出血性胃炎': { support: new Set(), unsupport: new Set() }, '失血性贫血': { support: new Set(), unsupport: new Set() } } },
  };
  const projected = caseAnswer(appState, 0);
  const good = computeScore(c, projected, DEFAULT_RULES);
  assert.strictEqual(good.total, 100, '按应用真实形状作答应能满分，实得 ' + good.total);
  // 直接把整个 state 交给引擎（少投影一层）——键找不到，分数会静默塌成 0
  const bad = computeScore(c, appState, DEFAULT_RULES);
  assert.ok(bad.total < 20, '未投影时引擎本该读空；若这条不为 0，说明引擎又开始自己猜状态了：' + bad.total);
});

test('扣分明细之和必须等于实际扣分（不能出现两条各记全额）', () => {
  const c = fixtureCase();
  // 同时踩中「检查次数」和「花费」两条线，combine=max 只应扣一次
  const a = answer(c, { pick: () => true, auxRuns: 8, diagnoses: [] });
  const r = computeScore(c, a, DEFAULT_RULES);
  const auxPens = r.penalties.filter(p => p.sec === 'aux');
  assert.strictEqual(auxPens.length, 2, '本例应同时踩中次数与花费两条线: ' + JSON.stringify(r.penalties));
  assert.strictEqual(auxPens.filter(p => p.binding).length, 1, '取最重时应只有一条生效');
  const declared = r.penalties.reduce((s, p) => s + p.points, 0);
  const actual = r.breakdown.reduce((s, b) => s + (b.lost || 0), 0);
  assert.ok(Math.abs(declared + actual) < 1e-9, `明细 ${declared.toFixed(2)} 与实际少拿 ${actual.toFixed(2)} 对不上账`);
});

// —— 真实数据（缺失则跳过；仓库不含 8MB 生成数据） ——
const REAL = path.join(__dirname, '..', 'site', 'data', 'cases.json');
test('真实四例：结构校验 + 全选必要项可达满分', { skip: !fs.existsSync(REAL) }, () => {
  const cases = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const problems = validateCases(cases);
  const errors = problems.filter(p => p.level === 'error');
  assert.deepStrictEqual(errors.map(p => p.msg), [], '真实数据存在结构性错误');
  for (const p of problems.filter(x => x.level === 'warn')) {
    console.log('  [warn]', p.msg);
  }
  for (const c of cases) {
    const picked = {};
    for (const sec of ['history', 'physical', 'aux', 'treatment']) picked[sec] = new Set(caseItems(c.sections, sec).filter(i => i.nec).map(i => i.key));
    const diagMarks = {}, diagClass = {};
    for (const d of c.sections.diagnosis) { diagMarks[d.name] = { support: new Set(), unsupport: new Set() }; diagClass[d.name] = d.cls; }
    const lim = (c.limits && c.limits.aux) || {};
    const r = computeScore(c, { picked, auxCheckCount: Math.max(0, Math.min(lim.reasonable || 0, lim.standard || 0)), diagMarks, diagClass }, DEFAULT_RULES);
    assert.strictEqual(Math.round(r.total), 100, c.name + ' 全选必要项应得满分: ' + JSON.stringify(r.breakdown.map(b => [b.key, b.coverage, b.penalty])));
    assert.ok(r.notes.unclassifiedDiagnoses.length === 0);
  }
});
