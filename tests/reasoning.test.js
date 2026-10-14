'use strict';
// 临床推理链（reasoning.js）的回归。
// 这一层是「还原思维轨迹」，不是「打分」；但它必须和评分共用同一份诊断名匹配与证据判读，
// 否则同一个答案会在评分里算命中、在思维链里算「标准答案里没有」。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const JS = p => path.join(__dirname, '..', 'site', 'assets', 'js', p);
const { buildReasoning, hypothesisTrace, STAGES } = require(JS('domain/reasoning.js'));
const { evidenceReview, computeScore, DEFAULT_RULES } = require(JS('domain/scoring.js'));
const { norm } = require(JS('domain/case.js'));

function fixtureCase() {
  const U1 = { text: '血常规 - 白细胞: 11.8', src: '辅助检查', item: '白细胞', sub: '血常规', content: '11.8', support: true };
  const U2 = { text: '脉搏P: 90次/分', src: '体格检查', item: '脉搏P', sub: '', content: '90次/分', support: false };
  const V1 = { text: '呕血: 鲜红', src: '病史采集', item: '呕血', sub: '', content: '鲜红', support: true };
  return {
    idx: 0, name: '示例病例', dept: '消化内科', patient: '张三', gender: '男', age: '40',
    limits: {
      history: { standard: 2, reasonable: 3, max: 4 },
      physical: { standard: 1, reasonable: 2, max: 3 },
      aux: { standard: 1, reasonable: 2, max: 3, costStandard: 10, costReasonable: 20, costMax: 30 },
      treatment: { standard: 1, reasonable: 2, max: 3 },
    },
    sections: {
      history: [{ category: '现病史', subs: [{ name: '主要症状', items: [
        { q: '呕血?', reply: '鲜红', necessary: true, score: 1 },
        { q: '腹痛?', reply: '无', necessary: false, score: 0 },
      ] }] }],
      physical: [{ name: '一般检查', items: [{ name: '脉搏P', result: '90次/分', necessary: true, score: 1 }] }],
      aux: [{ name: '化验单', children: [{ name: '血常规', children: [{ name: '白细胞', result: '11.8', unit: '109/L', necessary: true, score: 1, cost: 5 }] }] }],
      diagnosis: [
        { name: '急性糜烂出血性胃炎', cls: '主要诊断', score: 2, synonyms: '急性出血性胃炎', bySrc: { 辅助检查: [U1], 体格检查: [U2] } },
        { name: '消化性溃疡', cls: '鉴别诊断', score: 1, synonyms: '', bySrc: { 病史采集: [V1] } },
      ],
      treatment: [{ group: '一般治疗', items: [{ name: '禁食', necessary: true, score: 1, scenes: ['住院'] }] }],
    },
  };
}

// 学生答案：主诊断用了同义名，另加一个标准答案里没有的诊断，并漏掉消化性溃疡
function fixtureAnswer() {
  const c = fixtureCase();
  const key = (sec, name) => {
    const items = require(JS('domain/case.js')).caseItems(c.sections, sec);
    return items.find(i => (i.item.q || i.item.name) === name).key;
  };
  return {
    picked: {
      history: new Set([key('history', '呕血?')]),
      physical: new Set([key('physical', '脉搏P')]),
      aux: new Set([key('aux', '白细胞')]),
      treatment: new Set([key('treatment', '禁食')]),
    },
    auxCheckCount: 1,
    diagMarks: {},   // 下面按插入序填
    diagClass: {},
  };
}

// 标记的键空间由应用决定：证据树上的每条依据以 norm(u.text) 为键存进 diagMarks（见 app.js 的
// renderEvSrc / 右栏依据池），持久化里存的也是这个键。夹具必须照同一套键写，
// 否则测的是「引擎读不到键」而不是「引擎判读错了」。
function withDiags(answer, entries) {
  for (const [name, cls, marks] of entries) {
    answer.diagMarks[name] = {
      support: new Set((marks.support || []).map(norm)),
      unsupport: new Set((marks.unsupport || []).map(norm)),
    };
    if (cls) answer.diagClass[name] = cls;
  }
  return answer;
}

