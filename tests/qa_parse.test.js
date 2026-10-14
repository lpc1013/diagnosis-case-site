'use strict';
// 行为级 E2E 的解析层回归。
// 这批用例盯的不是 runner 会不会通过，而是「页面没跑完/跑歪了的时候，它能不能说出来」。
// 一个从不失败的 runner 比没有 runner 更糟——所以每条失败路径都要真的灌进去喂一遍。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseQaDom, formatQa, unescapeText } = require(path.join(__dirname, '..', 'tools', 'qa_parse.js'));

const wrap = payload => `<!DOCTYPE html><html><body><pre id="qa-result">${payload}</pre></body></html>`;
const okPayload = {
  stage: 'act', done: true, fail: 0, total: 2,
  checks: [{ name: '病史：点到标准线', pass: true, detail: '37 项' }, { name: '辅助：两组全选并检测', pass: true, detail: '' }],
};

test('真结果：全 pass 判通过，并带回 stage 与计数', () => {
  const r = parseQaDom(wrap(JSON.stringify(okPayload)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stage, 'act');
  assert.deepStrictEqual(r.counts, { total: 2, failed: 0 });
});

test('有红条目：判不通过，且失败的那条按名字点名', () => {
  const bad = JSON.parse(JSON.stringify(okPayload));
  bad.checks[1] = { name: '辅助：两组全选并检测', pass: false, detail: '跑了 1/2 组' };
  bad.fail = 1;
  const r = parseQaDom(wrap(JSON.stringify(bad)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.counts.failed, 1);
  const shown = formatQa(r, 'act');
  assert.match(shown, /✖ 辅助：两组全选并检测/);
  assert.match(shown, /跑了 1\/2 组/);
  assert.match(shown, /红 1 条/);
});

test('Chrome 没吐 DOM：判 EMPTY_OUTPUT，不是「跑完了但 0 条失败」', () => {
  for (const s of ['', '   ', '\n\n']) {
    const r = parseQaDom(s);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'EMPTY_OUTPUT');
  }
});

test('页面上没有结果块：判 NO_RESULT（驱动没激活/中途抛错的形状）', () => {
  const r = parseQaDom('<html><body><div id="section">正在载入病例数据…</div></body></html>');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NO_RESULT');
});

test('结果块不是合法 JSON：判 BAD_JSON 并把解析原因带出来', () => {
  const r = parseQaDom(wrap('{"stage":"act","done":true,checks:['));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'BAD_JSON');
});

test('缺 done:true 一律视为没跑完（宁可不判通过）', () => {
  const half = Object.assign({}, okPayload, { done: undefined });
  const r = parseQaDom(wrap(JSON.stringify(half)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NOT_DONE');
});

test('checks 不是数组：判 NO_CHECKS，不能当成「零条断言所以通过」', () => {
  const r = parseQaDom(wrap(JSON.stringify({ stage: 'act', done: true, checks: null })));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NO_CHECKS');
});

test('pass 必须是真值：pass:0 / pass:"false" 都算红', () => {
  const payload = { stage: 'act', done: true, checks: [{ name: 'a', pass: 0 }, { name: 'b', pass: 'false' }] };
  const r = parseQaDom(wrap(JSON.stringify(payload)));
  assert.strictEqual(r.counts.failed, 2);
  assert.strictEqual(r.ok, false);
});

test('实体转义必须还原后再 parse，且 &amp; 只能最后替换', () => {
  // dump-dom 会把结果块里的引号与尖括号转义；顺序错了就会把 &amp;quot; 拆成 " 而偷改内容
  assert.strictEqual(unescapeText('&amp;quot;'), '&quot;');
  assert.strictEqual(unescapeText('&lt;b&gt;&amp;lt;b&amp;gt;'), '<b>&lt;b&gt;');
  assert.strictEqual(unescapeText('&#039;'), "'");
  const payload = { stage: 'act', done: true, checks: [{ name: '含引号 " 与尖括号 <tag> 的明细', pass: true, detail: 'a & b' }] };
  const raw = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const r = parseQaDom(wrap(raw));
  assert.strictEqual(r.ok, true, r.detail);
  assert.strictEqual(r.checks[0].name, '含引号 " 与尖括号 <tag> 的明细');
  assert.strictEqual(r.checks[0].detail, 'a & b');
});

test('fatal / aborted 原样透传，格式化的时候必须出现在读数里', () => {
  const payload = Object.assign({}, okPayload, { fatal: '页面在 30 秒内没有完成装载' });
  const r = parseQaDom(wrap(JSON.stringify(payload)));
  assert.strictEqual(r.fatal, '页面在 30 秒内没有完成装载');
  assert.match(formatQa(r, 'act'), /\[fatal\] 页面在 30 秒内没有完成装载/);
});

test('解析器自身要能拒收非字符串输入（runner 传错东西时不许判通过）', () => {
  for (const v of [null, undefined, 42, {}]) {
    const r = parseQaDom(v);
    assert.strictEqual(r.ok, false);
  }
});
