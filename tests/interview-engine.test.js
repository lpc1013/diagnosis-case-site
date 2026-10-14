'use strict';
// 临床问诊时间序列引擎的回归：增量重放 + 构建期自检闸门 + 问诊路径。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ENGINE = path.join(__dirname, '..', 'site', 'assets', 'js', 'domain', 'interview-engine.js');
const hr = require(ENGINE);

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

// ——— 问诊路径：显示层不许自己再数一遍 ops，这里就是唯一的一份账 ———
test('interviewPath：按出题顺序记录每步问了什么、净增几行', () => {
  const steps = [
    { q: '你哪里不舒服？', ops: [S1] },
    { q: '呕血多久了？', ops: [S2] },
    { q: '颜色？', ops: [S3] },
  ];
  const r = hr.interviewPath(steps, [0, 1, 2]);
  assert.strictEqual(r.asked, 3);
  assert.strictEqual(r.skipped, 0);
  assert.deepStrictEqual(r.path.map(p => p.q), ['你哪里不舒服？', '呕血多久了？', '颜色？'], '路径必须按系统出题顺序，不是点选顺序');
  assert.deepStrictEqual(r.path.map(p => p.net), [1, 1, 0], '第 3 步是就地延长，行数不该增加');
  assert.deepStrictEqual(r.path.map(p => p.ext), [0, 0, 1]);
  // 延长虽然不增行，但产出行必须算给这一步，否则复盘会把「呕血，暗红色」记成第 2 步的功劳
  assert.deepStrictEqual(r.path[2].lines, ['呕血，暗红色']);
  assert.deepStrictEqual(r.lines, ['现病史', '呕血，暗红色']);
});

test('interviewPath：没问的步骤计入 skipped，且不会贡献任何行', () => {
  const steps = [{ q: 'a', ops: [S1] }, { q: 'b', ops: [S2] }, { q: 'c', ops: [S3] }];
  const r = hr.interviewPath(steps, [0]);
  assert.strictEqual(r.asked, 1);
  assert.strictEqual(r.skipped, 2);
  assert.deepStrictEqual(r.lines, ['现病史']);
  assert.deepStrictEqual(r.path.map(p => p.step), [0]);
});

test('interviewPath：净增为 0 或负数的步骤被点名（问了但一行都没得到）', () => {
  const steps = [
    { q: '第一步', ops: [{ t: 'add', line: '伴随症状' }] },
    { q: '白问的一步', ops: [{ t: 'del', line: '伴随症状' }] },
  ];
  const r = hr.interviewPath(steps, [0, 1]);
  assert.deepStrictEqual(r.emptyTurns, [1], '第 2 步净 -1 行，必须被点出来: ' + JSON.stringify(r.path));
  assert.strictEqual(r.lines.length, 0);
});

test('interviewPath：越界与重复的下标不重复计入', () => {
  const steps = [{ q: 'a', ops: [S1] }, { q: 'b', ops: [S2] }];
  const r = hr.interviewPath(steps, [0, 0, 1, 9, -1]);
  assert.strictEqual(r.asked, 2, JSON.stringify(r.path));
  assert.strictEqual(r.total, 2);
});

test('interviewPath：估算轨迹带着 sourceType 出去，显示层才能标注它不可当真实顺序', () => {
  const steps = [{ q: 'a', sourceType: 'estimated', ops: [S1] }];
  const r = hr.interviewPath(steps, [0]);
  assert.strictEqual(r.estimated, 1);
  assert.strictEqual(r.path[0].sourceType, 'estimated');
});

test('opsTally：只认 add/ext/del，未知的 op 类型不计入也不报错', () => {
  // 与 replayOps 同一套容忍度：未知类型直接跳过；但 ops 数组里塞 null 不在契约内
  //（replayOps 同样会抛），所以这里不给它写「抗脏数据」的假承诺。
  assert.deepStrictEqual(hr.opsTally([{ t: 'add' }, { t: 'ext' }, { t: 'ext' }, { t: 'xyz' }]), { add: 1, ext: 2, del: 0 });
  assert.deepStrictEqual(hr.opsTally(undefined), { add: 0, ext: 0, del: 0 });
  assert.throws(() => hr.replayOps([], [null]), TypeError, '脏数据应当响亮地坏掉，而不是被静默吞掉');
});

