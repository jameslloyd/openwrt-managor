import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server/index.js';
import { db } from '../server/storage/db.js';
import { backupEngine } from '../server/services/backupEngine.js';
import { hostManager } from '../server/services/hostManager.js';
import {
  buildTelemetrySshScript,
  parseSshTelemetryOutput,
  parseSwitchFdbSection,
  formatSwitchPortLabel,
  parseOpkgUpgradable,
  evaluateAttendedSysupgrade,
  compareOpenWrtVersions,
} from '../server/services/realUbus.js';
import { analyzeInterference } from '../server/services/wifiEngine.js';
import {
  resolveMacManufacturer,
  resolveSsidManufacturer,
  resolveWirelessNetworkManufacturer,
  lookupVendor,
} from '../server/services/ouiVendor.js';

let server;
let baseUrl;
let savedHostsBeforeTest = null;

test.before(async () => {
  savedHostsBeforeTest = await db.getHosts();
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
  backupEngine.stopScheduler();
  if (Array.isArray(savedHostsBeforeTest) && savedHostsBeforeTest.length > 0) {
    await db.saveHosts(savedHostsBeforeTest);
  } else {
    await db.saveHosts([]);
  }
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

test('Neighboring Networks Scanner: parses iw scan output and aggregates relative signal strength across multiple OpenWrt radios', () => {
  const apDownOutput = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Downstairs-AP', model: 'OpenWrt AP' }),
    '===IWDEV===',
    'phy#1',
    '\tInterface phy1-ap0',
    '\t\tssid HomeMesh',
    '\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz',
    '\t\ttxpower 23.00 dBm',
    '===SCANDUMP===',
    '---IFACE:phy1-ap0---',
    'BSS 70:4f:57:aa:bb:cc(on phy1-ap0)',
    '\tlb-tsf: 123456',
    '\tfreq: 5180',
    '\tsignal: -54.00 dBm',
    '\tlast seen: 420 ms ago',
    '\tSSID: NeighborFiber5G',
    '\tRSN:\t * Version: 1',
    '\tHT operation:',
    '\t\t * primary channel: 36',
    '\tVHT operation:',
    '\t\t * channel width: 1 (80 MHz)',
  ].join('\n');

  const apUpOutput = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Upstairs-AP', model: 'OpenWrt AP' }),
    '===IWDEV===',
    'phy#1',
    '\tInterface phy1-ap0',
    '\t\tssid HomeMesh',
    '\t\tchannel 100 (5500 MHz), width: 80 MHz, center1: 5530 MHz',
    '\t\ttxpower 23.00 dBm',
    '===SCANDUMP===',
    '---IFACE:phy1-ap0---',
    'BSS 70:4f:57:aa:bb:cc(on phy1-ap0)',
    '\tfreq: 5180',
    '\tsignal: -76.00 dBm',
    '\tlast seen: 950 ms ago',
    '\tSSID: NeighborFiber5G',
    '\tRSN:\t * Version: 1',
    '\tVHT operation:',
    '\t\t * channel width: 1 (80 MHz)',
  ].join('\n');

  const apDown = { id: 'ap-down', name: 'Downstairs AP' };
  const apUp = { id: 'ap-up', name: 'Upstairs AP' };

  const tDown = parseSshTelemetryOutput(apDown, apDownOutput);
  const tUp = parseSshTelemetryOutput(apUp, apUpOutput);

  assert.equal(tDown.neighbors.length, 1);
  assert.equal(tDown.neighbors[0].bssid, '70:4f:57:aa:bb:cc');
  assert.equal(tDown.neighbors[0].ssid, 'NeighborFiber5G');
  assert.equal(tDown.neighbors[0].channel, 36);
  assert.equal(tDown.neighbors[0].widthMhz, 80);
  assert.equal(tDown.neighbors[0].signalDbm, -54);

  hostManager.applyTelemetryToHost(apDown, tDown);
  hostManager.applyTelemetryToHost(apUp, tUp);

  const bands = hostManager.getLiveWifiBands();
  const neighbors5g = bands['5GHz'].neighbors;
  assert.equal(neighbors5g.length, 1);

  const neighbor = neighbors5g[0];
  assert.equal(neighbor.bssid, '70:4f:57:aa:bb:cc');
  assert.equal(neighbor.ssid, 'NeighborFiber5G');
  assert.equal(neighbor.manufacturer, 'TP-Link');
  assert.equal(neighbor.bssidManufacturer, 'TP-Link');
  assert.equal(neighbor.strongestSignalDbm, -54);
  assert.equal(neighbor.isManagedFleet, false);

  // Relative signal strength on each radio sorted strongest first
  assert.equal(neighbor.observations.length, 2);
  assert.equal(neighbor.observations[0].hostName, 'Downstairs AP');
  assert.equal(neighbor.observations[0].signalDbm, -54);
  assert.equal(neighbor.observations[1].hostName, 'Upstairs AP');
  assert.equal(neighbor.observations[1].signalDbm, -76);

  // Interference analysis flags external neighbor overlapping Downstairs AP on Channel 36
  const analysis = analyzeInterference(bands);
  const extWarning = analysis.warnings.find((w) => w.type === 'external_interference' && w.band === '5GHz');
  assert.ok(extWarning);
  assert.ok(extWarning.message.includes('NeighborFiber5G'));
  assert.ok(extWarning.message.includes('-54 dBm'));
  assert.equal(analysis.bandCongestion['5GHz'].neighborsCount, 1);

  hostManager.liveRadiosByHost.delete('ap-down');
  hostManager.liveRadiosByHost.delete('ap-up');
  hostManager.liveNeighborsByHost.delete('ap-down');
  hostManager.liveNeighborsByHost.delete('ap-up');
  hostManager.hostsCacheById.delete('ap-down');
  hostManager.hostsCacheById.delete('ap-up');
});

test('Foreign AP RF Triangulation: trilaterates approximate 2D coordinates from 3 OpenWrt AP signal powers', () => {
  const makeApScan = (hostname, signalDbm) =>
    [
      '===BOARD===',
      JSON.stringify({ hostname, model: 'OpenWrt AP' }),
      '===IWDEV===',
      'phy#1',
      '\tInterface phy1-ap0',
      '\t\tssid FleetWiFi',
      '\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz',
      '===SCANDUMP===',
      '---IFACE:phy1-ap0---',
      'BSS c8:b4:22:11:22:33(on phy1-ap0)',
      '\tfreq: 5745',
      `\tsignal: ${signalDbm}.00 dBm`,
      '\tlast seen: 210 ms ago',
      '\tSSID: NextDoorCafe5G',
      '\tRSN:\t * Version: 1',
      '\tVHT operation:',
      '\t\t * channel width: 1 (80 MHz)',
    ].join('\n');

  const wiredGwOutput = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Core-Wired-Gateway', model: 'FriendlyElec NanoPi R6S' }),
    '===UPTIME===',
    '86400.00 100000.00',
    '===IWDEV===',
  ].join('\n');

  const wiredGateway = { id: 'gw-wired', name: 'Core Wired Gateway', role: 'gateway', mapPosition: { x: 50, y: 50 } };
  const apWest = { id: 'ap-west', name: 'West Wing AP', mapPosition: { x: 20, y: 20 } };
  const apEast = { id: 'ap-east', name: 'East Wing AP', mapPosition: { x: 80, y: 20 } };
  const apSouth = { id: 'ap-south', name: 'South Patio AP', mapPosition: { x: 50, y: 80 } };

  // Include a wired-only OpenWrt gateway (no wireless radios) and ensure it is excluded from AP triangulation
  const gwTelemetry = parseSshTelemetryOutput(wiredGateway, wiredGwOutput);
  assert.equal(gwTelemetry.radios.length, 0);
  hostManager.applyTelemetryToHost(wiredGateway, gwTelemetry);
  hostManager.hostsCacheById.set('gw-wired', {
    ...hostManager.hostsCacheById.get('gw-wired'),
    persisted: true,
  });

  // Foreign AP is much closer to West Wing AP (-48 dBm -> ~1.6m) than East (-74 dBm -> ~11.7m) or South (-78 dBm -> ~15.8m)
  hostManager.applyTelemetryToHost(apWest, parseSshTelemetryOutput(apWest, makeApScan('West-AP', -48)));
  hostManager.applyTelemetryToHost(apEast, parseSshTelemetryOutput(apEast, makeApScan('East-AP', -74)));
  hostManager.applyTelemetryToHost(apSouth, parseSshTelemetryOutput(apSouth, makeApScan('South-AP', -78)));

  const bands = hostManager.getLiveWifiBands();
  const band5g = bands['5GHz'];
  assert.equal(band5g.anchors.length, 3);
  assert.equal(band5g.anchors.some((a) => a.hostId === 'gw-wired'), false);
  assert.deepEqual(
    band5g.anchors.map((a) => a.hostId).sort(),
    ['ap-east', 'ap-south', 'ap-west']
  );
  assert.equal(band5g.neighbors.length, 1);

  const foreignAp = band5g.neighbors[0];
  assert.equal(foreignAp.ssid, 'NextDoorCafe5G');
  assert.ok(foreignAp.triangulation);
  assert.equal(foreignAp.triangulation.method, 'trilateration');
  assert.equal(foreignAp.triangulation.confidence, 'high');
  assert.equal(foreignAp.triangulation.apCount, 3);
  assert.equal(foreignAp.triangulation.closestHostId, 'ap-west');
  assert.ok(foreignAp.triangulation.minDistanceMeters < 2.5);

  // Triangulated coordinates (x, y) must be closer to West Wing AP (20, 20) than East (80, 20) or South (50, 80)
  const distToWest = Math.hypot(foreignAp.triangulation.x - 20, foreignAp.triangulation.y - 20);
  const distToEast = Math.hypot(foreignAp.triangulation.x - 80, foreignAp.triangulation.y - 20);
  const distToSouth = Math.hypot(foreignAp.triangulation.x - 50, foreignAp.triangulation.y - 80);
  assert.ok(distToWest < distToEast, `Expected distToWest (${distToWest}) < distToEast (${distToEast})`);
  assert.ok(distToWest < distToSouth, `Expected distToWest (${distToWest}) < distToSouth (${distToSouth})`);

  // Verify GPS (Latitude/Longitude) & Altitude 3D triangulation calibration
  const apWestGps = {
    id: 'ap-west',
    name: 'West Wing AP',
    latitude: 51.5075,
    longitude: -0.128,
    altitude: 12.0,
  };
  const apEastGps = {
    id: 'ap-east',
    name: 'East Wing AP',
    latitude: 51.5075,
    longitude: -0.1274,
    altitude: 15.5,
  };
  const apSouthGps = {
    id: 'ap-south',
    name: 'South Patio AP',
    latitude: 51.5071,
    longitude: -0.1277,
    altitude: 9.0,
  };
  hostManager.applyTelemetryToHost(apWestGps, parseSshTelemetryOutput(apWestGps, makeApScan('West-AP', -48)));
  hostManager.applyTelemetryToHost(apEastGps, parseSshTelemetryOutput(apEastGps, makeApScan('East-AP', -74)));
  hostManager.applyTelemetryToHost(apSouthGps, parseSshTelemetryOutput(apSouthGps, makeApScan('South-AP', -78)));

  const gpsBands = hostManager.getLiveWifiBands();
  const gpsBand5g = gpsBands['5GHz'];
  assert.equal(gpsBand5g.anchors.every((a) => a.isGpsProjected && a.hasGps && a.hasAlt), true);

  const gpsForeignAp = gpsBand5g.neighbors[0];
  assert.equal(gpsForeignAp.triangulation.gpsCalibrated, true);
  assert.equal(gpsForeignAp.triangulation.altitudeCalibrated, true);
  assert.equal(typeof gpsForeignAp.triangulation.latitude, 'number');
  assert.equal(typeof gpsForeignAp.triangulation.longitude, 'number');
  assert.equal(typeof gpsForeignAp.triangulation.altitudeMeters, 'number');
  // Because foreign AP is strongest at West Wing AP (12.0m alt, 51.5075, -0.1280), estimated altitude should be near 12.0m
  assert.ok(gpsForeignAp.triangulation.altitudeMeters > 11.0 && gpsForeignAp.triangulation.altitudeMeters < 13.5);

  // Clean up test state
  for (const id of ['gw-wired', 'ap-west', 'ap-east', 'ap-south']) {
    hostManager.liveRadiosByHost.delete(id);
    hostManager.liveNeighborsByHost.delete(id);
    hostManager.hostsCacheById.delete(id);
  }
});

