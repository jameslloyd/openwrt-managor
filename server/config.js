import path from 'node:path';
import fs from 'node:fs';

const rootDir = process.cwd();

// Helper to resolve writable directory with fallback
function resolveDirectory(envPath, fallbackRelPath) {
  if (envPath) {
    try {
      const resolved = path.resolve(envPath);
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      // Test write permissions
      const testFile = path.join(resolved, `.write_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return resolved;
    } catch (err) {
      console.error(`[openwrt-managor] Warning: Cannot write to configured directory "${envPath}" (${err.message}). Falling back to "./${fallbackRelPath}".`);
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
  singleCorePollIntervalMs: parseInt(process.env.SINGLE_CORE_POLL_INTERVAL_MS || '60000', 10),
  backupTimeoutMs: parseInt(process.env.BACKUP_TIMEOUT_MS || '30000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  publicDir: path.resolve(rootDir, 'public'),
  appVersion: '1.0.0',
};
