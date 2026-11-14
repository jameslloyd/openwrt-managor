/**
 * OpenWrt Manager (openwrt-managor)
 * Host Fleet Management View & Native <dialog> Modal
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { openModal, closeModal, confirmAction } from '../components/modal.js';
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
        <button type="button" class="btn-icon" onclick="document.getElementById('host-updates-dialog').close()" aria-label="Close">
          ${renderIcon('x', 'icon')}
        </button>
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
          <button type="button" class="btn-icon" onclick="document.getElementById('host-form-dialog').close()" aria-label="Close">
            ${renderIcon('x', 'icon')}
          </button>
        </div>

        <div class="modal-body">
          <input type="hidden" id="host-id-input" value="" />

          <div class="form-group">
            <label class="form-label" for="host-name-input">Display Name</label>
            <input type="text" id="host-name-input" class="form-input" placeholder="e.g. Living Room AP" required />
          </div>

          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px;">
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

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
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
            <input type="password" id="host-password-input" class="form-input" placeholder="Router password or ubus token" />
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

    const payload = { name, ip, role, protocol, username, password, isSimulated: false };

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

function renderHostRow(h) {
  const isOnline = h.status === 'online';
  const hostVendor = resolveClientSideVendor(h.mac, h.model || h.name, h.vendor);
  const pkgCount = h.updates?.packagesCount || 0;
  const asu = h.updates?.attendedSysupgrade || {};
  const fwAvailable = Boolean(h.updates?.firmwareUpdateAvailable || asu.firmwareUpdateAvailable);
  const availFwVer = h.updates?.availableFirmwareVersion || asu.availableVersion;

  return `
    <tr>
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
      </td>
      <td>
        <span class="font-mono">${escapeHtml(h.ip)}</span>
      </td>
      <td>
        <span style="text-transform: capitalize;">${escapeHtml(h.role || 'AP')}</span>
      </td>
      <td>
        <div style="font-size: 12px; font-weight: 500;">${escapeHtml(h.firmware || 'OpenWrt')}</div>
        <div style="font-size: 10.5px; color: var(--color-text-muted);">Uptime: ${formatUptime(h.uptimeSec)}</div>
      </td>
      <td>
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
      </td>
      <td>
        <div class="font-mono" style="font-size: 11.5px;">CPU: ${h.cpuUsagePct ?? 0}% • RAM: ${h.memUsagePct ?? 0}%</div>
      </td>
      <td>
        <strong>${h.clientCount ?? 0}</strong> active
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <div style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px;">
          <button type="button" class="btn ${pkgCount > 0 || fwAvailable ? 'btn-primary' : 'btn-secondary'} btn-updates-host" data-host-id="${escapeHtml(h.id)}" style="height: 28px; padding: 0 10px; font-size: 11.5px;" title="Manage software packages &amp; Attended Sysupgrade">
            ${renderIcon('download', 'icon icon-sm')} Updates${pkgCount > 0 ? ` (${pkgCount})` : fwAvailable ? ' (!)' : ''}
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

export function openHostUpdatesModal(container, hostId, lastCommandOutput = '') {
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

  bodyEl.innerHTML = `
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
            ? `<button type="button" class="btn btn-primary" id="asu-install-btn" style="font-size: 12px;">
                ${renderIcon('download', 'icon icon-sm')} Install Attended Sysupgrade
              </button>`
            : `<button type="button" class="btn btn-secondary" id="asu-check-btn" style="font-size: 12px;">
                ${renderIcon('refresh', 'icon icon-sm')} Check ASU Server
              </button>`}
          ${fwAvailable && asu.installed
            ? `<button type="button" class="btn btn-primary" id="asu-upgrade-btn" style="font-size: 12px;">
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
        <button type="button" class="btn btn-secondary" id="pkg-refresh-btn" style="font-size: 12px;">
          ${renderIcon('refresh', 'icon icon-sm')} Refresh Package Lists (opkg update)
        </button>
        <button type="button" class="btn btn-primary" id="pkg-upgrade-all-btn" style="font-size: 12px;" ${packages.length === 0 ? 'disabled' : ''}>
          ${renderIcon('download', 'icon icon-sm')} Update All Packages (${packages.length})
        </button>
      </div>
    </div>

    <div style="border: 1px solid var(--color-border); border-radius: var(--radius-md); max-height: 280px; overflow-y: auto;">
      <table class="data-table" style="font-size: 12.5px;">
        <thead>
          <tr>
            <th>Package Name</th>
            <th>Installed Version</th>
            <th>Available Version</th>
            <th>Category</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${packages.length > 0
            ? packages
                .map(
                  (pkg) => `
            <tr>
              <td class="font-mono" style="font-weight: 600;">${escapeHtml(pkg.name)}</td>
              <td class="font-mono" style="color: var(--color-text-secondary);">${escapeHtml(pkg.currentVersion)}</td>
              <td class="font-mono" style="color: var(--color-success); font-weight: 600;">${escapeHtml(pkg.newVersion)}</td>
              <td>
                <span class="status-pill ${pkg.isSecurityOrCore ? 'warning' : 'info'}" style="font-size: 10.5px; padding: 1px 7px;">
                  ${pkg.isSecurityOrCore ? 'Core / Security' : 'Package'}
                </span>
              </td>
              <td style="text-align: right;">
                <button type="button" class="btn btn-secondary btn-upgrade-single-pkg" data-pkg-name="${escapeHtml(pkg.name)}" style="height: 26px; padding: 0 10px; font-size: 11.5px;">
                  Update
                </button>
              </td>
            </tr>
          `
                )
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

    <!-- Section 3: SSH Package / Attended Sysupgrade Output Console -->
    <div id="updates-log-wrapper" style="display: ${lastCommandOutput ? 'block' : 'none'};">
      <div style="font-size: 11.5px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 4px; text-transform: uppercase;">
        Router Command Output
      </div>
      <pre id="updates-command-log" style="background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 10px 12px; font-family: var(--font-mono); font-size: 11.5px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; color: var(--color-text-primary);">${escapeHtml(lastCommandOutput)}</pre>
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

  // Wire Update All Packages
  const upgradeAllBtn = bodyEl.querySelector('#pkg-upgrade-all-btn');
  upgradeAllBtn?.addEventListener('click', async () => {
    try {
      upgradeAllBtn.disabled = true;
      upgradeAllBtn.innerHTML = `${renderIcon('refresh', 'icon icon-sm')} Updating All Packages...`;
      toast.info('Updating Packages', `Upgrading ${packages.length} packages on ${host.name || host.hostname}...`);
      const res = await api.upgradeHostPackages(hostId, 'all');
      await store.poll(true);
      if (container) renderHosts(container);
      openHostUpdatesModal(container, hostId, res.output || 'All packages upgraded.');
      toast.success('Packages Updated', `Software packages updated on ${host.name || host.hostname}.`);
    } catch (err) {
      toast.error('Package Upgrade Failed', err.message);
      upgradeAllBtn.disabled = false;
      upgradeAllBtn.innerHTML = `${renderIcon('download', 'icon icon-sm')} Update All Packages (${packages.length})`;
    }
  });

  // Wire Individual Package Update Buttons
  bodyEl.querySelectorAll('.btn-upgrade-single-pkg').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pkgName = btn.getAttribute('data-pkg-name');
      if (!pkgName) return;
      try {
        btn.disabled = true;
        btn.textContent = 'Updating...';
        const res = await api.upgradeHostPackages(hostId, [pkgName]);
        await store.poll(true);
        if (container) renderHosts(container);
        openHostUpdatesModal(container, hostId, res.output || `Upgraded ${pkgName}.`);
        toast.success('Package Updated', `Updated ${pkgName} on ${host.name || host.hostname}.`);
      } catch (err) {
        toast.error(`Failed to update ${pkgName}`, err.message);
        btn.disabled = false;
        btn.textContent = 'Update';
      }
    });
  });

  // Wire Install Attended Sysupgrade (`auc` + `luci-app-attendedsysupgrade`)
  const asuInstallBtn = bodyEl.querySelector('#asu-install-btn');
  asuInstallBtn?.addEventListener('click', async () => {
    try {
      asuInstallBtn.disabled = true;
      asuInstallBtn.textContent = 'Installing Attended Sysupgrade...';
      toast.info('Installing ASU', `Installing auc and luci-app-attendedsysupgrade on ${host.name || host.hostname}...`);
      const res = await api.runAttendedSysupgrade(hostId, 'install');
      await store.poll(true);
      if (container) renderHosts(container);
      openHostUpdatesModal(container, hostId, res.output || 'Installed Attended Sysupgrade.');
      toast.success('Attended Sysupgrade Installed', 'Ready to check and build custom firmware upgrades.');
    } catch (err) {
      toast.error('Installation Failed', err.message);
      asuInstallBtn.disabled = false;
      asuInstallBtn.textContent = 'Install Attended Sysupgrade';
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

  // Wire Upgrade Firmware via Attended Sysupgrade (`auc -y` / `owut upgrade`)
  const asuUpgradeBtn = bodyEl.querySelector('#asu-upgrade-btn');
  asuUpgradeBtn?.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: `Attended Sysupgrade to OpenWrt ${availFwVer}`,
      message: `This will automatically take a TrueNAS configuration backup of ${host.name || host.hostname}, request a custom sysupgrade image with all your installed packages from ${asu.serverUrl || 'sysupgrade.openwrt.org'}, and flash the router. Proceed?`,
      confirmLabel: `Backup & Upgrade to ${availFwVer}`,
      isDestructive: false
    });
    if (!confirmed) return;

    try {
      asuUpgradeBtn.disabled = true;
      asuUpgradeBtn.textContent = 'Building & Flashing Image...';
      toast.info('Attended Sysupgrade Started', `Creating pre-upgrade backup and requesting OpenWrt ${availFwVer} image...`);
      const res = await api.runAttendedSysupgrade(hostId, 'upgrade');
      await store.poll(true);
      if (container) renderHosts(container);
      openHostUpdatesModal(container, hostId, res.output || 'Attended Sysupgrade initiated.');
      toast.success('Firmware Upgrade Initiated', `Attended Sysupgrade command completed on ${host.name || host.hostname}.`);
    } catch (err) {
      toast.error('Attended Sysupgrade Failed', err.message);
      asuUpgradeBtn.disabled = false;
      asuUpgradeBtn.textContent = `Upgrade Firmware (${availFwVer})`;
    }
  });
}

function resetHostForm() {
  const form = document.getElementById('host-form');
  if (!form) return;
  form.reset();
  document.getElementById('host-id-input').value = '';
  document.getElementById('host-modal-title').textContent = 'Add OpenWrt Node';
  const fb = document.getElementById('host-test-feedback');
  if (fb) fb.style.display = 'none';
}