test('Manufacturer Resolution: identifies manufacturer from BSSID OUI, virtual locally-administered BSSID, SSID, and client MAC/hostname', () => {
  // 1. Standard IEEE OUI lookup
  assert.equal(resolveMacManufacturer('94:83:c4:aa:bb:cc'), 'GL.iNet');
  assert.equal(resolveMacManufacturer('70:4f:57:11:22:33'), 'TP-Link');
  assert.equal(resolveMacManufacturer('18:e8:29:44:55:66'), 'Ubiquiti');

  // 2. Locally-administered virtual BSSID (first byte bit 1 flipped: 0x94 -> 0x96)
  assert.equal(resolveMacManufacturer('96:83:c4:aa:bb:cc'), 'GL.iNet (Virtual BSSID)');

  // 3. SSID-based manufacturer resolution
  assert.equal(resolveSsidManufacturer('GL-MT6000-5G'), 'GL.iNet');
  assert.equal(resolveSsidManufacturer('SKY98421'), 'Sky UK');
  assert.equal(resolveSsidManufacturer('BT-X9A2B'), 'BT / EE');
  assert.equal(resolveSsidManufacturer('Deco_Mesh'), 'TP-Link');

  // 4. Combined BSSID + SSID wireless network manufacturer resolution
  const netInfo = resolveWirelessNetworkManufacturer({
    bssid: '02:00:00:11:22:33',
    ssid: 'FRITZ!Box 7590 AX',
  });
  assert.equal(netInfo.manufacturer, 'AVM (FRITZ!Box)');
  assert.equal(netInfo.ssidManufacturer, 'AVM (FRITZ!Box)');

  // 5. Client MAC + Hostname fallback resolution for randomized MACs
  assert.equal(lookupVendor('a4:83:e7:11:22:33', 'unknown'), 'Apple, Inc.');
  assert.equal(lookupVendor('da:a1:19:22:33:44', 'Jan-iPhone-16'), 'Apple, Inc.');
  assert.equal(lookupVendor('da:a1:19:22:33:44', 'shellyplus1pm-a8032a'), 'Shelly / Allterco');
});

