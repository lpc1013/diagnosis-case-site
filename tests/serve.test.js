'use strict';
// 静态服务器边界与异常隔离回归测试（node:test，零依赖）
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');

const SITE = path.join(__dirname, '..', 'site');
const { resolveRequest, ROOT, CSP } = require(path.join(SITE, 'serve.js'));

// 旧实现的路径判定，保留在此用于证明这些断言确实能抓到当年的缺陷（falsification 基线）。
// 缺陷：把「字符串前缀」当成了「目录边界」。
function legacyResolve(rawUrl) {
  const p = decodeURIComponent(rawUrl.split('?')[0]);
  const fp = path.join(ROOT, p);
  return fp.startsWith(ROOT) ? fp : null;
}

// 所有经由 URL 归一化 + 百分号解码仍然能构造出的「越界」写法。
// 注意：裸 '/../../x' 会被 WHATWG URL 归一化吃掉，所以真实攻击一律用编码形态。
const TRAVERSAL = [
  '/..%2fsecret.txt',
  '/..%2f..%2fsecret.txt',
  '/%2e%2e%2f%2e%2e%2fsecret.txt',
  '/data/..%2f..%2f..%2fdiag_cache.json',
  '/..%5c..%5csecret.txt',
];

// 其中「与 ROOT 同名字前缀的兄弟目录」这一类，才是旧 startsWith 判定真正漏出去的：
// path.join 已经把 .. 消化掉，结果形如 <ROOT>-private/x.txt，字符串前缀仍是 ROOT。
const LEGACY_LEAK = [
  '/..%2fsite-private%2fsecret.txt',
  '/..%2fsite_backup%2fdiag_cache.json',
  '/assets/..%2f..%2fsite.data%2fx.json',
];

test('根路径解析到 index.html，仍在 ROOT 内', () => {
  assert.strictEqual(resolveRequest('/').fp, path.join(SITE, 'index.html'));
});

test('常规资源可解析', () => {
  assert.strictEqual(resolveRequest('/assets/app.js').fp, path.join(SITE, 'assets', 'app.js'));
  assert.strictEqual(resolveRequest('/data/cases.json').fp, path.join(SITE, 'data', 'cases.json'));
  assert.strictEqual(resolveRequest('/index.html?v=3#x').fp, path.join(SITE, 'index.html'));
});

test('穿越与兄弟目录被拒绝（403）', () => {
  for (const u of TRAVERSAL.concat(LEGACY_LEAK)) {
    assert.strictEqual(resolveRequest(u).status, 403, '未拒绝: ' + u);
  }
});

test('兄弟目录语料在旧实现下确实漏出 ROOT 外文件，新实现全部拦住', () => {
  // 若这条失败，说明语料失效（本套断言就变成永真绿闸），要修语料而不是删断言。
  for (const u of LEGACY_LEAK) {
    const fp = legacyResolve(u);
    assert.ok(fp, '旧实现本应放行该写法，语料失效: ' + u);
    assert.ok(path.relative(ROOT, fp).startsWith('..' + path.sep),
      '旧实现放行的路径并不在 ROOT 外，语料失效: ' + u);
    assert.strictEqual(resolveRequest(u).status, 403, '新实现未拦住: ' + u);
  }
});

test('非法百分号编码返回 400 而不是抛出 URIError', () => {
  assert.strictEqual(resolveRequest('/%ff%fe').status, 400);
  assert.strictEqual(resolveRequest('/%E0%A4%A').status, 400);
});

test('NUL 字节返回 400', () => {
  assert.strictEqual(resolveRequest('/a%00b').status, 400);
});

test('隐藏文件被拒绝', () => {
  assert.strictEqual(resolveRequest('/.git/config').status, 403);
  assert.strictEqual(resolveRequest('/%2eenv').status, 403);
});

test('任何被放行的解析结果都必须在 ROOT 内（性质断言）', () => {
  const corpus = TRAVERSAL.concat(LEGACY_LEAK, ['/', '/index.html', '/a/./b', '/%2e%2e', '/data/../', '/favicon.ico', '/%ff']);
  for (const u of corpus) {
    const r = resolveRequest(u);
    if (r.fp) {
      const rel = path.relative(ROOT, r.fp);
      assert.ok(rel && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), u + ' 解析越界: ' + rel);
    }
  }
});

// —— 端到端：进程必须活过非法请求 ——
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 4000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

