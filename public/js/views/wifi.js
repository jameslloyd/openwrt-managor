/**
 * OpenWrt Manager (openwrt-managor)
 * WiFi APs, Spectrum Congestion & Neighboring Network Signal Analyzer View
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { SpectrumChart } from '../charts/spectrum-chart.js';
import { renderIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/formatters.js';

let chartInstance = null;
let activeBand = '5GHz';
let isScanning = false;

export function renderWifi(container) {
  const { wifiChannels, wifiInterference } = store.state;
  const bands = wifiChannels?.bands || {};
  const currentBandData = bands[activeBand] || { radios: [], neighbors: [], noiseFloorDbm: -95 };
  const warnings = wifiInterference?.warnings || [];
  const bandCongestion = wifiInterference?.bandCongestion || {};
  const currentBandCongestion = bandCongestion[activeBand] || {
    radiosCount: (currentBandData.radios || []).length,
    neighborsCount: (currentBandData.neighbors || []).filter((n) => !n.isManagedFleet).length,
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
        <p>Multi-radio RF spectrum congestion, neighboring network scan, and relative signal strength per AP radio</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-primary" id="wifi-scan-neighbors-btn" ${isScanning ? 'disabled' : ''}>
          ${renderIcon('wifi', 'icon')} ${isScanning ? 'Scanning Airwaves...' : 'Scan Neighboring Networks'}
        </button>
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
            const nCount = (bands[bandKey]?.neighbors || []).filter((n) => !n.isManagedFleet).length;
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
              <span class="band-tab-pill ${levelClass}" title="Band congestion score: ${cScore}% (${rCount} radios, ${nCount} neighbor networks)">
                ${rCount} ${rCount === 1 ? 'Radio' : 'Radios'}${nCount > 0 ? ` • ${nCount} Ext` : ''}${rCount > 0 || nCount > 0 ? ` • ${cScore}%` : ''}
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
            <span style="font-size: 12px; color: var(--color-text-muted);">Solid curves = Managed AP radios • Dashed curves = Scanned neighboring networks • Hatched zones = Channel overlap</span>
          </div>
          <div id="wifi-band-recommendation-mount">
            ${renderRecommendationBadge(currentBandCongestion)}
          </div>
        </div>
        <div id="wifi-spectrum-chart-mount"></div>
      </div>

      <!-- Scanned Neighboring Networks & Relative Signal Strength per Radio -->
      <div id="wifi-neighbors-mount">
        ${renderNeighborNetworksSection(currentBandData, activeBand)}
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
    neighbors: currentBandData.neighbors || [],
    noiseFloorDbm: currentBandData.noiseFloorDbm || -95,
    conflicts: warnings,
    overlappingZones: currentBandCongestion.overlappingZones || [],
  });

  const switchBand = (newBand) => {
    activeBand = newBand;
    const allBands = store.state.wifiChannels?.bands || {};
    const allCongestion = store.state.wifiInterference?.bandCongestion || {};
    const allWarnings = store.state.wifiInterference?.warnings || [];
    const bandData = allBands[activeBand] || { radios: [], neighbors: [], noiseFloorDbm: -95 };
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
      neighbors: bandData.neighbors || [],
      noiseFloorDbm: bandData.noiseFloorDbm || -95,
      conflicts: allWarnings,
      overlappingZones: bCongestion.overlappingZones || [],
    });

    const alertMount = container.querySelector('#wifi-interference-mount');
    if (alertMount) {
      alertMount.innerHTML = renderInterferenceWarnings(allWarnings, activeBand, bCongestion);
    }

    const neighborsMount = container.querySelector('#wifi-neighbors-mount');
    if (neighborsMount) {
      neighborsMount.innerHTML = renderNeighborNetworksSection(bandData, activeBand);
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

  // Attach Scan Neighboring Networks button
  const scanBtn = container.querySelector('#wifi-scan-neighbors-btn');
  scanBtn?.addEventListener('click', async () => {
    if (isScanning) return;
    isScanning = true;
    scanBtn.disabled = true;
    scanBtn.innerHTML = `${renderIcon('wifi', 'icon')} Scanning Airwaves...`;
    toast.info('Scanning Spectrum', 'Triggering active wireless scan across all OpenWrt radios...');
    try {
      const res = await api.scanWifiNetworks('all');
      if (res?.bands) {
        store.setState({
          wifiChannels: { bands: res.bands },
          wifiInterference: res.analysis || store.state.wifiInterference,
        });
      }
      const totalFound = Object.values(res?.bands || {}).reduce(
        (acc, b) => acc + (b.neighbors || []).length,
        0
      );
      toast.success('Wireless Scan Complete', `Detected ${totalFound} neighboring wireless network BSSIDs across your radios.`);
      renderWifi(container);
    } catch (err) {
      toast.error('Wireless Scan Failed', err.message || 'Could not complete wireless scan.');
    } finally {
      isScanning = false;
      const btnNow = container.querySelector('#wifi-scan-neighbors-btn');
      if (btnNow) {
        btnNow.disabled = false;
        btnNow.innerHTML = `${renderIcon('wifi', 'icon')} Scan Neighboring Networks`;
      }
    }
  });

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

function dbmToQualityPct(signalDbm) {
  const clamped = Math.max(-95, Math.min(-35, Number(signalDbm) || -90));
  return Math.round(((clamped + 95) / 60) * 100);
}

function renderNeighborNetworksSection(bandData = {}, bandName = '5GHz') {
  const neighbors = bandData?.neighbors || [];
  const radios = bandData?.radios || [];

  return `
    <div class="spectrum-chart-wrapper" style="padding: var(--space-4);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
        <div>
          <h2 style="font-size: 15px; font-weight: 600;">Neighboring Networks &amp; Relative Signal Strength (${escapeHtml(bandName)})</h2>
          <span style="font-size: 12px; color: var(--color-text-muted);">
            Compares received signal strength (RSSI in dBm) of nearby networks as heard by each of your OpenWrt radios
          </span>
        </div>
        <span class="status-pill ${neighbors.length > 0 ? 'info' : ''}">
          ${neighbors.length} ${neighbors.length === 1 ? 'Network' : 'Networks'} Detected
        </span>
      </div>

      ${
        neighbors.length === 0
          ? `
        <div class="empty-state" style="padding: var(--space-4);">
          <div class="empty-state-title">No Neighboring Networks Scanned on ${escapeHtml(bandName)} Yet</div>
          <div class="empty-state-desc">
            Click <strong>Scan Neighboring Networks</strong> above to command all OpenWrt radios to scan surrounding SSIDs and compare their relative signal strength on each AP.
          </div>
        </div>
      `
          : `
        <div class="table-responsive">
          <table class="data-table">
            <caption class="sr-only">Scanned Neighboring Wireless Networks on ${escapeHtml(bandName)} and Relative Signal Strength per Radio</caption>
            <thead>
              <tr>
                <th scope="col">SSID / Network</th>
                <th scope="col">BSSID</th>
                <th scope="col">Channel</th>
                <th scope="col">Security</th>
                <th scope="col">Peak Signal</th>
                <th scope="col">Relative Signal Strength per OpenWrt Radio</th>
              </tr>
            </thead>
            <tbody>
              ${neighbors
                .map((nb) => {
                  const peakSig = nb.strongestSignalDbm ?? -85;
                  const peakPct = dbmToQualityPct(peakSig);
                  const sigClass = peakSig >= -60 ? 'high' : peakSig >= -75 ? 'medium' : 'low';
                  const overlapsOurChannel = radios.some((r) => Number(r.channel) === Number(nb.channel));
                  const observations = Array.isArray(nb.observations) ? nb.observations : [];

                  const perRadioHtml = observations
                    .map((obs) => {
                      const pct = dbmToQualityPct(obs.signalDbm);
                      const barClass = obs.signalDbm >= -60 ? 'high' : obs.signalDbm >= -75 ? 'medium' : 'low';
                      return `
                        <div class="neighbor-radio-rssi-item" title="${escapeHtml(obs.hostName)} (${escapeHtml(obs.device)}): ${obs.signalDbm} dBm (${pct}% relative strength)">
                          <div class="neighbor-radio-rssi-header">
                            <span class="neighbor-radio-name">${escapeHtml(obs.hostName)} <small style="color:var(--color-text-muted);">(${escapeHtml(obs.device)})</small></span>
                            <span class="font-mono neighbor-radio-dbm">${obs.signalDbm} dBm <small>(${pct}%)</small></span>
                          </div>
                          <div class="utilization-track" style="height: 5px;">
                            <div class="utilization-fill ${barClass}" style="width: ${pct}%;"></div>
                          </div>
                        </div>
                      `;
                    })
                    .join('');

                  return `
                    <tr>
                      <td>
                        <div style="display: flex; align-items: center; gap: 6px; font-weight: 600;">
                          <span>${escapeHtml(nb.ssid)}</span>
                          ${nb.isManagedFleet ? '<span class="status-pill info" style="font-size: 10px; padding: 1px 6px;">Fleet AP</span>' : ''}
                          ${!nb.isManagedFleet && overlapsOurChannel ? '<span class="status-pill warning" style="font-size: 10px; padding: 1px 6px;" title="Shares channel with your AP">Shares Ch</span>' : ''}
                        </div>
                      </td>
                      <td class="font-mono" style="font-size: 12px;">${escapeHtml(nb.bssid.toUpperCase())}</td>
                      <td class="font-mono">Ch ${nb.channel} <small style="color:var(--color-text-muted);">(${nb.widthMhz || 20}MHz)</small></td>
                      <td><span class="status-pill">${escapeHtml(nb.security || 'Open')}</span></td>
                      <td class="font-mono">
                        <span class="status-pill ${sigClass === 'high' ? 'warning' : sigClass === 'medium' ? 'info' : ''}">
                          ${peakSig} dBm (${peakPct}%)
                        </span>
                      </td>
                      <td style="min-width: 260px;">
                        <div class="neighbor-radio-rssi-list">
                          ${perRadioHtml}
                        </div>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      `
      }
    </div>
  `;
}

function renderBandCongestionSummary(bands = {}, bandCongestion = {}, selectedBand = '5GHz') {
  return ['2.4GHz', '5GHz', '6GHz']
    .map((bandName) => {
      const radios = bands[bandName]?.radios || [];
      const extNeighbors = (bands[bandName]?.neighbors || []).filter((n) => !n.isManagedFleet);
      const stats = bandCongestion[bandName] || {
        radiosCount: radios.length,
        neighborsCount: extNeighbors.length,
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
        radios.length === 0 && extNeighbors.length === 0
          ? 'Inactive'
          : level === 'high'
            ? 'High Congestion'
            : level === 'moderate'
              ? 'Moderate Load'
              : 'Clean Spectrum';
      const pillClass =
        radios.length === 0 && extNeighbors.length === 0
          ? ''
          : level === 'high'
            ? 'danger'
            : level === 'moderate'
              ? 'warning'
              : 'success';
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
              <span><strong>${stats.neighborsCount ?? extNeighbors.length}</strong> Neighbors</span>
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
      Best Channel: <strong>${escapeHtml(rec.label || `Ch ${rec.channel}`)}</strong> (${rec.overlappingRadios === 0 && !rec.overlappingNeighbors ? '0 overlaps' : `${rec.combinedUtilPct}% load`})
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
              <th scope="col">External Neighbors</th>
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
                const hasLoudNeighbor = ch.strongestNeighborDbm !== null && ch.strongestNeighborDbm >= -70;
                const isHigh = load >= 70 || (isShared && load >= 50) || (hasLoudNeighbor && load >= 55);
                const statusClass = isHigh ? 'danger' : isShared || hasLoudNeighbor || load >= 45 ? 'warning' : 'success';
                const statusText = isHigh
                  ? 'Congested'
                  : isShared
                    ? `Co-Channel (${ch.radioCount} APs)`
                    : hasLoudNeighbor
                      ? `Ext Neighbor (${ch.strongestNeighborDbm}dBm)`
                      : load >= 45
                        ? 'Moderate'
                        : 'Clear';
                const fillClass = load >= 70 ? 'high' : load >= 45 || isShared || hasLoudNeighbor ? 'medium' : 'low';
                const radioNames = ch.radios.map((r) => `${escapeHtml(r.hostName)} (${r.utilizationPct}%)`).join(', ');
                const neighborText =
                  ch.neighborCount > 0 ? `${ch.neighborCount} (${ch.strongestNeighborDbm} dBm)` : '0';

                return `
                  <tr>
                    <td class="font-mono"><strong>Ch ${ch.channel}</strong> (${ch.centerFreqMhz} MHz)</td>
                    <td class="font-mono">${ch.widthMhz} MHz</td>
                    <td>${radioNames}</td>
                    <td class="font-mono">${neighborText}</td>
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
          : w.type === 'external_interference'
            ? 'External Neighbor Network Interference'
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