test('Backup Schedules: updating schedule persists cron, computes nextRun, syncs retention settings, and executes when due', async () => {
  // 1. Update schedule via PUT /api/backups/schedules
  const updateRes = await fetch(`${baseUrl}/api/backups/schedules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [
        {
          id: 'sched-nightly-fleet',
          name: 'Twice Daily ZFS Snapshot',
          cron: '0 */12 * * *',
          enabled: true,
          targets: ['all'],
          retentionMaxBackups: 7,
        },
      ],
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.schedules.length, 1);
  assert.equal(updateData.schedules[0].name, 'Twice Daily ZFS Snapshot');
  assert.equal(updateData.schedules[0].cron, '0 */12 * * *');
  assert.equal(updateData.schedules[0].retentionMaxBackups, 7);
  assert.ok(updateData.schedules[0].nextRun);

  // Verify nextRun aligns to :00 minute and an even 12-hour boundary (00:00 or 12:00 UTC)
  const nextRunDate = new Date(updateData.schedules[0].nextRun);
  assert.equal(nextRunDate.getUTCMinutes(), 0);
  assert.equal(nextRunDate.getUTCHours() % 12, 0);

  // 2. Verify GET /api/backups/schedules and GET /api/settings reflect the saved schedule & retention
  const getSchedRes = await fetch(`${baseUrl}/api/backups/schedules`);
  const getSchedData = await getSchedRes.json();
  assert.equal(getSchedData.schedules[0].cron, '0 */12 * * *');
  assert.equal(getSchedData.schedules[0].retentionMaxBackups, 7);

  const settingsRes = await fetch(`${baseUrl}/api/settings`);
  const settingsData = await settingsRes.json();
  assert.equal(settingsData.retention.maxBackupsPerHost, 7);

  // 3. Verify checkDueSchedules executes a due schedule and advances nextRun
  const futureDate = new Date(nextRunDate.getTime() + 5000);
  const executedIds = await backupEngine.checkDueSchedules(futureDate);
  assert.deepEqual(executedIds, ['sched-nightly-fleet']);

  const afterSchedules = await db.getSchedules();
  assert.equal(afterSchedules[0].lastRun, futureDate.toISOString());
  assert.ok(new Date(afterSchedules[0].nextRun).getTime() > futureDate.getTime());
});

test('Package Updates & Attended Sysupgrade: parses opkg/apk updates and advises when new OpenWrt firmware is available', async () => {
  // 1. Version comparison
  assert.ok(compareOpenWrtVersions('23.05.5', '23.05.2') > 0);
  assert.ok(compareOpenWrtVersions('24.10.0', '23.05.5') > 0);
  assert.equal(compareOpenWrtVersions('23.05.5', '23.05.5'), 0);

  // 2. Parse opkg list-upgradable and apk version output
  const rawUpgradable = [
    'luci-app-firewall - git-23.093.42303-2352132 - 24.086.45142~09d5a38',
    'dnsmasq-full - 2.90-r2 - 2.90-r3',
    'curl - 8.6.0-r1 - 8.7.1-r1',
    'openssl-util - 3.0.13-r1 - 3.0.15-r1',
    'Collected errors:',
    ' * resolve_conffiles: Existing conffile /etc/config/dhcp is different',
  ].join('\n');

  const pkgs = parseOpkgUpgradable(rawUpgradable);
  assert.equal(pkgs.length, 4);
  // Core/security packages (dnsmasq-full, openssl-util) should be sorted first
  assert.equal(pkgs[0].name, 'dnsmasq-full');
  assert.equal(pkgs[0].currentVersion, '2.90-r2');
  assert.equal(pkgs[0].newVersion, '2.90-r3');
  assert.equal(pkgs[0].isSecurityOrCore, true);
  assert.equal(pkgs[1].name, 'openssl-util');
  assert.equal(pkgs[1].isSecurityOrCore, true);

  // 3. Full SSH telemetry output with opkg updates + Attended Sysupgrade (auc) output
  const mockSshOut = [
    '===BOARD===',
    JSON.stringify({
      hostname: 'Gateway-MT6000',
      model: 'GL.iNet GL-MT6000',
      board_name: 'glinet,gl-mt6000',
      release: {
        distribution: 'OpenWrt',
        version: '23.05.2',
        revision: 'r23630-842932a63d',
        target: 'mediatek/filogic',
        description: 'OpenWrt 23.05.2 r23630-842932a63d',
      },
    }),
    '===OPKG_UPGRADABLE===',
    rawUpgradable,
    '===ASU_STATUS===',
    'auc - 0.3.2-1',
    'luci-app-attendedsysupgrade - git-24.086.45142-09d5a38',
    'HAS_BIN:auc',
    "attendedsysupgrade.server.url='https://sysupgrade.openwrt.org'",
    '===ASU_CHECK===',
    'auc (0.3.2-1)',
    'Server: https://sysupgrade.openwrt.org',
    'Running: 23.05.2 r23630-842932a63d on mediatek/filogic (glinet,gl-mt6000)',
    'Available: 23.05.5 r24106-10cc5fcd00',
    '---VERSIONS_JSON---',
    JSON.stringify({
      versions_list: ['23.05.5', '24.10.0'],
      stable_version: '24.10.0',
    }),
  ].join('\n');

  const hostObj = { id: 'gw-mt6000', name: 'Main Gateway', ip: '192.168.1.1', role: 'gateway' };
  const telemetry = parseSshTelemetryOutput(hostObj, mockSshOut);

  assert.equal(telemetry.updates.packagesCount, 4);
  assert.equal(telemetry.updates.firmwareUpdateAvailable, true);
  assert.equal(telemetry.updates.availableFirmwareVersion, '23.05.5');
  assert.equal(telemetry.updates.attendedSysupgrade.installed, true);
  assert.equal(telemetry.updates.attendedSysupgrade.cliTool, 'auc');
  assert.equal(telemetry.updates.attendedSysupgrade.currentVersion, '23.05.2');
  assert.equal(telemetry.updates.attendedSysupgrade.availableVersion, '23.05.5');
  assert.equal(telemetry.updates.attendedSysupgrade.availableRevision, 'r24106-10cc5fcd00');
  assert.equal(telemetry.updates.attendedSysupgrade.target, 'mediatek/filogic');
  assert.equal(telemetry.updates.attendedSysupgrade.boardName, 'glinet,gl-mt6000');
  assert.ok(telemetry.updates.attendedSysupgrade.advisory.includes('23.05.5'));

  // 3b. Verify Attended Sysupgrade detection for LuCI-only, apk (owut), UCI config, default, and explicit ASU_NONE
  const luciOnlyAsu = evaluateAttendedSysupgrade({
    firmware: 'OpenWrt 23.05.4',
    asuStatusTxt: "HAS_LUCI:luci-app-attendedsysupgrade\nattendedsysupgrade.server.url='https://sysupgrade.openwrt.org'",
  });
  assert.equal(luciOnlyAsu.installed, true);
  assert.equal(luciOnlyAsu.cliTool, 'luci-app');

  const apkOwutAsu = evaluateAttendedSysupgrade({
    firmware: 'OpenWrt 24.10.0',
    asuStatusTxt: 'owut-2024.10.0-r1\nluci-app-attendedsysupgrade-24.10.0-r1',
  });
  assert.equal(apkOwutAsu.installed, true);
  assert.equal(apkOwutAsu.cliTool, 'owut');

  const unpolledDefaultAsu = evaluateAttendedSysupgrade({
    firmware: 'OpenWrt 23.05.4',
  });
  assert.equal(unpolledDefaultAsu.installed, true);

  const explicitNoneAsu = evaluateAttendedSysupgrade({
    firmware: 'OpenWrt 23.05.4',
    asuStatusTxt: 'ASU_NONE',
  });
  assert.equal(explicitNoneAsu.installed, false);
  assert.equal(explicitNoneAsu.statusVerified, true);

  // 4. Verify GET /api/hosts/:id/updates returns the host's software & firmware update advisory
  const created = await hostManager.createHost({
    id: 'gw-mt6000',
    name: 'Main Gateway',
    ip: '192.168.1.1',
    role: 'gateway',
  });
  assert.equal(created.id, 'gw-mt6000');

  const hosts = await db.getHosts();
  const idx = hosts.findIndex((h) => h.id === 'gw-mt6000');
  hostManager.applyTelemetryToHost(hosts[idx], telemetry);
  await db.saveHosts(hosts);

  const apiRes = await fetch(`${baseUrl}/api/hosts/gw-mt6000/updates`);
  assert.equal(apiRes.status, 200);
  const apiData = await apiRes.json();
  assert.equal(apiData.updates.packagesCount, 4);
  assert.equal(apiData.updates.firmwareUpdateAvailable, true);
  assert.equal(apiData.updates.availableFirmwareVersion, '23.05.5');

  // 5. Verify background software upgrade job execution and real-time step-by-step progress tracking
  let releaseSecondPackage;
  const secondPackageGate = new Promise((resolve) => {
    releaseSecondPackage = resolve;
  });

  hostManager.customStreamRunners.set('gw-mt6000', async (_cmd, { onLine }) => {
    const emit = (line) => {
      if (onLine) onLine(line);
      return line;
    };
    const lines = [];
    lines.push(emit('Downloading https://downloads.openwrt.org/releases/23.05.5/packages/Packages.gz'));
    lines.push(emit('===UPG_TOTAL:3==='));
    lines.push(emit('===UPG_START:1:3:dnsmasq-full==='));
    lines.push(emit('Upgrading dnsmasq-full on root from 2.90-r2 to 2.90-r3...'));
    lines.push(emit('Configuring dnsmasq-full.'));
    lines.push(emit('===UPG_DONE:1:3:dnsmasq-full:0==='));
    lines.push(emit('===UPG_START:2:3:openssl-util==='));
    lines.push(emit('Upgrading openssl-util on root from 3.0.13-r1 to 3.0.15-r1...'));

    // Pause mid-upgrade so we can assert the live in-progress API state
    await secondPackageGate;

    lines.push(emit('===UPG_DONE:2:3:openssl-util:0==='));
    lines.push(emit('===UPG_START:3:3:curl==='));
    lines.push(emit('Upgrading curl on root from 8.6.0-r1 to 8.7.1-r1...'));
    lines.push(emit('===UPG_DONE:3:3:curl:0==='));
    lines.push(emit('===BOARD==='));
    lines.push(
      emit(
        JSON.stringify({
          hostname: 'Gateway-MT6000',
          model: 'GL.iNet GL-MT6000',
          board_name: 'glinet,gl-mt6000',
          release: {
            distribution: 'OpenWrt',
            version: '23.05.2',
            revision: 'r23630-842932a63d',
            target: 'mediatek/filogic',
          },
        })
      )
    );
    lines.push(emit('===OPKG_UPGRADABLE==='));
    lines.push(emit('===ASU_STATUS==='));
    lines.push(emit('auc - 0.3.2-1'));
    lines.push(emit('HAS_BIN:auc'));
    lines.push(emit('===ASU_CHECK==='));
    return lines.join('\n');
  });

  // Trigger background upgrade via POST /api/hosts/gw-mt6000/updates/upgrade
  const startUpgradeRes = await fetch(`${baseUrl}/api/hosts/gw-mt6000/updates/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages: ['dnsmasq-full', 'openssl-util', 'curl'] }),
  });
  assert.equal(startUpgradeRes.status, 200);
  const startUpgradeData = await startUpgradeRes.json();
  assert.equal(startUpgradeData.background, true);
  assert.ok(startUpgradeData.jobId);

  // Give the async stream runner a tick to reach the mid-upgrade pause gate
  await new Promise((r) => setTimeout(r, 20));

  // Query live progress via GET /api/hosts/gw-mt6000/updates/job and GET /api/hosts/updates/jobs
  const liveJobRes = await fetch(`${baseUrl}/api/hosts/gw-mt6000/updates/job`);
  assert.equal(liveJobRes.status, 200);
  const liveJobData = await liveJobRes.json();
  assert.equal(liveJobData.job.status, 'running');
  assert.equal(liveJobData.job.packagesTotal, 3);
  assert.equal(liveJobData.job.packagesCompleted, 1);
  assert.equal(liveJobData.job.currentPackage, 'openssl-util');
  assert.deepEqual(liveJobData.job.completedPackages, ['dnsmasq-full']);
  assert.ok(liveJobData.job.progressPct > 20 && liveJobData.job.progressPct < 90);

  const jobsListRes = await fetch(`${baseUrl}/api/hosts/updates/jobs?activeOnly=true`);
  const jobsListData = await jobsListRes.json();
  assert.equal(jobsListData.jobs.length, 1);
  assert.equal(jobsListData.jobs[0].id, startUpgradeData.jobId);

  // Release the gate and wait for background job completion
  releaseSecondPackage();
  const internalJob = hostManager.getUpgradeJob(startUpgradeData.jobId);
  if (internalJob && internalJob._promise) {
    await internalJob._promise;
  }

  const finalJobRes = await fetch(`${baseUrl}/api/hosts/gw-mt6000/updates/job`);
  const finalJobData = await finalJobRes.json();
  assert.equal(finalJobData.job.status, 'completed');
  assert.equal(finalJobData.job.progressPct, 100);
  assert.equal(finalJobData.job.packagesCompleted, 3);
  assert.deepEqual(finalJobData.job.completedPackages, ['dnsmasq-full', 'openssl-util', 'curl']);

  const afterUpdatesRes = await fetch(`${baseUrl}/api/hosts/gw-mt6000/updates`);
  const afterUpdatesData = await afterUpdatesRes.json();
  assert.equal(afterUpdatesData.updates.packagesCount, 0);

  await hostManager.deleteHost('gw-mt6000', true);
});

