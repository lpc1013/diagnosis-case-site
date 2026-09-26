'use strict';

const SECTIONS = [
  { key: 'history', label: '病史' },
  { key: 'physical', label: '体格' },
  { key: 'aux', label: '辅助' },
  { key: 'diagnosis', label: '诊断' },
  { key: 'treatment', label: '治疗' },
];
const TX_SCENES = ['住院', '门诊', '急诊', '转诊治疗'];
const DIAG_CLS = ['主要诊断', '次要诊断', '鉴别诊断', '疑似诊断'];

const state = {
  cases: null,
  diaglib: null,
  cur: 0,
  sec: 'history',
  necOnly: false,
  mode: 'practice',          // 'practice' | 'answer'
  q: '',
  picked: {},                // picked[caseIdx][sec] = Set(key)
  diagQ: '',                 // 诊断模块内搜索
  diagMarks: {},             // diagMarks[caseIdx][diagName] = { support:Set(key), unsupport:Set(key) }
  diagClass: {},             // diagClass[caseIdx][diagName] = '主要诊断'|...
  activeDiag: {},            // activeDiag[caseIdx] = diagName（依据列表作用对象）
  txScene: {},               // txScene[caseIdx] = '住院'|'门诊'|'急诊'|'转诊治疗'
  auxPending: {},            // auxPending[caseIdx] = Set(key) 辅助检查多选「待检测」
  auxExpanded: {},           // auxExpanded[caseIdx] = Set(grpKey) 辅助组展开集合（v48 默认全折叠，点开才展开）
  auxCheckCount: {},          // auxCheckCount[caseIdx] = 检测动作次数（进度条口径=检查次数，v44）
  sbOpen: true,               // v50 桌面左侧病例抽屉：默认展开，会话内状态（不持久化）
  scores: {},                // scores[caseIdx] = { total, breakdown:[{label,weight,rate}], ts }
  hintDismissed: false,      // 移动端「提交位置」提示条是否已关闭
};

// ---------- 本地持久化（练习进度 + 评分，刷新不丢）----------
const LS_KEY = 'wb_clinthink_v1';
function serializePicked() {
  const o = {};
  for (const ci in state.picked) {
    o[ci] = {};
    for (const sec in state.picked[ci]) o[ci][sec] = [...state.picked[ci][sec]];
  }
  return o;
}
function serializeDiagMarks() {
  const out = {};
  for (const ci in state.diagMarks) {
    const byName = state.diagMarks[ci];
    if (!byName) continue;
    const o = {};
    for (const name in byName) {
      const m = byName[name];
      if (!m) continue;
      const s = Array.from(m.support || []), u = Array.from(m.unsupport || []);
      if (s.length || u.length) o[name] = { support: s, unsupport: u };
    }
    if (Object.keys(o).length) out[ci] = o;
  }
  return out;
}
function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ picked: serializePicked(), scores: state.scores || {}, hintDismissed: !!state.hintDismissed, auxCheckCount: state.auxCheckCount || {}, diagMarks: serializeDiagMarks(), activeDiag: state.activeDiag || {} }));
  } catch (e) { /* 容量或隐私模式，忽略 */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.picked) {
      for (const ci in d.picked) {
        state.picked[ci] = state.picked[ci] || {};
        for (const sec in d.picked[ci]) state.picked[ci][sec] = new Set(d.picked[ci][sec]);
      }
    }
    if (d.scores) state.scores = d.scores;
    if (typeof d.hintDismissed === 'boolean') state.hintDismissed = d.hintDismissed;
    if (d.auxCheckCount) state.auxCheckCount = d.auxCheckCount;
    // P2#6 诊断标记/当前诊断持久化（刷新或误关标签页不丢）
    if (d.diagMarks) {
      for (const ci in d.diagMarks) {
        state.diagMarks[ci] = state.diagMarks[ci] || {};
        for (const name in d.diagMarks[ci]) {
          const m = d.diagMarks[ci][name];
          state.diagMarks[ci][name] = { support: new Set(m.support || []), unsupport: new Set(m.unsupport || []) };
        }
      }
    }
    if (d.activeDiag) state.activeDiag = d.activeDiag;
    // v44 兼容旧数据：无检测次数记录时按已采集项目数兜底（近似旧口径，避免进度跳变）
    for (const ci in state.picked) {
      if (state.picked[ci] && state.picked[ci].aux && state.auxCheckCount[ci] == null) {
        state.auxCheckCount[ci] = state.picked[ci].aux.size;
      }
    }
  } catch (e) { /* 损坏则忽略 */ }
}

// ---------- 工具 ----------
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/&lt;sup&gt;/g, '<sup>').replace(/&lt;\/sup&gt;/g, '</sup>')
    .replace(/&lt;sub&gt;/g, '<sub>').replace(/&lt;\/sub&gt;/g, '</sub>');
}
function isNec(g) { return !!g.necessary; }
function scoreOf(g) { return g.score || 0; }
// 寻血标记：祖先结构含正确（必要）项时点亮
function scentMark(n) { return n > 0 ? '<span class="scent-dot" title="含正确选项"></span>' : ''; }
function necCountInNode(n) {
  if (n.items) return n.items.filter(isNec).length;
  if (n.subs) return n.subs.reduce((a, s) => a + necCountInNode(s), 0);
  if (n.children) return n.children.reduce((a, c) => a + necCountInNode(c), 0);
  return isNec(n) ? 1 : 0; // 辅助：叶子节点自身即项目
}
function getCase() { return state.cases[state.cur]; }
function norm(s) { return (s || '').replace(/\s+/g, '').replace(/[：:\/\\]/g, '').toLowerCase(); }

function keyOf(sec, item, path) {
  const p = (path || []).map(x => norm(x)).join('|');
  if (sec === 'history') return 'h|' + norm(item.q);
  if (sec === 'diagnosis') return 'd|' + norm(item.name);
  return sec[0] + '|' + p + '|' + norm(item.name || item.q);
}
function pickedSet() {
  state.picked[state.cur] = state.picked[state.cur] || {};
  state.picked[state.cur][state.sec] = state.picked[state.cur][state.sec] || new Set();
  return state.picked[state.cur][state.sec];
}
function isPicked(sec, key) {
  const c = state.picked[state.cur];
  return !!(c && c[sec] && c[sec].has(key));
}
function togglePick(sec, key) {
  const set = pickedSet();
  // 练习模式：已采集项不可回退取消（模拟考试，选项提交后不可撤销）
  if (set.has(key)) return;
  set.add(key);
  saveState();
}

// 统计必要项
function countNecHistory(h) { return h.reduce((a, cat) => a + cat.subs.reduce((b, sub) => b + sub.items.filter(isNec).length, 0), 0); }
function countTotalHistory(h) { return h.reduce((a, cat) => a + cat.subs.reduce((b, sub) => b + sub.items.length, 0), 0); }
function countNecPhysical(nodes) {
  return nodes.reduce((a, n) => a + (n.items ? n.items.filter(isNec).length : (n.subs ? countNecPhysical(n.subs) : 0)), 0);
}
function countTotalPhysical(nodes) {
  return nodes.reduce((a, n) => a + (n.items ? n.items.length : (n.subs ? countTotalPhysical(n.subs) : 0)), 0);
}
function countNecAux(nodes) {
  return nodes.reduce((a, n) => a + (n.children ? countNecAux(n.children) : (isNec(n) ? 1 : 0)), 0);
}
function countTotalAux(nodes) {
  return nodes.reduce((a, n) => a + (n.children ? countTotalAux(n.children) : 1), 0);
}
function countNecTreatment(t) { return t.reduce((a, g) => a + g.items.filter(isNec).length, 0); }
function countTotalTreatment(t) { return t.reduce((a, g) => a + g.items.length, 0); }

function necessaryKeys(sec) {
  const s = getCase().sections, out = [];
  if (sec === 'history') s.history.forEach(cat => cat.subs.forEach(sub => sub.items.forEach(it => { if (it.necessary) out.push(keyOf('history', it)); })));
  else if (sec === 'physical') s.physical.forEach(n => collectPhysicalKeys(n, [], out));
  else if (sec === 'aux') auxTopLevel().forEach(n => collectAuxKeys(n, [], out));
  else if (sec === 'treatment') s.treatment.forEach(g => g.items.forEach(it => { if (it.necessary) out.push(keyOf('treatment', it, [g.group])); }));
  else if (sec === 'diagnosis') s.diagnosis.forEach(d => out.push(keyOf('diagnosis', d)));
  return out;
}
function collectPhysicalKeys(n, path, out) {
  const p2 = path.concat(n.name);
  if (n.items) n.items.forEach(it => { if (it.necessary) out.push(keyOf('physical', it, p2)); });
  else if (n.subs) n.subs.forEach(s => collectPhysicalKeys(s, p2, out));
}
function collectAuxKeys(n, path, out) {
  const p2 = path.concat(n.name);
  if (n.children) n.children.forEach(c => collectAuxKeys(c, p2, out));
  else if (n.necessary) out.push(keyOf('aux', n, p2));
}

function collectPicked(sec) {
  const s = getCase().sections, out = [];
  const push = (item, l1, l2, nec, path) => { if (isPicked(sec, keyOf(sec, item, path))) out.push({ l1, l2, nec: !!nec }); };
  if (sec === 'history') s.history.forEach(cat => cat.subs.forEach(sub => sub.items.forEach(it => push(it, it.q, it.reply, it.necessary, [cat.category, sub.name]))));
  else if (sec === 'physical') s.physical.forEach(n => collectPhysicalPicked(n, [], out));
  else if (sec === 'aux') auxTopLevel().forEach(n => collectAuxPicked(n, [], out));
  else if (sec === 'treatment') s.treatment.forEach(g => g.items.forEach(it => push(it, it.name + (it.attr ? `（${it.attr}）` : ''), '', it.necessary, [g.group])));
  else if (sec === 'diagnosis') s.diagnosis.forEach(d => push(d, d.name, '', true, []));
  return out;
}
function collectPhysicalPicked(n, path, out) {
  const p2 = path.concat(n.name);
  if (n.items) n.items.forEach(it => { if (isPicked('physical', keyOf('physical', it, p2))) out.push({ l1: it.name, l2: it.result, nec: !!it.necessary }); });
  else if (n.subs) n.subs.forEach(s => collectPhysicalPicked(s, p2, out));
}
function collectAuxPicked(n, path, out) {
  const p2 = path.concat(n.name);
  if (n.children) n.children.forEach(c => collectAuxPicked(c, p2, out));
  else if (isPicked('aux', keyOf('aux', n, p2))) out.push({ l1: n.name, l2: n.result + (n.ref ? `（参考值 ${n.ref}）` : '') + (n.sig ? `（临床意义 ${n.sig}）` : ''), nec: !!n.necessary });
}

