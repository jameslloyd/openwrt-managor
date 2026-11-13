import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkSimulator } from '../server/services/simulator.js';
import { analyzeInterference } from '../server/services/wifiEngine.js';
import { extractTarGz } from '../server/services/tarUci.js';

test('Simulator: initializes 4 hosts and 22 clients', () => {
  const sim = new NetworkSimulator();
  const hosts = sim.getHosts();
  assert.equal(hosts.length, 4);

  const clients = sim.getClients();
  assert.equal(clients.length, 22);

  // Filters
  const wired = sim.getClients({ type: 'wired' });
  assert.equal(wired.length, 5);

  const wifi5g = sim.getClients({ type: 'wifi_5g' });
  assert.equal(wifi5g.length, 8);

  const wifi6g = sim.getClients({ type: 'wifi_6g' });
  assert.equal(wifi6g.length, 3);

  const wifi2g = sim.getClients({ type: 'wifi_2g' });
  assert.equal(wifi2g.length, 6);

  const vlan20 = sim.getClients({ vlan: 20 });
  assert.equal(vlan20.length, 7); // Hue bridge (wired) + 6 smart home devices
});

test('Simulator: WiFi spectrum covers 2.4GHz, 5GHz, and 6GHz bands with interference warnings', () => {
  const sim = new NetworkSimulator();
  const bands = sim.getWifiBands();

  assert.ok(bands['2.4GHz']);
  assert.ok(bands['5GHz']);
  assert.ok(bands['6GHz']);

  assert.ok(bands['2.4GHz'].radios.length >= 2);
  assert.ok(bands['5GHz'].radios.length >= 2);
  assert.ok(bands['6GHz'].radios.length >= 1);

  // Interference check
  const analysis = analyzeInterference(bands);
  assert.equal(analysis.summary.status, 'warning');
  assert.ok(analysis.warnings.length >= 2); // CCI on 2.4G (Ch 6) and 5G (Ch 36)
  assert.ok(analysis.warnings.some((w) => w.band === '2.4GHz' && w.channel === 6));
  assert.ok(analysis.warnings.some((w) => w.band === '5GHz' && w.channel === 36));
});

test('Simulator: mock archive generation produces valid OpenWrt tarball', () => {
  const sim = new NetworkSimulator();
  const res = sim.generateMockArchive('node-gw-01', 0);

  assert.ok(Buffer.isBuffer(res.archiveBuffer));
  assert.equal(typeof res.sha256, 'string');
  assert.equal(res.sha256.length, 64);

  const manifest = extractTarGz(res.archiveBuffer);
  assert.ok(manifest.length >= 5);
  assert.ok(manifest.some((f) => f.path === 'etc/config/network'));
  assert.ok(manifest.some((f) => f.path === 'etc/config/wireless'));
  assert.ok(manifest.some((f) => f.path === 'etc/config/firewall'));
});