test('Hermes & Agent REST API: exposes OpenAPI spec, manifest, fleet status, flexible host lookup, and optional API key auth', async () => {
  // 1. Verify OpenAPI 3.1 spec and Agent Tool Manifest endpoints
  const openApiRes = await fetch(`${baseUrl}/api/openapi.json`);
  assert.equal(openApiRes.status, 200);
  const openApiSpec = await openApiRes.json();
  assert.equal(openApiSpec.openapi, '3.1.0');
  assert.ok(openApiSpec.paths['/api/agent/status']);
  assert.ok(openApiSpec.paths['/api/agent/hosts/{idOrName}']);

  const manifestRes = await fetch(`${baseUrl}/api/agent/manifest`);
  assert.equal(manifestRes.status, 200);
  const manifestData = await manifestRes.json();
  assert.equal(manifestData.nameForModel, 'openwrt_manager');
  assert.ok(Array.isArray(manifestData.tools));
  assert.ok(manifestData.tools.some((t) => t.name === 'get_openwrt_fleet_status'));
  assert.ok(manifestData.tools.some((t) => t.name === 'get_openwrt_host_status'));

  // 2. Register two OpenWrt hosts and query fleet status via GET /api/agent/status and GET /api/v1/status
  await hostManager.createHost({
    id: 'gw-hermes',
    name: 'Core Gateway',
    hostname: 'OpenWrt-GW',
    ip: '192.168.10.1',
    role: 'gateway',
    model: 'GL.iNet GL-MT6000',
    firmware: 'OpenWrt 23.05.2',
  });
  await hostManager.createHost({
    id: 'ap-office',
    name: 'Office Access Point',
    hostname: 'OpenWrt-Office-AP',
    ip: '192.168.10.2',
    role: 'ap',
    model: 'Ubiquiti UniFi 6 LR',
    firmware: 'OpenWrt 24.10.0',
  });

  const statusRes = await fetch(`${baseUrl}/api/agent/status`);
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.summary.hostsTotal, 2);
  assert.equal(statusData.summary.hostsOnline, 2);
  assert.ok(statusData.summary.textSummary.includes('2 of 2 OpenWrt host(s) online'));
  assert.equal(statusData.hosts.length, 2);

  // Also verify /api/v1/status alias
  const v1StatusRes = await fetch(`${baseUrl}/api/v1/status`);
  assert.equal(v1StatusRes.status, 200);
  const v1StatusData = await v1StatusRes.json();
  assert.equal(v1StatusData.summary.hostsTotal, 2);

  // 3. Verify flexible host lookup by display name, IP address, slug, or ID via GET /api/agent/hosts/:idOrName
  const byNameRes = await fetch(`${baseUrl}/api/agent/hosts/${encodeURIComponent('Office Access Point')}`);
  assert.equal(byNameRes.status, 200);
  const byNameData = await byNameRes.json();
  assert.equal(byNameData.host.id, 'ap-office');
  assert.equal(byNameData.host.ip, '192.168.10.2');

  const byIpRes = await fetch(`${baseUrl}/api/agent/hosts/192.168.10.1`);
  assert.equal(byIpRes.status, 200);
  const byIpData = await byIpRes.json();
  assert.equal(byIpData.host.id, 'gw-hermes');
  assert.equal(byIpData.host.name, 'Core Gateway');

  const bySlugRes = await fetch(`${baseUrl}/api/v1/hosts/office-access-point`);
  assert.equal(bySlugRes.status, 200);
  const bySlugData = await bySlugRes.json();
  assert.equal(bySlugData.host.id, 'ap-office');

  // 4. Verify filtering on GET /api/agent/hosts
  const apOnlyRes = await fetch(`${baseUrl}/api/agent/hosts?role=ap`);
  const apOnlyData = await apOnlyRes.json();
  assert.equal(apOnlyData.count, 1);
  assert.equal(apOnlyData.hosts[0].id, 'ap-office');

  // 5. Verify optional API Key authentication for external agents
  const keyGenRes = await fetch(`${baseUrl}/api/settings/agent-key/regenerate`, { method: 'POST' });
  assert.equal(keyGenRes.status, 200);
  const { apiKey } = await keyGenRes.json();
  assert.ok(apiKey.startsWith('owrt_'));

  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentApi: { enabled: true, requireApiKey: true, apiKey },
    }),
  });

  // Unauthenticated request should be rejected with 401
  const unauthRes = await fetch(`${baseUrl}/api/agent/status`);
  assert.equal(unauthRes.status, 401);

  // Authenticated via X-API-Key or Bearer token should succeed with 200
  const authHeaderRes = await fetch(`${baseUrl}/api/agent/status`, {
    headers: { 'X-API-Key': apiKey },
  });
  assert.equal(authHeaderRes.status, 200);

  const bearerRes = await fetch(`${baseUrl}/api/v1/hosts/192.168.10.1`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(bearerRes.status, 200);

  // Reset requireApiKey back to false and clean up hosts
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentApi: { enabled: true, requireApiKey: false, apiKey },
    }),
  });
  await hostManager.deleteHost('gw-hermes', true);
  await hostManager.deleteHost('ap-office', true);
});

test('Switch Port & FDB Resolution: parses DSA bridge ports and attributes wired devices to leaf switch ports across Gateway and APs', async () => {
  // 1. Verify human-readable switch port formatting
  assert.deepEqual(formatSwitchPortLabel('lan1', 2500), {
    iface: 'lan1',
    switchPort: 'LAN 1',
    portNumber: 1,
    portLabel: 'LAN 1 (lan1)',
    speedMbps: 2500,
    maxSpeedMbps: 2500,
  });
  assert.deepEqual(formatSwitchPortLabel('sfp1', 10000), {
    iface: 'sfp1',
    switchPort: 'SFP+ 1',
    portNumber: 1,
    portLabel: 'SFP+ 1 (sfp1)',
    speedMbps: 10000,
    maxSpeedMbps: 10000,
  });
  assert.deepEqual(formatSwitchPortLabel('eth2', 1000), {
    iface: 'eth2',
    switchPort: 'LAN 2',
    portNumber: 2,
    portLabel: 'LAN 2 (eth2)',
    speedMbps: 1000,
    maxSpeedMbps: 1000,
  });

  // 2. Gateway SSH telemetry with 3 DSA bridge ports (lan1=trunk to Office AP, lan2=Proxmox-Server, lan3=down)
  const gwSshOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Main-Gateway', model: 'GL.iNet GL-MT6000' }),
    '===UPTIME===',
    '12000.00 10000.00',
    '===MAC===',
    '94:83:c4:00:00:01',
    '===DHCP===',
    '1700000000 00:11:32:aa:bb:01 192.168.1.50 Synology-NAS *',
    '1700000000 24:5e:be:cc:dd:02 192.168.1.60 Proxmox-VE *',
    '===ARP===',
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.2      0x1         0x2         94:83:c4:00:00:02     *        br-lan',
    '192.168.1.50     0x1         0x2         00:11:32:aa:bb:01     *        br-lan',
    '192.168.1.60     0x1         0x2         24:5e:be:cc:dd:02     *        br-lan',
    '===SWITCH_FDB===',
    'BRPORT|br-lan|lan1|0x1|2500|full|up|1',
    'BRPORT|br-lan|lan2|0x2|2500|full|up|1',
    'BRPORT|br-lan|lan3|0x3|-1|unknown|down|0',
    // lan1 is the uplink trunk to Office AP (94:83:c4:00:00:02), so it also sees Synology-NAS (00:11:32:aa:bb:01)
    'FDB|94:83:c4:00:00:02|lan1|br-lan|1',
    'FDB|00:11:32:aa:bb:01|lan1|br-lan|1',
    // lan2 has Proxmox-VE directly attached
    'FDB|24:5e:be:cc:dd:02|lan2|br-lan|1',
  ].join('\n');

  // 3. Secondary Office AP SSH telemetry where Synology-NAS is plugged directly into leaf port lan4
  const apSshOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Office-AP', model: 'ASUS RT-AX53U' }),
    '===UPTIME===',
    '11000.00 9000.00',
    '===MAC===',
    '94:83:c4:00:00:02',
    '===SWITCH_FDB===',
    'BRPORT|br-lan|lan1|0x1|1000|full|up|1',
    'BRPORT|br-lan|lan4|0x4|1000|full|up|1',
    // lan1 on Office AP is the uplink back to Main-Gateway (94:83:c4:00:00:01)
    'FDB|94:83:c4:00:00:01|lan1|br-lan|1',
    'FDB|24:5e:be:cc:dd:02|lan1|br-lan|1',
    // lan4 on Office AP is the leaf port where Synology-NAS is plugged in
    'FDB|00:11:32:aa:bb:01|lan4|br-lan|1',
  ].join('\n');

  await hostManager.createHost({
    id: 'gw-sw-test',
    name: 'Main Gateway',
    ip: '192.168.1.1',
    role: 'gateway',
  });
  await hostManager.createHost({
    id: 'ap-sw-test',
    name: 'Office AP',
    ip: '192.168.1.2',
    role: 'ap',
  });

  const hostsList = await db.getHosts();
  const gwHost = hostsList.find((h) => h.id === 'gw-sw-test');
  const apHost = hostsList.find((h) => h.id === 'ap-sw-test');

  hostManager.applyTelemetryToHost(gwHost, parseSshTelemetryOutput(gwHost, gwSshOut));
  hostManager.applyTelemetryToHost(apHost, parseSshTelemetryOutput(apHost, apSshOut));
  await db.saveHosts(hostsList);

  const liveClients = hostManager.getLiveClients();
  const nasClient = liveClients.find((c) => c.mac.toLowerCase() === '00:11:32:aa:bb:01');
  const proxmoxClient = liveClients.find((c) => c.mac.toLowerCase() === '24:5e:be:cc:dd:02');

  assert.ok(nasClient, 'Expected Synology-NAS in liveClients');
  assert.ok(proxmoxClient, 'Expected Proxmox-VE in liveClients');

  // Synology-NAS should be resolved to Office AP's leaf port LAN 4 (lan4 @ 1000 Mbps) rather than Gateway's trunk port lan1
  assert.equal(nasClient.connectedTo.hostId, 'ap-sw-test');
  assert.equal(nasClient.connectedTo.hostName, 'Office AP');
  assert.equal(nasClient.connectedTo.iface, 'lan4');
  assert.equal(nasClient.connectedTo.switchPort, 'LAN 4');
  assert.equal(nasClient.connectedTo.portLabel, 'LAN 4 (lan4)');
  assert.equal(nasClient.connectedTo.speedMbps, 1000);

  // Proxmox-VE should be resolved to Main Gateway's leaf port LAN 2 (lan2 @ 2500 Mbps)
  assert.equal(proxmoxClient.connectedTo.hostId, 'gw-sw-test');
  assert.equal(proxmoxClient.connectedTo.hostName, 'Main Gateway');
  assert.equal(proxmoxClient.connectedTo.iface, 'lan2');
  assert.equal(proxmoxClient.connectedTo.switchPort, 'LAN 2');
  assert.equal(proxmoxClient.connectedTo.portLabel, 'LAN 2 (lan2)');
  assert.equal(proxmoxClient.connectedTo.speedMbps, 2500);

  // Verify host.switchPorts includes connectedDevices (both wired clients and downstream APs on trunk ports)
  const enrichedHosts = await hostManager.getAllHosts();
  const enrichedGw = enrichedHosts.find((h) => h.id === 'gw-sw-test');
  const enrichedAp = enrichedHosts.find((h) => h.id === 'ap-sw-test');

  const gwLan1 = enrichedGw.switchPorts.find((p) => p.iface === 'lan1');
  const gwLan2 = enrichedGw.switchPorts.find((p) => p.iface === 'lan2');
  const apLan1 = enrichedAp.switchPorts.find((p) => p.iface === 'lan1');
  const apLan4 = enrichedAp.switchPorts.find((p) => p.iface === 'lan4');

  assert.equal(gwLan1.portRole, 'trunk');
  assert.ok(gwLan1.connectedDevices.some((d) => d.hostname === 'Office AP' && d.type === 'ap' && d.remoteIface === 'lan1'));
  assert.equal(gwLan2.portRole, 'access');
  assert.ok(gwLan2.connectedDevices.some((d) => d.hostname === 'Proxmox-VE'));
  assert.equal(apLan1.portRole, 'uplink');
  assert.ok(apLan1.connectedDevices.some((d) => d.id === 'gw-sw-test' && d.remoteIface === 'lan1'));
  assert.equal(apLan4.portRole, 'access');
  assert.ok(apLan4.connectedDevices.some((d) => d.hostname === 'Synology-NAS'));

  // Verify cross-host nicInfo on Office AP
  assert.equal(enrichedAp.nicInfo.localIface, 'lan1');
  assert.equal(enrichedAp.nicInfo.localPort, 'LAN 1');
  assert.equal(enrichedAp.nicInfo.upstreamHostId, 'gw-sw-test');
  assert.equal(enrichedAp.nicInfo.upstreamIface, 'lan1');
  assert.equal(enrichedAp.nicInfo.upstreamPort, 'LAN 1');

  // Verify GET /api/topology includes nicInfo on host nodes and sourcePort + targetPort on inter-host links
  const topoRes = await fetch(`${baseUrl}/api/topology`);
  const topoData = await topoRes.json();
  const gwToApLink = topoData.links.find((l) => l.source === 'gw-sw-test' && l.target === 'ap-sw-test');
  assert.ok(gwToApLink);
  assert.equal(gwToApLink.sourcePort, 'LAN 1');
  assert.equal(gwToApLink.sourceIface, 'lan1');
  assert.equal(gwToApLink.targetPort, 'LAN 1');
  assert.equal(gwToApLink.targetIface, 'lan1');

  await hostManager.deleteHost('gw-sw-test', true);
  await hostManager.deleteHost('ap-sw-test', true);
});