// 诊断「依据列表」对病史的取据：来自系统「检查记录」的结构化总结（而非单纯问答）。
// 把检查记录拆成逐条临床发现，跳过章节头；小节标题（伴随症状1、主要症状…）作为后续条目的上下文前缀。
function historyEvidenceEntries() {
  const rec = historyRecordText();
  if (!rec) return null;
  const body = rec.replace(/^检查记录\s*\n/, '').trim();
  if (!body) return null;
  const out = [];
  let ctx = '';
  for (const ln of body.split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    if (_CR_SECTIONS.has(t)) { ctx = ''; continue; }
    // 小节标题（伴随症状1 / 主要症状 / 起病情况与持续时间 …）：作为后续条目的上下文前缀，本身不入据
    if (t.length <= 10 && !/[？?。.！!，,、：:；;]/.test(t)) { ctx = t; continue; }
    let label = t, detail = '';
    if (ln.includes('：')) { const i = ln.indexOf('：'); label = ln.slice(0, i).trim(); detail = ln.slice(i + 1).trim(); }
    const full = (ctx ? ctx + ' · ' : '') + (detail ? `${label}：${detail}` : label);
    out.push({ sec: '病史采集', key: norm(full), label: (ctx ? ctx + ' · ' : '') + label, detail });
  }
  return out.length ? out : null;
}

// 诊断依据候选池：来自「已采集」的病史/体格/辅助项目（含错误/干扰项）
function collectEvidenceCandidates() {
  const s = getCase().sections, out = [];
  // 病史：依据取自系统「检查记录」结构化总结；无结构化数据时回退为单纯问答
  const histEntries = historyEvidenceEntries();
  if (histEntries) {
    for (const e of histEntries) out.push({ sec: '病史采集', key: e.key, label: e.label, detail: e.detail });
  } else {
    s.history.forEach(cat => cat.subs.forEach(sub => sub.items.forEach(it => {
      if (isPicked('history', keyOf('history', it, [cat.category, sub.name])))
        out.push({ sec: '病史采集', key: keyOf('history', it, [cat.category, sub.name]), label: it.q, detail: it.reply });
    })));
  }
  const pp = (n, path) => {
    const p2 = path.concat(n.name);
    if (n.items) n.items.forEach(it => { if (isPicked('physical', keyOf('physical', it, p2))) out.push({ sec: '体格检查', key: keyOf('physical', it, p2), label: it.name, detail: it.result }); });
    else if (n.subs) n.subs.forEach(s => pp(s, p2));
  };
  s.physical.forEach(n => pp(n, []));
  const pa = (n, path) => {
    const p2 = path.concat(n.name);
    if (n.children) n.children.forEach(c => pa(c, p2));
    else if (isPicked('aux', keyOf('aux', n, p2))) out.push({ sec: '辅助检查', key: keyOf('aux', n, p2), label: n.name, detail: (n.result || '') + (n.ref ? `（参考值 ${n.ref}）` : '') + (n.sig ? `（临床意义 ${n.sig}）` : '') });
  };
  auxTopLevel().forEach(n => pa(n, []));
  return out;
}

// 文本搜索
function matchText(g, q, extras = []) {
  if (!q) return true;
  const hay = [g.q, g.name, g.reply, g.result, g.std, g.content, g.sub, g.synonyms, g.attr, g.category, g.subcategory, g.explain, g.tool, g.position].concat(extras).filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

const SEC_TO_TAB = { history: '病史采集', physical: '体格检查', aux: '辅助检查', diagnosis: '诊断', treatment: '治疗' };
function normName(s) {
  return (s || '').replace(/\s+/g, '').replace(/[：:？?。。、；;，,+＋（）()]/g, '').toLowerCase();
}

// ---------- 侧栏 ----------
function renderSidebar() {
  const el = document.getElementById('caseList');
  el.innerHTML = state.cases.map((c, i) => {
    const practice = state.mode === 'practice';
    const scoreLine = practice ? '' :
      `<span class="c-score">必要项 ${countNecHistory(c.sections.history) + countNecPhysical(c.sections.physical) + countNecAux(c.sections.aux) + c.sections.diagnosis.length + countNecTreatment(c.sections.treatment)}</span>`;
    return `<button class="case-card ${i === state.cur ? 'active' : ''}" data-i="${i}"${i === state.cur ? ' aria-current="true"' : ''}>
      <span class="c-name">${esc(c.name)}</span>
      <span class="c-meta">${esc(c.dept)} · ${esc(c.patient)} · ${esc(c.gender)} · ${esc(c.age)}</span>
      ${scoreLine}
    </button>`;
  }).join('');
  el.querySelectorAll('.case-card').forEach(b => {
    b.onclick = () => { state.cur = +b.dataset.i; state.q = ''; document.getElementById('search').value = ''; if (state.sec === 'aux') state.auxExpanded[state.cur] = new Set();  // v49 切病例后辅助同样默认折叠
      setRpOpen(false); renderCase(); restoreDrawerFocus(); };
  });
}

// ---------- 病例头 ----------
function renderHead() {
  const c = getCase();
  document.getElementById('caseHead').innerHTML = `
    <h1>${esc(c.name)}</h1>
    <div class="chips">
      <span class="chip">科室：<b>${esc(c.dept)}</b></span>
      <span class="chip">患者：<b>${esc(c.patient)}</b></span>
      <span class="chip">性别：<b>${esc(c.gender)}</b></span>
      <span class="chip">年龄：<b>${esc(c.age)}</b></span>
    </div>`;
}

// ---------- tabs ----------
function renderTabs() {
  const s = getCase().sections;
  const totals = {
    history: [countNecHistory(s.history), countTotalHistory(s.history)],
    physical: [countNecPhysical(s.physical), countTotalPhysical(s.physical)],
    aux: [countNecAux(s.aux), countTotalAux(s.aux)],
    diagnosis: [s.diagnosis.length, s.diagnosis.length],
    treatment: [countNecTreatment(s.treatment), countTotalTreatment(s.treatment)]
  };
  document.getElementById('tabs').innerHTML = SECTIONS.map(t => {
    const [cur, max] = totals[t.key];
    return `<button class="tab ${t.key === state.sec ? 'active' : ''}" data-k="${t.key}">${t.label} ${cur}/${max}</button>`;
  }).join('');
  document.querySelectorAll('.tab').forEach(b => {
    b.onclick = () => {
      if (state.sec === b.dataset.k) return;
      state.sec = b.dataset.k;
      state.q = '';
      document.getElementById('search').value = '';
      if (state.sec === 'aux') state.auxExpanded[state.cur] = new Set();  // v49 每次进入辅助强制默认折叠
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.k === state.sec));
      renderSection(); renderReport();
      resetMainScroll();  // P1#3 切板块后重置中间栏滚动位置
    };
  });
}

// ================= 答案模式（三层对照） =================
function renderHistory() {
  const cats = getCase().sections.history;
  let any = false;
  let html = '<div class="section">';
  for (const cat of cats) {
    const catItems = cat.subs.flatMap(sub => sub.items);
    const catNec = catItems.filter(isNec).length;
    const subsHtml = cat.subs.map(sub => {
      const items = sub.items.filter(it => (!state.necOnly || isNec(it)) && matchText(it, state.q, [cat.category, sub.name, it.explain]));
      if (!items.length) return '';
      const subNec = sub.items.filter(isNec).length;
      return `<details class="group ${subNec ? 'has-nec' : ''}" ${state.q || state.necOnly ? 'open' : ''}>
        <summary>${scentMark(subNec)}<span class="sec-h2">${esc(sub.name)}</span><span class="g-count">${items.length} 项 · 必要 ${items.filter(isNec).length}</span></summary>
        <div class="group-body">${items.map(g => histItemHTML(g)).join('')}</div>
      </details>`;
    }).filter(Boolean).join('');
    if (!subsHtml) continue;
    any = true;
    html += `<details class="group ${catNec ? 'has-nec' : ''}" ${state.q || state.necOnly ? 'open' : ''}>
      <summary>${scentMark(catNec)}<span class="sec-h1">${esc(cat.category)}</span><span class="g-count">${catItems.length} 项 · 必要 ${catNec}</span></summary>
      <div class="group-body">${subsHtml}</div>
    </details>`;
  }
  html += '</div>';
  return any ? html : empty();
}
function histItemHTML(g) {
  return `<details class="item ${isNec(g) ? 'nec' : ''}" ${state.q || state.necOnly ? 'open' : ''}>
    <summary><span class="i-q">${esc(g.q)}</span>${isNec(g) ? '<span class="badge-nec">必要</span><span class="badge-score">' + scoreOf(g) + '分</span>' : ''}</summary>
    <div class="i-detail"><div class="kv reply"><span class="k">患者回复</span><span class="v">${esc(g.reply)}</span></div></div>
  </details>`;
}

function renderPhysicalNode(n, path, hidePos) {
  const p2 = path.concat(n.name);
  if (n.items) {
    const useHide = hidePos || n.kind === 'part';
    const items = n.items.filter(it => (!state.necOnly || isNec(it)) && matchText(it, state.q, p2.concat(it.tool, it.position)));
    if (!items.length) return '';
    const nec = n.items.filter(isNec).length;
    return `<details class="group ${nec ? 'has-nec' : ''}" ${state.q ? 'open' : ''}>
      <summary>${scentMark(nec)}${esc(n.name)}${n.kind === 'model' ? '<span class="g-sub">· 3D 人体模型</span>' : ''}<span class="g-count">${items.length} 项 · 必要 ${items.filter(isNec).length}</span></summary>
      <div class="group-body">
        ${items.map(it => `
          <details class="item ${isNec(it) ? 'nec' : ''}" ${state.q ? 'open' : ''}>
            <summary><span class="i-name">${esc(it.name)}</span>${!useHide && it.tool ? `<span class="attr">${esc(it.tool)}</span>` : ''}${!useHide && it.position ? `<span class="attr">${esc(it.position)}</span>` : ''}${isNec(it) ? '<span class="badge-nec">必要</span><span class="badge-score">' + scoreOf(it) + '分</span>' : ''}</summary>
            <div class="i-detail"><div class="kv result"><span class="k">查体结果</span><span class="v">${esc(it.result)}</span></div></div>
          </details>`).join('')}
      </div>
    </details>`;
  }
  if (n.subs) {
    const subs = n.subs.map(s => renderPhysicalNode(s, p2, hidePos)).filter(Boolean).join('');
    if (!subs) return '';
    const nec = n.subs.reduce((a, s) => a + necCountInNode(s), 0);
    return `<details class="group ${nec ? 'has-nec' : ''}" ${state.q ? 'open' : ''}>
      <summary>${scentMark(nec)}${esc(n.name)}<span class="g-count">${n.subs.length} 个子项</span></summary>
      <div class="group-body">${subs}</div>
    </details>`;
  }
  return '';
}
function renderPhysical() {
  const nodes = getCase().sections.physical.map(n => renderPhysicalNode(n, [], false)).filter(Boolean).join('');
  return nodes ? `<div class="section">${nodes}</div>` : empty();
}

