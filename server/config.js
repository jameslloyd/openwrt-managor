import path from 'node:path';
import fs from 'node:fs';

const rootDir = process.cwd();

// Helper to resolve writable directory with fallback
function resolveDirectory(envPath, fallbackRelPath) {
  if (envPath) {
    try {
      if (!fs.existsSync(envPath)) {
        fs.mkdirSync(envPath, { recursive: true });
      }
      // Test write permissions
      const testFile = path.join(envPath, `.write_test_${Date.now()}`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return path.resolve(envPath);
    } catch {
      // Fall through to local fallback
    }
  }
  const localFallback = path.resolve(rootDir, fallbackRelPath);
  if (!fs.existsSync(localFallback)) {
    fs.mkdirSync(localFallback, { recursive: true });
  }
  return localFallback;
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: resolveDirectory(process.env.DATA_DIR, 'data'),
  backupDir: resolveDirectory(process.env.BACKUP_DIR, 'backups'),
  demoMode: false,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  backupTimeoutMs: parseInt(process.env.BACKUP_TIMEOUT_MS || '30000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  publicDir: path.resolve(rootDir, 'public'),
  appVersion: '1.0.0',
};
