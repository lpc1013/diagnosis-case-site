'use strict';
// 样式层的静态闸。
// 两件事都是「浏览器会静默咽下去、构建全绿」的那类问题：
//   1) style.css 少一个 } —— 其后所有规则被当成上一条的声明块丢掉；
//   2) JS 画了一个 CSS 里根本没有的类名 —— 页面照样显示，只是裸着没样式。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read(path.join('site', 'assets', 'style.css'));
const APP = read(path.join('site', 'assets', 'app.js'));
const HTML = read(path.join('site', 'index.html'));
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('style.css 的块必须逐层闭合（不是只数总量相等）', () => {
  const css = stripComments(CSS);
  let depth = 0, minDepth = 0, rules = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) rules++; }
    if (depth < minDepth) minDepth = depth;
  }
  assert.ok(minDepth >= 0, `出现了提前闭合（最深处 ${minDepth}），说明有落单的 }`);
  assert.strictEqual(depth, 0, `结尾仍有 ${depth} 层没闭合——漏掉的那个 } 之后的全部规则都会被浏览器丢掉`);
  assert.ok(rules >= 200, `只数到 ${rules} 条顶层规则，样式表像是被截断了`);
  process.stdout.write(`[style.css 顶层规则 ${rules} 条，括号逐层闭合]\n`);
});

// 从 class="..." 里取类名：先摘掉 ${...} 插值，再把插值里的字面量类名收回来。
// 摘掉插值后会留下 `cls-`、`rt-` 这类前缀残片（真名是拼出来的），所以要求 token 不以 - 结尾。
function classTokens(src) {
  const out = new Set();
  const keep = t => { if (t && /^[a-zA-Z][\w-]*[a-zA-Z0-9]$/.test(t)) out.add(t); };
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const val = m[1];
    for (const l of val.matchAll(/'([^']*)'/g)) for (const t of l[1].split(/\s+/)) keep(t);
    for (const t of val.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) keep(t);
  }
  return out;
}

test('页面画出的每个类名，样式表里都得有对应规则', () => {
  const css = stripComments(CSS);
  const tokens = new Set([...classTokens(APP), ...classTokens(HTML)]);
  const missing = [...tokens].filter(t => !new RegExp('\\.' + t.replace(/[-]/g, '\\-') + '(?![\\w-])').test(css));
  // 复盘/思维链是这一轮新画的视图，单独报个数：新视图最容易被漏样式，
  // 只报「共查 N 个」看不出它到底覆没覆盖到那批新类名。
  const rt = [...tokens].filter(t => /^(rt-|b-miss|b-off|aux-std)/.test(t)).sort();
  assert.ok(rt.length >= 20, `复盘视图只探到 ${rt.length} 个类名，说明探针没量到新加的视图：${rt.join(' ')}`);
  assert.deepStrictEqual(missing, [],
    `这些类名被画出来但样式表里没有：${missing.join(', ')}（共查 ${tokens.size} 个类名，其中复盘视图 ${rt.length} 个）`);
  process.stdout.write(`[类名覆盖：${tokens.size} 个类名全部有规则，其中复盘/思维链视图 ${rt.length} 个]\n`);
});
