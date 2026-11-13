import { config } from '../config.js';
import { db } from '../storage/db.js';
import { simulator } from './simulator.js';
import { testHostConnection } from './realUbus.js';
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
  }

  async init(demoMode = true) {
    let hosts = (await db.getHosts()) || [];
    const settings = await db.getSettings();
    const hasRealHosts = hosts.some((h) => !h.isSimulated);

    if (hasRealHosts) {
      hosts = await this.removeDemoData(hosts);
      await db.saveHosts(hosts);
      return;
    }

    if (settings && settings.demoMode === false) {
      config.demoMode = false;
      return;
    }

    if (hosts.length === 0 && demoMode && config.demoMode) {
      // Seed initial simulated hosts
      hosts = simulator.getHosts();
      await db.saveHosts(hosts);
    }
  }

  /**
   * Purges all simulated demo hosts, demo backups, demo client aliases, and demo history.
   */
  async removeDemoData(currentHosts = null) {
    const hosts = currentHosts || (await db.getHosts()) || [];
    const simHostIds = hosts.filter((h) => h.isSimulated).map((h) => h.id);
    const realHosts = hosts.filter((h) => !h.isSimulated);

    // Disable demo mode in runtime config and persisted settings
    config.demoMode = false;
    const settings = (await db.getSettings()) || {};
    if (settings.demoMode !== false) {
      await db.saveSettings({ ...settings, demoMode: false });
    }

    // Remove demo backups for simulated hosts
    await backupEngine.removeDemoBackups(simHostIds);

    // Clear demo telemetry history
    await db.saveHistory([]);

    // Remove demo client aliases
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
    // Don't keep event loop alive if everything else exits
    this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollAllHosts() {
    // Tick simulator for realistic fluctuations
    simulator.tick();

    const hosts = await db.getHosts();
    if (!hosts) return;

    let updated = false;
    for (const h of hosts) {
      if (h.isSimulated) {
        const simHost = simulator.getHost(h.id);
        if (simHost) {
          h.status = simHost.status;
          h.uptimeSec = simHost.uptimeSec;
          h.cpuUsagePct = simHost.cpuUsagePct;
          h.memUsagePct = simHost.memUsagePct;
          h.clientCount = simHost.clientCount;
          h.lastSeen = simHost.lastSeen;
          updated = true;
        }
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
  }

  async getAllHosts({ sanitized = true } = {}) {
    let hosts = await db.getHosts();
    if (Array.isArray(hosts) && hosts.some((h) => !h.isSimulated) && hosts.some((h) => h.isSimulated)) {
      hosts = await this.removeDemoData(hosts);
      await db.saveHosts(hosts);
    }
    const list = (!hosts || hosts.length === 0) ? (config.demoMode ? simulator.getHosts() : []) : hosts;
    if (sanitized) {
      return list.map(sanitizeHost);
    }
    return list;
  }

  async getHost(id, { sanitized = true } = {}) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const host = hosts.find((h) => h.id === id) || null;
    if (!host) return null;
    return sanitized ? sanitizeHost(host) : host;
  }

  async createHost(data) {
    let hosts = await this.getAllHosts({ sanitized: false });
    const isSimulated = Boolean(data.isSimulated);

    // When adding a real host, purge all demo data and simulated hosts
    if (!isSimulated) {
      hosts = await this.removeDemoData(hosts);
    }

    const id = data.id || `node-${(data.role || 'ap')}-${Date.now().toString(36)}`;
    const newHost = {
      id,
      name: data.name || 'New OpenWrt Host',
      hostname: data.hostname || data.name || 'OpenWrt',
      model: data.model || 'OpenWrt Router/AP',
      ip: data.ip,
      role: data.role || 'ap',
      protocol: data.protocol || 'ubus_http',
      port: data.port || (data.useHttps ? 443 : 80),
      useHttps: Boolean(data.useHttps),
      username: data.username || 'root',
      password: data.password || '',
      sshPort: data.sshPort || 22,
      isSimulated,
      status: 'online',
      firmware: data.firmware || 'OpenWrt 23.05.4',
      uptimeSec: 3600,
      cpuUsagePct: 10.0,
      memUsagePct: 30.0,
      clientCount: 0,
      lastSeen: new Date().toISOString(),
    };

    hosts.push(newHost);
    await db.saveHosts(hosts);
    return sanitizeHost(newHost);
  }

  async updateHost(id, updateData) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) return null;

    const updated = {
      ...hosts[idx],
      ...updateData,
      id, // Preserve ID
    };
    hosts[idx] = updated;
    await db.saveHosts(hosts);
    return sanitizeHost(updated);
  }

  async deleteHost(id, deleteBackups = false) {
    let hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) return false;

    hosts.splice(idx, 1);
    await db.saveHosts(hosts);

    if (deleteBackups) {
      const backups = await backupEngine.listBackups(id);
      for (const b of backups) {
        await backupEngine.deleteBackup(b.id);
      }
    }
    return true;
  }

  async testHost(hostData) {
    // If testing an existing host by ID without credentials passed, retrieve stored credentials
    let configToTest = hostData;
    if (hostData.id && !hostData.password) {
      const stored = await this.getHost(hostData.id, { sanitized: false });
      if (stored) {
        configToTest = { ...stored, ...hostData };
      }
    }
    return testHostConnection(configToTest, simulator);
  }
}

export const hostManager = new HostManager();
