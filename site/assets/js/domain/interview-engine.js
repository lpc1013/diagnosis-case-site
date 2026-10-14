// 临床问诊时间序列引擎。
//
// 它不只是「把检查记录画出来」的显示算法：本病例的病史是学生【逐步问出来】的，
// 系统每次只回一批增量行，还会就地延长前一轮的行、偶尔撤销前一轮的行。
// 所以「学生问了哪些题、按什么顺序、每问得到什么」本身就是一份需要重建的时间序列——
// 前端回放与 build_history_records.js 的发布前自检必须共用这一份实现，
// 两份各写各的会让生成的数据与页面呈现悄悄分叉。
//
// ops 语义（由 build_history_records.js 产出）：
//   {t:'add', line, after}  该步真正新增的一行，after 为插入锚点行
//   {t:'ext', base, suf}    字段就地延长：base 行 -> base+suf，真实增量只是 suf
//   {t:'del', line}         该步被移除的一行
'use strict';

import { norm } from './case.js';

export const CR_SECTIONS = new Set(['基本常识', '现病史', '既往史', '个人史', '家族史', '月经婚育史', '妇产科问题', '小儿问题', '目前一般状况']);
export const CR_SEP = ['，', '、', '；', '：', ':', ' '];

export function cleanSuf(s) { return (s || '').replace(/^[,，、；;:： ]+/, ''); }

export function replayOps(working, ops) {
  for (const op of ops || []) {
    if (op.t === 'add') {
      let replaced = false;
      for (let k = 0; k < working.length; k++) {
        const X = working[k];
        if (!CR_SECTIONS.has(X) && op.line.startsWith(X) && op.line.length > X.length) {
          const s = op.line.slice(X.length);
          if (CR_SEP.some(x => s.startsWith(x))) { working[k] = op.line; replaced = true; break; }
        }
      }
      if (replaced) continue;
      if (op.after != null) { const a = working.indexOf(op.after); if (a >= 0) { working.splice(a + 1, 0, op.line); continue; } }
      working.push(op.line);
    } else if (op.t === 'ext') {
      const full = op.base + op.suf;
      let hit = -1, mode = 'full';
      // 1) 整基行命中：working 已有 op.base 整行，或已有 op.base 的「前缀段」
      for (let k = 0; k < working.length; k++) {
        const X = working[k];
        if (X === op.base || (!CR_SECTIONS.has(X) && op.base.startsWith(X) && op.base.length > X.length && CR_SEP.some(s => op.base.slice(X.length).startsWith(s)))) { hit = k; mode = 'full'; break; }
      }
      // 2) 尾段命中：op.base 的末段恰是 working 中某行 -> 把 suf 续到该行之后
      //    跳过未点的中间步骤也能合并为一条，且不泄露未点中的基内容。
      if (hit < 0) {
        for (let k = 0; k < working.length; k++) {
          const X = working[k];
          if (CR_SECTIONS.has(X) || X.length < 2) continue;
          const i = op.base.lastIndexOf(X);
          if (i > 0 && i + X.length === op.base.length && CR_SEP.includes(op.base[i - 1])) { hit = k; mode = 'tail'; break; }
        }
      }
      if (hit >= 0) { working[hit] = mode === 'full' ? full : working[hit] + op.suf; }
      else {
        const cs = cleanSuf(op.suf);
        if (op.after != null) { const a = working.indexOf(op.after); if (a >= 0) { working.splice(a + 1, 0, cs); continue; } }
        working.push(cs);  // 基行未点中：只显示新增后缀，绝不带出基内容
      }
    } else if (op.t === 'del') {
      const k = working.indexOf(op.line);
      if (k >= 0) working.splice(k, 1);
    }
  }
  return working;
}

// 只重放被点中的步骤（下标可乱序，内部按爬取顺序处理）
export function replayPicked(steps, pickedIdxs) {
  const idxs = [...new Set(pickedIdxs)].filter(i => i >= 0 && i < steps.length).sort((a, b) => a - b);
  const working = [];
  for (const idx of idxs) replayOps(working, steps[idx].ops || []);
  return working;
}

export function replayAll(steps) { return replayPicked(steps, (steps || []).map((_, i) => i)); }

export function linesOf(rec) {
  return (rec || '').split('\n').map(l => l.trim()).filter(Boolean).filter(l => l !== '检查记录');
}

// 重放全部步骤应当等于终态记录——构建脚本用它做发布前闸门
export function replayMatchesFinal(steps) {
  const got = replayAll(steps);
  const want = linesOf(steps[steps.length - 1].rec);
  return {
    order: JSON.stringify(got) === JSON.stringify(want),
    set: got.length === want.length && new Set(got).size === got.length && want.every(x => got.includes(x)),
    got, want,
  };
}

// ——— 问诊路径（复盘用）———
// 上面管「最终得到了什么」，这里管「是怎么问到的」：
// 每一步问了什么、这一步净增了几行、撤销过没有。
// 这是重建学生问诊轨迹的唯一入口，显示层不许自己再数一遍 ops。
export function opsTally(ops) {
  const t = { add: 0, ext: 0, del: 0 };
  for (const o of ops || []) if (t[o.t] != null) t[o.t]++;
  return t;
}

// 「学生勾了哪些问题」→「系统出题序列里的第几步」。
// 页面右栏的检查记录、复盘用的问诊路径、思维链第一段的线索，都必须走这一份映射：
// 各写一遍的话，三处会各自数出不同的问诊轨迹。
// 真实四例实测：每题规范化后在本病例内唯一（重名 0/37、0/29、0/34、0/37），
// 所以命中同名时取第一处即可；若将来再生数据出现重名，取第一处也不会静默串到后一处。
export function stepIdxsForQuestions(steps, questions) {
  const byQ = new Map();
  (steps || []).forEach((s, i) => {
    const k = norm(s.q);
    if (!byQ.has(k)) byQ.set(k, i);
  });
  const idxs = new Set();
  for (const q of questions || []) {
    const i = byQ.get(norm(q));
    if (i != null) idxs.add(i);
  }
  return [...idxs].sort((a, b) => a - b);
}

export function interviewPath(steps, pickedIdxs) {
  const all = steps || [];
  const wanted = new Set([...(pickedIdxs || [])].filter(i => i >= 0 && i < all.length));
  const working = [];
  const path = [];
  for (let i = 0; i < all.length; i++) {
    if (!wanted.has(i)) continue;
    const before = working.slice();
    replayOps(working, all[i].ops || []);
    const t = opsTally(all[i].ops);
    path.push({
      step: i,
      q: all[i].q || '',
      add: t.add, ext: t.ext, del: t.del,
      net: working.length - before.length,
      // 这一步之后「新出现或被打补丁改写」的行——延长是就地改写，所以它也算该步的产出
      lines: working.filter(l => !before.includes(l)),
      sourceType: all[i].sourceType || 'exact',
    });
  }
  const est = path.filter(p => p.sourceType === 'estimated').length;
  return {
    path,
    lines: working,
    asked: path.length,
    skipped: all.length - path.length,
    total: all.length,
    estimated: est,
    // 净增为 0 的步骤：问了但一行都没多（系统撤销或合并掉了），复盘要点出来
    emptyTurns: path.filter(p => p.net <= 0).map(p => p.step),
  };
}
