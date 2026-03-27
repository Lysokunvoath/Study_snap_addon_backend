import http from 'http';
import { WebSocketServer } from 'ws';
import { createApp } from './app';
import { handleTranscribeConnection } from './ws/transcribeSocket';

export function createHttpServer(): http.Server {
  const app = createApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';

    if (!url.startsWith('/ws/transcribe')) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTranscribeConnection(ws, req);
    });
  });

  return server;
}
