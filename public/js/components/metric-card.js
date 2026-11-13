/**
 * OpenWrt Manager (openwrt-managor)
 * Reusable Telemetry KPI Metric Card Component
 */

import { renderIcon } from '../utils/icons.js';

export function renderMetricCard({
  id = '',
  title = '',
  value = '',
  icon = 'activity',
  subtextHtml = '',
  onClick = null,
  isSkeleton = false
}) {
  if (isSkeleton) {
    return `
      <div class="kpi-card">
        <div class="kpi-header">
          <div class="shimmer skeleton-text" style="width: 80px;"></div>
          <div class="shimmer" style="width: 24px; height: 24px; border-radius: 4px;"></div>
        </div>
        <div class="shimmer skeleton-metric"></div>
        <div class="shimmer skeleton-text" style="width: 140px;"></div>
      </div>
    `;
  }

  const cursorStyle = onClick ? 'cursor: pointer;' : '';

  return `
    <div class="kpi-card" id="${id}" style="${cursorStyle}">
      <div class="kpi-header">
        <span class="kpi-title">${title}</span>
        <div class="kpi-icon">${renderIcon(icon, 'icon')}</div>
      </div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-subtext">
        ${subtextHtml}
      </div>
    </div>
  `;
}
