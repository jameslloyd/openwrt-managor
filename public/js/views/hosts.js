/**
 * OpenWrt Manager (openwrt-managor)
 * Host Fleet Management View & Native <dialog> Modal
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { openModal, closeModal, confirmAction, renderPaneThemeToggle } from '../components/modal.js';
import { formatUptime, formatMac, formatRelativeTime, escapeHtml, resolveClientSideVendor } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

export function renderHosts(container) {
  const { hosts } = store.state;
  const totalPkgUpdates = hosts.reduce((acc, h) => acc + (h.updates?.packagesCount || 0), 0);
  const hostsWithPkgUpdates = hosts.filter((h) => (h.updates?.packagesCount || 0) > 0);
  const hostsWithFwUpdates = hosts.filter((h) => h.updates?.firmwareUpdateAvailable);

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>OpenWrt Fleet Management</h1>
        <p>Register, monitor, manage software packages, and run Attended Sysupgrade firmware updates</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-secondary" id="hosts-check-updates-btn" ${hosts.length === 0 ? 'disabled' : ''}>
          ${renderIcon('refresh', 'icon')} Check All Updates
        </button>
        <button type="button" class="btn btn-primary" id="hosts-add-btn">
          ${renderIcon('plus', 'icon')} Add OpenWrt Host
        </button>
      </div>
    </div>

    <!-- Fleet Software & Attended Sysupgrade Summary Bar -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4);">
      <div class="chart-card" style="padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 36px; height: 36px; border-radius: var(--radius-md); background: ${totalPkgUpdates > 0 ? 'var(--color-warning-bg)' : 'var(--color-success-bg)'}; color: ${totalPkgUpdates > 0 ? 'var(--color-warning)' : 'var(--color-success)'}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            ${renderIcon('download', 'icon icon-md')}
          </div>
          <div>
            <div style="font-weight: 600; font-size: 14px;">
              ${totalPkgUpdates > 0 ? `${totalPkgUpdates} Package Update${totalPkgUpdates === 1 ? '' : 's'} Available` : 'All Installed Packages Up to Date'}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary);">
              ${hostsWithPkgUpdates.length > 0
                ? `Pending on ${hostsWithPkgUpdates.map((h) => escapeHtml(h.name || h.hostname)).join(', ')}`
                : 'Tracked via opkg / apk package lists across all online OpenWrt nodes'}
            </div>
          </div>
        </div>
        <span class="status-pill ${totalPkgUpdates > 0 ? 'warning' : 'success'}">
          <span class="status-dot ${totalPkgUpdates > 0 ? 'warning' : 'success'}"></span>
          ${totalPkgUpdates > 0 ? `${hostsWithPkgUpdates.length} Node${hostsWithPkgUpdates.length === 1 ? '' : 's'}` : 'Current'}
        </span>
      </div>

      <div class="chart-card" style="padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 36px; height: 36px; border-radius: var(--radius-md); background: ${hostsWithFwUpdates.length > 0 ? 'var(--color-info-bg)' : 'var(--color-primary-light)'}; color: ${hostsWithFwUpdates.length > 0 ? 'var(--color-info)' : 'var(--color-primary)'}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            ${renderIcon('zap', 'icon icon-md')}
          </div>
          <div>
            <div style="font-weight: 600; font-size: 14px;">
              ${hostsWithFwUpdates.length > 0
                ? `New Firmware Available (${hostsWithFwUpdates.length} Host${hostsWithFwUpdates.length === 1 ? '' : 's'})`
                : 'Attended Sysupgrade Firmware Advisor'}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary);">
              ${hostsWithFwUpdates.length > 0
                ? hostsWithFwUpdates
                    .map(
                      (h) =>
                        `${escapeHtml(h.name || h.hostname)}: OpenWrt ${escapeHtml(h.updates?.availableFirmwareVersion || h.updates?.attendedSysupgrade?.availableVersion || 'New')}`
                    )
                    .join(' • ')
                : 'Monitors OpenWrt releases & Attended Sysupgrade (auc / owut) availability'}
            </div>
          </div>
        </div>
        <span class="status-pill ${hostsWithFwUpdates.length > 0 ? 'warning' : 'online'}">
          <span class="status-dot ${hostsWithFwUpdates.length > 0 ? 'warning' : 'online'}"></span>
          ${hostsWithFwUpdates.length > 0 ? 'Upgrade Advised' : 'Up to Date'}
        </span>
      </div>
    </div>

    <div class="table-container">
      <div class="table-toolbar">
        <h2 style="font-size: 15px; font-weight: 600;">Registered Network Fleet (${hosts.length} Hosts)</h2>
      </div>

      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Host Name / Model</th>
              <th>IP Address</th>
              <th>Role</th>
              <th>Firmware / Uptime</th>
              <th>Software &amp; Firmware Updates</th>
              <th>CPU / RAM</th>
              <th>Active Clients</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${hosts.length > 0 ? hosts.map(h => renderHostRow(h)).join('') : `
              <tr>
                <td colspan="9" style="text-align: center; padding: 32px;">
                  <div class="empty-state">
                    <div class="empty-state-title">No OpenWrt Hosts Registered</div>
                    <div class="empty-state-desc">Click "Add OpenWrt Host" above to register your routers and access points.</div>
                  </div>
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Host Software & Attended Sysupgrade Native <dialog> Modal -->
    <dialog id="host-updates-dialog" aria-labelledby="updates-modal-title" style="max-width: 780px;">
      <div class="modal-header">
        <h2 id="updates-modal-title" class="modal-title">Software Packages &amp; Attended Sysupgrade</h2>
        <div class="modal-header-actions">
          ${renderPaneThemeToggle()}
          <button type="button" class="btn-icon" onclick="document.getElementById('host-updates-dialog').close()" aria-label="Close">
            ${renderIcon('x', 'icon')}
          </button>
        </div>
      </div>
      <div class="modal-body" id="host-updates-modal-body" style="gap: 16px;"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('host-updates-dialog').close()">Close</button>
      </div>
    </dialog>

    <!-- Add/Edit Host Native <dialog> Modal -->
    <dialog id="host-form-dialog" aria-labelledby="host-modal-title">
      <form id="host-form" method="dialog">
        <div class="modal-header">
          <h2 id="host-modal-title" class="modal-title">Add OpenWrt Node</h2>
          <div class="modal-header-actions">
            ${renderPaneThemeToggle()}
            <button type="button" class="btn-icon" onclick="document.getElementById('host-form-dialog').close()" aria-label="Close">
              ${renderIcon('x', 'icon')}
            </button>
          </div>
        </div>

        <div class="modal-body">
          <input type="hidden" id="host-id-input" value="" />

          <div class="form-group">
            <label class="form-label" for="host-name-input">Display Name</label>
            <input type="text" id="host-name-input" class="form-input" placeholder="e.g. Living Room AP" required />
          </div>

          <div class="form-row-ip-role">
            <div class="form-group">
              <label class="form-label" for="host-ip-input">Router IP Address or FQDN</label>
              <input type="text" id="host-ip-input" class="form-input font-mono" placeholder="192.168.1.1" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="host-role-select">Role</label>
              <select id="host-role-select" class="form-select">
                <option value="gateway">Main Gateway</option>
                <option value="ap" selected>Access Point</option>
                <option value="mesh">Mesh Extender</option>
                <option value="switch">Managed Switch</option>
              </select>
            </div>
          </div>

          <div class="form-row-2col">
            <div class="form-group">
              <label class="form-label" for="host-protocol-select">Connection Protocol</label>
              <select id="host-protocol-select" class="form-select">
                <option value="ssh" selected>Direct SSH (Port 22)</option>
                <option value="ubus_http">ubus HTTP (Port 80)</option>
                <option value="ubus_https">ubus HTTPS (Port 443)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="host-username-input">Username</label>
              <input type="text" id="host-username-input" class="form-input" value="root" required />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="host-password-input">Password / Token</label>
            <div style="display: flex; gap: 6px;">
              <input type="password" id="host-password-input" class="form-input" placeholder="Router password or ubus token" style="flex: 1;" />
              <button type="button" class="btn btn-secondary" id="host-toggle-pass-btn" aria-label="Show password" style="padding: 0 10px;">
                ${renderIcon('activity', 'icon icon-sm')} <span class="pass-toggle-label">Show</span>
              </button>
            </div>
          </div>

          <!-- Physical Geolocation (Latitude, Longitude & Altitude for RF Triangulation) -->
          <div style="border-top: 1px solid var(--color-border); padding-top: 10px; margin-top: 4px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
              <div>
                <span class="form-label" style="margin-bottom: 0;">Physical AP Location (GPS &amp; Altitude for RF Triangulation)</span>
                <div style="font-size: 11px; color: var(--color-text-muted);">
                  Optional decimal degrees &amp; elevation (meters) to anchor 3D multi-AP RF triangulation
                </div>
              </div>
              <button type="button" class="btn btn-secondary" id="host-use-gps-btn" style="padding: 3px 8px; font-size: 11px;">
                ${renderIcon('globe', 'icon')} Use Browser GPS
              </button>
            </div>
            <div class="form-row-3col">
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" for="host-latitude-input" style="font-size: 11.5px;">Latitude (°)</label>
                <input type="number" step="any" min="-90" max="90" id="host-latitude-input" class="form-input font-mono" placeholder="e.g. 51.507351" />
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" for="host-longitude-input" style="font-size: 11.5px;">Longitude (°)</label>
                <input type="number" step="any" min="-180" max="180" id="host-longitude-input" class="form-input font-mono" placeholder="e.g. -0.127758" />
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" for="host-altitude-input" style="font-size: 11.5px;">Altitude (m)</label>
                <input type="number" step="any" min="-500" max="10000" id="host-altitude-input" class="form-input font-mono" placeholder="e.g. 12.5" />
              </div>
            </div>
          </div>

          <!-- Connection Test Feedback Box -->
          <div style="margin-top: 6px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <span class="form-label">Connection Diagnostics</span>
              <button type="button" class="btn btn-secondary" id="host-test-btn" style="padding: 4px 10px; font-size: 12px;">
                ${renderIcon('zap', 'icon')} Test Connection Now
              </button>
            </div>
            <div id="host-test-feedback" class="probe-feedback-box" style="display: none;"></div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('host-form-dialog').close()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="host-save-btn">Save & Monitor</button>
        </div>
      </form>
    </dialog>
  `;

  // Attach Check All Updates Button
  const checkAllBtn = container.querySelector('#hosts-check-updates-btn');
  checkAllBtn?.addEventListener('click', async () => {
    try {
      checkAllBtn.disabled = true;
      checkAllBtn.innerHTML = `${renderIcon('refresh', 'icon')} Checking Fleet...`;
      toast.info('Checking Updates', 'Running opkg update & Attended Sysupgrade checks across all hosts...');
      const res = await api.checkHostUpdates('all');
      await store.poll(true);
      renderHosts(container);
      const totalPkgs = (res?.hosts || store.state.hosts || []).reduce(
        (acc, h) => acc + (h.updates?.packagesCount || 0),
        0
      );
      const fwCount = (res?.hosts || store.state.hosts || []).filter(
        (h) => h.updates?.firmwareUpdateAvailable
      ).length;
      toast.success(
        'Update Check Complete',
        `Found ${totalPkgs} package update${totalPkgs === 1 ? '' : 's'} and ${fwCount} firmware upgrade${fwCount === 1 ? '' : 's'}.`
      );
    } catch (err) {
      toast.error('Update Check Failed', err.message);
    } finally {
      if (checkAllBtn) {
        checkAllBtn.disabled = false;
        checkAllBtn.innerHTML = `${renderIcon('refresh', 'icon')} Check All Updates`;
      }
    }
  });

  // Attach Add Button
  container.querySelector('#hosts-add-btn')?.addEventListener('click', () => {
    resetHostForm();
    openModal('host-form-dialog');
  });

  // Attach Use Browser GPS button
  container.querySelector('#host-use-gps-btn')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation Unavailable', 'Your browser does not support the Geolocation API.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latEl = container.querySelector('#host-latitude-input');
        const lngEl = container.querySelector('#host-longitude-input');
        const altEl = container.querySelector('#host-altitude-input');
        if (latEl && Number.isFinite(pos.coords.latitude)) {
          latEl.value = (Math.round(pos.coords.latitude * 1e6) / 1e6).toString();
        }
        if (lngEl && Number.isFinite(pos.coords.longitude)) {
          lngEl.value = (Math.round(pos.coords.longitude * 1e6) / 1e6).toString();
        }
        if (altEl && Number.isFinite(pos.coords.altitude) && pos.coords.altitude !== null) {
          altEl.value = (Math.round(pos.coords.altitude * 10) / 10).toString();
        }
        toast.success('GPS Coordinates Filled', 'Populated Latitude, Longitude, and Altitude from browser geolocation.');
      },
      (err) => {
        toast.error('Geolocation Failed', err.message || 'Unable to retrieve browser GPS coordinates.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  // Attach Form Submit
  const form = container.querySelector('#host-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = container.querySelector('#host-id-input').value;
    const name = container.querySelector('#host-name-input').value;
    const ip = container.querySelector('#host-ip-input').value;
    const role = container.querySelector('#host-role-select').value;
    const protocol = container.querySelector('#host-protocol-select').value;
    const username = container.querySelector('#host-username-input').value;
    const password = container.querySelector('#host-password-input').value;
    const rawLat = container.querySelector('#host-latitude-input')?.value?.trim() ?? '';
    const rawLng = container.querySelector('#host-longitude-input')?.value?.trim() ?? '';
    const rawAlt = container.querySelector('#host-altitude-input')?.value?.trim() ?? '';

    const latitude = rawLat !== '' && Number.isFinite(Number(rawLat)) ? Number(rawLat) : null;
    const longitude = rawLng !== '' && Number.isFinite(Number(rawLng)) ? Number(rawLng) : null;
    const altitude = rawAlt !== '' && Number.isFinite(Number(rawAlt)) ? Number(rawAlt) : null;

    const payload = {
      name,
      ip,
      role,
      protocol,
      username,
      password,
      latitude,
      longitude,
      altitude,
      isSimulated: false,
    };

    try {
      if (id) {
        await api.updateHost(id, payload);
        toast.success('Host Updated', `Settings saved for ${name}`);
      } else {
        await api.createHost(payload);
        toast.success('Host Added', `Added ${name} to monitoring fleet`);
      }
      closeModal('host-form-dialog');
      await store.poll();
      renderHosts(container);
    } catch (err) {
      toast.error('Failed to Save Host', err.message);
    }
  });

  // Attach Live Test Connection Probe
  const passInput = container.querySelector('#host-password-input');
  const togglePassBtn = container.querySelector('#host-toggle-pass-btn');
  togglePassBtn?.addEventListener('click', () => {
    if (!passInput) return;
    const isPass = passInput.type === 'password';
    passInput.type = isPass ? 'text' : 'password';
    togglePassBtn.setAttribute('aria-label', isPass ? 'Hide password' : 'Show password');
    const label = togglePassBtn.querySelector('.pass-toggle-label');
    if (label) label.textContent = isPass ? 'Hide' : 'Show';
  });

  container.querySelector('#host-test-btn')?.addEventListener('click', async () => {
    const feedbackBox = container.querySelector('#host-test-feedback');
    const ip = container.querySelector('#host-ip-input').value;
    const username = container.querySelector('#host-username-input').value;
    const password = container.querySelector('#host-password-input').value;
    const protocol = container.querySelector('#host-protocol-select').value;

    feedbackBox.style.display = 'block';
    feedbackBox.className = 'probe-feedback-box';
    feedbackBox.innerHTML = `<div>Testing connection to ${escapeHtml(ip || 'router')} via ${escapeHtml(protocol)}...</div>`;

    try {
      const res = await api.testHostConnection({ ip, username, password, protocol, isSimulated: false });
      if (res.success) {
        feedbackBox.className = 'probe-feedback-box success';
        feedbackBox.innerHTML = `
          <div style="font-weight: 700; color: var(--color-success);">🟢 Connection Probe Succeeded!</div>
          <div>• Latency: <strong>${escapeHtml(res.latencyMs || 2.4)} ms</strong></div>
          <div>• Detected Model: <strong>${escapeHtml(res.detectedModel || 'OpenWrt Hardware')}</strong></div>
          <div>• Release: <strong>${escapeHtml(res.detectedFirmware || 'OpenWrt 23.05.4')}</strong></div>
          <div>• Status: ubus RPC handshake and authentication verified.</div>
        `;
      } else {
        feedbackBox.className = 'probe-feedback-box error';
        const errMsg = escapeHtml(res.error || res.message || 'Check IP address, router credentials, and firewall settings.');
        feedbackBox.innerHTML = `
          <div style="font-weight: 700; color: var(--color-danger);">🔴 Connection Probe Failed</div>
          <div>${errMsg}</div>
        `;
      }
    } catch (err) {
      feedbackBox.className = 'probe-feedback-box error';
      feedbackBox.innerHTML = `
        <div style="font-weight: 700; color: var(--color-danger);">🔴 Probe Error</div>
        <div>${escapeHtml(err.message)}</div>
      `;
    }
  });

  // Attach Row Action Buttons: Updates, Inspect, Edit, Delete
  container.querySelectorAll('.btn-updates-host').forEach(btn => {
    btn.addEventListener('click', () => {
      const hostId = btn.getAttribute('data-host-id');
      openHostUpdatesModal(container, hostId);
    });
  });

  container.querySelectorAll('.btn-inspect-host').forEach(btn => {
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
            rxRateBps: host.rxRateBps ?? 0,
            txRateBps: host.txRateBps ?? 0,
            clientCount: host.clientCount ?? 0
          }
        });
      }
    });
  });

  container.querySelectorAll('.btn-edit-host').forEach(btn => {
    btn.addEventListener('click', () => {
      const hostId = btn.getAttribute('data-host-id');
      const host = hosts.find(h => h.id === hostId);
      if (host) {
        document.getElementById('host-id-input').value = host.id;
        document.getElementById('host-name-input').value = host.name || host.hostname || '';
        document.getElementById('host-ip-input').value = host.ip || '';
        document.getElementById('host-role-select').value = host.role || 'ap';
        document.getElementById('host-protocol-select').value = host.protocol || 'ssh';
        document.getElementById('host-username-input').value = host.username || 'root';
        const passInput = document.getElementById('host-password-input');
        passInput.value = '';
        passInput.placeholder = host.hasPassword ? 'Leave blank to keep saved password' : 'Router password or ubus token';
        resetPasswordVisibility();
        const latInput = document.getElementById('host-latitude-input');
        const lngInput = document.getElementById('host-longitude-input');
        const altInput = document.getElementById('host-altitude-input');
        if (latInput) latInput.value = typeof host.latitude === 'number' ? host.latitude : '';
        if (lngInput) lngInput.value = typeof host.longitude === 'number' ? host.longitude : '';
        if (altInput) altInput.value = typeof host.altitude === 'number' ? host.altitude : '';
        document.getElementById('host-modal-title').textContent = `Edit Host: ${host.name || host.id}`;
        const fb = document.getElementById('host-test-feedback');
        if (fb) fb.style.display = 'none';
        openModal('host-form-dialog');
      }
    });
  });

  container.querySelectorAll('.btn-delete-host').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hostId = btn.getAttribute('data-host-id');
      const host = hosts.find(h => h.id === hostId);
      const confirmed = await confirmAction({
        title: 'Remove OpenWrt Host',
        message: `Are you sure you want to remove ${host?.name || hostId} from the fleet?`,
        confirmLabel: 'Remove Host',
        isDestructive: true
      });
      if (confirmed) {
        try {
          await api.deleteHost(hostId);
          toast.success('Host Removed', `Removed ${hostId}`);
          await store.poll();
          renderHosts(container);
        } catch (err) {
          toast.error('Removal Failed', err.message);
        }
      }
    });
  });
}

function getJobForHost(host) {
  if (!host) return null;
  const fromStore = (store.state.upgradeJobs || []).find((j) => j.hostId === host.id);
  return fromStore || host.activeUpgradeJob || null;
}

function renderHostRow(h) {
  const isOnline = h.status === 'online';
  const hostVendor = resolveClientSideVendor(h.mac, h.model || h.name, h.vendor);
  const pkgCount = h.updates?.packagesCount || 0;
  const asu = h.updates?.attendedSysupgrade || {};
  const fwAvailable = Boolean(h.updates?.firmwareUpdateAvailable || asu.firmwareUpdateAvailable);
  const availFwVer = h.updates?.availableFirmwareVersion || asu.availableVersion;
  const activeJob = getJobForHost(h);
  const isUpgrading = activeJob?.status === 'running';

  return `
    <tr data-row-host-id="${escapeHtml(h.id)}">
      <td>
        <span class="status-pill ${isOnline ? 'online' : 'offline'}">
          <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
          ${isOnline ? 'Online' : 'Offline'}
        </span>
      </td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(h.name || h.hostname)}</div>
        <div style="font-size: 11px; color: var(--color-text-muted);">
          ${escapeHtml(h.model || 'OpenWrt')}${hostVendor && hostVendor !== 'Unknown Manufacturer' ? ` • ${escapeHtml(hostVendor)}` : ''}
        </div>
        ${h.mac ? `<div class="font-mono" style="font-size: 10.5px; color: var(--color-text-muted);">${escapeHtml(formatMac(h.mac))} (${escapeHtml(hostVendor)})</div>` : ''}
        ${
          typeof h.latitude === 'number' || typeof h.altitude === 'number'
            ? `<div class="font-mono" style="font-size: 10.5px; color: var(--color-primary); margin-top: 2px;">
                ${typeof h.latitude === 'number' && typeof h.longitude === 'number' ? `GPS: ${h.latitude.toFixed(5)}°, ${h.longitude.toFixed(5)}°` : ''}${typeof h.latitude === 'number' && typeof h.altitude === 'number' ? ' • ' : ''}${typeof h.altitude === 'number' ? `Alt: ${h.altitude}m` : ''}
              </div>`
            : ''
        }
      </td>
      <td>
        <span class="font-mono">${escapeHtml(h.ip)}</span>
        ${h.nicInfo ? `
          <div style="font-size: 10.5px; color: var(--color-primary); margin-top: 2px;">
            🔌 NIC: <span class="font-mono" style="font-weight: 600;">${escapeHtml(h.nicInfo.localPortLabel || h.nicInfo.localIface)}</span>
          </div>
          ${h.role !== 'gateway' && h.nicInfo.upstreamHostName ? `
            <div style="font-size: 10px; color: var(--color-text-muted);">
              ↳ via ${escapeHtml(h.nicInfo.upstreamHostName)}${h.nicInfo.upstreamPort ? ` (${escapeHtml(h.nicInfo.upstreamPort)})` : ''}
            </div>
          ` : ''}
        ` : ''}
      </td>
      <td>
        <span style="text-transform: capitalize;">${escapeHtml(h.role || 'AP')}</span>
      </td>
      <td>
        <div style="font-size: 12px; font-weight: 500;">${escapeHtml(h.firmware || 'OpenWrt')}</div>
        <div style="font-size: 10.5px; color: var(--color-text-muted);">Uptime: ${formatUptime(h.uptimeSec)}</div>
      </td>
      <td class="host-row-updates-cell">
        ${isUpgrading
          ? `
          <div style="display: flex; flex-direction: column; gap: 5px; min-width: 190px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
              <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--color-primary);">
                <progress class="loading-spinner" style="width: 14px; height: 14px; --spinner-width: 2px;" aria-label="Upgrading ${escapeHtml(h.name || h.hostname)}"></progress>
                ${activeJob.type === 'attended-sysupgrade' ? 'Sysupgrade Running' : 'Upgrading Software'}
              </span>
              <span class="font-mono" style="font-size: 11px; font-weight: 700; color: var(--color-primary);">
                ${Math.round(activeJob.progressPct || 5)}%
              </span>
            </div>
            <progress class="custom-progress" max="100" value="${Math.round(activeJob.progressPct || 5)}" style="height: 6px;" aria-label="Software upgrade progress for ${escapeHtml(h.name || h.hostname)}"></progress>
            <div style="font-size: 10.5px; color: var(--color-text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(
                activeJob.currentPackage
                  ? `${activeJob.currentPackage} (${activeJob.packagesCompleted || 0}/${activeJob.packagesTotal || 1})`
                  : activeJob.phase || 'Running in background...'
              )}
            </div>
          </div>
          `
          : `
          <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
            ${fwAvailable
              ? `<span class="status-pill warning" style="font-size: 11px; padding: 2px 8px;" title="${escapeHtml(asu.advisory || '')}">
                  ${renderIcon('zap', 'icon icon-sm')} Firmware ${escapeHtml(availFwVer || 'Update')} Available
                </span>`
              : `<span class="status-pill success" style="font-size: 11px; padding: 2px 8px;" title="${escapeHtml(asu.advisory || 'Firmware is up to date')}">
                  ✓ Firmware Current
                </span>`}
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px;">
              ${pkgCount > 0
                ? `<span style="color: var(--color-warning); font-weight: 600;">${pkgCount} package update${pkgCount === 1 ? '' : 's'}</span>`
                : `<span style="color: var(--color-text-muted);">0 pkg updates</span>`}
              <span>•</span>
              <span style="color: ${asu.installed ? 'var(--color-success)' : 'var(--color-text-muted)'};" title="Attended Sysupgrade package status">
                ${asu.installed ? `ASU (${escapeHtml(asu.cliTool || 'installed')})` : 'ASU not installed'}
              </span>
            </div>
          </div>
          `}
      </td>
      <td>
        <div class="font-mono" style="font-size: 11.5px;">CPU: ${h.cpuUsagePct ?? 0}% • RAM: ${h.memUsagePct ?? 0}%</div>
      </td>
      <td>
        <strong>${h.clientCount ?? 0}</strong> active
        ${Array.isArray(h.switchPorts) && h.switchPorts.length > 0 ? `
          <div style="display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px;">
            ${h.switchPorts.map((p) => {
              const isPortUp = p.linkUp ?? p.status === 'up';
              const curSpd = Number(p.speedMbps) || 0;
              const rawMax = Number(p.maxSpeedMbps) || 0;
              const baseIfn = String(p.iface || '').split('.')[0];
              const maxSpd = rawMax > 0
                ? Math.max(rawMax, curSpd)
                : (/^(?:sfp|te|ten|xg|opt|qsfp)/i.test(baseIfn) ? Math.max(curSpd, 10000) : Math.max(curSpd, 1000));
              const curShort = curSpd >= 1000 ? `${curSpd / 1000}G` : `${curSpd}M`;
              const maxShort = maxSpd >= 1000 ? `${maxSpd / 1000}G` : `${maxSpd}M`;
              const isSuboptimal = isPortUp && curSpd > 0 && maxSpd > curSpd;
              const speedInfo = isPortUp && curSpd > 0
                ? (isSuboptimal ? `${curShort} / Capable: ${maxShort}` : curShort)
                : `Down (${maxShort} max)`;
              const devNames = Array.isArray(p.connectedDevices) && p.connectedDevices.length > 0
                ? p.connectedDevices.map((d) => d.hostname || d.ip || d.mac).join(', ')
                : (isPortUp ? 'Link Up' : 'Down');
              const pillLabel = isSuboptimal
                ? `${p.switchPort || p.portLabel || p.iface} (${curShort}/${maxShort})`
                : (p.switchPort || p.portLabel || p.iface);
              return `<span class="font-mono" title="${escapeHtml(`${p.switchPort || p.portLabel || p.iface} (${p.iface}) [${speedInfo}]: ${devNames}`)}" style="font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: ${isPortUp ? 'var(--color-primary-light)' : 'var(--color-surface-elevated)'}; color: ${isSuboptimal ? 'var(--color-warning)' : isPortUp ? 'var(--color-primary)' : 'var(--color-text-muted)'}; border: 1px solid ${isSuboptimal ? 'var(--color-warning)' : isPortUp ? 'var(--color-primary)' : 'var(--color-border)'};">${escapeHtml(pillLabel)}</span>`;
            }).join('')}
          </div>
        ` : ''}
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <div style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px;">
          <button type="button" class="btn ${isUpgrading || pkgCount > 0 || fwAvailable ? 'btn-primary' : 'btn-secondary'} btn-updates-host" data-host-id="${escapeHtml(h.id)}" style="height: 28px; padding: 0 10px; font-size: 11.5px;" title="Manage software packages &amp; Attended Sysupgrade">
            ${isUpgrading
              ? `<progress class="loading-spinner" style="width: 12px; height: 12px; --spinner-width: 2px; --spinner-color-fg: #fff;" aria-label="Upgrade in progress"></progress> Progress (${Math.round(activeJob.progressPct || 5)}%)`
              : `${renderIcon('download', 'icon icon-sm')} Updates${pkgCount > 0 ? ` (${pkgCount})` : fwAvailable ? ' (!)' : ''}`}
          </button>
          <button type="button" class="btn btn-secondary btn-inspect-host" data-host-id="${escapeHtml(h.id)}" style="height: 28px; padding: 0 10px; font-size: 11.5px;">
            ${renderIcon('activity', 'icon icon-sm')} Inspect
          </button>
          <button type="button" class="btn btn-secondary btn-edit-host" data-host-id="${escapeHtml(h.id)}" style="height: 28px; padding: 0 10px; font-size: 11.5px;">
            ${renderIcon('settings', 'icon icon-sm')} Edit
          </button>
          <button type="button" class="btn-icon btn-delete-host" data-host-id="${escapeHtml(h.id)}" style="width: 28px; height: 28px; color: var(--color-danger);" title="Remove host" aria-label="Remove host">
            ${renderIcon('trash', 'icon icon-sm')}
          </button>
        </div>
      </td>
    </tr>
  `;
}

let activeModalHostId = null;
let activeModalContainer = null;
let modalProgressListenerRegistered = false;

function renderUpgradeJobCardHtml(job) {
  if (!job) return '';
  const isRunning = job.status === 'running';
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const pct = Math.max(0, Math.min(100, Math.round(job.progressPct || (isCompleted ? 100 : 5))));
  const stateClass = isCompleted ? 'completed' : isFailed ? 'failed' : '';
  const progressClass = isCompleted ? 'success' : isFailed ? 'warning' : '';

  return `
    <div class="upgrade-job-card ${stateClass}" role="status" aria-live="polite">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${isRunning
            ? `<progress class="loading-spinner" aria-label="Upgrading packages in background"></progress>`
            : isCompleted
              ? `<span class="status-pill success" style="padding: 2px 8px;">✓ Completed</span>`
              : `<span class="status-pill danger" style="padding: 2px 8px;">✕ Failed</span>`}
          <div>
            <div style="font-weight: 700; font-size: 13.5px; color: var(--color-text-primary);">
              ${isRunning
                ? job.type === 'attended-sysupgrade'
                  ? 'Attended Sysupgrade Running in Background'
                  : 'Software Package Upgrade Running in Background'
                : isCompleted
                  ? 'Background Upgrade Completed'
                  : 'Background Upgrade Failed'}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary);">
              ${escapeHtml(job.phase || 'Executing upgrade...')}
            </div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${job.packagesTotal > 0
            ? `<span class="status-pill ${isCompleted ? 'success' : 'info'}" style="font-family: var(--font-mono); font-size: 11.5px;">
                ${job.packagesCompleted || 0} / ${job.packagesTotal} pkg${job.packagesTotal === 1 ? '' : 's'}
              </span>`
            : ''}
          <span class="font-mono" style="font-size: 13px; font-weight: 700; color: ${isCompleted ? 'var(--color-success)' : isFailed ? 'var(--color-danger)' : 'var(--color-primary)'};">
            ${pct}%
          </span>
        </div>
      </div>

      <progress class="custom-progress ${progressClass}" max="100" value="${pct}" aria-label="Upgrade progress percentage"></progress>

      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 11.5px; color: var(--color-text-secondary);">
        <div>
          ${job.currentPackage
            ? `Currently upgrading: <code class="font-mono" style="color: var(--color-primary); font-weight: 600;">${escapeHtml(job.currentPackage)}</code>`
            : isRunning
              ? 'Safe to close this dialog — upgrade continues in the background.'
              : job.completedAt
                ? `Finished ${formatRelativeTime(job.completedAt)}`
                : ''}
        </div>
        ${Array.isArray(job.completedPackages) && job.completedPackages.length > 0
          ? `<div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <span>Updated:</span>
              ${job.completedPackages
                .slice(-5)
                .map((p) => `<span class="status-pill success" style="font-size: 10px; padding: 1px 6px;">✓ ${escapeHtml(p)}</span>`)
                .join('')}
            </div>`
          : ''}
      </div>
    </div>
  `;
}

function ensureModalProgressListener() {
  if (modalProgressListenerRegistered) return;
  modalProgressListenerRegistered = true;

  store.on('upgrade-progress', () => {
    // Update inline host table rows if we are on the Hosts view
    if (store.state.activeView === 'hosts') {
      for (const h of store.state.hosts || []) {
        const tr = document.querySelector(`tr[data-row-host-id="${CSS.escape(h.id)}"]`);
        if (tr) {
          const temp = document.createElement('tbody');
          temp.innerHTML = renderHostRow(h).trim();
          const newTr = temp.firstElementChild;
          if (newTr) {
            const oldUpdatesCell = tr.querySelector('.host-row-updates-cell');
            const newUpdatesCell = newTr.querySelector('.host-row-updates-cell');
            if (oldUpdatesCell && newUpdatesCell) {
              oldUpdatesCell.innerHTML = newUpdatesCell.innerHTML;
            }
            const oldBtn = tr.querySelector('.btn-updates-host');
            const newBtn = newTr.querySelector('.btn-updates-host');
            if (oldBtn && newBtn) {
              oldBtn.className = newBtn.className;
              oldBtn.innerHTML = newBtn.innerHTML;
            }
          }
        }
      }
    }

    // If the updates modal is currently open, refresh its progress card and live console log
    const dialog = document.getElementById('host-updates-dialog');
    if (dialog && dialog.open && activeModalHostId) {
      const host = (store.state.hosts || []).find((h) => h.id === activeModalHostId);
      const job = getJobForHost(host);
      const progressMount = document.getElementById('modal-upgrade-progress-mount');
      if (progressMount) {
        const wasRunning = progressMount.getAttribute('data-job-status') === 'running';
        const nowStatus = job?.status || 'none';
        progressMount.setAttribute('data-job-status', nowStatus);
        progressMount.innerHTML = renderUpgradeJobCardHtml(job);

        // If job just completed or failed while modal is open, re-render the modal body so updated package counts & buttons reflect completion
        if (wasRunning && (nowStatus === 'completed' || nowStatus === 'failed')) {
          openHostUpdatesModal(activeModalContainer, activeModalHostId, job?.output || '');
          return;
        }
      }

      // Update per-package status cells in-place while running
      if (job) {
        document.querySelectorAll('[data-pkg-action-cell]').forEach((cell) => {
          const pkgName = cell.getAttribute('data-pkg-action-cell');
          if (!pkgName) return;
          if (Array.isArray(job.completedPackages) && job.completedPackages.includes(pkgName)) {
            cell.innerHTML = `<span class="status-pill success" style="font-size: 10.5px; padding: 2px 8px;">✓ Updated</span>`;
          } else if (job.status === 'running' && job.currentPackage === pkgName) {
            cell.innerHTML = `
              <span class="status-pill info" style="font-size: 10.5px; padding: 2px 8px; display: inline-flex; align-items: center; gap: 5px;">
                <progress class="loading-spinner" style="width: 11px; height: 11px; --spinner-width: 2px;" aria-label="Upgrading ${escapeHtml(pkgName)}"></progress>
                Upgrading...
              </span>
            `;
          } else if (
            job.status === 'running' &&
            Array.isArray(job.targetPackages) &&
            job.targetPackages.includes(pkgName)
          ) {
            cell.innerHTML = `<span class="status-pill" style="font-size: 10.5px; padding: 2px 8px;">Queued</span>`;
          }
        });

        if (job.output) {
          const logWrapper = document.getElementById('updates-log-wrapper');
          const logPre = document.getElementById('updates-command-log');
          if (logWrapper && logPre) {
            logWrapper.style.display = 'block';
            logPre.textContent = job.output;
            logPre.scrollTop = logPre.scrollHeight;
          }
        }
      }
    }
  });
}

export function openHostUpdatesModal(container, hostId, lastCommandOutput = '') {
  ensureModalProgressListener();
  activeModalHostId = hostId;
  activeModalContainer = container;

  const dialog = document.getElementById('host-updates-dialog');
  const bodyEl = document.getElementById('host-updates-modal-body');
  const titleEl = document.getElementById('updates-modal-title');
  if (!dialog || !bodyEl) return;

  const host = (store.state.hosts || []).find((h) => h.id === hostId);
  if (!host) return;

  if (titleEl) {
    titleEl.textContent = `Software & Firmware Updates — ${host.name || host.hostname} (${host.ip})`;
  }

  const updates = host.updates || {};
  const packages = Array.isArray(updates.packages) ? updates.packages : [];
  const asu = updates.attendedSysupgrade || {};
  const fwAvailable = Boolean(updates.firmwareUpdateAvailable || asu.firmwareUpdateAvailable);
  const availFwVer = updates.availableFirmwareVersion || asu.availableVersion;
  const activeJob = getJobForHost(host);
  const isJobRunning = activeJob?.status === 'running';
  const effectiveOutput = lastCommandOutput || activeJob?.output || '';

  bodyEl.innerHTML = `
    <!-- Live Background Upgrade Progress Card Mount -->
    <div id="modal-upgrade-progress-mount" data-job-status="${escapeHtml(activeJob?.status || 'none')}">
      ${renderUpgradeJobCardHtml(activeJob)}
    </div>

    <!-- Section 1: Attended Sysupgrade Firmware Advisor -->
    <div style="border: 1px solid ${fwAvailable ? 'var(--color-warning)' : 'var(--color-border)'}; background: ${fwAvailable ? 'var(--color-warning-bg)' : 'var(--color-surface-elevated)'}; border-radius: var(--radius-lg); padding: 14px 16px;">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="status-pill ${fwAvailable ? 'warning' : 'success'}">
              ${fwAvailable ? `New Firmware Available: OpenWrt ${escapeHtml(availFwVer)}` : 'Firmware Up to Date'}
            </span>
            <span class="status-pill ${asu.installed ? 'online' : ''}" style="font-size: 11px;">
              ${asu.installed
                ? `Attended Sysupgrade Installed (${escapeHtml(asu.packages?.map((p) => p.name).join(', ') || asu.cliTool || 'auc')})`
                : 'Attended Sysupgrade Package Not Installed'}
            </span>
          </div>
          <div style="font-size: 13px; font-weight: 600; margin-top: 8px; color: var(--color-text-primary);">
            ${escapeHtml(asu.advisory || `Running ${host.firmware || 'OpenWrt'}`)}
          </div>
          <div style="font-size: 11.5px; color: var(--color-text-secondary); margin-top: 4px; font-family: var(--font-mono);">
            Current: ${escapeHtml(asu.currentVersion || host.firmware || 'OpenWrt')}${asu.currentRevision ? ` (${escapeHtml(asu.currentRevision)})` : ''}
            ${asu.target ? ` • Target: ${escapeHtml(asu.target)}` : ''}
            ${asu.boardName ? ` • Board: ${escapeHtml(asu.boardName)}` : ''}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          ${!asu.installed
            ? `<button type="button" class="btn btn-primary" id="asu-install-btn" style="font-size: 12px;" ${isJobRunning ? 'disabled' : ''}>
                ${renderIcon('download', 'icon icon-sm')} Install Attended Sysupgrade
              </button>`
            : `<button type="button" class="btn btn-secondary" id="asu-check-btn" style="font-size: 12px;" ${isJobRunning ? 'disabled' : ''}>
                ${renderIcon('refresh', 'icon icon-sm')} Check ASU Server
              </button>`}
          ${fwAvailable && asu.installed
            ? `<button type="button" class="btn btn-primary" id="asu-upgrade-btn" style="font-size: 12px;" ${isJobRunning ? 'disabled' : ''}>
                ${renderIcon('zap', 'icon icon-sm')} Upgrade Firmware (${escapeHtml(availFwVer)})
              </button>`
            : ''}
        </div>
      </div>
    </div>

    <!-- Section 2: Package Updates Toolbar & Table -->
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
      <div>
        <div style="font-weight: 600; font-size: 14px;">
          Upgradable Software Packages (${packages.length})
        </div>
        <div style="font-size: 11.5px; color: var(--color-text-muted);">
          ${updates.lastChecked ? `Last checked ${formatRelativeTime(updates.lastChecked)}` : 'Click "Refresh Package Lists" to run opkg update on this router'}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button type="button" class="btn btn-secondary" id="pkg-refresh-btn" style="font-size: 12px;" ${isJobRunning ? 'disabled' : ''}>
          ${renderIcon('refresh', 'icon icon-sm')} Refresh Package Lists (opkg update)
        </button>
        <button type="button" class="btn btn-primary" id="pkg-upgrade-all-btn" style="font-size: 12px;" ${packages.length === 0 || isJobRunning ? 'disabled' : ''}>
          ${isJobRunning
            ? `<progress class="loading-spinner" style="width: 12px; height: 12px; --spinner-width: 2px; --spinner-color-fg: #fff;" aria-label="Upgrading packages"></progress> Upgrading in Background...`
            : `${renderIcon('download', 'icon icon-sm')} Update All Packages (${packages.length})`}
        </button>
      </div>
    </div>

    <div style="border: 1px solid var(--color-border); border-radius: var(--radius-md); max-height: 260px; overflow-y: auto;">
      <table class="data-table" style="font-size: 12.5px;">
        <thead>
          <tr>
            <th>Package Name</th>
            <th>Installed Version</th>
            <th>Available Version</th>
            <th>Category</th>
            <th style="text-align: right;">Status / Action</th>
          </tr>
        </thead>
        <tbody>
          ${packages.length > 0
            ? packages
                .map((pkg) => {
                  const isCompletedPkg = Array.isArray(activeJob?.completedPackages) && activeJob.completedPackages.includes(pkg.name);
                  const isCurrentPkg = isJobRunning && activeJob?.currentPackage === pkg.name;
                  const isQueuedPkg =
                    isJobRunning && Array.isArray(activeJob?.targetPackages) && activeJob.targetPackages.includes(pkg.name);

                  let actionCellHtml = `
                    <button type="button" class="btn btn-secondary btn-upgrade-single-pkg" data-pkg-name="${escapeHtml(pkg.name)}" style="height: 26px; padding: 0 10px; font-size: 11.5px;" ${isJobRunning ? 'disabled' : ''}>
                      Update
                    </button>
                  `;
                  if (isCompletedPkg) {
                    actionCellHtml = `<span class="status-pill success" style="font-size: 10.5px; padding: 2px 8px;">✓ Updated</span>`;
                  } else if (isCurrentPkg) {
                    actionCellHtml = `
                      <span class="status-pill info" style="font-size: 10.5px; padding: 2px 8px; display: inline-flex; align-items: center; gap: 5px;">
                        <progress class="loading-spinner" style="width: 11px; height: 11px; --spinner-width: 2px;" aria-label="Upgrading ${escapeHtml(pkg.name)}"></progress>
                        Upgrading...
                      </span>
                    `;
                  } else if (isQueuedPkg) {
                    actionCellHtml = `<span class="status-pill" style="font-size: 10.5px; padding: 2px 8px;">Queued</span>`;
                  }

                  return `
            <tr>
              <td class="font-mono" style="font-weight: 600;">${escapeHtml(pkg.name)}</td>
              <td class="font-mono" style="color: var(--color-text-secondary);">${escapeHtml(pkg.currentVersion)}</td>
              <td class="font-mono" style="color: var(--color-success); font-weight: 600;">${escapeHtml(pkg.newVersion)}</td>
              <td>
                <span class="status-pill ${pkg.isSecurityOrCore ? 'warning' : 'info'}" style="font-size: 10.5px; padding: 1px 7px;">
                  ${pkg.isSecurityOrCore ? 'Core / Security' : 'Package'}
                </span>
              </td>
              <td style="text-align: right;" data-pkg-action-cell="${escapeHtml(pkg.name)}">
                ${actionCellHtml}
              </td>
            </tr>
          `;
                })
                .join('')
            : `
            <tr>
              <td colspan="5" style="text-align: center; padding: 24px; color: var(--color-text-secondary);">
                All installed packages on ${escapeHtml(host.name || host.hostname)} are up to date.
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>

    <!-- Section 3: Live Streaming SSH Package / Attended Sysupgrade Output Console -->
    <div id="updates-log-wrapper" style="display: ${effectiveOutput ? 'block' : 'none'};">
      <div style="font-size: 11.5px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 4px; text-transform: uppercase;">
        Live Router Upgrade Output
      </div>
      <pre id="updates-command-log" style="background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 10px 12px; font-family: var(--font-mono); font-size: 11.5px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; color: var(--color-text-primary);">${escapeHtml(effectiveOutput)}</pre>
    </div>
  `;

  if (!dialog.open) {
    openModal(dialog);
  }

  // Wire Refresh Package Lists (`opkg update`)
  const refreshBtn = bodyEl.querySelector('#pkg-refresh-btn');
  refreshBtn?.addEventListener('click', async () => {
    try {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = `${renderIcon('refresh', 'icon icon-sm')} Running opkg update...`;
      const res = await api.checkHostUpdates(hostId);
      await store.poll(true);
      if (container) renderHosts(container);
      openHostUpdatesModal(container, hostId, res.output || 'Package lists updated.');
      toast.success('Updates Checked', `Found ${res.updates?.packagesCount || 0} upgradable packages.`);
    } catch (err) {
      toast.error('Check Failed', err.message);
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `${renderIcon('refresh', 'icon icon-sm')} Refresh Package Lists (opkg update)`;
    }
  });

  // Wire Update All Packages (Background Job)
  const upgradeAllBtn = bodyEl.querySelector('#pkg-upgrade-all-btn');
  upgradeAllBtn?.addEventListener('click', async () => {
    try {
      upgradeAllBtn.disabled = true;
      const res = await api.upgradeHostPackages(hostId, 'all');
      toast.info(
        'Upgrade Running in Background',
        `Upgrading ${packages.length || 'all'} package(s) on ${host.name || host.hostname}. Progress is tracked live.`
      );
      await store.pollUpgradeProgress();
      store.syncFastUpgradePolling();
      openHostUpdatesModal(container, hostId, res?.job?.output || '');
    } catch (err) {
      toast.error('Package Upgrade Failed', err.message);
      upgradeAllBtn.disabled = false;
    }
  });

  // Wire Individual Package Update Buttons (Background Job)
  bodyEl.querySelectorAll('.btn-upgrade-single-pkg').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pkgName = btn.getAttribute('data-pkg-name');
      if (!pkgName) return;
      try {
        btn.disabled = true;
        const res = await api.upgradeHostPackages(hostId, [pkgName]);
        toast.info('Package Upgrade Started', `Upgrading ${pkgName} in the background on ${host.name || host.hostname}...`);
        await store.pollUpgradeProgress();
        store.syncFastUpgradePolling();
        openHostUpdatesModal(container, hostId, res?.job?.output || '');
      } catch (err) {
        toast.error(`Failed to update ${pkgName}`, err.message);
        btn.disabled = false;
      }
    });
  });

  // Wire Install Attended Sysupgrade (`auc` + `luci-app-attendedsysupgrade`) in Background
  const asuInstallBtn = bodyEl.querySelector('#asu-install-btn');
  asuInstallBtn?.addEventListener('click', async () => {
    try {
      asuInstallBtn.disabled = true;
      const res = await api.runAttendedSysupgrade(hostId, 'install');
      toast.info(
        'Installing Attended Sysupgrade',
        `Background installation of auc and luci-app-attendedsysupgrade started on ${host.name || host.hostname}.`
      );
      await store.pollUpgradeProgress();
      store.syncFastUpgradePolling();
      openHostUpdatesModal(container, hostId, res?.job?.output || '');
    } catch (err) {
      toast.error('Installation Failed', err.message);
      asuInstallBtn.disabled = false;
    }
  });

  // Wire Check ASU Server (`auc -n` / `owut check`)
  const asuCheckBtn = bodyEl.querySelector('#asu-check-btn');
  asuCheckBtn?.addEventListener('click', async () => {
    try {
      asuCheckBtn.disabled = true;
      asuCheckBtn.textContent = 'Querying ASU Server...';
      const res = await api.runAttendedSysupgrade(hostId, 'check');
      await store.poll(true);
      if (container) renderHosts(container);
      openHostUpdatesModal(container, hostId, res.output || 'Attended Sysupgrade check completed.');
      toast.success('Attended Sysupgrade Checked', res.updates?.attendedSysupgrade?.advisory || 'Firmware status verified.');
    } catch (err) {
      toast.error('ASU Check Failed', err.message);
      asuCheckBtn.disabled = false;
      asuCheckBtn.textContent = 'Check ASU Server';
    }
  });

  // Wire Upgrade Firmware via Attended Sysupgrade (`auc -y` / `owut upgrade`) in Background
  const asuUpgradeBtn = bodyEl.querySelector('#asu-upgrade-btn');
  asuUpgradeBtn?.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: `Attended Sysupgrade to OpenWrt ${availFwVer}`,
      message: `This will automatically take a TrueNAS configuration backup of ${host.name || host.hostname}, request a custom sysupgrade image with all your installed packages from ${asu.serverUrl || 'sysupgrade.openwrt.org'}, and flash the router in the background. Proceed?`,
      confirmLabel: `Backup & Upgrade to ${availFwVer}`,
      isDestructive: false
    });
    if (!confirmed) return;

    try {
      asuUpgradeBtn.disabled = true;
      const res = await api.runAttendedSysupgrade(hostId, 'upgrade');
      toast.info(
        'Attended Sysupgrade Running in Background',
        `Building and flashing OpenWrt ${availFwVer} on ${host.name || host.hostname}.`
      );
      await store.pollUpgradeProgress();
      store.syncFastUpgradePolling();
      openHostUpdatesModal(container, hostId, res?.job?.output || '');
    } catch (err) {
      toast.error('Attended Sysupgrade Failed', err.message);
      asuUpgradeBtn.disabled = false;
    }
  });
}

function resetPasswordVisibility() {
  const passInput = document.getElementById('host-password-input');
  if (passInput) passInput.type = 'password';
  const togglePassBtn = document.getElementById('host-toggle-pass-btn');
  if (togglePassBtn) {
    togglePassBtn.setAttribute('aria-label', 'Show password');
    const label = togglePassBtn.querySelector('.pass-toggle-label');
    if (label) label.textContent = 'Show';
  }
}

function resetHostForm() {
  const form = document.getElementById('host-form');
  if (!form) return;
  form.reset();
  document.getElementById('host-id-input').value = '';
  document.getElementById('host-modal-title').textContent = 'Add OpenWrt Node';
  resetPasswordVisibility();
  const fb = document.getElementById('host-test-feedback');
  if (fb) fb.style.display = 'none';
}