test('24-Port Core Switch: parses all 24 LAN + SFP+ ports on switch bridge / swconfig and strips switch.1', async () => {
  // 1. Test 24-port DSA Realtek Core Switch (`switch` bridge with lan1..lan24 + sfp1..sfp2, plus br-lan enslaving switch.1)
  const dsaLines = [
    'HOSTIF|eth0|aa:bb:cc:00:24:00|',
    'HOSTIF|switch.1|aa:bb:cc:00:24:00|192.168.1.2',
    'DEFROUTE|192.168.1.1|switch.1|192.168.1.2',
    // Virtual VLAN bridge port that previously caused only 1 port (`switch.1`) to appear when only `br-*` was scanned
    'BRPORT|br-lan|switch.1|0x1|1000|full|up|1|aa:bb:cc:00:24:00',
    // CPU master conduit eth0
    'NICPORT|eth0|aa:bb:cc:00:24:00|10000|full|up|1|',
  ];
  for (let i = 1; i <= 24; i++) {
    const isUp = i === 1 || i === 5 || i === 12 || i === 24;
    dsaLines.push(
      `BRPORT|switch|lan${i}|0x${i.toString(16)}|${isUp ? '1000' : ''}|full|${isUp ? 'up' : 'down'}|${isUp ? '1' : '0'}|aa:bb:cc:00:24:${i.toString(16).padStart(2, '0')}`
    );
  }
  dsaLines.push('BRPORT|switch|sfp1|0x19|10000|full|up|1|aa:bb:cc:00:24:fa');
  dsaLines.push('BRPORT|switch|sfp2|0x1a||full|down|0|aa:bb:cc:00:24:fb');
  // FDB has both the hardware port (`lan5`) and the software bridge VLAN subinterface (`switch.1`)
  dsaLines.push('FDB|de:ad:be:ef:00:05|lan5|switch|1');
  dsaLines.push('FDB|de:ad:be:ef:00:05|switch.1|br-lan|1');

  const dsaParsed = parseSwitchFdbSection(dsaLines.join('\n'));
  assert.equal(dsaParsed.switchPorts.length, 26, 'Expected 24 copper LAN ports + 2 SFP+ cages (switch.1 and eth0 excluded)');
  assert.equal(dsaParsed.switchPorts[0].switchPort, 'LAN 1');
  assert.equal(dsaParsed.switchPorts[23].switchPort, 'LAN 24');
  assert.equal(dsaParsed.switchPorts[24].switchPort, 'SFP+ 1');
  assert.equal(dsaParsed.switchPorts[25].switchPort, 'SFP+ 2');
  assert.ok(!dsaParsed.switchPorts.some((p) => p.iface === 'switch.1' || p.iface === 'eth0'));
  // Ensure `switch.1` did NOT overwrite `lan5` in fdbByMac
  assert.equal(dsaParsed.fdbByMac.get('de:ad:be:ef:00:05')?.iface, 'lan5');
  assert.equal(dsaParsed.fdbByMac.get('de:ad:be:ef:00:05')?.switchPort, 'LAN 5');

  // 2. Test 24-port swconfig switch where /sys/class/net only has eth0 and eth0.1
  const swconfigLines = [
    'BRPORT|br-lan|eth0.1|0x1|1000|full|up|1|aa:bb:cc:11:24:00',
    'NICPORT|eth0|aa:bb:cc:11:24:00|1000|full|up|1|',
  ];
  for (let i = 1; i <= 24; i++) {
    const st = i <= 4 ? 'up' : 'down';
    swconfigLines.push(`SWPORT|switch0|${i}|${st}|${st === 'up' ? '1000baseT' : ''}|full-duplex`);
  }
  const swParsed = parseSwitchFdbSection(swconfigLines.join('\n'));
  assert.equal(swParsed.switchPorts.length, 24, 'Expected all 24 swconfig ports instead of single eth0/eth0.1');
  assert.equal(swParsed.switchPorts[0].switchPort, 'Port 1');
  assert.equal(swParsed.switchPorts[23].switchPort, 'Port 24');
});

