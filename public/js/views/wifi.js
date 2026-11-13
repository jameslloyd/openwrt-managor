/**
 * OpenWrt Manager (openwrt-managor)
 * WiFi APs, Spectrum Congestion & Channel Coverage Analyzer View
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
  const bandCongestion = wifiInterference?.bandCongestion || {};
  const currentBandCongestion = bandCongestion[activeBand] || {
    radiosCount: (currentBandData.radios || []).length,
    totalClients: (currentBandData.radios || []).reduce((acc, r) => acc + (r.clientCount || 0), 0),
    avgUtilizationPct: 0,
    peakUtilizationPct: 0,
    overlappingCount: 0,
    congestionScore: 0,
    congestionLevel: 'low',
    recommendedChannel: null,
    overlappingZones: [],
    channels: [],
  };

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>WiFi APs &amp; Spectrum Congestion Analyzer</h1>
        <p>Multi-radio RF spectrum congestion heatmap, airtime utilization, and automated co-channel overlap detection</p>
      </div>
      <div class="view-actions">
        <span class="status-pill ${warnings.length > 0 ? 'warning' : 'success'}">
          <span class="status-dot ${warnings.length > 0 ? 'warning' : 'success'}"></span>
          ${warnings.length > 0 ? `${warnings.length} Congestion / Overlap Alert(s)` : 'All Channels Optimal'}
        </span>
      </div>
    </div>

    <div class="spectrum-container">
      <!-- Multi-Band Congestion Summary Strip -->
      <div class="congestion-summary-grid" id="wifi-congestion-summary-mount">
        ${renderBandCongestionSummary(bands, bandCongestion, activeBand)}
      </div>

      <!-- Frequency Band Tabs -->
      <div class="band-tabs" role="tablist" aria-label="WiFi Frequency Bands">
        ${['2.4GHz', '5GHz', '6GHz']
          .map((bandKey) => {
            const bStats = bandCongestion[bandKey];
            const rCount = (bands[bandKey]?.radios || []).length;
            const cScore = bStats?.congestionScore ?? 0;
            const levelClass = cScore >= 65 ? 'high' : cScore >= 35 ? 'moderate' : 'low';
            const subLabel =
              bandKey === '2.4GHz' ? '802.11b/g/n/ax' : bandKey === '5GHz' ? '802.11a/n/ac/ax' : 'WiFi 6E / 7';
            return `
            <button type="button"
                    role="tab"
                    aria-selected="${activeBand === bandKey ? 'true' : 'false'}"
                    class="band-tab-btn ${activeBand === bandKey ? 'active' : ''}"
                    data-band="${bandKey}">
              ${renderIcon('wifi', 'icon')}
              <span>${bandKey} (${subLabel})</span>
              <span class="band-tab-pill ${levelClass}" title="Band congestion score: ${cScore}% (${rCount} radios)">
                ${rCount} ${rCount === 1 ? 'Radio' : 'Radios'}${rCount > 0 ? ` • ${cScore}%` : ''}
              </span>
            </button>
          `;
          })
          .join('')}
      </div>

      <!-- Interference & Congestion Alert Banner if conflicts exist in current band -->
      <div id="wifi-interference-mount">
        ${renderInterferenceWarnings(warnings, activeBand, currentBandCongestion)}
      </div>

      <!-- SVG Spectrum Chart Card -->
      <div class="spectrum-chart-wrapper">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <div>
            <h2 style="font-size: 15px; font-weight: 600;" id="wifi-spectrum-heading">Spectrum Allocation &amp; Congestion (${activeBand})</h2>
            <span style="font-size: 12px; color: var(--color-text-muted);">Hatched amber/red zones mark overlapping channel contention across AP radios</span>
          </div>
          <div id="wifi-band-recommendation-mount">
            ${renderRecommendationBadge(currentBandCongestion)}
          </div>
        </div>
        <div id="wifi-spectrum-chart-mount"></div>
      </div>

      <!-- Channel Congestion Breakdown Table across all radios on this band -->
      <div id="wifi-channel-breakdown-mount">
        ${renderChannelCongestionBreakdown(currentBandCongestion, activeBand)}
      </div>

      <!-- AP Radios Hardware Overview Grid -->
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <h2 style="font-size: 15px; font-weight: 600;" id="wifi-radios-heading">Managed AP Radios on ${activeBand}</h2>
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
      const host = store.state.hosts.find((h) => h.id === radio.hostId);
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
            clientCount: host.clientCount,
          },
        });
      }
    },
  });

  chartInstance.setData({
    radios: currentBandData.radios || [],
    noiseFloorDbm: currentBandData.noiseFloorDbm || -95,
    conflicts: warnings,
    overlappingZones: currentBandCongestion.overlappingZones || [],
  });

  const switchBand = (newBand) => {
    activeBand = newBand;
    const allBands = store.state.wifiChannels?.bands || {};
    const allCongestion = store.state.wifiInterference?.bandCongestion || {};
    const allWarnings = store.state.wifiInterference?.warnings || [];
    const bandData = allBands[activeBand] || { radios: [], noiseFloorDbm: -95 };
    const bCongestion = allCongestion[activeBand] || { overlappingZones: [], channels: [] };

    container.querySelectorAll('.band-tab-btn').forEach((b) => {
      const isMatch = b.getAttribute('data-band') === activeBand;
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    const summaryMount = container.querySelector('#wifi-congestion-summary-mount');
    if (summaryMount) {
      summaryMount.innerHTML = renderBandCongestionSummary(allBands, allCongestion, activeBand);
      attachSummaryCardClicks(summaryMount, switchBand);
    }

    const specHeading = container.querySelector('#wifi-spectrum-heading');
    if (specHeading) specHeading.textContent = `Spectrum Allocation & Congestion (${activeBand})`;

    const recMount = container.querySelector('#wifi-band-recommendation-mount');
    if (recMount) recMount.innerHTML = renderRecommendationBadge(bCongestion);

    chartInstance.setBand(activeBand);
    chartInstance.setData({
      radios: bandData.radios || [],
      noiseFloorDbm: bandData.noiseFloorDbm || -95,
      conflicts: allWarnings,
      overlappingZones: bCongestion.overlappingZones || [],
    });

    const alertMount = container.querySelector('#wifi-interference-mount');
    if (alertMount) {
      alertMount.innerHTML = renderInterferenceWarnings(allWarnings, activeBand, bCongestion);
    }

    const breakdownMount = container.querySelector('#wifi-channel-breakdown-mount');
    if (breakdownMount) {
      breakdownMount.innerHTML = renderChannelCongestionBreakdown(bCongestion, activeBand);
    }

    const radiosHeading = container.querySelector('#wifi-radios-heading');
    if (radiosHeading) radiosHeading.textContent = `Managed AP Radios on ${activeBand}`;

    const radiosMount = container.querySelector('#wifi-radios-mount');
    if (radiosMount) {
      radiosMount.innerHTML = renderRadioCards(bandData.radios || [], allWarnings);
    }
  };

  // Attach Band Tab switching
  const tabBtns = container.querySelectorAll('.band-tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchBand(btn.getAttribute('data-band') || '5GHz');
    });
  });

  attachSummaryCardClicks(container.querySelector('#wifi-congestion-summary-mount'), switchBand);
}

function attachSummaryCardClicks(mount, switchBand) {
  if (!mount) return;
  mount.querySelectorAll('[data-select-band]').forEach((card) => {
    card.addEventListener('click', () => {
      const targetBand = card.getAttribute('data-select-band');
      if (targetBand) switchBand(targetBand);
    });
  });
}

function renderBandCongestionSummary(bands = {}, bandCongestion = {}, selectedBand = '5GHz') {
  return ['2.4GHz', '5GHz', '6GHz']
    .map((bandName) => {
      const radios = bands[bandName]?.radios || [];
      const stats = bandCongestion[bandName] || {
        radiosCount: radios.length,
        totalClients: radios.reduce((acc, r) => acc + (r.clientCount || 0), 0),
        avgUtilizationPct: 0,
        peakUtilizationPct: 0,
        overlappingCount: 0,
        congestionScore: 0,
        congestionLevel: 'low',
        recommendedChannel: null,
      };

      const score = stats.congestionScore ?? 0;
      const level = stats.congestionLevel || (score >= 65 ? 'high' : score >= 35 ? 'moderate' : 'low');
      const levelLabel =
        radios.length === 0 ? 'Inactive' : level === 'high' ? 'High Congestion' : level === 'moderate' ? 'Moderate Load' : 'Clean Spectrum';
      const pillClass = radios.length === 0 ? '' : level === 'high' ? 'danger' : level === 'moderate' ? 'warning' : 'success';
      const barClass = level === 'high' ? 'high' : level === 'moderate' ? 'medium' : 'low';

      return `
        <button type="button"
                class="congestion-band-card ${selectedBand === bandName ? 'active' : ''} ${level === 'high' ? 'congested' : ''}"
                data-select-band="${bandName}">
          <div class="congestion-band-card-header">
            <span class="congestion-band-title">${bandName} Band</span>
            <span class="status-pill ${pillClass}">${levelLabel}</span>
          </div>
          <div class="congestion-band-metrics">
            <div>
              <div class="congestion-score-val">${score}%</div>
              <div class="congestion-score-label">Congestion Index</div>
            </div>
            <div class="congestion-mini-stats">
              <span><strong>${stats.radiosCount}</strong> Radios</span>
              <span><strong>${stats.totalClients}</strong> Clients</span>
              <span><strong>${stats.avgUtilizationPct}%</strong> Avg Airtime</span>
              <span><strong>${stats.overlappingCount}</strong> Overlaps</span>
            </div>
          </div>
          <div class="utilization-track" style="margin-top: 6px;">
            <div class="utilization-fill ${barClass}" style="width: ${score}%;"></div>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderRecommendationBadge(bandStats = {}) {
  const rec = bandStats?.recommendedChannel;
  if (!rec || !bandStats.radiosCount) return '';
  return `
    <span class="status-pill info" title="Least congested channel on ${escapeHtml(bandStats.band || '')}">
      Best Channel: <strong>${escapeHtml(rec.label || `Ch ${rec.channel}`)}</strong> (${rec.overlappingRadios === 0 ? '0 overlaps' : `${rec.combinedUtilPct}% load`})
    </span>
  `;
}

function renderChannelCongestionBreakdown(bandStats = {}, bandName = '5GHz') {
  const channels = bandStats?.channels || [];
  if (channels.length === 0) return '';

  return `
    <div class="spectrum-chart-wrapper" style="padding: var(--space-4);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
        <h2 style="font-size: 15px; font-weight: 600;">Channel Congestion Breakdown across All ${escapeHtml(bandName)} Radios</h2>
        <span style="font-size: 12px; color: var(--color-text-muted);">Aggregated airtime contention per channel</span>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <caption class="sr-only">${escapeHtml(bandName)} Channel Congestion Breakdown</caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Width</th>
              <th scope="col">Transmitting Radios</th>
              <th scope="col">Connected Clients</th>
              <th scope="col">Combined Airtime Load</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${channels
              .map((ch) => {
                const load = ch.combinedUtilizationPct || 0;
                const isShared = ch.radioCount > 1;
                const isHigh = load >= 70 || (isShared && load >= 50);
                const statusClass = isHigh ? 'danger' : isShared || load >= 45 ? 'warning' : 'success';
                const statusText = isHigh
                  ? 'Congested'
                  : isShared
                    ? `Co-Channel (${ch.radioCount} APs)`
                    : load >= 45
                      ? 'Moderate'
                      : 'Clear';
                const fillClass = load >= 70 ? 'high' : load >= 45 || isShared ? 'medium' : 'low';
                const radioNames = ch.radios.map((r) => `${escapeHtml(r.hostName)} (${r.utilizationPct}%)`).join(', ');

                return `
                  <tr>
                    <td class="font-mono"><strong>Ch ${ch.channel}</strong> (${ch.centerFreqMhz} MHz)</td>
                    <td class="font-mono">${ch.widthMhz} MHz</td>
                    <td>${radioNames}</td>
                    <td class="font-mono">${ch.clientCount}</td>
                    <td style="min-width: 160px;">
                      <div style="display: flex; align-items: center; gap: 8px;">
                        <div class="utilization-track" style="flex: 1;">
                          <div class="utilization-fill ${fillClass}" style="width: ${load}%;"></div>
                        </div>
                        <span class="font-mono" style="font-size: 12px; min-width: 36px;">${load}%</span>
                      </div>
                    </td>
                    <td><span class="status-pill ${statusClass}">${statusText}</span></td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderInterferenceWarnings(warnings = [], band, bandStats = {}) {
  const bandWarnings = warnings.filter((w) => !w.band || w.band === band);
  if (bandWarnings.length === 0) return '';

  return bandWarnings
    .map((w) => {
      const titlePrefix =
        w.type === 'airtime_congestion'
          ? 'High Airtime Congestion'
          : w.type === 'adjacent_channel'
            ? 'Adjacent-Channel Interference'
            : 'Co-Channel Congestion';
      return `
        <div class="interference-alert" style="margin-bottom: 8px;">
          <div class="interference-alert-icon">${renderIcon('alertTriangle', 'icon')}</div>
          <div class="interference-alert-content">
            <div class="interference-alert-title">${titlePrefix} on ${escapeHtml(w.band || band)} Channel ${escapeHtml(String(w.channel))}</div>
            <div class="interference-alert-desc">${escapeHtml(w.message)}</div>
          </div>
        </div>
      `;
    })
    .join('');
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

  return radios
    .map((radio) => {
      const radioWarnings = warnings.filter((w) => w.affectedRadios?.includes(radio.id));
      const isConflicted = radioWarnings.length > 0;
      const utilPct = radio.utilizationPct ?? 30;
      const noiseDbm = radio.noiseDbm ?? -95;

      let utilClass = 'low';
      if (utilPct >= 70) utilClass = 'high';
      else if (utilPct >= 45) utilClass = 'medium';

      return `
      <div class="radio-card ${isConflicted ? 'has-conflict' : ''}">
        <div class="radio-card-header">
          <div>
            <div class="radio-card-title">${escapeHtml(radio.hostName)} (${escapeHtml(radio.device || 'radio0')})</div>
            <div class="radio-card-ssid">SSID: <strong>${escapeHtml(radio.ssid || 'Homelab')}</strong></div>
          </div>
          ${
            isConflicted
              ? `
            <span class="status-pill warning" title="${escapeHtml(radioWarnings.map((w) => w.message).join(' '))}">
              ${renderIcon('alertTriangle', 'icon')} ${utilPct >= 70 ? 'Congested' : 'Conflict'}
            </span>
          `
              : `
            <span class="status-pill success">Optimal</span>
          `
          }
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
            <span class="radio-stat-label">Tx Power / Noise</span>
            <span class="radio-stat-val">${radio.txPowerDbm || 20} dBm / ${noiseDbm} dBm</span>
          </div>
          <div class="radio-stat-item">
            <span class="radio-stat-label">Connected Clients</span>
            <span class="radio-stat-val">${radio.clientCount ?? 0} active</span>
          </div>
        </div>

        <div class="utilization-container">
          <div class="utilization-label-row">
            <span>Channel Airtime Congestion</span>
            <span class="font-mono">${utilPct}%</span>
          </div>
          <div class="utilization-track">
            <div class="utilization-fill ${utilClass}" style="width: ${utilPct}%;"></div>
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}
