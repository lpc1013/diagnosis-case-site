'use strict';
// 三档信息密度的接线闸（静态）。
// 行为级 E2E 已经会点这三档了，但它只能在「跑得起来」的时候说话；
// 这一条管的是更基础的一件事：顶栏按钮、应用里的判定、驱动里的 id 映射，三者必须还是同一套名字。
// 任何一处改名而其余两处没跟上，页面会照常渲染、按钮会照常存在，只是点了没反应。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read(path.join('site', 'index.html'));
const APP = read(path.join('site', 'assets', 'app.js'));
const QA = read(path.join('site', 'assets', 'qa.js'));

const UI = ['study', 'exam', 'review'];

test('顶栏三档按钮：id、data-ui、aria-pressed 一个都不能少', () => {
  const btns = [...HTML.matchAll(/<button id="(btn\w+)" class="mode-btn[^"]*"[^>]*data-ui="(\w+)"[^>]*aria-pressed="(\w+)"/g)]
    .map(m => ({ id: m[1], ui: m[2], pressed: m[3] }));
  assert.deepStrictEqual(btns.map(b => b.ui), UI, `档位按钮应与 ${UI.join('/')} 一一对应，实际：${JSON.stringify(btns)}`);
  assert.strictEqual(btns.filter(b => b.pressed === 'true').length, 1, '必须恰好一个按钮标为按下态（初始档）');
  assert.strictEqual(new Set(btns.map(b => b.id)).size, 3, '三档按钮 id 不能重复');
  process.stdout.write(`[三档按钮接线：${btns.map(b => `${b.id}=${b.ui}`).join(' ')}]\n`);
});

test('应用侧的档位判定必须是这一套（少一个就把某一档降级成考试档）', () => {
  for (const fn of ['isStudy', 'isExam', 'isReview', 'showsAnswers', 'canEdit']) {
    assert.match(APP, new RegExp(`function ${fn}\\(\\)`), `app.js 里找不到 ${fn}() —— 泄露/死控件的判定就没了单一来源`);
  }
  assert.ok(!/state\.mode\b/.test(APP), 'app.js 里还留着 state.mode：说明有两处代码在读两套状态');
  assert.match(APP, /ui: 'exam'/, '默认档必须是考试档：新页面一打开就要能闭卷作答');
  assert.match(APP, /if \(isReview\(\) && answerLocked\(\)\) html \+= renderReasoningTimeline\(\);/,
    '思维链没有挂在「复盘且已提交」的闸门上');
});

test('驱动里的档位 id 映射必须跟得上顶栏改名', () => {
  const map = new Set([...QA.matchAll(/(\w+): '(btn\w+)'/g)].map(m => m[1]));
  assert.deepStrictEqual([...map].sort(), [...UI].sort(), `qa.js 认的档位是 ${[...map].join('/')}，与顶栏不一致`);
  for (const b of ['btnStudy', 'btnExam', 'btnReview']) {
    assert.ok(QA.includes(`'${b}'`) && HTML.includes(`id="${b}"`), `${b} 在驱动或顶栏里缺一处`);
  }
});

test('旧的两态说法在站点代码里彻底消失（防止半套实现共存）', () => {
  const stale = [];
  const files = { 'site/assets/app.js': APP, 'site/index.html': HTML, 'site/assets/qa.js': QA };
  for (const f of Object.keys(files)) {
    for (const pat of [/state\.mode\b/, /btnPractice/, /btnAnswer/, /练习模式/, /答案模式/, /'practice'/, /'answer'/]) {
      if (pat.test(files[f])) stale.push(`${f}: ${pat.source}`);
    }
  }
  assert.deepStrictEqual(stale, [], '还残留旧模式说法：' + stale.join('，'));
  process.stdout.write(`[旧两态说法残留 0 处（扫 ${Object.keys(files).length} 个文件 × 7 条模式）]\n`);
});
