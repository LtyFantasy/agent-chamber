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
      } | null;
    }
  }
}
export {};
