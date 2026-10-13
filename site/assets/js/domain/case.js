// 病例结构的权威实现：键生成 + 扁平化条目枚举。
// 渲染层、评分层、持久化层都必须从这里取 key，任何一处自己拼路径就会产生
// 「同一条目两个键」——历史上病史键就因为忽略路径而能跨分类碰撞。
'use strict';

export function norm(s) {
  return (s || '').replace(/\s+/g, '').replace(/[：:\/\\]/g, '').toLowerCase();
}

// 化验单/报告单是冗余包装层：只保留其子节点作为一级
export function auxTopLevel(auxNodes) {
  const out = [];
  for (const n of auxNodes || []) {
    if (n.name === '化验单' || n.name === '报告单') { if (n.children) out.push(...n.children); }
    else out.push(n);
  }
  return out;
}

// 每个板块的「规范路径」只在此定义一次
export function historyPath(cat, sub) { return [cat.category, sub.name]; }

export function keyOf(sec, item, path) {
  if (sec === 'diagnosis') return 'd|' + norm(item.name);
  const p = (path || []).map(norm).join('|');
  // 治疗项的「规格」在 attr 里（拆石膏（大）/（小）、根管清理（前牙）/（磨牙）），
  // 只用 name 会让同组两条不同措施共用一个勾选状态——真实四例中每例都已发生 3 次。
  const id = norm(item.name || item.q) + (sec === 'treatment' && item.attr ? '|' + norm(item.attr) : '');
  return sec[0] + '|' + p + '|' + id;
}

// cost 会被拼进 HTML 并累计进花费，必须始终是有限非负数；脏数据按 0 处理
export function safeCost(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function* walkPhysical(nodes, path) {
  for (const n of nodes || []) {
    const p2 = path.concat(n.name);
    if (n.items) for (const it of n.items) yield { item: it, path: p2 };
    else if (n.subs) yield* walkPhysical(n.subs, p2);
  }
}

function* walkAux(nodes, path) {
  for (const n of nodes) {
    const p2 = path.concat(n.name);
    if (n.children) yield* walkAux(n.children, p2);
    else yield { item: n, path: p2 };
  }
}

function auxDetail(n) {
  return n.result + (n.ref ? `（参考值 ${n.ref}）` : '') + (n.sig ? `（临床意义 ${n.sig}）` : '');
}

// itemsOf 返回该板块全部可选条目：{ key, item, nec, score, label, detail }
// label/detail 就是报告面板展示的「项目名 / 结果」，与点选态判定共用同一份键。
export function itemsOf(sec, sections) {
  const out = [];
  if (sec === 'history') {
    for (const cat of sections.history || []) {
      for (const sub of cat.subs || []) {
        for (const it of sub.items || []) {
          const path = historyPath(cat, sub);
          out.push({ key: keyOf('history', it, path), item: it, nec: !!it.necessary, score: it.score || 0, label: it.q, detail: it.reply });
        }
      }
    }
  } else if (sec === 'physical') {
    for (const { item, path } of walkPhysical(sections.physical, [])) {
      out.push({ key: keyOf('physical', item, path), item, nec: !!item.necessary, score: item.score || 0, label: item.name, detail: item.result });
    }
  } else if (sec === 'aux') {
    for (const { item, path } of walkAux(auxTopLevel(sections.aux), [])) {
      out.push({ key: keyOf('aux', item, path), item, nec: !!item.necessary, score: item.score || 0, cost: safeCost(item.cost), label: item.name, detail: auxDetail(item) });
    }
  } else if (sec === 'treatment') {
    for (const g of sections.treatment || []) {
      for (const it of g.items || []) {
        const path = [g.group];
        out.push({ key: keyOf('treatment', it, path), item: it, nec: !!it.necessary, score: it.score || 0, label: it.name + (it.attr ? `（${it.attr}）` : ''), detail: '' });
      }
    }
  } else if (sec === 'diagnosis') {
    for (const d of sections.diagnosis || []) {
      out.push({ key: keyOf('diagnosis', d, []), item: d, nec: true, score: d.score || 1, label: d.name, detail: '' });
    }
  }
  return out;
}

const cache = new WeakMap();
// 同一份病例对象上重复枚举（切板块/渲染/评分都会要）时复用结果
export function caseItems(sections, sec) {
  let bySec = cache.get(sections);
  if (!bySec) { bySec = {}; cache.set(sections, bySec); }
  if (!bySec[sec]) bySec[sec] = itemsOf(sec, sections);
  return bySec[sec];
}

export function countNec(sections, sec) { return caseItems(sections, sec).reduce((a, i) => a + (i.nec ? 1 : 0), 0); }
export function countTotal(sections, sec) { return caseItems(sections, sec).length; }

export function necKeys(sections, sec) {
  return caseItems(sections, sec).filter(i => i.nec).map(i => i.key);
}
