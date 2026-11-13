/**
 * OpenWrt Manager (openwrt-managor)
 * Pure SVG Multi-Band RF Spectrum Visualizer
 * Accurately models 20/40/80/160 MHz channel width curves, congested overlap zones, and airtime utilization across 2.4GHz, 5GHz, and 6GHz
 */

import { escapeHtml } from '../utils/formatters.js';

export class SpectrumChart {
  constructor({ container, band = '5GHz', onRadioClick = null }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.band = band;
    this.onRadioClick = onRadioClick;
    this.radios = [];
    this.noiseFloorDbm = -95;
    this.conflicts = [];
    this.overlappingZones = [];
  }

  setData({ radios = [], noiseFloorDbm = -95, conflicts = [], overlappingZones = [] }) {
    this.radios = radios;
    this.noiseFloorDbm = noiseFloorDbm;
    this.conflicts = conflicts;
    this.overlappingZones = overlappingZones;
    this.render();
  }

  setBand(band) {
    this.band = band;
    this.render();
  }

  getBandConfig() {
    if (this.band === '2.4GHz') {
      return {
        minFreq: 2400,
        maxFreq: 2490,
        channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        getFreq: (ch) => 2412 + 5 * (ch - 1),
        subBands: [{ name: 'ISM 2.4 GHz', start: 2400, end: 2484 }],
      };
    } else if (this.band === '6GHz') {
      return {
        minFreq: 5925,
        maxFreq: 7125,
        channels: [1, 17, 33, 49, 65, 81, 97, 113, 129, 145, 161, 177, 193, 209, 225],
        getFreq: (ch) => 5950 + 5 * ch,
        subBands: [
          { name: 'UNII-5', start: 5925, end: 6425 },
          { name: 'UNII-6', start: 6425, end: 6525 },
          { name: 'UNII-7', start: 6525, end: 6875 },
          { name: 'UNII-8', start: 6875, end: 7125 },
        ],
      };
    } else {
      // 5GHz Default
      return {
        minFreq: 5160,
        maxFreq: 5850,
        channels: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
        getFreq: (ch) => 5000 + 5 * ch,
        subBands: [
          { name: 'UNII-1 (Indoor)', start: 5170, end: 5250 },
          { name: 'UNII-2A (DFS)', start: 5250, end: 5330 },
          { name: 'UNII-2C (DFS)', start: 5490, end: 5730 },
          { name: 'UNII-3', start: 5735, end: 5835 },
        ],
      };
    }
  }

