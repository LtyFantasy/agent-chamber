declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: { userId: string; email: string; role: string; name: string } | null;
      agent?: {
        id: string;
        name: string;
        ownerId: string;
        permissions: Record<string, unknown>;
        /**
         * 本次认证所用 API Key 前缀（`api-key-auth.service.ts` 装配，决策 9）。
         * 可选，且**仅前缀**——完整明文/hash 禁止进入本对象（审计与日志只消费前缀）。
         */
        keyPrefix?: string;
      } | null;
    }
  }
}
export {};
