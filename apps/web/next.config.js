// next-intl 插件：声明请求配置文件位置（默认即 ./src/i18n/request.ts），
// 缺少它服务端渲染 NextIntlClientProvider 会报 "Couldn't find next-intl config file"
const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin();

const nextConfig = {
  reactStrictMode: true,
  env: {
    PORT: '8742',
  },
};

module.exports = withNextIntl(nextConfig);
