import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../storage/db.js';
import { writeJsonAtomic, readJson } from '../storage/atomic.js';
import { extractTarGz, getFileContentFromTarGz, computeSha256 } from './tarUci.js';
import { computeDiff } from './diffEngine.js';
import { simulator } from './simulator.js';
import { execSshCommand } from './realUbus.js';

export class BackupEngine {
  constructor(backupDir = config.backupDir) {
    this.backupDir = backupDir;
    this.schedulerTimer = null;
    this.isRunningSchedule = false;
  }

  /**
   * Matches a single cron field (minute, hour, day-of-month, month, day-of-week).
   */
  matchCronField(fieldExpr, value) {
    if (!fieldExpr || fieldExpr === '*') return true;
    const parts = String(fieldExpr).split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === '*') return true;
      if (trimmed.startsWith('*/')) {
        const step = parseInt(trimmed.slice(2), 10);
        if (Number.isFinite(step) && step > 0 && value % step === 0) return true;
      } else {
        const num = parseInt(trimmed, 10);
        if (Number.isFinite(num) && num === value) return true;
      }
    }
    return false;
  }

  /**
   * Computes the next UTC run timestamp for a 5-field cron expression (min hour dom month dow).
   */
  computeNextRun(cronExpr = '0 3 * * *', fromDate = new Date()) {
    const fields = String(cronExpr || '0 3 * * *').trim().split(/\s+/);
    if (fields.length < 5) {
      return new Date(fromDate.getTime() + 24 * 3600 * 1000).toISOString();
    }
    const [minField, hourField, domField, monthField, dowField] = fields;

    // Start searching at the next whole UTC minute
    const startMs = Math.floor(fromDate.getTime() / 60000) * 60000 + 60000;
    const maxMinutes = 8 * 24 * 60; // Search up to 8 days ahead

    for (let i = 0; i < maxMinutes; i++) {
      const candidate = new Date(startMs + i * 60000);
      const min = candidate.getUTCMinutes();
      if (!this.matchCronField(minField, min)) continue;

      const hour = candidate.getUTCHours();
      if (!this.matchCronField(hourField, hour)) continue;

      const dom = candidate.getUTCDate();
      if (!this.matchCronField(domField, dom)) continue;

      const month = candidate.getUTCMonth() + 1;
      if (!this.matchCronField(monthField, month)) continue;

      const dow = candidate.getUTCDay();
      if (!this.matchCronField(dowField, dow)) continue;

      return candidate.toISOString();
    }

    return new Date(fromDate.getTime() + 24 * 3600 * 1000).toISOString();
  }

  startScheduler(checkIntervalMs = 30000) {
    this.stopScheduler();
    this.schedulerTimer = setInterval(() => {
      this.checkDueSchedules().catch(() => {});
    }, checkIntervalMs);
    if (this.schedulerTimer.unref) {
      this.schedulerTimer.unref();
    }
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async checkDueSchedules(now = new Date()) {
    if (this.isRunningSchedule) return [];
    this.isRunningSchedule = true;
    const executed = [];
    try {
      const schedules = (await db.getSchedules()) || [];
      let modified = false;

      for (const sched of schedules) {
        if (sched.enabled === false) continue;
        const nextRunMs = sched.nextRun ? new Date(sched.nextRun).getTime() : 0;
        if (!nextRunMs || Number.isNaN(nextRunMs)) {
          sched.nextRun = this.computeNextRun(sched.cron, now);
          modified = true;
          continue;
        }
        if (now.getTime() >= nextRunMs) {
          const target = sched.targets && sched.targets.length === 1 ? sched.targets[0] : 'all';
          await this.runBackup(target, 'scheduled');
          sched.lastRun = now.toISOString();
          sched.nextRun = this.computeNextRun(sched.cron, now);
          modified = true;
          executed.push(sched.id);
        }
      }

      if (modified) {
        await db.saveSchedules(schedules);
      }
    } finally {
      this.isRunningSchedule = false;
    }
    return executed;
  }

  async init(seedDemo = false) {
    await fs.mkdir(this.backupDir, { recursive: true });
    if (seedDemo === true) {
      await this.seedDemoBackups();
    } else {
      await this.removeDemoBackups();
    }
  }

  /**
   * Removes demo backup archives and directories for simulated hosts.
   */
  async removeDemoBackups(simHostIds = null) {
    const defaultDemoIds = simulator.getHosts().map((h) => h.id);
    const targetIds = Array.from(new Set([...defaultDemoIds, ...(simHostIds || [])]));
    const resolvedBackupDir = path.resolve(this.backupDir);

    for (const hostId of targetIds) {
      try {
        this.validateHostId(hostId);
        const safeHostDir = path.resolve(resolvedBackupDir, hostId);
        if (safeHostDir.startsWith(resolvedBackupDir + path.sep)) {
          await fs.rm(safeHostDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors for missing dirs
      }
    }
  }

  /**
   * Seeds demo backups for immediate out-of-the-box evaluation.
   */
  async seedDemoBackups() {
    const existing = await this.listBackups();
    if (existing.length > 0) {
      return; // Already seeded or has backups
    }

    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;

    // 1. node-gw-01: Baseline backup from yesterday (versionOffset = 0)
    const gwTime1 = new Date(now - dayMs).toISOString();
    await this.createSimulatedBackup('node-gw-01', gwTime1, 0, 'scheduled');

    // 2. node-gw-01: Current backup from today with realistic diffs (versionOffset = 1)
    const gwTime2 = new Date(now).toISOString();
    await this.createSimulatedBackup('node-gw-01', gwTime2, 1, 'manual');

    // 3. node-ap-01 backup
    const ap1Time = new Date(now - 2 * 3600 * 1000).toISOString();
    await this.createSimulatedBackup('node-ap-01', ap1Time, 0, 'scheduled');

    // 4. node-ap-02 backup
    const ap2Time = new Date(now - 3 * 3600 * 1000).toISOString();
    await this.createSimulatedBackup('node-ap-02', ap2Time, 0, 'scheduled');

    // 5. node-ap-03 backup
    const ap3Time = new Date(now - 4 * 3600 * 1000).toISOString();
    await this.createSimulatedBackup('node-ap-03', ap3Time, 0, 'scheduled');
  }

  validateHostId(hostId) {
    if (!hostId || typeof hostId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
      throw new Error('Invalid host identifier');
    }
  }

  formatTimestampForFilename(isoString) {
    return isoString.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 'T') + 'Z';
  }

  async createSimulatedBackup(hostId, timestamp = new Date().toISOString(), versionOffset = 0, triggerType = 'manual') {
    this.validateHostId(hostId);
    const dbHosts = (await db.getHosts()) || [];
    const host = dbHosts.find((h) => h.id === hostId) || simulator.getHost(hostId);
    const hostName = host ? host.name : hostId;

    let archiveBuffer = null;
    let sha256 = null;
    let sizeBytes = 0;
    let filesCount = 0;
    let filesList = [];

    // Try pulling a real backup archive over SSH if host is a real router with SSH credentials
    if (host && !host.isSimulated && host.ip && (host.password || host.sshPrivateKey)) {
      try {
        const { stdout } = await execSshCommand(
          host,
          'sysupgrade -b - 2>/dev/null || tar -czf - -C / etc/config etc/dropbear etc/passwd etc/shadow etc/hosts 2>/dev/null',
          { timeoutMs: 15000, binary: true }
        );
        if (Buffer.isBuffer(stdout) && stdout.length > 32 && stdout[0] === 0x1f && stdout[1] === 0x8b) {
          const extracted = extractTarGz(stdout, false);
          if (Array.isArray(extracted) && extracted.length > 0) {
            archiveBuffer = stdout;
            sha256 = computeSha256(archiveBuffer);
            sizeBytes = archiveBuffer.length;
            filesCount = extracted.length;
            filesList = extracted.map((f) => f.path);
          }
        }
      } catch {
        // Fallback to generated archive if SSH backup fails (e.g. offline test hosts)
      }
    }

    if (!archiveBuffer) {
      const mock = simulator.generateMockArchive(hostId, versionOffset, host);
      archiveBuffer = mock.archiveBuffer;
      sha256 = mock.sha256;
      sizeBytes = mock.sizeBytes;
      filesCount = mock.filesCount;
      filesList = mock.filesList;
    }

    const resolvedBackupDir = path.resolve(this.backupDir);
    const safeHostDir = path.resolve(resolvedBackupDir, hostId);
    if (!safeHostDir.startsWith(resolvedBackupDir + path.sep)) {
      throw new Error('Path traversal detected');
    }
    await fs.mkdir(safeHostDir, { recursive: true });

    const timeFormatted = this.formatTimestampForFilename(timestamp);
    const filename = `${timeFormatted}_${hostId}_openwrt.tar.gz`;
    const archivePath = path.resolve(safeHostDir, filename);
    const metaPath = path.resolve(safeHostDir, `${filename.replace('.tar.gz', '')}.meta.json`);

    const id = `bak-${hostId}-${timeFormatted}`;
    const meta = {
      id,
      hostId,
      hostName,
      filename,
      timestamp,
      sizeBytes,
      sha256,
      openwrtVersion: host ? host.firmware : 'OpenWrt 23.05.4',
      target: host ? host.model : 'x86/64',
      triggerType,
      filesCount,
      status: 'success',
      filesList,
    };

    await fs.writeFile(archivePath, archiveBuffer);
    await writeJsonAtomic(metaPath, meta);

    // Apply retention pruning
    await this.applyRetention(hostId);

    return meta;
  }

  async listBackups(filterHostId = null) {
    if (filterHostId) {
      this.validateHostId(filterHostId);
    }
    const results = [];
    try {
      const hostDirs = await fs.readdir(this.backupDir, { withFileTypes: true });
      for (const entry of hostDirs) {
        if (!entry.isDirectory()) continue;
        const hostId = entry.name;
        if (filterHostId && hostId !== filterHostId) continue;

        const hostDirPath = path.join(this.backupDir, hostId);
        const files = await fs.readdir(hostDirPath);

        for (const file of files) {
          if (file.endsWith('.meta.json')) {
            const meta = await readJson(path.join(hostDirPath, file), null);
            if (meta) {
              results.push(meta);
            }
          }
        }
      }
    } catch {
      // return empty array if dir missing
    }

    // Sort newest first
    return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async getBackupMeta(backupId) {
    const all = await this.listBackups();
    return all.find((b) => b.id === backupId) || null;
  }

  async getBackupBuffer(backupId) {
    const meta = await this.getBackupMeta(backupId);
    if (!meta) return null;

    const resolvedBackupDir = path.resolve(this.backupDir);
    const archivePath = path.resolve(resolvedBackupDir, meta.hostId, meta.filename);
    if (!archivePath.startsWith(resolvedBackupDir + path.sep)) {
      throw new Error('Path traversal detected');
    }

    try {
      return await fs.readFile(archivePath);
    } catch {
      return null;
    }
  }

  async deleteBackup(backupId) {
    const meta = await this.getBackupMeta(backupId);
    if (!meta) return false;

    const resolvedBackupDir = path.resolve(this.backupDir);
    const archivePath = path.resolve(resolvedBackupDir, meta.hostId, meta.filename);
    const metaPath = path.resolve(resolvedBackupDir, meta.hostId, `${meta.filename.replace('.tar.gz', '')}.meta.json`);
    if (!archivePath.startsWith(resolvedBackupDir + path.sep) || !metaPath.startsWith(resolvedBackupDir + path.sep)) {
      throw new Error('Path traversal detected');
    }

    try {
      await fs.unlink(archivePath);
    } catch {}
    try {
      await fs.unlink(metaPath);
    } catch {}

    return true;
  }

  async getBackupFiles(backupId) {
    const buf = await this.getBackupBuffer(backupId);
    if (!buf) return null;
    return extractTarGz(buf, false);
  }

  async getBackupFileContent(backupId, targetPath) {
    if (!targetPath || targetPath.includes('..')) {
      throw new Error('Invalid file path');
    }
    const buf = await this.getBackupBuffer(backupId);
    if (!buf) return null;
    return getFileContentFromTarGz(buf, targetPath);
  }

  async diffBackups(backupIdA, backupIdB, filePath) {
    if (!filePath || filePath.includes('..')) {
      throw new Error('Invalid file path');
    }
    const metaA = await this.getBackupMeta(backupIdA);
    const metaB = await this.getBackupMeta(backupIdB);
    if (!metaA || !metaB) {
      throw new Error('One or both backups not found');
    }

    const contentA = (await this.getBackupFileContent(backupIdA, filePath)) || '';
    const contentB = (await this.getBackupFileContent(backupIdB, filePath)) || '';

    const diffResult = computeDiff(contentA, contentB);

    return {
      file: filePath,
      backupA: { id: metaA.id, timestamp: metaA.timestamp },
      backupB: { id: metaB.id, timestamp: metaB.timestamp },
      hasDifferences: diffResult.hasDifferences,
      hunks: diffResult.hunks,
    };
  }

  async runBackup(hostId, triggerType = 'manual') {
    const jobId = `job-bak-${Date.now()}`;
    let targetHosts = [hostId];
    if (hostId === 'all') {
      const dbHosts = (await db.getHosts()) || [];
      targetHosts = dbHosts.map((h) => h.id);
    }

    const results = [];
    for (const id of targetHosts) {
      const backupMeta = await this.createSimulatedBackup(id, new Date().toISOString(), 0, triggerType);
      results.push({
        id: backupMeta.id,
        hostId: backupMeta.hostId,
        filename: backupMeta.filename,
        sizeBytes: backupMeta.sizeBytes,
        sha256: backupMeta.sha256,
        status: 'success',
      });
    }

    return {
      jobId,
      status: 'completed',
      backups: results,
    };
  }

  getUtcDateKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  getUtcMonthKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  getUtcYearKey(date) {
    return `${date.getUTCFullYear()}`;
  }

  /**
   * Evaluates GFS (Grandfather-Father-Son) retention for a host's backups:
   * Keeps the newest:
   *  - 7 daily backups (keepDaily = 7)
   *  - 4 weekly backups (keepWeekly = 4)
   *  - 6 monthly backups (keepMonthly = 6)
   *  - 1 yearly backup (keepYearly = 1)
   * Backups outside of this retention policy are marked for deletion.
   */
  evaluateGfsRetention(backups = [], policy = {}) {
    const keepDaily = Number.isFinite(Number(policy.keepDaily))
      ? Math.max(0, Math.round(Number(policy.keepDaily)))
      : 7;
    const keepWeekly = Number.isFinite(Number(policy.keepWeekly))
      ? Math.max(0, Math.round(Number(policy.keepWeekly)))
      : 4;
    const keepMonthly = Number.isFinite(Number(policy.keepMonthly))
      ? Math.max(0, Math.round(Number(policy.keepMonthly)))
      : 6;
    const keepYearly = Number.isFinite(Number(policy.keepYearly))
      ? Math.max(0, Math.round(Number(policy.keepYearly)))
      : 1;

    const sorted = [...backups].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 1. Pick the newest backup for each distinct UTC calendar day (older same-day backups are pruned)
    const seenDays = new Set();
    const dailyRepresentatives = [];
    for (const b of sorted) {
      const dt = new Date(b.timestamp);
      if (Number.isNaN(dt.getTime())) continue;
      const dayKey = this.getUtcDateKey(dt);
      if (!seenDays.has(dayKey)) {
        seenDays.add(dayKey);
        dailyRepresentatives.push({ backup: b, date: dt });
      }
    }

    const tierById = new Map();

    // 2. Keep newest N daily backups (default 7)
    for (const entry of dailyRepresentatives) {
      if (tierById.size >= keepDaily) break;
      tierById.set(entry.backup.id, 'daily');
    }

    // 3. Keep newest N weekly backups (default 4) from older daily representatives
    const seenWeeks = new Set();
    for (const entry of dailyRepresentatives) {
      if (tierById.has(entry.backup.id)) continue;
      if (seenWeeks.size >= keepWeekly) break;
      const weekKey = this.getIsoWeekKey(entry.date);
      if (!seenWeeks.has(weekKey)) {
        seenWeeks.add(weekKey);
        tierById.set(entry.backup.id, 'weekly');
      }
    }

    // 4. Keep newest N monthly backups (default 6) from older daily representatives
    const seenMonths = new Set();
    for (const entry of dailyRepresentatives) {
      if (tierById.has(entry.backup.id)) continue;
      if (seenMonths.size >= keepMonthly) break;
      const monthKey = this.getUtcMonthKey(entry.date);
      if (!seenMonths.has(monthKey)) {
        seenMonths.add(monthKey);
        tierById.set(entry.backup.id, 'monthly');
      }
    }

    // 5. Keep newest N yearly backups (default 1) from older daily representatives
    const seenYears = new Set();
    for (const entry of dailyRepresentatives) {
      if (tierById.has(entry.backup.id)) continue;
      if (seenYears.size >= keepYearly) break;
      const yearKey = this.getUtcYearKey(entry.date);
      if (!seenYears.has(yearKey)) {
        seenYears.add(yearKey);
        tierById.set(entry.backup.id, 'yearly');
      }
    }

    const kept = [];
    const deleted = [];
    for (const b of sorted) {
      if (tierById.has(b.id)) {
        kept.push(b);
      } else {
        deleted.push(b);
      }
    }

    return { kept, deleted, tierById };
  }

  async applyRetention(hostId) {
    const settings = (await db.getSettings()) || {};
    const schedules = (await db.getSchedules()) || [];
    const primarySched = schedules[0] || {};
    const ret = settings.retention || {};

    const policy = {
      keepDaily: primarySched.keepDaily ?? ret.keepDaily ?? 7,
      keepWeekly: primarySched.keepWeekly ?? ret.keepWeekly ?? 4,
      keepMonthly: primarySched.keepMonthly ?? ret.keepMonthly ?? 6,
      keepYearly: primarySched.keepYearly ?? ret.keepYearly ?? 1,
    };

    const hostBackups = await this.listBackups(hostId);
    if (hostBackups.length === 0) {
      return;
    }

    const { kept, deleted, tierById } = this.evaluateGfsRetention(hostBackups, policy);

    for (const b of deleted) {
      await this.deleteBackup(b.id);
    }

    // Persist retentionTier ('daily' | 'weekly' | 'monthly' | 'yearly') on kept backup metadata
    const resolvedBackupDir = path.resolve(this.backupDir);
    for (const b of kept) {
      const tier = tierById.get(b.id);
      if (tier && b.retentionTier !== tier && b.filename) {
        b.retentionTier = tier;
        const metaPath = path.resolve(
          resolvedBackupDir,
          b.hostId,
          `${b.filename.replace('.tar.gz', '')}.meta.json`
        );
        if (metaPath.startsWith(resolvedBackupDir + path.sep)) {
          try {
            await writeJsonAtomic(metaPath, b);
          } catch {}
        }
      }
    }
  }

  async applyAllRetention() {
    try {
      const hostDirs = await fs.readdir(this.backupDir, { withFileTypes: true });
      for (const entry of hostDirs) {
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) {
          await this.applyRetention(entry.name);
        }
      }
    } catch {
      // ignore if backupDir doesn't exist yet
    }
  }
}

export const backupEngine = new BackupEngine();
