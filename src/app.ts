import cors from 'cors';
import express from 'express';
import { env } from './config/env';
import { healthRouter } from './routes/health';
import { sessionRouter } from './routes/session';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: false,
    })
  );
  app.use(express.json({ limit: '512kb' }));

  app.use(healthRouter);
  app.use(sessionRouter);

  return app;
}
