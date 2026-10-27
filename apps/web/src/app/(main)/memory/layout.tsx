/**
 * Memory 列表、详情与 graph 共用的发行门；机制见线上
 * docs/integrations/oss-dual-repo.md §11。关闭时在服务端终止路由，避免直链挂载查询组件。
 */
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';

/** 关闭发行能力时返回标准 404；开启时保留各页面原有权限和查询行为。 */
export default function MemoryLayout({ children }: { children: ReactNode }) {
  if (!MEMORY_FEATURE_ENABLED) notFound();
  return children;
}