test('思维链固定五段，顺序不许漂', () => {
  const r = buildReasoning(fixtureCase(), withDiags(fixtureAnswer(), [['急性出血性胃炎', '主要诊断', {}]]));
  assert.deepStrictEqual(r.stages.map(s => s.key), ['clues', 'hypotheses', 'evidence', 'ruled', 'final']);
  assert.deepStrictEqual(r.stages.map(s => s.label), ['发现线索', '提出假设', '寻找证据', '排除 / 待排', '确定诊断']);
  assert.strictEqual(r.stages.length, STAGES.length);
});

test('线索只来自真正采集到的项，并带来源分布', () => {
  const r = buildReasoning(fixtureCase(), withDiags(fixtureAnswer(), []));
  assert.strictEqual(r.summary.clues, 3, '病史1 + 体格1 + 辅助1，未采集的不许出现: ' + JSON.stringify(r.stages[0].items));
  assert.deepStrictEqual(r.summary.clueBySrc, { 病史采集: 1, 体格检查: 1, 辅助检查: 1 });
  const hist = r.stages[0].items.find(c => c.src === '病史采集');
  assert.strictEqual(hist.from, '呕血?');
  assert.strictEqual(hist.detail, '鲜红');
});

test('给了问诊步骤时，线索带着「哪一问得到哪一行」的步序（复盘要能还原顺序）', () => {
  const steps = [
    { q: '你哪里不舒服？', ops: [{ t: 'add', line: '现病史' }, { t: 'add', line: '呕血，鲜红' }] },
    { q: '腹痛吗？', ops: [{ t: 'add', line: '腹痛' }] },
  ];
  const r = buildReasoning(fixtureCase(), withDiags(fixtureAnswer(), []), { steps, pickedIdxs: [0] });
  const hist = r.stages[0].items.filter(c => c.src === '病史采集');
  assert.strictEqual(hist.length, 2, '一步的两行都应算作该步产出: ' + JSON.stringify(hist));
  assert.deepStrictEqual([...new Set(hist.map(h => h.step))], [0], '只重放了被点中的第 0 步');
  assert.ok(!hist.some(h => h.detail === '腹痛'), '没问的步骤不得混进线索: ' + JSON.stringify(hist));
});

test('假设按学生添加顺序，不按标准答案顺序；同义名归到标准诊断', () => {
  const c = fixtureCase();
  const a = withDiags(fixtureAnswer(), [
    ['消化性溃疡', '鉴别诊断', {}],
    ['急性出血性胃炎', '主要诊断', {}],   // 同义名
  ]);
  const t = hypothesisTrace(c, a);
  assert.deepStrictEqual(t.map(x => x.name), ['消化性溃疡', '急性出血性胃炎'], '顺序必须等于插入顺序');
  assert.strictEqual(t[1].standard, '急性糜烂出血性胃炎', '同义名没归位：' + JSON.stringify(t[1]));
  assert.strictEqual(t[1].verdict, 'confirmed');
  assert.strictEqual(t[1].verdictLabel, '确立');
  assert.strictEqual(t[0].verdict, 'pending');
});

test('四种分类各得一个结论，表外的分类名一律当未分类（不猜学生想说什么）', () => {
  const c = fixtureCase();
  const mk = cls => hypothesisTrace(c, withDiags(fixtureAnswer(), [['急性糜烂出血性胃炎', cls, {}]]))[0];
  assert.strictEqual(mk('主要诊断').verdict, 'confirmed');
  assert.strictEqual(mk('次要诊断').verdict, 'secondary');
  assert.strictEqual(mk('鉴别诊断').verdict, 'pending');
  assert.strictEqual(mk('疑似诊断').verdict, 'suspected');
  assert.strictEqual(mk(null).verdict, 'unclassified');
  assert.strictEqual(mk('首诊').verdict, 'unclassified', '未知分类被当成主要诊断了——这是把站点猜测算进学生头上');
});

