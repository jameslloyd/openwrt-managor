/**
 * OpenWrt Manager (openwrt-managor)
 * Manufacturer Resolution Engine for MAC Addresses, BSSIDs (including Locally Administered virtual AP BSSIDs),
 * SSIDs, and Client Hostnames.
 */

const OUI_PREFIXES = {
  // GL.iNet
  '94:83:c4': 'GL.iNet',
  'e4:95:6e': 'GL.iNet',
  'dd:28:19': 'GL.iNet',

  // TP-Link
  '70:4f:57': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  'b0:be:76': 'TP-Link',
  '14:eb:b6': 'TP-Link',
  '18:d6:c7': 'TP-Link',
  '1c:3b:f3': 'TP-Link',
  '28:87:ba': 'TP-Link',
  '30:de:4b': 'TP-Link',
  '34:60:f9': 'TP-Link',
  '40:ed:00': 'TP-Link',
  '54:af:97': 'TP-Link',
  '5c:a6:e6': 'TP-Link',
  '60:32:b1': 'TP-Link',
  '68:ff:7b': 'TP-Link',
  '74:da:88': 'TP-Link',
  '84:16:f9': 'TP-Link',
  '98:da:c4': 'TP-Link',
  'a8:42:a1': 'TP-Link',
  'ac:84:c6': 'TP-Link',
  'b0:4e:26': 'TP-Link',
  'b0:95:75': 'TP-Link',
  'c0:06:c3': 'TP-Link',
  'c0:25:e9': 'TP-Link',
  'cc:32:e5': 'TP-Link',
  'd8:07:b6': 'TP-Link',
  'd8:47:32': 'TP-Link',
  'e4:c3:2a': 'TP-Link',
  'e8:48:b8': 'TP-Link',
  'f4:f2:6d': 'TP-Link',

  // Ubiquiti
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
  'ac:8b:a9': 'Ubiquiti',
  'b4:fb:e4': 'Ubiquiti',
  'd0:21:f9': 'Ubiquiti',
  'dc:9f:db': 'Ubiquiti',
  'e0:63:da': 'Ubiquiti',
  'f4:92:bf': 'Ubiquiti',
  'fc:ec:da': 'Ubiquiti',

  // ASUS / ASUSTek
  '04:42:1a': 'ASUS',
  '04:92:26': 'ASUS',
  '04:d4:c4': 'ASUS',
  '08:60:6e': 'ASUS',
  '08:bfb8': 'ASUS',
  '10:7b:44': 'ASUS',
  '14:da:e9': 'ASUS',
  '1c:87:2c': 'ASUS',
  '24:4b:fe': 'ASUS',
  '2c:4d:54': 'ASUS',
  '2c:56:dc': 'ASUS',
  '30:5a:3a': 'ASUS',
  '30:85:a9': 'ASUS',
  '34:97:f6': 'ASUS',
  '38:2c:4a': 'ASUS',
  '38:d5:47': 'ASUS',
  '3c:7c:3f': 'ASUS',
  '40:b0:76': 'ASUS',
  '50:46:5d': 'ASUS',
  '60:45:cb': 'ASUS',
  '70:8b:cd': 'ASUS',
  '7c:10:c9': 'ASUS',
  '88:d7:f6': 'ASUS',
  '90:e6:ba': 'ASUS',
  'a8:5e:45': 'ASUS',
  'ac:22:0b': 'ASUS',
  'ac:9e:17': 'ASUS',
  'b0:6e:bf': 'ASUS',
  'c8:60:00': 'ASUS',
  'c8:7f:54': 'ASUS',
  'd8:50:e6': 'ASUS',
  'e0:3f:49': 'ASUS',
  'f0:2f:74': 'ASUS',
  'f8:32:e4': 'ASUS',

  // Netgear
  '00:09:5b': 'Netgear',
  '00:14:6c': 'Netgear',
  '00:1b:2f': 'Netgear',
  '00:1e:2a': 'Netgear',
  '00:24:b2': 'Netgear',
  '00:26:f2': 'Netgear',
  '08:bd:43': 'Netgear',
  '10:0c:6b': 'Netgear',
  '10:da:43': 'Netgear',
  '14:59:c0': 'Netgear',
  '20:0c:c8': 'Netgear',
  '20:e5:2a': 'Netgear',
  '28:80:88': 'Netgear',
  '28:c6:8e': 'Netgear',
  '2c:b0:5d': 'Netgear',
  '34:98:b5': 'Netgear',
  '38:94:ed': 'Netgear',
  '3c:37:86': 'Netgear',
  '40:5d:82': 'Netgear',
  '44:a5:6e': 'Netgear',
  '4c:60:de': 'Netgear',
  '6c:b0:ce': 'Netgear',
  '78:d2:94': 'Netgear',
  '80:cc:9c': 'Netgear',
  '84:1b:5e': 'Netgear',
  '9c:3d:cf': 'Netgear',
  '9c:c9:eb': 'Netgear',
  'a0:04:60': 'Netgear',
  'a0:40:a0': 'Netgear',
  'b0:39:56': 'Netgear',
  'b0:7f:b9': 'Netgear',
  'c0:ff:d4': 'Netgear',
  'c4:04:15': 'Netgear',
  'cc:40:d0': 'Netgear',
  'dc:ef:09': 'Netgear',
  'e0:46:9a': 'Netgear',
  'e0:91:f5': 'Netgear',

  // MikroTik
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

  // Linksys / Belkin
  '00:14:bf': 'Linksys',
  '00:18:f8': 'Linksys',
  '00:22:6b': 'Linksys',
  '14:91:82': 'Linksys / Belkin',
  '20:aa:4b': 'Linksys',
  '30:23:03': 'Linksys',
  '48:f8:b3': 'Linksys',
  '58:ef:68': 'Linksys',
  '60:38:e0': 'Linksys / Belkin',
  '94:10:3e': 'Linksys / Belkin',
  'b4:75:0e': 'Linksys / Belkin',
  'c0:56:27': 'Linksys / Belkin',
  'c8:b3:73': 'Linksys',

  // D-Link
  '00:1b:11': 'D-Link',
  '00:26:5a': 'D-Link',
  '14:d6:4d': 'D-Link',
  '1c:7e:e5': 'D-Link',
  '28:10:7b': 'D-Link',
  '3c:1e:04': 'D-Link',
  '78:32:1b': 'D-Link',
  'c8:be:19': 'D-Link',
  'f0:7d:68': 'D-Link',

  // AVM FRITZ!Box
  '00:04:0e': 'AVM (FRITZ!Box)',
  '24:65:11': 'AVM (FRITZ!Box)',
  '34:31:c4': 'AVM (FRITZ!Box)',
  '3c:a6:2f': 'AVM (FRITZ!Box)',
  '44:4e:6d': 'AVM (FRITZ!Box)',
  '5c:49:79': 'AVM (FRITZ!Box)',
  '7c:ff:4d': 'AVM (FRITZ!Box)',
  '9c:c7:a6': 'AVM (FRITZ!Box)',
  'c8:0e:14': 'AVM (FRITZ!Box)',
  'dc:39:6f': 'AVM (FRITZ!Box)',
  'e0:28:6d': 'AVM (FRITZ!Box)',

  // ISP Gateways: Sky, BT, Virgin Media, Sagemcom, Technicolor, Arcadyan, Arris, Sercomm, Nokia, Zyxel, Huawei, ZTE
  '38:a2:8c': 'Sky UK',
  '78:3e:53': 'Sky UK',
  '90:5c:44': 'Sky UK',
  'c0:3e:0f': 'Sky UK',
  'd4:5d:df': 'Sky UK',
  '00:19:70': 'Zyxel',
  '08:26:97': 'Zyxel',
  '1c:74:0d': 'Zyxel',
  '4c:9e:ff': 'Zyxel',
  '50:eb:f6': 'Zyxel',
  'b8:e8:56': 'Zyxel',
  'c8:b4:22': 'Sagemcom',
  '18:62:2c': 'Sagemcom',
  '28:9e:fc': 'Sagemcom',
  '4c:17:eb': 'Sagemcom',
  '68:15:90': 'Sagemcom',
  '7c:03:d8': 'Sagemcom',
  '9c:50:ee': 'Sagemcom',
  'a8:4e:3f': 'Sagemcom',
  '10:13:31': 'Technicolor',
  '30:93:bc': 'Technicolor',
  '58:90:43': 'Technicolor',
  '88:f7:c7': 'Technicolor',
  'a4:b1:e9': 'Technicolor',
  'c4:ea:1d': 'Technicolor',
  'e0:b9:e5': 'Technicolor',
  '18:83:bf': 'Arcadyan',
  '50:78:b3': 'Arcadyan',
  '74:31:70': 'Arcadyan',
  '88:03:55': 'Arcadyan',
  'ec:a9:40': 'Arcadyan',
  '00:1d:d1': 'Arris / CommScope',
  '20:3d:66': 'Arris / CommScope',
  '5c:e3:0e': 'Arris / CommScope',
  '84:61:a0': 'Arris / CommScope',
  '90:c7:d8': 'Arris / CommScope',
  'd4:04:cd': 'Arris / CommScope',
  '00:0e:8f': 'Sercomm',
  '14:c0:3e': 'Sercomm',
  '48:83:c7': 'Sercomm',
  'e8:f1:b0': 'Sercomm',
  '00:25:9e': 'Huawei',
  '04:f9:38': 'Huawei',
  '20:f3:a3': 'Huawei',
  '28:6e:d4': 'Huawei',
  '48:46:fb': 'Huawei',
  '70:72:3c': 'Huawei',
  '88:53:d4': 'Huawei',
  'c8:d1:5e': 'Huawei',
  'e0:19:1d': 'Huawei',
  'f4:55:9c': 'Huawei',
  '00:19:c6': 'ZTE',
  '34:4b:50': 'ZTE',
  '74:a7:8e': 'ZTE',
  '98:f5:37': 'ZTE',
  'c8:64:c7': 'ZTE',

  // Enterprise & Mesh APs: Cisco / Meraki, Aruba, Ruckus, eero, Google, Tenda, Cudy, DrayTek
  '00:18:0a': 'Cisco Meraki',
  '0c:8d:db': 'Cisco Meraki',
  '34:56:fe': 'Cisco Meraki',
  '88:15:44': 'Cisco Meraki',
  'e0:55:3d': 'Cisco Meraki',
  'e0:cb:bc': 'Cisco Meraki',
  '00:0b:86': 'HPE Aruba',
  '18:64:72': 'HPE Aruba',
  '24:de:c6': 'HPE Aruba',
  '6c:f3:7f': 'HPE Aruba',
  '94:b4:0f': 'HPE Aruba',
  '2c:c5:d3': 'CommScope Ruckus',
  '58:93:96': 'CommScope Ruckus',
  '74:91:1a': 'CommScope Ruckus',
  'c8:03:f5': 'CommScope Ruckus',
  '40:70:f5': 'Amazon eero',
  '50:0f:f5': 'Amazon eero',
  '68:ff:fd': 'Amazon eero',
  '74:ac:b9': 'Amazon eero',
  'f8:bb:bf': 'Amazon eero',
  'c8:3a:35': 'Tenda',
  'd8:32:14': 'Tenda',
  '00:50:7f': 'DrayTek',
  '14:49:bc': 'DrayTek',
  '74:26:ff': 'SpaceX Starlink',
  '28:16:a8': 'SpaceX Starlink',

  // WiFi / Ethernet Silicon (MediaTek, Qualcomm, Broadcom, Intel, Realtek)
  '00:0c:43': 'MediaTek / Ralink',
  '00:0e:8e': 'MediaTek',
  '00:03:7f': 'Qualcomm Atheros',
  '00:13:74': 'Qualcomm Atheros',
  '40:45:da': 'Qualcomm',
  '00:10:18': 'Broadcom',
  '00:90:4c': 'Broadcom',
  '00:e0:4c': 'Realtek',
  '52:54:00': 'QEMU / KVM Virtual NIC',
  'bc:24:11': 'Proxmox / QEMU',
  '00:50:56': 'VMware',
  '00:0c:29': 'VMware',
  '00:15:5d': 'Microsoft Hyper-V',

  // Apple
  'a4:83:e7': 'Apple, Inc.',
  'f0:99:bf': 'Apple, Inc.',
  '1c:59:9b': 'Apple, Inc.',
  '40:a3:cc': 'Apple, Inc.',
  '00:1c:b3': 'Apple, Inc.',
  '04:52:f3': 'Apple, Inc.',
  '10:dd:b1': 'Apple, Inc.',
  '14:7d:da': 'Apple, Inc.',
  '18:65:90': 'Apple, Inc.',
  '24:a0:74': 'Apple, Inc.',
  '28:cf:e9': 'Apple, Inc.',
  '34:36:3b': 'Apple, Inc.',
  '38:f9:d3': 'Apple, Inc.',
  '3c:06:30': 'Apple, Inc.',
  '3c:22:fb': 'Apple, Inc.',
  '48:d7:05': 'Apple, Inc.',
  '50:ed:3c': 'Apple, Inc.',
  '58:b0:35': 'Apple, Inc.',
  '60:03:08': 'Apple, Inc.',
  '64:b9:e8': 'Apple, Inc.',
  '6c:40:08': 'Apple, Inc.',
  '70:56:81': 'Apple, Inc.',
  '78:31:c1': 'Apple, Inc.',
  '7c:d1:c3': 'Apple, Inc.',
  '80:e6:50': 'Apple, Inc.',
  '84:38:35': 'Apple, Inc.',
  '88:66:5a': 'Apple, Inc.',
  '8c:85:90': 'Apple, Inc.',
  '90:b0:ed': 'Apple, Inc.',
  '98:01:a7': 'Apple, Inc.',
  'a0:99:9b': 'Apple, Inc.',
  'a8:20:66': 'Apple, Inc.',
  'ac:bc:32': 'Apple, Inc.',
  'b0:34:95': 'Apple, Inc.',
  'b8:09:8a': 'Apple, Inc.',
  'bc:52:b7': 'Apple, Inc.',
  'c8:2a:14': 'Apple, Inc.',
  'd0:81:7a': 'Apple, Inc.',
  'dc:a9:04': 'Apple, Inc.',
  'e0:ac:cb': 'Apple, Inc.',
  'f0:18:98': 'Apple, Inc.',
  'f4:0f:24': 'Apple, Inc.',
  'f8:ff:c2': 'Apple, Inc.',

  // Samsung
  '00:12:47': 'Samsung',
  '08:d4:2b': 'Samsung',
  '14:49:e0': 'Samsung',
  '24:4b:03': 'Samsung',
  '28:27:bf': 'Samsung',
  '34:23:ba': 'Samsung',
  '38:01:97': 'Samsung',
  '50:01:d9': 'Samsung',
  '60:a1:0a': 'Samsung',
  '78:47:1d': 'Samsung',
  '84:25:db': 'Samsung',
  '94:35:0a': 'Samsung',
  'a8:9f:ba': 'Samsung',
  'bc:14:ef': 'Samsung',
  'c4:73:1e': 'Samsung',
  'd0:22:be': 'Samsung',
  'e4:7c:f9': 'Samsung',
  'f4:42:8f': 'Samsung',

  // Google / Nest
  '3c:5a:b4': 'Google',
  '48:d6:d5': 'Google',
  '54:60:09': 'Google',
  '64:16:66': 'Google / Nest',
  '18:b4:30': 'Google / Nest',
  'd4:f5:47': 'Google',
  'f4:f5:d8': 'Google',
  'f8:8f:ca': 'Google',

  // Raspberry Pi, Espressif, Shelly, Sonos, Philips, Sony, Valve, PC hardware
  'dc:a6:32': 'Raspberry Pi',
  'b8:27:eb': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '28:cd:c1': 'Raspberry Pi',
  'd8:3a:dd': 'Raspberry Pi',
  '2c:cf:67': 'Raspberry Pi',
  '24:0a:c4': 'Espressif (ESP32/8266)',
  '24:6f:28': 'Espressif (ESP32/8266)',
  '30:ae:a4': 'Espressif (ESP32/8266)',
  '3c:71:bf': 'Espressif (ESP32/8266)',
  '48:3f:da': 'Shelly / Allterco',
  '84:cc:a8': 'Espressif (ESP32/8266)',
  '8c:aa:b5': 'Espressif (ESP32/8266)',
  'a4:cf:12': 'Espressif (ESP32/8266)',
  'b4:e6:2d': 'Espressif (ESP32/8266)',
  'c4:4f:33': 'Espressif (ESP32/8266)',
  'dc:4f:22': 'Espressif (ESP32/8266)',
  'ec:fa:bc': 'Espressif (ESP32/8266)',
  '00:17:88': 'Philips Hue (Signify)',
  'ec:b5:fa': 'Philips Hue (Signify)',
  '94:9f:3e': 'Sonos, Inc.',
  '00:0e:58': 'Sonos, Inc.',
  '34:7e:5c': 'Sonos, Inc.',
  '48:a6:b8': 'Sonos, Inc.',
  '54:2a:1b': 'Sonos, Inc.',
  '5c:aa:fd': 'Sonos, Inc.',
  '78:28:ca': 'Sonos, Inc.',
  'b8:e9:37': 'Sonos, Inc.',
  'fc:f1:52': 'Sony',
  '00:d9:d1': 'Sony',
  '70:9e:29': 'Sony Interactive',
  'd8:43:ae': 'Valve',
  '00:25:90': 'Supermicro',
  '3c:ec:ef': 'Supermicro',
  'e0:d5:5e': 'GIGABYTE / Intel',
  '18:c0:4d': 'GIGABYTE',
  '74:56:3c': 'GIGABYTE',
  'b4:2e:99': 'GIGABYTE',
  '00:11:32': 'Synology',
  '24:5e:be': 'QNAP',
  '00:1b:21': 'Intel Corporate',
  '3c:fd:fe': 'Intel Corporate',
  '68:05:ca': 'Intel Corporate',
  '8c:8d:28': 'Intel Corporate',
  'a4:34:d9': 'Intel Corporate',
  'dc:fb:48': 'Intel Corporate',
};

