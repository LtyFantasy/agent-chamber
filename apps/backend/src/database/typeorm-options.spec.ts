/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 生产运行时 TypeORM 装配断言：连接选项（尤其连接级会话默认值 `extra`）**确实**
 *     被装配进 `app.module.ts` 的 `TypeOrmModule.forRoot`
 *
 * [代码职责]
 *   - 断言 `buildTypeOrmOptions()` 的返回形状：`extra` 与 `PG_CONNECTION_EXTRA` **同源**、
 *     其余键保持既有语义、`migrations` glob 指向真实存在的目录
 *
 * [权威文档]
 *   - 主文档: src/database/typeorm-options.ts — [关键不变量] 与工厂 rationale
 *   - 补充: src/database/pg-session-defaults.ts — 阈值取值与连接级下发论证
 *
 * [关键不变量]
 *   - **删掉 `extra: PG_CONNECTION_EXTRA` 那一行，本套件必须响亮地红**：这是本文件存在的
 *     唯一理由（`extra` 缺失的症状是「检索静默少召回」，无任何报错可依赖）。
 *   - 断言对象必须是**工厂返回值**（= 真正交给 forRoot 的那份），不是常量本身——
 *     「常量断言常量」守不住装配旁路（见 typeorm-options.ts 的 PGCONN-FACTORY-BYPASS）。
 *
 * [关联代码]
 *   - src/database/typeorm-options.ts — 被断言的工厂
 *   - src/database/pg-session-defaults.ts — `extra` 的期望值来源
 *   - src/app.module.ts — 真实装配点（`TypeOrmModule.forRoot(buildTypeOrmOptions())`）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import { PG_CONNECTION_EXTRA, PG_TRGM_SIMILARITY_THRESHOLD } from './pg-session-defaults';
import { buildTypeOrmOptions } from './typeorm-options';

describe('buildTypeOrmOptions（生产运行时 TypeORM 装配）', () => {
  it('extra 与 PG_CONNECTION_EXTRA 同源装配（删掉那一行即红）', () => {
    const options = buildTypeOrmOptions();

    // 真断言「装配」：断言工厂产出的选项对象，而不是常量自身
    expect(options.extra).toBe(PG_CONNECTION_EXTRA);
    expect(options.extra).toEqual({
      options: `-c pg_trgm.similarity_threshold=${PG_TRGM_SIMILARITY_THRESHOLD}`,
    });
  });

  it('连接与迁移关键选项保持既有语义（工厂搬运不改行为）', () => {
    const options = buildTypeOrmOptions();

    expect(options.type).toBe('postgres');
    expect(options.synchronize).toBe(false); // 生产禁 synchronize（Schema 只走 migration）
    expect(options.migrationsRun).toBe(true); // 部署即跑迁移链
    expect(typeof options.namingStrategy).toBe('object'); // SnakeNamingStrategy（snake_case 列名）
    expect(Array.isArray(options.entities)).toBe(true);
    expect((options.entities as unknown[]).length).toBeGreaterThan(0);
  });

  it('migrations glob 的基准目录真实存在且含迁移（防 __dirname 搬运出错）', () => {
    const options = buildTypeOrmOptions();
    const glob = (options.migrations as string[])[0];

    // glob 基准必须是本文件同级目录（ts-jest 下 = src/database，编译后 = dist/.../src/database），
    // 而不是 app.module.ts 时代的 '<root>/database'——搬错即部署时找不到迁移链
    const dir = path.dirname(glob);
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.includes('AddDocSpaceModule'))).toBe(true);
    expect(files.some((f) => f.includes('AddDocSectionHeadingPathTrgmIndex'))).toBe(true);
  });
});
