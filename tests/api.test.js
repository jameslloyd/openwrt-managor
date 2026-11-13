import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server/index.js';
import { hostManager } from '../server/services/hostManager.js';

let server;
let baseUrl;

test.before(async () => {
  server = await createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  hostManager.stopPolling();
  await new Promise((resolve) => server.close(resolve));
});

test('API: GET /api/health returns healthy container status', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'healthy');
  assert.equal(typeof data.uptimeSec, 'number');
  assert.equal(data.storage.dataDirOk, true);
  assert.equal(data.storage.backupDirOk, true);
});

test('API: GET /api/system/info returns node runtime statistics', async () => {
  const res = await fetch(`${baseUrl}/api/system/info`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.app, 'OpenWrt Manager');
  assert.ok(data.nodeVersion);
  assert.ok(data.memoryUsage.rssBytes > 0);
});

test('API: GET and PUT /api/settings', async () => {
  const getRes = await fetch(`${baseUrl}/api/settings`);
  assert.equal(getRes.status, 200);
  const current = await getRes.json();
  assert.ok(current.retention);

  const putRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pollIntervalMs: 12000 }),
  });
  assert.equal(putRes.status, 200);
  const updated = await putRes.json();
  assert.equal(updated.pollIntervalMs, 12000);
});

test('API: Hosts CRUD and test probes', async () => {
  // Test unsaved host connection
  const probeRes = await fetch(`${baseUrl}/api/hosts/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '192.168.1.1', isSimulated: true }),
  });
  assert.equal(probeRes.status, 200);
  const probeData = await probeRes.json();
  assert.equal(probeData.success, true);
  assert.equal(probeData.ubusConnected, true);

  // List hosts
  const listRes = await fetch(`${baseUrl}/api/hosts`);
  assert.equal(listRes.status, 200);
  const hosts = await listRes.json();
  assert.ok(Array.isArray(hosts));
  assert.ok(hosts.length >= 4);

  // Get single host
  const singleRes = await fetch(`${baseUrl}/api/hosts/node-gw-01`);
  assert.equal(singleRes.status, 200);
  const host = await singleRes.json();
  assert.equal(host.id, 'node-gw-01');

  // Test single host probe
  const testRes = await fetch(`${baseUrl}/api/hosts/node-gw-01/test`, { method: 'POST' });
  assert.equal(testRes.status, 200);
  const testData = await testRes.json();
  assert.equal(testData.success, true);

  // Create new host
  const createRes = await fetch(`${baseUrl}/api/hosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Workshop AP',
      ip: '192.168.1.19',
      role: 'ap',
      isSimulated: true,
    }),
  });
  assert.equal(createRes.status, 201);
  const newHost = await createRes.json();
  assert.ok(newHost.id);

  // Update new host
  const updateRes = await fetch(`${baseUrl}/api/hosts/${newHost.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Workshop AP Updated' }),
  });
  assert.equal(updateRes.status, 200);
  const updatedHost = await updateRes.json();
  assert.equal(updatedHost.name, 'Workshop AP Updated');

  // Delete new host
  const deleteRes = await fetch(`${baseUrl}/api/hosts/${newHost.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 200);
});

test('API: GET /api/topology returns nodes and links', async () => {
  const res = await fetch(`${baseUrl}/api/topology`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.nodes));
  assert.ok(Array.isArray(data.links));

  // WAN node
  assert.ok(data.nodes.some((n) => n.type === 'wan'));
  // Gateway node
  assert.ok(data.nodes.some((n) => n.type === 'gateway'));
  // AP nodes
  assert.ok(data.nodes.some((n) => n.type === 'ap'));
});

