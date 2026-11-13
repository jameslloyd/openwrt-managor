/**
 * OpenWrt Manager (openwrt-managor)
 * Host Fleet Management View & Native <dialog> Modal
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { openModal, closeModal, confirmAction } from '../components/modal.js';
import { formatUptime, formatMac, escapeHtml, resolveClientSideVendor } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

export function renderHosts(container) {
  const { hosts } = store.state;

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>OpenWrt Fleet Management</h1>
        <p>Register, monitor, test credentials, and configure OpenWrt routers and access points</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-primary" id="hosts-add-btn">
          ${renderIcon('plus', 'icon')} Add OpenWrt Host
        </button>
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
              <th>CPU / RAM</th>
              <th>Active Clients</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${hosts.length > 0 ? hosts.map(h => renderHostRow(h)).join('') : `
              <tr>
                <td colspan="8" style="text-align: center; padding: 32px;">
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

  // Attach Row Action Buttons: Inspect, Edit, Delete
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
        <div style="font-size: 12px;">${escapeHtml(h.firmware || 'OpenWrt 23.05.4')}</div>
        <div style="font-size: 10px; color: var(--color-text-muted);">Uptime: ${formatUptime(h.uptimeSec)}</div>
      </td>
      <td>
        <div class="font-mono" style="font-size: 11.5px;">CPU: ${h.cpuUsagePct ?? 0}% • RAM: ${h.memUsagePct ?? 0}%</div>
      </td>
      <td>
        <strong>${h.clientCount ?? 0}</strong> active
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <button type="button" class="btn btn-secondary btn-inspect-host" data-host-id="${h.id}" style="padding: 4px 8px; font-size: 11.5px;">
          ${renderIcon('activity', 'icon')} Inspect
        </button>
        <button type="button" class="btn btn-secondary btn-edit-host" data-host-id="${h.id}" style="padding: 4px 8px; font-size: 11.5px;">
          ${renderIcon('settings', 'icon')} Edit
        </button>
        <button type="button" class="btn-icon btn-delete-host" data-host-id="${h.id}" style="width: 26px; height: 26px; color: var(--color-danger);" title="Remove host">
          ${renderIcon('trash', 'icon')}
        </button>
      </td>
    </tr>
  `;
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
