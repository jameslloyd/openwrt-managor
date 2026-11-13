import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server/index.js';
import { db } from '../server/storage/db.js';
import { backupEngine } from '../server/services/backupEngine.js';
import { hostManager } from '../server/services/hostManager.js';
import { parseSshTelemetryOutput } from '../server/services/realUbus.js';
import { analyzeInterference } from '../server/services/wifiEngine.js';

let server;
let baseUrl;

test.before(async () => {
  await db.saveHosts([]);
  await backupEngine.removeDemoBackups(['node-gw-01', 'node-ap-01', 'node-ap-02', 'node-ap-03']);
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
  await db.saveHosts([]);
  await backupEngine.removeDemoBackups(['node-gw-01', 'node-ap-01', 'node-ap-02', 'node-ap-03']);
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

  // Initially no demo hosts are seeded
  const initialRes = await fetch(`${baseUrl}/api/hosts`);
  assert.equal(initialRes.status, 200);
  const initialHosts = await initialRes.json();
  assert.ok(Array.isArray(initialHosts));
  assert.equal(initialHosts.length, 0);

  // Create new gateway host
  const gwRes = await fetch(`${baseUrl}/api/hosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'node-gw-01',
      name: 'Main Gateway',
      ip: '192.168.1.1',
      role: 'gateway',
    }),
  });
  assert.equal(gwRes.status, 201);

  // Create new AP host
  const createRes = await fetch(`${baseUrl}/api/hosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'node-ap-01',
      name: 'Workshop AP',
      ip: '192.168.1.19',
      role: 'ap',
    }),
  });
  assert.equal(createRes.status, 201);
  const newHost = await createRes.json();
  assert.equal(newHost.id, 'node-ap-01');
  assert.equal(newHost.isSimulated, false);

  // Get single host
  const singleRes = await fetch(`${baseUrl}/api/hosts/node-gw-01`);
  assert.equal(singleRes.status, 200);
  const host = await singleRes.json();
  assert.equal(host.id, 'node-gw-01');

  // Update new host
  const updateRes = await fetch(`${baseUrl}/api/hosts/${newHost.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Workshop AP Updated' }),
  });
  assert.equal(updateRes.status, 200);
  const updatedHost = await updateRes.json();
  assert.equal(updatedHost.name, 'Workshop AP Updated');
});

test('API: GET /api/topology returns nodes and links for registered hosts', async () => {
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

test('API: Clients inventory returns empty list when no demo data exists', async () => {
  const res = await fetch(`${baseUrl}/api/clients`);
  assert.equal(res.status, 200);
  const clients = await res.json();
  assert.ok(Array.isArray(clients));
  assert.equal(clients.length, 0);
});

test('API: WiFi spectrum channels and interference analysis have no demo radios', async () => {
  const channelsRes = await fetch(`${baseUrl}/api/wifi/channels`);
  assert.equal(channelsRes.status, 200);
  const channelsData = await channelsRes.json();
  assert.ok(channelsData.bands['2.4GHz']);
  assert.ok(channelsData.bands['5GHz']);
  assert.ok(channelsData.bands['6GHz']);
  assert.equal(channelsData.bands['2.4GHz'].radios.length, 0);
  assert.equal(channelsData.bands['5GHz'].radios.length, 0);
  assert.equal(channelsData.bands['6GHz'].radios.length, 0);

  const interRes = await fetch(`${baseUrl}/api/wifi/interference`);
  assert.equal(interRes.status, 200);
  const interData = await interRes.json();
  assert.ok(interData.summary);
  assert.equal(interData.warnings.length, 0);
});

test('API: Backups run, download, inspection, diff, schedules', async () => {
  // Run on-demand backups for registered hosts
  const runRes = await fetch(`${baseUrl}/api/backups/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId: 'all' }),
  });
  assert.equal(runRes.status, 200);
  const runData = await runRes.json();
  assert.equal(runData.status, 'completed');
  assert.ok(runData.backups.length >= 2);

  // List backups
  const listRes = await fetch(`${baseUrl}/api/backups`);
  assert.equal(listRes.status, 200);
  const backups = await listRes.json();
  assert.ok(backups.length >= 2);

  const backupA = backups[0];
  const backupB = backups[1];

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

  // Clean up test hosts and their backups
  await fetch(`${baseUrl}/api/hosts/node-gw-01?deleteBackups=true`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/hosts/node-ap-01?deleteBackups=true`, { method: 'DELETE' });
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

test('API: Adding a real host removes all demo data (hosts, backups, clients, wifi, topology, demoMode)', async () => {
  // Add a real host (isSimulated: false)
  const createRes = await fetch(`${baseUrl}/api/hosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Production Router',
      ip: '10.0.0.1',
      role: 'gateway',
      isSimulated: false,
    }),
  });
  assert.equal(createRes.status, 201);
  const realHost = await createRes.json();
  assert.equal(realHost.isSimulated, false);

  // 1. Only the real host remains in /api/hosts (demo hosts removed)
  const hostsRes = await fetch(`${baseUrl}/api/hosts`);
  const hosts = await hostsRes.json();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, realHost.id);
  assert.equal(hosts.some((h) => h.isSimulated), false);

  // 2. Demo backups removed from /api/backups
  const backupsRes = await fetch(`${baseUrl}/api/backups`);
  const backups = await backupsRes.json();
  assert.equal(backups.length, 0);

  // 3. Demo clients removed from /api/clients
  const clientsRes = await fetch(`${baseUrl}/api/clients`);
  const clients = await clientsRes.json();
  assert.equal(clients.length, 0);

  // 4. Demo radios removed from /api/wifi/channels & /api/wifi/interference
  const wifiRes = await fetch(`${baseUrl}/api/wifi/channels`);
  const wifiData = await wifiRes.json();
  assert.equal(wifiData.bands['2.4GHz'].radios.length, 0);
  assert.equal(wifiData.bands['5GHz'].radios.length, 0);
  assert.equal(wifiData.bands['6GHz'].radios.length, 0);

  const interRes = await fetch(`${baseUrl}/api/wifi/interference`);
  const interData = await interRes.json();
  assert.equal(interData.warnings.length, 0);

  // 5. Topology only includes WAN + the real host (no demo nodes or demo clients)
  const topoRes = await fetch(`${baseUrl}/api/topology`);
  const topoData = await topoRes.json();
  assert.equal(topoData.nodes.length, 2);
  assert.ok(topoData.nodes.some((n) => n.id === realHost.id));
  assert.equal(topoData.nodes.some((n) => n.id === 'node-gw-01'), false);

  // 6. Health & settings report demoMode: false
  const healthRes = await fetch(`${baseUrl}/api/health`);
  const healthData = await healthRes.json();
  assert.equal(healthData.demoMode, false);

  // Cleanup: delete the real host
  await fetch(`${baseUrl}/api/hosts/${realHost.id}`, { method: 'DELETE' });
});

