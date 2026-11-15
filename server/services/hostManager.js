import { config } from '../config.js';
import { db } from '../storage/db.js';
import { simulator } from './simulator.js';
import {
  testHostConnection,
  pollRealHost,
  scanHostWirelessNetworks,
  checkHostUpdates,
  upgradeHostPackages,
  performAttendedSysupgradeAction,
  evaluateAttendedSysupgrade,
  formatSwitchPortLabel,
} from './realUbus.js';
import { backupEngine } from './backupEngine.js';
import { triangulateBandNeighbors, extractHostGeolocation } from './wifiEngine.js';
import { lookupVendor, resolveWirelessNetworkManufacturer } from './ouiVendor.js';

export function sanitizeHost(host, activeUpgradeJob = null) {
  if (!host) return null;
  const { password, sshPrivateKey, mockStreamRunner, ...safe } = host;
  if (!safe.updates) {
    const asu = evaluateAttendedSysupgrade({ firmware: safe.firmware || 'OpenWrt' });
    safe.updates = {
      packagesCount: 0,
      packages: [],
      firmwareUpdateAvailable: asu.firmwareUpdateAvailable,
      availableFirmwareVersion: asu.availableVersion,
      attendedSysupgrade: asu,
      lastChecked: null,
    };
  } else if (
    safe.updates.attendedSysupgrade &&
    !safe.updates.attendedSysupgrade.installed &&
    !safe.updates.attendedSysupgrade.statusVerified
  ) {
    const refreshedAsu = evaluateAttendedSysupgrade({
      firmware: safe.firmware || safe.updates.attendedSysupgrade.currentVersion || 'OpenWrt',
    });
    safe.updates = {
      ...safe.updates,
      firmwareUpdateAvailable: refreshedAsu.firmwareUpdateAvailable,
      availableFirmwareVersion: refreshedAsu.availableVersion,
      attendedSysupgrade: {
        ...safe.updates.attendedSysupgrade,
        ...refreshedAsu,
      },
    };
  }
  return {
    ...safe,
    hasPassword: Boolean(password),
    activeUpgradeJob: activeUpgradeJob || safe.activeUpgradeJob || null,
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
    this.fdbByHost = new Map(); // hostId -> { [mac]: { iface, switchPort, portLabel, portNumber, speedMbps, portMacCount } }
    this.switchPortsByHost = new Map(); // hostId -> array of switchPort objects
    this.hostsCacheById = new Map(); // hostId -> host metadata (name, role, mapPosition)
    this.upgradeJobs = new Map(); // jobId -> upgradeJob object
    this.activeJobByHost = new Map(); // hostId -> jobId
    this.customStreamRunners = new Map(); // hostId -> mockStreamRunner (for unit tests)
    this.pollFailuresByHost = new Map(); // hostId -> consecutive failed poll count
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
    if (telemetry.vendor) host.vendor = telemetry.vendor;
    if (telemetry.firmware) host.firmware = telemetry.firmware;
    if (typeof telemetry.uptimeSec === 'number') host.uptimeSec = telemetry.uptimeSec;
    if (typeof telemetry.cpuUsagePct === 'number') host.cpuUsagePct = telemetry.cpuUsagePct;
    if (typeof telemetry.memUsagePct === 'number') host.memUsagePct = telemetry.memUsagePct;
    if (telemetry.mac) host.mac = telemetry.mac;
    if (Array.isArray(telemetry.allMacs) && telemetry.allMacs.length > 0) {
      host.allMacs = telemetry.allMacs;
    }
    if (Array.isArray(telemetry.hostInterfaces)) {
      host.hostInterfaces = telemetry.hostInterfaces;
    }
    if (telemetry.defaultRoute) {
      host.defaultRoute = telemetry.defaultRoute;
    }
    if (!host.vendor && (host.mac || host.model)) {
      host.vendor = lookupVendor(host.mac, host.model);
    }
    host.rxRateBps = telemetry.rxRateBps || 0;
    host.txRateBps = telemetry.txRateBps || 0;
    if (telemetry.wan) host.wan = telemetry.wan;
    if (Array.isArray(telemetry.radios)) {
      host.radios = telemetry.radios;
      this.liveRadiosByHost.set(host.id, telemetry.radios);
      if (telemetry.radios.length === 0) {
        this.liveNeighborsByHost.delete(host.id);
      }
    }
    if (!Array.isArray(telemetry.radios) || telemetry.radios.length > 0) {
      if (Array.isArray(telemetry.neighbors) && telemetry.neighbors.length > 0) {
        this.liveNeighborsByHost.set(host.id, telemetry.neighbors);
      } else if (!this.liveNeighborsByHost.has(host.id) && Array.isArray(telemetry.neighbors)) {
        this.liveNeighborsByHost.set(host.id, telemetry.neighbors);
      }
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
    if (telemetry.fdbMap) {
      this.fdbByHost.set(host.id, telemetry.fdbMap);
    }
    if (Array.isArray(telemetry.switchPorts)) {
      host.switchPorts = telemetry.switchPorts;
      this.switchPortsByHost.set(host.id, telemetry.switchPorts);
    }
    if (telemetry.updates) {
      host.updates = telemetry.updates;
    }
    if (telemetry.sample) {
      this.prevSamples.set(host.id, telemetry.sample);
    }
    const prevCache = this.hostsCacheById.get(host.id);
    const radios = Array.isArray(host.radios) ? host.radios : (this.liveRadiosByHost.get(host.id) || []);
    const geo = extractHostGeolocation(host.latitude !== undefined || host.altitude !== undefined || host.geoLocation ? host : prevCache || host);
    if (geo.hasGps) {
      host.latitude = geo.latitude;
      host.longitude = geo.longitude;
    }
    if (geo.hasAlt) {
      host.altitude = geo.altitude;
    }
    this.hostsCacheById.set(host.id, {
      id: host.id,
      name: host.name || host.hostname || host.id,
      hostname: host.hostname || host.name || host.id,
      ip: host.ip || prevCache?.ip || null,
      mac: host.mac ? String(host.mac).toLowerCase() : prevCache?.mac || null,
      allMacs: Array.isArray(host.allMacs) ? host.allMacs : prevCache?.allMacs || (host.mac ? [String(host.mac).toLowerCase()] : []),
      hostInterfaces: Array.isArray(host.hostInterfaces) ? host.hostInterfaces : prevCache?.hostInterfaces || [],
      defaultRoute: host.defaultRoute || prevCache?.defaultRoute || null,
      role: host.role || 'ap',
      mapPosition: host.mapPosition || prevCache?.mapPosition || null,
      latitude: geo.latitude,
      longitude: geo.longitude,
      altitude: geo.altitude,
      radios,
      switchPorts: Array.isArray(host.switchPorts) ? host.switchPorts : prevCache?.switchPorts || [],
      hasWirelessRadios: radios.length > 0,
      persisted: Boolean(prevCache?.persisted),
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
          this.pollFailuresByHost.set(host.id, 0);
          this.applyTelemetryToHost(host, telemetry);
          updated = true;
        } else {
          const failures = (this.pollFailuresByHost.get(host.id) || 0) + 1;
          this.pollFailuresByHost.set(host.id, failures);
          // Require at least 2 consecutive failed polls before flipping an already-online host to offline
          if (host.status !== 'online' || failures >= 2) {
            host.status = 'offline';
            host.rxRateBps = 0;
            host.txRateBps = 0;
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
    } finally {
      this.isPolling = false;
    }
  }

  getManagedHostMacMap(hostsList = null) {
    const macToHostId = new Map();
    const macsByHostId = new Map();
    const ipToMacFromArp = new Map();

    for (const arpMap of this.arpByHost.values()) {
      if (!arpMap || typeof arpMap !== 'object') continue;
      for (const [mac, entry] of Object.entries(arpMap)) {
        const ip = typeof entry === 'string' ? entry : entry?.ip;
        if (ip && ip !== '0.0.0.0' && mac) {
          ipToMacFromArp.set(ip, mac.toLowerCase());
        }
      }
    }
    for (const dhcpMap of this.dhcpByHost.values()) {
      if (!dhcpMap || typeof dhcpMap !== 'object') continue;
      for (const [mac, entry] of Object.entries(dhcpMap)) {
        if (entry?.ip && entry.ip !== '0.0.0.0' && mac && !ipToMacFromArp.has(entry.ip)) {
          ipToMacFromArp.set(entry.ip, mac.toLowerCase());
        }
      }
    }

    const iterableHosts = Array.isArray(hostsList) && hostsList.length > 0
      ? hostsList
      : Array.from(this.hostsCacheById.values());

    for (const h of iterableHosts) {
      if (!h || !h.id) continue;
      const set = new Set();
      const addMac = (m) => {
        if (!m) return;
        const clean = String(m).trim().toLowerCase();
        if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(clean) && clean !== '00:00:00:00:00:00') {
          set.add(clean);
          macToHostId.set(clean, h.id);
        }
      };

      addMac(h.mac);
      const cached = this.hostsCacheById.get(h.id);
      if (cached?.mac) addMac(cached.mac);
      for (const m of h.allMacs || cached?.allMacs || []) addMac(m);
      for (const p of h.switchPorts || this.switchPortsByHost.get(h.id) || []) addMac(p?.mac);
      for (const r of h.radios || this.liveRadiosByHost.get(h.id) || []) addMac(r?.bssid);
      if (h.ip && ipToMacFromArp.has(h.ip)) {
        addMac(ipToMacFromArp.get(h.ip));
      }
      if (!h.mac && set.size > 0) {
        h.mac = Array.from(set)[0];
      }
      macsByHostId.set(h.id, set);
    }

    return { macToHostId, macsByHostId };
  }

  resolveBestSwitchPortForMac(macLower) {
    if (!macLower) return null;
    const { macToHostId } = this.getManagedHostMacMap();
    const targetOwnerHostId = macToHostId.get(macLower) || null;

    const candidates = [];
    for (const [hostId, fdbMap] of this.fdbByHost.entries()) {
      if (targetOwnerHostId && hostId === targetOwnerHostId) continue;
      if (!fdbMap || typeof fdbMap !== 'object') continue;
      const entry = fdbMap[macLower];
      if (!entry || !entry.iface) continue;

      // Check if this same switch port on this host also carries ANOTHER managed OpenWrt host's MAC (trunk/uplink port)
      let isTrunkToManagedHost = false;
      for (const [otherMac, otherEntry] of Object.entries(fdbMap)) {
        const otherOwnerId = macToHostId.get(otherMac);
        if (
          otherMac !== macLower &&
          otherEntry?.iface === entry.iface &&
          otherOwnerId &&
          otherOwnerId !== hostId &&
          otherOwnerId !== targetOwnerHostId
        ) {
          isTrunkToManagedHost = true;
          break;
        }
      }

      const hostMeta = this.hostsCacheById.get(hostId);
      const fmt = formatSwitchPortLabel(entry.iface, entry.speedMbps, entry.maxSpeedMbps);
      candidates.push({
        hostId,
        hostName: hostMeta?.name || hostMeta?.hostname || hostId,
        iface: entry.iface,
        switchPort: entry.switchPort || fmt?.switchPort || entry.iface,
        portLabel: entry.portLabel || fmt?.portLabel || entry.iface,
        portNumber: entry.portNumber ?? null,
        speedMbps: entry.speedMbps || 1000,
        maxSpeedMbps: entry.maxSpeedMbps || fmt?.maxSpeedMbps || entry.speedMbps || 1000,
        vlan: entry.vlan || 1,
        portMacCount: entry.portMacCount || 1,
        isTrunkToManagedHost,
      });
    }

    if (candidates.length === 0) return null;

    // Prefer non-trunk access ports first, then lowest portMacCount (most specific leaf switch port)
    candidates.sort((a, b) => {
      if (a.isTrunkToManagedHost !== b.isTrunkToManagedHost) {
        return a.isTrunkToManagedHost ? 1 : -1;
      }
      return (a.portMacCount || 1) - (b.portMacCount || 1);
    });

    return candidates[0];
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
        const resolvedVendor =
          c.vendor && c.vendor !== 'Unknown Manufacturer' && c.vendor !== 'Private / Randomized MAC' && c.vendor !== 'Network Device'
            ? c.vendor
            : lookupVendor(macLower, resolvedHostname);

        if (!existing || (existing.connectionType === 'wired' && c.connectionType !== 'wired')) {
          let connectedTo = c.connectedTo ? { ...c.connectedTo } : null;
          let speedMbps = c.speedMbps || c.rxRateMbps || 1000;

          if (c.connectionType === 'wired') {
            const bestPort = this.resolveBestSwitchPortForMac(macLower);
            if (bestPort) {
              connectedTo = {
                hostId: bestPort.hostId,
                hostName: bestPort.hostName,
                iface: bestPort.iface,
                switchPort: bestPort.switchPort,
                portLabel: bestPort.portLabel,
                portNumber: bestPort.portNumber,
                speedMbps: bestPort.speedMbps,
                maxSpeedMbps: bestPort.maxSpeedMbps || bestPort.speedMbps || 1000,
              };
              speedMbps = bestPort.speedMbps || speedMbps;
            } else if (connectedTo && connectedTo.iface && !connectedTo.switchPort) {
              const formatted = formatSwitchPortLabel(connectedTo.iface, speedMbps);
              if (formatted) {
                connectedTo.switchPort = formatted.switchPort;
                connectedTo.portLabel = formatted.portLabel;
                connectedTo.portNumber = formatted.portNumber;
                connectedTo.maxSpeedMbps = formatted.maxSpeedMbps || speedMbps || 1000;
              }
            }
          }

          byMac.set(macLower, {
            ...c,
            ip: resolvedIp,
            hostname: resolvedHostname,
            vendor: resolvedVendor,
            connectedTo,
            speedMbps: c.connectionType === 'wired' ? speedMbps : c.speedMbps,
            rxRateMbps: c.connectionType === 'wired' ? speedMbps : c.rxRateMbps,
            txRateMbps: c.connectionType === 'wired' ? speedMbps : c.txRateMbps,
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
          if (
            (!existing.vendor || existing.vendor === 'Unknown Manufacturer' || existing.vendor === 'Private / Randomized MAC') &&
            resolvedVendor
          ) {
            existing.vendor = resolvedVendor;
          }
          if (!existing.dhcpLeaseRemainingSec && resolvedLeaseRemaining) {
            existing.dhcpLeaseRemainingSec = resolvedLeaseRemaining;
          }
        }
      }
    }

    // Also include wired devices learned on physical switch ports (`fdbByHost`) that have a known IP in globalDhcp or globalArp (e.g. wired device plugged into a secondary AP)
    const { macToHostId } = this.getManagedHostMacMap();
    for (const hostMac of macToHostId.keys()) {
      byMac.delete(hostMac);
    }
    for (const fdbMap of this.fdbByHost.values()) {
      if (!fdbMap || typeof fdbMap !== 'object') continue;
      for (const rawMac of Object.keys(fdbMap)) {
        const macLower = rawMac.toLowerCase();
        if (byMac.has(macLower) || macToHostId.has(macLower)) continue;
        const dhcp = globalDhcp[macLower] || {};
        const arpIp = globalArp[macLower];
        const rdns = globalRdns[macLower] || {};
        const resolvedIp = dhcp.ip || arpIp || rdns.ip || null;
        if (!resolvedIp || resolvedIp === '0.0.0.0') continue;

        const bestPort = this.resolveBestSwitchPortForMac(macLower);
        if (!bestPort) continue;

        const resolvedHostname =
          (dhcp.hostname && dhcp.hostname !== '*' && dhcp.hostname !== dhcp.ip ? dhcp.hostname : null) ||
          rdns.hostname ||
          (dhcp.hostname && dhcp.hostname !== '*' ? dhcp.hostname : null) ||
          resolvedIp;

        byMac.set(macLower, {
          mac: macLower,
          ip: resolvedIp,
          hostname: resolvedHostname,
          vendor: lookupVendor(macLower, resolvedHostname),
          connectionType: 'wired',
          connectedTo: {
            hostId: bestPort.hostId,
            hostName: bestPort.hostName,
            iface: bestPort.iface,
            switchPort: bestPort.switchPort,
            portLabel: bestPort.portLabel,
            portNumber: bestPort.portNumber,
            speedMbps: bestPort.speedMbps,
            maxSpeedMbps: bestPort.maxSpeedMbps || bestPort.speedMbps || 1000,
          },
          vlan: bestPort.vlan || 1,
          isGuest: false,
          signalDbm: null,
          noiseDbm: null,
          snrDb: null,
          speedMbps: bestPort.speedMbps || 1000,
          rxRateMbps: bestPort.speedMbps || 1000,
          txRateMbps: bestPort.speedMbps || 1000,
          rxRateBps: 0,
          txRateBps: 0,
          rxBytesTotal: 0,
          txBytesTotal: 0,
          dhcpLeaseRemainingSec: dhcp.dhcpLeaseRemainingSec || 36000,
          signalHistory: [],
          roamingLog: [],
          lastSeen: new Date().toISOString(),
        });
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
          const mfgInfo = resolveWirelessNetworkManufacturer({
            bssid: bssidKey,
            ssid: n.ssid || '(Hidden Network)',
          });
          map.set(bssidKey, {
            bssid: bssidKey,
            ssid: n.ssid || '(Hidden Network)',
            isHidden: Boolean(n.isHidden),
            manufacturer: n.manufacturer || mfgInfo.manufacturer,
            bssidManufacturer: n.bssidManufacturer || mfgInfo.bssidManufacturer,
            ssidManufacturer: n.ssidManufacturer || mfgInfo.ssidManufacturer,
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
          const updatedMfg = resolveWirelessNetworkManufacturer({
            bssid: bssidKey,
            ssid: entry.ssid,
          });
          entry.manufacturer = updatedMfg.manufacturer;
          entry.bssidManufacturer = updatedMfg.bssidManufacturer;
          entry.ssidManufacturer = updatedMfg.ssidManufacturer;
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

    // Collect active hosts for RF triangulation anchor coordinates (only OpenWrt hosts with wireless radios)
    const activeHostIds = new Set();
    for (const [id, radios] of this.liveRadiosByHost.entries()) {
      if (Array.isArray(radios) && radios.length > 0) activeHostIds.add(id);
    }
    for (const [id, h] of this.hostsCacheById.entries()) {
      const liveRadios = this.liveRadiosByHost.get(id);
      const hasLiveRadios = Array.isArray(liveRadios) && liveRadios.length > 0;
      const hasCachedRadios = Boolean(h.persisted && !this.liveRadiosByHost.has(id) && h.hasWirelessRadios);
      if (hasLiveRadios || hasCachedRadios) {
        activeHostIds.add(id);
      }
    }

    const activeHosts = [];
    for (const hostId of activeHostIds) {
      const cached = this.hostsCacheById.get(hostId);
      const liveRadios = this.liveRadiosByHost.get(hostId) || cached?.radios || [];
      if (!Array.isArray(liveRadios) || liveRadios.length === 0) continue;
      if (cached) {
        activeHosts.push({
          ...cached,
          radios: liveRadios,
          hasWirelessRadios: true,
        });
      } else {
        const neighbors = this.liveNeighborsByHost.get(hostId) || [];
        const hostName =
          liveRadios[0]?.hostName ||
          neighbors[0]?.seenByHostName ||
          hostId;
        activeHosts.push({
          id: hostId,
          name: hostName,
          role: 'ap',
          mapPosition: null,
          radios: liveRadios,
          hasWirelessRadios: true,
        });
      }
    }

    triangulateBandNeighbors(bands, activeHosts);

    return bands;
  }

  async scanAllWifiNetworks(targetHostId = 'all') {
    const hosts = await this.getAllHosts({ sanitized: false });
    const onlineHosts = hosts.filter((h) => {
      if (h.isSimulated) return false;
      if (targetHostId !== 'all' && h.id !== targetHostId) return false;
      // If scanning all hosts, skip hosts that were already polled and confirmed to have 0 wireless radios
      if (targetHostId === 'all') {
        const liveRadios = this.liveRadiosByHost.get(h.id);
        if (Array.isArray(liveRadios) && liveRadios.length === 0 && (!Array.isArray(h.radios) || h.radios.length === 0)) {
          return false;
        }
      }
      return true;
    });

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
      const liveRadios = this.liveRadiosByHost.get(h.id);
      const radios = Array.isArray(liveRadios)
        ? liveRadios
        : Array.isArray(h.radios)
          ? h.radios
          : [];
      if (!this.liveRadiosByHost.has(h.id) && radios.length > 0) {
        this.liveRadiosByHost.set(h.id, radios);
      }
      const liveSwitchPorts = this.switchPortsByHost.get(h.id);
      const switchPorts = Array.isArray(liveSwitchPorts)
        ? liveSwitchPorts
        : Array.isArray(h.switchPorts)
          ? h.switchPorts
          : [];
      if (!this.switchPortsByHost.has(h.id) && switchPorts.length > 0) {
        this.switchPortsByHost.set(h.id, switchPorts);
      }
      const geo = extractHostGeolocation(h);
      this.hostsCacheById.set(h.id, {
        id: h.id,
        name: h.name || h.hostname || h.id,
        hostname: h.hostname || h.name || h.id,
        ip: h.ip || null,
        mac: h.mac ? String(h.mac).toLowerCase() : null,
        allMacs: Array.isArray(h.allMacs) ? h.allMacs : h.mac ? [String(h.mac).toLowerCase()] : [],
        hostInterfaces: Array.isArray(h.hostInterfaces) ? h.hostInterfaces : [],
        defaultRoute: h.defaultRoute || null,
        role: h.role || 'ap',
        mapPosition: h.mapPosition || null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        altitude: geo.altitude,
        radios,
        switchPorts,
        hasWirelessRadios: radios.length > 0,
        persisted: true,
      });
    }

    // Cross-correlate NIC ports and FDB tables across ALL OpenWrt hosts & clients
    const liveClients = this.getLiveClients();
    this.resolveFleetNicPorts(hosts, liveClients);

    if (sanitized) {
      return hosts.map((h) => sanitizeHost(h, this.getUpgradeJobForHost(h.id)));
    }
    return hosts;
  }

  /**
   * Checks all OpenWrt hosts to determine:
   * 1. Which local NIC port each OpenWrt host uses (`localIface` / `localPort`)
   * 2. Which upstream OpenWrt host & NIC port each OpenWrt host is connected to (`upstreamHostId` / `upstreamPort`)
   * 3. Reciprocal `connectedDevices` and `portRole` across every OpenWrt host's `switchPorts`
   */
  resolveFleetNicPorts(hosts, liveClients = []) {
    if (!Array.isArray(hosts) || hosts.length === 0) return;
    const { macToHostId, macsByHostId } = this.getManagedHostMacMap(hosts);
    const gwHost = hosts.find((h) => h.role === 'gateway') || hosts[0];

    // Step 1: Clone raw switchPorts for each host and attach wired clients
    const portsByHostId = new Map();
    for (const h of hosts) {
      const rawPorts = this.switchPortsByHost.get(h.id) || h.switchPorts || [];
      const clonedPorts = Array.isArray(rawPorts)
        ? rawPorts.map((p) => {
            const attachedClients = liveClients
              .filter(
                (c) =>
                  c.connectionType === 'wired' &&
                  c.connectedTo?.hostId === h.id &&
                  (c.connectedTo?.iface === p.iface || c.connectedTo?.switchPort === p.switchPort)
              )
              .map((c) => ({
                mac: c.mac,
                ip: c.ip,
                hostname: c.hostname,
                vendor: c.vendor || null,
                type: 'client',
              }));
            const fmt = formatSwitchPortLabel(p.iface, p.speedMbps, p.maxSpeedMbps);
            const hasActiveDevices =
              attachedClients.length > 0 || (Array.isArray(p.connectedMacs) && p.connectedMacs.length > 0);
            const isLinkUp = Boolean((p.linkUp ?? p.status === 'up') || hasActiveDevices);
            return {
              ...p,
              maxSpeedMbps: Math.max(p.maxSpeedMbps || 0, fmt?.maxSpeedMbps || 1000, p.speedMbps || 0),
              linkUp: isLinkUp,
              status: isLinkUp ? 'up' : 'down',
              connectedDevices: [...attachedClients],
            };
          })
        : [];
      portsByHostId.set(h.id, clonedPorts);
    }

    // Step 2: For each non-gateway (or secondary) OpenWrt host, check all other OpenWrt hosts' FDB tables to find its upstream host & NIC port, and check its own FDB/interfaces to find its local uplink NIC port
    for (const h of hosts) {
      const myMacs = macsByHostId.get(h.id) || new Set();
      const myPorts = portsByHostId.get(h.id) || [];
      const myFdb = this.fdbByHost.get(h.id) || {};

      // Identify WAN port if present (especially for Gateway)
      const wanPortObj =
        myPorts.find((p) => p.portRole === 'wan' || /^wan/i.test(p.iface) || /^wan/i.test(p.switchPort || '')) ||
        (h.role === 'gateway' && h.defaultRoute?.dev
          ? myPorts.find((p) => p.iface === h.defaultRoute.dev) || formatSwitchPortLabel(h.defaultRoute.dev, h.wan?.speedMbps || 1000)
          : null);

      let bestUpstream = null;
      if (h.id !== gwHost?.id || h.role !== 'gateway') {
        const upstreamCandidates = [];
        for (const peer of hosts) {
          if (peer.id === h.id) continue;
          const peerFdb = this.fdbByHost.get(peer.id) || {};
          const peerPorts = portsByHostId.get(peer.id) || [];

          let matchedPeerEntry = null;
          for (const m of myMacs) {
            if (peerFdb[m]) {
              matchedPeerEntry = peerFdb[m];
              break;
            }
          }

          if (matchedPeerEntry && matchedPeerEntry.iface) {
            const peerPortObj = peerPorts.find((p) => p.iface === matchedPeerEntry.iface);
            const formatted = peerPortObj || formatSwitchPortLabel(matchedPeerEntry.iface, matchedPeerEntry.speedMbps);
            let otherManagedHostsOnPort = 0;
            const seenOwnerIds = new Set();
            for (const [oMac, oEntry] of Object.entries(peerFdb)) {
              const oOwner = macToHostId.get(oMac);
              if (
                oOwner &&
                oOwner !== peer.id &&
                oOwner !== h.id &&
                oEntry?.iface === matchedPeerEntry.iface &&
                !seenOwnerIds.has(oOwner)
              ) {
                seenOwnerIds.add(oOwner);
                otherManagedHostsOnPort++;
              }
            }
            upstreamCandidates.push({
              upstreamHostId: peer.id,
              upstreamHostName: peer.name || peer.hostname || peer.id,
              upstreamIface: matchedPeerEntry.iface,
              upstreamPort: formatted?.switchPort || matchedPeerEntry.switchPort || matchedPeerEntry.iface,
              upstreamPortLabel: formatted?.portLabel || matchedPeerEntry.portLabel || matchedPeerEntry.iface,
              upstreamSpeedMbps: peerPortObj?.speedMbps || matchedPeerEntry.speedMbps || 1000,
              upstreamMaxSpeedMbps:
                peerPortObj?.maxSpeedMbps ||
                matchedPeerEntry.maxSpeedMbps ||
                formatted?.maxSpeedMbps ||
                peerPortObj?.speedMbps ||
                1000,
              portMacCount: matchedPeerEntry.portMacCount || 1,
              otherManagedHostsOnPort,
              isSwitchPeer: peer.role === 'switch' || peerPorts.length >= 8,
              isGatewayPeer: peer.role === 'gateway',
            });
          }
        }

        if (upstreamCandidates.length > 0) {
          upstreamCandidates.sort((a, b) => {
            if (a.otherManagedHostsOnPort !== b.otherManagedHostsOnPort) {
              return a.otherManagedHostsOnPort - b.otherManagedHostsOnPort;
            }
            if ((a.portMacCount || 1) !== (b.portMacCount || 1)) {
              return (a.portMacCount || 1) - (b.portMacCount || 1);
            }
            if (a.isSwitchPeer !== b.isSwitchPeer) {
              return a.isSwitchPeer ? -1 : 1;
            }
            if (a.isGatewayPeer !== b.isGatewayPeer) {
              return a.isGatewayPeer ? -1 : 1;
            }
            return 0;
          });
          bestUpstream = upstreamCandidates[0];
        }
      }

      // Now find which local NIC port on `h` itself connects to `bestUpstream` (or to the gateway/network)
      let localPortObj = null;
      const targetParentId = bestUpstream?.upstreamHostId || (h.id !== gwHost?.id ? gwHost?.id : null);
      const parentMacs = targetParentId ? macsByHostId.get(targetParentId) || new Set() : new Set();

      // 2a. Check `h`'s own FDB for the parent OpenWrt host's MACs
      for (const pm of parentMacs) {
        if (myFdb[pm] && myFdb[pm].iface) {
          const fEntry = myFdb[pm];
          localPortObj = myPorts.find((p) => p.iface === fEntry.iface) || {
            iface: fEntry.iface,
            switchPort: fEntry.switchPort || formatSwitchPortLabel(fEntry.iface, fEntry.speedMbps)?.switchPort || fEntry.iface,
            portLabel: fEntry.portLabel || formatSwitchPortLabel(fEntry.iface, fEntry.speedMbps)?.portLabel || fEntry.iface,
            speedMbps: fEntry.speedMbps || 1000,
          };
          break;
        }
      }

      // 2b. If not found in FDB for specific parent, check `h`'s FDB for ANY other managed OpenWrt host's MAC
      if (!localPortObj) {
        for (const [fMac, fEntry] of Object.entries(myFdb)) {
          const ownerId = macToHostId.get(fMac);
          if (ownerId && ownerId !== h.id && fEntry?.iface) {
            localPortObj = myPorts.find((p) => p.iface === fEntry.iface) || {
              iface: fEntry.iface,
              switchPort: fEntry.switchPort || formatSwitchPortLabel(fEntry.iface, fEntry.speedMbps)?.switchPort || fEntry.iface,
              portLabel: fEntry.portLabel || formatSwitchPortLabel(fEntry.iface, fEntry.speedMbps)?.portLabel || fEntry.iface,
              speedMbps: fEntry.speedMbps || 1000,
            };
            if (!bestUpstream) {
              const peerHost = hosts.find((ph) => ph.id === ownerId);
              if (peerHost) {
                bestUpstream = {
                  upstreamHostId: peerHost.id,
                  upstreamHostName: peerHost.name || peerHost.hostname || peerHost.id,
                  upstreamIface: null,
                  upstreamPort: null,
                  upstreamPortLabel: null,
                  upstreamSpeedMbps: localPortObj.speedMbps || 1000,
                };
              }
            }
            break;
          }
        }
      }

      // 2c. Check if `h`'s default route or management IP is on a specific physical NIC or active bridge port
      if (!localPortObj && h.role !== 'gateway') {
        const defDev = h.defaultRoute?.dev;
        const matchingDefPort = defDev ? myPorts.find((p) => p.iface === defDev) : null;
        if (matchingDefPort) {
          localPortObj = matchingDefPort;
        } else if (defDev && !/^(br-|br\d+|switch)/i.test(defDev) && !defDev.includes('.') && myPorts.length === 0) {
          localPortObj = formatSwitchPortLabel(defDev, 1000);
        } else {
          const activePorts = myPorts.filter((p) => p.linkUp);
          // Prefer an active port that has no leaf clients pinned or highest connectedMacs count, or lan1/eth0
          localPortObj =
            activePorts.find((p) => p.connectedDevices.length === 0) ||
            activePorts[0] ||
            myPorts[0] ||
            null;
        }
      } else if (!localPortObj && h.role === 'gateway') {
        localPortObj = wanPortObj || myPorts.find((p) => p.linkUp) || myPorts[0] || null;
      }

      const negotiatedSpeed =
        bestUpstream?.upstreamSpeedMbps ||
        localPortObj?.speedMbps ||
        wanPortObj?.speedMbps ||
        h.wan?.speedMbps ||
        1000;

      h.nicInfo = {
        localIface: localPortObj?.iface || (h.role === 'gateway' ? wanPortObj?.iface || 'eth0' : 'lan1'),
        localPort: localPortObj?.switchPort || (h.role === 'gateway' ? wanPortObj?.switchPort || 'WAN' : 'LAN 1'),
        localPortLabel:
          localPortObj?.portLabel ||
          (h.role === 'gateway' ? wanPortObj?.portLabel || 'WAN (eth0)' : 'LAN 1 (lan1)'),
        localSpeedMbps: localPortObj?.speedMbps || negotiatedSpeed,
        localMaxSpeedMbps: Math.max(
          localPortObj?.maxSpeedMbps || 0,
          localPortObj?.speedMbps || 0,
          negotiatedSpeed || 1000
        ),
        upstreamHostId: bestUpstream?.upstreamHostId || (h.id !== gwHost?.id ? gwHost?.id || null : null),
        upstreamHostName:
          bestUpstream?.upstreamHostName || (h.id !== gwHost?.id ? gwHost?.name || gwHost?.hostname || null : null),
        upstreamIface: bestUpstream?.upstreamIface || null,
        upstreamPort: bestUpstream?.upstreamPort || null,
        upstreamPortLabel: bestUpstream?.upstreamPortLabel || null,
        upstreamSpeedMbps: bestUpstream?.upstreamSpeedMbps || null,
        upstreamMaxSpeedMbps: bestUpstream?.upstreamMaxSpeedMbps || bestUpstream?.upstreamSpeedMbps || null,
        wanIface: wanPortObj?.iface || (h.role === 'gateway' ? 'eth0' : null),
        wanPort: wanPortObj?.switchPort || (h.role === 'gateway' ? 'WAN' : null),
        wanPortLabel: wanPortObj?.portLabel || (h.role === 'gateway' ? 'WAN (eth0)' : null),
        wanSpeedMbps: wanPortObj?.speedMbps || h.wan?.speedMbps || null,
        wanMaxSpeedMbps: wanPortObj?.maxSpeedMbps || wanPortObj?.speedMbps || h.wan?.speedMbps || null,
      };

      // Step 3: Reciprocally link upstream & downstream OpenWrt hosts on their respective `switchPorts`
      if (bestUpstream?.upstreamHostId && bestUpstream?.upstreamIface) {
        const upPorts = portsByHostId.get(bestUpstream.upstreamHostId) || [];
        const upPort = upPorts.find((p) => p.iface === bestUpstream.upstreamIface);
        if (upPort) {
          upPort.portRole = 'trunk';
          if (h.status !== 'offline') {
            upPort.linkUp = true;
            upPort.status = 'up';
          }
          if (!upPort.connectedDevices.some((d) => d.id === h.id)) {
            upPort.connectedDevices.unshift({
              id: h.id,
              mac: h.mac || null,
              ip: h.ip || null,
              hostname: h.name || h.hostname || h.id,
              type: h.role || 'ap',
              remoteIface: h.nicInfo.localIface,
              remotePort: h.nicInfo.localPort,
              remotePortLabel: h.nicInfo.localPortLabel,
            });
          }
        }
      }

      if (localPortObj && h.id !== gwHost?.id && h.nicInfo.upstreamHostId) {
        const myPortInList = myPorts.find((p) => p.iface === localPortObj.iface);
        const parentHost = hosts.find((ph) => ph.id === h.nicInfo.upstreamHostId);
        if (myPortInList && parentHost) {
          myPortInList.portRole = 'uplink';
          if (h.status !== 'offline' || parentHost.status !== 'offline') {
            myPortInList.linkUp = true;
            myPortInList.status = 'up';
          }
          if (!myPortInList.connectedDevices.some((d) => d.id === parentHost.id)) {
            myPortInList.connectedDevices.unshift({
              id: parentHost.id,
              mac: parentHost.mac || null,
              ip: parentHost.ip || null,
              hostname: `${parentHost.name || parentHost.hostname} (Uplink)`,
              type: parentHost.role || 'gateway',
              remoteIface: h.nicInfo.upstreamIface,
              remotePort: h.nicInfo.upstreamPort,
              remotePortLabel: h.nicInfo.upstreamPortLabel,
            });
          }
        }
      }
    }

    // Step 4: Finalize portRole on every port of every host
    for (const h of hosts) {
      const myPorts = portsByHostId.get(h.id) || [];
      for (const p of myPorts) {
        if (p.connectedDevices.length > 0 && !p.linkUp) {
          p.linkUp = true;
          p.status = 'up';
        }
        if (!p.linkUp) {
          p.portRole = p.portRole === 'wan' ? 'wan' : 'down';
        } else if (p.portRole === 'wan') {
          if (p.connectedDevices.length === 0 && h.wan?.ip) {
            p.connectedDevices.push({
              id: 'wan-internet',
              ip: h.wan.gateway || h.wan.ip,
              hostname: `WAN Uplink (${h.wan.ip})`,
              type: 'wan',
            });
          }
        } else if (p.portRole !== 'uplink' && p.portRole !== 'trunk') {
          const hasAp = p.connectedDevices.some((d) => d.type === 'ap' || d.type === 'mesh' || d.type === 'switch');
          const hasGw = p.connectedDevices.some((d) => d.type === 'gateway');
          if (hasGw) p.portRole = 'uplink';
          else if (hasAp) p.portRole = 'trunk';
          else if (p.connectedDevices.length > 0) p.portRole = 'access';
          else p.portRole = 'idle';
        }
      }
      h.switchPorts = myPorts;
    }
  }

  async getHost(id, { sanitized = true } = {}) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const host = hosts.find((h) => h.id === id) || null;
    if (!host) return null;
    return sanitized ? sanitizeHost(host, this.getUpgradeJobForHost(host.id)) : host;
  }

  async createHost(data) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const id = data.id || `node-${(data.role || 'ap')}-${Date.now().toString(36)}`;
    const protocol = data.protocol || 'ssh';
    const defaultPort = protocol === 'ssh' ? 22 : data.useHttps || protocol === 'ubus_https' ? 443 : 80;
    const geo = extractHostGeolocation(data);

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
      latitude: geo.latitude,
      longitude: geo.longitude,
      altitude: geo.altitude,
      mapPosition: data.mapPosition || null,
      radios: Array.isArray(data.radios) ? data.radios : [],
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
    const radios = Array.isArray(newHost.radios) ? newHost.radios : [];
    if (radios.length > 0) {
      this.liveRadiosByHost.set(newHost.id, radios);
    }
    this.hostsCacheById.set(newHost.id, {
      id: newHost.id,
      name: newHost.name || newHost.hostname || newHost.id,
      hostname: newHost.hostname || newHost.name || newHost.id,
      role: newHost.role || 'ap',
      mapPosition: newHost.mapPosition || null,
      latitude: newHost.latitude,
      longitude: newHost.longitude,
      altitude: newHost.altitude,
      radios,
      hasWirelessRadios: radios.length > 0,
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
    const mergedRaw = {
      ...existing,
      ...updateData,
    };

    const hasGeoFieldsInUpdate =
      'latitude' in updateData ||
      'longitude' in updateData ||
      'altitude' in updateData ||
      'lat' in updateData ||
      'lng' in updateData ||
      'alt' in updateData ||
      'geoLocation' in updateData;

    const geo = hasGeoFieldsInUpdate ? extractHostGeolocation(updateData) : extractHostGeolocation(mergedRaw);

    const updated = {
      ...mergedRaw,
      latitude: geo.latitude,
      longitude: geo.longitude,
      altitude: geo.altitude,
      // If user explicitly updated GPS coordinates without specifying a custom mapPosition, let GPS drive the floorplan projection
      mapPosition:
        updateData.mapPosition !== undefined
          ? updateData.mapPosition
          : hasGeoFieldsInUpdate && geo.hasGps
            ? null
            : existing.mapPosition || null,
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
    const radios = Array.isArray(updated.radios)
      ? updated.radios
      : (this.liveRadiosByHost.get(updated.id) || []);
    this.hostsCacheById.set(updated.id, {
      id: updated.id,
      name: updated.name || updated.hostname || updated.id,
      hostname: updated.hostname || updated.name || updated.id,
      role: updated.role || 'ap',
      mapPosition: updated.mapPosition || null,
      latitude: updated.latitude,
      longitude: updated.longitude,
      altitude: updated.altitude,
      radios,
      hasWirelessRadios: radios.length > 0,
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
    this.fdbByHost.delete(id);
    this.switchPortsByHost.delete(id);
    this.hostsCacheById.delete(id);
    const activeJobId = this.activeJobByHost.get(id);
    if (activeJobId) {
      this.upgradeJobs.delete(activeJobId);
      this.activeJobByHost.delete(id);
    }
    this.customStreamRunners.delete(id);
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

  async checkUpdatesForHost(hostId) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const host = hosts[idx];
    const res = await checkHostUpdates(host);
    if (res.firmware) host.firmware = res.firmware;
    if (res.updates) host.updates = res.updates;
    host.lastSeen = new Date().toISOString();
    hosts[idx] = host;
    await db.saveHosts(hosts);

    return {
      hostId: host.id,
      hostName: host.name || host.hostname,
      updates: host.updates,
      output: res.output || '',
      host: sanitizeHost(host),
    };
  }

  async checkUpdatesForAllHosts() {
    const hosts = await this.getAllHosts({ sanitized: false });
    const results = [];
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      if (host.isSimulated) continue;
      try {
        const res = await checkHostUpdates(host);
        if (res.firmware) host.firmware = res.firmware;
        if (res.updates) host.updates = res.updates;
        host.lastSeen = new Date().toISOString();
        hosts[i] = host;
        results.push({
          hostId: host.id,
          hostName: host.name || host.hostname,
          success: true,
          updates: host.updates,
        });
      } catch (err) {
        results.push({
          hostId: host.id,
          hostName: host.name || host.hostname,
          success: false,
          error: err.message,
        });
      }
    }
    await db.saveHosts(hosts);
    return {
      checkedCount: results.length,
      results,
      hosts: hosts.map((h) => sanitizeHost(h, this.getUpgradeJobForHost(h.id))),
    };
  }

  getUpgradeJob(jobId) {
    return this.upgradeJobs.get(jobId) || null;
  }

  getUpgradeJobForHost(hostId) {
    const jobId = this.activeJobByHost.get(hostId);
    if (!jobId) return null;
    const job = this.upgradeJobs.get(jobId);
    if (!job) return null;
    if (job.status !== 'running' && job.completedAt) {
      const ageMs = Date.now() - new Date(job.completedAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        return null;
      }
    }
    return job;
  }

  getAllUpgradeJobs({ activeOnly = false } = {}) {
    const nowMs = Date.now();
    const list = [];
    for (const job of this.upgradeJobs.values()) {
      if (activeOnly && job.status !== 'running') continue;
      if (job.status !== 'running' && job.completedAt) {
        const ageMs = nowMs - new Date(job.completedAt).getTime();
        if (ageMs > 5 * 60 * 1000) continue;
      }
      list.push(job);
    }
    list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return list;
  }

  async startPackageUpgradeJob(hostId, packages = 'all') {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const host = hosts[idx];
    const existingJob = this.getUpgradeJobForHost(host.id);
    if (existingJob && existingJob.status === 'running') {
      return {
        success: true,
        background: true,
        alreadyRunning: true,
        jobId: existingJob.id,
        status: existingJob.status,
        hostId: host.id,
        job: existingJob,
        host: sanitizeHost(host, existingJob),
      };
    }

    const targetPackages =
      Array.isArray(packages) && packages.length > 0
        ? packages.filter((p) => typeof p === 'string' && /^[a-zA-Z0-9._+-]+$/.test(p))
        : Array.isArray(host.updates?.packages) && host.updates.packages.length > 0
          ? host.updates.packages.map((p) => p.name)
          : [];

    const now = new Date().toISOString();
    const jobId = `upg-${host.id}-${Date.now().toString(36)}`;
    const job = {
      id: jobId,
      hostId: host.id,
      hostName: host.name || host.hostname || host.id,
      type: 'packages',
      action: 'upgrade',
      status: 'running',
      phase: 'Connecting via SSH and refreshing package lists...',
      progressPct: 5,
      packagesTotal: targetPackages.length,
      packagesCompleted: 0,
      currentPackage: null,
      targetPackages,
      completedPackages: [],
      failedPackages: [],
      logs: [`[${now}] Starting background package upgrade on ${host.name || host.hostname} (${host.ip})...`],
      output: `[${now}] Starting background package upgrade on ${host.name || host.hostname} (${host.ip})...`,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    };

    this.upgradeJobs.set(jobId, job);
    this.activeJobByHost.set(host.id, jobId);

    const hostWithStreamRunner = {
      ...host,
      mockStreamRunner: host.mockStreamRunner || this.customStreamRunners.get(host.id) || null,
    };

    const runPromise = (async () => {
      try {
        const res = await upgradeHostPackages(hostWithStreamRunner, packages, {
          onProgress: (prog) => {
            if (prog.phase) job.phase = prog.phase;
            if (typeof prog.progressPct === 'number') job.progressPct = prog.progressPct;
            if (typeof prog.packagesTotal === 'number') job.packagesTotal = prog.packagesTotal;
            if (typeof prog.packagesCompleted === 'number') job.packagesCompleted = prog.packagesCompleted;
            if (prog.currentPackage !== undefined) job.currentPackage = prog.currentPackage;
            if (Array.isArray(prog.completedPackages)) job.completedPackages = [...prog.completedPackages];
            if (Array.isArray(prog.failedPackages)) job.failedPackages = [...prog.failedPackages];
            if (Array.isArray(prog.logs) && prog.logs.length > 0) {
              job.logs = [...prog.logs];
              job.output = prog.logs.join('\n');
            }
            job.updatedAt = new Date().toISOString();
          },
        });

        const freshHosts = (await db.getHosts()) || [];
        const hIdx = freshHosts.findIndex((h) => h.id === host.id);
        if (hIdx !== -1) {
          if (res.updates) {
            freshHosts[hIdx].updates = res.updates;
          }
          freshHosts[hIdx].lastSeen = new Date().toISOString();
          await db.saveHosts(freshHosts);
        }

        const doneIso = new Date().toISOString();
        job.status = 'completed';
        job.progressPct = 100;
        job.currentPackage = null;
        if (typeof res.packagesCompleted === 'number' && res.packagesCompleted > 0) {
          job.packagesCompleted = res.packagesCompleted;
        }
        if (typeof res.packagesTotal === 'number' && res.packagesTotal > 0) {
          job.packagesTotal = res.packagesTotal;
        }
        job.phase =
          job.packagesCompleted > 0
            ? `Completed upgrading ${job.packagesCompleted} package(s)`
            : 'Package upgrade completed';
        if (res.output) {
          job.output = res.output;
        }
        job.updates = res.updates || host.updates;
        job.updatedAt = doneIso;
        job.completedAt = doneIso;
        return job;
      } catch (err) {
        const failIso = new Date().toISOString();
        job.status = 'failed';
        job.error = err.message || 'Package upgrade failed';
        job.currentPackage = null;
        job.phase = `Upgrade failed: ${job.error}`;
        job.logs.push(`[ERROR] ${job.error}`);
        job.output = job.logs.join('\n');
        job.updatedAt = failIso;
        job.completedAt = failIso;
        return job;
      }
    })();

    Object.defineProperty(job, '_promise', {
      value: runPromise,
      enumerable: false,
      configurable: true,
    });

    return {
      success: true,
      background: true,
      jobId: job.id,
      status: job.status,
      hostId: host.id,
      job,
      updates: host.updates,
      host: sanitizeHost(host, job),
    };
  }

  async upgradePackagesForHost(hostId, packages = 'all') {
    return this.startPackageUpgradeJob(hostId, packages);
  }

  async startAttendedSysupgradeJob(hostId, { action = 'upgrade' } = {}) {
    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const host = hosts[idx];
    const existingJob = this.getUpgradeJobForHost(host.id);
    if (existingJob && existingJob.status === 'running') {
      return {
        success: true,
        background: true,
        alreadyRunning: true,
        action,
        jobId: existingJob.id,
        status: existingJob.status,
        hostId: host.id,
        job: existingJob,
        host: sanitizeHost(host, existingJob),
      };
    }

    const now = new Date().toISOString();
    const jobId = `asu-${host.id}-${Date.now().toString(36)}`;
    const initialPhase =
      action === 'install'
        ? 'Installing Attended Sysupgrade packages (auc, luci-app-attendedsysupgrade)...'
        : 'Creating pre-upgrade TrueNAS snapshot and requesting custom firmware image...';

    const job = {
      id: jobId,
      hostId: host.id,
      hostName: host.name || host.hostname || host.id,
      type: 'attended-sysupgrade',
      action,
      status: 'running',
      phase: initialPhase,
      progressPct: 8,
      packagesTotal: action === 'install' ? 2 : 1,
      packagesCompleted: 0,
      currentPackage: action === 'install' ? 'auc + luci-app-attendedsysupgrade' : host.updates?.availableFirmwareVersion || 'firmware',
      targetPackages: [],
      completedPackages: [],
      failedPackages: [],
      logs: [`[${now}] ${initialPhase}`],
      output: `[${now}] ${initialPhase}`,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    };

    this.upgradeJobs.set(jobId, job);
    this.activeJobByHost.set(host.id, jobId);

    const hostWithStreamRunner = {
      ...host,
      mockStreamRunner: host.mockStreamRunner || this.customStreamRunners.get(host.id) || null,
    };

    const runPromise = (async () => {
      try {
        if (action === 'upgrade') {
          try {
            job.logs.push('Creating pre-upgrade configuration backup archive...');
            job.output = job.logs.join('\n');
            await backupEngine.runBackup(host.id, 'pre-upgrade');
            job.logs.push('Pre-upgrade configuration backup completed.');
            job.progressPct = 18;
            job.output = job.logs.join('\n');
          } catch {
            // Proceed even if backup snapshot fails
          }
        }

        const res = await performAttendedSysupgradeAction(hostWithStreamRunner, {
          action,
          onProgress: (prog) => {
            if (prog.phase) job.phase = prog.phase;
            if (typeof prog.progressPct === 'number') job.progressPct = prog.progressPct;
            if (Array.isArray(prog.logs) && prog.logs.length > 0) {
              job.logs = [...prog.logs];
              job.output = prog.logs.join('\n');
            }
            job.updatedAt = new Date().toISOString();
          },
        });

        const freshHosts = (await db.getHosts()) || [];
        const hIdx = freshHosts.findIndex((h) => h.id === host.id);
        if (hIdx !== -1) {
          if (res.updates) {
            freshHosts[hIdx].updates = res.updates;
          }
          freshHosts[hIdx].lastSeen = new Date().toISOString();
          await db.saveHosts(freshHosts);
        }

        const doneIso = new Date().toISOString();
        job.status = 'completed';
        job.progressPct = 100;
        job.packagesCompleted = job.packagesTotal;
        job.currentPackage = null;
        job.phase =
          action === 'install'
            ? 'Attended Sysupgrade packages installed and verified'
            : 'Attended Sysupgrade completed';
        if (res.output) {
          job.output = res.output;
        }
        job.updates = res.updates || host.updates;
        job.updatedAt = doneIso;
        job.completedAt = doneIso;
        return job;
      } catch (err) {
        const failIso = new Date().toISOString();
        job.status = 'failed';
        job.error = err.message || 'Attended Sysupgrade failed';
        job.currentPackage = null;
        job.phase = `Attended Sysupgrade failed: ${job.error}`;
        job.logs.push(`[ERROR] ${job.error}`);
        job.output = job.logs.join('\n');
        job.updatedAt = failIso;
        job.completedAt = failIso;
        return job;
      }
    })();

    Object.defineProperty(job, '_promise', {
      value: runPromise,
      enumerable: false,
      configurable: true,
    });

    return {
      success: true,
      background: true,
      action,
      jobId: job.id,
      status: job.status,
      hostId: host.id,
      job,
      updates: host.updates,
      host: sanitizeHost(host, job),
    };
  }

  async attendedSysupgradeForHost(hostId, { action = 'check' } = {}) {
    if (action === 'upgrade' || action === 'install') {
      return this.startAttendedSysupgradeJob(hostId, { action });
    }

    const hosts = await this.getAllHosts({ sanitized: false });
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const host = hosts[idx];
    const res = await performAttendedSysupgradeAction(host, { action });
    if (res.updates) {
      host.updates = res.updates;
    }
    host.lastSeen = new Date().toISOString();
    hosts[idx] = host;
    await db.saveHosts(hosts);

    return {
      success: true,
      action,
      hostId: host.id,
      output: res.output,
      updates: host.updates,
      host: sanitizeHost(host, this.getUpgradeJobForHost(host.id)),
    };
  }
}

export const hostManager = new HostManager();
