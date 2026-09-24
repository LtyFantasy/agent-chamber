// index.mjs — Cordis 插件入口（薄壳）：name/inject/apply 三件套。
// 本文件刻意零静态跨文件 import（v1.2.1 §2 禁令扩写：含 @deepseek-ai/* 与 ../../kimi-code/*）：
// link/绝对路径装载下 realpath 到本仓，仓内无 node_modules/@deepseek-ai，静态跨包 import 必炸
// ERR_MODULE_NOT_FOUND 拖垮 boot（已实证硬事实 4）。chamber.mjs 的装载同样走动态 import +
// try/catch——模块损坏只降级本插件，绝不拖垮 dsh 启动（R10）。
// apply() 零 throw：三功能各自的故障隔离在 chamber.mjs 的 applyChamber 内；此层只兜装载失败。

/** 插件名：日志前缀与 section 命名的归因基础（Cordis 约定导出） */
export const name = 'agent-chamber';

/**
 * Cordis 服务依赖声明（编译产物核实：ctx.agents.get(id):Agent|undefined；
 * ctx.systemPrompt.section({name,order,text,complete?})，无 interpolate 字段）。
 * 注意：inject 只保证 apply 调用时服务在场；applyChamber 内仍逐服务复检，
 * 服务缺失与内容异常分开记日志（plan 硬约束），二者不互相掩护。
 */
export const inject = ['agents', 'systemPrompt'];

/**
 * Cordis apply：动态装载 chamber.mjs 并委托。async apply 有一方先例
 * （dsh-mcp-client / dsh-tool-fs-search 等均 async function apply）。
 * @param {object} ctx Cordis 上下文
 */
export async function apply(ctx) {
  const logger = ctx.logger; // cordis LoggerService：error/info/warn/debug 四方法（logger.d.ts 实证）
  let chamber;
  try {
    chamber = await import(new URL('./chamber.mjs', import.meta.url));
  } catch (error) {
    // 降级但留可见信号：模块文件缺失/语法错误 → 插件整体不装，boot 无损
    logger?.error?.(`[agent-chamber] chamber module load failed: ${String(error)}`);
    return;
  }
  try {
    await chamber.applyChamber(ctx);
  } catch (error) {
    // applyChamber 内部已按功能隔离；此处是最后兜底（理论上不可达）
    logger?.error?.(`[agent-chamber] apply failed: ${String(error)}`);
  }
  // Remote namespace 'chamber'（批 1，plan §2）：与 chamber.mjs 同款的动态装载 + 故障隔离范式。
  // setupChamberRemote 内部零 throw（任何失败只降级日志 '[agent-chamber] remote=unavailable:<reason>'）；
  // 此层只兜 remote.mjs 模块装载失败（文件缺失/语法错误），日志词表对齐 module-load。
  try {
    const remote = await import(new URL('./remote.mjs', import.meta.url));
    await remote.setupChamberRemote(ctx, logger);
  } catch (error) {
    logger?.error?.(`[agent-chamber] remote=unavailable:module-load error=${String(error)}`);
  }
}
