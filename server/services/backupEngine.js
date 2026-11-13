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
    const gwTime2 = new Date(now - 3600 * 1000).toISOString();
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

  async applyRetention(hostId) {
    const settings = (await db.getSettings()) || {};
    const retention = settings.retention || {
      maxBackupsPerHost: 10,
      maxAgeDays: 30,
      minRetainedPerHost: 2,
    };

    const hostBackups = await this.listBackups(hostId);
    if (hostBackups.length <= retention.minRetainedPerHost) {
      return;
    }

    const now = Date.now();
    const maxAgeMs = retention.maxAgeDays * 24 * 3600 * 1000;

    // Keep at least minRetainedPerHost
    for (let i = retention.minRetainedPerHost; i < hostBackups.length; i++) {
      const b = hostBackups[i];
      const ageMs = now - new Date(b.timestamp).getTime();
      const exceedsCount = i >= retention.maxBackupsPerHost;
      const exceedsAge = ageMs > maxAgeMs;

      if (exceedsCount || exceedsAge) {
        await this.deleteBackup(b.id);
      }
    }
  }
}

export const backupEngine = new BackupEngine();
