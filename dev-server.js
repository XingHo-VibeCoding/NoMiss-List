/**
 * NoMiss List —— 本地开发服务器（开发用，不属于产品功能）
 *
 * 为什么需要它：浏览器的"本地存储"按来源隔离，直接双击打开文件得到的是
 * file:// 来源，和 http://localhost 是两个互不相通的数据空间。为了让数据
 * 从第一天起就待在同一个地方，统一用这个服务器访问。
 *
 * 只用 Node 自带模块，零依赖、无需联网安装。
 *
 * 用法：  node dev-server.js         （默认 8000 端口）
 *        node dev-server.js 8080    （指定端口）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // 安全：不允许跳出项目目录
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 禁止访问');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到：' + urlPath);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  NoMiss List 已启动');
  console.log('  浏览器打开：  http://localhost:' + PORT);
  console.log('  停止服务器：  在这个窗口按 Ctrl + C');
  console.log('');
});
