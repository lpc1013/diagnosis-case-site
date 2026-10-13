'use strict';
// 病例 ↔ 原始数据配对：必须由内容决定，且错配必须响亮失败
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { matchRawFiles } = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'data', 'case-registry.js'));

const NAMES = ['呕血068', '记忆力减退', '双下肢浮肿', '血压升高'];
const ENTRIES = [
  { file: 'aaa.json', name: '呕血068', id: '1' },
  { file: 'bbb.json', name: '记忆力减退', id: '2' },
  { file: 'ccc.json', name: '双下肢浮肿', id: '3' },
  { file: 'ddd.json', name: '血压升高', id: '4' },
];

test('文件顺序完全打乱后，配对仍然正确（旧实现按枚举下标会串病例）', () => {
  const shuffled = [ENTRIES[2], ENTRIES[0], ENTRIES[3], ENTRIES[1]];
  const { map, errors } = matchRawFiles(NAMES, shuffled);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(map.get('呕血068'), 'aaa.json');
  assert.strictEqual(map.get('记忆力减退'), 'bbb.json');
  assert.strictEqual(map.get('双下肢浮肿'), 'ccc.json');
  assert.strictEqual(map.get('血压升高'), 'ddd.json');
  // 旧实现 readdirSync(...)[idx] 在这一趟会把 c0 的答案接到 ccc 的结构上
  assert.notStrictEqual(shuffled[0].file, ENTRIES[0].file, '语料没有真的换序');
});

test('缺少某个病例的原始数据时报错并点名缺谁', () => {
  const { errors } = matchRawFiles(NAMES, ENTRIES.slice(0, 2));
  assert.ok(errors.some(e => /双下肢浮肿/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some(e => /血压升高/.test(e)));
});

test('同名病例两份文件不允许静默取其一', () => {
  const dup = ENTRIES.concat([{ file: 'eee.json', name: '呕血068', id: '5' }]);
  const { errors } = matchRawFiles(NAMES, dup);
  assert.ok(errors.some(e => /同名病例/.test(e)), JSON.stringify(errors));
});

test('源目录多出清单之外的病例也要报错，而不是被无声忽略', () => {
  const extra = ENTRIES.concat([{ file: 'fff.json', name: '新病例', id: '6' }]);
  const { errors } = matchRawFiles(NAMES, extra);
  assert.ok(errors.some(e => /清单之外/.test(e)), JSON.stringify(errors));
});

test('meta.name 缺失的文件直接判错', () => {
  const { errors } = matchRawFiles(['甲'], [{ file: 'x.json', name: '', id: '' }]);
  assert.ok(errors.some(e => /meta\.name/.test(e)), JSON.stringify(errors));
});

test('病例名两侧空白不影响配对', () => {
  const { map, errors } = matchRawFiles(['  呕血068  '], [ENTRIES[0]]);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(map.get('  呕血068  '), 'aaa.json');
});
