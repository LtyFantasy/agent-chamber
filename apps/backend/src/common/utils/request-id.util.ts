import { v4 as uuidv4 } from 'uuid';

export function generateRequestId(): string {
  return `req_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
}