test('LAN Port Hardware Capability (maxSpeedMbps): parses PORTCAP and infers default capable speed when running slower', async () => {
  const capLines = [
    'BRPORT|switch|lan1|0x1|100|full|up|1|aa:bb:cc:00:99:01',
    'BRPORT|switch|lan2|0x2|1000|full|up|1|aa:bb:cc:00:99:02',
    'BRPORT|switch|lan3|0x3|1000|full|up|1|aa:bb:cc:00:99:03',
    'BRPORT|switch|sfp1|0x19|1000|full|up|1|aa:bb:cc:00:99:19',
    // Explicit hardware capabilities from netifd / ethtool:
    // lan1 is a 1G port running at 100M; lan2 is a 2.5G port running at 1G; sfp1 is a 10G SFP+ cage running at 1G
    'PORTCAP|lan1|1000|100',
    'PORTCAP|lan2|2500|1000',
    'PORTCAP|sfp1|10000|1000',
    'FDB|aa:11:22:33:44:01|lan1|switch|1',
    'FDB|aa:11:22:33:44:02|lan2|switch|1',
  ];

  const parsed = parseSwitchFdbSection(capLines.join('\n'));
  const lan1 = parsed.switchPorts.find((p) => p.iface === 'lan1');
  const lan2 = parsed.switchPorts.find((p) => p.iface === 'lan2');
  const lan3 = parsed.switchPorts.find((p) => p.iface === 'lan3');
  const sfp1 = parsed.switchPorts.find((p) => p.iface === 'sfp1');

  assert.equal(lan1.speedMbps, 100);
  assert.equal(lan1.maxSpeedMbps, 1000);
  assert.equal(lan2.speedMbps, 1000);
  assert.equal(lan2.maxSpeedMbps, 2500);
  assert.equal(lan3.speedMbps, 1000);
  assert.equal(lan3.maxSpeedMbps, 1000);
  assert.equal(sfp1.speedMbps, 1000);
  assert.equal(sfp1.maxSpeedMbps, 10000);

  // Verify FDB entry also carries maxSpeedMbps for client & host port resolution
  assert.equal(parsed.fdbByMac.get('aa:11:22:33:44:01')?.speedMbps, 100);
  assert.equal(parsed.fdbByMac.get('aa:11:22:33:44:01')?.maxSpeedMbps, 1000);
  assert.equal(parsed.fdbByMac.get('aa:11:22:33:44:02')?.speedMbps, 1000);
  assert.equal(parsed.fdbByMac.get('aa:11:22:33:44:02')?.maxSpeedMbps, 2500);

  // Verify UCINET-discovered ports with active FDB MACs, LINKUP (LOWER_UP), bridge STP state=3, or SWPORT are marked UP
  const uciActiveLines = [
    'HOSTIF|lan1|00:11:22:33:44:01|',
    "UCINET|network.@device[0].ports='lan1' 'lan2' 'lan3' 'lan4' 'lan5' 'lan6'",
    'PORTCAP|lan1|1000|1000|1|1',
    'PORTCAP|lan2|1000|1000|0|1',
    'PORTCAP|lan3|1000||0|0',
    // lan4 has sysfs operstate=unknown and speed=-1, but bridge STP state is 3 (forwarding)
    'BRPORT|switch|lan4|0x4|-1|full|unknown||00:11:22:33:44:04|3',
    // lan5 is reported UP via ip link LOWER_UP (`LINKUP|lan5`)
    'LINKUP|lan5',
    // lan6 is reported UP via swconfig (`SWPORT|switch0|6|up|1000baseT|full-duplex`)
    'SWPORT|switch0|6|up|1000baseT|full-duplex',
    'FDB|aa:bb:cc:dd:ee:02|lan2|switch|1',
    // Multicast MAC and host's own interface MAC should be ignored from connectedMacs
    'FDB|33:33:00:00:00:01|lan3|switch|1',
    'FDB|00:11:22:33:44:01|lan3|switch|1',
  ];
  const uciParsed = parseSwitchFdbSection(uciActiveLines.join('\n'));
  const uLan1 = uciParsed.switchPorts.find((p) => p.iface === 'lan1');
  const uLan2 = uciParsed.switchPorts.find((p) => p.iface === 'lan2');
  const uLan3 = uciParsed.switchPorts.find((p) => p.iface === 'lan3');
  const uLan4 = uciParsed.switchPorts.find((p) => p.iface === 'lan4');
  const uLan5 = uciParsed.switchPorts.find((p) => p.iface === 'lan5');
  const uLan6 = uciParsed.switchPorts.find((p) => p.iface === 'lan6');
  assert.equal(uLan1.status, 'up');
  assert.equal(uLan1.linkUp, true);
  assert.equal(uLan2.status, 'up');
  assert.equal(uLan2.linkUp, true);
  assert.equal(uLan3.status, 'down');
  assert.equal(uLan3.linkUp, false);
  assert.equal(uLan4.status, 'up');
  assert.equal(uLan4.linkUp, true);
  assert.equal(uLan5.status, 'up');
  assert.equal(uLan5.linkUp, true);
  assert.equal(uLan6.status, 'up');
  assert.equal(uLan6.linkUp, true);

  // Verify ===NETDEV_STATUS=== JSON parsing in parseSshTelemetryOutput and partial fallback preservation
  const fullSshWithNetdevStatus = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Switch-Core', model: 'ZyXEL GS1900-24' }),
    '===UPTIME===',
    '3600.00 3000.00',
    '===DHCP===',
    '1700000000 aa:bb:cc:dd:ee:99 192.168.1.99 Workstation-PC *',
    '===NETDEV_STATUS===',
    JSON.stringify({
      lan1: {
        up: true,
        carrier: true,
        speed: '100F',
        'link-supported': ['10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F'],
      },
      lan2: {
        up: true,
        carrier: true,
        speed: '1000F',
        'link-supported': ['100baseT-F', '1000baseT-F', '2500baseT-F'],
      },
    }),
    '===SWITCH_FDB===',
    'BRPORT|switch|lan1|0x1|100|full|up|1|00:11:22:33:44:01',
    'BRPORT|switch|lan2|0x2|1000|full|up|1|00:11:22:33:44:02',
    'FDB|aa:bb:cc:dd:ee:99|lan1|switch|1',
  ].join('\n');

  const swHost = await hostManager.createHost({
    id: 'sw-netdev-test',
    name: 'Switch Core',
    ip: '192.168.1.3',
    role: 'switch',
  });
  const parsedFull = parseSshTelemetryOutput(swHost, fullSshWithNetdevStatus);
  assert.equal(parsedFull.switchPorts.find((p) => p.iface === 'lan1')?.speedMbps, 100);
  assert.equal(parsedFull.switchPorts.find((p) => p.iface === 'lan1')?.maxSpeedMbps, 1000);
  assert.equal(parsedFull.switchPorts.find((p) => p.iface === 'lan2')?.speedMbps, 1000);
  assert.equal(parsedFull.switchPorts.find((p) => p.iface === 'lan2')?.maxSpeedMbps, 2500);

  const allDbHosts = await db.getHosts();
  const dbSwHost = allDbHosts.find((h) => h.id === 'sw-netdev-test');
  hostManager.applyTelemetryToHost(dbSwHost, parsedFull);
  assert.ok(hostManager.getLiveClients().some((c) => c.mac.toLowerCase() === 'aa:bb:cc:dd:ee:99'));

  // Simulate a subsequent partial fallback poll with empty clients/dhcpMap and ensure existing client data is preserved
  hostManager.applyTelemetryToHost(dbSwHost, {
    online: true,
    isPartialFallback: true,
    uptimeSec: 3630,
    clients: [],
    dhcpMap: {},
    arpMap: {},
    fdbMap: {},
    switchPorts: [],
  });
  assert.ok(hostManager.getLiveClients().some((c) => c.mac.toLowerCase() === 'aa:bb:cc:dd:ee:99'));

  // Verify 24-port managed switch where ports come from UCINET/NICPORT and FDB comes from BRMAC (brforward) or VLAN subinterfaces
  const managed24Out = [
    "UCINET|network.@device[0].ports='lan1' 'lan2' 'lan3' 'lan4'",
    'NICPORT|lan1|00:aa:bb:cc:dd:01|1000|full|down|0|switch|3|1',
    'NICPORT|lan2|00:aa:bb:cc:dd:01|-1|unknown|down|0|switch|0|2',
    'NICPORT|lan3|00:aa:bb:cc:dd:01|-1|unknown|down|0|switch|0|3',
    'BRMAC|switch|2|aa:bb:cc:11:22:33',
    'FDB|aa:bb:cc:44:55:66|lan4.1|switch|1',
  ].join('\n');
  const parsedM24 = parseSwitchFdbSection(managed24Out);
  assert.equal(parsedM24.switchPorts.find((p) => p.iface === 'lan1')?.linkUp, true); // brport/state=3 forwarding
  assert.equal(parsedM24.switchPorts.find((p) => p.iface === 'lan2')?.linkUp, true); // BRMAC on portNo 2
  assert.ok(parsedM24.switchPorts.find((p) => p.iface === 'lan2')?.connectedMacs.includes('aa:bb:cc:11:22:33'));
  assert.equal(parsedM24.switchPorts.find((p) => p.iface === 'lan3')?.linkUp, false);
  assert.equal(parsedM24.switchPorts.find((p) => p.iface === 'lan4')?.linkUp, true); // FDB on lan4.1 matched to lan4

  await hostManager.deleteHost('sw-netdev-test', true);
});

test('Dumb Switch Detection: identifies switch ports seeing multiple hosts not on a downstream managed switch', async () => {
  await hostManager.createHost({
    id: 'gw-dumb-test',
    name: 'Main Gateway',
    ip: '192.168.10.1',
    role: 'gateway',
  });
  await hostManager.createHost({
    id: 'sw-dumb-test',
    name: 'Managed Switch 24P',
    ip: '192.168.10.2',
    role: 'switch',
  });

  const gwOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Main-Gateway', model: 'OpenWrt One' }),
    '===UPTIME===',
    '7200.00 6000.00',
    '===DHCP===',
    '1700000000 00:11:22:aa:bb:01 192.168.10.50 Desk-PC-1 *',
    '1700000000 00:11:22:aa:bb:02 192.168.10.51 Desk-PC-2 *',
    '1700000000 00:11:22:aa:bb:03 192.168.10.52 Solo-NAS *',
    '===SWITCH_FDB===',
    'HOSTIF|br-lan|aa:00:00:00:00:01|192.168.10.1',
    'BRPORT|br-lan|lan1|0x1|1000|full|up|1|aa:00:00:00:00:01|3',
    // Gateway lan1 connects to Managed Switch (aa:00:00:00:00:02) and sees all 3 wired clients through it
    'FDB|aa:00:00:00:00:02|lan1|br-lan|1',
    'FDB|00:11:22:aa:bb:01|lan1|br-lan|1',
    'FDB|00:11:22:aa:bb:02|lan1|br-lan|1',
    'FDB|00:11:22:aa:bb:03|lan1|br-lan|1',
  ].join('\n');

  const swOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Managed-Switch', model: 'ZyXEL GS1900-24' }),
    '===UPTIME===',
    '7200.00 6500.00',
    '===SWITCH_FDB===',
    'HOSTIF|switch.1|aa:00:00:00:00:02|192.168.10.2',
    "UCINET|network.@device[0].ports='lan1' 'lan2' 'lan3' 'lan4' 'lan5' 'lan6' 'lan7' 'lan8'",
    'BRPORT|switch|lan1|0x1|1000|full|up|1|aa:00:00:00:00:02|3',
    'BRPORT|switch|lan2|0x2|1000|full|up|1|aa:00:00:00:00:02|3',
    'BRPORT|switch|lan3|0x3|1000|full|up|1|aa:00:00:00:00:02|3',
    // lan1 is uplink to Gateway
    'FDB|aa:00:00:00:00:01|lan1|switch|1',
    // lan2 has a 5-port dumb switch with 2 wired hosts (Desk-PC-1 and Desk-PC-2)
    'FDB|00:11:22:aa:bb:01|lan2|switch|1',
    'FDB|00:11:22:aa:bb:02|lan2|switch|1',
    // lan3 has a single wired host (Solo-NAS)
    'FDB|00:11:22:aa:bb:03|lan3|switch|1',
  ].join('\n');

  const allDb = await db.getHosts();
  hostManager.applyTelemetryToHost(
    allDb.find((h) => h.id === 'gw-dumb-test'),
    parseSshTelemetryOutput({ id: 'gw-dumb-test' }, gwOut)
  );
  hostManager.applyTelemetryToHost(
    allDb.find((h) => h.id === 'sw-dumb-test'),
    parseSshTelemetryOutput({ id: 'sw-dumb-test' }, swOut)
  );

  const resolvedHosts = await hostManager.getAllHosts();
  const gwResolved = resolvedHosts.find((h) => h.id === 'gw-dumb-test');
  const swResolved = resolvedHosts.find((h) => h.id === 'sw-dumb-test');

  // Gateway lan1 connects to Managed Switch -> NOT a dumb switch
  const gwLan1 = gwResolved.switchPorts.find((p) => p.iface === 'lan1');
  assert.equal(gwLan1.hasUnmanagedSwitch, false);

  // Managed Switch lan1 is uplink to Gateway -> NOT a dumb switch
  const swLan1 = swResolved.switchPorts.find((p) => p.iface === 'lan1');
  assert.equal(swLan1.hasUnmanagedSwitch, false);

  // Managed Switch lan2 has 2 wired hosts not on a downstream managed switch -> IS a dumb switch!
  const swLan2 = swResolved.switchPorts.find((p) => p.iface === 'lan2');
  assert.equal(swLan2.hasUnmanagedSwitch, true);
  assert.equal(swLan2.unmanagedSwitch.deviceCount, 2);

  // Managed Switch lan3 has only 1 wired host -> NOT a dumb switch
  const swLan3 = swResolved.switchPorts.find((p) => p.iface === 'lan3');
  assert.equal(swLan3.hasUnmanagedSwitch, false);

  // Verify topology response includes the unmanaged_switch node
  const topoRes = await fetch(`${baseUrl}/api/topology`);
  assert.equal(topoRes.status, 200);
  const topoBody = await topoRes.json();
  const dumbNode = topoBody.nodes.find((n) => n.type === 'unmanaged_switch' && n.parentHostId === 'sw-dumb-test');
  assert.ok(dumbNode, 'Expected unmanaged_switch node in topology');
  assert.equal(dumbNode.parentIface, 'lan2');

  await hostManager.deleteHost('gw-dumb-test', true);
  await hostManager.deleteHost('sw-dumb-test', true);
});

