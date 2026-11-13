/**
 * OpenWrt Manager (openwrt-managor)
 * WiFi APs & Channel Coverage Analyzer View
 */

import { store } from '../store.js';
import { SpectrumChart } from '../charts/spectrum-chart.js';
import { renderIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/formatters.js';

let chartInstance = null;
let activeBand = '5GHz';

export function renderWifi(container) {
  const { wifiChannels, wifiInterference } = store.state;
  const bands = wifiChannels?.bands || {};
  const currentBandData = bands[activeBand] || { radios: [], noiseFloorDbm: -95 };
  const warnings = wifiInterference?.warnings || [];

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>WiFi APs & Channel Coverage Analyzer</h1>
        <p>RF frequency spectrum visualizer and automated co-channel interference detection</p>
      </div>
      <div class="view-actions">
        <span class="status-pill ${warnings.length > 0 ? 'warning' : 'success'}">
          <span class="status-dot ${warnings.length > 0 ? 'warning' : 'success'}"></span>
          ${warnings.length > 0 ? `${warnings.length} Channel Conflict(s)` : 'All Channels Optimal'}
        </span>
      </div>
    </div>

    <div class="spectrum-container">
      <!-- Frequency Band Tabs -->
      <div class="band-tabs">
        <button type="button" class="band-tab-btn ${activeBand === '2.4GHz' ? 'active' : ''}" data-band="2.4GHz">
          ${renderIcon('wifi', 'icon')} 2.4 GHz (802.11b/g/n/ax)
        </button>
        <button type="button" class="band-tab-btn ${activeBand === '5GHz' ? 'active' : ''}" data-band="5GHz">
          ${renderIcon('wifi', 'icon')} 5 GHz (802.11a/n/ac/ax)
        </button>
        <button type="button" class="band-tab-btn ${activeBand === '6GHz' ? 'active' : ''}" data-band="6GHz">
          ${renderIcon('wifi', 'icon')} 6 GHz (802.11ax/be WiFi 6E/7)
        </button>
      </div>

      <!-- Interference Alert Warning Banner if conflicts exist in current band -->
      <div id="wifi-interference-mount">
        ${renderInterferenceWarnings(warnings, activeBand)}
      </div>

      <!-- SVG Spectrum Chart Card -->
      <div class="spectrum-chart-wrapper">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="font-size: 15px; font-weight: 600;">Spectrum Allocation (${activeBand})</h2>
          <span style="font-size: 12px; color: var(--color-text-muted);">Hover curves to view transmitter metrics</span>
        </div>
        <div id="wifi-spectrum-chart-mount"></div>
      </div>

      <!-- AP Radios Hardware Overview Grid -->
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <h2 style="font-size: 15px; font-weight: 600;">Managed AP Radios on ${activeBand}</h2>
        <div class="radios-grid" id="wifi-radios-mount">
          ${renderRadioCards(currentBandData.radios, warnings)}
        </div>
      </div>
    </div>
  `;

  // Instantiate SVG Spectrum Chart
  const chartMount = container.querySelector('#wifi-spectrum-chart-mount');
  chartInstance = new SpectrumChart({
    container: chartMount,
    band: activeBand,
    onRadioClick: (radio) => {
      // Find parent host and open drawer
      const host = store.state.hosts.find(h => h.id === radio.hostId);
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
            cpuUsagePct: host.cpuUsagePct,
            memUsagePct: host.memUsagePct,
            clientCount: host.clientCount
          }
        });
      }
    }
  });

  chartInstance.setData({
    radios: currentBandData.radios || [],
    noiseFloorDbm: currentBandData.noiseFloorDbm || -95,
    conflicts: warnings
  });

  // Attach Band Tab switching
  const tabBtns = container.querySelectorAll('.band-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeBand = btn.getAttribute('data-band') || '5GHz';

      const bandData = (store.state.wifiChannels?.bands || {})[activeBand] || { radios: [], noiseFloorDbm: -95 };
      chartInstance.setBand(activeBand);
      chartInstance.setData({
        radios: bandData.radios || [],
        noiseFloorDbm: bandData.noiseFloorDbm || -95,
        conflicts: store.state.wifiInterference?.warnings || []
      });

      // Update interference alert banner and radio cards
      const alertMount = container.querySelector('#wifi-interference-mount');
      if (alertMount) {
        alertMount.innerHTML = renderInterferenceWarnings(store.state.wifiInterference?.warnings || [], activeBand);
      }

      const radiosMount = container.querySelector('#wifi-radios-mount');
      if (radiosMount) {
        radiosMount.innerHTML = renderRadioCards(bandData.radios || [], store.state.wifiInterference?.warnings || []);
      }
    });
  });
}

function renderInterferenceWarnings(warnings = [], band) {
  const bandWarnings = warnings.filter(w => !w.band || w.band === band);
  if (bandWarnings.length === 0) return '';

  return bandWarnings.map(w => `
    <div class="interference-alert">
      <div class="interference-alert-icon">${renderIcon('alertTriangle', 'icon')}</div>
      <div class="interference-alert-content">
        <div class="interference-alert-title">Co-Channel Interference Detected on ${escapeHtml(w.band || band)} Channel ${w.channel}</div>
        <div class="interference-alert-desc">${escapeHtml(w.message)}</div>
      </div>
    </div>
  `).join('');
}

function renderRadioCards(radios = [], warnings = []) {
  if (!radios || radios.length === 0) {
    return `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-state-title">No Radios on this Band</div>
        <div class="empty-state-desc">None of the managed OpenWrt hosts have active wireless transmitters in this frequency range.</div>
      </div>
    `;
  }

  return radios.map(radio => {
    const isConflicted = warnings.some(w => w.affectedRadios?.includes(radio.id));
    const utilPct = radio.utilizationPct ?? 30;

    let utilClass = 'low';
    if (utilPct > 70) utilClass = 'high';
    else if (utilPct > 45) utilClass = 'medium';

    return `
      <div class="radio-card ${isConflicted ? 'has-conflict' : ''}">
        <div class="radio-card-header">
          <div>
            <div class="radio-card-title">${escapeHtml(radio.hostName)} (${escapeHtml(radio.device || 'radio0')})</div>
            <div class="radio-card-ssid">SSID: <strong>${escapeHtml(radio.ssid || 'Homelab')}</strong></div>
          </div>
          ${isConflicted ? `
            <span class="status-pill warning" title="Co-channel overlap detected">
              ${renderIcon('alertTriangle', 'icon')} Conflict
            </span>
          ` : `
            <span class="status-pill success">Optimal</span>
          `}
        </div>

        <div class="radio-stat-grid">
          <div class="radio-stat-item">
            <span class="radio-stat-label">Channel</span>
            <span class="radio-stat-val">${radio.channel} (${radio.centerFreqMhz || ''} MHz)</span>
          </div>
          <div class="radio-stat-item">
            <span class="radio-stat-label">Channel Width</span>
            <span class="radio-stat-val">${radio.widthMhz || 20} MHz</span>
          </div>
          <div class="radio-stat-item">
            <span class="radio-stat-label">Tx Power</span>
            <span class="radio-stat-val">${radio.txPowerDbm || 20} dBm (${Math.round(Math.pow(10, (radio.txPowerDbm || 20) / 10))} mW)</span>
          </div>
          <div class="radio-stat-item">
            <span class="radio-stat-label">Connected Clients</span>
            <span class="radio-stat-val">${radio.clientCount ?? 0} active</span>
          </div>
        </div>

        <div class="utilization-container">
          <div class="utilization-label-row">
            <span>Airtime Utilization</span>
            <span class="font-mono">${utilPct}%</span>
          </div>
          <div class="utilization-track">
            <div class="utilization-fill ${utilClass}" style="width: ${utilPct}%;"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
