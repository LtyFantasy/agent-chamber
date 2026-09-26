/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的 **Nest 模块装配点**：provider / 配置 / 配额 / 通用 runner 的提供与导出
 *
 * [代码职责]
 *   - providers：`JUDGMENT_PROVIDER` + `JUDGMENT_CONFIG`（装配见 judgment-provider.factory）
 *     + `JudgmentQuotaService` + `JudgmentRunnerService`
 *   - exports：四个 provider 全部导出——业务模块（经验库 / DocSpace）只 import 本模块即可拿到
 *     完整判别能力，不需要各自重复装配
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/architecture.md` — 模块清单（判别内核层）
 *   - 线上 DocSpace `docs/experience-base.md` — 判别服务章
 *
 * [关键不变量]
 *   - **本模块刻意不 `ConfigModule.forFeature(judgment)`**：配置注册点是 `app.module.ts` 的
 *     `load` 数组（单源），本模块只**读** `ConfigService`。在此重复注册会让同一份 env 被解析
 *     两次，且两处缺省值迟早漂移（`JUDGMENT_CONFIG_FALLBACK` 已经承担"没 load 时的兜底形状"）。
 *   - **两个 token 的字符串值不变**（e2e `overrideProvider` 的替换点）：改名 = e2e 静默落到
 *     真实现（真的联网打计费 API，而测试全绿）。
 *   - **本模块不 import 任何业务模块**：判别内核被业务模块 import，反向依赖会成环
 *     （能力实现是叶子文件，可被 `judgment.capabilities.ts` import，但那只发生在非模块层）。
 *   - **配额服务必须是单例**（本模块的一个 provider 实例）：全局桶跨能力可见是**语义要求**
 *     （"实例级出境量上限"），若每个调用点各持一份，闸值被静默放大成 N 倍。
 *   - `ConfigModule` 在 `app.module.ts` 里 `isGlobal`，故本模块无需 import 它即可注入
 *     `ConfigService`（与 ExperienceModule 同款前提）。
 *
 * [关联代码]
 *   - judgment-provider.factory.ts — 两个 token 的 provider 定义与启动诊断
 *   - judgment-quota.service.ts / judgment-runner.service.ts — 配额与通用编排
 *   - modules/experience/experience.module.ts — 消费者（imports 本模块）
 *   - modules/docspace/docspace.module.ts — 搜索重排的消费者（imports 本模块）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 provider 时确认它该 export（业务侧要用）还是仅模块内可见
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import { JUDGMENT_PROVIDER } from './judgment-capability.interface';
import {
  JUDGMENT_CONFIG,
  judgmentConfigProvider,
  judgmentProviderProvider,
} from './judgment-provider.factory';
import { JudgmentQuotaService } from './judgment-quota.service';
import { JudgmentRunnerService } from './judgment-runner.service';

/**
 * 判别内核模块（平台共享的判别能力底座）。
 *
 * 装配面很窄：一个 provider（真联网 / 关闭态）+ 一份只读配置 + 配额计数器 + 通用 runner。
 * 业务语义（条目快照、搜索重排）一律留在业务模块，本模块不认识任何具体能力。
 */
@Module({
  imports: [
    // 判别日志表：**通用判别行与经验库行写同一张表**（`operation` 列区分；零 migration）
    TypeOrmModule.forFeature([ExperienceJudgmentRecord]),
  ],
  providers: [
    judgmentProviderProvider,
    judgmentConfigProvider,
    JudgmentQuotaService,
    JudgmentRunnerService,
  ],
  exports: [JUDGMENT_PROVIDER, JUDGMENT_CONFIG, JudgmentQuotaService, JudgmentRunnerService],
})
export class JudgmentModule {}
