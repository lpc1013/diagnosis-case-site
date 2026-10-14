'use strict';
// 三档信息密度的截图取证（零依赖，无头 Chrome，不抢前台焦点）。
//
// 为什么先跑一趟 act：复盘档只有在【已提交】的病例上才允许开答案，
// 空着答卷去截「复盘」只会截到一句提示，看不出这档到底长什么样。
// 所以这里用同一个 profile 先 act（作答+提交），再逐档截图。
//
// 用法：node tools/shot.js [--keep-profile]
// 产物：_qa/ui-exam.png / _qa/ui-study.png / _qa/ui-review.png / _qa/shots.json
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

// 复用 runner 已经在本机验过的无头启动条件（同一个 require 不会重复跑 main）
const { findBrowser, waitServer, freePort: freePortUnused } = require('./qa_run.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, '_qa');

function runChrome(browser, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chrome 超时未退出：' + args.join(' ').slice(0, 120))); }, timeoutMs);
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, err }); });
  });
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = findBrowser();
  if (!browser) { console.error('✖ 找不到 Chrome/Edge（设 CHROME_PATH 也行）'); return 2; }
  const port = await freePortUnused();
  const server = spawn(process.execPath, [path.join(SITE, 'serve.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });
  const profile = path.join(OUT, 'shot-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const base = 'http://127.0.0.1:' + port + '/index.html';
  const report = { browser, port, profile: path.relative(ROOT, profile), shots: [], startedAt: new Date().toISOString() };
  let rc = 0;
  try {
    if (!(await waitServer(port))) throw new Error('本地服务器起不来');

    // 1) 先作答并提交（--dump-dom 只为把这一次跑完，DOM 不保留）
    const act = await runChrome(browser, [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      '--virtual-time-budget=45000',
      '--dump-dom',
      base + '#qa=act',
    ], 180000);
    if (act.code !== 0) console.log('! act 退出码 ' + act.code + '：' + act.err.slice(0, 200));

    // 2) 逐档截图：先删旧图，避免「这张其实是上一轮的」
    for (const ui of ['exam', 'study', 'review']) {
      const file = path.join(OUT, 'ui-' + ui + '.png');
      fs.rmSync(file, { force: true });
      await runChrome(browser, [
        '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--user-data-dir=' + profile,
        '--window-size=1440,1600',
        '--virtual-time-budget=40000',
        '--screenshot=' + file,
        base + '#qa=shot-' + ui,
      ], 180000);
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      report.shots.push({ ui, file: st ? path.relative(ROOT, file) : null, bytes: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, fresh: !!st && st.mtimeMs > t0 });
      if (!st || st.size < 1000) { rc = 1; console.log(`✖ ${ui} 没截出像样的图：${st ? st.size + ' 字节' : '文件不存在'}`); }
      else console.log(`✔ ${ui} → ${path.relative(ROOT, file)}（${(st.size / 1024).toFixed(0)} KB，本轮新写）`);
    }
  } catch (e) {
    rc = 1;
    console.error('✖ 截图未完成：' + e.message);
    report.error = e.message;
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 200));
    if (!process.argv.includes('--keep-profile')) fs.rmSync(profile, { recursive: true, force: true });
    report.elapsedMs = Date.now() - t0;
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(report, null, 1), 'utf8');
    console.log('产物：' + path.relative(ROOT, path.join(OUT, 'shots.json')) + `（耗时 ${(report.elapsedMs / 1000).toFixed(1)}s，${rc === 0 ? '全部为本轮新写' : '有图没产出'}）`);
  }
  return rc;
}

if (require.main === module) main().then(c => process.exit(c));
