import { config } from '../config.js';
import { db } from '../storage/db.js';
import { simulator } from './simulator.js';
import { testHostConnection, pollRealHost } from './realUbus.js';
import { backupEngine } from './backupEngine.js';

export function sanitizeHost(host) {
  if (!host) return null;
  const { password, sshPrivateKey, ...safe } = host;
  return {
    ...safe,
    hasPassword: Boolean(password),
  };
}

export class HostManager {
  constructor() {
    this.pollTimer = null;
    this.isPolling = false;
    this.prevSamples = new Map(); // hostId -> { timestamp, cpuStat, netCounters, clientBytes }
    this.liveClientsByHost = new Map(); // hostId -> array of client objects
    this.liveRadiosByHost = new Map(); // hostId -> array of radio objects
    this.signalHistoryByMac = new Map(); // mac -> array of { timestamp, signalDbm }
  }

  async init() {
    let hosts = (await db.getHosts()) || [];
    if (hosts.some((h) => h.isSimulated)) {
      hosts = await this.removeDemoData(hosts);
      await db.saveHosts(hosts);
    }
    config.demoMode = false;
    const settings = await db.getSettings();
    if (settings && settings.demoMode !== false) {
      await db.saveSettings({ ...settings, demoMode: false });
    }

    // Trigger an initial background poll for any configured hosts
    if (hosts.length > 0) {
      this.pollAllHosts().catch(() => {});
    }
  }

  /**
   * Purges all simulated demo hosts, demo backups, demo client aliases, and demo history.
   */
  async removeDemoData(currentHosts = null) {
    const hosts = currentHosts || (await db.getHosts()) || [];
    const simHostIds = hosts.filter((h) => h.isSimulated).map((h) => h.id);
    const realHosts = hosts.filter((h) => !h.isSimulated);

    config.demoMode = false;
    const settings = (await db.getSettings()) || {};
    if (settings.demoMode !== false) {
      await db.saveSettings({ ...settings, demoMode: false });
    }

    await backupEngine.removeDemoBackups(simHostIds);
    await db.saveHistory([]);

    const aliases = (await db.getClientAliases()) || {};
    const demoMacs = new Set(simulator.getClients().map((c) => c.mac.toLowerCase()));
    let aliasesChanged = false;
    const cleanedAliases = { ...aliases };
    for (const mac of Object.keys(cleanedAliases)) {
      if (demoMacs.has(mac.toLowerCase())) {
        delete cleanedAliases[mac];
        aliasesChanged = true;
      }
    }
    if (aliasesChanged) {
      await db.saveClientAliases(cleanedAliases);
    }

    return realHosts;
  }

