/**
 * OpenWrt Manager (openwrt-managor)
 * Interactive SVG RF Triangulation & Spatial Radar Map
 * Visualizes Managed OpenWrt AP Anchor Nodes (draggable), Foreign AP triangulated positions,
 * RSSI log-distance path loss rings, and multi-AP signal power vectors.
 */

import { escapeHtml, resolveClientSideVendor } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

export class TriangulationMap {
  constructor({
    container,
    band = '5GHz',
    sizeMode = 'standard',
    onAnchorMove = null,
    onSelectNeighbor = null,
    onSizeModeChange = null,
  }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.band = band;
    this.sizeMode = sizeMode;
    this.onAnchorMove = onAnchorMove;
    this.onSelectNeighbor = onSelectNeighbor;
    this.onSizeModeChange = onSizeModeChange;
    this.anchors = [];
    this.neighbors = [];
    this.selectedBssid = null;
    this.draggingHostId = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  setSizeMode(mode) {
    this.sizeMode = mode || 'standard';
    this.render();
    if (this.onSizeModeChange) {
      this.onSizeModeChange(this.sizeMode);
    }
  }

  setZoom(nextZoom, centerSvgX = null, centerSvgY = null) {
    const prevZoom = this.zoom || 1;
    const clamped = Math.round(Math.max(1, Math.min(3.5, nextZoom)) * 100) / 100;
    if (clamped === 1) {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.render();
      return;
    }

    const { width, height } = this.getDimensions();
    const cx = centerSvgX !== null ? centerSvgX : this.panX + width / prevZoom / 2;
    const cy = centerSvgY !== null ? centerSvgY : this.panY + height / prevZoom / 2;
    const newVbW = width / clamped;
    const newVbH = height / clamped;

    this.zoom = clamped;
    this.panX = Math.max(0, Math.min(width - newVbW, cx - newVbW / 2));
    this.panY = Math.max(0, Math.min(height - newVbH, cy - newVbH / 2));
    this.render();
  }

  getDimensions() {
    const isExpanded = this.sizeMode === 'large' || this.sizeMode === 'fullscreen';
    return {
      width: isExpanded ? 960 : 880,
      height: isExpanded ? 640 : 490,
    };
  }

  setData({ anchors = [], neighbors = [], selectedBssid = null }) {
    this.anchors = Array.isArray(anchors)
      ? anchors
          .filter(
            (a) =>
              a &&
              a.hasWirelessRadios !== false &&
              (!Array.isArray(a.radios) || a.radios.length > 0)
          )
          .map((a) => ({ ...a }))
      : [];
    this.neighbors = Array.isArray(neighbors)
      ? neighbors.filter((n) => !n.isManagedFleet && n.triangulation)
      : [];

    if (selectedBssid !== undefined && selectedBssid !== null) {
      this.selectedBssid = selectedBssid.toLowerCase();
    } else if (
      !this.selectedBssid ||
      !this.neighbors.some((n) => n.bssid.toLowerCase() === this.selectedBssid)
    ) {
      // Default to the foreign AP heard by the most OpenWrt APs (or strongest signal)
      const best = [...this.neighbors].sort((a, b) => {
        const diffAp = (b.triangulation?.apCount || 0) - (a.triangulation?.apCount || 0);
        if (diffAp !== 0) return diffAp;
        return (b.strongestSignalDbm || -95) - (a.strongestSignalDbm || -95);
      })[0];
      this.selectedBssid = best ? best.bssid.toLowerCase() : null;
    }

    this.render();
  }

  selectNeighbor(bssid) {
    if (!bssid) return;
    this.selectedBssid = bssid.toLowerCase();
    this.render();
    if (this.onSelectNeighbor) {
      this.onSelectNeighbor(this.selectedBssid);
    }
  }

  setBand(band) {
    this.band = band;
    this.render();
  }

  render() {
    if (!this.container) return;

    const { width, height } = this.getDimensions();
    const padLeft = 48;
    const padRight = 32;
    const padTop = 28;
    const padBottom = 38;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const vbW = width / (this.zoom || 1);
    const vbH = height / (this.zoom || 1);
    this.panX = Math.max(0, Math.min(width - vbW, this.panX || 0));
    this.panY = Math.max(0, Math.min(height - vbH, this.panY || 0));
    const vbX = this.panX;
    const vbY = this.panY;
    const zoomPct = Math.round((this.zoom || 1) * 100);

    const scaleX = plotW / 100;
    const scaleY = plotH / 100;
    const toX = (x) => padLeft + Math.max(0, Math.min(100, Number(x) || 50)) * scaleX;
    const toY = (y) => padTop + Math.max(0, Math.min(100, Number(y) || 50)) * scaleY;
    const fromSvgX = (px) => Math.round(Math.max(6, Math.min(94, (px - padLeft) / scaleX)) * 10) / 10;
    const fromSvgY = (py) => Math.round(Math.max(6, Math.min(94, (py - padTop) / scaleY)) * 10) / 10;

    // 1. Background Grid (0..100m at 20m intervals)
    let gridHtml = '';
    for (let g = 0; g <= 100; g += 20) {
      const gx = toX(g);
      const gy = toY(g);
      gridHtml += `
        <line x1="${gx.toFixed(1)}" y1="${padTop}" x2="${gx.toFixed(1)}" y2="${padTop + plotH}" class="triangulation-grid-line" />
        <text x="${gx.toFixed(1)}" y="${padTop + plotH + 16}" text-anchor="middle" class="spectrum-axis-label">${g}m</text>
        <line x1="${padLeft}" y1="${gy.toFixed(1)}" x2="${padLeft + plotW}" y2="${gy.toFixed(1)}" class="triangulation-grid-line" />
        <text x="${padLeft - 8}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="spectrum-axis-label">${g}m</text>
      `;
    }

    // Compass rose in top-right corner
    const compassX = padLeft + plotW - 26;
    const compassY = padTop + 26;
    const compassHtml = `
      <g aria-hidden="true" transform="translate(${compassX}, ${compassY})">
        <circle cx="0" cy="0" r="16" fill="var(--color-surface-elevated)" stroke="var(--color-border)" stroke-width="1" />
        <polygon points="0,-12 -4,2 0,-1 4,2" fill="var(--color-primary)" />
        <text x="0" y="-18" text-anchor="middle" class="spectrum-axis-label" style="font-size: 9px; font-weight: 700;">N</text>
      </g>
    `;

    // 2. Active Foreign AP Trilateration Rings & Signal Power Vectors
    const selectedNeighbor =
      this.neighbors.find((n) => n.bssid.toLowerCase() === this.selectedBssid) || null;
    let ringsHtml = '';
    let vectorsHtml = '';

    // Pre-calculate display positions for foreign APs (with slight collision offset if identical)
    const displayCoordsByBssid = new Map();
    const occupiedPoints = [];
    for (const nb of this.neighbors) {
      const tri = nb.triangulation;
      if (!tri) continue;
      let dx = tri.x;
      let dy = tri.y;
      let shiftIdx = 0;
      while (
        occupiedPoints.some((pt) => Math.hypot(pt.x - dx, pt.y - dy) < 3.6) &&
        shiftIdx < 8
      ) {
        shiftIdx++;
        const angle = (shiftIdx * Math.PI) / 4;
        dx = Math.max(6, Math.min(94, tri.x + Math.cos(angle) * 3.8));
        dy = Math.max(6, Math.min(94, tri.y + Math.sin(angle) * 3.8));
      }
      occupiedPoints.push({ x: dx, y: dy });
      displayCoordsByBssid.set(nb.bssid.toLowerCase(), { x: dx, y: dy });
    }

    if (selectedNeighbor && selectedNeighbor.triangulation) {
      const tri = selectedNeighbor.triangulation;
      const disp = displayCoordsByBssid.get(selectedNeighbor.bssid.toLowerCase()) || {
        x: tri.x,
        y: tri.y,
      };
      const targetSvgX = toX(disp.x);
      const targetSvgY = toY(disp.y);

      // Uncertainty error halo around the triangulated foreign AP
      const errRx = Math.max(14, (tri.errorRadiusMeters || 4) * 1.8 * scaleX);
      const errRy = Math.max(14, (tri.errorRadiusMeters || 4) * 1.8 * scaleY);
      ringsHtml += `
        <ellipse cx="${targetSvgX.toFixed(1)}" cy="${targetSvgY.toFixed(1)}"
                 rx="${errRx.toFixed(1)}" ry="${errRy.toFixed(1)}"
                 fill="rgba(245, 158, 11, 0.09)"
                 stroke="rgba(245, 158, 11, 0.45)"
                 stroke-width="1.2"
                 stroke-dasharray="3 3" />
      `;

      // Per-AP RSSI distance rings and signal vectors
      const measurements = Array.isArray(tri.anchorMeasurements) ? tri.anchorMeasurements : [];
      measurements.forEach((m, idx) => {
        const anchorNow = this.anchors.find((a) => a.hostId === m.hostId);
        const ax = anchorNow ? anchorNow.x : m.anchorX;
        const ay = anchorNow ? anchorNow.y : m.anchorY;
        const svgAx = toX(ax);
        const svgAy = toY(ay);
        const rx = Math.max(12, (m.canvasRadius || m.distanceMeters * 1.8) * scaleX);
        const ry = Math.max(12, (m.canvasRadius || m.distanceMeters * 1.8) * scaleY);

        const ringColors = ['#3b82f6', '#10b981', '#a855f7', '#06b6d4'];
        const ringColor = ringColors[idx % ringColors.length];

        ringsHtml += `
          <ellipse cx="${svgAx.toFixed(1)}" cy="${svgAy.toFixed(1)}"
                   rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"
                   fill="none"
                   stroke="${ringColor}"
                   stroke-width="1.5"
                   stroke-dasharray="6 4"
                   opacity="0.55" />
        `;

        const midX = (svgAx + targetSvgX) / 2;
        const midY = (svgAy + targetSvgY) / 2;
        const labelText = `${m.signalDbm} dBm (~${m.distanceMeters}m)`;
        const pillW = labelText.length * 6.2 + 12;

        vectorsHtml += `
          <g aria-hidden="true">
            <line x1="${svgAx.toFixed(1)}" y1="${svgAy.toFixed(1)}"
                  x2="${targetSvgX.toFixed(1)}" y2="${targetSvgY.toFixed(1)}"
                  stroke="${ringColor}"
                  stroke-width="1.8"
                  stroke-dasharray="4 3"
                  opacity="0.85" />
            <rect x="${(midX - pillW / 2).toFixed(1)}" y="${(midY - 9).toFixed(1)}"
                  width="${pillW.toFixed(1)}" height="18" rx="9"
                  fill="var(--color-surface-elevated)"
                  stroke="${ringColor}"
                  stroke-width="1"
                  opacity="0.94" />
            <text x="${midX.toFixed(1)}" y="${(midY + 3.5).toFixed(1)}"
                  text-anchor="middle"
                  style="font-size: 10px; font-family: var(--font-mono); font-weight: 600; fill: var(--color-text-primary);">
              ${escapeHtml(labelText)}
            </text>
          </g>
        `;
      });
    }

    // 3. Foreign AP Markers
    let foreignNodesHtml = '';
    for (const nb of this.neighbors) {
      const tri = nb.triangulation;
      if (!tri) continue;
      const bssidKey = nb.bssid.toLowerCase();
      const isSelected = bssidKey === this.selectedBssid;
      const disp = displayCoordsByBssid.get(bssidKey) || { x: tri.x, y: tri.y };
      const sx = toX(disp.x);
      const sy = toY(disp.y);

      const sig = nb.strongestSignalDbm ?? -85;
      const markerColor =
        tri.confidence === 'high'
          ? '#f59e0b'
          : tri.confidence === 'medium'
            ? '#06b6d4'
            : '#94a3b8';
      const methodLabel =
        tri.method === 'trilateration'
          ? `Trilaterated (${tri.apCount} APs)`
          : tri.method === 'bilateration'
            ? 'Bilaterated (2 APs)'
            : 'Proximity Ring (1 AP)';
      const shortSsid =
        nb.ssid && nb.ssid.length > 18 ? `${nb.ssid.slice(0, 16)}…` : nb.ssid || '(Hidden)';
      const mfgLabel = nb.manufacturer || nb.bssidManufacturer || resolveClientSideVendor(nb.bssid, nb.ssid);

      foreignNodesHtml += `
        <g class="triangulation-foreign-node ${isSelected ? 'selected' : ''}"
           data-bssid="${escapeHtml(bssidKey)}"
           tabindex="0"
           role="button"
           aria-pressed="${isSelected ? 'true' : 'false'}"
           aria-label="Foreign AP ${escapeHtml(nb.ssid)}, Manufacturer ${escapeHtml(mfgLabel)}, BSSID ${escapeHtml(nb.bssid.toUpperCase())}, Channel ${nb.channel}, Peak ${sig} dBm, ${methodLabel}, ${escapeHtml(tri.bearingLabel || '')}"
           transform="translate(${sx.toFixed(1)}, ${sy.toFixed(1)})">
          ${
            isSelected
              ? `<circle cx="0" cy="0" r="16" fill="none" stroke="${markerColor}" stroke-width="2" stroke-dasharray="3 2" />`
              : ''
          }
          <circle cx="0" cy="0" r="${isSelected ? '9' : '7'}"
                  fill="var(--color-surface-elevated)"
                  stroke="${markerColor}"
                  stroke-width="${isSelected ? '2.8' : '2'}" />
          <line x1="-4" y1="0" x2="4" y2="0" stroke="${markerColor}" stroke-width="1.5" />
          <line x1="0" y1="-4" x2="0" y2="4" stroke="${markerColor}" stroke-width="1.5" />
          <text x="0" y="${isSelected ? '23' : '20'}"
                text-anchor="middle"
                style="font-size: 11px; font-weight: ${isSelected ? '700' : '600'}; fill: var(--color-text-primary);">
            ${escapeHtml(shortSsid)}
          </text>
          <text x="0" y="${isSelected ? '34' : '31'}"
                text-anchor="middle"
                style="font-size: 9.5px; font-family: var(--font-mono); fill: var(--color-text-muted);">
            Ch ${nb.channel} • ${sig} dBm
          </text>
        </g>
      `;
    }

    // 4. Managed OpenWrt AP Anchor Nodes (Draggable)
    let anchorNodesHtml = '';
    for (const anchor of this.anchors) {
      const ax = toX(anchor.x);
      const ay = toY(anchor.y);
      const shortName =
        anchor.hostName && anchor.hostName.length > 20
          ? `${anchor.hostName.slice(0, 18)}…`
          : anchor.hostName;

      anchorNodesHtml += `
        <g class="triangulation-anchor-node"
           data-host-id="${escapeHtml(anchor.hostId)}"
           tabindex="0"
           role="button"
           aria-label="Managed OpenWrt AP ${escapeHtml(anchor.hostName)} at (${anchor.x}m, ${anchor.y}m). Drag to calibrate physical AP position."
           transform="translate(${ax.toFixed(1)}, ${ay.toFixed(1)})">
          <circle cx="0" cy="0" r="15" fill="rgba(59, 130, 246, 0.16)" stroke="var(--color-primary)" stroke-width="1.5" />
          <circle cx="0" cy="0" r="9" fill="var(--color-primary)" />
          <circle cx="0" cy="0" r="3.2" fill="#ffffff" />
          <rect x="-54" y="-33" width="108" height="16" rx="8"
                fill="var(--color-surface-elevated)"
                stroke="var(--color-primary)"
                stroke-width="1" />
          <text x="0" y="-21.5" text-anchor="middle"
                style="font-size: 10.5px; font-weight: 700; fill: var(--color-text-primary);">
            ${escapeHtml(shortName)}
          </text>
        </g>
      `;
    }

    const emptyOverlayHtml =
      this.neighbors.length === 0
        ? `
      <g aria-hidden="true">
        <rect x="${width / 2 - 190}" y="${height / 2 - 34}" width="380" height="68" rx="10"
              fill="var(--color-surface-elevated)" stroke="var(--color-border)" opacity="0.92" />
        <text x="${width / 2}" y="${height / 2 - 6}" text-anchor="middle"
              style="font-size: 13px; font-weight: 600; fill: var(--color-text-primary);">
          No Foreign APs Triangulated on ${escapeHtml(this.band)} Yet
        </text>
        <text x="${width / 2}" y="${height / 2 + 15}" text-anchor="middle"
              style="font-size: 11.5px; fill: var(--color-text-muted);">
          Run a Wireless Scan above to triangulate neighboring AP locations from RSSI.
        </text>
      </g>
    `
        : '';

    const selectedSummaryHtml =
      selectedNeighbor && selectedNeighbor.triangulation
        ? `
      <div class="triangulation-Inspector-bar">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <span class="status-pill ${
            selectedNeighbor.triangulation.confidence === 'high'
              ? 'success'
              : selectedNeighbor.triangulation.confidence === 'medium'
                ? 'info'
                : 'warning'
          }">
            ${
              selectedNeighbor.triangulation.method === 'trilateration'
                ? `Trilaterated (${selectedNeighbor.triangulation.apCount} APs)`
                : selectedNeighbor.triangulation.method === 'bilateration'
                  ? 'Bilaterated (2 APs)'
                  : 'Single-AP Proximity Ring'
            }
          </span>
          <span style="font-size: 13px; font-weight: 700; color: var(--color-text-primary);">
            ${escapeHtml(selectedNeighbor.ssid)}
          </span>
          <span class="status-pill">
            ${escapeHtml(selectedNeighbor.manufacturer || selectedNeighbor.bssidManufacturer || resolveClientSideVendor(selectedNeighbor.bssid, selectedNeighbor.ssid))}
          </span>
          <span class="font-mono" style="font-size: 12px; color: var(--color-text-secondary);">
            (${escapeHtml(selectedNeighbor.bssid.toUpperCase())} • Ch ${selectedNeighbor.channel})
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--color-text-secondary); flex-wrap: wrap;">
          <span>Position: <strong class="font-mono">(${selectedNeighbor.triangulation.x}m, ${selectedNeighbor.triangulation.y}m)</strong></span>
          <span>Bearing: <strong>${escapeHtml(selectedNeighbor.triangulation.bearingLabel)}</strong></span>
          <span>Confidence: <strong class="font-mono">${selectedNeighbor.triangulation.confidencePct}% (±${selectedNeighbor.triangulation.errorRadiusMeters}m)</strong></span>
        </div>
      </div>
    `
        : '';

    this.container.innerHTML = `
      <div class="triangulation-viewport">
        <div class="triangulation-map-toolbar" role="toolbar" aria-label="Triangulation Map Zoom and Size Controls">
          <button type="button" class="triangulation-toolbar-btn" data-tri-action="zoom-in" title="Zoom In (+)" aria-label="Zoom In">
            ${renderIcon('zoomIn', 'icon')}
          </button>
          <button type="button" class="triangulation-toolbar-btn" data-tri-action="zoom-out" title="Zoom Out (-)" aria-label="Zoom Out">
            ${renderIcon('zoomOut', 'icon')}
          </button>
          <button type="button" class="triangulation-toolbar-btn" data-tri-action="zoom-reset" title="Reset Zoom &amp; Pan (100%)" aria-label="Reset Zoom (${zoomPct}%)">
            ${zoomPct}%
          </button>
          <span style="width: 1px; height: 16px; background: var(--color-border); margin: 0 2px;"></span>
          <button type="button" class="triangulation-toolbar-btn ${this.sizeMode === 'large' ? 'active' : ''}" data-tri-action="toggle-large" title="Toggle Larger Map Height" aria-pressed="${this.sizeMode === 'large' ? 'true' : 'false'}">
            ${this.sizeMode === 'large' ? 'Standard Height' : 'Expand Height'}
          </button>
          <button type="button" class="triangulation-toolbar-btn ${this.sizeMode === 'fullscreen' ? 'active' : ''}" data-tri-action="toggle-fullscreen" title="${this.sizeMode === 'fullscreen' ? 'Exit Full Screen (Esc)' : 'Full Screen Map'}" aria-pressed="${this.sizeMode === 'fullscreen' ? 'true' : 'false'}">
            ${renderIcon(this.sizeMode === 'fullscreen' ? 'minimize' : 'maximize', 'icon')}
            <span>${this.sizeMode === 'fullscreen' ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
        </div>
        <svg class="triangulation-map-svg ${this.zoom > 1 ? 'is-zoomed' : ''}" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Foreign AP RF Triangulation Spatial Map (${escapeHtml(this.band)})">
          <rect x="${padLeft}" y="${padTop}" width="${plotW}" height="${plotH}" rx="8"
                fill="var(--color-bg)" stroke="var(--color-border)" stroke-width="1" />
          ${gridHtml}
          ${compassHtml}
          ${ringsHtml}
          ${vectorsHtml}
          ${foreignNodesHtml}
          ${anchorNodesHtml}
          ${emptyOverlayHtml}
        </svg>
      </div>
      ${selectedSummaryHtml}
    `;

    const svgEl = this.container.querySelector('svg');

    // Toolbar actions (Zoom In, Zoom Out, Reset, Large, Fullscreen)
    this.container.querySelectorAll('[data-tri-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-tri-action');
        if (action === 'zoom-in') {
          this.setZoom((this.zoom || 1) + 0.35);
        } else if (action === 'zoom-out') {
          this.setZoom((this.zoom || 1) - 0.35);
        } else if (action === 'zoom-reset') {
          this.setZoom(1);
        } else if (action === 'toggle-large') {
          this.setSizeMode(this.sizeMode === 'large' ? 'standard' : 'large');
        } else if (action === 'toggle-fullscreen') {
          this.setSizeMode(this.sizeMode === 'fullscreen' ? 'standard' : 'fullscreen');
        }
      });
    });

    // Attach wheel zoom when Ctrl/Cmd is pressed or in fullscreen/zoomed mode
    svgEl?.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey && this.sizeMode !== 'fullscreen' && this.zoom <= 1) {
          return;
        }
        e.preventDefault();
        const rect = svgEl.getBoundingClientRect();
        const curVbW = width / (this.zoom || 1);
        const curVbH = height / (this.zoom || 1);
        const focusX = this.panX + ((e.clientX - rect.left) / (rect.width || 1)) * curVbW;
        const focusY = this.panY + ((e.clientY - rect.top) / (rect.height || 1)) * curVbH;
        const delta = e.deltaY < 0 ? 0.25 : -0.25;
        this.setZoom((this.zoom || 1) + delta, focusX, focusY);
      },
      { passive: false }
    );

    // Background drag-to-pan when zoomed in
    let isPanningBg = false;
    let panStartClientX = 0;
    let panStartClientY = 0;
    let panStartOriginX = 0;
    let panStartOriginY = 0;

    svgEl?.addEventListener('pointerdown', (e) => {
      if (this.zoom <= 1) return;
      if (e.target.closest('.triangulation-anchor-node') || e.target.closest('.triangulation-foreign-node')) {
        return;
      }
      isPanningBg = true;
      panStartClientX = e.clientX;
      panStartClientY = e.clientY;
      panStartOriginX = this.panX;
      panStartOriginY = this.panY;
      svgEl.classList.add('is-panning');
      svgEl.setPointerCapture?.(e.pointerId);
    });

    svgEl?.addEventListener('pointermove', (e) => {
      if (!isPanningBg) return;
      const rect = svgEl.getBoundingClientRect();
      const curVbW = width / (this.zoom || 1);
      const curVbH = height / (this.zoom || 1);
      const dxSvg = ((e.clientX - panStartClientX) / (rect.width || 1)) * curVbW;
      const dySvg = ((e.clientY - panStartClientY) / (rect.height || 1)) * curVbH;
      this.panX = Math.max(0, Math.min(width - curVbW, panStartOriginX - dxSvg));
      this.panY = Math.max(0, Math.min(height - curVbH, panStartOriginY - dySvg));
      svgEl.setAttribute('viewBox', `${this.panX.toFixed(1)} ${this.panY.toFixed(1)} ${curVbW.toFixed(1)} ${curVbH.toFixed(1)}`);
    });

    const endPanBg = (e) => {
      if (!isPanningBg) return;
      isPanningBg = false;
      svgEl.classList.remove('is-panning');
      svgEl.releasePointerCapture?.(e.pointerId);
    };
    svgEl?.addEventListener('pointerup', endPanBg);
    svgEl?.addEventListener('pointercancel', endPanBg);

    // Attach click + keyboard selection for foreign AP markers
    this.container.querySelectorAll('.triangulation-foreign-node').forEach((node) => {
      const bssid = node.getAttribute('data-bssid');
      const activate = () => this.selectNeighbor(bssid);
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        activate();
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          activate();
        }
        if (e.key === ' ') {
          e.preventDefault();
        }
      });
      node.addEventListener('keyup', (e) => {
        if (e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });

    // Attach pointer drag-and-drop on Managed OpenWrt AP Anchor Nodes to calibrate physical layout
    this.container.querySelectorAll('.triangulation-anchor-node').forEach((anchorEl) => {
      const hostId = anchorEl.getAttribute('data-host-id');
      let isDragging = false;

      const toSvgCoords = (clientX, clientY) => {
        if (!svgEl) return { x: 50, y: 50 };
        const rect = svgEl.getBoundingClientRect();
        const curVbW = width / (this.zoom || 1);
        const curVbH = height / (this.zoom || 1);
        const svgX = this.panX + ((clientX - rect.left) / (rect.width || 1)) * curVbW;
        const svgY = this.panY + ((clientY - rect.top) / (rect.height || 1)) * curVbH;
        return {
          x: fromSvgX(svgX),
          y: fromSvgY(svgY),
          svgX: Math.max(padLeft + 16, Math.min(padLeft + plotW - 16, svgX)),
          svgY: Math.max(padTop + 16, Math.min(padTop + plotH - 16, svgY)),
        };
      };

      anchorEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        isDragging = true;
        this.draggingHostId = hostId;
        anchorEl.setPointerCapture?.(e.pointerId);
      });

      anchorEl.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const coords = toSvgCoords(e.clientX, e.clientY);
        anchorEl.setAttribute('transform', `translate(${coords.svgX.toFixed(1)}, ${coords.svgY.toFixed(1)})`);
      });

      const finishDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        this.draggingHostId = null;
        anchorEl.releasePointerCapture?.(e.pointerId);
        const coords = toSvgCoords(e.clientX, e.clientY);
        const anchorObj = this.anchors.find((a) => a.hostId === hostId);
        if (anchorObj) {
          anchorObj.x = coords.x;
          anchorObj.y = coords.y;
        }
        if (this.onAnchorMove) {
          this.onAnchorMove(hostId, { x: coords.x, y: coords.y });
        }
      };

      anchorEl.addEventListener('pointerup', finishDrag);
      anchorEl.addEventListener('pointercancel', () => {
        isDragging = false;
        this.draggingHostId = null;
      });
    });
  }
}
