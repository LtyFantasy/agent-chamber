/**
 * Next.js standalone 模式不会自动复制客户端静态资源到 standalone 目录。
 * 此脚本在 build 完成后自动执行复制，确保 standalone 输出包含 CSS/JS chunks。
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '.next', 'static');
const dest = path.join(__dirname, '..', '.next', 'standalone', 'apps', 'web', '.next', 'static');

if (!fs.existsSync(src)) {
  console.warn('[postbuild] .next/static not found, skipping copy');
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
console.log('[postbuild] .next/static copied to standalone');
