/**
 * OpenWrt Manager (openwrt-managor)
 * Application Settings, Hermes & Agent REST API Controls, and Retention Policies
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { renderIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/formatters.js';

export function renderSettings(container) {
  const { health, settings } = store.state;
  const origin = window.location.origin;
  const agentApi = settings?.agentApi || { enabled: true, requireApiKey: false, apiKey: '' };

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>System Settings &amp; Agent API</h1>
        <p>Hermes &amp; external agent REST API integration, TrueNAS storage retention, and NOC preferences</p>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: var(--space-5); max-width: 880px;">
      <!-- Hermes & External Agent REST API Integration Card -->
      <div class="chart-card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 34px; height: 34px; border-radius: var(--radius-md); background: var(--color-primary-light); color: var(--color-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              ${renderIcon('terminal', 'icon icon-md')}
            </div>
            <div>
              <h2 style="font-size: 15px; font-weight: 600;">Hermes &amp; Agent REST API</h2>
              <div style="font-size: 12px; color: var(--color-text-secondary);">
                Structured REST &amp; OpenAPI 3.1 endpoints for Hermes and AI/automation agents to query OpenWrt host status
              </div>
            </div>
          </div>
          <span class="status-pill ${agentApi.enabled !== false ? 'online' : 'offline'}">
            <span class="status-dot ${agentApi.enabled !== false ? 'online' : 'offline'}"></span>
            ${agentApi.enabled !== false ? (agentApi.requireApiKey ? 'Active (API Key Required)' : 'Active (Open on LAN)') : 'Disabled'}
          </span>
        </div>

        <div class="form-row-2col" style="margin-top: 12px;">
          <div class="form-group">
            <label class="form-label" for="agent-api-auth-select">Authentication Mode</label>
            <select class="form-select" id="agent-api-auth-select">
              <option value="open" ${!agentApi.requireApiKey ? 'selected' : ''}>Open on Local Network (No Key Required)</option>
              <option value="key" ${agentApi.requireApiKey ? 'selected' : ''}>Require API Key (Bearer / X-API-Key)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="agent-api-key-input">Agent API Key</label>
            <div style="display: flex; gap: 6px;">
              <input type="text" id="agent-api-key-input" class="form-input font-mono" value="${escapeHtml(agentApi.apiKey || '')}" placeholder="Click Generate to create an API key" readonly />
              <button type="button" class="btn btn-secondary" id="agent-key-regen-btn" title="Generate new API key">
                ${renderIcon('refresh', 'icon icon-sm')} Generate
              </button>
              <button type="button" class="btn btn-secondary" id="agent-key-copy-btn" title="Copy API key">
                Copy
              </button>
            </div>
          </div>
        </div>

        <!-- Agent Discovery & Status Endpoints Reference -->
        <div style="margin-top: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden;">
          <table class="data-table" style="font-size: 12px;">
            <thead>
              <tr>
                <th>Method</th>
                <th>Endpoint</th>
                <th>Description for Hermes / Agents</th>
                <th style="text-align: right;">Copy URL</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/agent/status</td>
                <td>Complete fleet snapshot: summary, alerts, all hosts CPU/RAM/uptime, updates, WiFi &amp; backups</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/status" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/agent/hosts</td>
                <td>List &amp; filter OpenWrt hosts (<code>?q=</code>, <code>?status=online</code>, <code>?role=ap</code>, <code>?updates=true</code>)</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/hosts" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/agent/hosts/{idOrName}</td>
                <td>Query single host by ID, display name, hostname, IP, or MAC (add <code>?refresh=true</code> for live SSH poll)</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/hosts/" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill info" style="font-size: 10.5px; padding: 1px 6px;">POST</span></td>
                <td class="font-mono">/api/agent/hosts/{idOrName}/poll</td>
                <td>Force an immediate live SSH telemetry poll on a specific host or <code>all</code></td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/hosts/all/poll" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/agent/clients</td>
                <td>Connected wireless &amp; wired clients with DHCP IPs, manufacturers, and WiFi signal strength</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/clients" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/agent/updates</td>
                <td>Available package updates, Attended Sysupgrade firmware advisories, and active upgrade jobs</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/agent/updates" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
              <tr>
                <td><span class="status-pill success" style="font-size: 10.5px; padding: 1px 6px;">GET</span></td>
                <td class="font-mono">/api/openapi.json</td>
                <td>OpenAPI 3.1.0 specification &amp; <code>/api/agent/manifest</code> tool definitions for Hermes</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-copy-endpoint" data-url="${escapeHtml(origin)}/api/openapi.json" style="height: 24px; padding: 0 8px; font-size: 11px;">Copy</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary" id="agent-test-status-btn" style="font-size: 12px;">
            ${renderIcon('zap', 'icon icon-sm')} Test Agent Status API (/api/agent/status)
          </button>
          <span class="form-hint">Also accessible under <code>/api/v1/status</code> and <code>/api/v1/hosts</code>.</span>
        </div>

        <pre id="agent-api-preview" style="display: none; margin-top: 10px; background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 10px 12px; font-family: var(--font-mono); font-size: 11.5px; max-height: 220px; overflow-y: auto; white-space: pre-wrap; color: var(--color-text-primary);"></pre>
      </div>

      <!-- Theme & Appearance (modern-web-guidance dark-mode-toggle) -->
      <div class="chart-card">
        <h2 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">Appearance &amp; NOC Color Scheme</h2>
        <div class="form-group">
          <label class="form-label">Theme Preference</label>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-secondary theme-choice-btn" data-theme="dark">
              ${renderIcon('moon', 'icon')} NOC Dark Theme (Default)
            </button>
            <button type="button" class="btn btn-secondary theme-choice-btn" data-theme="light">
              ${renderIcon('sun', 'icon')} Light Theme
            </button>
            <button type="button" class="btn btn-secondary theme-choice-btn" data-theme="system">
              ${renderIcon('settings', 'icon')} Follow System OS
            </button>
          </div>
          <span class="form-hint">Reflected directly via native &lt;meta name="color-scheme"&gt; and CSS light-dark() tokens.</span>
        </div>
      </div>

      <!-- TrueNAS Volume & Retention Settings -->
      <div class="chart-card">
        <h2 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">TrueNAS Backup &amp; Storage Retention</h2>
        <div class="form-row-2col">
          <div class="form-group">
            <label class="form-label">Persistent Data Directory</label>
            <input type="text" class="form-input font-mono" value="${escapeHtml(health?.storage?.dataDir || '/data')}" readonly />
          </div>
          <div class="form-group">
            <label class="form-label">Persistent Backups Mount</label>
            <input type="text" class="form-input font-mono" value="${escapeHtml(health?.storage?.backupDir || '/backups')}" readonly />
          </div>
        </div>

        <div class="form-row-2col" style="margin-top: 14px;">
          <div class="form-group">
            <label class="form-label">GFS Config Backup Retention (Daily / Weekly / Monthly / Yearly)</label>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
              <div>
                <label class="form-label" for="settings-keep-daily" style="font-size: 11px;">Daily</label>
                <input type="number" id="settings-keep-daily" class="form-input" min="0" max="365" value="${settings?.retention?.keepDaily ?? 7}" />
              </div>
              <div>
                <label class="form-label" for="settings-keep-weekly" style="font-size: 11px;">Weekly</label>
                <input type="number" id="settings-keep-weekly" class="form-input" min="0" max="104" value="${settings?.retention?.keepWeekly ?? 4}" />
              </div>
              <div>
                <label class="form-label" for="settings-keep-monthly" style="font-size: 11px;">Monthly</label>
                <input type="number" id="settings-keep-monthly" class="form-input" min="0" max="120" value="${settings?.retention?.keepMonthly ?? 6}" />
              </div>
              <div>
                <label class="form-label" for="settings-keep-yearly" style="font-size: 11px;">Yearly</label>
                <input type="number" id="settings-keep-yearly" class="form-input" min="0" max="20" value="${settings?.retention?.keepYearly ?? 1}" />
              </div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-poll-select">Standard Poll Interval (Multi-Core)</label>
            <select class="form-select" id="settings-poll-select">
              <option value="5000" ${settings?.pollIntervalMs === 5000 ? 'selected' : ''}>5 seconds (High Frequency)</option>
              <option value="10000" ${!settings?.pollIntervalMs || settings?.pollIntervalMs === 10000 ? 'selected' : ''}>10 seconds (Standard)</option>
              <option value="30000" ${settings?.pollIntervalMs === 30000 ? 'selected' : ''}>30 seconds (Low Resource)</option>
            </select>
            <span class="form-hint">Default dynamic polling rate for multi-core routers &amp; APs.</span>
          </div>
        </div>

        <div class="form-row-2col" style="margin-top: 10px;">
          <div class="form-group">
            <label class="form-label" for="settings-single-core-poll-select">Single-Core Device Poll Interval (Managed Switches)</label>
            <select class="form-select" id="settings-single-core-poll-select">
              <option value="30000" ${settings?.singleCorePollIntervalMs === 30000 ? 'selected' : ''}>30 seconds (Moderate Relief)</option>
              <option value="60000" ${!settings?.singleCorePollIntervalMs || settings?.singleCorePollIntervalMs === 60000 ? 'selected' : ''}>60 seconds (Recommended for Single-Core Switches)</option>
              <option value="120000" ${settings?.singleCorePollIntervalMs === 120000 ? 'selected' : ''}>120 seconds (Ultra-Low CPU Impact)</option>
              <option value="300000" ${settings?.singleCorePollIntervalMs === 300000 ? 'selected' : ''}>300 seconds (5 Minutes)</option>
            </select>
            <span class="form-hint">Automatically applied to devices detected with 1 CPU core (e.g. single-core managed switches). Manual Refresh still updates immediately.</span>
          </div>
        </div>

        <div style="margin-top: 16px; text-align: right;">
          <button type="button" class="btn btn-primary" id="settings-save-btn">Save Settings</button>
        </div>
      </div>
    </div>
  `;

  // Attach Theme Choice Buttons
  container.querySelectorAll('.theme-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme');
      applyTheme(theme);
      toast.success('Theme Updated', `Switched theme preference to ${theme}`);
    });
  });

  // Copy Endpoint URL Buttons
  container.querySelectorAll('.btn-copy-endpoint').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Copied URL', url);
      } catch {
        toast.info('Endpoint URL', url);
      }
    });
  });

  // Generate / Regenerate Agent API Key
  container.querySelector('#agent-key-regen-btn')?.addEventListener('click', async () => {
    try {
      const res = await api.regenerateAgentApiKey();
      const input = container.querySelector('#agent-api-key-input');
      if (input && res?.apiKey) {
        input.value = res.apiKey;
      }
      await store.poll(true);
      toast.success('API Key Generated', 'New Hermes / Agent API key saved.');
    } catch (err) {
      toast.error('Failed to Generate Key', err.message);
    }
  });

  // Copy Agent API Key
  container.querySelector('#agent-key-copy-btn')?.addEventListener('click', async () => {
    const val = container.querySelector('#agent-api-key-input')?.value;
    if (!val) {
      toast.info('No API Key Set', 'Click Generate first to create an Agent API key.');
      return;
    }
    try {
      await navigator.clipboard.writeText(val);
      toast.success('API Key Copied', 'Copied to clipboard.');
    } catch {
      toast.info('Agent API Key', val);
    }
  });

  // Test Agent Status API Preview
  container.querySelector('#agent-test-status-btn')?.addEventListener('click', async () => {
    const pre = container.querySelector('#agent-api-preview');
    if (!pre) return;
    pre.style.display = 'block';
    pre.textContent = 'Querying GET /api/agent/status...';
    try {
      const currentKey = container.querySelector('#agent-api-key-input')?.value || '';
      const data = await api.getAgentStatus(currentKey);
      pre.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      pre.textContent = `Error: ${err.message}`;
    }
  });

  // Save Settings
  container.querySelector('#settings-save-btn')?.addEventListener('click', async () => {
    const pollInterval = parseInt(container.querySelector('#settings-poll-select')?.value || '10000', 10);
    const singleCorePollInterval = parseInt(
      container.querySelector('#settings-single-core-poll-select')?.value || '60000',
      10
    );
    const keepDaily = Math.max(0, parseInt(container.querySelector('#settings-keep-daily')?.value || '7', 10) || 7);
    const keepWeekly = Math.max(0, parseInt(container.querySelector('#settings-keep-weekly')?.value || '4', 10) || 4);
    const keepMonthly = Math.max(0, parseInt(container.querySelector('#settings-keep-monthly')?.value || '6', 10) || 6);
    const keepYearly = Math.max(0, parseInt(container.querySelector('#settings-keep-yearly')?.value || '1', 10) || 1);
    const maxBackups = keepDaily + keepWeekly + keepMonthly + keepYearly;
    const requireApiKey = container.querySelector('#agent-api-auth-select')?.value === 'key';
    const apiKey = container.querySelector('#agent-api-key-input')?.value || '';

    try {
      const updated = await api.updateSettings({
        pollIntervalMs: pollInterval,
        singleCorePollIntervalMs: singleCorePollInterval,
        retention: {
          keepDaily,
          keepWeekly,
          keepMonthly,
          keepYearly,
          maxBackupsPerHost: maxBackups,
          maxAgeDays: 365,
          minRetainedPerHost: 1
        },
        agentApi: {
          enabled: true,
          requireApiKey,
          apiKey
        }
      });
      if (updated?.agentApi?.apiKey) {
        const keyInput = container.querySelector('#agent-api-key-input');
        if (keyInput) keyInput.value = updated.agentApi.apiKey;
      }
      await store.poll(true);
      store.startPolling(pollInterval);
      renderSettings(container);
      toast.success('Settings Saved', 'Agent API, retention policies, and polling frequencies updated.');
    } catch (err) {
      toast.error('Save Failed', err.message);
    }
  });
}

function applyTheme(theme) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (theme === 'system') {
    localStorage.removeItem('color-scheme');
    if (meta) meta.content = 'dark light';
  } else {
    localStorage.setItem('color-scheme', theme);
    if (meta) meta.content = theme;
  }
}
