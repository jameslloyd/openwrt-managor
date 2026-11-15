/**
 * OpenWrt Manager (openwrt-managor)
 * Interactive Physical NIC & Switch Port Wiring Diagram
 * Visualizes every OpenWrt host's hardware NIC ports, inter-host trunk/uplink patch cables,
 * negotiated link speeds, and attached wired devices across the fleet.
 */

import { escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

function truncateText(str, maxLen = 18) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

function getPortSpeedColor(port) {
  const isUp = port.linkUp ?? port.status === 'up';
  if (!isUp) return 'var(--color-text-muted)';
  const spd = Number(port.speedMbps) || 1000;
  if (spd >= 10000) return '#a855f7'; // 10G Purple
  if (spd >= 2500) return '#06b6d4'; // 2.5G Cyan
  if (spd >= 1000) return 'var(--color-success)'; // 1G Green
  return 'var(--color-warning)'; // 100M/10M Amber
}

function getPortSpeedShort(port) {
  const isUp = port.linkUp ?? port.status === 'up';
  if (!isUp) return 'DOWN';
  const spd = Number(port.speedMbps) || 0;
  if (spd >= 10000) return `${spd / 1000}G`;
  if (spd >= 1000) return `${spd / 1000}G`;
  if (spd > 0) return `${spd}M`;
  return 'UP';
}

function getPortRoleMeta(port) {
  const isUp = port.linkUp ?? port.status === 'up';
  const role = port.portRole || (isUp ? 'access' : 'down');
  if (role === 'wan') return { label: 'WAN', bg: 'rgba(59, 130, 246, 0.16)', fg: '#3b82f6' };
  if (role === 'uplink') return { label: 'UPLINK', bg: 'rgba(6, 182, 212, 0.16)', fg: '#06b6d4' };
  if (role === 'trunk') return { label: 'TRUNK', bg: 'rgba(168, 85, 247, 0.16)', fg: '#a855f7' };
  if (!isUp || role === 'down') return { label: 'DOWN', bg: 'rgba(100, 116, 139, 0.14)', fg: 'var(--color-text-muted)' };
  if (role === 'access' || (Array.isArray(port.connectedDevices) && port.connectedDevices.length > 0)) {
    return { label: 'ACCESS', bg: 'rgba(16, 185, 129, 0.16)', fg: 'var(--color-success)' };
  }
  return { label: 'ACTIVE', bg: 'rgba(16, 185, 129, 0.12)', fg: 'var(--color-success)' };
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
              Cross-host NIC port mapping, inter-router Ethernet/SFP+ patch links, and attached wired endpoints across all OpenWrt nodes
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
    if (rawPorts.length > 0) {
      if (this.showActiveOnly) {
        const filtered = rawPorts.filter(
          (p) => (p.linkUp ?? p.status === 'up') || (Array.isArray(p.connectedDevices) && p.connectedDevices.length > 0)
        );
        return filtered.length > 0 ? filtered : rawPorts;
      }
      return rawPorts;
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
          <div class="empty-state-desc">Register an OpenWrt router or access point to inspect NIC &amp; switch port wiring.</div>
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
    const secondaryHosts = this.hosts.filter((h) => h.id !== gwHost.id);

    const portBoxW = 74;
    const portBoxH = 54;
    const portGap = 10;
    const chassisPadX = 18;
    const chassisHeaderH = 44;
    const chassisH = chassisHeaderH + portBoxH + 22;

    const getChassisWidth = (portsCount) =>
      Math.max(250, chassisPadX * 2 + Math.max(1, portsCount) * portBoxW + Math.max(0, portsCount - 1) * portGap);

    const gwPorts = this.normalizeHostPorts(gwHost);
    const gwW = getChassisWidth(gwPorts.length);

    const secLayouts = secondaryHosts.map((h) => {
      const ports = this.normalizeHostPorts(h);
      const w = getChassisWidth(ports.length);
      return { host: h, ports, w };
    });

    const secGap = 32;
    const totalSecW =
      secLayouts.reduce((acc, item) => acc + item.w, 0) + Math.max(0, secLayouts.length - 1) * secGap;

    const svgW = Math.max(920, gwW + 80, totalSecW + 80);
    const svgH = secondaryHosts.length > 0 ? 370 : 195;
    const centerX = svgW / 2;

    // Position coordinates of every (hostId, iface/switchPort) jack center so we can draw exact patch cables
    const portJackCoords = new Map(); // `${hostId}:${iface}` and `${hostId}:${switchPort}` -> { x, y, port, host }

    const renderChassisSvg = (host, ports, x, y, w) => {
      const hostName = host.name || host.hostname || host.id;
      const nic = host.nicInfo || {};
      const uplinkBadge =
        host.role === 'gateway'
          ? `WAN NIC: ${nic.wanPortLabel || nic.localPortLabel || 'eth0'}`
          : `On NIC: ${nic.localPortLabel || 'lan1'}${nic.upstreamHostName ? ` → ${nic.upstreamHostName} ${nic.upstreamPort || ''}` : ''}`;

      const totalPortsW = ports.length * portBoxW + Math.max(0, ports.length - 1) * portGap;
      const startPortX = x + (w - totalPortsW) / 2;
      const portY = y + chassisHeaderH;

      let portsSvg = '';
      ports.forEach((p, idx) => {
        const px = startPortX + idx * (portBoxW + portGap);
        const py = portY;
        const jackCenterX = px + portBoxW / 2;
        const jackTopY = py;
        const jackBottomY = py + portBoxH;

        portJackCoords.set(`${host.id}:${p.iface}`, {
          x: jackCenterX,
          topY: jackTopY,
          bottomY: jackBottomY,
          port: p,
          host,
        });
        if (p.switchPort) {
          portJackCoords.set(`${host.id}:${p.switchPort}`, {
            x: jackCenterX,
            topY: jackTopY,
            bottomY: jackBottomY,
            port: p,
            host,
          });
        }

        const color = getPortSpeedColor(p);
        const spdShort = getPortSpeedShort(p);
        const roleMeta = getPortRoleMeta(p);
        const isUp = p.linkUp ?? p.status === 'up';
        const devFirst = Array.isArray(p.connectedDevices) && p.connectedDevices[0] ? p.connectedDevices[0] : null;
        const devLabel = devFirst
          ? truncateText(devFirst.hostname || devFirst.ip || devFirst.mac, 11)
          : isUp
            ? roleMeta.label
            : 'Empty';

        const tooltip = `${hostName} • ${p.portLabel || p.iface} [${spdShort}]${
          Array.isArray(p.connectedDevices) && p.connectedDevices.length > 0
            ? ' — Attached: ' + p.connectedDevices.map((d) => d.hostname || d.ip || d.mac).join(', ')
            : ''
        }`;

        portsSvg += `
          <g class="sw-svg-port" data-host-id="${escapeHtml(host.id)}" data-iface="${escapeHtml(p.iface)}" style="cursor: pointer;">
            <title>${escapeHtml(tooltip)}</title>
            <rect x="${px}" y="${py}" width="${portBoxW}" height="${portBoxH}" rx="6"
                  fill="var(--color-surface)" stroke="${isUp ? color : 'var(--color-border)'}" stroke-width="${isUp ? '1.8' : '1'}" />
            <!-- LED + Speed Row -->
            <circle cx="${px + 10}" cy="${py + 11}" r="3.5" fill="${color}" />
            <text x="${px + portBoxW - 6}" y="${py + 14}" font-size="9" font-weight="700" fill="${color}" text-anchor="end" font-family="var(--font-mono)">
              ${escapeHtml(spdShort)}
            </text>
            <!-- Port Label & Kernel NIC -->
            <text x="${px + portBoxW / 2}" y="${py + 29}" font-size="10.5" font-weight="700" fill="var(--color-text-primary)" text-anchor="middle">
              ${escapeHtml(truncateText(p.switchPort || p.iface, 10))}
            </text>
            <text x="${px + portBoxW / 2}" y="${py + 40}" font-size="8.5" fill="var(--color-text-muted)" text-anchor="middle" font-family="var(--font-mono)">
              ${escapeHtml(truncateText(p.iface, 11))}
            </text>
            <!-- Connected Device / Role Footer -->
            <text x="${px + portBoxW / 2}" y="${py + 50}" font-size="8.5" font-weight="600" fill="${devFirst ? 'var(--color-primary)' : 'var(--color-text-secondary)'}" text-anchor="middle">
              ${escapeHtml(devLabel)}
            </text>
          </g>
        `;
      });

      return `
        <g class="sw-svg-chassis" data-host-id="${escapeHtml(host.id)}" style="cursor: pointer;">
          <rect x="${x}" y="${y}" width="${w}" height="${chassisH}" rx="10"
                fill="var(--color-surface-elevated)" stroke="var(--color-border)" stroke-width="1.5" />
          <circle cx="${x + 16}" cy="${y + 18}" r="4.5" fill="${host.status === 'online' ? 'var(--color-success)' : 'var(--color-danger)'}" />
          <text x="${x + 27}" y="${y + 21}" font-size="12.5" font-weight="700" fill="var(--color-text-primary)">
            ${escapeHtml(truncateText(hostName, 26))}
          </text>
          <text x="${x + 27}" y="${y + 35}" font-size="10" fill="var(--color-text-muted)" font-family="var(--font-mono)">
            ${escapeHtml(host.ip || '')} • ${escapeHtml(truncateText(uplinkBadge, 44))}
          </text>
          ${portsSvg}
        </g>
      `;
    };

    let chassisSvg = '';
    const gwX = centerX - gwW / 2;
    const gwY = 18;
    chassisSvg += renderChassisSvg(gwHost, gwPorts, gwX, gwY, gwW);

    let cursorX = centerX - totalSecW / 2;
    const secY = 230;
    secLayouts.forEach((item) => {
      chassisSvg += renderChassisSvg(item.host, item.ports, cursorX, secY, item.w);
      cursorX += item.w + secGap;
    });

    // Render SVG Patch Cables between OpenWrt Hosts' NIC Ports
    let cablesSvg = '';
    secondaryHosts.forEach((secHost) => {
      const nic = secHost.nicInfo || {};
      const parentId = nic.upstreamHostId || gwHost.id;

      // Locate source port jack on upstream host
      const srcCoord =
        (nic.upstreamIface && portJackCoords.get(`${parentId}:${nic.upstreamIface}`)) ||
        (nic.upstreamPort && portJackCoords.get(`${parentId}:${nic.upstreamPort}`)) ||
        Array.from(portJackCoords.values()).find(
          (c) =>
            c.host.id === parentId &&
            Array.isArray(c.port.connectedDevices) &&
            c.port.connectedDevices.some((d) => d.id === secHost.id)
        ) ||
        Array.from(portJackCoords.values()).find((c) => c.host.id === parentId);

      // Locate target port jack on downstream OpenWrt host
      const tgtCoord =
        (nic.localIface && portJackCoords.get(`${secHost.id}:${nic.localIface}`)) ||
        (nic.localPort && portJackCoords.get(`${secHost.id}:${nic.localPort}`)) ||
        Array.from(portJackCoords.values()).find((c) => c.host.id === secHost.id);

      if (!srcCoord || !tgtCoord) return;

      const x1 = srcCoord.x;
      const y1 = srcCoord.bottomY;
      const x2 = tgtCoord.x;
      const y2 = tgtCoord.topY;
      const midY = (y1 + y2) / 2;
      const midX = (x1 + x2) / 2;

      const spd = nic.upstreamSpeedMbps || nic.localSpeedMbps || srcCoord.port?.speedMbps || 1000;
      const spdLabel = spd >= 1000 ? `${spd / 1000}G` : `${spd}M`;
      const strokeColor = spd >= 10000 ? '#a855f7' : spd >= 2500 ? '#06b6d4' : 'var(--color-success)';
      const isMesh = secHost.role === 'mesh' || nic.upstreamIface === 'mesh0';

      const srcPortText = srcCoord.port?.iface || nic.upstreamPort || 'LAN';
      const tgtPortText = tgtCoord.port?.iface || nic.localPort || 'LAN';
      const cableLabel = `${srcPortText} ⟷ ${tgtPortText} (${spdLabel})`;
      const pillW = Math.max(96, cableLabel.length * 6.2);

      cablesSvg += `
        <g class="sw-svg-cable">
          <path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}"
                fill="none" stroke="${strokeColor}" stroke-width="2.5"
                ${isMesh ? 'stroke-dasharray="5,4"' : ''} opacity="0.88" />
          <circle cx="${x1}" cy="${y1}" r="4" fill="${strokeColor}" />
          <circle cx="${x2}" cy="${y2}" r="4" fill="${strokeColor}" />
          <rect x="${midX - pillW / 2}" y="${midY - 10}" width="${pillW}" height="18" rx="9"
                fill="var(--color-surface-elevated)" stroke="${strokeColor}" stroke-width="1.2" />
          <text x="${midX}" y="${midY + 2}" font-size="9.5" font-weight="700" fill="var(--color-text-primary)" text-anchor="middle" font-family="var(--font-mono)">
            ${escapeHtml(cableLabel)}
          </text>
        </g>
      `;
    });

    svgWrap.innerHTML = `
      <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="min-width: 680px; display: block;" role="img" aria-label="Physical NIC and Switch Port Wiring Diagram">
        <g class="sw-cables-layer">${cablesSvg}</g>
        <g class="sw-chassis-layer">${chassisSvg}</g>
      </svg>
    `;

    svgWrap.querySelectorAll('.sw-svg-chassis').forEach((el) => {
      el.addEventListener('click', () => {
        const hostId = el.getAttribute('data-host-id');
        const host = this.hosts.find((h) => h.id === hostId);
        if (host && this.onHostClick) this.onHostClick(host);
      });
    });
  }

  renderChassisCards(chassisGrid) {
    chassisGrid.innerHTML = this.hosts
      .map((host) => {
        const ports = this.normalizeHostPorts(host);
        const activeCount = ports.filter((p) => p.linkUp ?? p.status === 'up').length;
        const nic = host.nicInfo || {};
        const nicBanner =
          host.role === 'gateway'
            ? `WAN NIC: <strong>${escapeHtml(nic.wanPortLabel || nic.localPortLabel || 'WAN (eth0)')}</strong>`
            : `Host Uplink NIC: <strong>${escapeHtml(nic.localPortLabel || 'LAN 1 (lan1)')}</strong>${
                nic.upstreamHostName
                  ? ` ⟷ <strong>${escapeHtml(nic.upstreamHostName)}</strong> (${escapeHtml(nic.upstreamPortLabel || nic.upstreamPort || 'Switch Port')})`
                  : ''
              }`;

        return `
          <div class="sw-host-chassis-card" data-host-id="${escapeHtml(host.id)}"
               style="background: var(--color-surface-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="status-dot ${host.status === 'online' ? 'online' : 'offline'}"></span>
                  <span style="font-weight: 700; font-size: 13.5px;">${escapeHtml(host.name || host.hostname || host.id)}</span>
                  <span class="font-mono" style="font-size: 11px; color: var(--color-text-muted);">${escapeHtml(host.ip || '')}</span>
                </div>
                <div style="font-size: 11.5px; color: var(--color-text-secondary); margin-top: 3px;">
                  🔌 ${nicBanner}
                </div>
              </div>
              <span class="status-pill ${activeCount > 0 ? 'online' : ''}" style="font-size: 11px;">
                ${activeCount}/${ports.length} NICs Up
              </span>
            </div>

            <!-- Port Rows -->
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${ports
                .map((p) => {
                  const isUp = p.linkUp ?? p.status === 'up';
                  const spdColor = getPortSpeedColor(p);
                  const spdShort = getPortSpeedShort(p);
                  const roleMeta = getPortRoleMeta(p);
                  const devices = Array.isArray(p.connectedDevices) ? p.connectedDevices : [];

                  return `
                    <div style="background: var(--color-surface); border: 1px solid var(--color-border-subtle); border-left: 3px solid ${spdColor}; border-radius: 6px; padding: 7px 10px; display: flex; flex-direction: column; gap: 4px;">
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <div style="display: inline-flex; align-items: center; gap: 6px;">
                          <span style="font-weight: 700; font-size: 12px;">${escapeHtml(p.switchPort || p.iface)}</span>
                          <span class="font-mono" style="font-size: 11px; color: var(--color-text-muted);">(${escapeHtml(p.iface)})</span>
                          <span style="font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: ${roleMeta.bg}; color: ${roleMeta.fg};">
                            ${escapeHtml(roleMeta.label)}
                          </span>
                        </div>
                        <span class="font-mono" style="font-size: 11px; font-weight: 700; color: ${spdColor};">
                          ${escapeHtml(spdShort)}${isUp && p.duplex ? ` • ${escapeHtml(String(p.duplex).toUpperCase())}` : ''}
                        </span>
                      </div>
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
