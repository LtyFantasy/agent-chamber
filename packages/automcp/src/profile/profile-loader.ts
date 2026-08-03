/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/automcp.md §4
 *   - 补充: AGENTS.md §7 (关键数字速查)
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { ToolProfile } from '../types';

/**
 * 默认 profile 搜索路径（按优先级排序）
 *
 * 为了同时覆盖通用场景和本项目的目录结构，--profile <name> 会依次查找：
 *   1. <cwd>/config/mcp-profiles/<name>.json
 *   2. <cwd>/apps/backend/config/mcp-profiles/<name>.json
 *   3. <cwd>/mcp-profiles/<name>.json
 */
const PROFILE_SEARCH_DIRS = [
  path.join('config', 'mcp-profiles'),
  path.join('apps', 'backend', 'config', 'mcp-profiles'),
  path.join('mcp-profiles'),
];

/**
 * 将 profile 名称解析为实际文件路径
 *
 * @param name - profile 名称（如 agent）
 * @param cwd - 当前工作目录，默认 process.cwd()
 * @returns 存在的 profile 文件绝对路径
 * @throws 当所有候选路径都不存在时抛出错误
 */
export function resolveProfilePath(name: string, cwd = process.cwd()): string {
  const fileName = `${name}.json`;
  const candidates = PROFILE_SEARCH_DIRS.map((dir) => path.resolve(cwd, dir, fileName));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Profile "${name}" not found. Searched paths:\n${candidates.map((p) => `  - ${p}`).join('\n')}`,
  );
}

/**
 * 从 JSON 文件加载 ToolProfile
 *
 * @param profilePath - profile 文件路径
 * @returns 解析后的 ToolProfile
 * @throws 当文件读取失败或 JSON 非法时抛出错误
 */
export async function loadProfile(profilePath: string): Promise<ToolProfile> {
  let raw: string;
  try {
    raw = await readFile(profilePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read profile at "${profilePath}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in profile "${profilePath}": ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Profile "${profilePath}" must be a JSON object, got ${typeof parsed}`);
  }

  const profile = parsed as Record<string, unknown>;

  return {
    name: typeof profile.name === 'string' ? profile.name : undefined,
    description: typeof profile.description === 'string' ? profile.description : undefined,
    tags: parseStringArray(profile.tags, 'tags'),
    include: parseStringArray(profile.include, 'include'),
    exclude: parseStringArray(profile.exclude, 'exclude'),
  };
}

/**
 * 解析 profile 中的字符串数组字段
 */
function parseStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Profile field "${fieldName}" must be an array of strings`);
  }

  const result = value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`Profile field "${fieldName}" must be an array of strings`);
    }
    return item;
  });

  return result.length > 0 ? result : undefined;
}
