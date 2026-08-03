/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §13. Skill 模块
 *   - 补充: ./agents/skills/agent-chamber/SKILL.md
 *
 * [踩坑索引]
 *
 * [铁律关联] #4(文档优先) #10(工具优先) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import type { GrayMatterFile } from 'gray-matter';
import { ErrorCode } from '@agent-chamber/shared';
import { SkillListItemDto, SkillDetailDto } from './skill.dto';

/**
 * Skill 名称/子路径白名单。
 *
 * 仅允许 URL-safe 的字符，阻断目录遍历与特殊字符注入。
 */
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Skill 分发服务。
 *
 * 负责从文件系统读取 `.agents/skills/` 下的 Skill Markdown，解析 YAML frontmatter，
 * 并向 Controller 提供列表/详情/子 Skill/原始内容四种能力。
 *
 * 安全设计：
 * - 所有用户传入的标识符（name / subpath）均经过白名单校验。
 * - 最终解析后的绝对路径必须落在目标 Skill 目录内，防止 `..` 目录遍历。
 */
@Injectable()
export class SkillService {
  /** Skill 文件根目录 */
  private readonly skillDir: string;

  constructor(private readonly configService: ConfigService) {
    // 默认路径兼容开发与生产：
    // - 开发：apps/backend/src/modules/skill/ → ../../../../../.agents/skills = agent-chamber/.agents/skills
    // - 生产：dist/apps/backend/src/modules/skill/ → ../../../../../.agents/skills = dist/.agents/skills（由 build 脚本复制）
    const defaultSkillDir = path.resolve(__dirname, '../../../../../.agents/skills');
    this.skillDir = this.configService.get<string>('SKILL_DIR') || defaultSkillDir;
  }

  /**
   * 获取所有公开 Skill 的元数据列表。
   *
   * 只读取 `skillDir` 下直接子目录中的 `SKILL.md`；缺少该文件的目录会被静默忽略。
   *
   * @returns Skill 元数据列表
   */
  async findAll(): Promise<SkillListItemDto[]> {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(this.skillDir, { withFileTypes: true });
    } catch {
      // 目录不存在或不可读时返回空列表，避免公开接口 500
      return [];
    }

    const dirs = entries.filter((entry) => entry.isDirectory());
    const items = await Promise.all(
      dirs.map(async (dir) => {
        const filePath = path.resolve(this.skillDir, dir.name, 'SKILL.md');
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = matter(content);
          return this.toListItem(dir.name, parsed);
        } catch {
          // 目录下无 SKILL.md 或读取失败时跳过
          return null;
        }
      }),
    );

    return items.filter((item): item is SkillListItemDto => item !== null);
  }

  /**
   * 获取主 Skill 详情。
   *
   * @param name Skill 名称（URL 参数）
   * @returns Skill 详情
   * @throws NotFoundException Skill 不存在或路径非法
   */
  async findOne(name: string): Promise<SkillDetailDto> {
    const filePath = this.resolveSkillFile(name);
    return this.readDetail(filePath, name);
  }

  /**
   * 获取子 Skill 详情。
   *
   * @param name 父 Skill 名称
   * @param subpath 子 Skill 路径（如 taskboard、topics）
   * @returns 子 Skill 详情
   * @throws NotFoundException Skill 不存在或路径非法
   */
  async findSubSkill(name: string, subpath: string): Promise<SkillDetailDto> {
    const filePath = this.resolveSkillFile(name, subpath);
    return this.readDetail(filePath, subpath);
  }

  /**
   * 获取 Skill 原始 Markdown 内容。
   *
   * @param name Skill 名称
   * @returns 原始 Markdown 字符串
   * @throws NotFoundException Skill 不存在或路径非法
   */
  async getRaw(name: string): Promise<string> {
    const filePath = this.resolveSkillFile(name);
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      throw new NotFoundException({ message: 'Skill not found', code: ErrorCode.SKILL_NOT_FOUND });
    }
  }

  /**
   * 校验标识符是否符合白名单。
   *
   * @param identifier Skill 名称或子路径
   * @throws NotFoundException 校验失败时统一返回 404，避免泄露目录结构
   */
  private validateIdentifier(identifier: string): void {
    if (!identifier || !SKILL_NAME_PATTERN.test(identifier)) {
      throw new NotFoundException({ message: 'Skill not found', code: ErrorCode.SKILL_NOT_FOUND });
    }
  }

  /**
   * 解析并校验 Skill 文件路径。
   *
   * 先对 `name`（和可选的 `subpath`）做白名单校验，再用 `path.resolve` 计算真实路径，
   * 最后确认目标路径位于 `skillDir/:name/` 目录下，防止目录遍历攻击。
   *
   * @param name Skill 名称
   * @param subpath 可选的子 Skill 路径
   * @returns 校验通过的 SKILL.md 绝对路径
   * @throws NotFoundException 路径非法或不存在
   */
  private resolveSkillFile(name: string, subpath?: string): string {
    this.validateIdentifier(name);
    const skillBase = path.resolve(this.skillDir, name);
    const target = subpath
      ? path.resolve(skillBase, subpath, 'SKILL.md')
      : path.resolve(skillBase, 'SKILL.md');

    if (!target.startsWith(skillBase + path.sep)) {
      throw new NotFoundException({ message: 'Skill not found', code: ErrorCode.SKILL_NOT_FOUND });
    }

    return target;
  }

  /**
   * 读取 SKILL.md 并转换为详情 DTO。
   *
   * @param filePath SKILL.md 绝对路径
   * @param fallbackName frontmatter 中缺少 name 时的 fallback
   * @returns Skill 详情
   * @throws NotFoundException 文件读取失败
   */
  private async readDetail(filePath: string, fallbackName: string): Promise<SkillDetailDto> {
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      throw new NotFoundException({ message: 'Skill not found', code: ErrorCode.SKILL_NOT_FOUND });
    }

    const parsed = matter(content);
    return {
      ...this.toListItem(fallbackName, parsed),
      content: parsed.content,
    };
  }

  /**
   * 将 gray-matter 解析结果转换为列表项 DTO。
   *
   * @param fallbackName 目录名或子路径名
   * @param parsed gray-matter 解析结果
   * @returns Skill 列表项
   */
  private toListItem(fallbackName: string, parsed: GrayMatterFile<string>): SkillListItemDto {
    return {
      name: typeof parsed.data.name === 'string' ? parsed.data.name : fallbackName,
      description: typeof parsed.data.description === 'string' ? parsed.data.description : '',
      version: typeof parsed.data.version === 'string' ? parsed.data.version : '',
      updatedAt: this.toDateString(parsed.data.updatedAt),
    };
  }

  /**
   * 将 frontmatter 中的日期/字符串值统一转换为字符串。
   *
   * gray-matter 底层使用 js-yaml，会把 `2026-06-16` 解析为 Date 对象，
   * 因此需要同时处理 string 与 Date 两种类型。
   *
   * @param value frontmatter 字段值
   * @returns ISO 8601 字符串；无法解析时返回空字符串
   */
  private toDateString(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    if (typeof value === 'string') {
      return value;
    }
    return '';
  }
}