test('标准答案里没有的诊断进「排除」并说明为什么；漏掉的标准诊断进 missed', () => {
  const c = fixtureCase();
  const r = buildReasoning(c, withDiags(fixtureAnswer(), [
    ['肝硬化', '主要诊断', {}],
    ['急性糜烂出血性胃炎', '主要诊断', {}],
  ]));
  const ruled = r.stages.find(s => s.key === 'ruled').items;
  assert.strictEqual(ruled.length, 1, JSON.stringify(ruled));
  assert.strictEqual(ruled[0].name, '肝硬化');
  assert.match(ruled[0].reason, /标准答案中没有/);
  assert.deepStrictEqual(r.missed.map(m => m.name), ['消化性溃疡'], '漏诊没列出来: ' + JSON.stringify(r.missed));
  assert.strictEqual(r.summary.spurious, 1);
});

test('思维自相矛盾要单独点名：列为主要诊断，却不支持证据多于支持证据', () => {
  const c = fixtureCase();
  const a = withDiags(fixtureAnswer(), [['急性糜烂出血性胃炎', '主要诊断', { unsupport: ['脉搏P: 90次/分', '不存在的一条: x'] }]]);
  const t = hypothesisTrace(c, a)[0];
  assert.strictEqual(t.contradiction, true, JSON.stringify(t));
  assert.strictEqual(t.markedUnsup, 2);
  assert.strictEqual(t.onTree, 1, '只有 1 条落在标准依据树上，另一条是依据池里的');
  const r = buildReasoning(c, a);
  assert.match(r.stages.find(s => s.key === 'ruled').items[0].reason, /不支持证据（2）多于支持证据（0）/);
});

test('判读账与评分共用一份实现：思维链的 marked 必须等于 evidenceReview 的 marked', () => {
  const c = fixtureCase();
  // 故意掺一条【不落在标准依据树上】的标记（右栏依据池里的键也能被标记）：
  // 只有存在这种标记时，「按标准树数」与「按原始 Set 大小数」两种算法才会给出不同的数，
  // 这条一致性断言才有鉴别力——上一版夹具两条恰好相等，灌进缺陷都不红（已复现）。
  const a = withDiags(fixtureAnswer(), [['急性糜烂出血性胃炎', '主要诊断', {
    support: ['血常规 - 白细胞: 11.8'],
    unsupport: ['脉搏P: 90次/分', '依据池里但不在标准树上的一条'],
  }]]);
  const r = buildReasoning(c, a);
  const ev = evidenceReview(c, a);
  assert.strictEqual(ev.marked, 2, '评分侧应按标准树逐条判读（3 条标记里只有 2 条落在树上）');
  assert.strictEqual(r.summary.evidenceMarked, ev.marked, '两处各算一套，标记数就会漂');
  assert.strictEqual(r.trace[0].onTree, 2);
  assert.strictEqual(r.trace[0].markedUnsup, 2, '原始标记数应包含不落树的那条');
  assert.strictEqual(r.summary.evidenceAccuracy, ev.accuracy);
  assert.strictEqual(r.summary.evidenceAccuracy, 1, '两条都判对（白细胞支持、脉搏不支持）');
});

test('持久化回来的数组形状标记也能读：不能只认内存里的 Set', () => {
  const c = fixtureCase();
  const a = withDiags(fixtureAnswer(), [['急性糜烂出血性胃炎', '主要诊断', {}]]);
  a.diagMarks['急性糜烂出血性胃炎'] = { support: [norm('血常规 - 白细胞: 11.8')], unsupport: [] };
  a.diagClass['急性糜烂出血性胃炎'] = '主要诊断';
  const r = buildReasoning(c, a);
  assert.strictEqual(r.summary.evidenceMarked, 1, '数组形状（刷新后）被判成 0 条: ' + JSON.stringify(r.trace[0]));
});

test('空答卷不崩：五段都在，计数全 0', () => {
  const r = buildReasoning(fixtureCase(), { picked: {}, auxCheckCount: 0, diagMarks: {}, diagClass: {} });
  assert.strictEqual(r.stages.length, 5);
  assert.strictEqual(r.summary.hypotheses, 0);
  assert.strictEqual(r.summary.clues, 0);
  assert.strictEqual(r.summary.evidenceAccuracy, null, '一条没标时准确率应是「无从计算」而不是 0 或 NaN');
});

