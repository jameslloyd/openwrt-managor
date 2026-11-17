/**
 * OpenWrt Manager (openwrt-managor)
 * Interactive Physical NIC & Switch Port Wiring Diagram
 * Visualizes every OpenWrt host's hardware NIC ports (including 24/28/48-port core switches),
 * inter-host trunk/uplink patch cables, negotiated link speeds, and attached wired devices across the fleet.
 */

import { escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

function truncateText(str, maxLen = 18) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

function formatSpeedShort(mbps) {
  const spd = Number(mbps) || 0;
  if (spd >= 1000) return `${spd / 1000}G`;
  if (spd > 0) return `${spd}M`;
  return '';
}

function getPortMaxSpeedMbps(port) {
  const explicitMax = Number(port?.maxSpeedMbps) || 0;
  const curSpd = Number(port?.speedMbps) || 0;
  if (explicitMax > 0) return Math.max(explicitMax, curSpd);
  const iface = String(port?.iface || port?.switchPort || '');
  if (/^(sfp|te|ten|xg|opt|qsfp)/i.test(iface)) return Math.max(curSpd, 10000);
  if (/^(fa|fe)\d+/i.test(iface)) return Math.max(curSpd, 100);
  return Math.max(curSpd, 1000);
}

function isPortActive(port) {
  return Boolean(
    (port?.linkUp ?? port?.status === 'up') ||
      (Array.isArray(port?.connectedDevices) && port.connectedDevices.length > 0) ||
      (Array.isArray(port?.connectedMacs) && port.connectedMacs.length > 0) ||
      Number(port?.rxRateBps) > 0 ||
      Number(port?.txRateBps) > 0
  );
}

function isPortSpeedSuboptimal(port) {
  const isUp = isPortActive(port);
  if (!isUp) return false;
  const cur = Number(port.speedMbps) || 0;
  const max = getPortMaxSpeedMbps(port);
  return cur > 0 && max > 0 && cur < max;
}

function getPortSpeedColor(port) {
  const isUp = isPortActive(port);
  if (!isUp) return 'var(--color-text-muted)';
  const spd = Number(port.speedMbps) || 1000;
  if (spd >= 10000) return '#a855f7'; // 10G Purple
  if (spd >= 2500) return '#06b6d4'; // 2.5G Cyan
  if (spd >= 1000) return 'var(--color-success)'; // 1G Green
  return 'var(--color-warning)'; // 100M/10M Amber
}

function getPortSpeedShort(port) {
  const isUp = isPortActive(port);
  const cur = Number(port.speedMbps) || 0;
  const max = getPortMaxSpeedMbps(port);
  if (!isUp) return 'DOWN';
  if (cur > 0 && max > 0 && cur !== max) {
    return `${formatSpeedShort(cur)}/${formatSpeedShort(max)}`;
  }
  return formatSpeedShort(cur) || '1G';
}

function getPortSpeedDetail(port) {
  const isUp = isPortActive(port);
  const cur = Number(port.speedMbps) || 0;
  const max = getPortMaxSpeedMbps(port);
  if (!isUp) {
    return max > 0 ? `DOWN (Capable: ${formatSpeedShort(max)})` : 'DOWN';
  }
  const curLabel = formatSpeedShort(cur) || '1G';
  const dupLabel = port.duplex ? ` • ${String(port.duplex).toUpperCase()}` : '';
  if (cur > 0 && max > 0 && cur !== max) {
    return `${curLabel}${dupLabel} (Capable: ${formatSpeedShort(max)})`;
  }
  return `${curLabel}${dupLabel}`;
}

function getPortRoleMeta(port) {
  const isUp = isPortActive(port);
  const role = port.portRole || (isUp ? 'access' : 'down');
  if (role === 'wan') return { label: 'WAN', bg: 'rgba(59, 130, 246, 0.16)', fg: '#3b82f6' };
  if (role === 'uplink') return { label: 'UPLINK', bg: 'rgba(6, 182, 212, 0.16)', fg: '#06b6d4' };
  if (port.hasUnmanagedSwitch) return { label: 'DUMB SW', bg: 'rgba(245, 158, 11, 0.18)', fg: 'var(--color-warning)' };
  if (role === 'trunk') return { label: 'TRUNK', bg: 'rgba(168, 85, 247, 0.16)', fg: '#a855f7' };
  if (!isUp || role === 'down') return { label: 'DOWN', bg: 'rgba(100, 116, 139, 0.14)', fg: 'var(--color-text-muted)' };
  if (role === 'access' || (Array.isArray(port.connectedDevices) && port.connectedDevices.length > 0)) {
    return { label: 'ACCESS', bg: 'rgba(16, 185, 129, 0.16)', fg: 'var(--color-success)' };
  }
  return { label: 'ACTIVE', bg: 'rgba(16, 185, 129, 0.12)', fg: 'var(--color-success)' };
}

function inferSwitchPortCapacity(host) {
  const descriptor = `${host.name || ''} ${host.hostname || ''} ${host.model || ''}`;
  const m = descriptor.match(/\b(48|52|28|26|24|18|16|10|8)\s*(?:-|\s)?(?:port|p|g|ge|rj45)/i) ||
            descriptor.match(/(?:gs|dgs|sg|crs|css|tl-sg|usw|es|jgs)\D*(48|28|24|16|8)\b/i);
  if (m) return Number(m[1]);
  if (host.role === 'switch' || /\bswitch\b/i.test(descriptor)) return 24;
  return 0;
}

export class SwitchPortDiagram {
  constructor({ container, onHostClick = null, onClientClick = null }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.onHostClick = onHostClick;
    this.onClientClick = onClientClick;
    this.hosts = [];
    this.clients = [];
    this.links = [];
    this.showActiveOnly = false;
    this.isExpanded = false;
    this.initDOM();
  }

  initDOM() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="chart-card switch-port-diagram-card" id="switch-port-diagram-card" style="display: flex; flex-direction: column; gap: 14px;">
        <div class="chart-header" style="flex-wrap: wrap; gap: 12px;">
          <div class="chart-title-group">
            <h2 style="display: flex; align-items: center; gap: 8px;">
              ${renderIcon('server', 'icon')}
              Physical NIC &amp; Switch Port Wiring Diagram
            </h2>
            <span style="font-size: 12px; color: var(--color-text-muted);">
              Cross-host NIC port mapping, multi-port core switch faceplates, inter-router Ethernet/SFP+ patch links, and attached wired endpoints
            </span>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <div class="chart-legend" style="gap: 10px; font-size: 11.5px;">
              <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #a855f7;"></span>10G SFP+</span>
              <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #06b6d4;"></span>2.5G</span>
              <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: var(--color-success);"></span>1G</span>
              <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning);"></span>100M</span>
              <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-muted);"></span>Down</span>
            </div>
            <button type="button" class="btn btn-secondary" id="sw-diag-filter-btn" style="height: 30px; padding: 0 10px; font-size: 11.5px;">
              All Ports
            </button>
            <button type="button" class="btn btn-secondary" id="sw-diag-expand-btn" style="height: 30px; padding: 0 10px; font-size: 11.5px;" title="Toggle expanded view">
              ${renderIcon('maximize', 'icon icon-sm')} <span class="sw-expand-label">Larger View</span>
            </button>
          </div>
        </div>

        <!-- Interactive SVG Inter-Host NIC Patch Wiring Diagram -->
        <div id="sw-diag-svg-wrap" style="width: 100%; overflow-x: auto; background: var(--color-bg-primary); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-md); padding: 8px;"></div>

        <!-- Hardware Switch Chassis Faceplates & Port Matrix per OpenWrt Host -->
        <div id="sw-diag-chassis-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px;"></div>
      </div>
    `;

    const filterBtn = this.container.querySelector('#sw-diag-filter-btn');
    if (filterBtn) {
      filterBtn.addEventListener('click', () => {
        this.showActiveOnly = !this.showActiveOnly;
        filterBtn.textContent = this.showActiveOnly ? 'Active Ports Only' : 'All Ports';
        filterBtn.classList.toggle('btn-primary', this.showActiveOnly);
        filterBtn.classList.toggle('btn-secondary', !this.showActiveOnly);
        this.render();
      });
    }

    const expandBtn = this.container.querySelector('#sw-diag-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        this.isExpanded = !this.isExpanded;
        const card = this.container.querySelector('#switch-port-diagram-card');
        const label = expandBtn.querySelector('.sw-expand-label');
        if (card) {
          if (this.isExpanded) {
            card.style.position = 'fixed';
            card.style.inset = '16px';
            card.style.zIndex = '1100';
            card.style.overflowY = 'auto';
            card.style.boxShadow = '0 24px 64px rgba(0, 0, 0, 0.65)';
            if (label) label.textContent = 'Exit Fullscreen';
          } else {
            card.style.position = '';
            card.style.inset = '';
            card.style.zIndex = '';
            card.style.overflowY = '';
            card.style.boxShadow = '';
            if (label) label.textContent = 'Larger View';
          }
        }
        this.render();
      });
    }
  }

  setData({ hosts = [], clients = [], links = [] }) {
    this.hosts = Array.isArray(hosts) ? hosts : [];
    this.clients = Array.isArray(clients) ? clients : [];
    this.links = Array.isArray(links) ? links : [];
    this.render();
  }

  normalizeHostPorts(host) {
    const rawPorts = Array.isArray(host.switchPorts) ? host.switchPorts : [];
    const expectedSwitchCapacity = inferSwitchPortCapacity(host);
    const isCoreSwitch = host.role === 'switch' || expectedSwitchCapacity >= 8 || rawPorts.length >= 8;

    // If the host is a multi-port switch (e.g. 24-port core switch) but only reported <= 1 management/bridge interface
    // (e.g. switch.1 or eth0 before full DSA/swconfig port enumeration), synthesize the full 24-port faceplate
    if (rawPorts.length <= 1 && expectedSwitchCapacity >= 8) {
      const existingPort = rawPorts[0] || null;
      const existingDevices = Array.isArray(existingPort?.connectedDevices) ? [...existingPort.connectedDevices] : [];
      const synthPorts = [];
      for (let i = 1; i <= expectedSwitchCapacity; i++) {
        const iface = `lan${i}`;
        const switchPort = `LAN ${i}`;
        const isUplinkPort = i === 1 && host.status !== 'offline';
        const attachedClients = this.clients
          .filter(
            (c) =>
              c.connectionType === 'wired' &&
              c.connectedTo?.hostId === host.id &&
              (c.connectedTo?.portNumber === i || c.connectedTo?.iface === iface || c.connectedTo?.switchPort === switchPort)
          )
          .map((c) => ({
            mac: c.mac,
            ip: c.ip,
            hostname: c.hostname,
            vendor: c.vendor || null,
            type: 'client',
          }));
        const attachedPeers = this.hosts
          .filter(
            (peer) =>
              peer.id !== host.id &&
              peer.status !== 'offline' &&
              peer.nicInfo?.upstreamHostId === host.id &&
              (peer.nicInfo?.upstreamIface === iface || peer.nicInfo?.upstreamPort === switchPort)
          )
          .map((peer) => ({
            id: peer.id,
            mac: peer.mac || null,
            ip: peer.ip || null,
            hostname: peer.name || peer.hostname || peer.id,
            type: peer.role || 'ap',
          }));
        const connectedDevices =
          i === 1 ? [...existingDevices, ...attachedPeers, ...attachedClients] : [...attachedPeers, ...attachedClients];
        const isUp = isUplinkPort || connectedDevices.length > 0;
        synthPorts.push({
          iface,
          switchPort,
          portNumber: i,
          portLabel: `LAN ${i} (${iface})`,
          portRole: isUplinkPort ? 'uplink' : attachedPeers.length > 0 ? 'trunk' : connectedDevices.length > 0 ? 'access' : 'down',
          speedMbps: existingPort?.speedMbps || 1000,
          duplex: 'full',
          status: isUp ? 'up' : 'down',
          linkUp: isUp,
          connectedDevices,
        });
      }

      // Distribute any unassigned downstream APs or wired clients attached to this switch across ports 2..N
      const assignedPeerIds = new Set(
        synthPorts.flatMap((p) => p.connectedDevices.map((d) => d.id).filter(Boolean))
      );
      const unassignedPeers = this.hosts.filter(
        (peer) =>
          peer.id !== host.id &&
          peer.role !== 'gateway' &&
          peer.status !== 'offline' &&
          !assignedPeerIds.has(peer.id) &&
          (peer.nicInfo?.upstreamHostId === host.id || (!peer.nicInfo?.upstreamIface && isCoreSwitch))
      );
      let nextPortIdx = 1;
      for (const peer of unassignedPeers) {
        while (nextPortIdx < synthPorts.length && synthPorts[nextPortIdx].connectedDevices.length > 0) {
          nextPortIdx++;
        }
        if (nextPortIdx < synthPorts.length) {
          const targetPort = synthPorts[nextPortIdx];
          targetPort.connectedDevices.push({
            id: peer.id,
            mac: peer.mac || null,
            ip: peer.ip || null,
            hostname: peer.name || peer.hostname || peer.id,
            type: peer.role || 'ap',
          });
          targetPort.linkUp = true;
          targetPort.status = 'up';
          targetPort.portRole = 'trunk';
          nextPortIdx++;
        }
      }

      const assignedClientMacs = new Set(
        synthPorts.flatMap((p) => p.connectedDevices.map((d) => d.mac && d.mac.toLowerCase()).filter(Boolean))
      );
      const unassignedClients = this.clients.filter(
        (c) =>
          c.connectionType === 'wired' &&
          c.connectedTo?.hostId === host.id &&
          c.mac &&
          !assignedClientMacs.has(c.mac.toLowerCase())
      );
      for (const c of unassignedClients) {
        while (nextPortIdx < synthPorts.length && synthPorts[nextPortIdx].connectedDevices.length > 0) {
          nextPortIdx++;
        }
        const targetPort = synthPorts[nextPortIdx < synthPorts.length ? nextPortIdx : 0];
        if (targetPort) {
          targetPort.connectedDevices.push({
            mac: c.mac,
            ip: c.ip,
            hostname: c.hostname,
            vendor: c.vendor || null,
            type: 'client',
          });
          targetPort.linkUp = true;
          targetPort.status = 'up';
          if (targetPort.portRole === 'down') targetPort.portRole = 'access';
          nextPortIdx++;
        }
      }

      if (this.showActiveOnly) {
        const active = synthPorts.filter((p) => p.linkUp || p.connectedDevices.length > 0);
        return active.length > 0 ? active : synthPorts;
      }
      return synthPorts;
    }

    if (rawPorts.length > 0) {
      const isHostOnline = host.status !== 'offline';
      const nic = host.nicInfo || {};
      const enrichedPorts = rawPorts.map((p) => {
        const existingDevices = Array.isArray(p.connectedDevices) ? [...p.connectedDevices] : [];
        const portMacSet = new Set(
          Array.isArray(p.connectedMacs) ? p.connectedMacs.map((m) => String(m || '').toLowerCase()).filter(Boolean) : []
        );
        const isTrunkOrUplink = p.portRole === 'trunk' || p.portRole === 'uplink' || p.portRole === 'wan';
        const extraClients = this.clients
          .filter((c) => {
            if (c.connectionType !== 'wired') return false;
            const cMac = c.mac ? c.mac.toLowerCase() : null;
            if (existingDevices.some((d) => d.mac && cMac && d.mac.toLowerCase() === cMac)) return false;
            const matchByConnectedTo =
              c.connectedTo?.hostId === host.id &&
              (c.connectedTo?.iface === p.iface ||
                c.connectedTo?.switchPort === p.switchPort ||
                (p.portNumber !== null && p.portNumber !== undefined && c.connectedTo?.portNumber === p.portNumber));
            const matchByPortFdb = !isTrunkOrUplink && cMac && portMacSet.has(cMac);
            return matchByConnectedTo || matchByPortFdb;
          })
          .map((c) => ({
            mac: c.mac,
            ip: c.ip,
            hostname: c.hostname,
            vendor: c.vendor || null,
            type: 'client',
          }));
        const extraPeers = this.hosts
          .filter((peer) => {
            if (peer.id === host.id || peer.status === 'offline') return false;
            if (existingDevices.some((d) => d.id === peer.id)) return false;
            const matchByUpstream =
              peer.nicInfo?.upstreamHostId === host.id &&
              (peer.nicInfo?.upstreamIface === p.iface || peer.nicInfo?.upstreamPort === p.switchPort);
            const peerMac = peer.mac ? peer.mac.toLowerCase() : null;
            const matchByPeerMac = peerMac && portMacSet.has(peerMac) && p.portRole !== 'uplink';
            return matchByUpstream || matchByPeerMac;
          })
          .map((peer) => ({
            id: peer.id,
            mac: peer.mac || null,
            ip: peer.ip || null,
            hostname: peer.name || peer.hostname || peer.id,
            type: peer.role || 'ap',
          }));
        const connectedDevices = [...existingDevices, ...extraPeers, ...extraClients];
        const isActiveLocalNic =
          isHostOnline &&
          ((nic.localIface && p.iface === nic.localIface) || (nic.localPort && p.switchPort === nic.localPort));
        const isActiveRole =
          isHostOnline && (p.portRole === 'uplink' || p.portRole === 'trunk' || (p.portRole === 'wan' && host.role === 'gateway'));
        const hasTraffic = Number(p.rxRateBps) > 0 || Number(p.txRateBps) > 0;
        const hasMacs = portMacSet.size > 0;
        const hasTopologyLink = this.links.some(
          (l) =>
            (l.source === host.id && (l.sourceIface === p.iface || l.sourcePort === p.switchPort)) ||
            (l.target === host.id && (l.targetIface === p.iface || l.targetPort === p.switchPort))
        );
        const isUp = Boolean(
          (p.linkUp ?? p.status === 'up') ||
            connectedDevices.length > 0 ||
            hasMacs ||
            hasTraffic ||
            hasTopologyLink ||
            isActiveLocalNic ||
            isActiveRole
        );
        let portRole = p.portRole;
        if (isUp && (!portRole || portRole === 'down' || portRole === 'lan')) {
          if (extraPeers.length > 0 || connectedDevices.some((d) => d.type === 'ap' || d.type === 'switch' || d.type === 'mesh')) {
            portRole = 'trunk';
          } else if (connectedDevices.length > 0) {
            portRole = 'access';
          } else {
            portRole = 'idle';
          }
        }
        return {
          ...p,
          portRole,
          linkUp: isUp,
          status: isUp ? 'up' : 'down',
          connectedDevices,
        };
      });

      // Attach any remaining wired clients assigned to `host.id` whose iface didn't match a specific port name
      const assignedMacs = new Set(
        enrichedPorts.flatMap((p) => p.connectedDevices.map((d) => d.mac && d.mac.toLowerCase()).filter(Boolean))
      );
      const leftoverClients = this.clients.filter(
        (c) =>
          c.connectionType === 'wired' &&
          c.connectedTo?.hostId === host.id &&
          c.mac &&
          !assignedMacs.has(c.mac.toLowerCase())
      );
      if (leftoverClients.length > 0) {
        let portCursor = enrichedPorts.findIndex((p) => p.portRole !== 'wan' && p.portRole !== 'uplink' && p.connectedDevices.length === 0);
        if (portCursor === -1) portCursor = 0;
        for (const c of leftoverClients) {
          const targetPort = enrichedPorts[portCursor % enrichedPorts.length];
          if (targetPort) {
            targetPort.connectedDevices.push({
              mac: c.mac,
              ip: c.ip,
              hostname: c.hostname,
              vendor: c.vendor || null,
              type: 'client',
            });
            targetPort.linkUp = true;
            targetPort.status = 'up';
            if (!targetPort.portRole || targetPort.portRole === 'down' || targetPort.portRole === 'idle') {
              targetPort.portRole = 'access';
            }
            portCursor++;
          }
        }
      }

      // Evaluate Unmanaged ("Dumb") Switch presence on each enriched port
      for (const p of enrichedPorts) {
        const isUplinkOrWan =
          p.portRole === 'uplink' ||
          p.portRole === 'wan' ||
          (isHostOnline &&
            ((nic.localIface && p.iface === nic.localIface) || (nic.localPort && p.switchPort === nic.localPort)));
        const hasDownstreamManagedSwitch = p.connectedDevices.some((d) => {
          if (d.type === 'switch') return true;
          if (d.id) {
            const peer = this.hosts.find((ph) => ph.id === d.id);
            if (peer && (peer.role === 'switch' || inferSwitchPortCapacity(peer) >= 8 || (Array.isArray(peer.switchPorts) && peer.switchPorts.length >= 8))) {
              return true;
            }
          }
          return false;
        });
        const directEndpoints = p.connectedDevices.filter(
          (d) => d.type !== 'wan' && d.type !== 'gateway' && !(d.hostname && String(d.hostname).includes('(Uplink)'))
        );
        if (!isUplinkOrWan && !hasDownstreamManagedSwitch && (p.hasUnmanagedSwitch || directEndpoints.length >= 2)) {
          p.hasUnmanagedSwitch = true;
          p.unmanagedSwitch = p.unmanagedSwitch || {
            id: `unmanaged-switch-${host.id}-${p.iface}`,
            name: `Unmanaged Switch (${p.switchPort || p.iface})`,
            parentHostId: host.id,
            parentHostName: host.name || host.hostname || host.id,
            parentIface: p.iface,
            parentPort: p.switchPort || p.iface,
            parentPortLabel: p.portLabel || p.switchPort || p.iface,
            speedMbps: p.speedMbps || 1000,
            deviceCount: directEndpoints.length,
            devices: directEndpoints,
          };
          p.unmanagedSwitch.deviceCount = Math.max(p.unmanagedSwitch.deviceCount || 0, directEndpoints.length);
          p.unmanagedSwitch.devices = directEndpoints;
        }
      }

      if (this.showActiveOnly) {
        const filtered = enrichedPorts.filter(
          (p) => p.linkUp || (Array.isArray(p.connectedDevices) && p.connectedDevices.length > 0)
        );
        return filtered.length > 0 ? filtered : enrichedPorts;
      }
      return enrichedPorts;
    }

    // Synthesize fallback NIC port from nicInfo if host has not yet reported individual switch ports
    const nic = host.nicInfo || {};
    const fallbackIface = nic.localIface || (host.role === 'gateway' ? 'eth0' : 'lan1');
    const fallbackPort = nic.localPort || (host.role === 'gateway' ? 'WAN' : 'LAN 1');
    return [
      {
        iface: fallbackIface,
        switchPort: fallbackPort,
        portLabel: nic.localPortLabel || `${fallbackPort} (${fallbackIface})`,
        portRole: host.role === 'gateway' ? 'wan' : 'uplink',
        speedMbps: nic.localSpeedMbps || 1000,
        status: host.status === 'online' ? 'up' : 'down',
        linkUp: host.status === 'online',
        connectedDevices: [],
      },
    ];
  }

  render() {
    if (!this.container) return;
    const svgWrap = this.container.querySelector('#sw-diag-svg-wrap');
    const chassisGrid = this.container.querySelector('#sw-diag-chassis-grid');
    if (!svgWrap || !chassisGrid) return;

    if (!this.hosts || this.hosts.length === 0) {
      svgWrap.innerHTML = `
        <div class="empty-state" style="padding: 24px;">
          <div class="empty-state-title">No OpenWrt Hosts Available</div>
          <div class="empty-state-desc">Register an OpenWrt router, switch, or access point to inspect NIC &amp; switch port wiring.</div>
        </div>
      `;
      chassisGrid.innerHTML = '';
      return;
    }

    this.renderSvgWiringDiagram(svgWrap);
    this.renderChassisCards(chassisGrid);
  }

  renderSvgWiringDiagram(svgWrap) {
    const gwHost = this.hosts.find((h) => h.role === 'gateway') || this.hosts[0];
    const nonGwHosts = this.hosts.filter((h) => h.id !== gwHost.id);

    // Compute layout metrics per host (supports both single-row routers/APs and 2-row 16/24/28/48-port switches)
    const buildHostBoxSpec = (host) => {
      const ports = this.normalizeHostPorts(host);
      const isMultiRow = ports.length > 8;
      const rows = isMultiRow ? 2 : 1;
      const cols = Math.ceil(Math.max(1, ports.length) / rows);
      const portBoxW = isMultiRow ? 58 : 74;
      const portBoxH = isMultiRow ? 44 : 54;
      const portGapX = isMultiRow ? 6 : 10;
      const portGapY = 8;
      const chassisPadX = 18;
      const chassisHeaderH = 44;
      const w = Math.max(250, chassisPadX * 2 + cols * portBoxW + Math.max(0, cols - 1) * portGapX);
      const h = chassisHeaderH + rows * portBoxH + (rows - 1) * portGapY + 18;
      const isCoreSwitch =
        host.role === 'switch' ||
        ports.length >= 8 ||
        inferSwitchPortCapacity(host) >= 8;
      return {
        host,
        ports,
        isMultiRow,
        rows,
        cols,
        portBoxW,
        portBoxH,
        portGapX,
        portGapY,
        chassisHeaderH,
        w,
        h,
        isCoreSwitch,
      };
    };

    const gwSpec = buildHostBoxSpec(gwHost);
    const nonGwSpecs = nonGwHosts.map(buildHostBoxSpec);

    // Separate non-gateway hosts into Middle Tier (Core Switches) and Bottom Tier (Access Points / Mesh Nodes)
    const switchSpecs = nonGwSpecs.filter((s) => s.isCoreSwitch);
    const apSpecs = nonGwSpecs.filter((s) => !s.isCoreSwitch);
    const defaultSwitchHost = switchSpecs[0]?.host || null;

    const hostGapX = 32;
    const tierGapY = 86;

    // Dynamically size each Dumb Switch box so every attached host can be read in full
    const measureDumbSwitchBox = (host, port, usw) => {
      const rawDevices =
        Array.isArray(usw?.devices) && usw.devices.length > 0
          ? usw.devices
          : Array.isArray(port?.connectedDevices)
            ? port.connectedDevices
            : [];
      const deviceEntries = rawDevices.map((d) => {
        const primary = d.hostname || d.ip || d.mac || 'Host';
        const secondary =
          d.hostname && d.ip && d.ip !== '0.0.0.0'
            ? ` (${d.ip})`
            : !d.hostname && d.ip && d.mac
              ? ` (${d.mac})`
              : '';
        return {
          device: d,
          label: `${primary}${secondary}`,
          isInfra:
            d.type === 'ap' ||
            d.type === 'gateway' ||
            d.type === 'switch' ||
            d.type === 'mesh',
        };
      });

      const devCount = deviceEntries.length || usw?.deviceCount || 2;
      const titleText = `Dumb Switch (${port.switchPort || port.iface})`;
      const subText = `${devCount} Hosts on ${host.name || host.hostname || host.id}`;
      const cols = deviceEntries.length > 4 ? 2 : 1;
      const rows = Math.max(1, Math.ceil(deviceEntries.length / cols));
      const maxEntryChars = deviceEntries.reduce(
        (maxLen, e) => Math.max(maxLen, e.label.length),
        18
      );
      const colW = Math.max(155, Math.ceil(maxEntryChars * 6.1) + 22);
      const headerMinW = Math.max(
        Math.ceil(titleText.length * 7.0) + 36,
        Math.ceil(subText.length * 6.1) + 28
      );
      const contentW = cols * colW + (cols - 1) * 14 + 24;
      const w = Math.max(215, headerMinW, contentW);
      const headerH = 40;
      const rowH = 16;
      const h = headerH + rows * rowH + 12;

      return {
        w,
        h,
        cols,
         rows,
        colW,
        headerH,
        rowH,
        titleText,
        subText,
        deviceEntries,
      };
    };

    // Count total potential width per tier so svgW is wide enough for all chassis and expanded dumb switches
    let totalDumbSwitchesW = 0;
    let totalDumbSwitchesCount = 0;
    this.hosts.forEach((h) => {
      const ports = this.normalizeHostPorts(h);
      ports.forEach((p) => {
        if (p.hasUnmanagedSwitch) {
          const metrics = measureDumbSwitchBox(h, p, p.unmanagedSwitch);
          totalDumbSwitchesW += metrics.w;
          totalDumbSwitchesCount += 1;
        }
      });
    });
    const switchTierEstW =
      switchSpecs.reduce((acc, s) => acc + s.w, 0) + Math.max(0, switchSpecs.length - 1) * hostGapX;
    const apAndDumbEstW =
      apSpecs.reduce((acc, s) => acc + s.w, 0) +
      totalDumbSwitchesW +
      Math.max(0, apSpecs.length + totalDumbSwitchesCount - 1) * hostGapX;
    const maxTierW = Math.max(gwSpec.w, switchTierEstW, apAndDumbEstW);

    const svgW = Math.max(920, maxTierW + 96);
    const centerX = svgW / 2;

    // Position coordinates of every (hostId, iface/switchPort) jack and rendered dumb switch
    const portJackCoords = new Map();
    const dumbSwitchCoords = new Map();

    // Helper: resolve which upstream port jack a child host plugs into
    const findUpstreamCoordForHost = (secHost) => {
      const nic = secHost.nicInfo || {};
      let parentId = nic.upstreamHostId || gwHost.id;
      if (
        defaultSwitchHost &&
        secHost.id !== defaultSwitchHost.id &&
        parentId === gwHost.id &&
        !nic.upstreamIface
      ) {
        parentId = defaultSwitchHost.id;
      }

      const srcCoord =
        (nic.upstreamIface && portJackCoords.get(`${parentId}:${nic.upstreamIface}`)) ||
        (nic.upstreamPort && portJackCoords.get(`${parentId}:${nic.upstreamPort}`)) ||
        Array.from(portJackCoords.values()).find(
          (c) =>
            c.host.id === parentId &&
            Array.isArray(c.port.connectedDevices) &&
            c.port.connectedDevices.some((d) => d.id === secHost.id)
        ) ||
        Array.from(portJackCoords.values()).find(
          (c) => c.host.id === parentId && c.port.portRole !== 'wan' && (c.port.linkUp ?? c.port.status === 'up')
        ) ||
        Array.from(portJackCoords.values()).find((c) => c.host.id === parentId) ||
        null;

      return { parentId, srcCoord };
    };

    // Helper: 1D crossing-minimizing row solver that preserves sorted port order and anchors items near targetX
    const resolveHorizontalRow = (items, gap = hostGapX, margin = 28) => {
      if (items.length === 0) return [];
      const sorted = [...items].sort((a, b) => {
        if (Math.abs(a.targetX - b.targetX) > 1) return a.targetX - b.targetX;
        if ((a.targetRow ?? 0) !== (b.targetRow ?? 0)) return (a.targetRow ?? 0) - (b.targetRow ?? 0);
        return (a.orderIdx ?? 0) - (b.orderIdx ?? 0);
      });

      // Block-pool adjacent violators so items sit directly beneath their parent ports without colliding
      const blocks = sorted.map((item) => ({
        items: [item],
        width: item.w,
        desiredCenter: item.targetX,
      }));

      let merged = true;
      while (merged) {
        merged = false;
        for (let i = 0; i < blocks.length - 1; i++) {
          const left = blocks[i];
          const right = blocks[i + 1];
          const minDistance = left.width / 2 + right.width / 2 + gap;
          if (right.desiredCenter - left.desiredCenter < minDistance) {
            const combinedItems = [...left.items, ...right.items];
            const combinedW = left.width + right.width + gap;
            const avgCenter =
              combinedItems.reduce((sum, it) => sum + it.targetX, 0) / combinedItems.length;
            blocks.splice(i, 2, {
              items: combinedItems,
              width: combinedW,
              desiredCenter: avgCenter,
            });
            merged = true;
            break;
          }
        }
      }

      const placements = [];
      blocks.forEach((block) => {
        let cursor = block.desiredCenter - block.width / 2;
        block.items.forEach((it) => {
          placements.push({ item: it, x: cursor, centerX: cursor + it.w / 2 });
          cursor += it.w + gap;
        });
      });

      // Clamp within [margin, svgW - margin] while preserving relative spacing
      const minLeft = placements[0].x;
      if (minLeft < margin) {
        const shiftRight = margin - minLeft;
        placements.forEach((p) => {
          p.x += shiftRight;
          p.centerX += shiftRight;
        });
      }
      const last = placements[placements.length - 1];
      const maxRight = last.x + last.item.w;
      if (maxRight > svgW - margin) {
        const shiftLeft = maxRight - (svgW - margin);
        placements.forEach((p) => {
          p.x -= shiftLeft;
          p.centerX -= shiftLeft;
        });
      }
      // Final forward sweep in case clamping compressed the left edge
      for (let i = 0; i < placements.length; i++) {
        if (i === 0 && placements[0].x < margin) {
          placements[0].x = margin;
          placements[0].centerX = margin + placements[0].item.w / 2;
        } else if (i > 0) {
          const minX = placements[i - 1].x + placements[i - 1].item.w + gap;
          if (placements[i].x < minX) {
            placements[i].x = minX;
            placements[i].centerX = minX + placements[i].item.w / 2;
          }
        }
      }

      return placements;
    };

    const renderChassisSvg = (spec, x, y, tierIdx) => {
      const { host, ports, rows, cols, portBoxW, portBoxH, portGapX, portGapY, chassisHeaderH, w, h } = spec;
      const hostName = host.name || host.hostname || host.id;
      const nic = host.nicInfo || {};
      const activeCount = ports.filter((p) => p.linkUp ?? p.status === 'up').length;
      const uplinkBadge =
        host.role === 'gateway'
          ? `WAN NIC: ${nic.wanPortLabel || nic.localPortLabel || 'eth0'} • ${activeCount}/${ports.length} Ports Up`
          : `On NIC: ${nic.localPortLabel || 'lan1'}${nic.upstreamHostName ? ` → ${nic.upstreamHostName} ${nic.upstreamPort || ''}` : ''} • ${activeCount}/${ports.length} Ports Up`;

      const totalPortsW = cols * portBoxW + Math.max(0, cols - 1) * portGapX;
      const startPortX = x + (w - totalPortsW) / 2;
      const startPortY = y + chassisHeaderH;

      let portsSvg = '';
      ports.forEach((p, idx) => {
        const row = rows > 1 ? Math.floor(idx / cols) : 0;
        const col = rows > 1 ? idx % cols : idx;
        const px = startPortX + col * (portBoxW + portGapX);
        const py = startPortY + row * (portBoxH + portGapY);
        const jackCenterX = px + portBoxW / 2;

        const coordEntry = {
          x: jackCenterX,
          topY: py,
          bottomY: py + portBoxH,
          chassisTopY: y,
          chassisBottomY: y + h,
          row,
          rows,
          tierIdx,
          port: p,
          host,
        };
        portJackCoords.set(`${host.id}:${p.iface}`, coordEntry);
        if (p.switchPort) {
          portJackCoords.set(`${host.id}:${p.switchPort}`, coordEntry);
        }

        const color = getPortSpeedColor(p);
        const spdShort = getPortSpeedShort(p);
        const roleMeta = getPortRoleMeta(p);
        const isUp = p.linkUp ?? p.status === 'up';
        const isDumbSw = Boolean(p.hasUnmanagedSwitch);
        const devCount = Array.isArray(p.connectedDevices) ? p.connectedDevices.length : 0;
        const devFirst = devCount > 0 ? p.connectedDevices[0] : null;
        const devLabel = isDumbSw
          ? spec.isMultiRow
            ? `SW(${devCount})`
            : `DUMB SW (${devCount})`
          : devFirst
            ? truncateText(devFirst.hostname || devFirst.ip || devFirst.mac, spec.isMultiRow ? 8 : 11)
            : isUp
              ? roleMeta.label
              : 'Down';

        const spdDetail = getPortSpeedDetail(p);
        const tooltip = `${hostName} • ${p.portLabel || p.iface} [${spdDetail}]${
          isDumbSw ? ` • Unmanaged (Dumb) Switch (${devCount} hosts)` : ''
        }${
          devCount > 0
            ? ' — Attached: ' + p.connectedDevices.map((d) => d.hostname || d.ip || d.mac).join(', ')
            : ''
        }`;

        if (spec.isMultiRow) {
          // Compact 2-row hardware switch port jack (ideal for 16/24/28/48-port switches)
          portsSvg += `
            <g class="sw-svg-port" data-host-id="${escapeHtml(host.id)}" data-iface="${escapeHtml(p.iface)}" style="cursor: pointer;">
              <title>${escapeHtml(tooltip)}</title>
              <rect x="${px}" y="${py}" width="${portBoxW}" height="${portBoxH}" rx="5"
                    fill="var(--color-surface)" stroke="${isDumbSw ? 'var(--color-warning)' : isUp ? color : 'var(--color-border)'}" stroke-width="${isDumbSw ? '1.8' : isUp ? '1.6' : '1'}" />
              <circle cx="${px + 8}" cy="${py + 9}" r="3" fill="${color}" />
              <text x="${px + portBoxW - 5}" y="${py + 12}" font-size="8" font-weight="700" fill="${color}" text-anchor="end" font-family="var(--font-mono)">
                ${escapeHtml(spdShort)}
              </text>
              <text x="${px + portBoxW / 2}" y="${py + 25}" font-size="9.5" font-weight="700" fill="var(--color-text-primary)" text-anchor="middle">
                ${escapeHtml(truncateText(p.switchPort || p.iface, 8))}
              </text>
              <text x="${px + portBoxW / 2}" y="${py + 37}" font-size="7.5" font-weight="700" fill="${isDumbSw ? 'var(--color-warning)' : devFirst ? 'var(--color-primary)' : 'var(--color-text-muted)'}" text-anchor="middle">
                ${escapeHtml(devLabel)}
              </text>
            </g>
          `;
        } else {
          portsSvg += `
            <g class="sw-svg-port" data-host-id="${escapeHtml(host.id)}" data-iface="${escapeHtml(p.iface)}" style="cursor: pointer;">
              <title>${escapeHtml(tooltip)}</title>
              <rect x="${px}" y="${py}" width="${portBoxW}" height="${portBoxH}" rx="6"
                    fill="var(--color-surface)" stroke="${isDumbSw ? 'var(--color-warning)' : isUp ? color : 'var(--color-border)'}" stroke-width="${isDumbSw ? '2' : isUp ? '1.8' : '1'}" />
              <circle cx="${px + 10}" cy="${py + 11}" r="3.5" fill="${color}" />
              <text x="${px + portBoxW - 6}" y="${py + 14}" font-size="9" font-weight="700" fill="${color}" text-anchor="end" font-family="var(--font-mono)">
                ${escapeHtml(spdShort)}
              </text>
              <text x="${px + portBoxW / 2}" y="${py + 29}" font-size="10.5" font-weight="700" fill="var(--color-text-primary)" text-anchor="middle">
                ${escapeHtml(truncateText(p.switchPort || p.iface, 10))}
              </text>
              <text x="${px + portBoxW / 2}" y="${py + 40}" font-size="8.5" fill="var(--color-text-muted)" text-anchor="middle" font-family="var(--font-mono)">
                ${escapeHtml(truncateText(p.iface, 11))}
              </text>
              <text x="${px + portBoxW / 2}" y="${py + 50}" font-size="8.5" font-weight="700" fill="${isDumbSw ? 'var(--color-warning)' : devFirst ? 'var(--color-primary)' : 'var(--color-text-secondary)'}" text-anchor="middle">
                ${escapeHtml(devLabel)}
              </text>
            </g>
          `;
        }
      });

      return `
        <g class="sw-svg-chassis" data-host-id="${escapeHtml(host.id)}" style="cursor: pointer;">
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"
                fill="var(--color-surface-elevated)" stroke="var(--color-border)" stroke-width="1.5" />
          <circle cx="${x + 16}" cy="${y + 18}" r="4.5" fill="${host.status === 'online' ? 'var(--color-success)' : 'var(--color-danger)'}" />
          <text x="${x + 27}" y="${y + 21}" font-size="12.5" font-weight="700" fill="var(--color-text-primary)">
            ${escapeHtml(truncateText(hostName, 32))}
          </text>
          <text x="${x + 27}" y="${y + 35}" font-size="10" fill="var(--color-text-muted)" font-family="var(--font-mono)">
            ${escapeHtml(host.ip || '')} • ${escapeHtml(truncateText(uplinkBadge, 64))}
          </text>
          ${portsSvg}
        </g>
      `;
    };

    let chassisSvg = '';
    let dumbSwNodesSvg = '';
    let dumbSwCablesSvg = '';
    let currentY = 18;

    const renderDumbSwitchItem = (item, bx, by) => {
      const { host, port, coord, usw, metrics } = item;
      const boxW = item.w;
      const boxH = item.h;
      const {
        cols,
        colW,
        headerH,
        rowH,
        titleText,
        subText,
        deviceEntries,
      } = metrics || measureDumbSwitchBox(host, port, usw);

      const devNames = deviceEntries.map((e) => e.label).join(', ');
      const bCenterX = bx + boxW / 2;
      const swCoord = {
        x: bx,
        y: by,
        centerX: bCenterX,
        topY: by,
        bottomY: by + boxH,
        host,
        port,
        usw,
      };
      dumbSwitchCoords.set(`${host.id}:${port.iface}`, swCoord);
      if (port.switchPort) {
        dumbSwitchCoords.set(`${host.id}:${port.switchPort}`, swCoord);
      }

      const x1 = coord.x;
      const y1 = coord.bottomY;
      const x2 = bCenterX;
      const y2 = by;
      const midY = (y1 + y2) / 2;

      dumbSwCablesSvg += `
        <g class="sw-svg-dumb-cable">
          <path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}"
                fill="none" stroke="var(--color-warning)" stroke-width="2" stroke-dasharray="5,3" opacity="0.9" />
          <circle cx="${x1}" cy="${y1}" r="3.5" fill="var(--color-warning)" />
          <circle cx="${x2}" cy="${y2}" r="3.5" fill="var(--color-warning)" />
        </g>
      `;

      let hostsListSvg = '';
      deviceEntries.forEach((entry, idx) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const itemX = bx + 14 + c * (colW + 14);
        const itemY = by + headerH + 14 + r * rowH;
        const dotColor = entry.isInfra ? 'var(--color-primary)' : 'var(--color-warning)';
        const textColor = entry.isInfra ? 'var(--color-primary)' : 'var(--color-text-secondary)';
        hostsListSvg += `
          <g class="sw-svg-dumb-host"
             data-host-id="${escapeHtml(entry.device?.id || '')}"
             data-client-mac="${escapeHtml(entry.device?.mac || '')}"
             style="cursor: pointer;">
            <circle cx="${itemX}" cy="${itemY - 3.5}" r="3" fill="${dotColor}" />
            <text x="${itemX + 8}" y="${itemY}" font-size="9.5" font-weight="${entry.isInfra ? '700' : '500'}"
                  fill="${textColor}" font-family="var(--font-mono)">
              ${escapeHtml(entry.label)}
            </text>
          </g>
        `;
      });

      dumbSwNodesSvg += `
        <g class="sw-svg-dumb-switch" data-host-id="${escapeHtml(host.id)}" style="cursor: pointer;">
          <title>${escapeHtml(`${usw.name} on ${host.name || host.hostname} (${port.portLabel || port.iface}) — ${usw.deviceCount} hosts: ${devNames}`)}</title>
          <rect x="${bx}" y="${by}" width="${boxW}" height="${boxH}" rx="8"
                fill="var(--color-surface-elevated)" stroke="var(--color-warning)" stroke-width="1.8" stroke-dasharray="5,3" />
          <circle cx="${bx + 14}" cy="${by + 16}" r="4" fill="var(--color-warning)" />
          <text x="${bx + 24}" y="${by + 19}" font-size="11" font-weight="700" fill="var(--color-text-primary)">
            ${escapeHtml(titleText)}
          </text>
          <text x="${bx + 14}" y="${by + 33}" font-size="9.5" font-weight="600" fill="var(--color-warning)" font-family="var(--font-mono)">
            ${escapeHtml(subText)}
          </text>
          <line x1="${bx + 10}" y1="${by + headerH}" x2="${bx + boxW - 10}" y2="${by + headerH}"
                stroke="var(--color-border-subtle)" stroke-width="1" />
          ${hostsListSvg}
        </g>
      `;
    };

    const collectDumbSwitchItemsForSpecs = (specs) => {
      const items = [];
      specs.forEach((spec) => {
        spec.ports.forEach((p, pIdx) => {
          if (p.hasUnmanagedSwitch) {
            const coord = portJackCoords.get(`${spec.host.id}:${p.iface}`);
            if (coord) {
              const usw = p.unmanagedSwitch || {
                id: `unmanaged-switch-${spec.host.id}-${p.iface}`,
                name: `Unmanaged Switch (${p.switchPort || p.iface})`,
                deviceCount: Array.isArray(p.connectedDevices) ? p.connectedDevices.length : 2,
                devices: p.connectedDevices || [],
              };
              const metrics = measureDumbSwitchBox(spec.host, p, usw);
              items.push({
                kind: 'dumb_switch',
                w: metrics.w,
                h: metrics.h,
                metrics,
                targetX: coord.x,
                targetRow: coord.row ?? 0,
                orderIdx: pIdx,
                host: spec.host,
                port: p,
                coord,
                usw,
              });
            }
          }
        });
      });
      return items;
    };

    const renderMixedRow = (rowItems, tierIdx) => {
      if (rowItems.length === 0) return;
      const placements = resolveHorizontalRow(rowItems, hostGapX, 28);
      let maxH = 0;
      placements.forEach(({ item, x }) => {
        if (item.kind === 'dumb_switch') {
          renderDumbSwitchItem(item, x, currentY);
        } else {
          chassisSvg += renderChassisSvg(item.spec, x, currentY, tierIdx);
        }
        if (item.h > maxH) maxH = item.h;
      });
      currentY += maxH + tierGapY;
    };

    // Tier 0: Gateway centered at top
    chassisSvg += renderChassisSvg(gwSpec, centerX - gwSpec.w / 2, currentY, 0);
    currentY += gwSpec.h + tierGapY;

    let tierCounter = 1;

    // Tier 1 (if Core Managed Switches exist): Core Switches + any Dumb Switches attached directly to Gateway
    if (switchSpecs.length > 0) {
      const gwDumbItems = collectDumbSwitchItemsForSpecs([gwSpec]);
      const switchRowItems = [
        ...switchSpecs.map((spec, idx) => {
          const { srcCoord } = findUpstreamCoordForHost(spec.host);
          return {
            kind: 'chassis',
            spec,
            w: spec.w,
            h: spec.h,
            targetX: srcCoord ? srcCoord.x : centerX,
            targetRow: srcCoord ? srcCoord.row : 0,
            orderIdx: idx,
          };
        }),
        ...gwDumbItems,
      ];
      renderMixedRow(switchRowItems, tierCounter++);
    }

    // Collect Dumb Switches from the active switch layer (Core Switches if present, otherwise Gateway)
    const upstreamSwitchLayerSpecs = switchSpecs.length > 0 ? switchSpecs : [gwSpec];
    const midDumbItems = collectDumbSwitchItemsForSpecs(upstreamSwitchLayerSpecs);

    // Separate APs into:
    //  - Direct APs (connected to a port WITHOUT a dumb switch) -> placed in the same tier as midDumbItems, sorted by parent port X
    //  - Downstream APs (connected via a port WITH a dumb switch) -> placed in the sub-tier directly below that dumb switch
    const directApItems = [];
    const behindDumbSwApSpecs = [];
    apSpecs.forEach((spec, idx) => {
      const { srcCoord } = findUpstreamCoordForHost(spec.host);
      if (srcCoord?.port?.hasUnmanagedSwitch) {
        behindDumbSwApSpecs.push({ spec, idx });
      } else {
        directApItems.push({
          kind: 'chassis',
          spec,
          w: spec.w,
          h: spec.h,
          targetX: srcCoord ? srcCoord.x : centerX,
          targetRow: srcCoord ? srcCoord.row : 0,
          orderIdx: 100 + idx,
        });
      }
    });

    if (midDumbItems.length > 0 || directApItems.length > 0) {
      renderMixedRow([...midDumbItems, ...directApItems], tierCounter++);
    }

    if (behindDumbSwApSpecs.length > 0) {
      const subApItems = behindDumbSwApSpecs.map(({ spec, idx }) => {
        const { parentId, srcCoord } = findUpstreamCoordForHost(spec.host);
        const dumbSw =
          srcCoord?.port &&
          (dumbSwitchCoords.get(`${parentId}:${srcCoord.port.iface}`) ||
            dumbSwitchCoords.get(`${parentId}:${srcCoord.port.switchPort}`));
        return {
          kind: 'chassis',
          spec,
          w: spec.w,
          h: spec.h,
          targetX: dumbSw ? dumbSw.centerX : srcCoord ? srcCoord.x : centerX,
          targetRow: 0,
          orderIdx: idx,
        };
      });
      renderMixedRow(subApItems, tierCounter++);
    }

    // Finally, if any rendered Access Point itself has a port with a detected Dumb Switch, render it below the AP tier
    const apDumbItems = collectDumbSwitchItemsForSpecs(apSpecs);
    if (apDumbItems.length > 0) {
      renderMixedRow(apDumbItems, tierCounter++);
    }

    const svgH = Math.max(195, currentY - tierGapY + 22);

    // Render SVG Patch Cables between OpenWrt Hosts' NIC Ports (with pill collision avoidance)
    let cablesSvg = dumbSwCablesSvg;
    const placedPills = [];

    const evalCubicBezier = (v0, v1, v2, v3, t) => {
      const u = 1 - t;
      return (
        u * u * u * v0 +
        3 * u * u * t * v1 +
        3 * u * t * t * v2 +
        t * t * t * v3
      );
    };

    nonGwHosts.forEach((secHost) => {
      const nic = secHost.nicInfo || {};
      const { parentId, srcCoord } = findUpstreamCoordForHost(secHost);

      const tgtCoord =
        (nic.localIface && portJackCoords.get(`${secHost.id}:${nic.localIface}`)) ||
        (nic.localPort && portJackCoords.get(`${secHost.id}:${nic.localPort}`)) ||
        Array.from(portJackCoords.values()).find(
          (c) => c.host.id === secHost.id && (c.port.linkUp ?? c.port.status === 'up')
        ) ||
        Array.from(portJackCoords.values()).find((c) => c.host.id === secHost.id);

      if (!srcCoord || !tgtCoord) return;

      // If this host connects through a rendered Dumb Switch node, route the patch cable from the Dumb Switch to the host
      const viaDumbNode =
        srcCoord.port?.hasUnmanagedSwitch &&
        (dumbSwitchCoords.get(`${parentId}:${srcCoord.port.iface}`) ||
          dumbSwitchCoords.get(`${parentId}:${srcCoord.port.switchPort}`));

      const x1 = viaDumbNode ? viaDumbNode.centerX : srcCoord.x;
      const y1 = viaDumbNode ? viaDumbNode.bottomY : srcCoord.bottomY;
      const x2 = tgtCoord.x;
      const y2 = tgtCoord.topY;
      const midY = (y1 + y2) / 2;

      const spd = nic.upstreamSpeedMbps || nic.localSpeedMbps || srcCoord.port?.speedMbps || 1000;
      const maxCap = Math.max(
        nic.upstreamMaxSpeedMbps || 0,
        nic.localMaxSpeedMbps || 0,
        srcCoord.port ? getPortMaxSpeedMbps(srcCoord.port) : 0,
        tgtCoord.port ? getPortMaxSpeedMbps(tgtCoord.port) : 0
      );
      const spdLabel =
        maxCap > spd
          ? `${formatSpeedShort(spd)} / ${formatSpeedShort(maxCap)} max`
          : formatSpeedShort(spd) || '1G';
      const strokeColor = spd >= 10000 ? '#a855f7' : spd >= 2500 ? '#06b6d4' : spd >= 1000 ? 'var(--color-success)' : 'var(--color-warning)';
      const isMesh = secHost.role === 'mesh' || nic.upstreamIface === 'mesh0';

      const srcPortText = viaDumbNode
        ? `Dumb SW (${srcCoord.port?.switchPort || srcCoord.port?.iface || 'LAN'})`
        : srcCoord.port?.iface || nic.upstreamPort || 'LAN';
      const tgtPortText = tgtCoord.port?.iface || nic.localPort || 'LAN';
      const cableLabel = `${srcPortText} ⟷ ${tgtPortText} (${spdLabel})`;
      const pillW = Math.max(96, cableLabel.length * 6.2);
      const pillH = 18;

      // Choose a parameter t along the cubic Bezier curve so the label pill never overlaps an existing pill
      const candidateTs = [0.5, 0.34, 0.66, 0.24, 0.76];
      let chosenX = (x1 + x2) / 2;
      let chosenY = midY;
      for (const t of candidateTs) {
        const cx = evalCubicBezier(x1, x1, x2, x2, t);
        const cy = evalCubicBezier(y1, midY, midY, y2, t);
        const collides = placedPills.some(
          (p) =>
            Math.abs(cy - p.y) < pillH + 3 &&
            Math.abs(cx - p.x) < (pillW + p.w) / 2 + 6
        );
        if (!collides) {
          chosenX = cx;
          chosenY = cy;
          break;
        }
      }
      placedPills.push({ x: chosenX, y: chosenY, w: pillW, h: pillH });

      cablesSvg += `
        <g class="sw-svg-cable">
          <path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}"
                fill="none" stroke="${strokeColor}" stroke-width="2.5"
                ${isMesh ? 'stroke-dasharray="5,4"' : ''} opacity="0.88" />
          <circle cx="${x1}" cy="${y1}" r="4" fill="${strokeColor}" />
          <circle cx="${x2}" cy="${y2}" r="4" fill="${strokeColor}" />
          <rect x="${chosenX - pillW / 2}" y="${chosenY - 10}" width="${pillW}" height="${pillH}" rx="9"
                fill="var(--color-surface-elevated)" stroke="${strokeColor}" stroke-width="1.2" />
          <text x="${chosenX}" y="${chosenY + 2}" font-size="9.5" font-weight="700" fill="var(--color-text-primary)" text-anchor="middle" font-family="var(--font-mono)">
            ${escapeHtml(cableLabel)}
          </text>
        </g>
      `;
    });

    svgWrap.innerHTML = `
      <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="min-width: 680px; display: block;" role="img" aria-label="Physical NIC and Switch Port Wiring Diagram">
        <g class="sw-cables-layer">${cablesSvg}</g>
        <g class="sw-chassis-layer">${chassisSvg}${dumbSwNodesSvg}</g>
      </svg>
    `;

    svgWrap.querySelectorAll('.sw-svg-chassis, .sw-svg-dumb-switch').forEach((el) => {
      el.addEventListener('click', () => {
        const hostId = el.getAttribute('data-host-id');
        const host = this.hosts.find((h) => h.id === hostId);
        if (host && this.onHostClick) this.onHostClick(host);
      });
    });

    svgWrap.querySelectorAll('.sw-svg-dumb-host').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const hostId = el.getAttribute('data-host-id');
        const mac = el.getAttribute('data-client-mac');
        if (hostId && hostId !== 'wan-internet') {
          const foundHost = this.hosts.find((h) => h.id === hostId);
          if (foundHost && this.onHostClick) {
            this.onHostClick(foundHost);
            return;
          }
        }
        if (mac) {
          const foundClient = this.clients.find(
            (c) => (c.mac || '').toLowerCase() === mac.toLowerCase()
          );
          if (foundClient && this.onClientClick) this.onClientClick(foundClient);
        }
      });
    });
  }

  renderChassisCards(chassisGrid) {
    chassisGrid.innerHTML = this.hosts
      .map((host) => {
        const ports = this.normalizeHostPorts(host);
        const isMultiPortSwitch = ports.length >= 8;
        const activeCount = ports.filter((p) => p.linkUp ?? p.status === 'up').length;
        const dumbSwitchCount = ports.filter((p) => p.hasUnmanagedSwitch).length;
        const nic = host.nicInfo || {};
        const nicBanner =
          host.role === 'gateway'
            ? `WAN NIC: <strong>${escapeHtml(nic.wanPortLabel || nic.localPortLabel || 'WAN (eth0)')}</strong>`
            : `Host Uplink NIC: <strong>${escapeHtml(nic.localPortLabel || 'LAN 1 (lan1)')}</strong>${
                nic.upstreamHostName
                  ? ` ⟷ <strong>${escapeHtml(nic.upstreamHostName)}</strong> (${escapeHtml(nic.upstreamPortLabel || nic.upstreamPort || 'Switch Port')})`
                  : ''
              }`;

        // Render a visual 2-row hardware RJ45/SFP+ switch faceplate strip for 8/16/24/28/48-port switches
        const faceplateCols = Math.ceil(ports.length / 2);
        const faceplateHtml = isMultiPortSwitch
          ? `
            <div class="sw-faceplate-strip" style="background: var(--color-bg-primary); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-sm); padding: 10px; overflow-x: auto;">
              <div style="font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-muted); margin-bottom: 6px; display: flex; justify-content: space-between;">
                <span>Hardware Switch Faceplate (${ports.length} Ports)</span>
                <span>${activeCount} Active / ${ports.length - activeCount} Down${dumbSwitchCount > 0 ? ` • ${dumbSwitchCount} Dumb Switch${dumbSwitchCount > 1 ? 'es' : ''}` : ''}</span>
              </div>
              <div style="display: grid; grid-template-columns: repeat(${faceplateCols}, minmax(44px, 1fr)); gap: 5px;">
                ${ports
                  .map((p, idx) => {
                    const isUp = p.linkUp ?? p.status === 'up';
                    const isDumbSw = Boolean(p.hasUnmanagedSwitch);
                    const spdColor = getPortSpeedColor(p);
                    const spdShort = getPortSpeedShort(p);
                    const spdDetail = getPortSpeedDetail(p);
                    const isSfp = /^sfp/i.test(p.switchPort || '') || /^(sfp|te|xg|opt)/i.test(p.iface || '');
                    const shortNum = p.portNumber ?? idx + 1;
                    const devCount = Array.isArray(p.connectedDevices) ? p.connectedDevices.length : 0;
                    const titleText = `${p.portLabel || p.iface} [${spdDetail}]${
                      isDumbSw ? ` • Unmanaged (Dumb) Switch (${devCount} hosts)` : ''
                    }${
                      devCount > 0 ? ' — ' + p.connectedDevices.map((d) => d.hostname || d.ip || d.mac).join(', ') : ''
                    }`;
                    return `
                      <div title="${escapeHtml(titleText)}"
                           style="background: var(--color-surface); border: 1.5px solid ${isDumbSw ? 'var(--color-warning)' : isUp ? spdColor : 'var(--color-border)'}; border-radius: ${isSfp ? '3px' : '5px'}; padding: 4px 3px; display: flex; flex-direction: column; align-items: center; gap: 2px; opacity: ${isUp ? '1' : '0.62'};">
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0 2px;">
                          <span style="width: 5px; height: 5px; border-radius: 50%; background: ${spdColor};"></span>
                          <span class="font-mono" style="font-size: 8.5px; font-weight: 700; color: ${spdColor};">${escapeHtml(spdShort)}</span>
                        </div>
                        <span class="font-mono" style="font-size: 10px; font-weight: 700; color: var(--color-text-primary);">
                          ${isSfp ? `SFP${shortNum}` : shortNum}
                        </span>
                        <span style="font-size: 8px; color: ${isDumbSw ? 'var(--color-warning)' : devCount > 0 ? 'var(--color-primary)' : 'var(--color-text-muted)'}; font-weight: 700;">
                          ${isDumbSw ? `SW(${devCount})` : devCount > 0 ? `${devCount} dev` : isUp ? 'UP' : '—'}
                        </span>
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            </div>
          `
          : '';

        return `
          <div class="sw-host-chassis-card" data-host-id="${escapeHtml(host.id)}"
               style="${isMultiPortSwitch ? 'grid-column: 1 / -1;' : ''} background: var(--color-surface-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <div>
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <span class="status-dot ${host.status === 'online' ? 'online' : 'offline'}"></span>
                  <span style="font-weight: 700; font-size: 13.5px;">${escapeHtml(host.name || host.hostname || host.id)}</span>
                  <span class="font-mono" style="font-size: 11px; color: var(--color-text-muted);">${escapeHtml(host.ip || '')}</span>
                  ${host.model ? `<span style="font-size: 11px; color: var(--color-text-muted);">• ${escapeHtml(host.model)}</span>` : ''}
                </div>
                <div style="font-size: 11.5px; color: var(--color-text-secondary); margin-top: 3px;">
                  🔌 ${nicBanner}
                </div>
              </div>
              <div style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                ${dumbSwitchCount > 0 ? `
                  <span style="font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(245, 158, 11, 0.16); color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.35);">
                    🔀 ${dumbSwitchCount} Dumb Switch${dumbSwitchCount > 1 ? 'es' : ''} Detected
                  </span>
                ` : ''}
                <span class="status-pill ${activeCount > 0 ? 'online' : ''}" style="font-size: 11px;">
                  ${activeCount}/${ports.length} NICs Up
                </span>
              </div>
            </div>

            ${faceplateHtml}

            <!-- Port Rows / Multi-Column Port Matrix -->
            <div style="${
              isMultiPortSwitch
                ? 'display: grid; grid-template-columns: repeat(auto-fill, minmax(225px, 1fr)); gap: 6px;'
                : 'display: flex; flex-direction: column; gap: 6px;'
            }">
              ${ports
                .map((p) => {
                  const isUp = p.linkUp ?? p.status === 'up';
                  const isDumbSw = Boolean(p.hasUnmanagedSwitch);
                  const spdColor = getPortSpeedColor(p);
                  const curSpd = Number(p.speedMbps) || 0;
                  const maxSpd = getPortMaxSpeedMbps(p);
                  const curLabel = isUp ? formatSpeedShort(curSpd) || 'UP' : 'DOWN';
                  const maxLabel = formatSpeedShort(maxSpd);
                  const isSuboptimal = isPortSpeedSuboptimal(p);
                  const roleMeta = getPortRoleMeta(p);
                  const devices = Array.isArray(p.connectedDevices) ? p.connectedDevices : [];

                  return `
                    <div style="background: var(--color-surface); border: 1px solid ${isDumbSw ? 'rgba(245, 158, 11, 0.4)' : 'var(--color-border-subtle)'}; border-left: 3px solid ${isDumbSw ? 'var(--color-warning)' : spdColor}; border-radius: 6px; padding: 7px 10px; display: flex; flex-direction: column; gap: 4px;">
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
                        <div style="display: inline-flex; align-items: center; gap: 6px;">
                          <span style="font-weight: 700; font-size: 12px;">${escapeHtml(p.switchPort || p.iface)}</span>
                          <span class="font-mono" style="font-size: 11px; color: var(--color-text-muted);">(${escapeHtml(p.iface)})</span>
                          <span style="font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: ${roleMeta.bg}; color: ${roleMeta.fg};">
                            ${escapeHtml(roleMeta.label)}
                          </span>
                        </div>
                        <div style="display: inline-flex; align-items: center; gap: 5px;">
                          <span class="font-mono" style="font-size: 11px; font-weight: 700; color: ${spdColor};">
                            ${escapeHtml(curLabel)}${isUp && p.duplex ? ` • ${escapeHtml(String(p.duplex).toUpperCase())}` : ''}
                          </span>
                          ${
                            isSuboptimal
                              ? `<span class="font-mono" title="Port hardware is capable of ${escapeHtml(maxLabel)} (${maxSpd} Mbps), currently negotiated at ${escapeHtml(curLabel)} (${curSpd} Mbps)" style="font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(245, 158, 11, 0.16); color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.35);">
                                  Capable: ${escapeHtml(maxLabel)}
                                </span>`
                              : !isUp && maxLabel
                                ? `<span class="font-mono" style="font-size: 9.5px; color: var(--color-text-muted);">(${escapeHtml(maxLabel)} max)</span>`
                                : ''
                          }
                        </div>
                      </div>
                      ${
                        isDumbSw
                          ? `<div style="font-size: 10.5px; font-weight: 600; color: var(--color-warning); background: rgba(245, 158, 11, 0.1); border-radius: 4px; padding: 3px 6px;">
                              🔀 Unmanaged (Dumb) Switch • ${devices.length} hosts on this port
                            </div>`
                          : ''
                      }
                      ${
                        devices.length > 0
                          ? `
                        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px;">
                          ${devices
                            .map((d) => {
                              const isInfra = d.type === 'ap' || d.type === 'gateway' || d.type === 'switch' || d.type === 'mesh' || d.type === 'wan';
                              return `
                                <button type="button" class="sw-device-chip"
                                        data-device-type="${escapeHtml(d.type || 'client')}"
                                        data-host-id="${escapeHtml(d.id || '')}"
                                        data-client-mac="${escapeHtml(d.mac || '')}"
                                        style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: ${isInfra ? 'var(--color-primary-light)' : 'var(--color-surface-elevated)'}; color: ${isInfra ? 'var(--color-primary)' : 'var(--color-text-primary)'}; border: 1px solid var(--color-border);">
                                  <span>${isInfra ? '📡' : '🔌'}</span>
                                  <strong>${escapeHtml(d.hostname || d.ip || d.mac)}</strong>
                                  ${d.remotePortLabel || d.remoteIface ? `<span class="font-mono" style="font-size: 10px; opacity: 0.85;">[NIC: ${escapeHtml(d.remotePortLabel || d.remoteIface)}]</span>` : ''}
                                  ${d.ip && d.ip !== '0.0.0.0' ? `<span class="font-mono" style="font-size: 10px; color: var(--color-text-muted);">${escapeHtml(d.ip)}</span>` : ''}
                                </button>
                              `;
                            })
                            .join('')}
                        </div>
                      `
                          : `
                        <div style="font-size: 11px; color: var(--color-text-muted);">
                          ${isUp ? 'Carrier active — no leaf MACs pinned' : 'No carrier detected'}
                        </div>
                      `
                      }
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    chassisGrid.querySelectorAll('.sw-device-chip').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hostId = btn.getAttribute('data-host-id');
        const mac = btn.getAttribute('data-client-mac');
        if (hostId && hostId !== 'wan-internet') {
          const foundHost = this.hosts.find((h) => h.id === hostId);
          if (foundHost && this.onHostClick) this.onHostClick(foundHost);
        } else if (mac) {
          const foundClient = this.clients.find((c) => (c.mac || '').toLowerCase() === mac.toLowerCase());
          if (foundClient && this.onClientClick) this.onClientClick(foundClient);
        }
      });
    });
  }
}
