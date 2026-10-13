'use strict';
// 规则表外置 + 版本绑定的回归测试。
// 这批用例要盯的不是「函数算得对不对」，而是「改这张表，分数会不会跟着变」——
// 上一轮就栽在引擎接的是内置常量、页面接的也是内置常量，而规则文件根本没人读。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DOMAIN = p => path.join(ROOT, 'site', 'assets', 'js', 'domain', p);
const RULES_FILE = path.join(ROOT, 'site', 'rules', 'official-rule.json');

const { computeScore, DEFAULT_RULES, normalizeRules, rulesDigest, formatWeights, BUILTIN_RULES_VERSION } = require(DOMAIN('scoring.js'));
const { caseVersionOf, caseItems } = require(DOMAIN('case.js'));
const { validateRules, validateCases } = require(path.join(ROOT, 'site', 'assets', 'js', 'data', 'schema.js'));

const errs = ps => ps.filter(p => p.level === 'error');

function fixtureCase() {
  return {
    idx: 0, name: '示例病例', dept: '消化内科',
    limits: {
      history: { standard: 5, reasonable: 8, max: 10 },
      physical: { standard: 3, reasonable: 5, max: 6 },
      aux: { standard: 4, reasonable: 6, max: 8, costStandard: 100, costReasonable: 150, costMax: 200 },
      treatment: { standard: 2, reasonable: 3, max: 4 },
    },
    sections: {
      history: [{ category: '现病史', subs: [{ name: '主要症状', items: [
        { q: '呕血?', reply: '是', necessary: true, score: 2 },
        { q: '腹胀?', reply: '无', necessary: false, score: 0 }] }] }],
      physical: [{ name: '一般检查', items: [{ name: '体温', result: '36.8', necessary: true, score: 1 }] }],
      aux: [
        { name: '化验单', children: [{ name: '血红蛋白', cost: 20, necessary: true, score: 2 }] },
        { name: '影像', children: [{ name: '胃镜', cost: 100, necessary: true, score: 2 }] },
      ],
      diagnosis: [{ name: '上消化道出血', cls: '主要诊断', score: 1 }],
      treatment: [{ group: '一般治疗', items: [{ name: '卧床休息', necessary: true, score: 1 }] }],
    },
  };
}

// 全选必要项 + 分类正确 = 满分卷
function perfectAnswer(c) {
  const picked = {};
  for (const sec of ['history', 'physical', 'aux', 'diagnosis', 'treatment']) {
    picked[sec] = new Set(caseItems(c.sections, sec).filter(i => i.nec).map(i => i.key));
  }
  const diagMarks = {};
  for (const d of c.sections.diagnosis) diagMarks[d.name] = { support: new Set(), unsupport: new Set() };
  return { picked, auxCheckCount: 2, diagClass: { '上消化道出血': '主要诊断' }, diagMarks };
}

// 只做了化验、没做胃镜：辅助覆盖率 50%，用来暴露权重变化
function halfAuxAnswer(c) {
  const a = perfectAnswer(c);
  const blood = caseItems(c.sections, 'aux').find(i => i.item.name === '血红蛋白');
  a.picked.aux = new Set([blood.key]);
  a.auxCheckCount = 1;
  return a;
}

test('规则文件存在且通过结构校验', () => {
  assert.ok(fs.existsSync(RULES_FILE), 'site/rules/official-rule.json 必须在仓库里（它是计分标准本身，不是再生数据）');
  const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  assert.deepStrictEqual(errs(validateRules(raw)), [], '规则文件不应有 error 级问题');
});

test('规则文件与内置兜底逐项同值（搬家没改分）', () => {
  const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const { rules } = normalizeRules(raw);
  // 唯一允许的差别是版本号本身
  assert.strictEqual(rules.ruleVersion, raw.ruleVersion);
  assert.deepStrictEqual(rules.weights, DEFAULT_RULES.weights, 'weights 漂移：内置兜底没跟上规则文件');
  assert.deepStrictEqual(rules.excess, DEFAULT_RULES.excess, 'excess 漂移');
  assert.deepStrictEqual(rules.overdiagnosis, DEFAULT_RULES.overdiagnosis, 'overdiagnosis 漂移');
  assert.strictEqual(rules.combine, DEFAULT_RULES.combine);
  assert.deepStrictEqual(rules.evidence, DEFAULT_RULES.evidence);
  assert.strictEqual(rulesDigest(rules), rulesDigest(DEFAULT_RULES),
    '两份摘要不同 = 没有规则文件的机器会打出另一个分数；要么同步内置表，要么在 changelog 里写明这是旧版');
});

test('满分卷在规则文件下与内置兜底下同分', () => {
  const c = fixtureCase();
  const a = perfectAnswer(c);
  const { rules } = normalizeRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')));
  assert.strictEqual(computeScore(c, a, rules).total, computeScore(c, a, DEFAULT_RULES).total);
  assert.strictEqual(computeScore(c, a, rules).total, 100);
});

