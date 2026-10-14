// 行为级自测驱动（只在 URL 带 #qa= 时激活，否则本模块什么都不做）。
// 它不 import app.js、不读应用内部状态，只通过真实 DOM 点击与 localStorage 交接，
// 因此它测的是「玩家那条链」而不是「函数自己的定义」——上一轮就是栽在只调函数、
// 结果引擎收到的答卷形状和页面存的根本不是一回事，而单测照样全绿。
//
// 用法（两趟无头 Chrome，同一个 profile，中间靠 localStorage 交接期望值）：
//   #qa=act      打开病例 → 完成病史 → 体格 → 辅助(全选+检测) → 诊断(搜索+选+分类) → 治疗(选场景+点项) → 提交
//                把提交时刻看到的成绩与答卷快照写进 localStorage['qa_expect']
//   #qa=density  同一 profile 续跑：三档信息密度的可见性取证（考试档零泄露 / 复盘思维链 / 学习档反证）
//   #qa=verify   重新载入 → 读回成绩单与【答卷本体】→ 与期望逐项比对 → 再点一次确认答案已锁定
// 结果落在 <pre id="qa-result">，由 tools/qa_run.js 用 --dump-dom 回读并判定退出码。
'use strict';

const HANDOFF = 'qa_expect';
const RESULT_ID = 'qa-result';
const checks = [];
let stage = 'unknown';

// 断言值必须是真布尔：非布尔一律判红，并把它的字面值写进读数。
// 用 `!!pass` 兜转会吞掉「我本来想断言的东西是 undefined / 空数组」这类写错的断言。
function add(name, pass, detail) {
  let d = detail === undefined ? '' : String(detail);
  if (pass !== true && typeof pass !== 'boolean') d = (`[断言值不是布尔：${JSON.stringify(pass)}] ` + d).trim();
  checks.push({ name, pass: pass === true, detail: d });
}

function emit(extra) {
  const payload = Object.assign({
    stage,
    done: true,
    fail: checks.filter(c => c.pass !== true).length,
    total: checks.length,
    checks,
  }, extra || {});
  const text = JSON.stringify(payload);
  let pre = document.getElementById(RESULT_ID);
  if (!pre) {
    pre = document.createElement('pre');
    pre.id = RESULT_ID;
    document.body.appendChild(pre);
  }
  pre.textContent = text;
  document.title = 'QA_DONE ' + payload.stage + ' fail=' + payload.fail;
}

function fatal(reason) { emit({ fatal: reason, done: true }); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const txt = sel => { const e = $(sel); return e ? e.textContent.trim() : null; };

// 等到应用真的把数据画出来（.sp-ver 是启动完成后才有的元素）
async function ready(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ($('.sp-ver') && $('#section').textContent.length > 200 && !/正在载入/.test($('#section').textContent)) {
      // 8MB 病例是异步 fetch 的，模块装载完不等于数据画完
      if (!$('.empty.load-error')) return true;
      return false;
    }
    await sleep(50);
  }
  return false;
}

function tabOf(re) {
  const t = $$('.tab').find(x => re.test(x.textContent));
  if (!t) throw new Error('找不到板块 ' + re);
  t.click();
  return t;
}

// 进度条读数：「30 项 · 标准 37 / 扣分线 55.5 / 上限 74」
function readLimit() {
  const raw = txt('.limit-val') || '';
  const m = raw.match(/^\s*([\d.]+)\s*(?:项|次)/);
  const s = raw.match(/标准\s*([\d.]+)/);
  return { val: m ? Number(m[1]) : null, std: s ? Number(s[1]) : null, raw };
}

// 一路点到标准线为止。每次重新查询节点——渲染层每点一次都重发整段 DOM，
// 攥着旧节点继续点等于点了些已经脱离文档的按钮。
function clickUntilStandard(sel, maxClicks) {
  let n = 0;
  for (;;) {
    const { val, std } = readLimit();
    if (val == null || std == null) break;
    if (val >= std) break;
    if (n >= maxClicks) break;
    const next = $$(sel).find(e => e.getAttribute('aria-pressed') !== 'true');
    if (!next) break;
    next.click();
    n++;
  }
  return { clicks: n, after: readLimit() };
}

