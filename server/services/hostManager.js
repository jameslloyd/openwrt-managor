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
    let hosts = await db.getHosts();
    if ((!hosts || hosts.length === 0) && demoMode) {
      // Seed initial simulated hosts
      hosts = simulator.getHosts();
      await db.saveHosts(hosts);
    }
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
    const hosts = await db.getHosts();
    const list = (!hosts || hosts.length === 0) ? simulator.getHosts() : hosts;
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
    const hosts = await this.getAllHosts({ sanitized: false });
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
      isSimulated: Boolean(data.isSimulated),
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
