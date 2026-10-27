/**
 * Next.js standalone 模式不会自动复制客户端静态资源到 standalone 目录。
 * 此脚本在 build 完成后自动执行复制，确保 standalone 输出包含 CSS/JS chunks。
 */

const fs = require('fs');
const path = require('path');

// 与 next.config.js 同款的 distDir 开关：deploy.sh 的影子构建传 DIST_DIR=.next-new，
// 此处必须跟着走，否则影子构建后本脚本会把【旧】.next/static 复制进 standalone 目录
// （读到的是运行中服务的旧产物）。缺省仍为 .next，行为与从前一致。
const distDir = (process.env.DIST_DIR || '').trim() || '.next';

const src = path.join(__dirname, '..', distDir, 'static');
const dest = path.join(__dirname, '..', distDir, 'standalone', 'apps', 'web', '.next', 'static');

if (!fs.existsSync(src)) {
  console.warn(`[postbuild] ${distDir}/static not found, skipping copy`);
  process.exit(0);
}

if (!fs.existsSync(path.dirname(dest))) {
  console.warn('[postbuild] standalone directory not found, skipping copy');
  process.exit(0);
}

// 删除旧的 static（如果存在），避免残留旧文件
if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}

// 复制新的 static
fs.cpSync(src, dest, { recursive: true, force: true });
console.log(`[postbuild] ${distDir}/static copied to standalone`);
