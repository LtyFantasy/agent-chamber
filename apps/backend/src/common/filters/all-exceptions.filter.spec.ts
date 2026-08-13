import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: { method: string; url: string; headers: Record<string, string> };
  let mockHost: unknown;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockRequest = {
      method: 'GET',
      url: '/test',
      headers: {},
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    };
  });

  it('should use custom code from exception response when provided', () => {
    const exception = new BadRequestException({
      message: 'List is not empty',
      code: ErrorCode.LIST_NOT_EMPTY,
    });

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.LIST_NOT_EMPTY,
        message: 'List is not empty',
      }),
    );
  });

  it('should fallback to status-based code when no custom code provided', () => {
    const exception = new NotFoundException('Resource not found');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
      }),
    );
  });

  it('should extract message from object response correctly', () => {
    const exception = new BadRequestException({
      message: 'Topic is closed',
      code: ErrorCode.TOPIC_CLOSED,
    });

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Topic is closed',
      }),
    );
  });

  it('should handle string response (backward compatible)', () => {
    const exception = new UnauthorizedException('Token expired');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Token expired',
      }),
    );
  });

  it('should handle validation errors with array messages', () => {
    const exception = new BadRequestException({
      message: ['email must be an email', 'password is too short'],
      error: 'Bad Request',
    });

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    // 多条违规聚合到顶层 message（分号分隔），完整数组保留在 data.errors
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.BAD_REQUEST,
        message: 'email must be an email; password is too short',
        data: { errors: ['email must be an email', 'password is too short'] },
      }),
    );
  });

  it('should keep single validation error message without separator', () => {
    const exception = new BadRequestException({
      message: ['title should not be empty'],
      error: 'Bad Request',
    });

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.BAD_REQUEST,
        message: 'title should not be empty',
        data: { errors: ['title should not be empty'] },
      }),
    );
  });

  it('should include timestamp and requestId in response', () => {
    const exception = new BadRequestException('Bad request');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    const response = mockResponse.json.mock.calls[0][0];
    expect(response.timestamp).toBeDefined();
    expect(new Date(response.timestamp).getTime()).not.toBeNaN();
    expect(response.requestId).toBeDefined();
  });

  it('should map TypeORM EntityNotFoundError to 404 NOT_FOUND', () => {
    const exception = new EntityNotFoundError('User', 'user-1');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
      }),
    );
  });

  it('should map PostgreSQL UUID syntax error to 400 VALIDATION_ERROR', () => {
    const exception = new QueryFailedError(
      'SELECT',
      [],
      new Error('invalid input syntax for type uuid: "xyz"'),
    );

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid UUID format',
      }),
    );
  });

  it('should map PostgreSQL foreign key violation to 400 VALIDATION_ERROR', () => {
    const exception = new QueryFailedError(
      'INSERT',
      [],
      new Error('insert or update on table "tasks" violates foreign key constraint "fk_list_id"'),
    );

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid reference',
      }),
    );
  });

  it('should map PostgreSQL foreign key missing reference to 404 NOT_FOUND', () => {
    const driverError = new Error(
      'insert or update on table "tasks" violates foreign key constraint "fk_list_id"',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driverError as any).detail =
      'Key (list_id)=(00000000-0000-0000-0000-000000000000) is not present in table "board_lists".';
    const exception = new QueryFailedError('INSERT', [], driverError);

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NOT_FOUND,
        message: 'Referenced resource not found',
      }),
    );
  });

  it('should map PostgreSQL unique constraint violation to 409 CONFLICT', () => {
    const exception = new QueryFailedError(
      'INSERT',
      [],
      new Error('duplicate key value violates unique constraint "users_email_key"'),
    );

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RESOURCE_CONFLICT,
        message: 'Resource conflict',
      }),
    );
  });

  it('should map 409 CONFLICT to RESOURCE_CONFLICT when no custom code', () => {
    // 核心修复：HTTP 409 无自定义 code 时映射到 RESOURCE_CONFLICT 而非 BAD_REQUEST
    const exception = new ConflictException('Resource already exists');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RESOURCE_CONFLICT,
        message: 'Resource already exists',
      }),
    );
  });

  it('should map 400 to BAD_REQUEST when no custom code', () => {
    const exception = new BadRequestException('Invalid input');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.BAD_REQUEST,
        message: 'Invalid input',
      }),
    );
  });

  it('should map 404 to NOT_FOUND when no custom code', () => {
    const exception = new NotFoundException('Missing');

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NOT_FOUND,
        message: 'Missing',
      }),
    );
  });

  it('should map 429 to RATE_LIMITED when no custom code', () => {
    const exception = new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests',
      }),
    );
  });

  // ─── 日志降噪（P2 批次 A4）─────────────────────────────────
  describe('logging level by status', () => {
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('4xx 走 warn 且不带 stack（避免 driverError.detail 回显用户输入）', () => {
      const exception = new BadRequestException('Invalid input');

      filter.catch(exception, mockHost as unknown as ArgumentsHost);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      // warn 仅单参（消息），不传 stack
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('400'));
      expect(warnSpy.mock.calls[0]).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('映射为 4xx 的 QueryFailedError 也走 warn 无 stack', () => {
      const exception = new QueryFailedError(
        'SELECT',
        [],
        new Error('invalid input syntax for type uuid: "xyz"'),
      );

      filter.catch(exception, mockHost as unknown as ArgumentsHost);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('5xx 走 error 且带 stack', () => {
      const exception = new InternalServerErrorException('Boom');

      filter.catch(exception, mockHost as unknown as ArgumentsHost);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500'), expect.any(String));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('未知异常（默认 500）走 error 带 stack', () => {
      const exception = new Error('unexpected');

      filter.catch(exception, mockHost as unknown as ArgumentsHost);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500'), expect.any(String));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