  startPolling(intervalMs = 10000) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollAllHosts(), intervalMs);
    this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  applyTelemetryToHost(host, telemetry) {
    if (!telemetry || !telemetry.online) {
      return false;
    }
    host.status = 'online';
    if (telemetry.hostname) host.hostname = telemetry.hostname;
    if (telemetry.model) host.model = telemetry.model;
    if (telemetry.firmware) host.firmware = telemetry.firmware;
    if (typeof telemetry.uptimeSec === 'number') host.uptimeSec = telemetry.uptimeSec;
    if (typeof telemetry.cpuUsagePct === 'number') host.cpuUsagePct = telemetry.cpuUsagePct;
    if (typeof telemetry.memUsagePct === 'number') host.memUsagePct = telemetry.memUsagePct;
    if (telemetry.mac) host.mac = telemetry.mac;
    host.rxRateBps = telemetry.rxRateBps || 0;
    host.txRateBps = telemetry.txRateBps || 0;
    if (telemetry.wan) host.wan = telemetry.wan;
    if (Array.isArray(telemetry.radios)) {
      host.radios = telemetry.radios;
      this.liveRadiosByHost.set(host.id, telemetry.radios);
    }
    if (Array.isArray(telemetry.clients)) {
      host.clientCount = telemetry.clients.length;
      this.liveClientsByHost.set(host.id, telemetry.clients);

      const nowIso = new Date().toISOString();
      for (const c of telemetry.clients) {
        if (typeof c.signalDbm === 'number') {
          const hist = this.signalHistoryByMac.get(c.mac) || [];
          hist.push({ timestamp: nowIso, signalDbm: c.signalDbm });
          if (hist.length > 30) hist.shift();
          this.signalHistoryByMac.set(c.mac, hist);
        }
      }
    }
    if (telemetry.sample) {
      this.prevSamples.set(host.id, telemetry.sample);
    }
    host.lastSeen = new Date().toISOString();
    return true;
  }

  async pollSingleHost(hostId) {
    const hosts = (await db.getHosts()) || [];
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const host = hosts[idx];
    const telemetry = await pollRealHost(host, this.prevSamples.get(host.id));
    if (telemetry.online) {
      this.applyTelemetryToHost(host, telemetry);
      hosts[idx] = host;
      await db.saveHosts(hosts);
    }
    return sanitizeHost(host);
  }

  async pollAllHosts() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const hosts = await db.getHosts();
      if (!hosts || hosts.length === 0) return;

      const results = await Promise.all(
        hosts.map(async (h) => {
          const telemetry = await pollRealHost(h, this.prevSamples.get(h.id));
          return { host: h, telemetry };
        })
      );

      let updated = false;
      for (const { host, telemetry } of results) {
        if (telemetry.online) {
          this.applyTelemetryToHost(host, telemetry);
          updated = true;
        } else {
          host.status = 'offline';
          host.rxRateBps = 0;
          host.txRateBps = 0;
          updated = true;
        }
      }

      if (updated) {
        await db.saveHosts(hosts);
      }

      // Record history snapshot (keep last 120 points)
      const history = (await db.getHistory()) || [];
      const now = new Date().toISOString();
      const totalClients = hosts.reduce((acc, h) => acc + (h.clientCount || 0), 0);
      const avgCpu = Math.round(hosts.reduce((acc, h) => acc + (h.cpuUsagePct || 0), 0) / (hosts.length || 1));

      history.push({
        timestamp: now,
        onlineHosts: hosts.filter((h) => h.status === 'online').length,
        totalClients,
        avgCpu,
      });

      if (history.length > 120) {
        history.shift();
      }
      await db.saveHistory(history);
    } finally {
      this.isPolling = false;
    }
  }

  getLiveClients() {
    // Deduplicate clients across APs and gateways (prefer WiFi station entry over wired DHCP lease entry)
    const byMac = new Map();
    for (const clients of this.liveClientsByHost.values()) {
      for (const c of clients) {
        const existing = byMac.get(c.mac);
        if (!existing || (existing.connectionType === 'wired' && c.connectionType !== 'wired')) {
          byMac.set(c.mac, {
            ...c,
            signalHistory: this.signalHistoryByMac.get(c.mac) || [],
            roamingLog: [],
          });
        }
      }
    }
    return Array.from(byMac.values());
  }

  getLiveWifiBands() {
    const bands = {
      '2.4GHz': { rangeMhz: [2400, 2484], noiseFloorDbm: -95, radios: [] },
      '5GHz': { rangeMhz: [5150, 5875], noiseFloorDbm: -98, radios: [] },
      '6GHz': { rangeMhz: [5925, 7125], noiseFloorDbm: -101, radios: [] },
    };

    for (const radios of this.liveRadiosByHost.values()) {
      for (const r of radios) {
        if (bands[r.band]) {
          bands[r.band].radios.push(r);
        }
      }
    }
    return bands;
  }

  async getAllHosts({ sanitized = true } = {}) {
    let hosts = (await db.getHosts()) || [];
    if (hosts.some((h) => h.isSimulated)) {
      hosts = await this.removeDemoData(hosts);
      await db.saveHosts(hosts);
    }
    if (sanitized) {
      return hosts.map(sanitizeHost);
    }
    return hosts;
  }

  async getHost(id, { sanitized = true } = {}) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const host = hosts.find((h) => h.id === id) || null;
    if (!host) return null;
    return sanitized ? sanitizeHost(host) : host;
  }

  async createHost(data) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const id = data.id || `node-${(data.role || 'ap')}-${Date.now().toString(36)}`;
    const protocol = data.protocol || 'ssh';
    const defaultPort = protocol === 'ssh' ? 22 : data.useHttps || protocol === 'ubus_https' ? 443 : 80;

    const newHost = {
      id,
      name: data.name || 'New OpenWrt Host',
      hostname: data.hostname || data.name || 'OpenWrt',
      model: data.model || 'OpenWrt Router/AP',
      ip: data.ip,
      role: data.role || 'ap',
      protocol,
      port: data.port || defaultPort,
      useHttps: Boolean(data.useHttps || protocol === 'ubus_https'),
      username: data.username || 'root',
      password: data.password || '',
      sshPort: data.sshPort || (protocol === 'ssh' && data.port ? data.port : 22),
      isSimulated: false,
      status: 'online',
      firmware: data.firmware || 'OpenWrt',
      uptimeSec: 0,
      cpuUsagePct: 0,
      memUsagePct: 0,
      rxRateBps: 0,
      txRateBps: 0,
      clientCount: 0,
      radios: [],
      lastSeen: new Date().toISOString(),
    };

    // If credentials or SSH/ubus details are provided, try a quick live poll right away
    if (data.password || data.pollNow) {
      const telemetry = await pollRealHost(newHost);
      if (telemetry.online) {
        this.applyTelemetryToHost(newHost, telemetry);
      }
    } else {
      // Non-blocking background poll so unit tests with unreachable IPs don't block
      setTimeout(() => {
        this.pollSingleHost(id).catch(() => {});
      }, 10);
    }

    hosts.push(newHost);
    await db.saveHosts(hosts);
    return sanitizeHost(newHost);
  }

  async updateHost(id, updateData) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) return null;

    const existing = hosts[idx];
    const updated = {
      ...existing,
      ...updateData,
      // Preserve stored password if edit form submitted an empty password field
      password:
        updateData.password !== undefined && updateData.password !== ''
          ? updateData.password
          : existing.password,
      id,
    };

    if (updateData.password || updateData.ip || updateData.protocol || updateData.username) {
      const telemetry = await pollRealHost(updated, this.prevSamples.get(id));
      if (telemetry.online) {
        this.applyTelemetryToHost(updated, telemetry);
      }
    }

    hosts[idx] = updated;
    await db.saveHosts(hosts);
    return sanitizeHost(updated);
  }

  async deleteHost(id, deleteBackups = false) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) return false;

    hosts.splice(idx, 1);
    this.prevSamples.delete(id);
    this.liveClientsByHost.delete(id);
    this.liveRadiosByHost.delete(id);
    await db.saveHosts(hosts);

    if (deleteBackups) {
      await backupEngine.removeDemoBackups([id]);
    }
    return true;
  }

  async testHost(hostData) {
    let configToTest = hostData;
    if (hostData.id && !hostData.password) {
      const stored = await this.getHost(hostData.id, { sanitized: false });
      if (stored) {
        configToTest = { ...stored, ...hostData, password: hostData.password || stored.password };
      }
    }
    return testHostConnection(configToTest, simulator);
  }
}

export const hostManager = new HostManager();
