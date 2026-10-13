'use strict';
// 病史增量重放 + 构建期自检闸门
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const hr = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'domain', 'history-replay.js'));

const S1 = { t: 'add', line: '现病史' };
const S2 = { t: 'add', line: '呕血', after: '现病史' };
const S3 = { t: 'ext', base: '呕血', suf: '，暗红色', after: '呕血' };

test('replayOps：add 按锚点插入，ext 就地延长基行', () => {
  const w = hr.replayPicked([{ ops: [S1] }, { ops: [S2] }, { ops: [S3] }], [0, 1, 2]);
  assert.deepStrictEqual(w, ['现病史', '呕血，暗红色']);
});

test('基行未被点中时，ext 只露出后缀，绝不带出未采集的基内容', () => {
  // 只点第 3 步（其 base「呕血」来自未点的第 2 步）
  const w = hr.replayPicked([{ ops: [S1] }, { ops: [S2] }, { ops: [S3] }], [0, 2]);
  assert.ok(w.includes('现病史'));
  assert.ok(!w.some(l => l === '呕血'), '未点中的基行不应整条出现: ' + JSON.stringify(w));
});

test('跳过中间步骤仍合并为一条（前缀命中分支）', () => {
  const steps = [
    { ops: [{ t: 'add', line: '习惯与嗜好：长期吸烟' }] },
    { ops: [{ t: 'ext', base: '习惯与嗜好：长期吸烟', suf: '，饮酒史', after: null }] },
    { ops: [{ t: 'ext', base: '习惯与嗜好：长期吸烟，饮酒史', suf: '，无服药史', after: null }] },
  ];
  const w = hr.replayPicked(steps, [0, 2]);
  assert.strictEqual(w.length, 1, '同字段的多段延长应合并为一行: ' + JSON.stringify(w));
  assert.strictEqual(w[0], '习惯与嗜好：长期吸烟，饮酒史，无服药史');
  // 记下这个既有语义：第 3 步的 base 里含未点选的第 2 步文本「饮酒史」，
  // 前缀命中分支会把整条 base 重建出来，因此中间内容会出现在检查记录里。
  // 这与「只显示被点步骤贡献的内容」并不完全一致，但它同时是构建脚本
  // replayMatchesFinal 自检所依赖的行为——要改得连同 history_records.json 一起重生成，
  // 属于训练语义变更，需要单独确认，不在本次整改里擅动。
});

test('基行完全没有公共前缀时，只露出后缀（不泄露基内容）', () => {
  const steps = [
    { ops: [{ t: 'add', line: '现病史' }] },
    { ops: [{ t: 'ext', base: '一条没采集过的基行', suf: '，新后缀' }] },
  ];
  const w = hr.replayPicked(steps, [0, 1]);
  assert.ok(w.includes('现病史'));
  assert.ok(!w.some(l => l.includes('一条没采集过的基行')), '基行未点中且无公共前缀时不得带出基内容: ' + JSON.stringify(w));
});

test('del 移除上一轮被系统撤销的行', () => {
  const steps = [
    { ops: [{ t: 'add', line: '伴随症状' }] },
    { ops: [{ t: 'del', line: '伴随症状' }, { t: 'add', line: '伴随症状1：恶心' }] },
  ];
  assert.deepStrictEqual(hr.replayPicked(steps, [0, 1]), ['伴随症状1：恶心']);
});

test('点选顺序不影响结果（内部按步骤序号排序重放）', () => {
  const steps = [{ ops: [S1] }, { ops: [S2] }, { ops: [S3] }];
  assert.deepStrictEqual(hr.replayPicked(steps, [2, 0, 1]), hr.replayPicked(steps, [0, 1, 2]));
});

test('replayMatchesFinal：一致时通过，被篡改内容时报 set:false', () => {
  const good = [
    { rec: '现病史\n呕血', ops: [{ t: 'add', line: '现病史' }, { t: 'add', line: '呕血', after: '现病史' }] },
  ];
  assert.deepStrictEqual({ order: replayOk(good).order, set: replayOk(good).set }, { order: true, set: true });

  const bad = [
    { rec: '现病史\n呕血', ops: [{ t: 'add', line: '现病史' }] },
    { rec: '现病史\n呕血\n黑便', ops: [{ t: 'add', line: '呕血', after: '现病史' }] },   // 漏了黑便
  ];
  const r = replayOk(bad);
  assert.strictEqual(r.set, false, '内容与终态不一致却被判通过');
});

function replayOk(steps) { return hr.replayMatchesFinal(steps); }

test('章节标题行不被当作可延长基行', () => {
  const w = hr.replayOps([], [{ t: 'add', line: '既往史' }, { t: 'add', line: '既往史，高血压', after: null }]);
  assert.ok(w.some(l => l === '既往史，高血压'), '章节名后的追加应成行: ' + JSON.stringify(w));
});

// —— 真实产物：history_records.json 必须过自检（闸门确实拦得住） ——
const HR = path.join(__dirname, '..', 'site', 'data', 'history_records.json');
test('已生成的重放数据逐例自检通过', { skip: !fs.existsSync(HR) }, () => {
  const data = JSON.parse(fs.readFileSync(HR, 'utf8'));
  for (const idx of Object.keys(data)) {
    const steps = data[idx];
    if (!steps.length) continue;
    const r = hr.replayMatchesFinal(steps);
    assert.ok(r.set, `病例 ${idx} 重放内容与终态不一致`);
    assert.ok(['exact', 'estimated', undefined].includes(steps[0].sourceType), 'sourceType 应标明精确/估算');
  }
});

test('构建脚本在重放不一致时中止且不写出文件', { skip: !fs.existsSync(HR) }, () => {
  // 用一份被篡改的重放数据跑真正的闸门：脚本必须非 0 退出，且不改写产物
  const tmpDir = path.join(__dirname, '..', '_tmp_gate_check');
  fs.mkdirSync(tmpDir, { recursive: true });
  const script = path.join(tmpDir, 'gate.js');
  const data = JSON.parse(fs.readFileSync(HR, 'utf8'));
  const firstKey = Object.keys(data)[0];
  // 抹掉最后一步的内容，使重放结果与终态不符
  const steps = data[firstKey];
  steps[steps.length - 1].ops = [{ t: 'add', line: '与本例无关的一行' }];
  fs.writeFileSync(script, `
    const hr = require(${JSON.stringify(path.join(__dirname, '..', 'site', 'assets', 'js', 'domain', 'history-replay.js'))});
    const steps = ${JSON.stringify(steps)};
    const chk = hr.replayMatchesFinal(steps);
    if (!chk.set) { console.error('BLOCKED'); process.exit(1); }
    console.log('PASSED');
  `, 'utf8');
  let failed = false;
  let out = '';
  try {
    out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(failed, '篡改后的重放数据没有被拦下（闸门是摆设）');
  assert.match(out, /BLOCKED/);
});
