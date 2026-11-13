import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './storage/db.js';
import { backupEngine } from './services/backupEngine.js';
import { hostManager } from './services/hostManager.js';
import { handleApiRequest } from './routes/api.js';
import { serveStatic } from './static.js';

export async function createServer() {
  await db.init();
  await backupEngine.init();
  await hostManager.init();
  hostManager.startPolling(config.pollIntervalMs);

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const searchParams = parsedUrl.searchParams;

      if (pathname.startsWith('/api/')) {
        const handled = await handleApiRequest(req, res, pathname, searchParams);
        if (handled) return;
      }

      await serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: true, message: err.message }));
      }
    }
  });

  return server;
}

// Check if running as main module
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  createServer()
    .then((server) => {
      server.listen(config.port, () => {
        console.log(`[openwrt-managor] Server running on port ${config.port}`);
        console.log(`[openwrt-managor] Data dir: ${config.dataDir}`);
        console.log(`[openwrt-managor] Backup dir: ${config.backupDir}`);
      });

      const shutdown = () => {
        console.log('[openwrt-managor] Graceful shutdown initiated...');
        hostManager.stopPolling();
        server.close(() => {
          console.log('[openwrt-managor] Server closed.');
          process.exit(0);
        });
      };

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error('[openwrt-managor] Fatal startup error:', err);
      process.exit(1);
    });
}