test('SSH Telemetry Parser: extracts real uptime, CPU%, RAM%, model, firmware, radios, and clients from OpenWrt output', () => {
  const sampleSshOutput = [
    '===BOARD===',
    JSON.stringify({
      hostname: 'OpenWrt-Flint2',
      model: 'GL.iNet GL-MT6000',
      release: {
        distribution: 'OpenWrt',
        version: '23.05.4',
        revision: 'r24012-d811c7cee8',
        description: 'OpenWrt 23.05.4 r24012-d811c7cee8',
      },
    }),
    '===UPTIME===',
    '172845.62 684120.11',
    '===MEMINFO===',
    'MemTotal:        1024000 kB',
    'MemFree:          400000 kB',
    'MemAvailable:     768000 kB',
    'Buffers:           50000 kB',
    'Cached:           318000 kB',
    '===CPUSTAT1===',
    'cpu  1000 0 500 8500 0 0 0 0',
    '===CPUSTAT2===',
    'cpu  1025 0 515 8560 0 0 0 0',
    '===MAC===',
    '94:83:c4:aa:bb:cc',
    '===IWDEV===',
    'phy#1',
    '\tInterface phy1-ap0',
    '\t\tssid Homelab-5G',
    '\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz',
    '\t\ttxpower 23.00 dBm',
    '===STATIONS===',
    '---IFACE:phy1-ap0---',
    'Station a4:83:e7:11:22:33 (on phy1-ap0)',
    '\trx bytes:\t52428800',
    '\ttx bytes:\t10485760',
    '\tsignal:\t\t-51 [-53, -54] dBm',
    '\ttx bitrate:\t1201.0 MBit/s 80MHz HE-MCS 11',
    '\trx bitrate:\t866.7 MBit/s 80MHz HE-MCS 9',
    '===DHCP===',
    `${Math.floor(Date.now() / 1000) + 7200} a4:83:e7:11:22:33 192.168.1.142 MacBook-Air 01:a4:83:e7:11:22:33`,
    '===ARP===',
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.142    0x1         0x2         a4:83:e7:11:22:33     *        br-lan',
  ].join('\n');

  const parsed = parseSshTelemetryOutput({ id: 'node-ap-test', name: 'Flint 2 AP' }, sampleSshOutput);
  assert.equal(parsed.online, true);
  assert.equal(parsed.hostname, 'OpenWrt-Flint2');
  assert.equal(parsed.model, 'GL.iNet GL-MT6000');
  assert.equal(parsed.firmware, 'OpenWrt 23.05.4 r24012-d811c7cee8');
  assert.equal(parsed.uptimeSec, 172845);
  assert.equal(parsed.memUsagePct, 25); // (1024000 - 768000) / 1024000 = 25%
  assert.equal(parsed.cpuUsagePct, 40); // dTotal=100, dIdle=60 -> 40%
  assert.equal(parsed.mac, '94:83:c4:aa:bb:cc');
  assert.equal(parsed.radios.length, 1);
  assert.equal(parsed.radios[0].band, '5GHz');
  assert.equal(parsed.radios[0].channel, 36);
  assert.equal(parsed.clients.length, 1);
  assert.equal(parsed.clients[0].ip, '192.168.1.142');
  assert.equal(parsed.clients[0].hostname, 'MacBook-Air');
  assert.equal(parsed.clients[0].signalDbm, -51);
});