test('真实请求：非法编码返回 400，进程仍存活并能继续服务', async () => {
  const port = 18787 + (process.pid % 500);
  const child = spawn(process.execPath, [path.join(SITE, 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  const exits = [];
  child.on('exit', c => exits.push('exited:' + c));
  try {
    for (let i = 0; i < 60; i++) {
      try { await get(port, '/index.html'); break; }
      catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.strictEqual((await get(port, '/%ff%fe')).status, 400);
    const trav = await get(port, '/..%2f..%2fREADME.md');
    assert.strictEqual(trav.status, 403, '越界请求必须被拒绝而不是返回内容');
    assert.ok(!/诊断学临床思维训练/.test(trav.body), '越界响应体不得含 ROOT 外文件内容');
    const ok = await get(port, '/index.html');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers['x-content-type-options'], 'nosniff');
    assert.deepStrictEqual(exits, [], '服务进程不应因非法请求退出');
  } finally {
    child.kill();
  }
});

// —— CSP ——
// 内联脚本扫描器：CSP 关掉 script-src 'unsafe-inline' 之后，页面里任何行内脚本都会静默失效
// （按钮照样在、照样能点，只是那段代码不跑了），所以要在发布前用源码扫一遍。
function findInlineCode(html) {
  const hits = [];
  const tag = /<script\b([^>]*)>/gi;
  let m;
  while ((m = tag.exec(html))) {
    if (!/\bsrc\s*=/i.test(m[1])) hits.push('行内 <script>' + m[1].slice(0, 40));
  }
  const attr = /\son[a-z]+\s*=\s*["']/gi;
  while ((m = attr.exec(html))) hits.push('行内事件属性 ' + m[0].trim());
  const jsUrl = /href\s*=\s*["']javascript:/gi;
  while ((m = jsUrl.exec(html))) hits.push('javascript: 链接');
  return hits;
}

test('CSP 扫描器自身能认出三种内联写法（否则这条闸是永真绿）', () => {
  const bad = '<script>doThing()</script><button onclick="go()">x</button><a href="javascript:void(0)">y</a>';
  const hits = findInlineCode(bad);
  assert.strictEqual(hits.length, 3, '应当各命中一条，实到 ' + JSON.stringify(hits));
  // 合法写法不得误报：外链 module、JS 里赋的处理器、行内 style
  const good = '<script type="module" src="assets/app.js?v=55"></script><div style="width:50%"></div>';
  assert.deepStrictEqual(findInlineCode(good), []);
  // JS 里给属性赋处理器不是内联事件；写成 assert.ok(数组) 会因 [] 恒真而永远绿
  assert.deepStrictEqual(findInlineCode('btn.onclick = fn;'), []);
});

test('站内每个 HTML 与前端源码都没有内联脚本（script-src self 才不会打断页面）', () => {
  const files = fs.readdirSync(SITE).filter(f => f.endsWith('.html')).map(f => path.join(SITE, f));
  files.push(path.join(SITE, 'assets', 'app.js'));
  const bad = [];
  for (const f of files) {
    for (const h of findInlineCode(fs.readFileSync(f, 'utf8'))) bad.push(path.basename(f) + ': ' + h);
  }
  assert.deepStrictEqual(bad, [], '这些地方会被 CSP 拦掉：\n  ' + bad.join('\n  '));
});

test('CSP 本身不含 script-src 的放行口子，但保留行内 style（进度条要用）', () => {
  const directives = Object.fromEntries(CSP.split(';').map(s => {
    const t = s.trim(); const i = t.indexOf(' ');
    return [t.slice(0, i), t.slice(i + 1).trim()];
  }));
  assert.strictEqual(directives['default-src'], "'self'");
  assert.strictEqual(directives['script-src'], "'self'", 'script-src 一旦带上 unsafe-inline，这条闸就该红');
  assert.ok(directives['style-src'].includes("'unsafe-inline'"), '行内 style 属性被拦会让评分条变成 0 宽');
  assert.strictEqual(directives['object-src'], "'none'");
  assert.strictEqual(directives['frame-ancestors'], "'none'");
});

test('真实请求：成功与失败的响应都带 CSP 头', async () => {
  const port = 19100 + (process.pid % 300);
  const child = spawn(process.execPath, [path.join(SITE, 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await get(port, '/index.html'); break; }
      catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    const probes = [['/index.html', 200], ['/%ff%fe', 400], ['/..%2f..%2fREADME.md', 403], ['/nope.json', 404]];
    for (const [u, want] of probes) {
      const r = await get(port, u);
      assert.strictEqual(r.status, want, u + ' 状态码');
      assert.strictEqual(r.headers['content-security-policy'], CSP, u + ' 缺 CSP 头');
    }
    // 规则表与病例数据必须同源可读：connect-src 'self' 之下 fetch 才不会被拦
    const rules = await get(port, '/rules/official-rule.json');
    assert.strictEqual(rules.status, 200, 'site/rules/official-rule.json 应当被服务出去');
    assert.strictEqual(rules.headers['content-type'], 'application/json; charset=utf-8');
    assert.doesNotThrow(() => JSON.parse(rules.body));
  } finally {
    child.kill();
  }
});
