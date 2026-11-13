import { createTarGz, computeSha256 } from './tarUci.js';

export class NetworkSimulator {
  constructor() {
    this.enableRoaming = true;
    this.trafficSpike = false;
    this.simulatedOfflineHost = null;
    this.tickCount = 0;
    this.roamingHistory = new Map(); // mac -> array of roaming events
    this.signalHistory = new Map(); // mac -> array of { timestamp, signalDbm }
    this.initDefaultData();
  }

  initDefaultData() {
    this.hosts = [
      {
        id: 'node-gw-01',
        name: 'Main Gateway',
        hostname: 'OpenWrt-GW',
        model: 'x86/64 Dual 2.5GbE Appliance',
        ip: '192.168.1.1',
        mac: '00:e0:4c:68:01:00',
        role: 'gateway',
        isSimulated: true,
        status: 'online',
        firmware: 'OpenWrt 23.05.4 r24012-d811c7cee8',
        uptimeSec: 864210,
        cpuUsagePct: 12.5,
        memUsagePct: 28.4,
        clientCount: 22,
        lastSeen: new Date().toISOString(),
        wan: {
          ip: '203.0.113.42',
          gateway: '203.0.113.1',
          dns: ['1.1.1.1', '8.8.8.8'],
          speedMbps: 1000,
        },
      },
      {
        id: 'node-ap-01',
        name: 'Living Room AP',
        hostname: 'OpenWrt-LivingRoom',
        model: 'GL.iNet GL-MT6000 (Flint 2)',
        ip: '192.168.1.2',
        mac: '94:83:c4:12:34:56',
        role: 'ap',
        isSimulated: true,
        status: 'online',
        firmware: 'OpenWrt 23.05.4 r24012-d811c7cee8',
        uptimeSec: 432100,
        cpuUsagePct: 8.4,
        memUsagePct: 34.2,
        clientCount: 9,
        lastSeen: new Date().toISOString(),
      },
      {
        id: 'node-ap-02',
        name: 'Office AP',
        hostname: 'OpenWrt-Office',
        model: 'Linksys E8450 (Belkin RT3200)',
        ip: '192.168.1.3',
        mac: '58:d9:d5:78:90:ab',
        role: 'ap',
        isSimulated: true,
        status: 'online',
        firmware: 'OpenWrt 23.05.4 r24012-d811c7cee8',
        uptimeSec: 345600,
        cpuUsagePct: 9.1,
        memUsagePct: 38.0,
        clientCount: 8,
        lastSeen: new Date().toISOString(),
      },
      {
        id: 'node-ap-03',
        name: 'Outdoor AP',
        hostname: 'OpenWrt-Outdoor',
        model: 'TP-Link Archer C7 v5',
        ip: '192.168.1.4',
        mac: '70:4f:57:ab:cd:ef',
        role: 'ap',
        isSimulated: true,
        status: 'online',
        firmware: 'OpenWrt 22.03.6 r20310-9b489a206a',
        uptimeSec: 1209600,
        cpuUsagePct: 14.8,
        memUsagePct: 45.1,
        clientCount: 5,
        lastSeen: new Date().toISOString(),
      },
    ];

    this.radios = {
      '2.4GHz': {
        rangeMhz: [2400, 2484],
        noiseFloorDbm: -95,
        radios: [
          {
            id: 'radio-ap01-2g',
            hostId: 'node-ap-01',
            hostName: 'Living Room AP',
            device: 'radio0',
            ssid: 'Homelab-Main',
            channel: 6,
            centerFreqMhz: 2437,
            widthMhz: 20,
            txPowerDbm: 23,
            signalDbm: -48,
            clientCount: 6,
            utilizationPct: 28.4,
          },
          {
            id: 'radio-ap02-2g',
            hostId: 'node-ap-02',
            hostName: 'Office AP',
            device: 'radio0',
            ssid: 'Homelab-Main',
            channel: 1,
            centerFreqMhz: 2412,
            widthMhz: 20,
            txPowerDbm: 20,
            signalDbm: -52,
            clientCount: 4,
            utilizationPct: 18.2,
          },
          {
            id: 'radio-ap03-2g',
            hostId: 'node-ap-03',
            hostName: 'Outdoor AP',
            device: 'radio0',
            ssid: 'Homelab-Main',
            channel: 6,
            centerFreqMhz: 2437,
            widthMhz: 20,
            txPowerDbm: 24,
            signalDbm: -56,
            clientCount: 3,
            utilizationPct: 34.0,
          },
        ],
      },
      '5GHz': {
        rangeMhz: [5150, 5875],
        noiseFloorDbm: -98,
        radios: [
          {
            id: 'radio-ap01-5g',
            hostId: 'node-ap-01',
            hostName: 'Living Room AP',
            device: 'radio1',
            ssid: 'Homelab-Main',
            channel: 36,
            centerFreqMhz: 5210,
            widthMhz: 80,
            txPowerDbm: 26,
            signalDbm: -42,
            clientCount: 9,
            utilizationPct: 35.1,
          },
          {
            id: 'radio-ap02-5g',
            hostId: 'node-ap-02',
            hostName: 'Office AP',
            device: 'radio1',
            ssid: 'Homelab-Main',
            channel: 36,
            centerFreqMhz: 5210,
            widthMhz: 80,
            txPowerDbm: 24,
            signalDbm: -49,
            clientCount: 5,
            utilizationPct: 38.5,
          },
          {
            id: 'radio-ap03-5g',
            hostId: 'node-ap-03',
            hostName: 'Outdoor AP',
            device: 'radio1',
            ssid: 'Homelab-Outdoor',
            channel: 100,
            centerFreqMhz: 5500,
            widthMhz: 80,
            txPowerDbm: 23,
            signalDbm: -58,
            clientCount: 2,
            utilizationPct: 15.0,
            dfs: { state: 'cac_completed', isDfs: true },
          },
        ],
      },
      '6GHz': {
        rangeMhz: [5925, 7125],
        noiseFloorDbm: -101,
        radios: [
          {
            id: 'radio-ap02-6g',
            hostId: 'node-ap-02',
            hostName: 'Office AP',
            device: 'radio2',
            ssid: 'Homelab-6G',
            channel: 37,
            centerFreqMhz: 6135,
            widthMhz: 80,
            txPowerDbm: 22,
            signalDbm: -54,
            clientCount: 3,
            utilizationPct: 12.0,
          },
          {
            id: 'radio-ap01-6g',
            hostId: 'node-ap-01',
            hostName: 'Living Room AP',
            device: 'radio2',
            ssid: 'Homelab-6G',
            channel: 69,
            centerFreqMhz: 6295,
            widthMhz: 160,
            txPowerDbm: 24,
            signalDbm: -50,
            clientCount: 2,
            utilizationPct: 16.5,
          },
        ],
      },
    };

    this.clients = [
      // --- Wired Clients ---
      {
        mac: '00:25:90:f1:e2:d3',
        ip: '192.168.1.50',
        hostname: 'TrueNAS-SCALE-Storage',
        vendor: 'Supermicro',
        connectionType: 'wired',
        connectedTo: { hostId: 'node-gw-01', hostName: 'Main Gateway', iface: 'eth2' },
        vlan: 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 10000,
        rxRateMbps: 10000,
        txRateMbps: 10000,
        rxRateBps: 24500000,
        txRateBps: 18200000,
        rxBytesTotal: 18492049102,
        txBytesTotal: 14820194820,
        dhcpLeaseRemainingSec: 86400,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'e0:d5:5e:31:82:19',
        ip: '192.168.1.102',
        hostname: 'Workstation-PC',
        vendor: 'Intel Corporate',
        connectionType: 'wired',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'eth1' },
        vlan: 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 2500,
        rxRateMbps: 2500,
        txRateMbps: 2500,
        rxRateBps: 4200000,
        txRateBps: 850000,
        rxBytesTotal: 8492049102,
        txBytesTotal: 3420194820,
        dhcpLeaseRemainingSec: 32000,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '40:a3:cc:89:ab:cd',
        ip: '192.168.1.180',
        hostname: 'LivingRoom-AppleTV',
        vendor: 'Apple, Inc.',
        connectionType: 'wired',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'eth2' },
        vlan: 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 1000,
        rxRateMbps: 1000,
        txRateMbps: 1000,
        rxRateBps: 15200000,
        txRateBps: 450000,
        rxBytesTotal: 9892049102,
        txBytesTotal: 1220194820,
        dhcpLeaseRemainingSec: 54000,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'bc:24:11:90:fe:12',
        ip: '192.168.1.55',
        hostname: 'Proxmox-Node-01',
        vendor: 'Minisforum',
        connectionType: 'wired',
        connectedTo: { hostId: 'node-gw-01', hostName: 'Main Gateway', iface: 'eth3' },
        vlan: 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 2500,
        rxRateMbps: 2500,
        txRateMbps: 2500,
        rxRateBps: 3400000,
        txRateBps: 2100000,
        rxBytesTotal: 4892049102,
        txBytesTotal: 2820194820,
        dhcpLeaseRemainingSec: 86400,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '00:17:88:6a:34:bc',
        ip: '192.168.20.10',
        hostname: 'Philips-Hue-Bridge',
        vendor: 'Signify Netherlands',
        connectionType: 'wired',
        connectedTo: { hostId: 'node-gw-01', hostName: 'Main Gateway', iface: 'eth4' },
        vlan: 20,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 100,
        rxRateMbps: 100,
        txRateMbps: 100,
        rxRateBps: 18000,
        txRateBps: 14000,
        rxBytesTotal: 292049102,
        txBytesTotal: 120194820,
        dhcpLeaseRemainingSec: 62000,
        lastSeen: new Date().toISOString(),
      },