test('stepIdxsForQuestions：按规范化后的问题文本找回出题步序，越界与没匹配都不造出步序', () => {
  const steps = [{ q: '你哪里不舒服？' }, { q: '呕血多久了？' }, { q: '颜色？' }];
  // 空白与全角冒号在 norm() 里被抹平，所以页面侧的题面写法不必逐字相同
  assert.deepStrictEqual(hr.stepIdxsForQuestions(steps, ['颜色？ ', '你哪里不舒服？']), [0, 2], '必须按步序升序返回');
  assert.deepStrictEqual(hr.stepIdxsForQuestions(steps, ['没问过的一题']), []);
  assert.deepStrictEqual(hr.stepIdxsForQuestions(steps, []), []);
  assert.deepStrictEqual(hr.stepIdxsForQuestions([], ['a']), []);
});

test('stepIdxsForQuestions：同名题只认第一处，重复勾选不重复计步', () => {
  const steps = [{ q: '有黑便吗？', ops: [{ t: 'add', line: '黑便' }] }, { q: '有黑便吗？', ops: [{ t: 'add', line: '另一行' }] }];
  assert.deepStrictEqual(hr.stepIdxsForQuestions(steps, ['有黑便吗？', '有黑便吗？']), [0]);
  // 真实四例实测每题规范化后在本病例内唯一，所以「取第一处」不会改变现有产物；
  // 万一将来再生数据出现重名，这里也保证不会把两次的行都算到学生头上。
  assert.deepStrictEqual(hr.replayPicked(steps, hr.stepIdxsForQuestions(steps, ['有黑便吗？'])), ['黑便']);
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

test('真实四例：全点时的问诊路径与 replayAll 逐行一致，且 skipped 恒为 0', { skip: !fs.existsSync(HR) }, () => {
  const data = JSON.parse(fs.readFileSync(HR, 'utf8'));
  const checked = [];
  for (const idx of Object.keys(data)) {
    const steps = data[idx];
    if (!steps.length) continue;
    const allIdx = steps.map((_, i) => i);
    const r = hr.interviewPath(steps, allIdx);
    assert.deepStrictEqual(r.lines, hr.replayAll(steps), `病例 ${idx} 路径产出的行与 replayAll 不一致`);
    assert.strictEqual(r.asked, steps.length, `病例 ${idx} 全点却 skipped 不为 0`);
    assert.strictEqual(r.skipped, 0);
    checked.push(`${idx}:${steps.length}步`);
  }
  assert.ok(checked.length >= 1, '这条用例一条病例都没量到（数据文件是空的？）');
  process.stdout.write(`[interviewPath 真实数据命中 ${checked.length} 例：${checked.join(', ')}]\n`);
});

test('真实四例：路径里每一步的 add/ext/del 之和等于该步 ops 条数', { skip: !fs.existsSync(HR) }, () => {
  const data = JSON.parse(fs.readFileSync(HR, 'utf8'));
  let stepsChecked = 0;
  for (const idx of Object.keys(data)) {
    const steps = data[idx];
    const r = hr.interviewPath(steps, steps.map((_, i) => i));
    for (let i = 0; i < steps.length; i++) {
      const p = r.path[i];
      const known = p.add + p.ext + p.del;
      const total = (steps[i].ops || []).filter(o => o && ['add', 'ext', 'del'].includes(o.t)).length;
      assert.strictEqual(known, total, `病例 ${idx} 第 ${i} 步的 op 计数对不上：${known} vs ${total}`);
      stepsChecked++;
    }
  }
  assert.ok(stepsChecked >= 1, '一条 ops 都没量到');
  process.stdout.write(`[ops 计数逐句核对 ${stepsChecked} 步]\n`);
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
    const hr = require(${JSON.stringify(ENGINE)});
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

test('旧文件名已删除：任何人再引 history-replay.js 就是引了一份副本', () => {
  const legacy = path.join(__dirname, '..', 'site', 'assets', 'js', 'domain', 'history-replay.js');
  assert.ok(!fs.existsSync(legacy), 'history-replay.js 还在：同一算法将出现两份实现');
  const root = path.join(__dirname, '..');
  const hit = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', '_qa', '_trash_bak_20261013', '_audit_backup_20261013', 'archive', 'overall_cases', 'recon', '.workbuddy'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (p === __filename) continue;              // 本文件为了钉这件事，自己必然提到旧名
      if (!/\.(js|mjs|cjs|html|md|json)$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      if (/history-replay/.test(s)) hit.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepStrictEqual(hit, [], '还有地方在引旧路径（会静默拿到不存在的路径或另一份实现）：' + hit.join(', '));
});
