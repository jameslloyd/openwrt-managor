import test from 'node:test';
import assert from 'node:assert/strict';
import { createTarGz, extractTarGz, getFileContentFromTarGz, computeSha256 } from '../server/services/tarUci.js';

test('TarUci: create, inspect, extract, and hash', () => {
  const files = [
    { path: 'etc/config/network', content: 'config interface "lan"\n\toption ipaddr "192.168.1.1"\n' },
    { path: 'etc/config/wireless', content: 'config wifi-device "radio0"\n\toption channel "6"\n' },
    { path: 'etc/dropbear/authorized_keys', content: 'ssh-ed25519 AAAAC3... admin@truenas\n' },
  ];

  const archive = createTarGz(files);
  assert.ok(Buffer.isBuffer(archive));
  assert.ok(archive.length > 0);

  // Check SHA-256
  const sha = computeSha256(archive);
  assert.equal(typeof sha, 'string');
  assert.equal(sha.length, 64);

  // Inspect file manifest
  const manifest = extractTarGz(archive);
  assert.equal(manifest.length, 3);
  assert.equal(manifest[0].path, 'etc/config/network');
  assert.equal(manifest[0].isUci, true);
  assert.equal(manifest[1].path, 'etc/config/wireless');
  assert.equal(manifest[1].isUci, true);
  assert.equal(manifest[2].path, 'etc/dropbear/authorized_keys');
  assert.equal(manifest[2].isUci, false);

  // Extract single file content
  const content = getFileContentFromTarGz(archive, 'etc/config/network');
  assert.ok(content.includes('192.168.1.1'));

  const missing = getFileContentFromTarGz(archive, 'etc/config/nonexistent');
  assert.equal(missing, null);
});
