import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic, readJson } from '../server/storage/atomic.js';
import { Database } from '../server/storage/db.js';

test('Storage: atomic write and read', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managor-storage-test-'));
  const testFile = path.join(tmpDir, 'test.json');

  try {
    const data = { hello: 'world', count: 42 };
    await writeJsonAtomic(testFile, data);

    const readBack = await readJson(testFile);
    assert.deepEqual(readBack, data);

    // Missing file returns defaultValue
    const missing = await readJson(path.join(tmpDir, 'nonexistent.json'), { fallback: true });
    assert.deepEqual(missing, { fallback: true });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Storage: database initialization and CRUD', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managor-db-test-'));
  const db = new Database(tmpDir);

  try {
    await db.init();

    const settings = await db.getSettings();
    assert.ok(settings);
    assert.equal(settings.demoMode, true);

    const schedules = await db.getSchedules();
    assert.ok(Array.isArray(schedules));
    assert.ok(schedules.length > 0);

    // Save custom settings
    await db.saveSettings({ ...settings, pollIntervalMs: 5000 });
    const updated = await db.getSettings();
    assert.equal(updated.pollIntervalMs, 5000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