const SSID_MANUFACTURER_PATTERNS = [
  { regex: /^GL-[A-Z0-9]+|glinet|flint|beryl/i, vendor: 'GL.iNet' },
  { regex: /^TP-Link|^Deco|^Archer|^Omada|^Tapo/i, vendor: 'TP-Link' },
  { regex: /^Ubiquiti|^UniFi|^U6-|^U7-|^AmpliFi/i, vendor: 'Ubiquiti' },
  { regex: /^ASUS|^RT-A[CX]|^ZenWiFi|^ROG_/i, vendor: 'ASUS' },
  { regex: /^NETGEAR|^ORBI|^Nighthawk/i, vendor: 'Netgear' },
  { regex: /^MikroTik|^RouterOS|^hAP|^cAP/i, vendor: 'MikroTik' },
  { regex: /^OpenWrt|^LEDE/i, vendor: 'OpenWrt' },
  { regex: /^Linksys|^Velop/i, vendor: 'Linksys' },
  { regex: /^D-Link|^DIR-|^COVR/i, vendor: 'D-Link' },
  { regex: /^FRITZ!/i, vendor: 'AVM (FRITZ!Box)' },
  { regex: /^eero/i, vendor: 'Amazon eero' },
  { regex: /^GoogleWifi|^NestWifi|^Google-Home/i, vendor: 'Google / Nest' },
  { regex: /^STARLINK|^STINKY/i, vendor: 'SpaceX Starlink' },
  { regex: /^Tenda|^Nova/i, vendor: 'Tenda' },
  { regex: /^MERCUSYS|^Halo_/i, vendor: 'Mercusys' },
  { regex: /^Cudy/i, vendor: 'Cudy' },
  { regex: /^HUAWEI|^Honor/i, vendor: 'Huawei' },
  { regex: /^ZTE/i, vendor: 'ZTE' },
  { regex: /^Xiaomi|^Redmi|^Mi_/i, vendor: 'Xiaomi' },
  { regex: /^Zyxel|^Multy/i, vendor: 'Zyxel' },
  { regex: /^DrayTek|^Vigor/i, vendor: 'DrayTek' },
  { regex: /^Synology/i, vendor: 'Synology' },
  { regex: /^Meraki|^Cisco/i, vendor: 'Cisco Meraki' },
  { regex: /^Aruba|^InstantOn/i, vendor: 'HPE Aruba' },
  { regex: /^Ruckus/i, vendor: 'CommScope Ruckus' },
  { regex: /^Forti/i, vendor: 'Fortinet' },
  { regex: /^SKY[A-Z0-9]{4,}|^SkyWiFi|^NOWTV/i, vendor: 'Sky UK' },
  { regex: /^BT-[A-Z0-9]+|^BTHub|^BTWholeHome|^BTWi-fi|^EE-[A-Z0-9]+/i, vendor: 'BT / EE' },
  { regex: /^VM\d{5,}|^VirginMedia/i, vendor: 'Virgin Media' },
  { regex: /^Vodafone|^THG\d+/i, vendor: 'Vodafone' },
  { regex: /^TalkTalk/i, vendor: 'TalkTalk' },
  { regex: /^PLUSNET/i, vendor: 'Plusnet' },
  { regex: /^Hyperoptic/i, vendor: 'Hyperoptic' },
  { regex: /^Three_|^3Wireless/i, vendor: 'Three / Zyxel' },
  { regex: /^xfinity|^XFSETUP|^HOME-[0-9A-F]{4}/i, vendor: 'Comcast Xfinity' },
  { regex: /^ATT[A-Za-z0-9]{4,}/i, vendor: 'AT&T' },
  { regex: /^Verizon|^Fios-/i, vendor: 'Verizon' },
  { regex: /^SpectrumSetup|^MySpectrum/i, vendor: 'Spectrum' },
  { regex: /^Livebox|^Orange-/i, vendor: 'Orange / Sagemcom' },
  { regex: /^Freebox/i, vendor: 'Freebox' },
  { regex: /^Bbox/i, vendor: 'Bouygues Telecom' },
  { regex: /^Swisscom/i, vendor: 'Swisscom' },
  { regex: /^MagentaWLAN|^WLAN-\d{6}/i, vendor: 'Deutsche Telekom' },
  { regex: /\biPhone\b|\biPad\b|\bMacBook\b|\bAirPort\b/i, vendor: 'Apple, Inc.' },
  { regex: /\bGalaxy\b|^Samsung/i, vendor: 'Samsung' },
  { regex: /^DIRECT-[0-9A-F]{2}-HP|^HP-Print/i, vendor: 'HP Inc.' },
  { regex: /^DIRECT-[A-Za-z0-9]+-Canon|^Canon_/i, vendor: 'Canon' },
  { regex: /^DIRECT-[A-Za-z0-9]+-EPSON|^EPSON/i, vendor: 'Epson' },
  { regex: /^DIRECT-[A-Za-z0-9]+-BR|^Brother/i, vendor: 'Brother' },
  { regex: /^DIRECT-roku/i, vendor: 'Roku' },
  { regex: /BRAVIA/i, vendor: 'Sony' },
  { regex: /\[LG\]|^DIRECT-[0-9A-Za-z]+-LG/i, vendor: 'LG Electronics' },
];

