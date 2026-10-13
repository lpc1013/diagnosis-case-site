// localStorage 的读写：带版本号、结构校验与旧版本迁移。
// 病例顺序或键格式一变，旧记录就会悄悄指向别的条目——所以这里必须显式迁移，
// 迁不动的部分宁可想法丢（并报告），也不能让旧勾选落到新病例上。
'use strict';

import { caseItems, norm } from '../domain/case.js';

export const LS_KEY = 'wb_clinthink_v2';
export const SCHEMA_VERSION = 2;
const LEGACY_KEYS = ['wb_clinthink_v1'];

export function emptyApp() {
  return {
    picked: {},          // picked[caseIdx][sec] = Set(key)
    scores: {},
    hintDismissed: false,
    auxCheckCount: {},
    diagMarks: {},       // diagMarks[caseIdx][diagName] = { support:Set, unsupport:Set }
    diagClass: {},       // diagClass[caseIdx][diagName] = '主要诊断'|... |undefined=尚未分类
    activeDiag: {},
  };
}

const setToArr = s => (s instanceof Set ? [...s] : Array.from(s || []));

export function serialize(app) {
  const picked = {};
  for (const ci in app.picked) {
    picked[ci] = {};
    for (const sec in app.picked[ci]) picked[ci][sec] = setToArr(app.picked[ci][sec]);
  }
  const diagMarks = {};
  for (const ci in app.diagMarks) {
    const byName = {};
    for (const name in (app.diagMarks[ci] || {})) {
      const m = app.diagMarks[ci][name] || {};
      // 即便一条标记都没有也要留下：诊断名本身就是学生的作答，v1 把空标记丢掉导致刷新后诊断消失
      byName[name] = { support: setToArr(m.support), unsupport: setToArr(m.unsupport) };
    }
    if (Object.keys(byName).length) diagMarks[ci] = byName;
  }
  const diagClass = {};
  for (const ci in app.diagClass) {
    const o = {};
    for (const name in (app.diagClass[ci] || {})) if (app.diagClass[ci][name]) o[name] = app.diagClass[ci][name];
    if (Object.keys(o).length) diagClass[ci] = o;
  }
  return {
    v: SCHEMA_VERSION,
    picked,
    scores: app.scores || {},
    hintDismissed: !!app.hintDismissed,
    auxCheckCount: app.auxCheckCount || {},
    diagMarks,
    diagClass,
    activeDiag: app.activeDiag || {},
  };
}

// v1 的病史键是 'h|<问题>'，不含分类路径：同一问题在两个分类下会共用一个状态。
// 迁移时把这种模糊键展开到该问题在本病例中的全部规范键上，之后新点选才各自独立。
function expandLegacyHistoryKeys(caseObj, legacyKeys) {
  const byQ = new Map();
  for (const i of caseItems(caseObj.sections, 'history')) {
    const q = norm(i.item.q);
    if (!byQ.has(q)) byQ.set(q, []);
    byQ.get(q).push(i.key);
  }
  const out = [];
  for (const k of legacyKeys) {
    if (k.indexOf('h|') === 0 && k.split('|').length === 2) {
      const hits = byQ.get(k.slice(2));
      if (hits) { out.push(...hits); continue; }
    }
    out.push(k);
  }
  return out;
}

function validScore(s) {
  return s && typeof s === 'object' && Number.isFinite(s.total) && Array.isArray(s.breakdown);
}

