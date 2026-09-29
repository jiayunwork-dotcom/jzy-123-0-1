import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';
import { registerRoutes, Container } from './routes';
import { AppError } from '../errors';
import { AccountService } from '../application/accountService';
import { AccountView } from '../readmodel/accountView';
import { Projector } from '../readmodel/projector';

export interface BuildAppOptions {
  pool: Pool;
  /** 测试可注入小批量，模拟“分多批消费”的增量路径 */
  projectionBatchSize?: number;
  /** 测试可关闭/自定义 Fastify 日志 */
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(opts: BuildAppOptions): { app: FastifyInstance; container: Container } {
  const usePretty = process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY === '1';
  const app = Fastify({
    logger:
      opts.logger === undefined
        ? usePretty
          ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
          : { level: process.env.LOG_LEVEL ?? 'info' }
        : opts.logger,
  });

  app.register(cors, { origin: true });

  const projector = new Projector(opts.pool, undefined, opts.projectionBatchSize ?? 500);
  const container: Container = {
    pool: opts.pool,
    accountService: new AccountService(opts.pool, projector),
    accountView: new AccountView(opts.pool),
    projector,
  };

  registerRoutes(app, container);

  // 统一错误响应：{ error: { code, message, details? } }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn(error.message);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    // Fastify 请求体/schema 校验错误
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
        },
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: '内部错误' },
    });
  });

  return { app, container };
}