const HOSTNAME_MANUFACTURER_PATTERNS = [
  { regex: /iphone|ipad|macbook|imac|mac-mini|mac-studio|apple-tv|homepod|airpods|applewatch/i, vendor: 'Apple, Inc.' },
  { regex: /galaxy|sm-[a-z]\d{3}|samsung/i, vendor: 'Samsung' },
  { regex: /pixel-\d|chromecast|google-home|nest-/i, vendor: 'Google' },
  { regex: /raspberrypi|pi-hole|octopi/i, vendor: 'Raspberry Pi' },
  { regex: /^esp[-_]|esp32|esp8266|tasmota|esphome/i, vendor: 'Espressif (ESP32/8266)' },
  { regex: /^shelly/i, vendor: 'Shelly / Allterco' },
  { regex: /^sonos/i, vendor: 'Sonos, Inc.' },
  { regex: /philips-hue|hue-bridge/i, vendor: 'Philips Hue (Signify)' },
  { regex: /playstation|ps5|ps4|bravia/i, vendor: 'Sony' },
  { regex: /steamdeck|valve/i, vendor: 'Valve' },
  { regex: /nintendo|switch/i, vendor: 'Nintendo' },
  { regex: /xbox|surface/i, vendor: 'Microsoft' },
  { regex: /roku/i, vendor: 'Roku' },
  { regex: /synology|diskstation/i, vendor: 'Synology' },
  { regex: /qnap/i, vendor: 'QNAP' },
  { regex: /proxmox|pve/i, vendor: 'Proxmox / QEMU' },
  { regex: /gl-mt|gl-ax|flint/i, vendor: 'GL.iNet' },
  { regex: /tl-wa|tl-wr|deco|archer|omada/i, vendor: 'TP-Link' },
  { regex: /unifi|ubnt|u6-|u7-/i, vendor: 'Ubiquiti' },
];