      // --- 5GHz WiFi Clients ---
      {
        mac: 'a4:83:e7:2b:41:89',
        ip: '192.168.1.145',
        hostname: 'James-MacBook-Pro',
        vendor: 'Apple, Inc.',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -52,
        noiseDbm: -95,
        snrDb: 43,
        rxRateMbps: 1201,
        txRateMbps: 1080,
        rxRateBps: 1845000,
        txRateBps: 421000,
        rxBytesTotal: 4892049102,
        txBytesTotal: 1820194820,
        dhcpLeaseRemainingSec: 41200,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'f0:99:bf:14:88:21',
        ip: '192.168.1.150',
        hostname: 'iPhone-15-Pro',
        vendor: 'Apple, Inc.',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -61,
        noiseDbm: -95,
        snrDb: 34,
        rxRateMbps: 866,
        txRateMbps: 866,
        rxRateBps: 450000,
        txRateBps: 120000,
        rxBytesTotal: 2892049102,
        txBytesTotal: 920194820,
        dhcpLeaseRemainingSec: 38000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '1c:59:9b:32:ee:44',
        ip: '192.168.1.155',
        hostname: 'iPad-Pro-M2',
        vendor: 'Apple, Inc.',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -55,
        noiseDbm: -96,
        snrDb: 41,
        rxRateMbps: 1201,
        txRateMbps: 1201,
        rxRateBps: 820000,
        txRateBps: 190000,
        rxBytesTotal: 1892049102,
        txBytesTotal: 620194820,
        dhcpLeaseRemainingSec: 45000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'fc:f1:52:8a:99:32',
        ip: '192.168.1.190',
        hostname: 'Sony-Bravia-OLED',
        vendor: 'Sony Corporation',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -58,
        noiseDbm: -95,
        snrDb: 37,
        rxRateMbps: 866,
        txRateMbps: 866,
        rxRateBps: 22000000,
        txRateBps: 340000,
        rxBytesTotal: 14892049102,
        txBytesTotal: 420194820,
        dhcpLeaseRemainingSec: 52000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '94:9f:3e:12:44:01',
        ip: '192.168.1.195',
        hostname: 'Sonos-Arc-Soundbar',
        vendor: 'Sonos, Inc.',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -64,
        noiseDbm: -95,
        snrDb: 31,
        rxRateMbps: 433,
        txRateMbps: 433,
        rxRateBps: 920000,
        txRateBps: 110000,
        rxBytesTotal: 3892049102,
        txBytesTotal: 320194820,
        dhcpLeaseRemainingSec: 48000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '9c:3b:3f:66:a1:09',
        ip: '192.168.1.170',
        hostname: 'Nintendo-Switch-OLED',
        vendor: 'Nintendo Co., Ltd.',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -63,
        noiseDbm: -96,
        snrDb: 33,
        rxRateMbps: 433,
        txRateMbps: 433,
        rxRateBps: 640000,
        txRateBps: 120000,
        rxBytesTotal: 2192049102,
        txBytesTotal: 220194820,
        dhcpLeaseRemainingSec: 36000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'd8:43:ae:55:01:77',
        ip: '192.168.1.175',
        hostname: 'Steam-Deck-OLED',
        vendor: 'Valve Corporation',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1' },
        ssid: 'Homelab-Main',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -59,
        noiseDbm: -96,
        snrDb: 37,
        rxRateMbps: 1201,
        txRateMbps: 1201,
        rxRateBps: 4800000,
        txRateBps: 340000,
        rxBytesTotal: 6892049102,
        txBytesTotal: 820194820,
        dhcpLeaseRemainingSec: 42000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '50:76:af:99:21:bb',
        ip: '192.168.10.40',
        hostname: 'Guest-ThinkPad',
        vendor: 'Lenovo',
        connectionType: 'wifi_5g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1-guest' },
        ssid: 'Homelab-Guest',
        channel: 36,
        band: '5GHz',
        channelWidthMhz: 80,
        signalDbm: -67,
        noiseDbm: -96,
        snrDb: 29,
        rxRateMbps: 866,
        txRateMbps: 866,
        rxRateBps: 380000,
        txRateBps: 90000,
        rxBytesTotal: 992049102,
        txBytesTotal: 220194820,
        dhcpLeaseRemainingSec: 18000,
        vlan: 10,
        isGuest: true,
        lastSeen: new Date().toISOString(),
      },

      // --- 6GHz WiFi Clients ---
      {
        mac: '38:14:28:90:33:41',
        ip: '192.168.1.148',
        hostname: 'Dell-XPS-Developer',
        vendor: 'Intel Corporate',
        connectionType: 'wifi_6g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan2' },
        ssid: 'Homelab-6G',
        channel: 37,
        band: '6GHz',
        channelWidthMhz: 80,
        signalDbm: -49,
        noiseDbm: -101,
        snrDb: 52,
        rxRateMbps: 2402,
        txRateMbps: 2402,
        rxRateBps: 8400000,
        txRateBps: 2100000,
        rxBytesTotal: 12892049102,
        txBytesTotal: 5820194820,
        dhcpLeaseRemainingSec: 46000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '84:c7:ea:11:77:23',
        ip: '192.168.1.152',
        hostname: 'Galaxy-S24-Ultra',
        vendor: 'Samsung Electronics',
        connectionType: 'wifi_6g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan2' },
        ssid: 'Homelab-6G',
        channel: 69,
        band: '6GHz',
        channelWidthMhz: 160,
        signalDbm: -50,
        noiseDbm: -101,
        snrDb: 51,
        rxRateMbps: 2402,
        txRateMbps: 2402,
        rxRateBps: 1400000,
        txRateBps: 450000,
        rxBytesTotal: 3892049102,
        txBytesTotal: 1420194820,
        dhcpLeaseRemainingSec: 44000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '48:d7:05:88:aa:19',
        ip: '192.168.1.153',
        hostname: 'Pixel-8-Pro',
        vendor: 'Google LLC',
        connectionType: 'wifi_6g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan2' },
        ssid: 'Homelab-6G',
        channel: 37,
        band: '6GHz',
        channelWidthMhz: 80,
        signalDbm: -53,
        noiseDbm: -101,
        snrDb: 48,
        rxRateMbps: 2402,
        txRateMbps: 2402,
        rxRateBps: 980000,
        txRateBps: 280000,
        rxBytesTotal: 2892049102,
        txBytesTotal: 980194820,
        dhcpLeaseRemainingSec: 42000,
        vlan: 1,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },

      // --- 2.4GHz WiFi Clients (IoT & Smart Home) ---
      {
        mac: '68:54:5a:98:76:54',
        ip: '192.168.20.45',
        hostname: 'Ring-Doorbell-Pro',
        vendor: 'Amazon Technologies',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 6,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -78,
        noiseDbm: -95,
        snrDb: 17,
        rxRateMbps: 72,
        txRateMbps: 72,
        rxRateBps: 65000,
        txRateBps: 450000,
        rxBytesTotal: 1892049102,
        txBytesTotal: 4820194820,
        dhcpLeaseRemainingSec: 24000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '48:3f:da:77:11:02',
        ip: '192.168.20.60',
        hostname: 'Shelly-Plug-Office',
        vendor: 'Allterco Robotics',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 1,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -69,
        noiseDbm: -95,
        snrDb: 26,
        rxRateMbps: 72,
        txRateMbps: 72,
        rxRateBps: 8000,
        txRateBps: 12000,
        rxBytesTotal: 89204910,
        txBytesTotal: 120194820,
        dhcpLeaseRemainingSec: 52000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '48:3f:da:88:22:15',
        ip: '192.168.20.61',
        hostname: 'Shelly-Roller-LivingRoom',
        vendor: 'Allterco Robotics',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 1,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -72,
        noiseDbm: -95,
        snrDb: 23,
        rxRateMbps: 72,
        txRateMbps: 72,
        rxRateBps: 6000,
        txRateBps: 10000,
        rxBytesTotal: 79204910,
        txBytesTotal: 100194820,
        dhcpLeaseRemainingSec: 49000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '44:61:32:10:ef:90',
        ip: '192.168.20.70',
        hostname: 'Ecobee-Smart-Thermostat',
        vendor: 'Ecobee Inc.',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 6,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -66,
        noiseDbm: -95,
        snrDb: 29,
        rxRateMbps: 72,
        txRateMbps: 72,
        rxRateBps: 12000,
        txRateBps: 18000,
        rxBytesTotal: 189204910,
        txBytesTotal: 220194820,
        dhcpLeaseRemainingSec: 58000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: 'cc:50:e3:19:82:70',
        ip: '192.168.20.85',
        hostname: 'Garden-Weather-Station',
        vendor: 'Espressif Inc.',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-03', hostName: 'Outdoor AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 6,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -81,
        noiseDbm: -95,
        snrDb: 14,
        rxRateMbps: 54,
        txRateMbps: 54,
        rxRateBps: 4000,
        txRateBps: 8000,
        rxBytesTotal: 59204910,
        txBytesTotal: 80194820,
        dhcpLeaseRemainingSec: 36000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
      {
        mac: '00:09:b0:aa:bb:cc',
        ip: '192.168.20.90',
        hostname: 'Rachio-Sprinkler-Controller',
        vendor: 'Rachio, Inc.',
        connectionType: 'wifi_2g',
        connectedTo: { hostId: 'node-ap-03', hostName: 'Outdoor AP', iface: 'wlan0' },
        ssid: 'Homelab-IoT',
        channel: 6,
        band: '2.4GHz',
        channelWidthMhz: 20,
        signalDbm: -75,
        noiseDbm: -95,
        snrDb: 20,
        rxRateMbps: 72,
        txRateMbps: 72,
        rxRateBps: 5000,
        txRateBps: 11000,
        rxBytesTotal: 69204910,
        txBytesTotal: 90194820,
        dhcpLeaseRemainingSec: 42000,
        vlan: 20,
        isGuest: false,
        lastSeen: new Date().toISOString(),
      },
    ];

    // Initialize roaming history for simulated clients
    this.recordRoamingEvent(
      'a4:83:e7:2b:41:89',
      'node-ap-02',
      'node-ap-01',
      -78,
      -52,
      new Date(Date.now() - 3600 * 1000).toISOString()
    );
    this.recordRoamingEvent(
      'f0:99:bf:14:88:21',
      'node-ap-02',
      'node-ap-01',
      -76,
      -61,
      new Date(Date.now() - 7200 * 1000).toISOString()
    );

    // Initialize signal history
    for (const c of this.clients) {
      if (c.signalDbm !== null) {
        this.signalHistory.set(c.mac, [
          { timestamp: new Date(Date.now() - 300000).toISOString(), signalDbm: c.signalDbm - 3 },
          { timestamp: new Date(Date.now() - 150000).toISOString(), signalDbm: c.signalDbm + 2 },
          { timestamp: new Date().toISOString(), signalDbm: c.signalDbm },
        ]);
      }
    }
  }

  recordRoamingEvent(mac, fromHostId, toHostId, oldSignalDbm, newSignalDbm, timestamp = new Date().toISOString()) {
    if (!this.roamingHistory.has(mac)) {
      this.roamingHistory.set(mac, []);
    }
    const fromHost = this.hosts.find((h) => h.id === fromHostId);
    const toHost = this.hosts.find((h) => h.id === toHostId);
    this.roamingHistory.get(mac).unshift({
      timestamp,
      fromHostId,
      fromHostName: fromHost ? fromHost.name : fromHostId,
      toHostId,
      toHostName: toHost ? toHost.name : toHostId,
      oldSignalDbm,
      newSignalDbm,
    });
  }

  tick() {
    this.tickCount++;

    // Slight traffic fluctuation jitter
    const multiplier = this.trafficSpike ? 4.5 : 1.0;
    for (const c of this.clients) {
      const jitter = 0.85 + Math.random() * 0.3;
      c.rxRateBps = Math.round(c.rxRateBps * jitter * multiplier);
      c.txRateBps = Math.round(c.txRateBps * jitter * multiplier);
      c.rxBytesTotal += Math.round(c.rxRateBps * 2);
      c.txBytesTotal += Math.round(c.txRateBps * 2);

      // Slight signal fluctuation for wireless clients
      if (c.signalDbm !== null) {
        const dSignal = (Math.random() - 0.5) * 2;
        c.signalDbm = Math.min(-30, Math.max(-90, Math.round(c.signalDbm + dSignal)));
        c.snrDb = c.noiseDbm ? c.signalDbm - c.noiseDbm : 30;

        // Keep rolling signal history
        const history = this.signalHistory.get(c.mac) || [];
        history.push({ timestamp: new Date().toISOString(), signalDbm: c.signalDbm });
        if (history.length > 30) history.shift();
        this.signalHistory.set(c.mac, history);
      }
      c.lastSeen = new Date().toISOString();
    }

    // Occasional roaming simulation for James's MacBook Pro
    if (this.enableRoaming && this.tickCount % 12 === 0) {
      const mac = 'a4:83:e7:2b:41:89';
      const client = this.clients.find((c) => c.mac === mac);
      if (client) {
        if (client.connectedTo.hostId === 'node-ap-01') {
          this.recordRoamingEvent(mac, 'node-ap-01', 'node-ap-02', client.signalDbm, -55);
          client.connectedTo = { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1' };
          client.signalDbm = -55;
        } else {
          this.recordRoamingEvent(mac, 'node-ap-02', 'node-ap-01', client.signalDbm, -52);
          client.connectedTo = { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' };
          client.signalDbm = -52;
        }
      }
    }

    // Update host telemetry and status
    for (const h of this.hosts) {
      if (this.simulatedOfflineHost === h.id) {
        h.status = 'offline';
      } else {
        h.status = 'online';
        h.uptimeSec += 10;
        h.cpuUsagePct = Math.round((h.cpuUsagePct + (Math.random() - 0.5) * 3) * 10) / 10;
        h.cpuUsagePct = Math.max(3, Math.min(95, h.cpuUsagePct));
        h.lastSeen = new Date().toISOString();

        // Calculate client count
        h.clientCount = this.clients.filter((c) => c.connectedTo && c.connectedTo.hostId === h.id).length;
      }
    }
  }

  getHosts() {
    return this.hosts;
  }

  getHost(id) {
    return this.hosts.find((h) => h.id === id) || null;
  }

  getClients(filter = {}) {
    let list = [...this.clients];
    if (filter.q) {
      const q = filter.q.toLowerCase();
      list = list.filter(
        (c) =>
          c.hostname.toLowerCase().includes(q) ||
          c.ip.includes(q) ||
          c.mac.toLowerCase().includes(q) ||
          c.vendor.toLowerCase().includes(q)
      );
    }
    if (filter.hostId) {
      list = list.filter((c) => c.connectedTo && c.connectedTo.hostId === filter.hostId);
    }
    if (filter.type) {
      list = list.filter((c) => c.connectionType === filter.type);
    }
    if (filter.vlan) {
      const vlanNum = parseInt(filter.vlan, 10);
      list = list.filter((c) => c.vlan === vlanNum);
    }
    return list;
  }

  getClientByMac(mac) {
    const normalized = mac.toLowerCase();
    const client = this.clients.find((c) => c.mac.toLowerCase() === normalized);
    if (!client) return null;

    return {
      ...client,
      roamingLog: this.roamingHistory.get(normalized) || [],
      signalHistory: this.signalHistory.get(normalized) || [],
    };
  }

  getWifiBands() {
    return this.radios;
  }

  getTopology() {
    // Hierarchical nodes and links
    const nodes = [
      {
        id: 'wan-internet',
        label: 'WAN Uplink',
        type: 'wan',
        ip: '203.0.113.42',
        status: 'online',
        metrics: {
          rxRateBps: 28500000,
          txRateBps: 6200000,
          speedMbps: 1000,
        },
      },
      ...this.hosts.map((h) => ({
        id: h.id,
        label: h.name,
        type: h.role,
        ip: h.ip,
        mac: h.mac,
        model: h.model,
        status: h.status,
        metrics: {
          cpuUsagePct: h.cpuUsagePct,
          memUsagePct: h.memUsagePct,
          uptimeSec: h.uptimeSec,
          rxRateBps: Math.round(15000000 * (0.8 + Math.random() * 0.4)),
          txRateBps: Math.round(4000000 * (0.8 + Math.random() * 0.4)),
          clientCount: h.clientCount,
        },
      })),
      ...this.clients.map((c) => ({
        id: `client-${c.mac.replace(/:/g, '')}`,
        label: c.hostname,
        type:
          c.connectionType === 'wired'
            ? 'client_wired'
            : c.connectionType === 'wifi_2g'
              ? 'client_wifi_2g'
              : c.connectionType === 'wifi_5g'
                ? 'client_wifi_5g'
                : 'client_wifi_6g',
        ip: c.ip,
        mac: c.mac,
        status: 'online',
        vendor: c.vendor,
        hostId: c.connectedTo ? c.connectedTo.hostId : null,
        metrics: {
          rxRateBps: c.rxRateBps,
          txRateBps: c.txRateBps,
          signalDbm: c.signalDbm,
          snrDb: c.snrDb,
        },
      })),
    ];

    const links = [
      {
        id: 'link-wan-gw',
        source: 'wan-internet',
        target: 'node-gw-01',
        medium: 'ethernet',
        speedMbps: 1000,
        currentRxBps: 28500000,
        currentTxBps: 6200000,
        status: 'online',
      },
      {
        id: 'link-gw-ap01',
        source: 'node-gw-01',
        target: 'node-ap-01',
        medium: 'ethernet',
        speedMbps: 2500,
        currentRxBps: 14200000,
        currentTxBps: 3800000,
        status: 'online',
        vlans: [1, 10, 20],
      },
      {
        id: 'link-gw-ap02',
        source: 'node-gw-01',
        target: 'node-ap-02',
        medium: 'ethernet',
        speedMbps: 1000,
        currentRxBps: 8400000,
        currentTxBps: 2100000,
        status: 'online',
        vlans: [1, 10, 20],
      },
      {
        id: 'link-ap01-ap03',
        source: 'node-ap-01',
        target: 'node-ap-03',
        medium: 'wifi_mesh',
        speedMbps: 866,
        currentRxBps: 1800000,
        currentTxBps: 450000,
        signalDbm: -58,
        status: 'online',
        vlans: [1, 20],
      },
    ];

    // Client links
    for (const c of this.clients) {
      if (c.connectedTo) {
        links.push({
          id: `link-${c.connectedTo.hostId}-${c.mac.replace(/:/g, '')}`,
          source: c.connectedTo.hostId,
          target: `client-${c.mac.replace(/:/g, '')}`,
          medium: c.connectionType === 'wired' ? 'ethernet' : 'wifi_station',
          speedMbps: c.speedMbps || c.rxRateMbps || 100,
          currentRxBps: c.rxRateBps,
          currentTxBps: c.txRateBps,
          signalDbm: c.signalDbm,
          vlans: [c.vlan],
          status: 'online',
        });
      }
    }

    return { nodes, links };
  }

  generateMockArchive(hostId, versionOffset = 0) {
    const host = this.getHost(hostId) || this.hosts[0];
    const isGw = host.role === 'gateway';

    const networkConfig = isGw
      ? `
config interface 'loopback'
\toption device 'lo'
\toption proto 'static'
\toption ipaddr '127.0.0.1'
\toption netmask '255.0.0.0'

config device 'br_lan'
\toption name 'br-lan'
\toption type 'bridge'
\tlist ports 'eth1'

config interface 'lan'
\toption device 'br-lan'
\toption proto 'static'
\toption ipaddr '${versionOffset === 0 ? '192.168.1.1' : '192.168.1.254'}'
\toption netmask '255.255.255.0'
${versionOffset === 0 ? "\toption ip6assign '60'" : "\toption ip6assign '64'"}

config interface 'guest'
\toption device 'br-lan.10'
\toption proto 'static'
\toption ipaddr '192.168.10.1'
\toption netmask '255.255.255.0'

config interface 'iot'
\toption device 'br-lan.20'
\toption proto 'static'
\toption ipaddr '192.168.20.1'
\toption netmask '255.255.255.0'

config interface 'wan'
\toption device 'eth0'
\toption proto 'pppoe'
\toption username 'user@isp.net'
\toption password 'fiberpass'
\toption ipv6 'auto'
`.trim()
      : `
config interface 'loopback'
\toption device 'lo'
\toption proto 'static'
\toption ipaddr '127.0.0.1'
\toption netmask '255.0.0.0'

config device 'br_lan'
\toption name 'br-lan'
\toption type 'bridge'
\tlist ports 'eth0'

config interface 'lan'
\toption device 'br-lan'
\toption proto 'static'
\toption ipaddr '${host.ip}'
\toption netmask '255.255.255.0'
\toption gateway '192.168.1.1'
\tlist dns '192.168.1.1'
`.trim();

    const wirelessConfig = isGw
      ? `# Gateway has no active wireless radios\n`
      : `
config wifi-device 'radio0'
\toption type 'mac80211'
\toption path 'platform/soc/radio0'
\toption channel '${host.id === 'node-ap-02' ? 1 : 6}'
\toption band '2g'
\toption htmode 'HT20'
\toption cell_density '0'

config wifi-iface 'default_radio0'
\toption device 'radio0'
\toption network 'lan'
\toption mode 'ap'
\toption ssid 'Homelab-Main'
\toption encryption 'psk2+ccmp'
\toption key 'SuperSecretWiFiPassword'

config wifi-device 'radio1'
\toption type 'mac80211'
\toption path 'platform/soc/radio1'
\toption channel '${host.id === 'node-ap-03' ? 100 : 36}'
\toption band '5g'
\toption htmode '${versionOffset === 0 ? 'HE80' : 'HE160'}'
\toption cell_density '0'

config wifi-iface 'default_radio1'
\toption device 'radio1'
\toption network 'lan'
\toption mode 'ap'
\toption ssid 'Homelab-Main'
\toption encryption 'sae'
\toption key 'WPA3SecureNetworkKey'
`.trim();

    const firewallConfig = `
config defaults
\toption syn_flood '1'
\toption input 'ACCEPT'
\toption output 'ACCEPT'
\toption forward 'REJECT'

config zone
\toption name 'lan'
\tlist network 'lan'
\toption input 'ACCEPT'
\toption output 'ACCEPT'
\toption forward 'ACCEPT'

config zone
\toption name 'wan'
\tlist network 'wan'
\toption input 'REJECT'
\toption output 'ACCEPT'
\toption forward 'REJECT'
\toption masq '1'
\toption mtu_fix '1'

config forwarding
\toption src 'lan'
\toption dest 'wan'
${
  versionOffset === 0
    ? `
config redirect
\toption name 'TrueNAS-SSH'
\toption src 'wan'
\toption proto 'tcp'
\toption src_dport '2222'
\toption dest_ip '192.168.1.50'
\toption dest_port '22'
\toption target 'DNAT'
`
    : `
config redirect
\toption name 'TrueNAS-SSH'
\toption src 'wan'
\toption proto 'tcp'
\toption src_dport '2222'
\toption dest_ip '192.168.1.50'
\toption dest_port '22'
\toption target 'DNAT'

config redirect
\toption name 'WireGuard-VPN'
\toption src 'wan'
\toption proto 'udp'
\toption src_dport '51820'
\toption dest_ip '192.168.1.1'
\toption dest_port '51820'
\toption target 'DNAT'
`
}
`.trim();

    const dhcpConfig = `
config dnsmasq
\toption domainneeded '1'
\toption boguspriv '1'
\toption filterwin2k '0'
\toption localise_queries '1'
\toption rebind_protection '1'
\toption local '/lan/'
\toption domain 'lan'
\toption expandhosts '1'
\toption nonegcache '0'
\toption authoritative '1'
\toption readethers '1'
\toption leasefile '/tmp/dhcp.leases'

config dhcp 'lan'
\toption interface 'lan'
\toption start '100'
\toption limit '150'
\toption leasetime '12h'
\toption dhcpv4 'server'
\toption dhcpv6 'server'
\toption ra 'server'
`.trim();

    const systemConfig = `
config system
\toption hostname '${host.hostname}'
\toption timezone 'UTC'
\toption ttylogin '0'
\toption log_size '64'
\toption urandom_seed '0'

config timeserver 'ntp'
\toption enabled '1'
\tlist server '0.openwrt.pool.ntp.org'
\tlist server '1.openwrt.pool.ntp.org'
`.trim();

    const files = [
      { path: 'etc/config/network', content: networkConfig },
      { path: 'etc/config/wireless', content: wirelessConfig },
      { path: 'etc/config/firewall', content: firewallConfig },
      { path: 'etc/config/dhcp', content: dhcpConfig },
      { path: 'etc/config/system', content: systemConfig },
      { path: 'etc/config/dropbear', content: "config dropbear\n\toption Port '22'\n\toption PasswordAuth 'on'\n" },
      { path: 'etc/dropbear/authorized_keys', content: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdministratorKeyTrueNAS admin@truenas\n' },
      { path: 'etc/passwd', content: 'root:x:0:0:root:/root:/bin/ash\ndaemon:*:1:1:daemon:/var:/bin/false\n' },
      { path: 'etc/shadow', content: 'root:$1$mockedhash:19000:0:99999:7:::\n' },
    ];

    const archiveBuffer = createTarGz(files);
    const sha256 = computeSha256(archiveBuffer);

    return {
      archiveBuffer,
      sha256,
      sizeBytes: archiveBuffer.length,
      filesCount: files.length,
      filesList: files.map((f) => f.path),
    };
  }

  configure(params) {
    if (params.enableRoaming !== undefined) {
      this.enableRoaming = Boolean(params.enableRoaming);
    }
    if (params.trafficSpike !== undefined) {
      this.trafficSpike = Boolean(params.trafficSpike);
    }
    if (params.simulateOfflineHost !== undefined) {
      this.simulatedOfflineHost = params.simulateOfflineHost;
    }
    if (params.triggerRoamNow) {
      const mac = 'a4:83:e7:2b:41:89';
      const client = this.clients.find((c) => c.mac === mac);
      if (client) {
        if (client.connectedTo.hostId === 'node-ap-01') {
          this.recordRoamingEvent(mac, 'node-ap-01', 'node-ap-02', client.signalDbm, -55);
          client.connectedTo = { hostId: 'node-ap-02', hostName: 'Office AP', iface: 'wlan1' };
          client.signalDbm = -55;
        } else {
          this.recordRoamingEvent(mac, 'node-ap-02', 'node-ap-01', client.signalDbm, -52);
          client.connectedTo = { hostId: 'node-ap-01', hostName: 'Living Room AP', iface: 'wlan1' };
          client.signalDbm = -52;
        }
      }
    }
    return this.getStatus();
  }

  reset() {
    this.enableRoaming = true;
    this.trafficSpike = false;
    this.simulatedOfflineHost = null;
    this.tickCount = 0;
    this.roamingHistory.clear();
    this.signalHistory.clear();
    this.initDefaultData();
    return this.getStatus();
  }

  getStatus() {
    return {
      active: true,
      tickCount: this.tickCount,
      enableRoaming: this.enableRoaming,
      trafficSpike: this.trafficSpike,
      simulatedOfflineHost: this.simulatedOfflineHost,
      hostsCount: this.hosts.length,
      clientsCount: this.clients.length,
      bandsCount: Object.keys(this.radios).length,
    };
  }
}

export const simulator = new NetworkSimulator();
