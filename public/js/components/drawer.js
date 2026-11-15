/**
 * OpenWrt Manager (openwrt-managor)
 * Slide-out Inspector Drawer Controller
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { formatBytes, formatBps, formatUptime, formatRssi, formatSwitchPort, formatMac, escapeHtml, resolveClientSideVendor } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';
import { openHostUpdatesModal } from '../views/hosts.js';

let drawerEl = null;
let backdropEl = null;
let lastDrawerTrigger = null;

export function initDrawer() {
  drawerEl = document.getElementById('inspector-drawer');
  if (!drawerEl) return;

  // Create backdrop if not present
  backdropEl = document.getElementById('drawer-backdrop');
  if (!backdropEl) {
    backdropEl = document.createElement('div');
    backdropEl.id = 'drawer-backdrop';
    backdropEl.className = 'drawer-backdrop';
    backdropEl.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      z-index: calc(var(--z-drawer) - 1); display: none; opacity: 0;
      transition: opacity var(--transition-normal);
    `;
    document.body.appendChild(backdropEl);
    backdropEl.addEventListener('click', closeDrawer);
  }

  // Close on Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawerOpen()) {
      closeDrawer();
    }
  });

  // Focus trap inside drawer
  drawerEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = drawerEl.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Listen to store selection events
  store.on('node-selected', (node) => {
    if (node) renderNodeDetails(node);
  });

  store.on('client-selected', (client) => {
    if (client) renderClientDetails(client);
  });

  store.on('selection-cleared', () => {
    closeDrawer();
  });
}

export function isDrawerOpen() {
  return drawerEl && drawerEl.classList.contains('open');
}

export function openDrawer(triggerEl = null) {
  if (!drawerEl) return;
  lastDrawerTrigger = triggerEl || document.activeElement;
  drawerEl.hidden = false;
  drawerEl.classList.add('open');
  if (backdropEl) {
    backdropEl.style.display = 'block';
    setTimeout(() => { backdropEl.style.opacity = '1'; }, 10);
  }
  // Move focus to drawer close button or header
  setTimeout(() => {
    const focusTarget = drawerEl.querySelector('.drawer-close-btn') || drawerEl;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
  }, 50);
}

export function closeDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove('open');
  if (backdropEl) {
    backdropEl.style.opacity = '0';
    setTimeout(() => {
      backdropEl.style.display = 'none';
      drawerEl.hidden = true;
    }, 200);
  } else {
    drawerEl.hidden = true;
  }
  if (lastDrawerTrigger && typeof lastDrawerTrigger.focus === 'function') {
    try {
      lastDrawerTrigger.focus();
    } catch {}
  }
}

export function renderNodeDetails(node) {
  if (!drawerEl) return;

  const metrics = node.metrics || {};
  const isGw = node.type === 'gateway';
  const matchedHost = (store.state.hosts || []).find((h) => h.id === node.id);
  const nicInfo = node.nicInfo || matchedHost?.nicInfo || null;
  const switchPorts = Array.isArray(node.switchPorts) && node.switchPorts.length > 0
    ? node.switchPorts
    : (matchedHost?.switchPorts || []);

  const switchPortsSectionHtml = switchPorts.length > 0
    ? `
      <!-- Physical Switch Ports & Attached Devices -->
      <div class="drawer-section">
        <div class="drawer-section-title">Physical Switch Ports (${switchPorts.filter((p) => p.linkUp ?? p.status === 'up').length}/${switchPorts.length} Active)</div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${switchPorts.map((p) => {
            const isPortUp = p.linkUp ?? p.status === 'up';
            const curSpd = Number(p.speedMbps) || 0;
            const rawMax = Number(p.maxSpeedMbps) || 0;
            const baseIfn = String(p.iface || '').split('.')[0];
            const maxSpd = rawMax > 0
              ? Math.max(rawMax, curSpd)
              : (/^(?:sfp|te|ten|xg|opt|qsfp)/i.test(baseIfn) ? Math.max(curSpd, 10000) : Math.max(curSpd, 1000));
            const maxStr = maxSpd >= 1000 ? `${maxSpd / 1000} Gbps` : `${maxSpd} Mbps`;
            const isSuboptimal = isPortUp && curSpd > 0 && maxSpd > curSpd;
            const speedStr = isPortUp
              ? (curSpd >= 1000 ? `${curSpd / 1000} Gbps` : curSpd > 0 ? `${curSpd} Mbps` : 'Link Up')
              : `No Carrier (${maxStr} max)`;
            const devices = Array.isArray(p.connectedDevices) ? p.connectedDevices : [];
            return `
              <div style="background: var(--color-surface-elevated); padding: 9px 11px; border-radius: var(--radius-md); border: 1px solid ${isSuboptimal ? 'var(--color-warning)' : 'var(--color-border-subtle)'}; display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
                  <div style="display: inline-flex; align-items: center; gap: 6px;">
                    <span class="status-dot ${isPortUp ? 'online' : 'offline'}"></span>
                    <span style="font-weight: 700; font-size: 12.5px;">${escapeHtml(p.switchPort || p.portLabel || p.iface)}</span>
                    <span class="font-mono" style="font-size: 11px; color: var(--color-text-muted);">(${escapeHtml(p.iface)})</span>
                  </div>
                  <span class="font-mono" style="font-size: 11px; font-weight: 600; color: ${isSuboptimal ? 'var(--color-warning)' : isPortUp ? 'var(--color-primary)' : 'var(--color-text-muted)'};">
                    ${escapeHtml(speedStr)}${isPortUp && p.duplex ? ` • ${escapeHtml(String(p.duplex).toUpperCase())}` : ''}${isSuboptimal ? ` • Capable: ${escapeHtml(maxStr)}` : ''}
                  </span>
                </div>
                ${devices.length > 0 ? `
                  <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px;">
                    ${devices.map((d) => `
                      <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 7px; border-radius: 999px; background: ${d.type === 'ap' || d.type === 'gateway' ? 'var(--color-primary-light)' : 'var(--color-surface)'}; color: ${d.type === 'ap' || d.type === 'gateway' ? 'var(--color-primary)' : 'var(--color-text-primary)'}; border: 1px solid var(--color-border);">
                        ${d.type === 'ap' || d.type === 'gateway' ? '📡 ' : '🔌 '}<strong>${escapeHtml(d.hostname || d.ip || d.mac)}</strong>
                        ${d.ip && d.ip !== '0.0.0.0' ? `<span class="font-mono" style="font-size: 10px; color: var(--color-text-muted);">${escapeHtml(d.ip)}</span>` : ''}
                      </span>
                    `).join('')}
                  </div>
                ` : `
                  <div style="font-size: 11px; color: var(--color-text-muted);">
                    ${isPortUp ? 'Uplink / Unmanaged segment (no leaf devices pinned)' : 'Port disconnected'}
                  </div>
                `}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `
    : '';

  drawerEl.innerHTML = `
    <div class="drawer-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="status-dot ${node.status === 'online' ? 'online' : 'offline'}"></span>
        <h2 id="drawer-title" class="modal-title" style="font-size: 15px;">${escapeHtml(node.label || node.id)}</h2>
      </div>
      <button type="button" class="btn-icon drawer-close-btn" aria-label="Close drawer">
        ${renderIcon('x', 'icon')}
      </button>
    </div>
    <div class="drawer-body">
      <!-- General Specs -->
      <div class="drawer-section">
        <div class="drawer-section-title">Hardware & Identity</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12.5px;">
          <div><span style="color:var(--color-text-muted);">Model:</span> <div style="font-weight:600;">${escapeHtml(node.model || 'OpenWrt Device')}</div></div>
          <div><span style="color:var(--color-text-muted);">Role:</span> <div style="font-weight:600; text-transform: capitalize;">${escapeHtml(node.type || 'Node')}</div></div>
          <div><span style="color:var(--color-text-muted);">IP Address:</span> <div class="font-mono">${escapeHtml(node.ip || 'N/A')}</div></div>
          <div>
            <span style="color:var(--color-text-muted);">MAC Address:</span>
            <div class="font-mono">${formatMac(node.mac) || 'N/A'}</div>
            ${node.mac ? `<div style="font-size: 11px; color: var(--color-text-muted);">${escapeHtml(resolveClientSideVendor(node.mac, node.model || node.label, node.vendor))}</div>` : ''}
          </div>
          ${nicInfo ? `
            <div style="grid-column: 1 / -1; background: var(--color-surface-elevated); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--color-border-subtle); margin-top: 2px;">
              <div style="font-size: 11px; color: var(--color-text-muted);">${isGw ? 'Primary WAN / Uplink NIC Port' : 'Host Network NIC Port & Upstream Switch Port'}</div>
              <div style="font-weight: 600; color: var(--color-primary); margin-top: 2px;">
                🔌 ${escapeHtml(nicInfo.localPortLabel || nicInfo.localPort || nicInfo.localIface || 'eth0')}
                ${!isGw && nicInfo.upstreamHostName ? ` <span style="color: var(--color-text-secondary); font-weight: 500;">⟷ ${escapeHtml(nicInfo.upstreamHostName)}${nicInfo.upstreamPortLabel ? ` (${escapeHtml(nicInfo.upstreamPortLabel)})` : ''}</span>` : ''}
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      ${switchPortsSectionHtml}

      <!-- Live Resource Utilization -->
      <div class="drawer-section">
        <div class="drawer-section-title">Resource Utilization</div>
        <div class="node-progress-group">
          <div class="progress-label-row">
            <span>CPU Usage</span>
            <span class="font-mono">${metrics.cpuUsagePct ?? 0}%</span>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill cpu" style="width: ${metrics.cpuUsagePct ?? 0}%;"></div>
          </div>
        </div>
        <div class="node-progress-group" style="margin-top: 8px;">
          <div class="progress-label-row">
            <span>Memory (RAM)</span>
            <span class="font-mono">${metrics.memUsagePct ?? 0}%</span>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill ram" style="width: ${metrics.memUsagePct ?? 0}%;"></div>
          </div>
        </div>
      </div>

      <!-- Live Bandwidth -->
      <div class="drawer-section">
        <div class="drawer-section-title">Live Throughput</div>
        <div style="display: flex; gap: 16px; background: var(--color-surface-elevated); padding: 12px; border-radius: var(--radius-md);">
          <div style="flex: 1;">
            <div style="font-size: 11px; color: var(--color-text-muted);">RX (Download)</div>
            <div style="font-size: 16px; font-weight: 700; color: var(--color-primary);">${formatBps(metrics.rxRateBps)}</div>
          </div>
          <div style="flex: 1;">
            <div style="font-size: 11px; color: var(--color-text-muted);">TX (Upload)</div>
            <div style="font-size: 16px; font-weight: 700; color: var(--color-success);">${formatBps(metrics.txRateBps)}</div>
          </div>
          <div style="flex: 1;">
            <div style="font-size: 11px; color: var(--color-text-muted);">Connected</div>
            <div style="font-size: 16px; font-weight: 700;">${metrics.clientCount ?? 0} clients</div>
          </div>
        </div>
      </div>

      <!-- Software & Attended Sysupgrade -->
      <div class="drawer-section">
        <div class="drawer-section-title">Software &amp; Attended Sysupgrade</div>
        <div style="background: var(--color-surface-elevated); padding: 12px; border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 8px; font-size: 12.5px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="color: var(--color-text-secondary);">Installed Firmware:</span>
            <span style="font-weight: 600;">${escapeHtml(node.firmware || 'OpenWrt')}</span>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="color: var(--color-text-secondary);">Attended Sysupgrade:</span>
            ${node.updates?.firmwareUpdateAvailable
              ? `<span class="status-pill warning" style="font-size: 11px;">OpenWrt ${escapeHtml(node.updates.availableFirmwareVersion || 'Update')} Available</span>`
              : `<span class="status-pill success" style="font-size: 11px;">Up to Date</span>`}
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="color: var(--color-text-secondary);">Package Updates:</span>
            <span style="font-weight: 600; color: ${(node.updates?.packagesCount || 0) > 0 ? 'var(--color-warning)' : 'var(--color-success)'};">
              ${(node.updates?.packagesCount || 0) > 0 ? `${node.updates.packagesCount} available` : '0 pending'}
            </span>
          </div>
          <button type="button" class="btn btn-secondary" id="drawer-manage-updates-btn" style="margin-top: 4px; width: 100%; justify-content: center;">
            ${renderIcon('download', 'icon icon-sm')} Manage Packages &amp; Firmware Updates
          </button>
        </div>
      </div>
    </div>
    <div class="drawer-footer">
      <a href="http://${node.ip || ''}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
        ${renderIcon('externalLink', 'icon')} Open LuCI WebUI
      </a>
      <button type="button" class="btn btn-primary" id="drawer-backup-btn">
        ${renderIcon('database', 'icon')} Backup Node
      </button>
      <button type="button" class="btn btn-secondary" id="drawer-copy-ssh-btn">
        ${renderIcon('terminal', 'icon')} Copy SSH
      </button>
    </div>
  `;

  // Attach event handlers
  drawerEl.querySelector('.drawer-close-btn').addEventListener('click', closeDrawer);

  const manageUpdatesBtn = drawerEl.querySelector('#drawer-manage-updates-btn');
  if (manageUpdatesBtn) {
    manageUpdatesBtn.addEventListener('click', () => {
      closeDrawer();
      window.location.hash = '#/hosts';
      setTimeout(() => {
        const mainContent = document.getElementById('main-content');
        openHostUpdatesModal(mainContent, node.id);
      }, 60);
    });
  }

  const backupBtn = drawerEl.querySelector('#drawer-backup-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      try {
        backupBtn.disabled = true;
        backupBtn.textContent = 'Backing up...';
        await api.runBackup(node.id);
        toast.success('Backup Started', `Configuration backup queued for ${node.label || node.id}`);
        store.poll();
      } catch (err) {
        toast.error('Backup Failed', err.message);
      } finally {
        backupBtn.disabled = false;
        backupBtn.innerHTML = `${renderIcon('database', 'icon')} Backup Node`;
      }
    });
  }

  const copySshBtn = drawerEl.querySelector('#drawer-copy-ssh-btn');
  if (copySshBtn) {
    copySshBtn.addEventListener('click', () => {
      const cmd = `ssh root@${node.ip || '192.168.1.1'}`;
      navigator.clipboard.writeText(cmd);
      toast.info('Copied to Clipboard', cmd);
    });
  }

  openDrawer();
}

export function renderClientDetails(client) {
  if (!drawerEl) return;

  const rssi = formatRssi(client.signalDbm);
  const isWired = client.connectionType === 'wired';
  const portInfo = formatSwitchPort(client.connectedTo, client.rxRateMbps);

  drawerEl.innerHTML = `
    <div class="drawer-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon(isWired ? 'server' : 'wifi', 'icon')}
        <h2 id="drawer-title" class="modal-title" style="font-size: 15px;">${escapeHtml(client.hostname || client.ip)}</h2>
      </div>
      <button type="button" class="btn-icon drawer-close-btn" aria-label="Close drawer">
        ${renderIcon('x', 'icon')}
      </button>
    </div>
    <div class="drawer-body">
      <!-- Identity & Vendor -->
      <div class="drawer-section">
        <div class="drawer-section-title">Device Identity</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12.5px;">
          <div><span style="color:var(--color-text-muted);">IP Address:</span> <div class="font-mono" style="font-weight:600;">${escapeHtml(client.ip)}</div></div>
          <div>
            <span style="color:var(--color-text-muted);">MAC Address:</span>
            <div class="font-mono">${formatMac(client.mac)}</div>
            <div style="font-size: 11px; color: var(--color-text-muted);">${escapeHtml(resolveClientSideVendor(client.mac, client.hostname, client.vendor))}</div>
          </div>
          <div><span style="color:var(--color-text-muted);">Manufacturer:</span> <div>${escapeHtml(resolveClientSideVendor(client.mac, client.hostname, client.vendor))}</div></div>
          <div><span style="color:var(--color-text-muted);">Connected Node:</span> <div style="font-weight:600;">${escapeHtml(client.connectedTo?.hostName || client.connectedTo?.hostId || 'Gateway')}</div></div>
          <div>
            <span style="color:var(--color-text-muted);">${isWired ? 'Switch Port:' : 'Wireless Radio:'}</span>
            <div style="font-weight:600; color: var(--color-primary);">
              ${escapeHtml(portInfo.portBadge)}
              ${portInfo.iface && portInfo.iface !== portInfo.portBadge ? `<span class="font-mono" style="font-size: 11px; color: var(--color-text-muted); font-weight: 400;">(${escapeHtml(portInfo.iface)})</span>` : ''}
            </div>
          </div>
          <div>
            <span style="color:var(--color-text-muted);">${isWired ? 'Negotiated Speed:' : 'Channel / Band:'}</span>
            <div class="font-mono" style="font-weight:600;">
              ${isWired ? escapeHtml(portInfo.speedLabel || '1 Gbps') : `Ch ${escapeHtml(String(client.channel || 'Auto'))} (${escapeHtml(client.ssid || 'Wi-Fi')})`}
            </div>
          </div>
        </div>

        <!-- Friendly Alias / Nickname Editor (UX Spec) -->
        <div style="margin-top: 10px; display: flex; gap: 6px; align-items: center;">
          <input type="text" id="client-alias-input" class="form-input" style="padding: 5px 8px; font-size: 12px; flex: 1;" placeholder="Set friendly device nickname..." value="${escapeHtml(client.nickname || client.displayName || '')}" />
          <button type="button" class="btn btn-secondary" id="client-alias-save-btn" style="padding: 5px 10px; font-size: 12px;">Save</button>
        </div>
      </div>

      <!-- Wireless / Network Connection -->
      <div class="drawer-section">
        <div class="drawer-section-title">Connection Metrics</div>
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; background: var(--color-surface-elevated); padding: 12px; border-radius: var(--radius-md); text-align: center;">
          <div>
            <div style="font-size: 11px; color: var(--color-text-muted);">${isWired ? 'Switch Port' : 'Signal (RSSI)'}</div>
            <div style="font-weight: 700; color: var(--color-primary);">${isWired ? escapeHtml(portInfo.portBadge) : rssi.dbm}</div>
            <div style="font-size: 10px; color: var(--color-text-muted);">${isWired ? escapeHtml(portInfo.iface || 'Ethernet') : rssi.label}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--color-text-muted);">${isWired ? 'Link Speed' : 'PHY Rx Rate'}</div>
            <div style="font-weight: 700;">${isWired ? escapeHtml(portInfo.speedLabel || '1 Gbps') : (client.rxRateMbps ? `${client.rxRateMbps} Mbps` : 'N/A')}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--color-text-muted);">PHY Tx Rate</div>
            <div style="font-weight: 700;">${client.txRateMbps ? `${client.txRateMbps} Mbps` : 'N/A'}</div>
          </div>
        </div>
      </div>

      <!-- Live Bandwidth & Cumulative Traffic -->
      <div class="drawer-section">
        <div class="drawer-section-title">Live & Total Data Flow</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12.5px;">
          <div style="background: var(--color-surface-elevated); padding: 10px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; color: var(--color-text-muted);">Current RX Rate</div>
            <div style="font-weight: 700; color: var(--color-primary);">${formatBps(client.rxRateBps)}</div>
          </div>
          <div style="background: var(--color-surface-elevated); padding: 10px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; color: var(--color-text-muted);">Current TX Rate</div>
            <div style="font-weight: 700; color: var(--color-success);">${formatBps(client.txRateBps)}</div>
          </div>
          <div style="background: var(--color-surface-elevated); padding: 10px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; color: var(--color-text-muted);">Total RX Volume</div>
            <div style="font-weight: 600;">${formatBytes(client.rxBytesTotal)}</div>
          </div>
          <div style="background: var(--color-surface-elevated); padding: 10px; border-radius: var(--radius-md);">
            <div style="font-size: 11px; color: var(--color-text-muted);">Total TX Volume</div>
            <div style="font-weight: 600;">${formatBytes(client.txBytesTotal)}</div>
          </div>
        </div>
      </div>

      <!-- Roaming Timeline History -->
      <div class="drawer-section">
        <div class="drawer-section-title">Attachment &amp; Roaming Status</div>
        <div style="font-size: 12px; color: var(--color-text-secondary); background: var(--color-surface-elevated); padding: 10px; border-radius: var(--radius-md);">
          ${isWired
            ? `Wired client attached to <strong>${escapeHtml(portInfo.portBadge)}</strong>${portInfo.iface && portInfo.iface !== portInfo.portBadge ? ` (<span class="font-mono">${escapeHtml(portInfo.iface)}</span>)` : ''} on <strong>${escapeHtml(client.connectedTo?.hostName || 'Main Gateway')}</strong>${portInfo.speedLabel ? ` at ${escapeHtml(portInfo.speedLabel)}` : ''}.`
            : 'Currently active on ' + escapeHtml(client.ssid || 'Wi-Fi') + ' via ' + escapeHtml(client.connectedTo?.hostName || 'Living Room AP') + ' (Channel ' + (client.channel || '36') + ').'}
        </div>
      </div>
    </div>
    <div class="drawer-footer">
      <button type="button" class="btn btn-secondary" id="drawer-copy-ip">
        ${renderIcon('copy', 'icon')} Copy IP
      </button>
      <button type="button" class="btn btn-secondary" id="drawer-copy-mac">
        ${renderIcon('copy', 'icon')} Copy MAC
      </button>
    </div>
  `;

  drawerEl.querySelector('.drawer-close-btn').addEventListener('click', closeDrawer);

  const aliasBtn = drawerEl.querySelector('#client-alias-save-btn');
  if (aliasBtn) {
    aliasBtn.addEventListener('click', async () => {
      const aliasInput = drawerEl.querySelector('#client-alias-input');
      const nickname = aliasInput ? aliasInput.value.trim() : '';
      try {
        await api.setClientAlias(client.mac, nickname);
        client.nickname = nickname;
        client.displayName = nickname;
        toast.success('Alias Saved', `Nickname updated for ${client.mac}`);
        store.poll();
      } catch (err) {
        toast.error('Failed to Save Alias', err.message);
      }
    });
  }

  drawerEl.querySelector('#drawer-copy-ip').addEventListener('click', () => {
    navigator.clipboard.writeText(client.ip);
    toast.info('Copied IP Address', client.ip);
  });

  drawerEl.querySelector('#drawer-copy-mac').addEventListener('click', () => {
    navigator.clipboard.writeText(client.mac);
    toast.info('Copied MAC Address', client.mac);
  });

  openDrawer();
}