  render() {
    if (!this.container) return;

    const config = this.getBandConfig();
    const width = 960;
    const height = 290;
    const padding = { top: 34, right: 30, bottom: 52, left: 55 };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const freqToX = (freq) => {
      return padding.left + ((freq - config.minFreq) / (config.maxFreq - config.minFreq)) * chartWidth;
    };

    const minDbm = -100;
    const maxDbm = -20;
    const dbmToY = (dbm) => {
      const clamped = Math.max(minDbm, Math.min(maxDbm, dbm));
      return padding.top + chartHeight - ((clamped - minDbm) / (maxDbm - minDbm)) * chartHeight;
    };

    // Sub-bands background rectangles & labels
    let subBandsSvg = '';
    for (const sub of config.subBands) {
      const x1 = Math.max(padding.left, freqToX(sub.start));
      const x2 = Math.min(width - padding.right, freqToX(sub.end));
      const w = Math.max(0, x2 - x1);
      subBandsSvg += `
        <rect x="${x1}" y="${padding.top}" width="${w}" height="${chartHeight}" class="spectrum-subband-rect" />
        <text x="${x1 + w / 2}" y="${padding.top + 14}" class="spectrum-subband-label">${sub.name}</text>
      `;
    }

    // Highlight congested overlapping frequency zones across radios
    let congestionZonesSvg = '';
    const bandZones = (this.overlappingZones || []).filter((z) => !z.band || z.band === this.band);
    for (const zone of bandZones) {
      const zx1 = Math.max(padding.left, freqToX(zone.startFreqMhz));
      const zx2 = Math.min(width - padding.right, freqToX(zone.endFreqMhz));
      const zw = Math.max(0, zx2 - zx1);
      if (zw <= 0) continue;
      const isHigh = zone.severity === 'high' || (zone.combinedUtilizationPct || 0) >= 65;
      const strokeColor = isHigh ? 'var(--color-danger)' : 'var(--color-warning)';
      const badgeLabel = `Congested Ch ${zone.channels.join('/')} • ${zone.combinedUtilizationPct}% Airtime`;
      congestionZonesSvg += `
        <g class="spectrum-congestion-zone">
          <rect x="${zx1}" y="${padding.top}" width="${zw}" height="${chartHeight}"
                fill="url(#amber-hatch)"
                stroke="${strokeColor}"
                stroke-width="1.2"
                stroke-dasharray="4 3"
                opacity="0.85" />
          <text x="${zx1 + zw / 2}" y="${padding.top + 27}"
                font-size="9.5"
                font-weight="700"
                fill="${strokeColor}"
                text-anchor="middle">
            ${escapeHtml(badgeLabel)}
          </text>
        </g>
      `;
    }

    // Grid lines & Y-axis dBm ticks
    let yTicksSvg = '';
    const dbmTicks = [-30, -50, -70, -90];
    for (const tick of dbmTicks) {
      const y = dbmToY(tick);
      yTicksSvg += `
        <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="spectrum-grid-line" />
        <text x="${padding.left - 8}" y="${y + 4}" class="spectrum-axis-label" text-anchor="end">${tick} dBm</text>
      `;
    }

    // Noise floor line
    const noiseY = dbmToY(this.noiseFloorDbm);
    const noiseLineSvg = `
      <line x1="${padding.left}" y1="${noiseY}" x2="${width - padding.right}" y2="${noiseY}" stroke="var(--color-danger)" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.6"/>
      <text x="${width - padding.right - 5}" y="${noiseY - 4}" font-size="10" fill="var(--color-danger)" text-anchor="end">Noise: ${this.noiseFloorDbm} dBm</text>
    `;

    // Channel ticks along X-axis
    let xTicksSvg = '';
    for (const ch of config.channels) {
      const freq = config.getFreq(ch);
      if (freq >= config.minFreq && freq <= config.maxFreq) {
        const x = freqToX(freq);
        const radiosOnCh = this.radios.filter((r) => Number(r.channel) === ch);
        const isChCongested = radiosOnCh.length > 1 || radiosOnCh.some((r) => (r.utilizationPct || 0) >= 70);
        const labelColor = isChCongested ? 'var(--color-warning)' : 'var(--color-text-muted)';
        xTicksSvg += `
          <line x1="${x}" y1="${padding.top + chartHeight}" x2="${x}" y2="${padding.top + chartHeight + 6}" class="spectrum-axis" />
          <text x="${x}" y="${padding.top + chartHeight + 18}" class="spectrum-axis-label" style="fill: ${labelColor};" text-anchor="middle" font-weight="${radiosOnCh.length > 0 ? '700' : '600'}">${ch}</text>
          <text x="${x}" y="${padding.top + chartHeight + 30}" font-size="9" fill="var(--color-text-muted)" text-anchor="middle">${freq}</text>
        `;
      }
    }

    // Generate RF Bell Curves for active radios, staggering peak labels when multiple radios share a channel
    let curvesSvg = '';
    const colorPalette = ['#38bdf8', '#a855f7', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
    const channelSlotCount = new Map();

    this.radios.forEach((radio, index) => {
      const centerFreq = radio.centerFreqMhz || config.getFreq(radio.channel);
      const widthMhz = radio.widthMhz || 20;
      const baseSignalDbm = radio.signalDbm ?? -45;
      const slotIdx = channelSlotCount.get(centerFreq) || 0;
      channelSlotCount.set(centerFreq, slotIdx + 1);

      // Slightly offset co-channel curves so stacked transmitters remain individually visible
      const signalDbm = baseSignalDbm - slotIdx * 4;

      const fStart = centerFreq - widthMhz / 2;
      const fEnd = centerFreq + widthMhz / 2;

      const xStart = freqToX(fStart);
      const xEnd = freqToX(fEnd);
      const xCenter = freqToX(centerFreq);

      const yBase = dbmToY(this.noiseFloorDbm);
      const yPeak = dbmToY(signalDbm);

      // Trapezoid / Parabolic Bell curve path with smoothed shoulders
      const flatRatio = 0.75;
      const halfFlat = (widthMhz * flatRatio) / 2;
      const xFlatStart = freqToX(centerFreq - halfFlat);
      const xFlatEnd = freqToX(centerFreq + halfFlat);

      const pathData = `
        M ${xStart} ${yBase}
        C ${xStart + (xFlatStart - xStart) * 0.4} ${yBase},
          ${xFlatStart - (xFlatStart - xStart) * 0.2} ${yPeak},
          ${xFlatStart} ${yPeak}
        L ${xFlatEnd} ${yPeak}
        C ${xFlatEnd + (xEnd - xFlatEnd) * 0.2} ${yPeak},
          ${xEnd - (xEnd - xFlatEnd) * 0.4} ${yBase},
          ${xEnd} ${yBase}
        Z
      `;

      const color = colorPalette[index % colorPalette.length];
      const isConflicted = this.conflicts.some((c) => c.affectedRadios?.includes(radio.id));
      const utilPct = radio.utilizationPct ?? 0;
      const isHighUtil = utilPct >= 70;

      const strokeColor = isHighUtil ? 'var(--color-danger)' : isConflicted ? 'var(--color-warning)' : color;
      const fillOpacity = Math.min(0.45, Math.max(0.18, 0.15 + (utilPct / 100) * 0.3));

      const tooltipStr = escapeHtml(
        `${radio.hostName} • ${radio.ssid || 'OpenWrt'} (Ch ${radio.channel}, ${widthMhz}MHz) • ${utilPct}% Airtime • ${radio.clientCount ?? 0} Clients`
      );
      const radioLabel = escapeHtml(`${radio.hostName || radio.ssid} (${utilPct}%)`);
      const labelY = Math.max(padding.top + 12, yPeak - 6 - slotIdx * 11);

      curvesSvg += `
        <g class="spectrum-radio-group" data-radio-id="${escapeHtml(radio.id)}" role="button" tabindex="0" aria-label="${tooltipStr}">
          <path d="${pathData}"
                fill="${color}"
                fill-opacity="${fillOpacity.toFixed(2)}"
                stroke="${strokeColor}"
                stroke-width="${isConflicted || isHighUtil ? 2.6 : 1.8}"
                class="spectrum-curve ${isConflicted || isHighUtil ? 'conflict' : ''}"
                data-tooltip="${tooltipStr}"
          />
          <text x="${xCenter}" y="${labelY}" font-size="10.5" font-weight="700" fill="${color}" text-anchor="middle">
            ${radioLabel}
          </text>
        </g>
      `;
    });

    const svgHtml = `
      <svg viewBox="0 0 ${width} ${height}" class="spectrum-chart-svg" role="img" aria-label="${this.band} WiFi RF Spectrum Chart">
        <title>${this.band} WiFi RF Spectrum Allocation and Congestion Chart</title>
        <defs>
          <pattern id="amber-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-warning)" stroke-width="2" opacity="0.35"/>
          </pattern>
        </defs>

        <!-- Subbands background -->
        ${subBandsSvg}

        <!-- Highlighted Congestion Overlap Zones -->
        ${congestionZonesSvg}

        <!-- Baseline axes -->
        <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" class="spectrum-axis" />
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" class="spectrum-axis" />

        <!-- Grid lines & Ticks -->
        ${yTicksSvg}
        ${noiseLineSvg}
        ${xTicksSvg}

        <!-- Radio Curves -->
        ${curvesSvg}
      </svg>
      <div id="spectrum-chart-tooltip" class="spectrum-tooltip" style="display: none; opacity: 0;"></div>
    `;

    this.container.innerHTML = svgHtml;

    // Attach curve interaction (mouse and keyboard)
    const tooltip = this.container.querySelector('#spectrum-chart-tooltip');
    const curveGroups = this.container.querySelectorAll('.spectrum-radio-group');

    curveGroups.forEach((group) => {
      const radioId = group.getAttribute('data-radio-id');
      const path = group.querySelector('path');
      const tipText = path?.getAttribute('data-tooltip') || '';

      group.addEventListener('mouseenter', (e) => {
        if (!tooltip) return;
        tooltip.textContent = tipText;
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';
        tooltip.style.left = `${e.offsetX + 10}px`;
        tooltip.style.top = `${e.offsetY - 25}px`;
      });

      group.addEventListener('mousemove', (e) => {
        if (!tooltip) return;
        tooltip.style.left = `${e.offsetX + 10}px`;
        tooltip.style.top = `${e.offsetY - 25}px`;
      });

      group.addEventListener('mouseleave', () => {
        if (!tooltip) return;
        tooltip.style.display = 'none';
        tooltip.style.opacity = '0';
      });

      if (this.onRadioClick) {
        const triggerSelect = () => {
          const radio = this.radios.find((r) => r.id === radioId);
          if (radio) this.onRadioClick(radio);
        };
        group.addEventListener('click', triggerSelect);
        group.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            triggerSelect();
          } else if (e.key === ' ') {
            e.preventDefault();
          }
        });
        group.addEventListener('keyup', (e) => {
          if (e.key === ' ') {
            triggerSelect();
          }
        });
      }
    });
  }
}
