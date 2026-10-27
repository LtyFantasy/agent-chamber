/**
 * 把仓库根的 .agents/skills 复制进 backend 编译产物目录。
 *
 * 为什么需要它：apps/backend/src/modules/skill/skill.service.ts 以
 * `__dirname/../../../../../.agents/skills` 解析 skill 目录（生产 = <产物目录>/.agents/skills），
 * 所以 skill 文件必须随产物一起落在产物目录内 —— 构建脚本原来的内联 `cp -r ... dist/.agents/skills`
 * 无法表达「产物目录可能是 dist-new（影子构建）」，故抽成本脚本，由 DIST_DIR 决定目标。
 *
 * 目标目录: <apps/backend>/<DIST_DIR 或 dist>/.agents/skills
 * 源目录  : 依次探测 <内层 monorepo 根>/.agents/skills 与 <外层仓库根>/.agents/skills
 *           （本仓 .agents 只存在于外层仓库根；内层探测是兼容 chamber 快照仓布局的兜底）
 * 两处都找不到 → **exit 1**（F9）：skill 文件缺失时 backend 的 /skills 端点会空转，
 * 而「构建成功但 skill 缺失」是静默降级。旧内联 cp 的双失败同样会让构建失败（非静默），
 * 这里保持同一语义，并由 deploy.sh 的 assert_shadow_artifact 再兜一道非空目录检查。
 */

const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
const distDir = (process.env.DIST_DIR || '').trim() || 'dist';
const dest = path.join(pkgRoot, distDir, '.agents', 'skills');

const candidates = [
  path.join(pkgRoot, '..', '..', '.agents', 'skills'),
  path.join(pkgRoot, '..', '..', '..', '.agents', 'skills'),
];

// 非空目录判定（R13）：源目录「存在但为空」会让 Docker/dev 路径交付一个空 skills 目录，
// /skills 端点随即空转 —— 与「目录缺失」同属静默降级，一并按失败处理。
function isNonEmptyDir(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const src = candidates.find((candidate) => isNonEmptyDir(candidate));

if (!src) {
  console.error(`[copy-agent-skills] 未找到非空的 .agents/skills（已探测: ${candidates.join(', ')}）——构建失败`);
  console.error('[copy-agent-skills] skill 文件是 backend /skills 端点的数据源，缺失或为空都不能静默通过');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-agent-skills] ${src} → ${dest}`);
