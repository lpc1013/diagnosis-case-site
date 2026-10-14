// 行为级 E2E runner（零依赖）：自己起服务器 → 用无头 Chrome 跑两趟壳页 → 解析结果 → 按退出码判定。
// 无头跑法是按本机验过的配方写的：老式 --headless（--headless=new 在这台机器上不产出）、
// 绝对路径的 --user-data-dir（相对路径会被当成「加入现有会话」而根本没开新进程）、
// 每次一个新 profile（复用会命中缓存跑旧代码）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('node:child_process');

const { parseQaDom, formatQa } = require('./qa_parse.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, '_qa');
const KEEP = process.argv.includes('--keep');

function findBrowser() {
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA || '';
  cands.push(
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  );
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitServer(port, tries) {
  const attempt = n => new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/index.html', timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  }).then(ok => ok || (n <= 0 ? false : new Promise(r => setTimeout(r, 150)).then(() => attempt(n - 1))));
  return attempt(tries || 40);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function dumpDom(browser, url, profile, budgetMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      '--virtual-time-budget=' + budgetMs,
      '--dump-dom',
      url,
    ];
    const child = spawn(browser, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Chrome 超时 ' + timeoutMs + 'ms 未退出（已按 PID 终止这条进程）'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!out.trim()) reject(new Error('Chrome 没吐出 DOM（exit ' + code + '）：' + err.slice(0, 300)));
      else resolve(out);
    });
  });
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = findBrowser();
  if (!browser) {
    console.error('✖ 找不到 Chrome/Edge。设一个 CHROME_PATH 指向浏览器可执行文件即可（不会因此判通过）。');
    return 2;
  }
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(SITE, 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  const exits = [];
  server.on('exit', c => exits.push(c));

  const profile = path.join(OUT, 'profile-' + Date.now());   // 绝对路径
  fs.mkdirSync(profile, { recursive: true });
  const base = 'http://127.0.0.1:' + port + '/index.html';

  console.log('E2E：' + path.basename(browser) + ' @ http://127.0.0.1:' + port + '（profile ' + path.relative(ROOT, profile) + '）');
  const report = { browser, port, startedAt: new Date().toISOString(), stages: {}, verdict: null };
  let rc = 0;
  try {
    if (!(await waitServer(port))) throw new Error('本地服务器起不来（端口 ' + port + '）');

    // 前置检查：规则表必须可达，否则 act 阶段只会得到一个「装载失败」的假红
    const rules = await get(base.replace(/index\.html$/, 'rules/official-rule.json'));
    if (rules.status !== 200) throw new Error('规则表不可达 HTTP ' + rules.status);

    const stages = [['act', base + '#qa=act'], ['density', base + '#qa=density'], ['verify', base + '#qa=verify']];
    for (const [name, url] of stages) {
      // 两趟共用同一个 profile：第一趟把期望值留在 localStorage，第二趟读它
      const html = await dumpDom(browser, url, profile, 45000, 180000);
      fs.writeFileSync(path.join(OUT, name + '.html'), html, 'utf8');
      const parsed = parseQaDom(html);
      report.stages[name] = parsed.raw || { reason: parsed.reason, detail: parsed.detail };
      console.log(formatQa(parsed, name));
      if (!parsed.ok) rc = 1;
    }
  } catch (e) {
    rc = 1;
    console.error('✖ E2E 未能完成：' + e.message);
    report.error = e.message;
  } finally {
    server.kill();                                   // 按 PID 停，不发中断信号
    await new Promise(r => setTimeout(r, 200));
    report.serverExit = exits;
    report.verdict = rc === 0 ? 'pass' : 'fail';
    report.elapsedMs = Date.now() - t0;
    fs.writeFileSync(path.join(OUT, 'last.json'), JSON.stringify(report, null, 1), 'utf8');
    if (!KEEP) fs.rmSync(profile, { recursive: true, force: true });
    console.log('产物：' + path.relative(ROOT, path.join(OUT, 'last.json')) + '（耗时 ' + (report.elapsedMs / 1000).toFixed(1) + 's）');
  }
  return rc;
}

if (require.main === module) {
  main().then(code => process.exit(code));
} else {
  module.exports = { findBrowser, waitServer, freePort };
}