test('证伪：改规则文件里的权重，分数必须跟着塌（证明这张表真的被消费）', () => {
  const c = fixtureCase();
  // 必须是「部分正确」的答卷：满分卷每一项覆盖率都是 1，
  // 只要权重之和仍为 100，任何一套归一权重都得 100 —— 用它做样本这条证伪永远不会红。
  const partial = halfAuxAnswer(c);

  const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const before = computeScore(c, partial, normalizeRules(raw).rules).total;
  assert.strictEqual(Number(before.toFixed(2)), 65, '基线：辅助只做一半 ⇒ 10+10+35+10');
  const tampered = normalizeRules({ ...raw, weights: { ...raw.weights, aux: 40, diagnosis: 40 } });
  const after = computeScore(c, partial, tampered.rules).total;
  assert.notStrictEqual(after, before, '改了权重而分数不动 = 引擎读的不是这份表');
  assert.ok(after > before, `辅助降权、诊断升权应使「少做检查」的答卷分数上升（${before} → ${after}）`);
  assert.strictEqual(Number(after.toFixed(2)), 80);
});

test('证伪：改占位曲线的系数，扣分必须跟着变', () => {
  const c = fixtureCase();
  const a = {
    picked: { aux: new Set(caseItems(c.sections, 'aux').map(i => i.key)), history: new Set(), physical: new Set(), diagnosis: new Set(), treatment: new Set() },
    auxCheckCount: 9,   // 超出 reasonable 6，逼近 max 8
    diagClass: {}, diagMarks: {},
  };
  const base = computeScore(c, a, normalizeRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'))).rules);
  const looser = normalizeRules({
    ruleVersion: 'x', status: 'measured',
    weights: { history: 10, physical: 10, aux: 70, diagnosis: 10, treatment: 0 },
    excess: { from: 'reasonable', to: 'max', maxFraction: 0.2 },
    overdiagnosis: { perItem: 0.25, maxFraction: 1 }, combine: 'max', evidence: { weight: 0 },
  });
  const soft = computeScore(c, a, looser.rules);
  assert.ok(base.total < 100, '超线本应扣分');
  assert.ok(soft.total > base.total, `maxFraction 从 1 降到 0.2 应减轻扣分（${base.total.toFixed(1)} → ${soft.total.toFixed(1)}）`);
});

test('normalizeRules：缺字段回落内置并逐条点名', () => {
  const { rules, fromBuiltin } = normalizeRules({ ruleVersion: 'partial-1', weights: { aux: 70 } });
  assert.strictEqual(rules.ruleVersion, 'partial-1');
  assert.strictEqual(rules.weights.history, DEFAULT_RULES.weights.history);
  assert.ok(fromBuiltin.includes('weights.history'), '未提供的字段必须被报告出来');
  assert.ok(fromBuiltin.includes('excess.maxFraction'));
  assert.ok(fromBuiltin.includes('combine'), '标量字段缺省也要点名，否则报告会少说一项');
});

test('normalizeRules：空对象 = 完整内置表', () => {
  const { rules } = normalizeRules({});
  assert.strictEqual(rules.ruleVersion, BUILTIN_RULES_VERSION);
  assert.strictEqual(rulesDigest(rules), rulesDigest(DEFAULT_RULES));
});

test('validateRules 拒绝：未知字段 / 权重和≠100 / 非法 combine / 越界系数', () => {
  const good = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const cases = [
    [{ ...good, weightz: {} }, 'UNKNOWN_FIELD'],
    [{ ...good, weights: { ...good.weights, aux: 50 } }, 'WEIGHT_SUM'],
    [{ ...good, weights: { ...good.weights, bogus: 1 } }, 'UNKNOWN_SECTION'],
    [{ ...good, combine: 'worst' }, 'BAD_COMBINE'],
    [{ ...good, excess: { ...good.excess, maxFraction: 1.5 } }, 'BAD_FRACTION'],
    [{ ...good, excess: { from: 'sometimes', to: 'max', maxFraction: 1 } }, 'BAD_LIM_KEY'],
    [{ ...good, overdiagnosis: { perItem: -1, maxFraction: 1 } }, 'BAD_PER_ITEM'],
    [{ ...good, evidence: { weight: 5 } }, 'EVIDENCE_UNIMPLEMENTED'],
    [{ ...good, ruleVersion: '' }, 'NO_RULE_VERSION'],
  ];
  for (const [raw, code] of cases) {
    const found = errs(validateRules(raw)).map(p => p.code);
    assert.ok(found.includes(code), `${code} 应当被拒绝，实际报出 ${JSON.stringify(found)}`);
  }
  assert.deepStrictEqual(errs(validateRules('不是对象')), [{ level: 'error', code: 'NOT_OBJECT', msg: 'official-rule.json 顶层不是对象' }]);
});

test('rulesDigest：稳定且对计分量敏感', () => {
  const d0 = rulesDigest(DEFAULT_RULES);
  assert.strictEqual(rulesDigest(DEFAULT_RULES), d0, '同一张表两次摘要必须相同');
  assert.match(d0, /^[0-9a-f]{8}$/);
  const bump = normalizeRules({ weights: { ...DEFAULT_RULES.weights, physical: 9, diagnosis: 11 } }).rules;
  assert.notStrictEqual(rulesDigest(bump), d0);
  // 版本号改了但数没改：摘要不变（摘要回答的是「按哪套数算的」）
  assert.strictEqual(rulesDigest({ ...DEFAULT_RULES, ruleVersion: '9.9.9' }), d0);
});

test('formatWeights 由规则表生成，不再是手抄的字符串', () => {
  assert.strictEqual(formatWeights(DEFAULT_RULES), '病史10% · 体格10% · 辅助70% · 诊断10% · 治疗0%');
  assert.strictEqual(formatWeights(normalizeRules({ weights: { history: 20, physical: 20, aux: 40, diagnosis: 20, treatment: 0 } }).rules),
    '病史20% · 体格20% · 辅助40% · 诊断20% · 治疗0%');
});

test('caseVersionOf：只覆盖影响计分的字段', () => {
  const c = fixtureCase();
  const v = caseVersionOf(c);
  assert.match(v, /^c[0-9a-f]{8}$/);
  assert.strictEqual(caseVersionOf(fixtureCase()), v, '同样内容必须得到同样版本');
  const renamed = { ...c, name: '换个标题', dept: '心内科', gender: '男', age: '70', src: { file: 'x.json' } };
  assert.strictEqual(caseVersionOf(renamed), v, '标题/科室/人口学不影响计分，版本不应变');
  const rescored = fixtureCase();
  rescored.sections.history[0].subs[0].items[0].score = 3;
  assert.notStrictEqual(caseVersionOf(rescored), v, '分值变了就是另一份考卷');
  const relim = fixtureCase();
  relim.limits.aux.max = 9;
  assert.notStrictEqual(caseVersionOf(relim), v, '阈值变了同样要换版本');
  assert.strictEqual(caseVersionOf(null), null);
});

test('rulesDigest 覆盖每一个影响分数的字段（新增字段漏进摘要会被这条咬住）', () => {
  const base = rulesDigest(DEFAULT_RULES);
  const w = k => v => r => ({ ...r, weights: { ...r.weights, [k]: v } });
  const ex = k => v => r => ({ ...r, excess: { ...r.excess, [k]: v } });
  const od = k => v => r => ({ ...r, overdiagnosis: { ...r.overdiagnosis, [k]: v } });
  const mutations = [
    ['weights.history', w('history')(9)], ['weights.physical', w('physical')(11)],
    ['weights.aux', w('aux')(69)], ['weights.diagnosis', w('diagnosis')(11)], ['weights.treatment', w('treatment')(1)],
    ['excess.from', ex('from')('standard')], ['excess.to', ex('to')('reasonable')], ['excess.maxFraction', ex('maxFraction')(0.5)],
    ['overdiagnosis.perItem', od('perItem')(0.1)], ['overdiagnosis.maxFraction', od('maxFraction')(0.5)],
    ['combine', r => ({ ...r, combine: 'sum' })],
    ['evidence.weight', r => ({ ...r, evidence: { weight: 1 } })],
  ];
  for (const [name, f] of mutations) {
    assert.notStrictEqual(rulesDigest(f(DEFAULT_RULES)), base, `${name} 变了而摘要没变 = canonicalRules 漏登记了这个字段`);
  }
});

test('真实 cases.json：每条都带 caseVersion，且整体通过契约校验', () => {
  const p = path.join(ROOT, 'site', 'data', 'cases.json');
  if (!fs.existsSync(p)) return;   // 再生数据不入库，缺失时跳过而不是假装通过
  const cases = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(errs(validateCases(cases)).map(x => x.msg), []);
  const seen = new Map();
  for (const c of cases) {
    assert.match(String(c.caseVersion || ''), /^c[0-9a-f]{8}$/, `病例#${c.idx} 缺少 caseVersion，请重跑 build_site_data.js`);
    assert.strictEqual(caseVersionOf(c), c.caseVersion, `病例#${c.idx} 的版本摘要与内容不一致（构建后被人手改过？）`);
    if (seen.has(c.caseVersion)) assert.notStrictEqual(c.sections, seen.get(c.caseVersion), '两个病例计分内容完全相同');
    seen.set(c.caseVersion, c.sections);
  }
});
