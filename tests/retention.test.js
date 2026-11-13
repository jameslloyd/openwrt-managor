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