function auxTopLevel() {
  // 化验单/报告单是冗余包装层：只保留其子节点作为一级（v34）
  const out = [];
  for (const n of getCase().sections.aux) {
    if (n.name === '化验单' || n.name === '报告单') { if (n.children) out.push(...n.children); }
    else out.push(n);
  }
  return out;
}
function collectAuxLeaves(nodes, path, grp, grpKey, out) {
  // v36 平铺：递归收集叶子，grp=最近父级名（组标题），grpKey=组 key 前缀
  for (const n of nodes) {
    const p2 = path.concat(n.name);
    if (n.children) collectAuxLeaves(n.children, p2, n.name, 'a|' + p2.map(norm).join('|'), out);
    else out.push({ grp, grpKey, item: n, path: p2 });
  }
}
function renderAux() {
  const leaves = [];
  collectAuxLeaves(auxTopLevel(), [], '', '', leaves);
  const filtered = leaves.filter(l => (!state.necOnly || l.item.necessary) && matchText(l.item, state.q, l.path.concat(l.item.abbreviation)));
  if (!filtered.length) return empty();
  let html = '<div class="section aux-flat">';
  let curGrp = null, curGrpKey = null;
  for (const l of filtered) {
    if (l.grp !== curGrp || l.grpKey !== curGrpKey) {
      curGrp = l.grp; curGrpKey = l.grpKey;
      const grpLeaves = filtered.filter(x => x.grpKey === curGrpKey);
      const n = grpLeaves.length;
      const nec = grpLeaves.filter(x => isNec(x.item)).length;  // v40 寻血标记：组内必要项数
      const collapsed = !state.q && !(state.auxExpanded[state.cur] || new Set()).has(curGrpKey);  // v48 默认折叠，搜索时展开
      html += `<div class="aux-sec-head ${collapsed ? 'collapsed' : ''}" data-grp="${esc(curGrpKey)}">${scentMark(nec)}${esc(curGrp)}<span class="aux-sec-count">${n} 项</span></div>`;
    }
    if (!state.q && !(state.auxExpanded[state.cur] || new Set()).has(l.grpKey)) continue;
    const price = l.item.cost ? `<span class="price">￥${l.item.cost}</span>` : '';
    html += `<details class="aux-row ${isNec(l.item) ? 'nec' : ''}" ${state.q ? 'open' : ''}>
      <summary><span class="ar-name">${esc(l.item.name)}${l.item.abbreviation ? ` <span class="attr">${esc(l.item.abbreviation)}</span>` : ''}</span>${price}${isNec(l.item) ? '<span class="badge-nec">必要</span>' : ''}</summary>
      <div class="i-detail">
        <div class="kv result"><span class="k">结果</span><span class="v">${esc(l.item.result)} ${l.item.unit ? esc(l.item.unit) : ''}</span></div>
        ${price ? `<div class="kv price-kv"><span class="k">价格</span><span class="v">${price}</span></div>` : ''}
        ${l.item.ref ? `<div class="ref">参考值：${esc(l.item.ref)}</div>` : ''}
        ${l.item.sig ? `<div class="sig">临床意义：${esc(l.item.sig)}</div>` : ''}
      </div>
    </details>`;
  }
  html += '</div>';
  return html;
}

function renderTreatment() {
  const mode = state.mode;
  const scene = state.txScene[state.cur];
  // 练习模式：未选场景则先展示场景闸门；答案模式：直接展示全部治疗措施（不过滤场景）
  if (mode === 'practice' && !scene) return renderSceneGate();
  const groups = getCase().sections.treatment
    .map(g => ({ ...g, items: g.items.filter(it => {
        const sceneOk = mode === 'answer' || (it.scenes || []).includes(scene);
        return (!state.necOnly || isNec(it)) && sceneOk && matchText(it, state.q, [g.group]);
      }) }))
    .filter(g => g.items.length);
  if (!groups.length) return empty();
  return `<div class="section">${groups.map(g => {
    const nec = g.items.filter(isNec).length;
    return `
    <details class="group ${nec ? 'has-nec' : ''}" open>
      <summary>${scentMark(nec)}${esc(g.group)}<span class="g-count">${g.items.length} 项 · 必要 ${nec}</span></summary>
      <div class="group-body">
        ${g.items.map(it => `
          <details class="item ${isNec(it) ? 'nec' : ''}">
            <summary><span class="i-name">${esc(it.name)}</span>${mode === 'answer' ? (it.scenes && it.scenes.length ? `<span class="attr">${esc(it.scenes.join('/'))}</span>` : (it.attr ? `<span class="attr">${esc(it.attr)}</span>` : '')) : (it.attr ? `<span class="attr">${esc(it.attr)}</span>` : '')}${isNec(it) ? '<span class="badge-nec">必要</span><span class="badge-score">' + scoreOf(it) + '分</span>' : ''}</summary>
            ${it.attr && !isNec(it) ? `<div class="i-detail"><div class="kv attr"><span class="k">属性</span><span class="v">${esc(it.attr)}</span></div></div>` : ''}
          </details>`).join('')}
      </div>
    </details>`;
  }).join('')}</div>`;
}

function renderDiagnosisAnswer() {
  const diags = getCase().sections.diagnosis.filter(d => matchText(d, state.q));
  if (!diags.length) return empty();
  const byCls = {};
  diags.forEach(d => { (byCls[d.cls] = byCls[d.cls] || []).push(d); });
  const clsOrder = ['主要诊断', '次要诊断', '鉴别诊断', '疑似诊断', '未分类'];
  const clss = Object.keys(byCls).sort((a, b) => clsOrder.indexOf(a) - clsOrder.indexOf(b));
  return `<div class="section">${clss.map(cls => {
    const n = byCls[cls].length;
    return `
    <details class="group diag-cls ${n ? 'has-nec' : ''}" open>
      <summary>${scentMark(n)}<span class="cls-tag cls-${esc(cls)}">${esc(cls)}</span><span class="g-count">${n} 个诊断</span></summary>
      <div class="group-body">
        ${byCls[cls].map(d => renderDiagnosisCard(d, true)).join('')}
      </div>
    </details>`;
  }).join('')}</div>`;
}

function renderDiagnosisCard(d, isAnswer) {
  const sources = Object.keys(d.bySrc || {}).sort();
  return `<details class="diag" ${state.q ? 'open' : ''}>
    <summary><span class="d-name">${esc(d.name)}</span>${d.synonyms ? `<span class="d-syn">${esc(d.synonyms)}</span>` : ''}${isAnswer ? `<span class="badge-score">${scoreOf(d)}分</span>` : ''}</summary>
    <div class="i-detail">
      ${isAnswer && d.evidence && d.evidence.length ? `<div class="ev-tree">${renderEvidenceFromReport(d)}</div>` : ''}
      ${sources.length ? `<div class="ev-tree">${sources.map(src => renderEvSrc(d, src, isAnswer)).join('')}</div>` : '<div class="empty">暂无证据树</div>'}
    </div>
  </details>`;
}
function renderEvidenceFromReport(d) {
  const bySrc = {};
  d.evidence.forEach(e => { (bySrc[e.src] = bySrc[e.src] || []).push(e); });
  return Object.keys(bySrc).map(src => `
    <details class="ev-src" open>
      <summary>${esc(src)}<span class="ev-cnt">${bySrc[src].length} 条依据</span></summary>
      <div class="ev-list">
        ${bySrc[src].map(e => `<div class="ev"><span class="ev-item">${esc(e.item)}${e.sub && e.sub !== e.item ? ' · ' + esc(e.sub) : ''}：</span><span class="ev-content">${esc(e.content)}</span><span class="ev-score">${scoreOf(e)}分</span></div>`).join('')}
      </div>
    </details>`).join('');
}
function renderEvSrc(d, src, isAnswer) {
  const nodes = d.bySrc[src];
  return `<details class="ev-src" open>
    <summary>${esc(src)}<span class="ev-cnt">${nodes.length} 条</span></summary>
    <div class="ev-list">
      ${nodes.map(u => {
        const key = norm(u.text);
        let labels = '';
        if (isAnswer) {
          labels = u.support
            ? `<span class="ev-label green active">支持</span>`
            : `<span class="ev-label red active">不支持</span>`;
        } else {
          const marks = getDiagMarks(d.name);
          const sup = marks.support.has(key);
          const uns = marks.unsupport.has(key);
          labels = `<button class="ev-label green ${sup ? 'active' : ''}" data-d="${esc(d.name)}" data-k="${esc(key)}" data-v="support">支持</button>` +
                   `<button class="ev-label red ${uns ? 'active' : ''}" data-d="${esc(d.name)}" data-k="${esc(key)}" data-v="unsupport">不支持</button>`;
        }
        return `<div class="ev"><div class="ev-text"><span class="ev-item">${esc(u.sub ? u.sub + ' · ' + u.item : u.item)}</span><span class="ev-content">${esc(u.content)}</span></div>${labels}</div>`;
      }).join('')}
    </div>
  </details>`;
}
function getDiagMarks(dname) {
  state.diagMarks[state.cur] = state.diagMarks[state.cur] || {};
  if (!state.diagMarks[state.cur][dname]) state.diagMarks[state.cur][dname] = { support: new Set(), unsupport: new Set() };
  return state.diagMarks[state.cur][dname];
}
function getDiagClass(dname) {
  state.diagClass[state.cur] = state.diagClass[state.cur] || {};
  if (!state.diagClass[state.cur][dname]) state.diagClass[state.cur][dname] = '主要诊断';
  return state.diagClass[state.cur][dname];
}