test('Static Data Caching & Lightweight Dynamic Polling: caches static device data across polls and supports forced full refresh', async () => {
  // 1. Verify buildTelemetrySshScript omits heavy static commands and sleep 1 in dynamic mode
  const fullScript = buildTelemetrySshScript({ full: true, hasPrevCpuSample: false });
  assert.ok(fullScript.includes('ubus call system board'), 'Full script must query board info');
  assert.ok(fullScript.includes('sleep 1'), 'Initial full script without prev CPU sample must include sleep 1');
  assert.ok(fullScript.includes('opkg list-upgradable'), 'Full script must check upgradable packages');
  assert.ok(fullScript.includes('ethtool'), 'Full script must query ethtool capabilities');

  const fullScriptWithPrevCpu = buildTelemetrySshScript({ full: true, hasPrevCpuSample: true });
  assert.ok(!fullScriptWithPrevCpu.includes('sleep 1'), 'Full script with prev CPU sample must skip sleep 1');

  const dynamicScript = buildTelemetrySshScript({ full: false, hasPrevCpuSample: true, hasWirelessRadios: true });
  assert.ok(!dynamicScript.includes('ubus call system board'), 'Dynamic script must skip ubus system board');
  assert.ok(!dynamicScript.includes('sleep 1'), 'Dynamic script must skip sleep 1');
  assert.ok(!dynamicScript.includes('opkg list-upgradable'), 'Dynamic script must skip opkg list-upgradable');
  assert.ok(!dynamicScript.includes('ethtool'), 'Dynamic script must skip ethtool');
  assert.ok(!dynamicScript.includes('uci show'), 'Dynamic script must skip uci show');
  assert.ok(!dynamicScript.includes('scan dump'), 'Dynamic script must skip iw scan dump');
  assert.ok(!dynamicScript.includes('nslookup'), 'Dynamic script must skip nslookup loop');
  assert.ok(dynamicScript.includes('===UPTIME==='), 'Dynamic script must include /proc/uptime');
  assert.ok(dynamicScript.includes('===CPUSTAT2==='), 'Dynamic script must include single /proc/stat sample');
  assert.ok(dynamicScript.includes('===STATIONS==='), 'Dynamic script for AP must include station dump');

  const dynamicWiredSwitchScript = buildTelemetrySshScript({ full: false, hasPrevCpuSample: true, hasWirelessRadios: false });
  assert.ok(!dynamicWiredSwitchScript.includes('===IWDEV==='), 'Dynamic script for wired switch with 0 radios must skip iw commands');

  // 2. Verify parseSshTelemetryOutput caches static sections on full poll and merges them on subsequent dynamic polls
  const hostCfg = { id: 'cache-test-gw', name: 'Cache Gateway', role: 'gateway' };
  const fullStdout = [
    '===BOARD===',
    JSON.stringify({
      hostname: 'OpenWrt-Gateway-Pro',
      model: 'GL.iNet GL-MT6000',
      release: { description: 'OpenWrt 23.05.3 r23809' },
    }),
    '===RELEASE===',
    'DISTRIB_DESCRIPTION="OpenWrt 23.05.3 r23809"',
    '===UPTIME===',
    '1000.00 900.00',
    '===MEMINFO===',
    'MemTotal:       1000000 kB\nMemAvailable:    700000 kB',
    '===CPUSTAT1===',
    'cpu  1000 0 500 8500 0 0 0 0 0 0',
    '===CPUSTAT2===',
    'cpu  1100 0 550 9350 0 0 0 0 0 0',
    '===MAC===',
    '94:83:c4:aa:bb:01',
    '===NETDEV===',
    '  eth1: 1000000 100 0 0 0 0 0 0 500000 50 0 0 0 0 0 0',
    '===WAN===',
    JSON.stringify({
      l3_device: 'eth1',
      'ipv4-address': [{ address: '203.0.113.10', mask: 24 }],
      route: [{ nexthop: '203.0.113.1' }],
      'dns-server': ['1.1.1.1'],
    }),
    '===WIRELESS===',
    JSON.stringify({
      radio0: {
        config: { band: '5g', channel: '36', htmode: 'HE80', txpower: 23 },
        interfaces: [{ ifname: 'phy0-ap0', config: { ssid: 'HomeMesh-5G' } }],
      },
    }),
    '===IWDEV===',
    'phy#0\n\tInterface phy0-ap0\n\t\taddr 94:83:c4:aa:bb:02\n\t\tssid HomeMesh-5G\n\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz\n\t\ttxpower 23.00 dBm',
    '===SCANDUMP===',
    '---IFACE:phy0-ap0---\nBSS 11:22:33:44:55:66(on phy0-ap0)\n\tfreq: 5180\n\tsignal: -62.00 dBm\n\tSSID: NeighborNet',
    '===UCI_DHCP===',
    "dhcp.@host[0].mac='aa:bb:cc:dd:ee:10'\ndhcp.@host[0].ip='192.168.1.50'\ndhcp.@host[0].name='Static-NAS'",
    '===NETDEV_STATUS===',
    JSON.stringify({
      lan1: {
        up: true,
        carrier: true,
        speed: '1000F',
        'link-supported': ['100baseT-F', '1000baseT-F', '2500baseT-F'],
      },
    }),
    '===SWITCH_FDB===',
    'HOSTIF|br-lan|94:83:c4:aa:bb:01|192.168.1.1',
    'DEFROUTE|203.0.113.1|eth1|203.0.113.10',
    "UCINET|network.@device[0].ports='lan1' 'lan2'",
    'BRPORT|br-lan|lan1|0x1|1000|full|up|1|94:83:c4:aa:bb:01|3',
    'FDB|aa:bb:cc:dd:ee:10|lan1|br-lan|1',
    '===OPKG_UPGRADABLE===',
    'curl - 8.4.0-1 - 8.5.0-1\ndnsmasq - 2.89-1 - 2.90-1',
    '===ASU_STATUS===',
    'INSTALLED=1\nCLI=owut',
  ].join('\n');

  const firstRes = parseSshTelemetryOutput(hostCfg, fullStdout, null, { isFullPoll: true });
  assert.equal(firstRes.pollMode, 'full');
  assert.ok(firstRes.sample.staticCache, 'Full poll must populate sample.staticCache');
  assert.equal(firstRes.hostname, 'OpenWrt-Gateway-Pro');
  assert.equal(firstRes.model, 'GL.iNet GL-MT6000');
  assert.equal(firstRes.firmware, 'OpenWrt 23.05.3 r23809');
  assert.equal(firstRes.updates.packagesCount, 2);
  assert.equal(firstRes.neighbors.length, 1);
  assert.equal(firstRes.switchPorts.find((p) => p.iface === 'lan1')?.maxSpeedMbps, 2500);
  assert.equal(firstRes.switchPorts.length, 2, 'Both lan1 (active) and lan2 (from UCINET) should be present');

  // Now simulate a lightweight dynamic poll 10 seconds later (ONLY dynamic sections, no BOARD, RELEASE, WIRELESS, UCI_DHCP, NETDEV_STATUS, UCINET, SCANDUMP, OPKG_UPGRADABLE, CPUSTAT1)
  firstRes.sample.timestamp = Date.now() - 10000;
  const dynamicStdout = [
    '===UPTIME===',
    '1010.00 908.00',
    '===MEMINFO===',
    'MemTotal:       1000000 kB\nMemAvailable:    600000 kB',
    '===CPUSTAT2===',
    // Delta from firstRes CPUSTAT2 (total=11000, idle=9350) -> new (total=12000, idle=9850) => dTotal=1000, dIdle=500 => 50% CPU
    'cpu  1400 0 750 9850 0 0 0 0 0 0',
    '===NETDEV===',
    '  eth1: 2250000 200 0 0 0 0 0 0 1000000 100 0 0 0 0 0 0',
    '===IWDEV===',
    'phy#0\n\tInterface phy0-ap0\n\t\taddr 94:83:c4:aa:bb:02\n\t\tssid HomeMesh-5G\n\t\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz\n\t\ttxpower 23.00 dBm',
    '===STATIONS===',
    '---IFACE:phy0-ap0---\nStation dc:a6:32:11:22:33 (on phy0-ap0)\n\trx bytes:\t50000\n\ttx bytes:\t80000\n\tsignal:  \t-54 dBm\n\ttx bitrate:\t866.7 MBit/s\n\trx bitrate:\t780.0 MBit/s',
    '===DHCP===',
    `${Math.floor(Date.now() / 1000) + 7200} dc:a6:32:11:22:33 192.168.1.120 LivingRoom-Pi *`,
    '===ARP===',
    'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.50     0x1         0x2         aa:bb:cc:dd:ee:10     *        br-lan\n192.168.1.120    0x1         0x2         dc:a6:32:11:22:33     *        br-lan',
    '===SWITCH_FDB===',
    'BRPORT|br-lan|lan1|0x1|1000|full|up|1|94:83:c4:aa:bb:01|3',
    'FDB|aa:bb:cc:dd:ee:10|lan1|br-lan|1',
  ].join('\n');

  const dynRes = parseSshTelemetryOutput(hostCfg, dynamicStdout, firstRes.sample, { isFullPoll: false });
  assert.equal(dynRes.pollMode, 'dynamic');
  // Verify dynamic metrics updated:
  assert.equal(dynRes.uptimeSec, 1010);
  assert.equal(dynRes.memUsagePct, 40);
  assert.equal(dynRes.cpuUsagePct, 50, 'CPU usage should be computed from delta against prevSample.cpuStat without sleep 1');
  assert.ok(dynRes.rxRateBps > 0, 'WAN throughput rxRateBps should be computed using cached wan l3_device (eth1)');
  // Verify static metadata was preserved from cache:
  assert.equal(dynRes.hostname, 'OpenWrt-Gateway-Pro');
  assert.equal(dynRes.model, 'GL.iNet GL-MT6000');
  assert.equal(dynRes.firmware, 'OpenWrt 23.05.3 r23809');
  assert.equal(dynRes.mac, '94:83:c4:aa:bb:01');
  assert.equal(dynRes.wan?.ip, '203.0.113.10');
  assert.equal(dynRes.defaultRoute?.gatewayIp, '203.0.113.1');
  assert.equal(dynRes.updates.packagesCount, 2, 'Cached package update count must be preserved');
  assert.equal(dynRes.neighbors.length, 1, 'Cached neighbor scan dump must be preserved');
  assert.equal(dynRes.switchPorts.length, 2, 'Cached UCINET unbridged ports must be preserved');
  assert.equal(dynRes.switchPorts.find((p) => p.iface === 'lan1')?.maxSpeedMbps, 2500, 'Cached port hardware capability must be preserved');
  // Verify both the static UCI DHCP reservation client (Static-NAS) and dynamic WiFi client (LivingRoom-Pi) are resolved:
  assert.ok(dynRes.clients.some((c) => c.hostname === 'Static-NAS' && c.ip === '192.168.1.50'));
  assert.ok(dynRes.clients.some((c) => c.hostname === 'LivingRoom-Pi' && c.ip === '192.168.1.120'));

  // 3. Verify POST /api/hosts/refresh forces a full update and returns the refreshed fleet bundle
  await hostManager.createHost({
    id: 'cache-test-gw',
    name: 'Cache Gateway',
    ip: '192.168.99.1',
    role: 'gateway',
  });
  const allDb = await db.getHosts();
  hostManager.applyTelemetryToHost(
    allDb.find((h) => h.id === 'cache-test-gw'),
    dynRes
  );
  assert.ok(hostManager.prevSamples.get('cache-test-gw')?.staticCache, 'staticCache should be present before invalidation');
  hostManager.invalidateStaticCache('cache-test-gw');
  assert.equal(hostManager.prevSamples.get('cache-test-gw')?.staticCache, undefined, 'invalidateStaticCache should clear staticCache');
  assert.ok(hostManager.prevSamples.get('cache-test-gw')?.cpuStat, 'invalidateStaticCache should preserve cpuStat delta counter');

  const refreshRes = await fetch(`${baseUrl}/api/hosts/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId: 'all', full: true }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshBody = await refreshRes.json();
  assert.equal(refreshBody.refreshed, true);
  assert.equal(refreshBody.mode, 'full');
  assert.ok(Array.isArray(refreshBody.hosts));
  assert.ok(refreshBody.topology);
  assert.ok(Array.isArray(refreshBody.clients));

  await hostManager.deleteHost('cache-test-gw', true);
});

test('Single-Core Device Adaptive Polling: detects single-core managed switches, minimizes sysfs subshells, and throttles background polling rate', async () => {
  // 1. Verify buildTelemetrySshScript uses shell built-in `read -r` instead of `$(cat ...)` subshells in BRPORT/NICPORT loops
  const dynamicSwitchScript = buildTelemetrySshScript({
    full: false,
    hasPrevCpuSample: true,
    hasWirelessRadios: false,
  });
  assert.ok(
    dynamicSwitchScript.includes("grep '^cpu' /proc/stat"),
    'Dynamic script must query ^cpu lines from /proc/stat to detect CPU core count'
  );
  assert.ok(
    dynamicSwitchScript.includes('read -r spd < "$d/speed"'),
    'Dynamic script must use shell built-in read -r for sysfs port attributes to avoid subshell fork spikes'
  );
  assert.ok(
    !dynamicSwitchScript.includes('$(cat "$d/speed"'),
    'Dynamic script must not spawn $(cat "$d/speed") subshells per port'
  );

  // 2. Verify parseSshTelemetryOutput detects 1 CPU core vs 4 CPU cores from /proc/stat and caches cpuCores
  const singleCoreSwitchOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'ZyXEL-Switch', model: 'ZyXEL GS1900-24' }),
    '===UPTIME===',
    '5000.00 4800.00',
    '===CPUSTAT1===',
    'cpu  500 0 200 4300 0 0 0 0 0 0',
    '===CPUSTAT2===',
    'cpu  520 0 210 4370 0 0 0 0 0 0\ncpu0 520 0 210 4370 0 0 0 0 0 0',
  ].join('\n');

  const quadCoreRouterOut = [
    '===BOARD===',
    JSON.stringify({ hostname: 'Main-Router', model: 'GL.iNet GL-MT6000' }),
    '===UPTIME===',
    '5000.00 18000.00',
    '===CPUSTAT1===',
    'cpu  1000 0 400 18600 0 0 0 0 0 0',
    '===CPUSTAT2===',
    [
      'cpu  1040 0 420 18940 0 0 0 0 0 0',
      'cpu0 260 0 105 4735 0 0 0 0 0 0',
      'cpu1 260 0 105 4735 0 0 0 0 0 0',
      'cpu2 260 0 105 4735 0 0 0 0 0 0',
      'cpu3 260 0 105 4735 0 0 0 0 0 0',
    ].join('\n'),
  ].join('\n');

  const parsedSingle = parseSshTelemetryOutput({ id: 'sw-1core' }, singleCoreSwitchOut);
  assert.equal(parsedSingle.cpuCores, 1, 'Switch with only cpu0 in /proc/stat must be detected as 1 CPU core');
  assert.equal(parsedSingle.sample.staticCache.cpuCores, 1);

  const parsedQuad = parseSshTelemetryOutput({ id: 'gw-4core' }, quadCoreRouterOut);
  assert.equal(parsedQuad.cpuCores, 4, 'Router with cpu0..cpu3 in /proc/stat must be detected as 4 CPU cores');
  assert.equal(parsedQuad.sample.staticCache.cpuCores, 4);

  // 3. Verify HostManager throttles background polling for single-core devices while polling multi-core devices at normal rate
  await hostManager.createHost({
    id: 'sw-1core',
    name: 'Single-Core Switch',
    ip: '192.168.88.2',
    role: 'switch',
  });
  await hostManager.createHost({
    id: 'gw-4core',
    name: 'Quad-Core Gateway',
    ip: '192.168.88.1',
    role: 'gateway',
  });

  const baseTimeMs = Date.now();
  parsedSingle.sample.timestamp = baseTimeMs;
  parsedQuad.sample.timestamp = baseTimeMs;

  const dbHosts = await db.getHosts();
  const swHost = dbHosts.find((h) => h.id === 'sw-1core');
  const gwHost = dbHosts.find((h) => h.id === 'gw-4core');
  hostManager.applyTelemetryToHost(swHost, parsedSingle);
  hostManager.applyTelemetryToHost(gwHost, parsedQuad);
  await db.saveHosts(dbHosts);

  assert.equal(swHost.cpuCores, 1);
  assert.equal(swHost.pollIntervalMs, 60000, 'Single-core host should report 60s effective poll interval');
  assert.equal(gwHost.cpuCores, 4);
  assert.equal(
    gwHost.pollIntervalMs,
    hostManager.pollIntervalMs,
    'Multi-core host should report standard pollIntervalMs'
  );

  // 10 seconds later (standard poll tick):
  // - Quad-core gateway SHOULD be polled
  // - Single-core switch MUST be skipped (throttled until 60s have elapsed)
  assert.equal(
    hostManager.shouldPollHost(gwHost, { forceFull: false, nowMs: baseTimeMs + 10000 }),
    true,
    'Multi-core host must be polled on 10s tick'
  );
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: false, nowMs: baseTimeMs + 10000 }),
    false,
    'Single-core switch must be skipped on 10s tick (within 60s window)'
  );
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: false, nowMs: baseTimeMs + 50000 }),
    false,
    'Single-core switch must still be skipped at 50s'
  );
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: false, nowMs: baseTimeMs + 60000 }),
    true,
    'Single-core switch must be polled once 60s singleCorePollIntervalMs has elapsed'
  );
  // Forced full refresh (Refresh button) must ALWAYS poll the single-core switch immediately
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: true, nowMs: baseTimeMs + 5000 }),
    true,
    'Forced full refresh must bypass single-core throttle and poll immediately'
  );

  // 4. Verify PUT /api/settings can customize singleCorePollIntervalMs
  const putSettingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pollIntervalMs: 10000, singleCorePollIntervalMs: 120000 }),
  });
  assert.equal(putSettingsRes.status, 200);
  const updatedSettings = await putSettingsRes.json();
  assert.equal(updatedSettings.singleCorePollIntervalMs, 120000);
  assert.equal(hostManager.getSingleCorePollIntervalMs(), 120000);
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: false, nowMs: baseTimeMs + 90000 }),
    false,
    'With 120s single-core interval, single-core switch should be skipped at 90s'
  );
  assert.equal(
    hostManager.shouldPollHost(swHost, { forceFull: false, nowMs: baseTimeMs + 120000 }),
    true,
    'With 120s single-core interval, single-core switch should be polled at 120s'
  );

  // Reset singleCorePollIntervalMs back to default 60000
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pollIntervalMs: 10000, singleCorePollIntervalMs: 60000 }),
  });
  await hostManager.deleteHost('sw-1core', true);
  await hostManager.deleteHost('gw-4core', true);
});
