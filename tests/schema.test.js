'use strict';
// 数据加载：四类失败必须给出不同且可操作的提示
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadJson, LOAD_ERROR, validateCases, validateCase } = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'data', 'schema.js'));

function res(status, body, ok) {
  return { ok: ok == null ? status >= 200 && status < 300 : ok, status, text: async () => body };
}

test('文件缺失：报 FILE_NOT_FOUND 并点名是哪个文件', async () => {
  await assert.rejects(
    () => loadJson('data/cases.json', { fetcher: async () => res(404, 'not found') }),
    e => {
      assert.strictEqual(e.__loadKind, LOAD_ERROR.FILE_NOT_FOUND);
      assert.match(e.message, /缺少数据文件：data\/cases\.json/);
      return true;
    }
  );
});

test('网络失败：报 NETWORK_ERROR（而不是被当成文件不存在）', async () => {
  await assert.rejects(
    () => loadJson('data/cases.json', { fetcher: async () => { throw new TypeError('Failed to fetch'); } }),
    e => { assert.strictEqual(e.__loadKind, LOAD_ERROR.NETWORK_ERROR); return true; }
  );
});

test('JSON 损坏：报 INVALID_JSON', async () => {
  await assert.rejects(
    () => loadJson('data/cases.json', { fetcher: async () => res(200, '{ 半截') }),
    e => { assert.strictEqual(e.__loadKind, LOAD_ERROR.INVALID_JSON); return true; }
  );
});

test('HTTP 500：报 HTTP_ERROR 并带上状态码', async () => {
  await assert.rejects(
    () => loadJson('data/diaglib.json', { fetcher: async () => res(500, 'boom') }),
    e => { assert.strictEqual(e.__loadKind, LOAD_ERROR.HTTP_ERROR); assert.strictEqual(e.__status, 500); return true; }
  );
});

test('结构不合格：报 SCHEMA_ERROR 且逐条说明问题', async () => {
  await assert.rejects(
    () => loadJson('data/cases.json', { fetcher: async () => res(200, JSON.stringify([{ name: '甲' }])), validator: validateCases }),
    e => {
      assert.strictEqual(e.__loadKind, LOAD_ERROR.SCHEMA_ERROR);
      assert.ok(e.__problems.length >= 1);
      assert.match(e.message, /结构校验失败/);
      return true;
    }
  );
});

test('可选文件缺失不阻断（required:false）', async () => {
  await assert.rejects(
    () => loadJson('data/history_records.json', { required: false, fetcher: async () => res(404, 'x') }),
    e => { assert.strictEqual(e.__loadKind, LOAD_ERROR.FILE_NOT_FOUND); assert.match(e.message, /可选文件/); return true; }
  );
});

test('合法数据通过校验；键碰撞与满分不可达被分别抓出', () => {
  const good = {
    idx: 0, name: '甲', limits: {},
    sections: {
      history: [{ category: '现病史', subs: [{ name: '主要症状', items: [{ q: '腹痛?', necessary: true, score: 2 }] }] }],
      physical: [], aux: [], diagnosis: [], treatment: [],
    },
  };
  assert.deepStrictEqual(validateCases([good]), []);

  const colliding = JSON.parse(JSON.stringify(good));
  colliding.sections.history[0].subs.push({ name: '伴随症状', items: [{ q: '腹痛?', necessary: true, score: 1 }] });
  // 补上分类路径后两条不再碰撞
  assert.deepStrictEqual(validateCases([colliding]), []);

  const dup = JSON.parse(JSON.stringify(good));
  dup.sections.history[0].subs[0].items.push({ q: '腹痛?', necessary: false, score: 0 });
  dup.sections.history[0].category = '现病史';
  const probs = validateCases([dup]);
  assert.ok(probs.some(p => p.code === 'DUPLICATE_KEY'), '同分类同小节同名问题应报键碰撞: ' + JSON.stringify(probs));

  const unfair = JSON.parse(JSON.stringify(good));
  unfair.sections.history[0].subs[0].items.push({ q: '干扰项', necessary: false, score: 5 });
  const p2 = validateCase(unfair);
  assert.ok(p2.some(p => p.code === 'NON_NECESSARY_SCORED'), '非必要项带分值会让满分不可达');

  const badCost = JSON.parse(JSON.stringify(good));
  badCost.sections.aux = [{ name: '血常规', necessary: true, score: 1, cost: '<img src=x>' }];
  assert.ok(validateCase(badCost).some(p => p.code === 'BAD_COST'));
});
