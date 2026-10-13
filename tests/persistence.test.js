'use strict';
// 本地持久化：版本迁移 + 结构校验回归测试
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const JS = p => path.join(__dirname, '..', 'site', 'assets', 'js', p);
const { serialize, deserialize, loadFrom, saveTo, LS_KEY, emptyApp } = require(JS('data/persistence.js'));
const { caseItems } = require(JS('domain/case.js'));

function memStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m };
}

function tinyCase() {
  return {
    idx: 0, name: '示例', limits: {},
    sections: {
      history: [
        { category: '现病史', subs: [{ name: '主要症状', items: [{ q: '呕血?', necessary: true, score: 1 }] }] },
        { category: '既往史', subs: [{ name: '疾病史', items: [{ q: '呕血?', necessary: true, score: 1 }] }] },
      ],
      physical: [{ name: '一般检查', items: [{ name: '体温', result: '36.8', necessary: true, score: 1 }] }],
      aux: [{ name: '化验单', children: [{ name: '血常规', result: 'x', necessary: true, score: 1, cost: 10 }] }],
      diagnosis: [{ name: '急性胃炎', cls: '主要诊断', score: 1, bySrc: {} }],
      treatment: [{ group: '一般治疗', items: [{ name: '禁食', necessary: true, score: 1, scenes: ['急诊'] }] }],
    },
  };
}

const histKeys = c => caseItems(c.sections, 'history').map(i => i.key);

test('序列化往返：Set 与数组互转，诊断标记为空也保留诊断名', () => {
  const c = tinyCase();
  const keys = histKeys(c);
  const app = emptyApp();
  app.picked[0] = { history: new Set([keys[0]]), physical: new Set(), aux: new Set(), treatment: new Set() };
  app.diagMarks[0] = { '急性胃炎': { support: new Set(), unsupport: new Set() } };
  app.diagClass[0] = { '急性胃炎': '主要诊断' };
  app.auxCheckCount[0] = 3;

  const round = deserialize(serialize(app), [c]);
  assert.deepStrictEqual([...round.app.picked[0].history], [keys[0]]);
  assert.ok(round.app.picked[0].history instanceof Set);
  assert.ok('急性胃炎' in round.app.diagMarks[0], '没有标记的诊断被丢掉了——学生的作答不该消失');
  assert.strictEqual(round.app.diagClass[0]['急性胃炎'], '主要诊断');
  assert.strictEqual(round.app.auxCheckCount[0], 3);
  assert.deepStrictEqual(round.report.dropped, []);
});

test('诊断分类必须真的落盘（v1 完全没存它）', () => {
  const c = tinyCase();
  const app = emptyApp();
  app.diagMarks[0] = { '急性胃炎': { support: new Set(['k']), unsupport: new Set() } };
  app.diagClass[0] = { '急性胃炎': '鉴别诊断' };
  const out = serialize(app);
  assert.strictEqual(out.diagClass[0]['急性胃炎'], '鉴别诊断');
  assert.strictEqual(deserialize(out, [c]).app.diagClass[0]['急性胃炎'], '鉴别诊断');
});

test('v1 旧记录：模糊病史键展开到每个分类，且不会凭空造出诊断分类', () => {
  const c = tinyCase();
  const keys = histKeys(c);
  const legacy = { picked: { 0: { history: ['h|呕血?'], physical: [], aux: [], treatment: [] } }, scores: {} };
  const { app, report } = deserialize(legacy, [c]);
  assert.deepStrictEqual([...app.picked[0].history].sort(), keys.slice().sort(), '旧键应展开成两条独立规范键');
  assert.deepStrictEqual(app.diagClass, {}, '不能把「主要诊断」默认值当成学生主动的分类');
  assert.ok(report.migrated.length >= 1, '迁移必须留下说明');
  assert.strictEqual(report.version, 1);
});

test('当前数据里不存在的陈旧键被丢弃并报告，而不是继续计入检查次数', () => {
  const c = tinyCase();
  const { app, report } = deserialize({ picked: { 0: { history: ['h|已消失的问题'], aux: ['a|x|幽灵项'] } } }, [c]);
  assert.deepStrictEqual([...app.picked[0].history], []);
  assert.ok(report.dropped.some(x => /已丢弃/.test(x)), '丢弃必须可见: ' + JSON.stringify(report.dropped));
});

test('损坏或结构不符的记录按空进度处理，绝不抛异常打断启动', () => {
  const c = tinyCase();
  for (const bad of ['{ 不是JSON', '[]', '"字符串"', 42]) {
    const { app, report } = deserialize(bad, [c]);
    assert.deepStrictEqual(app.picked, {});
    assert.ok(report.dropped.length + report.warned.length >= 0);
  }
});

test('评分记录结构不完整时丢弃，完整时保留', () => {
  const c = tinyCase();
  const good = { total: 88, breakdown: [{ label: '病史', weight: '10%', rate: 0.8 }] };
  const { app } = deserialize({ scores: { 0: good, 1: { total: 'x' }, 2: null } }, [c]);
  assert.deepStrictEqual(Object.keys(app.scores), ['0']);
  assert.strictEqual(app.scores[0].total, 88);
});

test('没有检测次数记录时按已采集辅助项数兜底', () => {
  const c = tinyCase();
  const key = caseItems(c.sections, 'aux')[0].key;
  const { app } = deserialize({ picked: { 0: { aux: [key] } } }, [c]);
  assert.strictEqual(app.auxCheckCount[0], 1);
});

test('loadFrom 优先新版本键，仅新版本缺失时才读旧键；保存后清掉旧键', () => {
  const c = tinyCase();
  const legacyStore = memStorage({ wb_clinthink_v1: JSON.stringify({ picked: { 0: { history: ['h|呕血?'] } } }) });
  const r1 = loadFrom(legacyStore, [c]);
  assert.strictEqual(r1.report.version, 1);
  assert.strictEqual(r1.app.picked[0].history.size, 2);

  const v2Store = memStorage({ wb_clinthink_v1: '{}', [LS_KEY]: JSON.stringify({ v: 2, picked: {} }) });
  assert.strictEqual(loadFrom(v2Store, [c]).report.version, 2);

  saveTo(legacyStore, r1.app);
  assert.ok(legacyStore.getItem(LS_KEY), '应写入新版本键');
  assert.strictEqual(legacyStore.getItem('wb_clinthink_v1'), null, '旧键必须清掉，否则下次启动又迁移一遍');
  assert.strictEqual(loadFrom(legacyStore, [c]).app.picked[0].history.size, 2);
});

test('存储不可用（隐私模式）时保存静默失败但不抛', () => {
  const boom = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); } };
  assert.strictEqual(saveTo(boom, emptyApp()), false);
  assert.doesNotThrow(() => loadFrom(boom, []));
});