export function deserialize(raw, cases) {
  const report = { version: null, migrated: [], dropped: [], warned: [] };
  const app = emptyApp();
  if (raw == null) return { app, report };
  let d = raw;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { report.dropped.push('无法解析的 JSON，已按空进度处理'); return { app, report }; }
  }
  if (!d || typeof d !== 'object') { report.dropped.push('顶层不是对象，已按空进度处理'); return { app, report }; }

  const legacy = d.v == null || d.v < SCHEMA_VERSION;
  report.version = d.v == null ? 1 : d.v;

  const knownKeys = ci => {
    const c = cases && cases[ci];
    if (!c || !c.sections) return null;
    const m = {};
    for (const sec of ['history', 'physical', 'aux', 'diagnosis', 'treatment']) {
      m[sec] = new Set(caseItems(c.sections, sec).map(i => i.key));
    }
    return m;
  };

  if (d.picked && typeof d.picked === 'object') {
    for (const ci in d.picked) {
      const known = knownKeys(+ci);
      const bySec = {};
      for (const sec in (d.picked[ci] || {})) {
        let keys = Array.from(d.picked[ci][sec] || []).filter(k => typeof k === 'string');
        if (legacy && sec === 'history' && known) keys = expandLegacyHistoryKeys(cases[+ci], keys);
        if (known && known[sec]) {
          const kept = keys.filter(k => known[sec].has(k));
          const lost = keys.length - kept.length;
          if (lost) report.dropped.push(`病例#${ci} · ${sec}：${lost} 个旧键在当前数据中已不存在，已丢弃`);
          keys = kept;
        }
        bySec[sec] = new Set(keys);
      }
      if (legacy && bySec.history) report.migrated.push(`病例#${ci} 病史键已升级为「分类/小节/问题」三段路径`);
      app.picked[ci] = bySec;
    }
  }

  if (d.scores && typeof d.scores === 'object') {
    for (const ci in d.scores) {
      if (validScore(d.scores[ci])) app.scores[ci] = d.scores[ci];
      else report.dropped.push(`病例#${ci} 的旧评分记录结构不完整，已丢弃（可重新提交）`);
    }
  }

  if (typeof d.hintDismissed === 'boolean') app.hintDismissed = d.hintDismissed;
  if (d.auxCheckCount && typeof d.auxCheckCount === 'object') {
    for (const ci in d.auxCheckCount) {
      const n = Number(d.auxCheckCount[ci]);
      if (Number.isFinite(n) && n >= 0) app.auxCheckCount[ci] = n;
    }
  }

  if (d.diagMarks && typeof d.diagMarks === 'object') {
    for (const ci in d.diagMarks) {
      const byName = {};
      for (const name in d.diagMarks[ci]) {
        const m = d.diagMarks[ci][name] || {};
        byName[name] = { support: new Set(Array.from(m.support || [])), unsupport: new Set(Array.from(m.unsupport || [])) };
      }
      app.diagMarks[ci] = byName;
    }
  }

  // v1 完全没有 diagClass：不能凭空当成「学生选了主要诊断」，保持未分类
  if (d.diagClass && typeof d.diagClass === 'object') {
    for (const ci in d.diagClass) app.diagClass[ci] = Object.assign({}, d.diagClass[ci]);
    if (d.diagClass && !Object.keys(d.diagClass).length) report.warned.push('无历史分类记录');
  } else if (legacy) {
    report.migrated.push('旧版本未保存诊断分类，原「主要诊断」默认值已作废，请重新分类');
  }

  if (d.activeDiag && typeof d.activeDiag === 'object') app.activeDiag = Object.assign({}, d.activeDiag);

  // v44 兼容：没有检测次数时按已采集项目数兜底
  for (const ci in app.picked) {
    const a = app.picked[ci] && app.picked[ci].aux;
    if (a && app.auxCheckCount[ci] == null) app.auxCheckCount[ci] = a.size;
  }
  return { app, report };
}

// 优先读新版本键；只有新版本为空时才尝试旧键并迁移，读完后清掉旧键避免二次污染
export function loadFrom(storage, cases) {
  const read = k => {
    try {
      return storage && typeof storage.getItem === 'function' ? storage.getItem(k) : null;
    } catch (e) { return null; }  // 隐私模式/配额异常不得影响启动
  };
  const current = read(LS_KEY);
  if (current != null) return deserialize(current, cases);
  for (const k of LEGACY_KEYS) {
    const raw = read(k);
    if (raw != null) return deserialize(raw, cases);
  }
  return { app: emptyApp(), report: { version: null, migrated: [], dropped: [], warned: [] } };
}

export function saveTo(storage, app) {
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(LS_KEY, JSON.stringify(serialize(app)));
      for (const k of LEGACY_KEYS) if (typeof storage.removeItem === 'function') storage.removeItem(k);
      return true;
    }
  } catch (e) { /* 容量或隐私模式 */ }
  return false;
}

export { LEGACY_KEYS };
