/**
 * OpenWrt Manager (openwrt-managor)
 * Formatting Utilities: Bytes, bps, time, RSSI, MAC
 */

export function formatBytes(bytes, decimals = 1) {
  if (bytes === null || bytes === undefined || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(dm))} ${sizes[idx]}`;
}

export function formatBps(bps, decimals = 1) {
  if (bps === null || bps === undefined || isNaN(bps) || bps === 0) return '0 bps';
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.floor(Math.log(Math.abs(bps)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((bps / Math.pow(k, idx)).toFixed(dm))} ${sizes[idx]}`;
}

export function formatByteRate(bytesPerSec, decimals = 1) {
  if (!bytesPerSec) return '0 B/s';
  return `${formatBytes(bytesPerSec, decimals)}/s`;
}

export function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatRelativeTime(dateInput) {
  if (!dateInput) return 'never';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatMac(mac) {
  if (!mac) return '';
  return mac.toUpperCase();
}

export function formatRssi(signalDbm) {
  if (signalDbm === null || signalDbm === undefined) {
    return { dbm: 'N/A', label: 'Wired', level: 5, colorClass: 'wired' };
  }
  const dbm = Number(signalDbm);
  if (dbm >= -55) {
    return { dbm: `${dbm} dBm`, label: 'Excellent', level: 5, colorClass: 'level-5' };
  } else if (dbm >= -67) {
    return { dbm: `${dbm} dBm`, label: 'Good', level: 4, colorClass: 'level-4' };
  } else if (dbm >= -75) {
    return { dbm: `${dbm} dBm`, label: 'Fair', level: 3, colorClass: 'level-3' };
  } else if (dbm >= -82) {
    return { dbm: `${dbm} dBm`, label: 'Weak', level: 2, colorClass: 'level-2' };
  } else {
    return { dbm: `${dbm} dBm`, label: 'Very Weak', level: 1, colorClass: 'level-1' };
  }
}
