import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BackupEngine } from '../server/services/backupEngine.js';

test('Retention: seeds backups and respects retention limits', async () => {
  const tmpBackupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managor-bak-test-'));
  const engine = new BackupEngine(tmpBackupDir);

  try {
    // Seed demo backups
    await engine.init(true);

    const backups = await engine.listBackups();
    assert.ok(backups.length >= 5);

    // Filter by node-gw-01
    const gwBackups = await engine.listBackups('node-gw-01');
    assert.ok(gwBackups.length >= 2);

    // Diff between the two gw-01 backups
    const diff = await engine.diffBackups(gwBackups[1].id, gwBackups[0].id, 'etc/config/network');
    assert.equal(diff.hasDifferences, true);
    assert.ok(diff.hunks.length > 0);

    // Delete one backup
    const deleted = await engine.deleteBackup(gwBackups[0].id);
    assert.equal(deleted, true);

    const afterDelete = await engine.listBackups('node-gw-01');
    assert.equal(afterDelete.length, gwBackups.length - 1);
  } finally {
    await fs.rm(tmpBackupDir, { recursive: true, force: true });
  }
});

test('GFS Retention: keeps newest 7 daily, 4 weekly, 6 monthly, and 1 yearly backups and deletes all others', async () => {
  const tmpBackupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managor-gfs-test-'));
  const engine = new BackupEngine(tmpBackupDir);

  try {
    // Generate 30+ synthetic backup timestamps spanning:
    //  - 2 same-day backups on 2026-11-17 (only newest should be kept)
    //  - 9 daily backups from 2026-11-09 to 2026-11-17
    //  - 6 weekly backups across October/September 2026
    //  - 8 monthly backups across 2026/2025
    //  - 3 yearly backups across 2024, 2023, 2022
    const timestamps = [
      // Same-day duplicate on 2026-11-17
      '2026-11-17T18:00:00Z',
      '2026-11-17T03:00:00Z',
      // Remaining 6 newest daily backups (total 7 dailies: Nov 11..17)
      '2026-11-16T03:00:00Z',
      '2026-11-15T03:00:00Z',
      '2026-11-14T03:00:00Z',
      '2026-11-13T03:00:00Z',
      '2026-11-12T03:00:00Z',
      '2026-11-11T03:00:00Z',
      // Extra daily in same week as Nov 11 (2026-W46) -> Nov 10 becomes weekly #1 (W46), Nov 09 is pruned
      '2026-11-10T03:00:00Z',
      '2026-11-09T03:00:00Z',
      // Weekly backups in prior weeks (W45, W44, W43, W42, W41)
      '2026-11-03T03:00:00Z', // W45 (weekly #2)
      '2026-10-27T03:00:00Z', // W44 (weekly #3)
      '2026-10-20T03:00:00Z', // W43 (weekly #4)
      '2026-10-13T03:00:00Z', // W42 (becomes monthly #1 for 2026-10)
      '2026-10-06T03:00:00Z', // W41 (same month 2026-10 -> pruned!)
      // Monthly backups across prior months
      '2026-09-15T03:00:00Z', // 2026-09 (monthly #2)
      '2026-09-01T03:00:00Z', // 2026-09 duplicate -> pruned!
      '2026-08-15T03:00:00Z', // 2026-08 (monthly #3)
      '2026-07-15T03:00:00Z', // 2026-07 (monthly #4)
      '2026-06-15T03:00:00Z', // 2026-06 (monthly #5)
      '2026-05-15T03:00:00Z', // 2026-05 (monthly #6)
      '2026-04-15T03:00:00Z', // 2026-04 (becomes yearly #1 for 2026)
      '2026-03-15T03:00:00Z', // 2026-03 (same year 2026 -> pruned!)
      // Older years -> pruned since keepYearly = 1
      '2025-12-15T03:00:00Z',
      '2024-12-15T03:00:00Z',
    ];

    for (const ts of timestamps) {
      await engine.createSimulatedBackup('node-gw-01', ts, 0, 'scheduled');
    }

    const retained = await engine.listBackups('node-gw-01');
    const dailyCount = retained.filter((b) => b.retentionTier === 'daily').length;
    const weeklyCount = retained.filter((b) => b.retentionTier === 'weekly').length;
    const monthlyCount = retained.filter((b) => b.retentionTier === 'monthly').length;
    const yearlyCount = retained.filter((b) => b.retentionTier === 'yearly').length;

    assert.equal(dailyCount, 7, 'Should keep exactly 7 daily backups');
    assert.equal(weeklyCount, 4, 'Should keep exactly 4 weekly backups');
    assert.equal(monthlyCount, 6, 'Should keep exactly 6 monthly backups');
    assert.equal(yearlyCount, 1, 'Should keep exactly 1 yearly backup');
    assert.equal(retained.length, 18, 'Should delete all backups outside 7d/4w/6m/1y retention');

    // Verify newest of 2026-11-17 was kept and 03:00 was deleted
    assert.ok(retained.some((b) => b.timestamp === '2026-11-17T18:00:00Z'));
    assert.ok(!retained.some((b) => b.timestamp === '2026-11-17T03:00:00Z'));
  } finally {
    await fs.rm(tmpBackupDir, { recursive: true, force: true });
  }
});
