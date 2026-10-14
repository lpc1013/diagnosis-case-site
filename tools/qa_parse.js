// 把无头 Chrome --dump-dom 的输出解析成结构化结果。
// 单独成模块是为了它能被 tests/qa_parse.test.js 直接喂假 DOM 验证——
// 一个从不失败的 runner 比没有 runner 更糟，所以解析这条也要先证伪一次。
'use strict';

const RESULT_RE = /<pre id="qa-result"[^>]*>([\s\S]*?)<\/pre>/i;

function unescapeText(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseQaDom(html) {
  if (typeof html !== 'string' || !html.trim()) return { ok: false, reason: 'EMPTY_OUTPUT', detail: 'Chrome 没有吐出任何 DOM' };
  const m = html.match(RESULT_RE);
  if (!m) {
    return { ok: false, reason: 'NO_RESULT', detail: '页面上没有 <pre id="qa-result">：驱动没跑到终态（数据没装载、模块没被 #qa 激活，或中途抛错）' };
  }
  let payload;
  try {
    payload = JSON.parse(unescapeText(m[1]));
  } catch (e) {
    return { ok: false, reason: 'BAD_JSON', detail: '结果块不是合法 JSON：' + e.message };
  }
  if (!payload || payload.done !== true) {
    return { ok: false, reason: 'NOT_DONE', detail: '结果块缺少 done:true，视为没跑完' };
  }
  if (!Array.isArray(payload.checks)) {
    return { ok: false, reason: 'NO_CHECKS', detail: '结果块里没有 checks 数组' };
  }
  // 只认字面 true：'false'、非空字符串这类"看着像红"的值一律算红。
  // 以前用 !c.pass 判定，pass:'false' 会被判成通过——一个会把红洗成绿的解析器不能当验收闸。
  const failed = payload.checks.filter(c => !c || c.pass !== true);
  return {
    ok: failed.length === 0,
    stage: payload.stage,
    counts: { total: payload.checks.length, failed: failed.length },
    checks: payload.checks,
    fatal: payload.fatal || null,
    aborted: payload.aborted || null,
    captured: payload.captured || null,
    raw: payload,
  };
}

// 打印给人的读数：点名哪几条红了，而不是只报「N 条失败」
function formatQa(parsed, label) {
  if (!parsed.ok && !parsed.checks) return `  ✖ ${label || 'qa'}: [${parsed.reason}] ${parsed.detail}`;
  const lines = parsed.checks.map(c => `    ${c.pass ? '✔' : '✖'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  const head = `  ${parsed.counts && parsed.counts.failed ? '✖' : '✔'} ${label || parsed.stage || 'qa'}：${parsed.counts.total} 条断言，红 ${parsed.counts.failed} 条`;
  const extra = parsed.fatal ? `\n    [fatal] ${parsed.fatal}` : (parsed.aborted ? `\n    [aborted] ${parsed.aborted}` : '');
  return [head].concat(lines).join('\n') + extra;
}

module.exports = { parseQaDom, formatQa, unescapeText };
