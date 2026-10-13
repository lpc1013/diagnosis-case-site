// 数据契约校验 + 加载失败分类。
// 页面只该在真的拿到「结构正确」的数据时才开始训练，
// 并且要能告诉用户到底是断网、404、JSON 坏了还是结构不对——这三种恢复动作完全不同。
'use strict';

import { caseItems } from '../domain/case.js';

export const LOAD_ERROR = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  HTTP_ERROR: 'HTTP_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  SCHEMA_ERROR: 'SCHEMA_ERROR',
};

export const SECTIONS = ['history', 'physical', 'aux', 'diagnosis', 'treatment'];

function problem(level, code, msg) { return { level, code, msg }; }

// 结构校验：返回 [{level:'error'|'warn', code, msg}]，error 非空即不可用
export function validateCase(c, where) {
  const out = [];
  const at = where || (c && c.name) || '病例';
  if (!c || typeof c !== 'object') return [problem('error', 'NOT_OBJECT', at + ' 不是对象')];
  if (!c.sections || typeof c.sections !== 'object') return [problem('error', 'NO_SECTIONS', at + ' 缺少 sections')];
  for (const sec of SECTIONS) {
    if (!Array.isArray(c.sections[sec])) { out.push(problem('error', 'SECTION_NOT_ARRAY', `${at} · ${sec} 不是数组`)); continue; }
    const items = caseItems(c.sections, sec);
    const seen = new Map();
    for (const i of items) {
      if (!i.label) out.push(problem('error', 'ITEM_UNNAMED', `${at} · ${sec} 存在无名称条目`));
      if (seen.has(i.key)) out.push(problem('error', 'DUPLICATE_KEY', `${at} · ${sec} 键碰撞：「${seen.get(i.key)}」与「${i.label}」共用 ${i.key}`));
      else seen.set(i.key, i.label);
      // moduleCoverage 的分母含非必要项分值，前提是非必要项 score=0；一旦违背满分不可达
      if (!i.nec && i.score > 0) out.push(problem('warn', 'NON_NECESSARY_SCORED', `${at} · ${sec} 非必要项「${i.label}」带分值 ${i.score}，满分将不可达`));
      if (sec === 'aux' && i.item.cost != null && !Number.isFinite(Number(i.item.cost))) out.push(problem('error', 'BAD_COST', `${at} · aux「${i.label}」cost 不是数字（${i.item.cost}）`));
    }
  }
  if (c.limits) {
    for (const [sec, L] of Object.entries(c.limits)) {
      if (L == null) continue;
      if (!(L.max > 0)) out.push(problem('warn', 'BAD_LIMIT', `${at} · limits.${sec} 缺少有效 max`));
      if (L.reasonable != null && L.standard != null && L.reasonable < L.standard) out.push(problem('warn', 'LIMIT_INVERTED', `${at} · limits.${sec} 合理线低于标准线`));
    }
  }
  return out;
}

export function validateCases(cases) {
  if (!Array.isArray(cases)) return [problem('error', 'NOT_ARRAY', 'cases.json 顶层不是数组')];
  if (!cases.length) return [problem('error', 'EMPTY', 'cases.json 为空')];
  const out = [];
  const idxSeen = new Map();
  cases.forEach((c, i) => {
    out.push(...validateCase(c, `病例#${i}(${(c && c.name) || '未命名'})`));
    if (c && c.idx != null) {
      if (idxSeen.has(c.idx)) out.push(problem('error', 'DUP_IDX', `病例 idx ${c.idx} 重复：#${idxSeen.get(c.idx)} 与 #${i}`));
      else idxSeen.set(c.idx, i);
    }
  });
  return out;
}

// 把一个 fetch/解析失败归成可操作的类别
export function classifyLoadError(err, url) {
  const kind = err && err.__loadKind;
  if (kind) return err;
  const e = new Error(`加载 ${url} 失败：${(err && err.message) || err}`);
  e.__loadKind = LOAD_ERROR.NETWORK_ERROR;
  e.__url = url;
  return e;
}

// 独立的加载步骤：状态码、JSON、结构三段各有明确错误
export async function loadJson(url, { fetcher, required = true, validator } = {}) {
  const doFetch = fetcher || ((u) => fetch(u, { cache: 'no-store' }));
  let res;
  try {
    res = await doFetch(url);
  } catch (err) {
    const e = new Error(required ? `${url} 无法访问（网络失败或服务未启动）` : `${url} 无法访问`);
    e.__loadKind = LOAD_ERROR.NETWORK_ERROR; e.__url = url; throw e;
  }
  if (res.status === 404) {
    const e = new Error(required ? `缺少数据文件：${url}` : `${url} 不存在（可选文件，按空数据处理）`);
    e.__loadKind = LOAD_ERROR.FILE_NOT_FOUND; e.__url = url; throw e;
  }
  if (!res.ok) {
    const e = new Error(`${url} 返回 HTTP ${res.status}`);
    e.__loadKind = LOAD_ERROR.HTTP_ERROR; e.__url = url; e.__status = res.status; throw e;
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch (err) {
    const e = new Error(`${url} 不是合法 JSON：${err.message}`);
    e.__loadKind = LOAD_ERROR.INVALID_JSON; e.__url = url; throw e;
  }
  if (validator) {
    const problems = validator(data).filter(p => p.level === 'error');
    if (problems.length) {
      const e = new Error(`${url} 结构校验失败：${problems.map(p => p.msg).join('；')}`);
      e.__loadKind = LOAD_ERROR.SCHEMA_ERROR; e.__url = url; e.__problems = problems; throw e;
    }
  }
  return data;
}

export const LOAD_HELP = {
  [LOAD_ERROR.NETWORK_ERROR]: '请确认已通过本地服务器打开（node site/serve.js），不要用 file:// 直接双击 index.html。',
  [LOAD_ERROR.FILE_NOT_FOUND]: '该文件不存在。请用私有构建脚本生成后放入 site/data/，或检查文件名拼写。',
  [LOAD_ERROR.HTTP_ERROR]: '服务器返回了错误状态码，请检查 serve.js 日志与文件权限。',
  [LOAD_ERROR.INVALID_JSON]: '文件存在但不是合法 JSON，可能被截断或手工改坏，请重新生成。',
  [LOAD_ERROR.SCHEMA_ERROR]: '文件可读但结构不符合病例契约，请重新生成数据（详见 README 的再生步骤）。',
};
