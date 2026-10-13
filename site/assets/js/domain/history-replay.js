// 病史「检查记录」增量重放的唯一权威实现。
// 前端练习回放与 build_history_records.js 的自检必须共用这份，
// 两份各写各的会导致生成的数据与页面呈现悄悄分叉。
//
// ops 语义（由 build_history_records.js 产出）：
//   {t:'add', line, after}  该步真正新增的一行，after 为插入锚点行
//   {t:'ext', base, suf}    字段就地延长：base 行 -> base+suf，真实增量只是 suf
//   {t:'del', line}         该步被移除的一行
'use strict';

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