// ================= 练习模式（点选交互） =================
function pCard(sec, item, path, hidePos) {
  const key = keyOf(sec, item, path);
  const picked = isPicked(sec, key);
  const pend = (sec === 'aux' && !picked && auxPendingSet().has(key));
  let layer2 = '';
  if (picked) {
    if (sec === 'history') layer2 = `<div class="p-reply">${esc(item.reply)}</div>`;
    else if (sec === 'physical') layer2 = `<div class="p-reply">${esc(item.result)}</div>`;
    else if (sec === 'aux') layer2 = `<div class="p-reply">${esc(item.result)}${item.ref ? `<div class="ref">参考值：${esc(item.ref)}</div>` : ''}${item.sig ? `<div class="sig">临床意义：${esc(item.sig)}</div>` : ''}</div>`;
    else if (sec === 'treatment') layer2 = `<div class="p-reply">${item.attr ? esc(item.attr) : '（治疗措施）'}</div>`;
  }
  const badge = picked ? '<span class="b-picked">✓ 已采集</span>' : '';
  const price = (sec === 'aux' && item.cost) ? `<span class="price">¥${item.cost}</span>` : '';
  const l1 = sec === 'history' ? item.q : item.name;
  const extras = (sec === 'physical' && !hidePos) ? `${item.tool ? `<span class="attr">${esc(item.tool)}</span>` : ''}${item.position ? `<span class="attr">${esc(item.position)}</span>` : ''}` : (sec === 'treatment' && item.attr ? `<span class="attr">${esc(item.attr)}</span>` : '');
  return `<button class="pcard ${picked ? 'picked' : ''}${pend ? ' pend' : ''}" data-sec="${sec}" data-key="${esc(key)}">
    <span class="p-name">${pend ? '<span class="pend-ic"></span>' : ''}${esc(l1)}</span>
    ${extras}
    ${price}
    ${badge}
    ${layer2}
  </button>`;
}

function auxPendingSet() {
  state.auxPending[state.cur] = state.auxPending[state.cur] || new Set();
  return state.auxPending[state.cur];
}
function pGrp(head, bodyHtml, open, key) {
  return `<details class="pgroup" data-grp="${esc(key || '')}" ${open ? 'open' : ''}><summary class="pgroup-head">${head}</summary><div class="pgroup-body">${bodyHtml}</div></details>`;
}

function renderPracticeHistory() {
  const cats = getCase().sections.history;
  let any = false;
  let html = '<div class="section psec">';
  for (const cat of cats) {
    // 参考答案模式：按一级分类直接铺开（消掉冗余二级头）
    const allItems = cat.subs.flatMap(sub => sub.items);
    const items = allItems.filter(it => (!state.necOnly || it.necessary) && matchText(it, state.q, [cat.category, it.explain]));
    if (!items.length) continue;
    any = true;
    const head = `${esc(cat.category)}<span class="g-count">${items.length} 项</span>`;
    const body = items.map(it => pCard('history', it, [cat.category])).join('');
    html += pGrp(head, body, !!state.q, 'hist|' + cat.category);
  }
  html += '</div>';
  return any ? html : empty();
}

function renderPracticePhysicalNode(n, path, hidePos) {
  const p2 = path.concat(n.name);
  const open = !!state.q;
  if (n.items) {
    const useHide = hidePos || n.kind === 'part';
    const items = n.items.filter(it => (!state.necOnly || it.necessary) && matchText(it, state.q, p2.concat(it.tool, it.position)));
    if (!items.length) return '';
    const head = `${esc(n.name)}${n.kind === 'model' ? '<span class="g-sub">· 3D 人体模型</span>' : ''}<span class="g-count">${items.length} 项</span>`;
    const body = items.map(it => pCard('physical', it, p2, useHide)).join('');
    return pGrp(head, body, open, 'phy|' + p2.join('▸'));
  }
  if (n.subs) {
    const subs = n.subs.map(s => renderPracticePhysicalNode(s, p2, hidePos)).filter(Boolean).join('');
    if (!subs) return '';
    const head = `${esc(n.name)}<span class="g-count">${n.subs.length} 个子项</span>`;
    return pGrp(head, `<div class="pindent">${subs}</div>`, open, 'phy|' + p2.join('▸'));
  }
  return '';
}
function renderPracticePhysical() {
  const nodes = getCase().sections.physical.map(n => renderPracticePhysicalNode(n, [], false)).filter(Boolean).join('');
  return nodes ? `<div class="section psec">${nodes}</div>` : empty();
}

function renderPracticeAux() {
  const leaves = [];
  collectAuxLeaves(auxTopLevel(), [], '', '', leaves);
  const filtered = leaves.filter(l => (!state.necOnly || l.item.necessary) && matchText(l.item, state.q, l.path.concat(l.item.abbreviation)));
  if (!filtered.length) return empty();
  const pend = auxPendingSet();
  let html = '<div class="section psec aux-flat">';
  let curGrp = null, curGrpKey = null;
  for (const l of filtered) {
    if (l.grp !== curGrp || l.grpKey !== curGrpKey) {
      curGrp = l.grp; curGrpKey = l.grpKey;
      const n = filtered.filter(x => x.grpKey === curGrpKey).length;
      const grpPend = filtered.filter(x => x.grpKey === curGrpKey && pend.has(keyOf('aux', x.item, x.path))).length;
      const grpAvail = filtered.filter(x => x.grpKey === curGrpKey && !isPicked('aux', keyOf('aux', x.item, x.path))).length;
      // v45 全选 toggle：组内全部未采集项都已待检测 → 显示「取消全选」；否则「全选」
      const grpAllPend = grpAvail > 0 && grpAvail === filtered.filter(x => x.grpKey === curGrpKey && !isPicked('aux', keyOf('aux', x.item, x.path)) && pend.has(keyOf('aux', x.item, x.path))).length;
      const selBtn = grpAvail > 0 ? `<button class="aux-sel ${grpAllPend ? 'all' : ''}" data-grp="${esc(curGrpKey)}">${grpAllPend ? '取消全选' : '全选'}</button>` : '';
      const runBtn = grpPend > 0 ? `<button class="aux-run" data-grp="${esc(curGrpKey)}">检测 ${grpPend} 项</button>` : '';
      const collapsed = !state.q && !(state.auxExpanded[state.cur] || new Set()).has(curGrpKey);  // v48 默认折叠，搜索时展开
      html += `<div class="aux-sec-head ${collapsed ? 'collapsed' : ''}" data-grp="${esc(curGrpKey)}">${esc(curGrp)}<span class="aux-sec-count">${n} 项</span>${selBtn}${runBtn}</div>`;
    }
    if (!state.q && !(state.auxExpanded[state.cur] || new Set()).has(l.grpKey)) continue;
    const key = keyOf('aux', l.item, l.path);
    const picked = isPicked('aux', key);
    const isPend = pend.has(key);
    html += `<button class="aux-row ${picked ? 'picked' : ''} ${isPend ? 'pend' : ''}" data-sec="aux" data-key="${esc(key)}">
      <span class="ar-name">${isPend ? '<span class="pend-ic"></span>' : ''}${esc(l.item.name)}${l.item.abbreviation ? ` <span class="attr">${esc(l.item.abbreviation)}</span>` : ''}</span>
      ${l.item.cost ? `<span class="price">￥${l.item.cost}</span>` : ''}
      ${picked ? '<span class="b-picked">✓ 已采集</span>' : ''}
    </button>`;
  }
  html += '</div>';
  return html;
}

