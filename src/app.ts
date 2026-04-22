import cors from 'cors';
import express from 'express';
import { env } from './config/env';
import { healthRouter } from './routes/health';
import { sessionRouter } from './routes/session';
import { googleSyncRouter } from './routes/googleSync';
import { transcriptRouter } from './routes/transcript';
import { meetingBaasRouter } from './routes/meetingBaas';
import { studyRouter } from './routes/study';

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
  app.use(googleSyncRouter);
  app.use(transcriptRouter);
  app.use(meetingBaasRouter);
  app.use(studyRouter);

  return app;
}
