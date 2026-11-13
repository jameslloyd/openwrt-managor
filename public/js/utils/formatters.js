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

const CLIENT_OUI_MAP = {
  '94:83:c4': 'GL.iNet',
  'e4:95:6e': 'GL.iNet',
  'dd:28:19': 'GL.iNet',
  '70:4f:57': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  'b0:be:76': 'TP-Link',
  '14:eb:b6': 'TP-Link',
  '18:d6:c7': 'TP-Link',
  '1c:3b:f3': 'TP-Link',
  '28:87:ba': 'TP-Link',
  '30:de:4b': 'TP-Link',
  '60:32:b1': 'TP-Link',
  '68:ff:7b': 'TP-Link',
  '98:da:c4': 'TP-Link',
  'ac:84:c6': 'TP-Link',
  'b0:95:75': 'TP-Link',
  'c0:06:c3': 'TP-Link',
  'd8:07:b6': 'TP-Link',
  'e8:48:b8': 'TP-Link',
  'f4:f2:6d': 'TP-Link',
  '18:e8:29': 'Ubiquiti',
  '74:83:c2': 'Ubiquiti',
  'f0:9f:c2': 'Ubiquiti',
  '00:27:22': 'Ubiquiti',
  '04:18:d6': 'Ubiquiti',
  '24:5a:4c': 'Ubiquiti',
  '44:d9:e7': 'Ubiquiti',
  '60:22:32': 'Ubiquiti',
  '68:d7:9a': 'Ubiquiti',
  '70:a7:41': 'Ubiquiti',
  '78:45:58': 'Ubiquiti',
  '78:8a:20': 'Ubiquiti',
  '80:2a:a8': 'Ubiquiti',
  'b4:fb:e4': 'Ubiquiti',
  'd0:21:f9': 'Ubiquiti',
  'dc:9f:db': 'Ubiquiti',
  'e0:63:da': 'Ubiquiti',
  'f4:92:bf': 'Ubiquiti',
  'fc:ec:da': 'Ubiquiti',
  '04:42:1a': 'ASUS',
  '04:d4:c4': 'ASUS',
  '10:7b:44': 'ASUS',
  '1c:87:2c': 'ASUS',
  '24:4b:fe': 'ASUS',
  '2c:56:dc': 'ASUS',
  '34:97:f6': 'ASUS',
  '3c:7c:3f': 'ASUS',
  '50:46:5d': 'ASUS',
  '60:45:cb': 'ASUS',
  'ac:9e:17': 'ASUS',
  'd8:50:e6': 'ASUS',
  'f0:2f:74': 'ASUS',
  'f8:32:e4': 'ASUS',
  '00:14:6c': 'Netgear',
  '10:da:43': 'Netgear',
  '20:e5:2a': 'Netgear',
  '28:80:88': 'Netgear',
  '2c:b0:5d': 'Netgear',
  '3c:37:86': 'Netgear',
  '40:5d:82': 'Netgear',
  '6c:b0:ce': 'Netgear',
  '84:1b:5e': 'Netgear',
  '9c:3d:cf': 'Netgear',
  'a0:40:a0': 'Netgear',
  'b0:7f:b9': 'Netgear',
  'c4:04:15': 'Netgear',
  'e0:46:9a': 'Netgear',
  '00:0c:42': 'MikroTik',
  '08:55:31': 'MikroTik',
  '18:fd:74': 'MikroTik',
  '2c:c8:1b': 'MikroTik',
  '48:8f:5a': 'MikroTik',
  '4c:5e:0c': 'MikroTik',
  '64:d1:54': 'MikroTik',
  '6c:3b:6b': 'MikroTik',
  '74:4d:28': 'MikroTik',
  'b8:69:f4': 'MikroTik',
  'c4:ad:34': 'MikroTik',
  'cc:2d:e0': 'MikroTik',
  'd4:ca:6d': 'MikroTik',
  'dc:2c:6e': 'MikroTik',
  'e4:8d:8c': 'MikroTik',
  'c8:b4:22': 'Sagemcom',
  '18:62:2c': 'Sagemcom',
  '4c:17:eb': 'Sagemcom',
  '68:15:90': 'Sagemcom',
  '7c:03:d8': 'Sagemcom',
  '10:13:31': 'Technicolor',
  '58:90:43': 'Technicolor',
  'a4:b1:e9': 'Technicolor',
  'e0:b9:e5': 'Technicolor',
  '38:a2:8c': 'Sky UK',
  '78:3e:53': 'Sky UK',
  '90:5c:44': 'Sky UK',
  'c0:3e:0f': 'Sky UK',
  '00:19:70': 'Zyxel',
  '50:eb:f6': 'Zyxel',
  'b8:e8:56': 'Zyxel',
  '40:70:f5': 'Amazon eero',
  '68:ff:fd': 'Amazon eero',
  '74:ac:b9': 'Amazon eero',
  '74:26:ff': 'SpaceX Starlink',
  '28:16:a8': 'SpaceX Starlink',
  'a4:83:e7': 'Apple, Inc.',
  'f0:99:bf': 'Apple, Inc.',
  '1c:59:9b': 'Apple, Inc.',
  '40:a3:cc': 'Apple, Inc.',
  '3c:22:fb': 'Apple, Inc.',
  '60:03:08': 'Apple, Inc.',
  '8c:85:90': 'Apple, Inc.',
  'bc:52:b7': 'Apple, Inc.',
  'dc:a9:04': 'Apple, Inc.',
  'f0:18:98': 'Apple, Inc.',
  'dc:a6:32': 'Raspberry Pi',
  'b8:27:eb': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '28:cd:c1': 'Raspberry Pi',
  'd8:3a:dd': 'Raspberry Pi',
  '2c:cf:67': 'Raspberry Pi',
  '24:0a:c4': 'Espressif (ESP32/8266)',
  '30:ae:a4': 'Espressif (ESP32/8266)',
  '3c:71:bf': 'Espressif (ESP32/8266)',
  '48:3f:da': 'Shelly / Allterco',
  '00:17:88': 'Philips Hue (Signify)',
  '94:9f:3e': 'Sonos, Inc.',
  'fc:f1:52': 'Sony',
  'd8:43:ae': 'Valve',
  '00:25:90': 'Supermicro',
  '00:e0:4c': 'Realtek',
  'e0:d5:5e': 'GIGABYTE / Intel',
  'bc:24:11': 'Proxmox / QEMU',
  '52:54:00': 'QEMU / KVM Virtual NIC',
};

