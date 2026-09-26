// 从增量爬取数据(recon/incr_c{idx}_*.json)抽取「病史采集」每步累计「检查记录」文本，
// 并为每步计算"真实增量 ops"（add / ext / del），生成 site/data/history_records.json。
//
// ops 语义：
//   {t:'add', line}        该步真正新增的一行
//   {t:'ext', base, suf}   字段就地延长：base 行 -> base+suf（真实增量只是 suf，而非整行）
//   {t:'del', line}        该步被移除的一行（如 裸"伴随症状" 被"伴随症状1/2"取代时）
//
// 前端"重放模型"：只按爬取顺序重放【被点中的步骤】的 ops。
//   - 'ext'：若 base 已在 working（即基行被点中）-> 替换为 base+suf；否则只把 suf(去前导标点)作为新行，
//     绝不把未点中的基内容带出 -> 彻底消除"意外的多余增量"。
//   - 'add' / 'del'：常规增删（带字段延长折叠）。
//
// 自检：replayOps(全部步骤) 必须 == 终态 rec（顺序+集合一致）。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const RECON = path.join(ROOT, 'recon');
const OUT = path.join(ROOT, 'site', 'data', 'history_records.json');

const _CR_SECTIONS = new Set(['基本常识', '现病史', '既往史', '个人史', '家族史', '月经婚育史', '妇产科问题', '小儿问题', '目前一般状况']);
const _CR_SEP = ['，', '、', '；', '：', ':', ' '];

function norm(s) {
  return (s || '').replace(/\s+/g, '').replace(/[：:\/\\？?。.、；;，,+＋（）()“”"'\']/g, '').toLowerCase();
}
function extractCheckRecord(ft) {
  if (!ft) return null;
  const i = ft.indexOf('检查记录');
  if (i < 0) return null;
  let s = ft.slice(i);
  const e = s.indexOf('\n---\n', 1);
  return e > 0 ? s.slice(0, e) : s;
}
function orderedQuestionsFromFinal(finalRight, necSet) {
  if (!finalRight) return [];
  const lines = finalRight.split('\n').map(l => l.trim()).filter(Boolean);
  const qset = new Set();
  const out = [];
  for (const ln of lines) {
    if (ln.startsWith('儿子说：') || ln.startsWith('[') || ln.includes('问诊量') || ln.includes('问题列表')) continue;
    if (necSet.has(norm(ln))) { const k = norm(ln); if (!qset.has(k)) { qset.add(k); out.push(ln); } }
  }
  return out;
}
function linesOf(rec) {
  return (rec || '').split('\n').map(l => l.trim()).filter(Boolean).filter(l => l !== '检查记录');
}
function cleanSuf(s) { return (s || '').replace(/^[,，、；;:： ]+/, ''); }

// 计算 step i 相对 step i-1 的真实增量 ops（带插入锚点 after，保证重放顺序与终态一致）
function diffOps(oldRec, newRec) {
  const O = linesOf(oldRec), N = linesOf(newRec);
  const oSet = new Set(O), nSet = new Set(N);
  const added = N.filter(l => !oSet.has(l));
  const removed = O.filter(l => !nSet.has(l));
  const remSet = new Set(removed);
  const ops = [];
  const usedRem = new Set();
  for (let ai = 0; ai < N.length; ai++) {
    const A = N[ai];
    if (oSet.has(A)) continue; // 非新增行
    // 前驱锚点：N 中位于其前、且本步未被删除的最近一行
    let afterLine = null;
    for (let j = ai - 1; j >= 0; j--) { if (!remSet.has(N[j])) { afterLine = N[j]; break; } }
    let paired = false;
    for (let r = 0; r < removed.length; r++) {
      if (usedRem.has(r)) continue;
      const R = removed[r];
      if (_CR_SECTIONS.has(R)) continue;
      if (A.startsWith(R) && A.length > R.length) {
        const suff = A.slice(R.length);
        if (_CR_SEP.some(s => suff.startsWith(s))) { ops.push({ t: 'ext', base: R, suf: suff, after: afterLine }); usedRem.add(r); paired = true; break; }
      }
    }
    if (!paired) ops.push({ t: 'add', line: A, after: afterLine });
  }
  removed.forEach((R, r) => { if (!usedRem.has(r)) ops.push({ t: 'del', line: R }); });
  return ops;
}

// 重放 ops 到 working（与前端一致），用于自检
function replayOps(working, ops) {
  for (const op of ops) {
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
      // 1) 整基行命中：working 中已有 op.base 整行，或已有"op.base 的前缀段"（基行未点但其前缀已点 -> 合并）
      for (let k = 0; k < working.length; k++) {
        const X = working[k];
        if (X === op.base || (!_CR_SECTIONS.has(X) && op.base.startsWith(X) && op.base.length > X.length && _CR_SEP.some(s => op.base.slice(X.length).startsWith(s)))) { hit = k; mode = 'full'; break; }
      }
      // 2) 尾段命中：op.base 的"最后一段(末分隔符之后)"恰好是 working 中某行 X。
      //    例：base=习惯与嗜好：…服药史，饮酒史，working 已有 饮酒史(来自已点step34) ->
      //        把 suf 续到 饮酒史 之后 -> 饮酒史+suf。跳过未点的中间步骤也能合并为一条，且不泄露任何未点基内容。
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
        const cs = cleanSuf(op.suf);
        if (op.after != null) { const a = working.indexOf(op.after); if (a >= 0) { working.splice(a + 1, 0, cs); continue; } }
        working.push(cs); // 基未点中：只显示新增后缀，绝不泄露基内容
      }
    } else if (op.t === 'del') {
      const k = working.indexOf(op.line);
      if (k >= 0) working.splice(k, 1);
    }
  }
  return working;
}
function recordFromPicked(steps, pickedIdxs) {
  const idxs = [...new Set(pickedIdxs)].sort((a, b) => a - b);
  const working = [];
  for (const idx of idxs) replayOps(working, steps[idx].ops || []);
  return working;
}

