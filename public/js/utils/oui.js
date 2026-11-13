/**
 * OpenWrt Manager (openwrt-managor)
 * Local OUI Vendor Lookup Dictionary
 */

const KNOWN_OUIS = {
  'a4:83:e7': 'Apple, Inc.',
  '40:a3:cc': 'Apple, Inc.',
  '00:e0:4c': 'Realtek Semiconductor',
  '94:83:c4': 'GL Technologies',
  '00:14:d1': 'Trendnet',
  '48:2a:e3': 'Samsung Electronics',
  '68:54:5a': 'Amazon Technologies',
  '00:25:90': 'Super Micro Computer',
  'b8:27:eb': 'Raspberry Pi Foundation',
  'dc:a6:32': 'Raspberry Pi Foundation',
  'e4:5f:01': 'Raspberry Pi Foundation',
  '2c:cf:67': 'Espressif Inc.',
  '30:ae:a4': 'Espressif Inc.',
  '84:0d:8e': 'Shelly / Allterco',
  '00:17:88': 'Philips Lighting',
  '50:c7:bf': 'TP-Link Corporation',
  'ec:08:6b': 'TP-Link Corporation',
  '70:4f:57': 'Intel Corporate',
  '6c:6a:77': 'Intel Corporate',
  '1c:fe:2b': 'Google, Inc.',
  'ac:37:43': 'Google, Inc.',
  'f4:f5:d8': 'Google, Inc.',
  '34:7e:5c': 'LG Electronics',
  'd4:32:60': 'Sony Interactive',
  '00:50:56': 'VMware, Inc.',
  '52:54:00': 'QEMU Virtual NIC'
};

export function lookupVendor(mac, fallback = 'Unknown Vendor') {
  if (!mac) return fallback;
  const clean = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (clean.length < 6) return fallback;
  const prefix = `${clean.slice(0, 2)}:${clean.slice(2, 4)}:${clean.slice(4, 6)}`;
  return KNOWN_OUIS[prefix] || fallback;
}
