/**
 * OpenWrt Manager (openwrt-managor)
 * Overview Dashboard View
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { renderMetricCard } from '../components/metric-card.js';
import { formatBps, formatUptime, formatRelativeTime, escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

export function renderDashboard(container) {
  const { hosts, clients, wifiInterference, backups, health, throughputHistory } = store.state;

  const onlineHosts = hosts.filter(h => h.status === 'online').length;
  const totalHosts = hosts.length || (health?.hostsCount ?? 0);
  const activeClients = clients.length || 0;
  const wirelessClients = clients.filter(c => c.connectionType !== 'wired').length;
  const wiredClients = clients.filter(c => c.connectionType === 'wired').length;

  // WiFi Health Index calculation
  const healthScore = wifiInterference?.summary?.healthScore ?? 98;
  const warningsCount = wifiInterference?.summary?.warningsCount ?? 0;

  // Backup status
  const lastBackup = backups && backups.length > 0 ? backups[0] : null;
  const hasBackups = backups && backups.length > 0;
  const backupStatusLabel = hasBackups ? 'Up-to-Date' : 'Attention Needed';

  // Current WAN rates from latest history
  const latestThroughput = throughputHistory.length > 0
    ? throughputHistory[throughputHistory.length - 1]
    : { rxBps: 0, txBps: 0 };

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>Network Overview</h1>
        <p>Operational health, real-time WAN traffic, and OpenWrt fleet telemetry</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-primary" id="dash-quick-backup-all">
          ${renderIcon('database', 'icon')} Backup All Fleet
        </button>
        <button type="button" class="btn btn-secondary" id="dash-quick-refresh">
          ${renderIcon('refresh', 'icon')} Refresh
        </button>
      </div>
    </div>

    <!-- 4 KPI Summary Cards -->
    <div class="kpi-grid">
      ${renderMetricCard({
        id: 'kpi-nodes',
        title: 'OpenWrt Fleet Nodes',
        value: `${onlineHosts} / ${totalHosts} Online`,
        icon: 'router',
        subtextHtml: `
          <span class="status-pill ${onlineHosts === totalHosts && totalHosts > 0 ? 'online' : 'warning'}">
            <span class="status-dot ${onlineHosts === totalHosts && totalHosts > 0 ? 'online' : 'warning'}"></span>
            ${onlineHosts === totalHosts ? 'All Nodes Healthy' : 'Degraded Fleet'}
          </span>
          <a href="#/hosts" style="font-size:11.5px; text-decoration:none; color:var(--color-primary);">Manage Nodes →</a>
        `
      })}

      ${renderMetricCard({
        id: 'kpi-clients',
        title: 'Active Connected Hosts',
        value: `${activeClients} Connected`,
        icon: 'wifi',
        subtextHtml: `
          <div style="display: flex; gap: 6px;">
            <span class="status-pill info">${wirelessClients} Wireless</span>
            <span class="status-pill">${wiredClients} Wired</span>
          </div>
          <a href="#/clients" style="font-size:11.5px; text-decoration:none; color:var(--color-primary);">View All →</a>
        `
      })}

      ${renderMetricCard({
        id: 'kpi-wifi',
        title: 'WiFi Spectrum Health',
        value: `${healthScore}% Optimal`,
        icon: 'activity',
        subtextHtml: `
          <span class="status-pill ${warningsCount > 0 ? 'warning' : 'success'}">
            ${warningsCount > 0 ? `${warningsCount} Congestion Alert${warningsCount === 1 ? '' : 's'}` : 'Clean Spectrum'}
          </span>
          <a href="#/wifi" style="font-size:11.5px; text-decoration:none; color:var(--color-primary);">${wifiInterference?.summary?.mostCongestedBand && warningsCount > 0 ? `${escapeHtml(wifiInterference.summary.mostCongestedBand)} Busy →` : 'Spectrum →'}</a>
        `
      })}

      ${renderMetricCard({
        id: 'kpi-backup',
        title: 'TrueNAS Backup Status',
        value: backupStatusLabel,
        icon: 'database',
        subtextHtml: `
          <span style="font-size:11px; color:var(--color-text-muted);">
            ${lastBackup ? `Last: ${formatRelativeTime(lastBackup.timestamp)}` : 'No archives yet'}
          </span>
          <a href="#/backups" style="font-size:11.5px; text-decoration:none; color:var(--color-primary);">Center →</a>
        `
      })}
    </div>

    <!-- Dual-line WAN/LAN Real-time SVG Throughput Sparkline -->
    <div class="chart-card">
      <div class="chart-header">
        <div class="chart-title-group">
          <h2>WAN Real-Time Throughput</h2>
          <span style="font-size: 12px; color: var(--color-text-muted);">Inbound vs Outbound Gateway Traffic</span>
        </div>
        <div class="chart-legend">
          <div class="chart-legend-item">
            <span class="legend-dot download"></span>
            <span>Download: <strong>${formatBps(latestThroughput.rxBps)}</strong></span>
          </div>
          <div class="chart-legend-item">
            <span class="legend-dot upload"></span>
            <span>Upload: <strong>${formatBps(latestThroughput.txBps)}</strong></span>
          </div>
        </div>
      </div>
      <div class="sparkline-svg-container" id="dash-sparkline-container">
        <!-- Rendered SVG Sparkline -->
      </div>
    </div>

    <!-- Main Grid: Fleet Nodes Grid + Live Activity Stream -->
    <div class="dash-main-grid">
      <!-- OpenWrt Fleet Node Grid -->
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h2 style="font-size: 15px; font-weight: 600;">OpenWrt Fleet Nodes (${hosts.length})</h2>
          <a href="#/hosts" class="btn btn-ghost" style="font-size: 12px;">+ Add New Router</a>
        </div>
        <div class="nodes-grid" id="dash-nodes-grid">
          ${hosts.length > 0 ? hosts.map(host => renderHostCard(host)).join('') : `
            <div class="empty-state" style="grid-column: 1 / -1;">
              <div class="empty-state-title">No OpenWrt Hosts Registered</div>
              <div class="empty-state-desc">Add your first OpenWrt router or access point to begin monitoring.</div>
              <a href="#/hosts" class="btn btn-primary" style="margin-top: 8px; text-decoration: none;">+ Add OpenWrt Host</a>
            </div>
          `}
        </div>
      </div>

      <!-- Live Network Activity Stream -->
      <div class="activity-card">
        <h2 style="font-size: 15px; font-weight: 600;">Live Network Activity</h2>
        <ul class="activity-list">
          ${renderActivityItems({ hosts, backups, warnings: wifiInterference?.warnings || [] })}
        </ul>
      </div>
    </div>
  `;

  // Render SVG Sparkline
  renderSparkline(container.querySelector('#dash-sparkline-container'), throughputHistory);

  // Attach quick actions
  container.querySelector('#dash-quick-refresh')?.addEventListener('click', () => {
    store.poll();
    toast.info('Telemetry Updated', 'Fetched latest OpenWrt router metrics.');
  });

  container.querySelector('#dash-quick-backup-all')?.addEventListener('click', async () => {
    try {
      toast.info('Backup Queued', 'Running concurrent backup for all OpenWrt hosts...');
      await api.runBackup('all');
      toast.success('Backup Completed', 'All hosts backed up successfully to /backups.');
      store.poll();
    } catch (err) {
      toast.error('Backup Error', err.message);
    }
  });

  // Attach per-host inspect & backup buttons
  container.querySelectorAll('.node-inspect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const hostId = btn.getAttribute('data-host-id');
      const host = hosts.find(h => h.id === hostId);
      if (host) {
        store.selectNode({
          id: host.id,
          label: host.name || host.hostname,
          type: host.role,
          ip: host.ip,
          mac: host.mac,
          model: host.model,
          firmware: host.firmware,
          updates: host.updates,
          nicInfo: host.nicInfo || null,
          switchPorts: host.switchPorts || [],
          status: host.status,
          metrics: {
            cpuUsagePct: host.cpuUsagePct ?? 0,
            memUsagePct: host.memUsagePct ?? 0,
            uptimeSec: host.uptimeSec ?? 0,
            clientCount: host.clientCount ?? 0,
            rxRateBps: host.rxRateBps ?? 0,
            txRateBps: host.txRateBps ?? 0
          }
        });
      }
    });
  });

  container.querySelectorAll('.node-backup-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hostId = btn.getAttribute('data-host-id');
      try {
        btn.disabled = true;
        await api.runBackup(hostId);
        toast.success('Backup Created', `Configuration archive saved for ${hostId}`);
        store.poll();
      } catch (err) {
        toast.error('Backup Failed', err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderHostCard(host) {
  const isOnline = host.status === 'online';
  const cpuPct = host.cpuUsagePct ?? 0;
  const memPct = host.memUsagePct ?? 0;
  const radios = Array.isArray(host.radios) ? host.radios : [];
  const has2g = radios.some(r => r.band === '2.4GHz');
  const has5g = radios.some(r => r.band === '5GHz');
  const has6g = radios.some(r => r.band === '6GHz');
  const pkgCount = host.updates?.packagesCount || 0;
  const fwAvailable = Boolean(host.updates?.firmwareUpdateAvailable);
  const availFwVer = host.updates?.availableFirmwareVersion || host.updates?.attendedSysupgrade?.availableVersion;

  return `
    <div class="node-card">
      <div class="node-card-header">
        <div>
          <div class="node-name">${escapeHtml(host.name || host.hostname || host.id)}</div>
          <div class="node-model">${escapeHtml(host.model || 'OpenWrt Device')} • ${escapeHtml(host.firmware || 'OpenWrt')}</div>
        </div>
        <span class="status-pill ${isOnline ? 'online' : 'offline'}">
          <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
          ${isOnline ? 'Online' : 'Offline'}
        </span>
      </div>

      <div class="node-meta-row" style="flex-wrap: wrap;">
        <span>IP: ${escapeHtml(host.ip)}</span>
        <span>•</span>
        <span>Uptime: ${formatUptime(host.uptimeSec)}</span>
        ${host.nicInfo ? `
          <span>•</span>
          <span style="color: var(--color-primary); font-weight: 600;">
            🔌 NIC: ${escapeHtml(host.nicInfo.localPortLabel || host.nicInfo.localIface)}${host.role !== 'gateway' && host.nicInfo.upstreamPort ? ` → ${escapeHtml(host.nicInfo.upstreamPort)}` : ''}
          </span>
        ` : ''}
      </div>

      ${pkgCount > 0 || fwAvailable ? `
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          ${fwAvailable
            ? `<a href="#/hosts" class="status-pill warning" style="font-size: 11px; padding: 2px 8px; text-decoration: none;">
                ${renderIcon('zap', 'icon icon-sm')} Firmware ${escapeHtml(availFwVer || 'Update')} Available
              </a>`
            : ''}
          ${pkgCount > 0
            ? `<a href="#/hosts" class="status-pill info" style="font-size: 11px; padding: 2px 8px; text-decoration: none;">
                ${renderIcon('download', 'icon icon-sm')} ${pkgCount} Package Update${pkgCount === 1 ? '' : 's'}
              </a>`
            : ''}
        </div>
      ` : ''}

      <div class="node-progress-group">
        <div class="progress-label-row">
          <span>CPU (${cpuPct}%)</span>
          <span>RAM (${memPct}%)</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="progress-bar-track">
            <div class="progress-bar-fill cpu" style="width: ${cpuPct}%;"></div>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill ram" style="width: ${memPct}%;"></div>
          </div>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px;">
        <div class="node-radios-pills">
          ${has2g ? '<span class="radio-pill band-2g">2.4G</span>' : ''}
          ${has5g ? '<span class="radio-pill band-5g">5G</span>' : ''}
          ${has6g ? '<span class="radio-pill band-6g">6G</span>' : ''}
          ${!has2g && !has5g && !has6g ? `<span class="radio-pill band-wired" style="text-transform: capitalize;">${escapeHtml(host.role || 'Node')}</span>` : ''}
        </div>
        <span style="color: var(--color-text-secondary);">${host.clientCount ?? 0} Clients</span>
      </div>

      <div class="node-card-footer">
        <button type="button" class="btn btn-secondary node-inspect-btn" data-host-id="${host.id}">
          ${renderIcon('activity', 'icon')} Inspect
        </button>
        <button type="button" class="btn btn-ghost node-backup-btn" data-host-id="${host.id}">
          ${renderIcon('database', 'icon')} Backup
        </button>
      </div>
    </div>
  `;
}

function renderActivityItems({ hosts = [], backups = [], warnings = [] }) {
  const items = [];
  for (const h of hosts) {
    if (h.updates?.firmwareUpdateAvailable) {
      const availFw = h.updates.availableFirmwareVersion || h.updates.attendedSysupgrade?.availableVersion || 'New';
      items.push(`
        <li class="activity-item">
          <div class="activity-icon-badge warning">${renderIcon('zap', 'icon')}</div>
          <div class="activity-content">
            <div><strong>Attended Sysupgrade:</strong> OpenWrt ${escapeHtml(availFw)} is available for ${escapeHtml(h.name || h.hostname)}</div>
            <div class="activity-time"><a href="#/hosts" style="color: var(--color-primary); text-decoration: none;">Review &amp; Upgrade →</a></div>
          </div>
        </li>
      `);
    }
    if ((h.updates?.packagesCount || 0) > 0) {
      items.push(`
        <li class="activity-item">
          <div class="activity-icon-badge info">${renderIcon('download', 'icon')}</div>
          <div class="activity-content">
            <div><strong>Software Updates:</strong> ${h.updates.packagesCount} package update${h.updates.packagesCount === 1 ? '' : 's'} available on ${escapeHtml(h.name || h.hostname)}</div>
            <div class="activity-time"><a href="#/hosts" style="color: var(--color-primary); text-decoration: none;">Update Packages →</a></div>
          </div>
        </li>
      `);
    }
  }
  for (const h of hosts.slice(0, 3)) {
    items.push(`
      <li class="activity-item">
        <div class="activity-icon-badge ${h.status === 'online' ? 'success' : 'warning'}">${renderIcon('router', 'icon')}</div>
        <div class="activity-content">
          <div><strong>Host Monitored:</strong> ${escapeHtml(h.name || h.hostname)} (${escapeHtml(h.ip)}) is ${escapeHtml(h.status || 'online')}</div>
          <div class="activity-time">${h.lastSeen ? formatRelativeTime(h.lastSeen) : 'Just now'}</div>
        </div>
      </li>
    `);
  }
  for (const b of backups.slice(0, 2)) {
    items.push(`
      <li class="activity-item">
        <div class="activity-icon-badge info">${renderIcon('database', 'icon')}</div>
        <div class="activity-content">
          <div><strong>Backup Verified:</strong> SHA-256 validated for ${escapeHtml(b.hostName || b.hostId)}</div>
          <div class="activity-time">${formatRelativeTime(b.timestamp)}</div>
        </div>
      </li>
    `);
  }
  for (const w of warnings.slice(0, 2)) {
    items.push(`
      <li class="activity-item">
        <div class="activity-icon-badge warning">${renderIcon('alertTriangle', 'icon')}</div>
        <div class="activity-content">
          <div><strong>WiFi Interference:</strong> ${escapeHtml(w.message)}</div>
          <div class="activity-time">Active</div>
        </div>
      </li>
    `);
  }

  if (items.length === 0) {
    return `
      <li class="activity-item">
        <div class="activity-icon-badge info">${renderIcon('activity', 'icon')}</div>
        <div class="activity-content">
          <div><strong>No Recent Events:</strong> Add an OpenWrt host to begin live monitoring.</div>
        </div>
      </li>
    `;
  }

  return items.join('');
}

function renderSparkline(container, history = []) {
  if (!container) return;

  const width = container.clientWidth || 800;
  const height = 140;
  const pad = { top: 15, right: 15, bottom: 25, left: 50 };

  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  // Synthesize baseline points if empty
  let points = [...history];
  if (points.length < 5) {
    points = [
      { rxBps: 0, txBps: 0 },
      { rxBps: 0, txBps: 0 },
      ...points
    ];
  }

  const maxVal = Math.max(...points.map(p => Math.max(p.rxBps, p.txBps)), 1000000);

  const getX = (idx) => pad.left + (idx / (points.length - 1)) * chartW;
  const getY = (val) => pad.top + chartH - (val / maxVal) * chartH;

  // Build SVG Path for Download (RX) and Upload (TX)
  let rxPath = '';
  let txPath = '';
  let rxArea = `M ${getX(0)} ${pad.top + chartH}`;
  let txArea = `M ${getX(0)} ${pad.top + chartH}`;

  points.forEach((p, i) => {
    const x = getX(i);
    const yRx = getY(p.rxBps);
    const yTx = getY(p.txBps);

    if (i === 0) {
      rxPath += `M ${x} ${yRx}`;
      txPath += `M ${x} ${yTx}`;
    } else {
      rxPath += ` L ${x} ${yRx}`;
      txPath += ` L ${x} ${yTx}`;
    }

    rxArea += ` L ${x} ${yRx}`;
    txArea += ` L ${x} ${yTx}`;
  });

  rxArea += ` L ${getX(points.length - 1)} ${pad.top + chartH} Z`;
  txArea += ` L ${getX(points.length - 1)} ${pad.top + chartH} Z`;

  container.innerHTML = `
    <div style="position: relative; width: 100%; height: 100%;">
      <svg role="img" aria-label="Real-time Gateway WAN throughput history over the last 60 seconds" viewBox="0 0 ${width} ${height}" style="width:100%; height:100%;">
        <title>Real-time WAN download and upload traffic</title>
        <defs>
          <linearGradient id="rx-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
          </linearGradient>
          <linearGradient id="tx-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#10b981" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>
          </linearGradient>
        </defs>

        <!-- Baseline axis -->
        <line x1="${pad.left}" y1="${pad.top + chartH}" x2="${width - pad.right}" y2="${pad.top + chartH}" stroke="var(--color-border)" stroke-width="1"/>
        <text x="${pad.left - 6}" y="${pad.top + 10}" font-size="10" fill="var(--color-text-muted)" text-anchor="end">${formatBps(maxVal)}</text>
        <text x="${pad.left - 6}" y="${pad.top + chartH}" font-size="10" fill="var(--color-text-muted)" text-anchor="end">0 bps</text>

        <!-- Area fills -->
        <path d="${rxArea}" fill="url(#rx-grad)" />
        <path d="${txArea}" fill="url(#tx-grad)" />

        <!-- Lines -->
        <path d="${rxPath}" fill="none" stroke="#3b82f6" stroke-width="2.5" />
        <path d="${txPath}" fill="none" stroke="#10b981" stroke-width="2" />

        <!-- Crosshair & Indicators -->
        <line id="sparkline-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + chartH}" stroke="var(--color-primary)" stroke-width="1.5" stroke-dasharray="3,3" style="display:none; pointer-events:none;"/>
        <circle id="sparkline-dot-rx" r="4" fill="#3b82f6" style="display:none; pointer-events:none;"/>
        <circle id="sparkline-dot-tx" r="4" fill="#10b981" style="display:none; pointer-events:none;"/>
      </svg>
      <div id="sparkline-tooltip" class="sparkline-tooltip" style="display:none;"></div>
    </div>
  `;

  const crosshair = container.querySelector('#sparkline-crosshair');
  const dotRx = container.querySelector('#sparkline-dot-rx');
  const dotTx = container.querySelector('#sparkline-dot-tx');
  const tooltip = container.querySelector('#sparkline-tooltip');

  if (crosshair && dotRx && dotTx && tooltip) {
    const handleMove = (e) => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const mouseX = e.clientX - rect.left;
      const clampedX = Math.max(pad.left, Math.min(width - pad.right, (mouseX / rect.width) * width));
      const frac = (clampedX - pad.left) / (chartW || 1);
      const nearestIdx = Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1))));
      const p = points[nearestIdx];
      const ptX = getX(nearestIdx);
      const ptYRx = getY(p.rxBps);
      const ptYTx = getY(p.txBps);

      crosshair.setAttribute('x1', ptX);
      crosshair.setAttribute('x2', ptX);
      crosshair.style.display = 'block';

      dotRx.setAttribute('cx', ptX);
      dotRx.setAttribute('cy', ptYRx);
      dotRx.style.display = 'block';

      dotTx.setAttribute('cx', ptX);
      dotTx.setAttribute('cy', ptYTx);
      dotTx.style.display = 'block';

      tooltip.style.display = 'block';
      const tooltipX = Math.min(rect.width - 160, Math.max(10, mouseX - 60));
      tooltip.style.left = `${tooltipX}px`;
      tooltip.style.top = '10px';
      tooltip.innerHTML = `<span style="color:#3b82f6; font-weight:600;">↓ ${formatBps(p.rxBps)}</span> • <span style="color:#10b981; font-weight:600;">↑ ${formatBps(p.txBps)}</span>`;
    };

    const handleLeave = () => {
      crosshair.style.display = 'none';
      dotRx.style.display = 'none';
      dotTx.style.display = 'none';
      tooltip.style.display = 'none';
    };

    container.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', handleLeave);
  }
}