const reconFiles = {
  '0': 'incr_c0_呕血068.json',
  '1': 'incr_c1_记忆力定向力减退、走路不稳.json',
  '2': 'incr_c2_双下肢浮肿.json',
  '3': 'incr_c3_血压升高.json',
};

const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'data', 'cases.json'), 'utf8'));
const out = {};

for (const idx of Object.keys(reconFiles)) {
  const f = path.join(RECON, reconFiles[idx]);
  const siteNec = [];
  cases[idx].sections.history.forEach(cat => cat.subs.forEach(sub => sub.items.forEach(it => { if (it.necessary) siteNec.push(it.q); })));
  const necSet = new Set(siteNec.map(norm));
  let steps = null, method = '';

  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const tab = d.tabs && d.tabs['病史采集'];
    if (tab && tab.steps && tab.steps.length) {
      const exact = tab.steps.map(s => ({ q: s.item, rec: extractCheckRecord(s.fullText) })).filter(s => s.rec);
      if (exact.length) { steps = exact; method = `精确逐步(${exact.length}步)`; }
      else if (tab.finalRight) {
        const finalRec = extractCheckRecord(tab.finalRight);
        if (finalRec) {
          const ordered = orderedQuestionsFromFinal(tab.finalRight, necSet);
          const qOrder = ordered.length ? ordered : siteNec;
          const recLines = finalRec.split('\n');
          const N = qOrder.length || recLines.length;
          steps = qOrder.map((q, i) => {
            const upto = Math.max(1, Math.ceil(recLines.length * (i + 1) / N));
            return { q, rec: recLines.slice(0, upto).join('\n') };
          });
          method = `终态比例还原(${steps.length}步, 终态${recLines.length}行)`;
        }
      }
    }
  }

  if (!steps) steps = [];
  steps.forEach((s, i) => { s.ops = i === 0 ? linesOf(s.rec).map(l => ({ t: 'add', line: l })) : diffOps(steps[i - 1].rec, s.rec); });

  // 自检：重放全部步骤 必须 == 终态 rec（顺序+集合）
  if (steps.length) {
    const all = recordFromPicked(steps, steps.map((_, i) => i));
    const finalLines = linesOf(steps[steps.length - 1].rec);
    const okOrder = JSON.stringify(all) === JSON.stringify(finalLines);
    const setA = new Set(all), setB = new Set(finalLines);
    const okSet = all.length === finalLines.length && [...setA].every(x => setB.has(x)) && [...setB].every(x => setA.has(x));
    console.log(`[${idx}] 自检 重放全部=${okOrder ? '顺序+集合一致✓' : (okSet ? '集合一致(顺序略异)' : '不一致✗')}${okOrder ? '' : '\n    got: ' + all.join(' | ')}`);
  }

  const stepNorm = new Set(steps.map(s => norm(s.q)));
  const miss = siteNec.filter(q => !stepNorm.has(norm(q)));
  out[idx] = steps;
  console.log(`[${idx}] 方法=${method || '无数据'} 站点必要项=${siteNec.length} 未命中=${miss.length}` +
    (miss.length ? ' 缺失: ' + miss.slice(0, 4).join(' | ') : ' ✓ 全覆盖'));
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('\n已写', OUT);
