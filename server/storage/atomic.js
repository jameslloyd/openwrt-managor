import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Atomically writes JSON data to disk using fsync and rename to prevent corruption.
 * @param {string} filePath - Target file path
 * @param {any} data - Object to serialize
 */
export async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify(data, null, 2);

  const fileHandle = await fs.open(tmpPath, 'w', 0o644);
  try {
    await fileHandle.writeFile(payload, 'utf8');
    await fileHandle.chmod(0o644).catch(() => {});
    await fileHandle.sync(); // Force write to physical disk
  } finally {
    await fileHandle.close();
  }

  await fs.rename(tmpPath, filePath); // Atomic replacement
}

/**
 * Safely reads a JSON file from disk. Returns defaultValue if file does not exist.
 * @param {string} filePath - Path to JSON file
 * @param {any} defaultValue - Value to return if missing
 */
export async function readJson(filePath, defaultValue = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    throw err;
  }
}