export function resolveClientSideVendor(mac, hint = '', existingVendor = '') {
  if (
    existingVendor &&
    existingVendor !== 'Unknown Manufacturer' &&
    existingVendor !== 'Network Device' &&
    existingVendor !== 'Unknown'
  ) {
    return existingVendor;
  }
  if (mac && typeof mac === 'string') {
    const cleaned = mac.trim().toLowerCase().replace(/-/g, ':');
    const parts = cleaned.split(':');
    if (parts.length >= 3) {
      const b0 = parts[0].padStart(2, '0');
      const b1 = parts[1].padStart(2, '0');
      const b2 = parts[2].padStart(2, '0');
      const direct = `${b0}:${b1}:${b2}`;
      if (CLIENT_OUI_MAP[direct]) return CLIENT_OUI_MAP[direct];

      const byte0 = parseInt(b0, 16);
      if (!Number.isNaN(byte0)) {
        for (const cand of [byte0 & ~0x02, byte0 ^ 0x02, (byte0 - 2) & 0xff, (byte0 + 2) & 0xff]) {
          const prefix = `${cand.toString(16).padStart(2, '0')}:${b1}:${b2}`;
          if (CLIENT_OUI_MAP[prefix]) return `${CLIENT_OUI_MAP[prefix]} (Virtual BSSID)`;
        }
      }
    }
  }
  if (hint && typeof hint === 'string') {
    if (/gl-mt|gl-ax|flint|glinet/i.test(hint)) return 'GL.iNet';
    if (/tp-link|deco|archer|omada/i.test(hint)) return 'TP-Link';
    if (/ubiquiti|unifi|u6-|u7-/i.test(hint)) return 'Ubiquiti';
    if (/asus|rt-a[cx]|zenwifi/i.test(hint)) return 'ASUS';
    if (/netgear|orbi|nighthawk/i.test(hint)) return 'Netgear';
    if (/mikrotik|routeros/i.test(hint)) return 'MikroTik';
    if (/iphone|ipad|macbook|imac|apple/i.test(hint)) return 'Apple, Inc.';
    if (/galaxy|samsung/i.test(hint)) return 'Samsung';
    if (/pixel|chromecast|nest/i.test(hint)) return 'Google';
    if (/raspberrypi/i.test(hint)) return 'Raspberry Pi';
    if (/esp32|esp8266|tasmota|esphome/i.test(hint)) return 'Espressif (ESP32/8266)';
    if (/shelly/i.test(hint)) return 'Shelly / Allterco';
    if (/openwrt/i.test(hint)) return 'OpenWrt';
  }
  return existingVendor || 'Unknown Manufacturer';
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
