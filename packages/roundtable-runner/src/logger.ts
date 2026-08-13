/**
 * 轻量日志器（runner 独立进程，不依赖 NestJS Logger）
 *
 * 级别：debug < info < warn < error；info 为默认。
 * 输出：debug/info/warn → stdout，error → stderr（便于 shell 重定向分离）。
 */

/** 日志级别（阈值语义：设置 N 级则 N 及以上输出） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 级别数值序（阈值比较用） */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 日志器接口（driver/ws-client/core 全部经此输出，测试可注入静默实现） */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** ConsoleLogger 构造选项 */
export interface ConsoleLoggerOptions {
  /** 日志级别阈值（默认 info） */
  level?: LogLevel;
  /** 行前缀（如 '[roundtable-runner]'，默认空） */
  prefix?: string;
}

/** 输出到控制台的日志器实现 */
export class ConsoleLogger implements Logger {
  private readonly threshold: number;
  private readonly prefix: string;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.threshold = LEVEL_ORDER[options.level ?? 'info'];
    this.prefix = options.prefix ?? '';
  }

  /** 统一输出入口：低于阈值的行直接丢弃；error 走 stderr，其余走 stdout */
  private log(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const line = `[${new Date().toISOString()}]${this.prefix ? ` ${this.prefix}` : ''} [${level}] ${msg}`;
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  debug(msg: string): void {
    this.log('debug', msg);
  }

  info(msg: string): void {
    this.log('info', msg);
  }

  warn(msg: string): void {
    this.log('warn', msg);
  }

  error(msg: string): void {
    this.log('error', msg);
  }
}

/** 静默日志器（测试注入用：丢弃全部输出） */
export class NoopLogger implements Logger {
  debug(_msg: string): void {}
  info(_msg: string): void {}
  warn(_msg: string): void {}
  error(_msg: string): void {}
}
