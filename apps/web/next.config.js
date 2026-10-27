// next-intl 插件：声明请求配置文件位置（默认即 ./src/i18n/request.ts），
// 缺少它服务端渲染 NextIntlClientProvider 会报 "Couldn't find next-intl config file"
const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin();

// 影子构建开关（Stage 0 / 卡 876c1f22）：
// next start 运行中会按需读 <distDir> 下的页面 chunk 与静态资源，因此部署时
// 【不能】原地重建 .next（用户会拿到混合 chunk / 静态资源 404）。deploy.sh 的
// 影子构建传 DIST_DIR=.next-new（见 scripts/deploy.sh 步骤 6），停服后由
// scripts/lib/artifact-swap.sh rename 切换成 .next；不传时保持默认 .next，
// 本地开发 / 常规构建行为完全不变（pnpm build、next dev 均走默认值）。
const distDir = (process.env.DIST_DIR || '').trim() || '.next';

const nextConfig = {
  reactStrictMode: true,
  env: {
    PORT: '8742',
  },
  distDir,
};

module.exports = withNextIntl(nextConfig);