// —— 真实四例：拿真正会显示给用户的数据量一遍，并自报命中数 ——
const REAL = path.join(__dirname, '..', 'site', 'data', 'cases.json');
test('真实四例：全选必要项 + 照抄标准答案 → 思维链无漏诊无多余', { skip: !fs.existsSync(REAL) }, () => {
  const { caseItems, necKeys } = require(JS('domain/case.js'));
  const cases = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const report = [];
  for (const c of cases) {
    const answer = { picked: {}, auxCheckCount: 0, diagMarks: {}, diagClass: {} };
    for (const sec of ['history', 'physical', 'aux', 'treatment']) {
      answer.picked[sec] = new Set(necKeys(c.sections, sec));
    }
    answer.auxCheckCount = answer.picked.aux.size;
    for (const d of c.sections.diagnosis) {
      answer.diagMarks[d.name] = { support: new Set(), unsupport: new Set() };
      if (d.cls) answer.diagClass[d.name] = d.cls;
      for (const u of Object.values(d.bySrc || {}).flat()) {
        (u.support ? answer.diagMarks[d.name].support : answer.diagMarks[d.name].unsupport).add(norm(u.text));
      }
    }
    const r = buildReasoning(c, answer);
    assert.deepStrictEqual(r.missed, [], `病例 ${c.idx} 有漏诊被判出来: ` + JSON.stringify(r.missed));
    assert.strictEqual(r.summary.spurious, 0, `病例 ${c.idx} 出现多余诊断`);
    assert.strictEqual(r.summary.unclassified, 0, `病例 ${c.idx} 有标准诊断没带上分类`);
    assert.strictEqual(r.summary.evidenceAccuracy, 1, `病例 ${c.idx} 照抄标准判读却不算全对`);
    assert.ok(r.summary.confirmed >= 1, `病例 ${c.idx} 没有主要诊断`);
    assert.strictEqual(r.trace.length, c.sections.diagnosis.length);
    assert.strictEqual(r.stages[0].items.length, r.summary.clues);
    report.push(`例${c.idx}: 线索${r.summary.clues} 假设${r.summary.hypotheses} 确立${r.summary.confirmed} 待排${r.summary.pending} 依据${r.summary.evidenceMarked}条`);
    void caseItems;
  }
  process.stdout.write(`[思维链真实数据命中 ${report.length} 例：${report.join(' | ')}]\n`);
});

test('真实四例：把一个标准诊断换成不存在的诊断 → 立刻出现在「排除」里并计为多余', { skip: !fs.existsSync(REAL) }, () => {
  const { necKeys } = require(JS('domain/case.js'));
  const cases = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const c = cases[0];
  const answer = { picked: {}, auxCheckCount: 0, diagMarks: {}, diagClass: {} };
  for (const sec of ['history', 'physical', 'aux', 'treatment']) answer.picked[sec] = new Set(necKeys(c.sections, sec));
  const [first, ...rest] = c.sections.diagnosis;
  for (const d of rest) {
    answer.diagMarks[d.name] = { support: new Set(), unsupport: new Set() };
    if (d.cls) answer.diagClass[d.name] = d.cls;
  }
  answer.diagMarks['一种根本不存在的病'] = { support: new Set(), unsupport: new Set() };
  answer.diagClass['一种根本不存在的病'] = '主要诊断';
  const r = buildReasoning(c, answer);
  assert.strictEqual(r.summary.spurious, 1, JSON.stringify(r.stages.find(s => s.key === 'ruled').items));
  assert.deepStrictEqual(r.missed.map(m => m.name), [first.name], '漏掉的那个标准诊断没被列进 missed');
  const sc = computeScore(c, answer, DEFAULT_RULES);
  assert.ok(sc.notes.invalidDiagnoses.includes('一种根本不存在的病'), '推理链与评分对「哪个诊断是多余的」意见不一致');
  assert.strictEqual(r.summary.hypotheses, c.sections.diagnosis.length, '假设总数应与添加的诊断数相等');
});