test('API: Clients inventory and MAC inspection', async () => {
  const res = await fetch(`${baseUrl}/api/clients`);
  assert.equal(res.status, 200);
  const clients = await res.json();
  assert.ok(Array.isArray(clients));
  assert.ok(clients.length >= 20);

  // Query filter
  const filterRes = await fetch(`${baseUrl}/api/clients?q=MacBook`);
  assert.equal(filterRes.status, 200);
  const filtered = await filterRes.json();
  assert.equal(filtered.length, 1);
  assert.ok(filtered[0].hostname.includes('MacBook'));

  // Single client deep inspection
  const mac = encodeURIComponent(filtered[0].mac);
  const detailRes = await fetch(`${baseUrl}/api/clients/${mac}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.ok(Array.isArray(detail.roamingLog));
  assert.ok(Array.isArray(detail.signalHistory));

  // Set client alias
  const aliasRes = await fetch(`${baseUrl}/api/clients/${mac}/alias`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: "James Work Laptop" }),
  });
  assert.equal(aliasRes.status, 200);
  const aliased = await aliasRes.json();
  assert.equal(aliased.nickname, "James Work Laptop");
});

test('API: WiFi spectrum channels and interference analysis', async () => {
  const channelsRes = await fetch(`${baseUrl}/api/wifi/channels`);
  assert.equal(channelsRes.status, 200);
  const channelsData = await channelsRes.json();
  assert.ok(channelsData.bands['2.4GHz']);
  assert.ok(channelsData.bands['5GHz']);
  assert.ok(channelsData.bands['6GHz']);

  const interRes = await fetch(`${baseUrl}/api/wifi/interference`);
  assert.equal(interRes.status, 200);
  const interData = await interRes.json();
  assert.ok(interData.summary);
  assert.ok(interData.warnings.length > 0);
});

test('API: Backups run, download, inspection, diff, schedules', async () => {
  // List initial backups
  const listRes = await fetch(`${baseUrl}/api/backups`);
  assert.equal(listRes.status, 200);
  const backups = await listRes.json();
  assert.ok(backups.length >= 2);

  const backupA = backups[0];
  const backupB = backups.find((b) => b.hostId === backupA.hostId && b.id !== backupA.id) || backups[1];

  // Inspect files
  const filesRes = await fetch(`${baseUrl}/api/backups/${backupA.id}/files`);
  assert.equal(filesRes.status, 200);
  const filesData = await filesRes.json();
  assert.ok(Array.isArray(filesData.files));
  assert.ok(filesData.files.some((f) => f.path === 'etc/config/network'));

  // Get file content
  const contentRes = await fetch(`${baseUrl}/api/backups/${backupA.id}/file-content?path=etc/config/network`);
  assert.equal(contentRes.status, 200);
  const contentData = await contentRes.json();
  assert.equal(contentData.path, 'etc/config/network');
  assert.ok(contentData.content.includes('config interface'));

  // Diff between two backups
  const diffRes = await fetch(`${baseUrl}/api/backups/${backupA.id}/diff/${backupB.id}?file=etc/config/network`);
  assert.equal(diffRes.status, 200);
  const diffData = await diffRes.json();
  assert.equal(diffData.file, 'etc/config/network');
  assert.ok('hasDifferences' in diffData);

  // Download backup archive
  const downloadRes = await fetch(`${baseUrl}/api/backups/${backupA.id}/download`);
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers.get('content-type'), 'application/gzip');
  assert.ok(downloadRes.headers.get('content-disposition').includes('attachment; filename='));
  const blob = await downloadRes.arrayBuffer();
  assert.ok(blob.byteLength > 0);

  // Run on-demand backup
  const runRes = await fetch(`${baseUrl}/api/backups/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId: 'node-ap-01' }),
  });
  assert.equal(runRes.status, 200);
  const runData = await runRes.json();
  assert.equal(runData.status, 'completed');
  assert.ok(runData.backups.length >= 1);

  // Schedules
  const schedRes = await fetch(`${baseUrl}/api/backups/schedules`);
  assert.equal(schedRes.status, 200);
  const schedData = await schedRes.json();
  assert.ok(schedData.schedules.length >= 1);

  // Trigger schedule run
  const schedRunRes = await fetch(`${baseUrl}/api/backups/schedules/${schedData.schedules[0].id}/run`, {
    method: 'POST',
  });
  assert.equal(schedRunRes.status, 200);
});

test('API: Simulator controls (status, configure, reset)', async () => {
  const statusRes = await fetch(`${baseUrl}/api/simulator/status`);
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.active, true);

  const configRes = await fetch(`${baseUrl}/api/simulator/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trafficSpike: true }),
  });
  assert.equal(configRes.status, 200);
  const configured = await configRes.json();
  assert.equal(configured.trafficSpike, true);

  const resetRes = await fetch(`${baseUrl}/api/simulator/reset`, { method: 'POST' });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.equal(resetData.trafficSpike, false);
});

test('Static & Security: Path traversal protection', async () => {
  const traversalRes = await fetch(`${baseUrl}/../../../../etc/passwd`);
  assert.ok(traversalRes.status === 403 || traversalRes.status === 404);

  // Raw HTTP socket request containing literal .. traversal
  const rawResponse = await new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl);
    const client = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: '/static/../secret',
        method: 'GET',
      },
      (res) => {
        resolve(res.statusCode);
      }
    );
    client.on('error', reject);
    client.end();
  });
  assert.equal(rawResponse, 403);
});

test('Security: DoS protection rejects oversized payload with 413', async () => {
  const largeChunk = 'x'.repeat(1024 * 1024); // 1MB
  const largeBody = JSON.stringify({ data: [largeChunk, largeChunk, largeChunk, largeChunk, largeChunk, largeChunk] }); // >6MB
  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: largeBody,
    });
    assert.equal(res.status, 413);
  } catch (err) {
    // Some platforms may report socket hangup on req.destroy() which is also valid DoS protection
    assert.ok(err.message.includes('fetch failed') || err.message.includes('ECONNRESET'));
  }
});

test('Security: Host ID and path traversal input rejection in backups API', async () => {
  const badHostRes = await fetch(`${baseUrl}/api/backups/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId: '../../etc' }),
  });
  assert.equal(badHostRes.status, 400);

  const badQueryRes = await fetch(`${baseUrl}/api/backups?hostId=../etc`);
  assert.equal(badQueryRes.status, 400);
});