/**
 * Resolves a MAC address or BSSID to its IEEE OUI manufacturer.
 * Also unmasks Locally Administered virtual BSSIDs (where bit 1 of the first octet is flipped by hostapd/driver).
 */
export function resolveMacManufacturer(mac) {
  if (!mac || typeof mac !== 'string') return null;
  const cleaned = mac.trim().toLowerCase().replace(/-/g, ':');
  const parts = cleaned.split(':');
  if (parts.length < 3) return null;

  const b0 = parts[0].padStart(2, '0');
  const b1 = parts[1].padStart(2, '0');
  const b2 = parts[2].padStart(2, '0');
  const directPrefix = `${b0}:${b1}:${b2}`;
  if (OUI_PREFIXES[directPrefix]) {
    return OUI_PREFIXES[directPrefix];
  }

  // Check if locally-administered bit (0x02) or virtual BSSID offset was applied to the first octet
  const byte0 = parseInt(b0, 16);
  if (!Number.isNaN(byte0)) {
    const candidates = [
      byte0 & ~0x02,
      byte0 ^ 0x02,
      (byte0 - 2) & 0xff,
      (byte0 + 2) & 0xff,
    ];
    for (const cByte of candidates) {
      const candHex = cByte.toString(16).padStart(2, '0');
      const candPrefix = `${candHex}:${b1}:${b2}`;
      if (OUI_PREFIXES[candPrefix]) {
        return `${OUI_PREFIXES[candPrefix]} (Virtual BSSID)`;
      }
    }
  }

  return null;
}

