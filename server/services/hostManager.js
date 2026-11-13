import { config } from '../config.js';
import { db } from '../storage/db.js';
import { simulator } from './simulator.js';
import { testHostConnection, pollRealHost, scanHostWirelessNetworks } from './realUbus.js';
import { backupEngine } from './backupEngine.js';
import { triangulateBandNeighbors } from './wifiEngine.js';

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
    this.liveNeighborsByHost = new Map(); // hostId -> array of scanned neighbor BSS objects
    this.signalHistoryByMac = new Map(); // mac -> array of { timestamp, signalDbm }
    this.dhcpByHost = new Map(); // hostId -> { [mac]: { ip, hostname, expiresEpoch } }
    this.arpByHost = new Map(); // hostId -> { [mac]: ip }
    this.rdnsByHost = new Map(); // hostId -> { [ip]: hostname }
    this.hostsCacheById = new Map(); // hostId -> host metadata (name, role, mapPosition)
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
    if (Array.isArray(telemetry.neighbors) && telemetry.neighbors.length > 0) {
      this.liveNeighborsByHost.set(host.id, telemetry.neighbors);
    } else if (!this.liveNeighborsByHost.has(host.id) && Array.isArray(telemetry.neighbors)) {
      this.liveNeighborsByHost.set(host.id, telemetry.neighbors);
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
    if (telemetry.dhcpMap) {
      this.dhcpByHost.set(host.id, telemetry.dhcpMap);
    }
    if (telemetry.arpMap) {
      this.arpByHost.set(host.id, telemetry.arpMap);
    }
    if (telemetry.rdnsMap) {
      this.rdnsByHost.set(host.id, telemetry.rdnsMap);
    }
    if (telemetry.sample) {
      this.prevSamples.set(host.id, telemetry.sample);
    }
    this.hostsCacheById.set(host.id, {
      id: host.id,
      name: host.name || host.hostname || host.id,
      hostname: host.hostname || host.name || host.id,
      role: host.role || 'ap',
      mapPosition: host.mapPosition || null,
    });
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
    // Build a fleet-wide merged DHCP / ARP / reverse-DNS lookup across all gateways and APs
    const globalDhcp = {};
    for (const dhcpMap of this.dhcpByHost.values()) {
      for (const [mac, info] of Object.entries(dhcpMap)) {
        const existing = globalDhcp[mac];
        if (!existing || (!existing.ip && info.ip) || (existing.hostname === '*' && info.hostname && info.hostname !== '*')) {
          globalDhcp[mac] = { ...existing, ...info };
        }
      }
    }

    const globalArp = {};
    for (const arpMap of this.arpByHost.values()) {
      for (const [mac, entry] of Object.entries(arpMap)) {
        const ip = typeof entry === 'string' ? entry : entry?.ip;
        if (ip && ip !== '0.0.0.0' && !globalArp[mac]) {
          globalArp[mac] = ip;
        }
      }
    }

    const globalRdns = {};
    for (const rdnsMap of this.rdnsByHost.values()) {
      for (const [mac, entry] of Object.entries(rdnsMap)) {
        if (entry && typeof entry === 'object' && !globalRdns[mac]) {
          globalRdns[mac] = entry;
        }
      }
    }

    // Deduplicate clients across APs and gateways (prefer WiFi station entry over wired DHCP lease entry)
    const byMac = new Map();

    for (const clients of this.liveClientsByHost.values()) {
      for (const c of clients) {
        const macLower = (c.mac || '').toLowerCase();
        const existing = byMac.get(macLower);

        // Preserve any known IP/hostname from a wired DHCP entry if a wireless AP entry lacks it
        const dhcp = globalDhcp[macLower] || {};
        const arpIp = globalArp[macLower];
        const rdns = globalRdns[macLower] || {};
        const resolvedIp =
          c.ip && c.ip !== '0.0.0.0'
            ? c.ip
            : dhcp.ip || arpIp || rdns.ip || (existing && existing.ip !== '0.0.0.0' ? existing.ip : '0.0.0.0');
        let resolvedHostname = c.hostname;
        const isGenericHostname =
          !resolvedHostname ||
          resolvedHostname === '*' ||
          resolvedHostname.toLowerCase() === macLower ||
          resolvedHostname === c.ip ||
          resolvedHostname === '0.0.0.0';
        if (isGenericHostname) {
          resolvedHostname =
            (dhcp.hostname && dhcp.hostname !== '*' && dhcp.hostname !== dhcp.ip ? dhcp.hostname : null) ||
            rdns.hostname ||
            (dhcp.hostname && dhcp.hostname !== '*' ? dhcp.hostname : null) ||
            (existing && existing.hostname && existing.hostname !== existing.mac.toLowerCase() ? existing.hostname : null) ||
            (resolvedIp && resolvedIp !== '0.0.0.0' ? resolvedIp : null) ||
            resolvedHostname ||
            macLower;
        }
        const resolvedLeaseRemaining =
          c.dhcpLeaseRemainingSec ||
          dhcp.dhcpLeaseRemainingSec ||
          (existing ? existing.dhcpLeaseRemainingSec || 0 : 0);

        if (!existing || (existing.connectionType === 'wired' && c.connectionType !== 'wired')) {
          byMac.set(macLower, {
            ...c,
            ip: resolvedIp,
            hostname: resolvedHostname,
            dhcpLeaseRemainingSec: resolvedLeaseRemaining,
            signalHistory: this.signalHistoryByMac.get(c.mac) || this.signalHistoryByMac.get(macLower) || [],
            roamingLog: [],
          });
        } else if (existing.connectionType !== 'wired' && c.connectionType === 'wired') {
          // Enrich existing wireless client with wired/DHCP server IP & hostname if missing
          if ((!existing.ip || existing.ip === '0.0.0.0') && resolvedIp !== '0.0.0.0') {
            existing.ip = resolvedIp;
          }
          if (
            (!existing.hostname || existing.hostname.toLowerCase() === macLower || existing.hostname === '0.0.0.0') &&
            resolvedHostname &&
            resolvedHostname.toLowerCase() !== macLower
          ) {
            existing.hostname = resolvedHostname;
          }
          if (!existing.dhcpLeaseRemainingSec && resolvedLeaseRemaining) {
            existing.dhcpLeaseRemainingSec = resolvedLeaseRemaining;
          }
        }
      }
    }
    return Array.from(byMac.values());
  }

  getLiveWifiBands() {
    const bands = {
      '2.4GHz': { rangeMhz: [2400, 2484], noiseFloorDbm: -95, radios: [], neighbors: [] },
      '5GHz': { rangeMhz: [5150, 5875], noiseFloorDbm: -98, radios: [], neighbors: [] },
      '6GHz': { rangeMhz: [5925, 7125], noiseFloorDbm: -101, radios: [], neighbors: [] },
    };

    const managedSsidsByBandChan = new Set();
    for (const radios of this.liveRadiosByHost.values()) {
      for (const r of radios) {
        if (bands[r.band]) {
          bands[r.band].radios.push(r);
          managedSsidsByBandChan.add(`${r.band}:${r.channel}:${(r.ssid || '').toLowerCase()}`);
          if (typeof r.noiseDbm === 'number' && r.noiseDbm > bands[r.band].noiseFloorDbm) {
            bands[r.band].noiseFloorDbm = r.noiseDbm;
          }
        }
      }
    }

    // Aggregate scanned neighboring networks across all radios and record relative signal strength per radio
    const neighborsByBandBssid = {
      '2.4GHz': new Map(),
      '5GHz': new Map(),
      '6GHz': new Map(),
    };

    for (const hostNeighbors of this.liveNeighborsByHost.values()) {
      for (const n of hostNeighbors) {
        if (!bands[n.band]) continue;
        const map = neighborsByBandBssid[n.band];
        const bssidKey = n.bssid.toLowerCase();
        if (!map.has(bssidKey)) {
          map.set(bssidKey, {
            bssid: bssidKey,
            ssid: n.ssid || '(Hidden Network)',
            isHidden: Boolean(n.isHidden),
            isManagedFleet: managedSsidsByBandChan.has(`${n.band}:${n.channel}:${(n.ssid || '').toLowerCase()}`),
            band: n.band,
            channel: n.channel,
            centerFreqMhz: n.centerFreqMhz || n.freqMhz,
            widthMhz: n.widthMhz || 20,
            security: n.security || 'Open',
            strongestSignalDbm: n.signalDbm,
            strongestHostId: n.seenByHostId,
            strongestHostName: n.seenByHostName,
            strongestDevice: n.seenByDevice,
            observations: [],
          });
        }

        const entry = map.get(bssidKey);
        if (entry.isHidden && n.ssid && !n.isHidden) {
          entry.ssid = n.ssid;
          entry.isHidden = false;
        }
        if ((n.widthMhz || 20) > entry.widthMhz) {
          entry.widthMhz = n.widthMhz;
        }
        if (n.signalDbm > entry.strongestSignalDbm) {
          entry.strongestSignalDbm = n.signalDbm;
          entry.strongestHostId = n.seenByHostId;
          entry.strongestHostName = n.seenByHostName;
          entry.strongestDevice = n.seenByDevice;
        }

        const existingObs = entry.observations.find(
          (o) => o.hostId === n.seenByHostId && o.device === n.seenByDevice
        );
        if (!existingObs) {
          entry.observations.push({
            hostId: n.seenByHostId,
            hostName: n.seenByHostName,
            radioId: n.seenByRadioId,
            device: n.seenByDevice,
            signalDbm: n.signalDbm,
            lastSeenMs: n.lastSeenMs || 0,
          });
        } else if (n.signalDbm > existingObs.signalDbm) {
          existingObs.signalDbm = n.signalDbm;
        }
      }
    }

    for (const bandName of Object.keys(bands)) {
      const list = Array.from(neighborsByBandBssid[bandName].values()).sort(
        (a, b) => b.strongestSignalDbm - a.strongestSignalDbm
      );
      for (const item of list) {
        item.observations.sort((a, b) => b.signalDbm - a.signalDbm);
      }
      bands[bandName].neighbors = list;
    }

    // Collect active hosts for RF triangulation anchor coordinates
    const activeHostIds = new Set();
    for (const [id, radios] of this.liveRadiosByHost.entries()) {
      if (Array.isArray(radios) && radios.length > 0) activeHostIds.add(id);
    }
    for (const [id, neighbors] of this.liveNeighborsByHost.entries()) {
      if (Array.isArray(neighbors) && neighbors.length > 0) activeHostIds.add(id);
    }
    for (const [id, h] of this.hostsCacheById.entries()) {
      if (h.persisted) activeHostIds.add(id);
    }

    const activeHosts = [];
    for (const hostId of activeHostIds) {
      const cached = this.hostsCacheById.get(hostId);
      if (cached) {
        activeHosts.push(cached);
      } else {
        const radios = this.liveRadiosByHost.get(hostId) || [];
        const neighbors = this.liveNeighborsByHost.get(hostId) || [];
        const hostName =
          radios[0]?.hostName ||
          neighbors[0]?.seenByHostName ||
          hostId;
        activeHosts.push({ id: hostId, name: hostName, role: 'ap', mapPosition: null });
      }
    }

    triangulateBandNeighbors(bands, activeHosts);

    return bands;
  }

  async scanAllWifiNetworks(targetHostId = 'all') {
    const hosts = await this.getAllHosts({ sanitized: false });
    const onlineHosts = hosts.filter(
      (h) => !h.isSimulated && (targetHostId === 'all' || h.id === targetHostId)
    );

    await Promise.all(
      onlineHosts.map(async (h) => {
        try {
          const scanned = await scanHostWirelessNetworks(h);
          if (Array.isArray(scanned)) {
            this.liveNeighborsByHost.set(h.id, scanned);
          }
        } catch {
          // Ignore individual host scan errors if busy or unreachable
        }
      })
    );

    return this.getLiveWifiBands();
  }

  async getAllHosts({ sanitized = true } = {}) {
    let hosts = (await db.getHosts()) || [];
    if (hosts.some((h) => h.isSimulated)) {
      hosts = await this.removeDemoData(hosts);
      await db.saveHosts(hosts);
    }
    const persistedIds = new Set(hosts.map((h) => h.id));
    for (const [id, entry] of this.hostsCacheById.entries()) {
      if (entry.persisted && !persistedIds.has(id)) {
        this.hostsCacheById.delete(id);
      }
    }
    for (const h of hosts) {
      this.hostsCacheById.set(h.id, {
        id: h.id,
        name: h.name || h.hostname || h.id,
        hostname: h.hostname || h.name || h.id,
        role: h.role || 'ap',
        mapPosition: h.mapPosition || null,
        persisted: true,
      });
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
    this.hostsCacheById.set(newHost.id, {
      id: newHost.id,
      name: newHost.name || newHost.hostname || newHost.id,
      hostname: newHost.hostname || newHost.name || newHost.id,
      role: newHost.role || 'ap',
      mapPosition: newHost.mapPosition || null,
      persisted: true,
    });
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
    this.hostsCacheById.set(updated.id, {
      id: updated.id,
      name: updated.name || updated.hostname || updated.id,
      hostname: updated.hostname || updated.name || updated.id,
      role: updated.role || 'ap',
      mapPosition: updated.mapPosition || null,
      persisted: true,
    });
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
    this.liveNeighborsByHost.delete(id);
    this.dhcpByHost.delete(id);
    this.arpByHost.delete(id);
    this.rdnsByHost.delete(id);
    this.hostsCacheById.delete(id);
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
