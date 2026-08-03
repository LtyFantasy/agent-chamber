import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSFORM_KEY = 'skipTransform';

/**
 * 跳过 ResponseInterceptor 的统一包装，直接返回裸数据。
 * 用于健康检查、文件下载等不需要 { code, message, data } 结构的场景。
 */
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM_KEY, true);
