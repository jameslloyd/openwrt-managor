import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

/**
 * Serves static files from public/ with security checks and SPA fallback.
 */
export async function serveStatic(req, res, pathname) {
  const publicDir = config.publicDir;

  // Check for raw traversal attempts
  if (req.url.includes('..') || pathname.includes('..') || req.url.includes('%2e') || req.url.includes('%2E')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: Path Traversal Detected');
    return true;
  }

  // Normalize requested path
  let reqPath = decodeURIComponent(pathname);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  // Prevent directory traversal and sibling directory escapes
  const resolvedPublic = path.resolve(publicDir);
  const safePath = path.resolve(resolvedPublic, '.' + (reqPath.startsWith('/') ? reqPath : '/' + reqPath));
  if (safePath !== resolvedPublic && !safePath.startsWith(resolvedPublic + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: Path Traversal Detected');
    return true;
  }

  const ext = path.extname(safePath).toLowerCase();

  // Try serving requested file
  try {
    const stat = await fs.stat(safePath);
    if (stat.isFile()) {
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await fs.readFile(safePath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(content);
      return true;
    }
  } catch (err) {
    // File not found on disk
  }

  // SPA Fallback for client-side page routing (e.g. /overview, /topology, etc. requesting HTML)
  const isHtmlNavigation =
    req.headers.accept?.includes('text/html') &&
    ['/overview', '/topology', '/clients', '/wifi', '/backups', '/nodes', '/settings'].includes(pathname);

  if (isHtmlNavigation) {
    const indexPath = path.join(publicDir, 'index.html');
    try {
      const indexContent = await fs.readFile(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': indexContent.length,
        'Cache-Control': 'no-cache',
      });
      res.end(indexContent);
      return true;
    } catch {
      // index.html missing
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
  return true;
}