// 起点必须是真的空：进度条读数与评分卡都是可观察证据。
// 靠「先 clear 一下」假装干净是不成立的——应用启动时已经把旧存档读进内存了。
function assertCleanStart() {
  const dirty = [];
  for (const re of [/病史/, /体格/, /辅助/]) {
    tabOf(re);
    const { val, raw } = readLimit();
    if (val !== 0) dirty.push(re.source + ' 起始 ' + raw);
  }
  if ($('.score-card')) dirty.push('已经存在评分卡（本病例早已提交过）');
  add('起点干净', dirty.length === 0, dirty.join('；') || '三板块计数均为 0');
  return dirty.length === 0;
}

// 答卷本体的可见证据。
// 成绩单是【提交那一刻】算完就存下来的快照，只比对它，「刷新后存档把分类/场景丢了」
// 会表现为「分数一模一样」而悄悄溜过去——上一轮就是这么放过了一个真缺陷（实测复现过）。
// 所以这里逐项读回答卷本身：各板块进度条、已采集项数、每个诊断的分类与证据标记、治疗场景。
function answerSnapshot() {
  const per = {};
  for (const [name, re] of [['病史', /病史/], ['体格', /体格/], ['辅助', /辅助/], ['治疗', /治疗/]]) {
    tabOf(re);
    per[name] = { limit: readLimit().raw, picked: $$('#section [aria-pressed="true"]').length };
  }
  tabOf(/治疗/);
  const scene = (txt('#section .scene-active') || '').replace(/\s+/g, '');
  tabOf(/诊断/);
  const diag = $$('.diag-selected').map(c => ({
    name: c.dataset.d,
    // 可作答时分类是按钮（.cls-btn.active），复盘/锁定时是静态标签（.cls-tag）。
    // 只读按钮的话，提交后自动进复盘档 ⇒ 两边都读成「未分类」，相等是蒙出来的（已被证伪揪出）。
    cls: (c.querySelector('.cls-btn.active') || c.querySelector('.cls-tag') || {}).textContent || '未分类',
    marks: c.querySelectorAll('.ev-label.active').length,
  }));
  return { per, scene, diag };
}