function renderSceneGate() {
  return `<div class="section psec">
    <div class="scene-gate">
      <div class="scene-gate-title">请先选择治疗场景</div>
      <div class="scene-btns">
        ${TX_SCENES.map(s => `<button class="scene-btn" data-scene="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="scene-hint">选择场景后，下方按该场景展示对应的治疗措施分类。</div>
    </div>
  </div>`;
}

function renderPracticeTreatment() {
  const scene = state.txScene[state.cur];
  if (!scene) return renderSceneGate();
  const groups = getCase().sections.treatment
    .map(g => ({ ...g, items: g.items.filter(it => (!state.necOnly || it.necessary) && (it.scenes || []).includes(scene) && matchText(it, state.q, [g.group])) }))
    .filter(g => g.items.length);
  if (!groups.length) return empty();
  const open = !!state.q;
  return `<div class="section psec">
    <div class="scene-active">当前场景：<b>${esc(scene)}</b> <button class="scene-change" data-scene="__reset__">切换场景</button></div>
    ${groups.map(g => pGrp(`${esc(g.group)}<span class="g-count">${g.items.length} 项</span>`,
      g.items.map(it => pCard('treatment', it, [g.group])).join(''), open, 'tx|' + g.group)).join('')}
  </div>`;
}

// 诊断模块：练习模式
function renderPracticeDiagnosis() {
  const c = getCase();
  const diags = c.sections.diagnosis;
  state.diagMarks[state.cur] = state.diagMarks[state.cur] || {};

  const selectedNames = Object.keys(state.diagMarks[state.cur]);
  const active = state.activeDiag[state.cur] || selectedNames[0] || '';

  let html = `<div class="section psec diag-practice">
    <div class="diag-search-box">
      <input id="diagSearch" class="search wide" type="search" placeholder="搜索诊断库并添加诊断…" autocomplete="off" value="${esc(state.diagQ)}" />
      <div id="diagSuggestions" class="diag-suggestions"></div>
    </div>`;

  if (selectedNames.length) {
    html += `<div class="diag-selected-head">已选诊断 (${selectedNames.length})</div>`;
    html += selectedNames.map(n => {
      const d = diags.find(x => x.name === n);
      const cls = getDiagClass(n);
      const isActive = n === active;
      const clsBtns = DIAG_CLS.map(c => `<button class="cls-btn ${cls === c ? 'active' : ''}" data-d="${esc(n)}" data-cls="${esc(c)}">${esc(c)}</button>`).join('');
      // 一级标题（疾病名）只在此处出现一次；其下直接铺开证据树（源=二级、条目=三级），不再重复包裹疾病名
      const evHtml = d && d.bySrc && Object.keys(d.bySrc).length
        ? `<div class="diag-evtree">${Object.keys(d.bySrc).sort().map(src => renderEvSrc(d, src, false)).join('')}</div>`
        : (d ? `<div class="empty">本病例未提供该诊断的证据树；可从右侧「系统总结」对照。</div>` : renderPlaceholderDiag(n));
      const preview = renderDiagPreview(n);
      return `<div class="diag-selected ${isActive ? 'active' : ''}" data-d="${esc(n)}">
        <div class="diag-selected-bar">
          <span class="diag-selected-name">${esc(n)}</span>
          <div class="cls-btns">${clsBtns}</div>
        </div>
        ${preview}
        ${evHtml}
      </div>`;
    }).join('');
  } else {
    html += `<div class="empty">在上方搜索框输入诊断名，点击添加后可在本病例做支持/不支持标记，并选择「主要/次要/鉴别/疑似」分类。</div>`;
  }
  html += '</div>';
  return html;
}

function renderPlaceholderDiag(name) {
  return `<div class="empty">本病例未提供该诊断的证据树；可从右侧「系统总结」对照。</div>`;
}

function renderDiagSuggestions() {
  const el = document.getElementById('diagSuggestions');
  if (!el) return;
  const q = (state.diagQ || '').trim().toLowerCase();
  if (!q) { el.innerHTML = ''; return; }
  const hits = [];
  for (const d of state.diaglib) {
    if (d.name.toLowerCase().includes(q) || (d.code && d.code.toLowerCase().includes(q))) {
      hits.push(d);
      if (hits.length >= 50) break;
    }
  }
  if (!hits.length) { el.innerHTML = '<div class="empty">无匹配诊断</div>'; return; }
  el.innerHTML = hits.map(d => {
    const name = hl(d.name, q), code = hl(d.code || '—', q);
    return `<button class="diag-sug" data-name="${esc(d.name)}"><span class="lc">${code}</span><span class="ln">${name}</span></button>`;
  }).join('');
  el.querySelectorAll('.diag-sug').forEach(b => {
    b.onclick = () => {
      const name = b.dataset.name;
      state.diagMarks[state.cur] = state.diagMarks[state.cur] || {};
      if (!state.diagMarks[state.cur][name]) state.diagMarks[state.cur][name] = { support: new Set(), unsupport: new Set() };
      state.activeDiag[state.cur] = name;
      state.diagQ = '';
      document.getElementById('diagSearch').value = '';
      renderSection(); renderReport();
      saveState();  // F4 添加诊断即落盘
    };
  });
}

function hl(text, q) {
  const e = esc(text);
  if (!q) return e;
  const idx = e.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return e;
  return e.slice(0, idx) + '<mark>' + e.slice(idx, idx + q.length) + '</mark>' + e.slice(idx + q.length);
}

function restoreOpenGroups(el, keys) {
  if (!keys || !keys.length) return;
  el.querySelectorAll('details.pgroup').forEach(d => { if (keys.includes(d.dataset.grp)) d.open = true; });
}
function renderSection() {
  const sec = state.sec;
  const mode = state.mode;
  const el = document.getElementById('section');
  // 捕获当前展开的分组，重渲染后恢复（避免点选项时二级目录被自动折叠）
  const openKeys = [...el.querySelectorAll('details.pgroup[open]')].map(d => d.dataset.grp).filter(Boolean);
  if (sec === 'history') {
    const body = mode === 'practice' ? renderPracticeHistory() : renderHistory();
    el.innerHTML = renderLimitBar('history') + body;
  } else if (sec === 'physical') {
    const body = mode === 'practice' ? renderPracticePhysical() : renderPhysical();
    el.innerHTML = renderLimitBar('physical') + body;
  } else if (sec === 'aux') {
    const body = mode === 'practice' ? renderPracticeAux() : renderAux();
    el.innerHTML = renderLimitBar('aux') + body;
  } else if (sec === 'treatment') {
    const body = mode === 'practice' ? renderPracticeTreatment() : renderTreatment();
    el.innerHTML = renderLimitBar('treatment') + body;
  } else if (sec === 'diagnosis') {
    el.innerHTML = mode === 'practice' ? renderPracticeDiagnosis() : renderDiagnosisAnswer();
    if (mode === 'practice') { renderDiagSuggestions(); bindDiagLabels(); }
    restoreOpenGroups(el, openKeys);
    return;
  }
  restoreOpenGroups(el, openKeys);
}
// ---------- 限制进度条（病史/体格/辅助/治疗：项目数 + 辅助花费）----------
// 官网真实语义：standard=标准线(绿) / reasonable=合理线(橙，超标准但不扣分) / >reasonable 起扣分(红)
// max = 硬上限，也是进度条满格基准（reasonable = standard×1.5，max = standard×2）
function limitStats(sec) {
  const picked = (state.picked[state.cur] && state.picked[state.cur][sec]) || new Set();
  if (sec === 'aux') {
    // v44 口径修正：进度条「检查次数」= 检测动作次数（批量检测一次计 1），花费仍按项目 cost 累计
    let cost = 0;
    const walk = (n, path) => {
      const p2 = path.concat(n.name);
      if (n.children) n.children.forEach(c => walk(c, p2));
      else if (isPicked('aux', keyOf('aux', n, p2))) cost += (n.cost || 0);
    };
    auxTopLevel().forEach(n => walk(n, []));
    return { count: state.auxCheckCount[state.cur] || 0, cost };
  }
  return { count: picked.size };
}
function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); }
function limitBarHTML(label, val, lim, isCost, unit) {
  if (!lim) return '';
  const std = lim.standard, rea = lim.reasonable, max = lim.max;
  if (std == null || max == null || !max) return '';
  const reaV = (rea == null) ? max : rea;
  const pct = Math.min(100, (val / max) * 100);
  const color = val <= std ? 'green' : (val <= reaV ? 'orange' : 'red');
  const u = isCost ? '' : (unit || ' 项');
  const remain = Math.max(0, Math.ceil(std - val));
  const note = color === 'green'
    ? (remain > 0 ? `还差 ${fmtNum(remain)}${u} 到标准线 ${fmtNum(std)}（绿色达标区）` : `已达标；超过 ${fmtNum(reaV)}${u} 开始扣分`)
    : (color === 'orange'
      ? `已超标准线；≤ ${fmtNum(reaV)}${u} 仍不扣分`
      : `已超过扣分线 ${fmtNum(reaV)}${u}，将扣分`);
  const stdPct = Math.min(100, (std / max) * 100);
  const reaPct = Math.min(100, (reaV / max) * 100);
  return `<div class="limit-bar ${color}">
    <div class="limit-head"><span class="limit-label">${esc(label)}</span><span class="limit-val">${fmtNum(val)}${u} · 标准 ${fmtNum(std)} / 扣分线 ${fmtNum(reaV)} / 上限 ${fmtNum(max)}</span></div>
    <div class="limit-track">
      <div class="limit-zone zone-g" style="left:0;width:${stdPct}%"></div>
      <div class="limit-zone zone-o" style="left:${stdPct}%;width:${Math.max(0, reaPct - stdPct)}%"></div>
      <div class="limit-zone zone-r" style="left:${reaPct}%;width:${Math.max(0, 100 - reaPct)}%"></div>
      <div class="limit-fill" style="width:${pct}%"></div>
      <div class="limit-marker" style="left:${stdPct}%"></div>
      <div class="limit-marker mk-r" style="left:${reaPct}%"></div>
    </div>
    <div class="limit-note">${note}</div>
  </div>`;
}
function renderLimitBar(sec) {
  const L = getCase().limits;
  if (!L) return '';
  const LB = { history: '病史采集 · 提问数', physical: '体格检查 · 检查项目数', aux: '辅助检查 · 检查次数', treatment: '治疗 · 措施数' };
  if (sec === 'aux' && L.aux) {
    const s = limitStats('aux');
    return `<div class="limit-wrap">${limitBarHTML(LB.aux, s.count, L.aux, false, ' 次')}${limitBarHTML('辅助检查 · 花费', s.cost, { standard: L.aux.costStandard, reasonable: L.aux.costReasonable, max: L.aux.costMax }, true)}</div>`;
  }
  if (L[sec] && LB[sec]) {
    const s = limitStats(sec);
    return `<div class="limit-wrap">${limitBarHTML(LB[sec], s.count, L[sec])}</div>`;
  }
  return '';
}
function resetMainScroll() {
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}
function restoreDrawerFocus() {
  // F6 侧栏重建后焦点若落在 body（旧按钮已移除），归还到当前病例卡
  if (isMobileLayout() || !state.sbOpen) return;
  if (document.activeElement === document.body) {
    const fc = document.querySelector('#caseList .case-card.active') || document.querySelector('#caseList .case-card');
    if (fc) fc.focus({ preventScroll: true });
  }
}
function renderCase() {
  document.getElementById('caseView').hidden = false;
  renderSidebar(); renderHead(); renderTabs(); renderSection(); renderReport();
  renderRpHint();
  resetMainScroll();  // P1#3 切病例后重置中间栏滚动位置
}

// ================= 右侧报告面板 =================
function panelTitle(sec) {
  const map = { history: '检查记录', physical: '检查记录', aux: '检查结果', diagnosis: '依据列表', treatment: '治疗原则' };
  return map[sec] || '报告';
}

// ---------- 移动端：右栏 -> 底部抽屉 ----------
function isMobileLayout() {
  return window.matchMedia('(max-width: 860px)').matches;
}
function rpIsOpen() {
  return document.body.classList.contains('rp-open');
}
function syncRpBtn() {
  const btn = document.getElementById('rpToggle');
  if (!btn) return;
  if (rpIsOpen()) { btn.textContent = '✕ 收起'; return; }
  // 练习模式且本题尚未提交：悬浮球文案提示「可在此提交」
  if (state.mode === 'practice' && !state.scores[state.cur]) {
    btn.textContent = '📋 报告 · 提交';
  } else {
    btn.textContent = '📋 ' + panelTitle(state.sec);
  }
}
// 移动端提示条：仅在手机 + 练习模式 + 本案未提交 + 未手动关闭时显示
function renderRpHint() {
  const el = document.getElementById('rpHint');
  if (!el) return;
  const show = isMobileLayout() && state.mode === 'practice' && !state.scores[state.cur] && !state.hintDismissed;
  el.classList.toggle('show', show);
  el.hidden = !show;
  const ball = document.getElementById('rpToggle');
  if (ball) ball.classList.toggle('pulse', show);
}
// ================= v50 桌面左侧病例抽屉 =================
function sbIsOpen() { return !!state.sbOpen; }
function setSbMasked(masked) {
  document.body.classList.toggle('sb-masking', !!masked);
  // P2#4 焦点陷阱：仅当遮罩（overlay 全屏遮挡）升起时，才屏蔽主内容交互与 Tab 穿透
  const main = document.querySelector('.main'), rep = document.querySelector('.report-col');
  if (main) main.inert = !!masked;
  if (rep) rep.inert = !!masked;
}
function setSbOpen(open, focus) {
  state.sbOpen = !!open;
  document.body.classList.toggle('sb-open', state.sbOpen);
  document.body.classList.toggle('sb-collapsed', !state.sbOpen);
  const t = document.getElementById('sbToggle');
  if (t) t.setAttribute('aria-expanded', String(state.sbOpen));
  if (focus === false) return;  // F7 启动初始化不劫持焦点
  // v50.1 打开时焦点移入抽屉（最小可达性）；收起时焦点还给汉堡
  if (open && !isMobileLayout()) {
    const fc = document.querySelector('#caseList .case-card');
    if (fc) fc.focus(); else if (t) t.focus();
  } else if (!open && t) t.focus();
}
function bindDesktopDrawer() {
  const t = document.getElementById('sbToggle');
  const m = document.getElementById('sbMask');
  if (t) t.onclick = () => {
    // 从收起态打开时显示遮罩（默认展开/点击遮罩关闭后不显示遮罩）
    if (sbIsOpen()) { setSbOpen(false); setSbMasked(false); }
    else { setSbOpen(true); setSbMasked(true); }
  };
  if (m) m.onclick = () => { setSbOpen(false); setSbMasked(false); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sbIsOpen() && !isMobileLayout() && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { setSbOpen(false); setSbMasked(false); } });
  window.addEventListener('resize', () => { if (isMobileLayout() && sbIsOpen()) { setSbOpen(false); setSbMasked(false); } });
}
function setRpOpen(open) {
  document.body.classList.toggle('rp-open', !!open);
  const col = document.querySelector('.report-col');
  if (col && open) col.scrollTop = 0;
  syncRpBtn();
}
function bindMobileDrawer() {
  const btn = document.getElementById('rpToggle');
  const mask = document.getElementById('rpMask');
  const col = document.querySelector('.report-col');
  if (btn) btn.onclick = () => setRpOpen(!rpIsOpen());
  if (mask) mask.onclick = () => setRpOpen(false);
  // 点击抽屉顶部 grab handle（伪元素）关闭
  if (col) col.onclick = e => { if (e.target === col) setRpOpen(false); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && rpIsOpen()) setRpOpen(false); });
  window.addEventListener('resize', () => { if (!isMobileLayout() && rpIsOpen()) setRpOpen(false); renderRpHint(); });
  const hintX = document.getElementById('rpHintX');
  if (hintX) hintX.onclick = () => { state.hintDismissed = true; saveState(); renderRpHint(); };
  syncRpBtn();
}
function reportBlock(sec) {
  const rep = getCase().reports || {};
  if (sec === 'treatment') {
    let h = '';
    if (rep.txPrinciples) h += `<div class="rp-sub">治疗原则</div><pre class="rp-pre">${esc(rep.txPrinciples)}</pre>`;
    if (rep.txPlan) h += `<div class="rp-sub">治疗计划</div><pre class="rp-pre">${esc(rep.txPlan)}</pre>`;
    return h || '<div class="empty">（暂无系统报告）</div>';
  }
  const t = rep[sec];
  return t ? `<pre class="rp-pre">${esc(t)}</pre>` : '<div class="empty">（暂无系统报告）</div>';
}
function extractCheckRecord(fullText) {
  if (!fullText) return null;
  const idx = fullText.indexOf('检查记录\n');
  if (idx < 0) return null;
  const section = fullText.slice(idx);
  const endIdx = section.indexOf('\n---\n', 1);
  return endIdx > 0 ? section.slice(0, endIdx) : section;
}
// 病史采集「检查记录」：采用「重放模型」。
// 点选的必要项 -> 映射回增量爬取序列的 step 序号 -> 仅按爬取顺序重放【被点中的步骤】的 ops。
// ops 由 build_history_records.js 产出（add / ext / del）：
//   ext 是"字段就地延长"，真实增量只是后缀 suf；重放时后缀只挂到【已点中的基行】上，
//   若基行未被点中则只显示后缀(去前导标点)，绝不把未点中的基内容带出 -> 彻底消除"意外的多余增量"。
// 输出只可能包含被点步骤贡献的内容，绝不混入未点步骤。
const _CR_SEP = ['，', '、', '；', '：', ':', ' '];
const _hrMapCache = {};
function _hrQMap(arr) {
  let m = _hrMapCache[state.cur];
  if (!m) { m = {}; arr.forEach((s, i) => { m[norm(s.q)] = i; }); _hrMapCache[state.cur] = m; }
  return m;
}
function _hrCleanSuf(s) { return (s || '').replace(/^[,，、；;:： ]+/, ''); }
// 重放 ops 到 working（与 build_history_records.js 的 replayOps 完全一致）
function _hrReplayOps(working, ops) {
  for (const op of (ops || [])) {
    if (op.t === 'add') {
      let replaced = false;
      for (let k = 0; k < working.length; k++) {
        const X = working[k];
        if (!_CR_SECTIONS.has(X) && op.line.startsWith(X) && op.line.length > X.length) {
          const s = op.line.slice(X.length);
          if (_CR_SEP.some(x => s.startsWith(x))) { working[k] = op.line; replaced = true; break; }
        }
      }
      if (replaced) continue;
      if (op.after != null) { const a = working.indexOf(op.after); if (a >= 0) { working.splice(a + 1, 0, op.line); continue; } }
      working.push(op.line);
    } else if (op.t === 'ext') {
      const full = op.base + op.suf;
      let hit = -1, mode = 'full';
      // 1) 整基行命中：working 中已有 op.base 整行，或已有"op.base 的前缀段"
      for (let k = 0; k < working.length; k++) {
        const X = working[k];
        if (X === op.base || (!_CR_SECTIONS.has(X) && op.base.startsWith(X) && op.base.length > X.length && _CR_SEP.some(s => op.base.slice(X.length).startsWith(s)))) { hit = k; mode = 'full'; break; }
      }
      // 2) 尾段命中：op.base 的"最后一段(末分隔符之后)"恰好是 working 中某行 X -> 把 suf 续到 X 之后（跳过未点中间步骤也能合并，且不泄露）
      if (hit < 0) {
        for (let k = 0; k < working.length; k++) {
          const X = working[k];
          if (_CR_SECTIONS.has(X) || X.length < 2) continue;
          const i = op.base.lastIndexOf(X);
          if (i > 0 && i + X.length === op.base.length && _CR_SEP.includes(op.base[i - 1])) { hit = k; mode = 'tail'; break; }
        }
      }
      if (hit >= 0) { working[hit] = mode === 'full' ? full : working[hit] + op.suf; }
      else {
        const cs = _hrCleanSuf(op.suf);
        if (op.after != null) { const a = working.indexOf(op.after); if (a >= 0) { working.splice(a + 1, 0, cs); continue; } }
        working.push(cs); // 基行未点中：只显示新增后缀，绝不泄露基内容
      }
    } else if (op.t === 'del') {
      const k = working.indexOf(op.line);
      if (k >= 0) working.splice(k, 1);
    }
  }
  return working;
}
function historyRecordText() {
  const arr = (state.histRec && state.histRec[state.cur]) || [];
  if (!arr.length) return null;
  const map = _hrQMap(arr);
  const items = collectPicked('history').filter(p => p.nec);
  if (!items.length) return null;
  const idxs = [...new Set(items.map(p => map[norm(p.l1)]).filter(i => i != null))].sort((a, b) => a - b);
  if (!idxs.length) return null;
  const working = [];
  for (const idx of idxs) _hrReplayOps(working, arr[idx].ops);
  const out = working.join('\n');
  return out || null;
}

// 答案模式用：重放【全部】步骤的 ops，得到系统生成的「完整检查记录」（不依赖点选）。
function historyRecordFullText() {
  const arr = (state.histRec && state.histRec[state.cur]) || [];
  if (!arr.length) return null;
  const working = [];
  for (const step of arr) _hrReplayOps(working, step.ops);
  const out = working.join('\n');
  return out || null;
}

const _CR_SECTIONS = new Set(['基本常识', '现病史', '既往史', '个人史', '家族史', '月经婚育史', '妇产科问题', '小儿问题', '目前一般状况']);
// 将系统「检查记录」文本渲染为带层级的小结（section / sub / key:value / value）
function formatCheckRecord(rec) {
  const body = (rec || '').replace(/^检查记录\s*\n/, '');
  return body.trim().split('\n').map(ln => {
    const t = ln.trim();
    if (_CR_SECTIONS.has(t)) return `<div class="cr-sec">${esc(t)}</div>`;
    if (ln.includes('：')) { const i = ln.indexOf('：'); return `<div class="cr-kv"><span class="cr-k">${esc(ln.slice(0, i))}</span>${esc(ln.slice(i + 1))}</div>`; }
    if (t.length <= 10 && !/[？?。.！!，,、]/.test(t)) return `<div class="cr-sub">${esc(t)}</div>`;
    return `<div class="cr-val">${esc(ln)}</div>`;
  }).join('');
}

// ================= 评分（百分制，权重：病史10% · 体格10% · 辅助70% · 诊断10% · 治疗0%）=================
function moduleRate(sec) {
  const c = getCase();
  let necTotal = 0, pickedScore = 0;
  const add = (item, path, sc) => {
    const k = keyOf(sec, item, path);
    necTotal += sc;
    if (isPicked(sec, k) && item.necessary) pickedScore += sc;
  };
  if (sec === 'history') c.sections.history.forEach(cat => cat.subs.forEach(sub => sub.items.forEach(it => add(it, [cat.category], it.score || 0))));
  else if (sec === 'physical') {
    const w = (n, path) => { const p2 = path.concat(n.name); if (n.items) n.items.forEach(it => add(it, p2, it.score || 0)); else if (n.subs) n.subs.forEach(s => w(s, p2)); };
    c.sections.physical.forEach(n => w(n, []));
  } else if (sec === 'aux') {
    const w = (n, path) => { const p2 = path.concat(n.name); if (n.children) n.children.forEach(c2 => w(c2, p2)); else add(n, p2, n.score || 0); };
    auxTopLevel().forEach(n => w(n, []));
  } else if (sec === 'treatment') c.sections.treatment.forEach(g => g.items.forEach(it => add(it, [g.group], it.score || 0)));
  return necTotal ? pickedScore / necTotal : 1;
}
function diagnosisRate() {
  const c = getCase();
  const answers = c.sections.diagnosis;
  if (!answers.length) return 1;
  const clsMap = state.diagClass[state.cur] || {};
  const userNames = Object.keys(clsMap);
  const matchAnswer = (a) => userNames.find(un => {
    const unN = norm(un);
    if (unN === norm(a.name)) return true;
    const syn = (a.synonyms || '').split(/[，,、]/).map(x => norm(x));
    return syn.includes(unN);
  });
  const totalScore = answers.reduce((s, a) => s + (a.score || 1), 0);
  const hitScore = answers.reduce((s, a) => {
    const un = matchAnswer(a);
    if (!un) return s;
    return norm(clsMap[un]) === norm(a.cls) ? s + (a.score || 1) : s;
  }, 0);
  return totalScore ? hitScore / totalScore : 1;
}
function computeScore() {
  const breakdown = [
    { key: 'history', label: '病史', weight: '10%', rate: moduleRate('history') },
    { key: 'physical', label: '体格', weight: '10%', rate: moduleRate('physical') },
    { key: 'aux', label: '辅助', weight: '70%', rate: moduleRate('aux') },
    { key: 'diagnosis', label: '诊断', weight: '10%', rate: diagnosisRate() },
    { key: 'treatment', label: '治疗', weight: '0%', rate: moduleRate('treatment') },
  ];
  const total = breakdown.reduce((s, b) => s + b.rate * parseFloat(b.weight) / 100, 0) * 100;
  return { total, breakdown };
}

// ================= 提交区 + 评分卡 =================
function renderSubmitArea() {
  const cur = state.cur;
  const sc = state.scores && state.scores[cur];
  if (sc) {
    const rows = sc.breakdown.map(b => {
      const pct = Math.round(b.rate * 100);
      return `<div class="sb-row">
        <span class="sb-name">${esc(b.label)} <i>${esc(b.weight)}</i></span>
        <span class="sb-val">${pct}%</span>
        <span class="sb-bar"><span class="sb-fill" style="width:${pct}%"></span></span>
      </div>`;
    }).join('');
    return `<div class="submit-area submitted">
      <div class="score-card">
        <div class="score-head">本病例评分</div>
        <div class="score-total">${sc.total.toFixed(1)}<span class="score-unit">分 / 100</span></div>
        <div class="score-weights">权重：病史10% · 体格10% · 辅助70% · 诊断10% · 治疗0%</div>
        <div class="score-break">${rows}</div>
      </div>
      <button class="btn-reset-practice" data-reset="${cur}">重新练习本病例</button>
    </div>`;
  }
  return `<div class="submit-area">
    <button class="btn-submit" id="btnSubmit" data-cur="${cur}">提交本病例答卷</button>
    <div class="submit-hint">提交后按权重生成百分制评分（答题进度已本地保存，刷新不丢）</div>
  </div>`;
}

function renderReport() {
  const el = document.getElementById('reportPanel');
  let html = '';
  if (state.mode === 'practice') html += renderSubmitArea();
  html += renderReportInner();
  el.innerHTML = html;
  syncRpBtn();
}
function renderReportInner() {
  const sec = state.sec;
  if (sec === 'diagnosis') {
    if (state.mode === 'practice') return renderDiagEvidencePanel();
    return `<div class="rp-title">依据列表</div>${reportBlock('diagnosis')}`;
  }
  if (state.mode === 'answer') {
    const title = panelTitle(sec);
    let body;
    if (sec === 'history') {
      const full = historyRecordFullText();
      body = full
        ? `<div class="rp-records-label">系统检查记录（完整版）</div><div class="rp-checkrecord">${formatCheckRecord(full)}</div>`
        : reportBlock('history');
    } else if (sec === 'physical' || sec === 'aux') {
      body = renderAnswerResults(sec);
    } else {
      body = reportBlock(sec);
    }
    return `<div class="rp-title">${esc(title)}</div>${body}`;
  }
  // 练习模式（非诊断）
  const title = panelTitle(sec);
  let html = `<div class="rp-title">${esc(title)}</div>`;
  if (sec === 'history') {
    const items = collectPicked('history').filter(p => p.nec);
    if (!items.length) {
      html += `<div class="empty rp-empty">点击中间区域的问诊条目进行采集，右侧会逐步生成系统的「检查记录」。</div>`;
    } else {
      const rec = historyRecordText();
      if (rec) {
        html += `<div class="rp-records-label">系统检查记录（随问诊逐步生成）</div>`;
        html += `<div class="rp-checkrecord">${formatCheckRecord(rec)}</div>`;
      } else {
        html += formatPickedQA(items);
      }
    }
    return html;
  }
  const pickedItems = collectPicked(sec);
  if (!pickedItems.length) {
    html += `<div class="empty rp-empty">点击中间区域的选项进行“采集”，右侧会列出已采集的结果。</div>`;
  } else {
    html += `<div class="rp-records-label">已采集 ${pickedItems.length} 项</div>`;
    html += formatPickedResults(pickedItems);
  }
  return html;
}

// 答案模式：体格检查 / 辅助检查 右栏——列出该板块全部项目的检查结果（数值 / 参考值 / 临床意义）
function renderAnswerResults(sec) {
  const s = getCase().sections;
  const nodes = sec === 'physical' ? s.physical : s.aux;
  const out = [];
  const walk = (n) => {
    if (n.items) n.items.forEach(it => out.push({ name: it.name, result: it.result, ref: it.ref, sig: it.sig, unit: it.unit }));
    else if (n.subs) n.subs.forEach(walk);
    else if (n.children) n.children.forEach(walk);
    else if (n.result !== undefined && n.result !== null) out.push({ name: n.name, result: n.result, ref: n.ref, sig: n.sig, unit: n.unit });
  };
  nodes.forEach(walk);
  if (!out.length) return '<div class="empty">（暂无结果）</div>';
  return `<div class="rp-results">${out.map(o => `
    <div class="rp-result">
      <div class="rp-result-name">${esc(o.name)}</div>
      <div class="rp-result-val">${esc(o.result || '')}${o.unit ? ' ' + esc(o.unit) : ''}</div>
      ${o.ref ? `<div class="ref">参考值：${esc(o.ref)}</div>` : ''}
      ${o.sig ? `<div class="sig">临床意义：${esc(o.sig)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// 练习模式：已采集条目（历史兜底）渲染为清爽列表
function formatPickedQA(items) {
  return `<div class="rp-records-label">已采集 ${items.length} 项</div><div class="rp-records">${items.map(p => `
    <div class="rp-record">
      <div class="rp-rec-q">${esc(p.l1)}</div>
      ${p.l2 ? `<div class="rp-rec-a">${esc(p.l2)}</div>` : ''}
    </div>`).join('')}</div>`;
}
// 练习模式：体格检查 / 辅助 / 治疗 已采集结果清爽列表（替代原 <pre> 堆砌）
function formatPickedResults(items) {
  return `<div class="rp-records">${items.map(p => `
    <div class="rp-record">
      <div class="rp-rec-q">${esc(p.l1)}</div>
      ${p.l2 ? `<div class="rp-rec-a">${esc(p.l2)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// 诊断练习：右侧"依据列表"——来自已采集的病史/体格/辅助项目（含干扰项）
function renderDiagEvidencePanel() {
  const names = Object.keys(state.diagMarks[state.cur] || {});
  const active = state.activeDiag[state.cur] || names[0];
  if (!names.length) {
    return `<div class="rp-title">依据列表</div><div class="empty">尚未添加诊断。先在上方搜索并添加诊断，再在病史 / 体格 / 辅助检查中采集项目，相关依据会汇总于此。</div>`;
  }
  if (!active) return `<div class="rp-title">依据列表</div><div class="empty">请在左侧选择一个诊断。</div>`;
  const pool = collectEvidenceCandidates();
  const marks = getDiagMarks(active);
  const cls = getDiagClass(active);
  let html = `<div class="rp-title">依据列表 · ${esc(active)} <span class="cls-tag cls-${esc(cls)}">${esc(cls)}</span></div>`;
  if (!pool.length) {
    html += `<div class="empty">尚未在病史 / 体格 / 辅助检查中采集任何项目。采集后，相关依据会出现在此处，可逐一标记「支持 / 不支持」。</div>`;
    return html;
  }
  html += `<div class="ev-pool">`;
  for (const c of pool) {
    const sup = marks.support.has(c.key);
    const uns = marks.unsupport.has(c.key);
    html += `<div class="ev-pool-item">
      <div class="ev-pool-meta"><span class="ev-pool-src">${esc(c.sec)}</span></div>
      <div class="ev-pool-label-row">
        <div class="ev-pool-label">${esc(c.label)}</div>
        <div class="ev-pool-btns">
          <button class="ev-label green ${sup ? 'active' : ''}" data-d="${esc(active)}" data-k="${esc(c.key)}" data-v="support">支持</button>
          <button class="ev-label red ${uns ? 'active' : ''}" data-d="${esc(active)}" data-k="${esc(c.key)}" data-v="unsupport">不支持</button>
        </div>
      </div>
      ${c.detail ? `<div class="ev-pool-detail">${esc(c.detail)}</div>` : ''}
    </div>`;
  }
  html += `</div>`;
  return html;
}
function empty() { return `<div class="empty">没有匹配的内容${state.necOnly ? '（已筛选“必要项”）' : ''}。</div>`; }

// 练习模式：疾病一级标题下方「已选支持/不支持」预览（参照答案模式证据样式）
function renderDiagPreview(dname) {
  const marks = getDiagMarks(dname);
  if (!marks.support.size && !marks.unsupport.size) return '';
  // 支持/不支持标记可能来自右栏依据池（keyOf 键）或左栏证据树（norm(u.text) 键），两路都映射到展示条目
  const byKey = {};
  for (const c of collectEvidenceCandidates()) byKey[c.key] = c;
  const d = (getCase().sections.diagnosis || []).find(x => x.name === dname);
  const byNorm = {};
  if (d && d.bySrc) for (const src of Object.keys(d.bySrc)) for (const u of d.bySrc[src]) byNorm[norm(u.text)] = { sec: src, label: u.sub ? u.sub + ' · ' + u.item : u.item, detail: u.content };
  const lookup = k => byKey[k] || byNorm[k];
  const grp = (set, v) => {
    const items = [...set].map(k => lookup(k)).filter(Boolean);
    if (!items.length) return '';
    return `<div class="diag-prev-group">
      <div class="diag-prev-h ${v}">${v === 'support' ? '支持' : '不支持'} · ${items.length}</div>
      ${items.map(c => `<div class="diag-prev-item">
        <span class="diag-prev-badge ${v}">${v === 'support' ? '支持' : '不支持'}</span>
        <div class="diag-prev-text"><div class="diag-prev-label">${esc(c.label)}</div>${c.detail ? `<div class="diag-prev-detail">${esc(c.detail)}</div>` : ''}</div>
      </div>`).join('')}
    </div>`;
  };
  return `<div class="diag-preview">${grp(marks.support, 'support')}${grp(marks.unsupport, 'unsupport')}</div>`;
}
// 右栏点选支持/不支持后，仅就地更新该病左侧预览块（不重渲染整栏，避免折叠）
function updateDiagPreview(dname) {
  const card = [...document.querySelectorAll('.diag-selected')].find(c => c.dataset.d === dname);
  if (!card) return;
  const html = renderDiagPreview(dname);
  const prev = card.querySelector('.diag-preview');
  if (prev) { if (html) prev.outerHTML = html; else prev.remove(); }
  else if (html) card.insertAdjacentHTML('beforeend', html);
}

// ================= 事件绑定 =================
function bindSectionClicks() {
  // 委托监听绑在 .layout（同时包含 #section 与 #reportPanel），否则右栏按钮点不到
  document.querySelector('.layout').addEventListener('click', e => {
    // v48 折叠（默认全折叠）：练习/答案模式都可用（放在模式闸门前），点击组标题切换展开集合
    const grpHead = e.target.closest('.aux-sec-head');
    if (grpHead && !e.target.closest('.aux-run') && !e.target.closest('.aux-sel')) {
      const gk = grpHead.dataset.grp;
      state.auxExpanded[state.cur] = state.auxExpanded[state.cur] || new Set();
      if (state.auxExpanded[state.cur].has(gk)) state.auxExpanded[state.cur].delete(gk);
      else state.auxExpanded[state.cur].add(gk);
      renderSection();
      return;
    }
    if (state.mode !== 'practice') return;
    const arow = e.target.closest('.aux-row');
    if (arow && arow.dataset.sec === 'aux') {
      // v36 平铺行：未采集项进入「待检测」（可多选/取消），组标题「检测 N 项」批量采集
      const key = arow.dataset.key;
      if (!isPicked('aux', key)) {
        const pend = auxPendingSet();
        if (pend.has(key)) pend.delete(key); else pend.add(key);
        renderSection();
      }
      return;
    }
    const card = e.target.closest('.pcard');
    if (card) {
      const sec = card.dataset.sec, key = card.dataset.key;
      // v34 辅助检查：未采集项先进入「待检测」（可多选/取消），组内点「检测」批量采集
      if (sec === 'aux' && !isPicked(sec, key)) {
        const pend = auxPendingSet();
        if (pend.has(key)) pend.delete(key); else pend.add(key);
        renderSection();
        return;
      }
      togglePick(sec, key);
      renderSection();
      renderReport();
      return;
    }
    const selAll = e.target.closest('.aux-sel');
    if (selAll) {
      // v45 全选 toggle：组内全部未采集项已待检测 → 取消全选（清空该组 pending）；否则全选
      const grp = selAll.dataset.grp;
      const pend = auxPendingSet();
      const leaves = [];
      collectAuxLeaves(auxTopLevel(), [], '', '', leaves);
      const grpLeaves = leaves.filter(l => l.grpKey === grp && !isPicked('aux', keyOf('aux', l.item, l.path)));
      const allPend = grpLeaves.length > 0 && grpLeaves.every(l => pend.has(keyOf('aux', l.item, l.path)));
      for (const l of grpLeaves) {
        if (allPend) pend.delete(keyOf('aux', l.item, l.path));
        else pend.add(keyOf('aux', l.item, l.path));
      }
      renderSection();
      return;
    }
    const runBtn = e.target.closest('.aux-run');
    if (runBtn) {
      const grp = runBtn.dataset.grp;
      const pend = auxPendingSet();
      const picked = pickedSet();
      let n = 0;
      for (const k of [...pend]) {
        if (k.startsWith(grp + '|')) { picked.add(k); pend.delete(k); n++; }
      }
      if (n) { state.auxCheckCount[state.cur] = (state.auxCheckCount[state.cur] || 0) + 1; saveState(); }  // v44 检测动作计 1 次
      renderSection(); renderReport();
      return;
    }
    const lbl = e.target.closest('.ev-label');
    if (lbl) {
      const dname = lbl.dataset.d; const key = lbl.dataset.k; const val = lbl.dataset.v;
      const marks = getDiagMarks(dname);
      const has = marks[val].has(key);
      if (has) marks[val].delete(key);
      else {
        marks[val].add(key);
        if (val === 'support') marks.unsupport.delete(key);
        else marks.support.delete(key);
      }
      // v34：同步刷新所有同 key 按钮的 active 态（左栏证据树按钮不随 renderReport 重渲染，需即时反馈）
      document.querySelectorAll(`.ev-label[data-d="${CSS.escape(dname)}"][data-k="${CSS.escape(key)}"]`).forEach(b => {
        b.classList.toggle('active', marks[val].has(key));
      });
      renderReport();
      updateDiagPreview(dname);
      saveState();  // F4 标记点击立即落盘
      return;
    }
    const scene = e.target.closest('.scene-btn');
    if (scene) {
      const s = scene.dataset.scene;
      state.txScene[state.cur] = s;
      renderSection(); renderReport();
      return;
    }
    const cls = e.target.closest('.cls-btn');
    if (cls) {
      const d = cls.dataset.d, c = cls.dataset.cls;
      state.diagClass[state.cur] = state.diagClass[state.cur] || {};
      state.diagClass[state.cur][d] = c;
      renderSection();
      renderReport();
      return;
    }
    const dsel = e.target.closest('.diag-selected');
    if (dsel) {
      state.activeDiag[state.cur] = dsel.dataset.d;
      renderSection();
      renderReport();
      saveState();  // F4 activeDiag 切换即落盘
      return;
    }
    const sub = e.target.closest('.btn-submit');
    if (sub) {
      if (confirm('确定提交本病例答卷？\n提交后将按权重计算百分制评分（病史10% · 体格10% · 辅助70% · 诊断10% · 治疗0%）。\n答题进度已本地保存，可随时「重新练习」。')) {
        const r = computeScore();
        state.scores = state.scores || {};
        state.scores[state.cur] = {
          total: r.total,
          breakdown: r.breakdown.map(b => ({ label: b.label, weight: b.weight, rate: b.rate })),
          ts: Date.now(),
        };
        saveState();
        renderReport();
        renderRpHint();
      }
      return;
    }
    const reset = e.target.closest('.btn-reset-practice');
    if (reset) {
      if (confirm('确定重新练习本病例？\n将清空本病例的答题选择与评分记录。')) {
        const ci = +reset.dataset.reset;
        if (state.picked[ci]) delete state.picked[ci];
        if (state.scores) delete state.scores[ci];
        if (state.diagClass[ci]) delete state.diagClass[ci];
        if (state.diagMarks[ci]) delete state.diagMarks[ci];
        if (state.txScene[ci]) delete state.txScene[ci];
        if (state.auxCheckCount[ci]) delete state.auxCheckCount[ci];  // v47 重新练习清检测次数（否则进度条红条不消失）
        if (state.auxPending[ci]) delete state.auxPending[ci];
        if (state.auxExpanded[ci]) delete state.auxExpanded[ci];
        state.diagQ = '';
        saveState();
        renderCase();
      }
      return;
    }
  });
}
function bindDiagLabels() {
  // delegated in bindSectionClicks
}

// ================= 模式切换 =================
function setMode(mode) {
  state.mode = mode;
  document.getElementById('btnPractice').classList.toggle('active', mode === 'practice');
  document.getElementById('btnAnswer').classList.toggle('active', mode === 'answer');
  document.getElementById('btnPractice').setAttribute('aria-pressed', String(mode === 'practice'));
  document.getElementById('btnAnswer').setAttribute('aria-pressed', String(mode === 'answer'));
  const necEl = document.getElementById('necOnlyWrap');
  if (necEl) necEl.style.display = mode === 'practice' ? 'none' : '';
  setRpOpen(false);
  renderSidebar(); renderHead(); renderTabs(); renderSection(); renderReport();
  renderRpHint();
  resetMainScroll();  // P1#3 切模式后重置（替换原打在 #section 死代码上的 reset）
}

// ================= 启动 =================
function boot() {
  Promise.all([
    fetch('data/cases.json').then(r => r.json()),
    fetch('data/diaglib.json').then(r => r.json()),
    fetch('data/history_records.json').then(r => r.json()).catch(() => ({})),
  ]).then(([cases, diaglib, histRec]) => {
    state.cases = cases; state.diaglib = diaglib; state.histRec = histRec || {};
    loadState();
    renderSidebar(); renderCase();
    setMode('practice');

    document.getElementById('search').oninput = e => { state.q = e.target.value.trim(); renderSection(); };
    document.getElementById('necOnly').onchange = e => { state.necOnly = e.target.checked; renderSection(); };
    document.getElementById('btnPractice').onclick = () => setMode('practice');
    document.getElementById('btnAnswer').onclick = () => setMode('answer');

    bindSectionClicks();
    bindMobileDrawer();
  bindDesktopDrawer();
  setSbOpen(true, false);  // v50 初始展开（默认状态，F7 不劫持启动焦点）

    document.getElementById('section').addEventListener('input', e => {
      if (e.target.id === 'diagSearch') { state.diagQ = e.target.value.trim(); renderDiagSuggestions(); }
    });
  }).catch(err => {
    document.getElementById('section').innerHTML = `<div class="empty">加载数据失败：${esc(err.message)}<br/>请通过本地服务器（http://）打开本页面，勿用 file:// 直接双击。</div>`;
  });
}
boot();
