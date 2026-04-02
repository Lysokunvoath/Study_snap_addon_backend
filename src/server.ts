import { env } from './config/env';
import { logger } from './utils/logger';
import { createHttpServer } from './createServer';

const server = createHttpServer();

server.listen(env.port, () => {
  logger.info('Backend server listening', {
    port: env.port,
    nodeEnv: env.nodeEnv,
    asrProvider: 'google-cloud',
  });
});