function act() {
  if (!assertCleanStart()) { emit({ aborted: '起点不干净' }); return; }
  // —— 病史 ——
  tabOf(/病史/);
  const h = clickUntilStandard('#section .pcard', 60);
  add('病史：点到标准线', h.after.val >= h.after.std && h.clicks > 0, `${h.clicks} 次点击 → ${h.after.raw}`);

  // —— 体格 ——
  tabOf(/体格/);
  const p = clickUntilStandard('#section .pcard', 60);
  add('体格：点到标准线', p.after.val >= p.after.std && p.clicks > 0, `${p.clicks} 次点击 → ${p.after.raw}`);

  // —— 辅助：逐组 展开 → 全选 → 检测 ——
  // 每按一次都整段重渲染，所以每一轮都按「组 key」重新定位节点。
  // 上一版攥着 .aux-sel[i] 的下标继续点：第 0 组检测完就没有全选按钮了，
  // 第 1 圈的下标 1 其实指向第 3 组，检测按钮找不到 ⇒ 只跑成 1 组（少跑一组没人报错）。
  tabOf(/辅助/);
  const groupKeys = $$('.aux-sec-toggle').map(b => b.dataset.grp);
  const auxHead = gk => $$('.aux-sec-head').find(h => {
    const t = h.querySelector('.aux-sec-toggle');
    return !!t && t.dataset.grp === gk;
  });
  const auxRan = [], auxSkip = [];
  for (const gk of groupKeys) {
    if (auxRan.length === 2) break;
    const t0 = auxHead(gk) && auxHead(gk).querySelector('.aux-sec-toggle');
    if (!t0) { auxSkip.push('缺组标题'); continue; }
    if (t0.getAttribute('aria-expanded') !== 'true') t0.click();   // 折叠态才展开：对已展开的组再点一次是收起
    const sel = auxHead(gk) && auxHead(gk).querySelector('.aux-sel');
    if (!sel) { auxSkip.push('缺全选'); continue; }
    sel.click();
    const run = auxHead(gk) && auxHead(gk).querySelector('.aux-run');
    if (!run) { auxSkip.push('缺检测'); continue; }
    run.click();
    auxRan.push(gk);
  }
  const aux = readLimit();
  const auxPicked = $$('.aux-row.picked').length;
  add('辅助：两组各自全选并检测', auxRan.length === 2 && aux.val === 2,
    `跑了 ${auxRan.length}/${groupKeys.length} 组` + (auxSkip.length ? `，卡住：${auxSkip.join('、')}` : '') + ` → ${aux.raw}`);
  add('辅助：确有项被采进答卷', auxPicked > 0, `已采集 ${auxPicked} 项`);

  // —— 诊断：搜索 → 点建议 → 在【该诊断自己的卡片里】点分类 ——
  // 添加一个诊断就重渲染并换掉输入框节点，所以每轮重新取 #diagSearch；
  // 上一版拿全局 .cls-btn[i] 的下标，第 2 个诊断点到的是第 1 个诊断的「次要诊断」，
  // 而且循环里 box 早已脱离文档，三个关键词实际只加进去 1 个诊断。
  tabOf(/诊断/);
  const added = [], addedNames = new Set(), missed = [];
  for (const kw of ['贫血', '高血压', '出血']) {
    const box = $('#diagSearch');
    if (!box) { missed.push(`${kw}(搜索框没了)`); break; }
    box.value = kw;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const sug = $$('.diag-sug').find(b => !addedNames.has(b.dataset.name));
    if (!sug) { missed.push(`${kw}(无新匹配)`); continue; }
    const name = sug.dataset.name;
    sug.click();
    addedNames.add(name);
    const card = $$('.diag-selected').find(c => c.dataset.d === name);
    const btn = card && card.querySelector('.cls-btn');
    if (!btn) { missed.push(`${name}(无分类按钮)`); continue; }
    btn.click();
    added.push(name);
  }
  add('诊断：三个关键词都加进答卷并完成分类', added.length === 3,
    `加了 ${added.length}/3 个：${added.join('、')}` + (missed.length ? `；未成：${missed.join('、')}` : ''));

  // —— 治疗：先选场景，再点措施 ——
  tabOf(/治疗/);
  const scene = $$('.scene-btn')[0];
  let sceneName = null;
  if (scene) { scene.click(); sceneName = scene.dataset.scene; }
  const tx = clickUntilStandard('#section .pcard', 30);
  add('治疗：选定场景并点到标准线', !!sceneName && tx.clicks > 0, `场景 ${sceneName} → ${tx.after.raw}`);

  // 「切换场景」是个曾经点不动的按钮：没有任何分支派发过它。
  // 这里要的是真的回到闸门、再回到同一场景，且已采集的治疗项一个不少。
  const pickedBeforeSwitch = $$('#section [aria-pressed="true"]').length;
  const back = $('.scene-change');
  let gateBack = false;
  if (back) {
    back.click();
    gateBack = !!$('.scene-gate');
    const again = $$('.scene-btn')[0];
    if (again) again.click();
  }
  add('治疗：「切换场景」回到闸门并能再选回，已采集项不丢',
    gateBack && !!$('.scene-active') && $$('#section [aria-pressed="true"]').length === pickedBeforeSwitch,
    `闸门${gateBack ? '出现' : '未出现'}，回到场景后已采集 ${$$('#section [aria-pressed="true"]').length}/${pickedBeforeSwitch} 项`);

  // —— 提交 ——
  const before = txt('.sp-total');
  let confirmMsg = '';
  window.confirm = msg => { confirmMsg = msg; return true; };   // 不弹真窗（会抢焦点），捕获文案后直接放行
  const btn = $('#btnSubmit') || $('.btn-submit');
  add('提交按钮存在', !!btn, `提交前实时分 ${before}`);
  if (!btn) { emit({ aborted: 'no submit button' }); return; }
  btn.click();

  const card = $('.score-card');
  const total = card ? card.querySelector('.score-total').textContent : null;
  const ver = card ? (card.querySelector('.sp-ver') || {}).textContent : null;
  const weights = card ? (card.querySelector('.score-weights') || {}).textContent : null;
  const rows = card ? [...card.querySelectorAll('.sb-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()) : [];
  add('提交后出现评分卡', !!card, total);
  add('提交弹窗文案里的权重与评分卡一致', !!weights && confirmMsg.includes(weights.replace(/^权重：/, '')), weights);
  add('评分卡自报规则与病例版本', /规则\s+\S+/.test(ver || '') && /病例\s+c[0-9a-f]{8}/.test(ver || ''), ver);

  const expect = { total, ver, weights, rows, snap: answerSnapshot(), ts: Date.now(), ua: 'headless' };
  localStorage.setItem(HANDOFF, JSON.stringify(expect));
  add('期望值已交接', true, total);
  emit({ captured: expect });
}

function verify() {
  let want = null;
  try { want = JSON.parse(localStorage.getItem(HANDOFF)); } catch (e) { want = null; }
  add('读得到上一趟的期望值', !!want, want ? want.total : 'localStorage 里没有 qa_expect');
  if (!want) { emit({ aborted: 'no handoff' }); return; }

  const card = $('.score-card');
  const total = card ? card.querySelector('.score-total').textContent : null;
  const ver = card ? (card.querySelector('.sp-ver') || {}).textContent : null;
  const rows = card ? [...card.querySelectorAll('.sb-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()) : [];
  add('刷新后总分一模一样', total === want.total, `${want.total} → ${total}`);
  add('刷新后各板块明细一模一样', JSON.stringify(rows) === JSON.stringify(want.rows), rows.length + ' 行');
  add('刷新后仍写着同一版规则与病例', ver === want.ver, ver);

  const lock = $('.lock-banner');
  add('刷新后仍显示已锁定', !!lock, lock ? lock.textContent.slice(0, 24) : '无锁定横幅');

  // 成绩单一样 ≠ 答卷还在：必须逐项读回答卷本体
  const got = answerSnapshot();
  const wantSnap = want.snap;
  add('上一趟留下了答卷快照', !!wantSnap, wantSnap ? Object.keys(wantSnap.per).join('/') : '期望值里没有 snap');
  if (wantSnap) {
    const diffs = [];
    for (const k of Object.keys(wantSnap.per)) {
      const a = wantSnap.per[k], b = got.per[k];
      if (!b) { diffs.push(`${k} 刷新后读不到`); continue; }
      if (a.limit !== b.limit) diffs.push(`${k} 进度「${a.limit}」→「${b.limit}」`);
      if (a.picked !== b.picked) diffs.push(`${k} 已采集 ${a.picked} → ${b.picked}`);
    }
    add('刷新后答卷本体：四板块进度与已采集数一模一样', diffs.length === 0,
      diffs.join('；') || `${Object.keys(got.per).length} 个板块逐项相等`);

    const dd = [];
    if (got.diag.length !== wantSnap.diag.length) dd.push(`诊断数 ${wantSnap.diag.length} → ${got.diag.length}`);
    for (const w of wantSnap.diag) {
      const g = got.diag.find(x => x.name === w.name);
      if (!g) { dd.push(`${w.name} 刷新后消失`); continue; }
      if (g.cls !== w.cls) dd.push(`${w.name} 分类「${w.cls}」→「${g.cls}」`);
      if (g.marks !== w.marks) dd.push(`${w.name} 证据标记 ${w.marks} → ${g.marks}`);
    }
    add('刷新后答卷本体：诊断分类与证据标记一模一样', dd.length === 0,
      dd.join('；') || `${got.diag.length} 个诊断逐项相等`);
    // 覆盖断言：上一条「逐项相等」在两边都读成未分类时也是绿的，所以必须证明数到了真分类
    add('答卷里确实有诊断分了类（相等不是两个「未分类」蒙的）',
      got.diag.some(d => d.cls && d.cls !== '未分类'),
      got.diag.map(d => `${d.name}:${d.cls}`).join(' · '));
    add('刷新后答卷本体：治疗场景还在', got.scene === wantSnap.scene,
      `${wantSnap.scene || '(无)'} → ${got.scene || '(无)'}`);
  }

  // 锁定必须是真的：再点一次，分数不许动
  tabOf(/病史/);
  const any = $$('#section .pcard').find(e => e.getAttribute('aria-pressed') !== 'true');
  if (any) any.click();
  tabOf(/病史/);
  const after = ($('.score-card') ? $('.score-card').querySelector('.score-total').textContent : null);
  add('锁定后再点选，分数不变', after === want.total, `${want.total} → ${after}`);

  localStorage.removeItem(HANDOFF);   // 交接是一次性的，用完就清掉，免得下一趟拿旧期望比新成绩
  emit({ after });
}

// 三档信息密度的「可见性取证」：只读 DOM，不看应用内部状态。
// 考试档有没有漏答案、锁定后有没有点不动的控件、复盘有没有真的把思维链画出来——
// 这三件事都没法靠单元测试证明，因为它们是「渲染出来的分支」。
const LEAK_SEL = ['.badge-nec', '.badge-score', '.scent-dot', '.b-miss', '.b-off', '.aux-std', '.p-reply.std', '.rt-verdict', '.rt-wrap', '.rt-miss'];
const DEAD_SEL = ['button.aux-sel', 'button.aux-run', 'button.cls-btn', '#diagSearch', 'button.ev-label'];

function setUi(btnId) {
  const b = document.getElementById(btnId);
  if (!b) throw new Error('找不到档位按钮 #' + btnId);
  b.click();
  return b.dataset.ui;
}
// 进入辅助板块时应用会把分组强制折叠（v49），折叠状态下根本不渲染行——
// 直接数就等于对着一张空表断言「没有泄露」。所以扫辅助前必须先把分组展开，
// 并把「展开了几组、看见几行」写进断言读数，让覆盖数自己说话。
function expandAllAux() {
  let guard = 0;
  for (;;) {
    const t = $$('.aux-sec-toggle').find(b => b.getAttribute('aria-expanded') !== 'true');
    if (!t || guard++ > 60) break;
    t.click();
  }
  return {
    groups: $$('.aux-sec-toggle').length,
    open: $$('.aux-sec-toggle').filter(b => b.getAttribute('aria-expanded') === 'true').length,
    rows: $$('#section .aux-row').length,
  };
}
function visitTab(re) {
  tabOf(re);
  return re.source === '辅助' ? expandAllAux() : { groups: 0, open: 0, rows: $$('#section .pcard').length };
}

const TABS = [/病史/, /体格/, /辅助/, /诊断/, /治疗/];

function countLeaksPerTab() {
  const out = [];
  for (const re of TABS) {
    const cov = visitTab(re);
    out.push({ tab: re.source, cov, n: LEAK_SEL.reduce((a, s) => a + $$('#section ' + s).length, 0) });
  }
  return out;
}
function countDeadPerTab() {
  const out = [];
  for (const re of TABS) {
    const cov = visitTab(re);
    out.push({ tab: re.source, cov, n: DEAD_SEL.reduce((a, s) => a + $$('#section ' + s).length, 0) });
  }
  return out;
}

function density() {
  // 前置：复盘要看的是「已提交的答卷」，所以这一趟必须在 act 之后、同一个 profile 里跑
  if (!$('.score-card')) { add('复盘前置：本病例已提交', false, '页面上没有评分卡'); emit({ aborted: 'density 需要已提交的病例（先跑 act）' }); return; }

  const per = countLeaksPerTab();
  const leaks = per.filter(x => x.n > 0);
  const seen = per.reduce((a, x) => a + x.cov.rows, 0);
  add('考试档零泄露：五板块都没有答案节点', leaks.length === 0,
    `扫了 ${per.length} 个板块 × ${LEAK_SEL.length} 类节点，共看见 ${seen} 行可泄露的条目` +
    (leaks.length ? `；命中：${leaks.map(x => `${x.tab} ${x.n}`).join('，')}` : ''));

  const dead = countDeadPerTab().filter(x => x.n > 0);
  add('已提交（不能作答）时不留点不动的控件', dead.length === 0,
    dead.length ? `命中：${dead.map(x => `${x.tab} ${x.n} 个`).join('，')}` : `查了 ${TABS.length} 个板块 × ${DEAD_SEL.length} 类控件，都没有`);

  setUi('btnReview');
  tabOf(/诊断/);
  const stages = $$('.rt-stage').length;
  const nodes = $$('.rt-item').length;
  add('复盘档画出临床思维链的五段', !!$('#reasoningTimeline') && stages === 5, `${stages} 段 / ${nodes} 条节点`);
  // 线索段必须真的把「勾了哪些问题」映射回出题步序（stepIdxsForQuestions 在浏览器里、
  // 拿真实 8MB 数据跑通才算数）：映射断了这一段会退化成「本页面无问诊轨迹数据」。
  const clueSum = ($('.rt-clues .rt-sum') || {}).textContent || '';
  const asked = (clueSum.match(/问诊\s*(\d+)\/(\d+)\s*步/) || [])[1];
  add('思维链的线索段接上了真实问诊轨迹', !!asked && Number(asked) > 0, clueSum || '线索段没有问诊计数');
  // 复盘档要在【每个板块】都把「该不该选 / 你有没有选」画出来，而不是只在诊断栏挂个标签。
  // 上一版用「必要徽章 OR 结论标签」判定，诊断栏 0 个徽章也能蒙过去（已复现），所以逐板块扫。
  const cmp = [];
  for (const re of [/病史/, /体格/, /辅助/, /治疗/]) {
    const cov = visitTab(re);
    cmp.push({ tab: re.source, cov, nec: $$('#section .badge-nec').length, miss: $$('#section .b-miss').length, off: $$('#section .b-off').length });
  }
  const cmpTotals = cmp.reduce((a, x) => a + x.nec + x.miss + x.off, 0);
  const noCmp = cmp.filter(x => x.nec === 0);
  add('复盘档逐板块把作答与标准并排（必要/漏/未计分都画出来）', cmpTotals > 0 && noCmp.length === 0,
    cmp.map(x => `${x.tab}：必要${x.nec} 漏${x.miss} 未计分${x.off}（看了 ${x.cov.rows} 行）`).join(' · '));

  // 这条是上一条「考试档零泄露」的反证桩：学习档若也扫不到答案节点，那条断言就是永真绿
  setUi('btnStudy');
  let study = 0;
  let studyRows = 0;
  for (const re of [/病史/, /体格/, /辅助/]) { visitTab(re); study += $$('#section .badge-nec, #section .scent-dot').length; studyRows += $$('#section .aux-row, #section .pcard').length; }
  add('学习档确实把答案摊开（证明上面的零泄露不是永真绿）', study > 0, `学习与对照节点 ${study} 个（扫了 ${studyRows} 行）`);

  // 复盘在未提交的病例上不许开答案：换一例没提交过的
  const second = $$('.case-card').find(c => c.dataset.i === '1');
  if (!second) {
    add('复盘在未提交病例上不开答案', false, '找不到第二例病例来验证未提交状态');
  } else {
    second.click();
    setUi('btnReview');
    const l2 = countLeaksPerTab().reduce((a, x) => a + x.n, 0);
    const warn = ($('#reportPanel') || {}).textContent || '';
    add('复盘在未提交病例上不开答案', l2 === 0 && /还没提交/.test(warn),
      `答案节点 ${l2} 个，提示语${/还没提交/.test(warn) ? '已说明原因' : '缺失'}`);
  }

  // 收尾必须把档位和病例都放回 act 之后的样子，否则下一趟 verify 读不到评分卡
  const first = $$('.case-card').find(c => c.dataset.i === '0');
  if (first) first.click();
  setUi('btnExam');
  add('收尾回到考试档与病例 1', !!$('.score-card') && (document.querySelector('.mode-btn.active') || {}).dataset?.ui === 'exam',
    (document.querySelector('.mode-btn.active') || {}).textContent || '没有高亮档位');
  emit({});
}

// 截图档：给 tools/shot.js 用。它不判定对错，只把页面停在某一档的某个板块上，
// 让无头 Chrome 的 --screenshot 拍到「这一档到底长什么样」。
function shot(which) {
  const btnId = { study: 'btnStudy', exam: 'btnExam', review: 'btnReview' }[which];
  if (!btnId) { fatal('未知截图档位：' + which); return; }
  // ≥861px 时病例栏是浮层抽屉，展开着会盖住作答区左半边——截图前先收起来
  const burger = document.getElementById('sbToggle');
  if (burger && document.body.classList.contains('sb-open')) burger.click();
  setUi(btnId);
  tabOf(which === 'review' ? /诊断/ : /病史/);
  if (which === 'review') {
    // 复盘的思维链在右栏，展开一组辅助让对照标记也出现在画面里
    visitTab(/辅助/);
    tabOf(/诊断/);
  }
  add('截图停在这一档', true, `${which} / 高亮档=${(document.querySelector('.mode-btn.active') || {}).textContent || '?'}`);
  emit({});
}

async function main() {
  stage = (location.hash.match(/^#qa=([\w-]+)/) || [])[1] || 'act';
  if (!(await ready(30000))) { fatal('页面在 30 秒内没有完成装载'); return; }
  if (stage === 'act') {
    act();
  } else if (stage === 'density') {
    density();
  } else if (stage === 'verify') {
    verify();
  } else if (/^shot-/.test(stage)) {
    shot(stage.slice(5));
  } else {
    fatal('未知 #qa 阶段：' + stage);
  }
}

if (/^#qa=/.test(location.hash)) {
  main().catch(err => fatal((err && err.message) || String(err)));
}
