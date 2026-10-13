// 零依赖本地静态服务器。默认只监听 127.0.0.1，且只服务 ROOT 内的普通文件。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 把请求路径解析成 ROOT 内的真实文件路径。
// 返回 { status } 表示需要直接应答的错误，或 { fp } 表示可服务。
function resolveRequest(rawUrl) {
  let pathname;
  try {
    // WHATWG URL 会把 special scheme 里的 '\' 归一成 '/'，顺手挡掉 Windows 分隔符绕过
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch (e) {
    return { status: 400, body: 'Bad Request' };
  }
  if (pathname.indexOf('\0') >= 0) return { status: 400, body: 'Bad Request' };
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/favicon.ico') return { status: 204 };

  const fp = path.resolve(ROOT, '.' + pathname);
  const rel = path.relative(ROOT, fp);
  // rel 为空 = 请求 ROOT 本身；'..' 开头或绝对路径 = 越界（不同盘符时 relative 会给出绝对路径）
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { status: 403, body: 'Forbidden' };
  }
  if (rel.split(path.sep).some(seg => seg.startsWith('.'))) {
    return { status: 403, body: 'Forbidden' };  // 不服务 .git / .env 一类隐藏文件
  }
  return { fp };
}

// 只服务本站资源。style-src 里的 'unsafe-inline' 是给行内 style 属性的
// （评分条用 style="width:N%" 画进度），不是给行内 <script> 留的口子——
// script-src 没有 unsafe-inline，tests/serve.test.js 会钉住页面确实一个行内脚本都没有。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
  }, headers));
  res.end(body);
}

function handle(req, res) {
  const r = resolveRequest(req.url);
  if (r.status) return send(res, r.status, r.body);

  fs.stat(r.fp, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found');
    // 符号链接可以指向 ROOT 之外，落盘前再按真实路径核一次边界
    fs.realpath(r.fp, (realErr, realFp) => {
      if (realErr) return send(res, 404, 'Not Found');
      const realRel = path.relative(ROOT, realFp);
      if (realRel === '' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
        return send(res, 403, 'Forbidden');
      }
      fs.readFile(realFp, (readErr, buf) => {
        if (readErr) return send(res, 500, 'Internal Server Error');
        send(res, 200, buf, {
          'Content-Type': MIME[path.extname(realFp).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
      });
    });
  });
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // 任何未预期异常只杀掉这个请求，不带走进程
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
    else res.destroy();
    console.error('[serve] request failed:', e.message);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// 被 require 时（回归测试）只导出解析函数，不占端口；直接运行时才监听。
module.exports = { resolveRequest, ROOT, MIME, CSP };

if (require.main === module) {
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(HOST)) {
    console.warn('[serve] 警告：正在监听 ' + HOST + '，站点会对局域网暴露。开发用途请保持 127.0.0.1。');
  }
  server.listen(PORT, HOST, () => {
    console.log('serving ' + ROOT + ' on http://' + HOST + ':' + PORT);
  });
}