/**
 * Infers manufacturer or ISP hardware vendor from an SSID string.
 */
export function resolveSsidManufacturer(ssid) {
  if (!ssid || typeof ssid !== 'string' || ssid === '(Hidden Network)') return null;
  const trimmed = ssid.trim();
  for (const item of SSID_MANUFACTURER_PATTERNS) {
    if (item.regex.test(trimmed)) {
      return item.vendor;
    }
  }
  return null;
}

/**
 * Infers manufacturer from a client hostname or model string.
 */
export function resolveHostnameManufacturer(hostname) {
  if (!hostname || typeof hostname !== 'string') return null;
  const trimmed = hostname.trim();
  for (const item of HOSTNAME_MANUFACTURER_PATTERNS) {
    if (item.regex.test(trimmed)) {
      return item.vendor;
    }
  }
  for (const item of SSID_MANUFACTURER_PATTERNS) {
    if (item.regex.test(trimmed)) {
      return item.vendor;
    }
  }
  return null;
}

/**
 * Resolves the best overall manufacturer label for a network device, client, or AP radio/neighbor.
 */
export function lookupVendor(mac, fallbackHint = '') {
  const macVendor = resolveMacManufacturer(mac);
  if (macVendor) {
    return macVendor.replace(' (Virtual BSSID)', '');
  }
  const hintVendor = resolveHostnameManufacturer(fallbackHint) || resolveSsidManufacturer(fallbackHint);
  if (hintVendor) {
    return hintVendor;
  }
  if (mac && typeof mac === 'string') {
    const firstByte = parseInt(mac.slice(0, 2), 16);
    if (!Number.isNaN(firstByte) && (firstByte & 0x02) !== 0) {
      return 'Private / Randomized MAC';
    }
  }
  return 'Unknown Manufacturer';
}

/**
 * Resolves both BSSID manufacturer and SSID manufacturer for a wireless network.
 */
export function resolveWirelessNetworkManufacturer({ bssid = '', ssid = '', wpsManufacturer = '' } = {}) {
  const wps = (wpsManufacturer || '').trim();
  const bssidManufacturer = resolveMacManufacturer(bssid);
  const ssidManufacturer = resolveSsidManufacturer(ssid);

  const baseBssidVendor = bssidManufacturer ? bssidManufacturer.replace(' (Virtual BSSID)', '') : null;
  const manufacturer = wps || baseBssidVendor || ssidManufacturer || 'Unknown Manufacturer';

  return {
    manufacturer,
    bssidManufacturer: bssidManufacturer || (wps ? `${wps} (WPS)` : ssidManufacturer ? `${ssidManufacturer} (SSID)` : 'Unknown OUI'),
    ssidManufacturer: ssidManufacturer || baseBssidVendor || wps || null,
  };
}
