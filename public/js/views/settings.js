/**
 * OpenWrt Manager (openwrt-managor)
 * Application Settings & Live Simulator Controls
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { renderIcon } from '../utils/icons.js';

export function renderSettings(container) {
  const { health, settings } = store.state;

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>System Settings</h1>
        <p>TrueNAS storage retention, telemetry polling rates, and NOC color scheme preferences</p>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: var(--space-5); max-width: 800px;">
      <!-- Theme & Appearance (modern-web-guidance dark-mode-toggle) -->
      <div class="chart-card">
        <h2 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">Appearance & NOC Color Scheme</h2>
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
        <h2 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">TrueNAS Backup & Storage Retention</h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label class="form-label">Persistent Data Directory</label>
            <input type="text" class="form-input font-mono" value="${health?.storage?.dataDir || '/data'}" readonly />
          </div>
          <div class="form-group">
            <label class="form-label">Persistent Backups Mount</label>
            <input type="text" class="form-input font-mono" value="${health?.storage?.backupDir || '/backups'}" readonly />
          </div>
        </div>

        <div style="margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label class="form-label" for="settings-max-archives">Max Archives Per Host</label>
            <input type="number" id="settings-max-archives" class="form-input" min="2" max="100" value="${settings?.retention?.maxBackupsPerHost || 10}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="settings-poll-select">Telemetry Poll Interval</label>
            <select class="form-select" id="settings-poll-select">
              <option value="5000">5 seconds (High Frequency)</option>
              <option value="10000" selected>10 seconds (Standard)</option>
              <option value="30000">30 seconds (Low Resource)</option>
            </select>
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

  // Save Settings
  container.querySelector('#settings-save-btn')?.addEventListener('click', async () => {
    const pollInterval = parseInt(container.querySelector('#settings-poll-select')?.value || '10000', 10);
    const maxBackups = parseInt(container.querySelector('#settings-max-archives')?.value || '10', 10);

    try {
      await api.updateSettings({
        pollIntervalMs: pollInterval,
        retention: {
          maxBackupsPerHost: maxBackups,
          maxAgeDays: 30,
          minRetainedPerHost: 2
        }
      });
      store.startPolling(pollInterval);
      toast.success('Settings Saved', 'Retention policies and polling frequencies updated.');
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