test('Wireless client IP resolution: resolves AP wireless client IPs via DHCP server host or ARP + RDNS', () => {
  // 1. Gateway / DHCP Server has the DHCP leases for wireless clients
  const gwOutput = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Main-Gateway', model: 'OpenWrt Router' }),
    '===UPTIME===',
    '86400.00 100000.00',
    '===DHCP===',
    `${Math.floor(Date.now() / 1000) + 3600} b8:27:eb:aa:bb:cc 192.168.1.55 LivingRoom-TV *`,
  ].join('\n');

  // 2. Dumb AP has two wireless clients, no local /tmp/dhcp.leases, and one discovered via ARP + RDNS against gateway
  const apOutput = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Upstairs-AP', model: 'OpenWrt AP' }),
    '===UPTIME===',
    '43200.00 50000.00',
    '===IWDEV===',
    'phy#0',
    '\tInterface phy0-ap0',
    '\t\tssid HomeWiFi',
    '\t\tchannel 44 (5220 MHz), width: 80 MHz, center1: 5210 MHz',
    '===STATIONS===',
    '---IFACE:phy0-ap0---',
    'Station b8:27:eb:aa:bb:cc (on phy0-ap0)',
    '\tsignal:\t\t-58 dBm',
    '\ttx bitrate:\t866.7 MBit/s 80MHz HE-MCS 9',
    'Station dc:a6:32:11:22:33 (on phy0-ap0)',
    '\tsignal:\t\t-62 dBm',
    '\ttx bitrate:\t780.0 MBit/s 80MHz VHT-MCS 8',
    '===ARP===',
    '---IPNEIGH---',
    '192.168.1.88 dev br-lan lladdr dc:a6:32:11:22:33 REACHABLE',
    '===RDNS===',
    'dc:a6:32:11:22:33 192.168.1.88 raspberrypi.lan.',
  ].join('\n');

  const gwHost = { id: 'gw-1', name: 'Gateway' };
  const apHost = { id: 'ap-1', name: 'Upstairs AP' };

  const gwTelemetry = parseSshTelemetryOutput(gwHost, gwOutput);
  const apTelemetry = parseSshTelemetryOutput(apHost, apOutput);

  // Direct ARP + RDNS resolution on the AP itself
  const piClientOnAp = apTelemetry.clients.find((c) => c.mac === 'dc:a6:32:11:22:33');
  assert.equal(piClientOnAp.ip, '192.168.1.88');
  assert.equal(piClientOnAp.hostname, 'raspberrypi');

  // Fleet-wide DHCP resolution across Gateway + AP in hostManager
  hostManager.applyTelemetryToHost(gwHost, gwTelemetry);
  hostManager.applyTelemetryToHost(apHost, apTelemetry);

  const liveClients = hostManager.getLiveClients();
  const tvClient = liveClients.find((c) => c.mac === 'b8:27:eb:aa:bb:cc');
  assert.ok(tvClient);
  assert.equal(tvClient.connectionType, 'wifi_5g');
  assert.equal(tvClient.connectedTo.hostId, 'ap-1');
  assert.equal(tvClient.ip, '192.168.1.55');
  assert.equal(tvClient.hostname, 'LivingRoom-TV');
  assert.ok(tvClient.dhcpLeaseRemainingSec > 0);

  // Clean up test state from hostManager
  hostManager.liveClientsByHost.delete('gw-1');
  hostManager.liveClientsByHost.delete('ap-1');
  hostManager.liveRadiosByHost.delete('gw-1');
  hostManager.liveRadiosByHost.delete('ap-1');
  hostManager.dhcpByHost.delete('gw-1');
  hostManager.dhcpByHost.delete('ap-1');
  hostManager.arpByHost.delete('gw-1');
  hostManager.arpByHost.delete('ap-1');
  hostManager.rdnsByHost.delete('gw-1');
  hostManager.rdnsByHost.delete('ap-1');
});

test('Spectrum Congestion Engine: aggregates survey dump airtime across all radios and highlights overlapping congestion zones', () => {
  const ap1Output = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Downstairs-AP', model: 'OpenWrt AP' }),
    '===IWDEV===',
    'phy#1',
    '\tInterface phy1-ap0',
    '\t\tssid HomeMesh',
    '\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz',
    '\t\ttxpower 23.00 dBm',
    '===SURVEY===',
    '---IFACE:phy1-ap0---',
    '\tfrequency:\t\t\t5180 MHz [in use]',
    '\tnoise:\t\t\t\t-92 dBm',
    '\tchannel active time:\t\t10000 ms',
    '\tchannel busy time:\t\t4800 ms',
  ].join('\n');

  const ap2Output = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Upstairs-AP', model: 'OpenWrt AP' }),
    '===IWDEV===',
    'phy#1',
    '\tInterface phy1-ap0',
    '\t\tssid HomeMesh',
    '\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz',
    '\t\ttxpower 23.00 dBm',
    '===SURVEY===',
    '---IFACE:phy1-ap0---',
    '\tfrequency:\t\t\t5180 MHz [in use]',
    '\tnoise:\t\t\t\t-90 dBm',
    '\tchannel active time:\t\t10000 ms',
    '\tchannel busy time:\t\t3700 ms',
  ].join('\n');

  const ap1 = { id: 'ap-down', name: 'Downstairs AP' };
  const ap2 = { id: 'ap-up', name: 'Upstairs AP' };

  const t1 = parseSshTelemetryOutput(ap1, ap1Output);
  const t2 = parseSshTelemetryOutput(ap2, ap2Output);

  assert.equal(t1.radios[0].utilizationPct, 48);
  assert.equal(t1.radios[0].noiseDbm, -92);
  assert.equal(t2.radios[0].utilizationPct, 37);
  assert.equal(t2.radios[0].noiseDbm, -90);

  hostManager.applyTelemetryToHost(ap1, t1);
  hostManager.applyTelemetryToHost(ap2, t2);

  const bands = hostManager.getLiveWifiBands();
  const analysis = analyzeInterference(bands);

  assert.ok(analysis.bandCongestion['5GHz']);
  const c5 = analysis.bandCongestion['5GHz'];
  assert.equal(c5.radiosCount, 2);
  assert.equal(c5.overlappingCount, 1);
  assert.equal(c5.overlappingZones[0].combinedUtilizationPct, 85); // 48% + 37%
  assert.equal(c5.congestionLevel, 'high');
  assert.ok(c5.recommendedChannel);
  assert.notEqual(c5.recommendedChannel.channel, 36);

  hostManager.liveRadiosByHost.delete('ap-down');
  hostManager.liveRadiosByHost.delete('ap-up');
});
