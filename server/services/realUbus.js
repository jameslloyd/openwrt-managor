import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Common OUI vendor lookup table for MAC addresses
 */
const OUI_VENDORS = {
  '00:25:90': 'Supermicro',
  '00:e0:4c': 'Realtek',
  '94:83:c4': 'GL.iNet',
  'e0:d5:5e': 'GIGABYTE / Intel',
  'bc:24:11': 'Proxmox / QEMU',
  '00:17:88': 'Philips Lighting',
  'a4:83:e7': 'Apple, Inc.',
  'f0:99:bf': 'Apple, Inc.',
  '1c:59:9b': 'Apple, Inc.',
  '40:a3:cc': 'Apple, Inc.',
  'fc:f1:52': 'Sony',
  '94:9f:3e': 'Sonos, Inc.',
  'd8:43:ae': 'Valve',
  '48:3f:da': 'Shelly / Allterco',
  'dc:a6:32': 'Raspberry Pi',
  'b8:27:eb': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '28:cd:c1': 'Raspberry Pi',
  '70:4f:57': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  'b0:be:76': 'TP-Link',
  '18:e8:29': 'Ubiquiti',
  '74:83:c2': 'Ubiquiti',
  'f0:9f:c2': 'Ubiquiti',
};

function lookupVendor(mac) {
  if (!mac || typeof mac !== 'string') return 'Network Device';
  const prefix = mac.toLowerCase().slice(0, 8);
  return OUI_VENDORS[prefix] || 'Network Device';
}

let askpassScriptPath = null;
let hasSshpass = null;

function ensureAskpassScript() {
  if (askpassScriptPath && fs.existsSync(askpassScriptPath)) {
    return askpassScriptPath;
  }
  const scriptPath = path.join(os.tmpdir(), 'openwrt-managor-askpass.sh');
  const content = '#!/bin/sh\nprintf "%s\\n" "$OPENWRT_SSH_PASS"\n';
  fs.writeFileSync(scriptPath, content, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  askpassScriptPath = scriptPath;
  return scriptPath;
}

async function checkSshpass() {
  if (hasSshpass !== null) return hasSshpass;
  try {
    await execFileAsync('which', ['sshpass']);
    hasSshpass = true;
  } catch {
    hasSshpass = false;
  }
  return hasSshpass;
}

/**
 * Executes a command on a remote OpenWrt host via SSH.
 */
export async function execSshCommand(hostConfig, remoteCommand, { timeoutMs = 10000, binary = false } = {}) {
  const askpass = ensureAskpassScript();
  const useSshpass = Boolean(hostConfig.password) && (await checkSshpass());

  const port =
    hostConfig.protocol === 'ssh'
      ? hostConfig.port && hostConfig.port !== 80 && hostConfig.port !== 443
        ? hostConfig.port
        : hostConfig.sshPort || 22
      : hostConfig.sshPort || 22;

  const sshArgs = [
    '-p',
    String(port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=6',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=1',
    '-o',
    'NumberOfPasswordPrompts=1',
    '-o',
    'HostKeyAlgorithms=+ssh-rsa',
    '-o',
    'PubkeyAcceptedAlgorithms=+ssh-rsa',
    `${hostConfig.username || 'root'}@${hostConfig.ip}`,
    remoteCommand,
  ];

  const env = {
    ...process.env,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: ':0',
    OPENWRT_SSH_PASS: hostConfig.password || '',
    SSHPASS: hostConfig.password || '',
  };

  const cmd = useSshpass ? 'sshpass' : 'ssh';
  const args = useSshpass ? ['-e', 'ssh', ...sshArgs] : sshArgs;

  return execFileAsync(cmd, args, {
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: binary ? 'buffer' : 'utf8',
  });
}

/**
 * Real OpenWrt HTTP ubus Client
 */
export class OpenWrtUbusClient {
  constructor(hostConfig) {
    this.host = hostConfig;
    this.sessionToken = null;
    this.tokenExpires = 0;
  }

  getBaseUrl() {
    const isHttps = this.host.useHttps || this.host.protocol === 'ubus_https';
    const proto = isHttps ? 'https' : 'http';
    const port = this.host.port || (isHttps ? 443 : 80);
    return `${proto}://${this.host.ip}:${port}/ubus`;
  }

  async call(subsystem, method, params = {}) {
    const token = this.sessionToken || '00000000000000000000000000000000';
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'call',
      params: [token, subsystem, method, params],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(this.getBaseUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || 'ubus RPC call error');
      }
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async login() {
    const res = await this.call('session', 'login', {
      username: this.host.username || 'root',
      password: this.host.password || '',
    });
    if (res && res[1] && res[1].ubus_rpc_session) {
      this.sessionToken = res[1].ubus_rpc_session;
      this.tokenExpires = Date.now() + (res[1].expires || 300) * 1000;
      return true;
    }
    return false;
  }

  async getSystemInfo() {
    return this.call('system', 'info');
  }

  async getBoardInfo() {
    return this.call('system', 'board');
  }
}

export function validateHostParameters(hostConfig) {
  if (!hostConfig || typeof hostConfig !== 'object') {
    return 'Invalid host configuration';
  }
  const ip = hostConfig.ip;
  if (!ip || typeof ip !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(ip)) {
    return 'Invalid IP address or hostname format';
  }
  if (hostConfig.port !== undefined && hostConfig.port !== null && hostConfig.port !== '') {
    const port = Number(hostConfig.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'Port must be an integer between 1 and 65535';
    }
  }
  if (hostConfig.username && (typeof hostConfig.username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(hostConfig.username))) {
    return 'Invalid username format';
  }
  return null;
}

function parseCpuLine(line) {
  if (!line || !line.startsWith('cpu ')) return null;
  const parts = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (parts.length < 4) return null;
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((acc, v) => acc + v, 0);
  return { idle, total };
}

function parseMeminfo(text, sysinfo = null) {
  const vals = {};
  if (text) {
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
      if (m) {
        vals[m[1]] = Number(m[2]);
      }
    }
  }
  if (vals.MemTotal > 0) {
    const avail =
      vals.MemAvailable !== undefined
        ? vals.MemAvailable
        : (vals.MemFree || 0) + (vals.Buffers || 0) + (vals.Cached || 0);
    const used = Math.max(0, vals.MemTotal - avail);
    return Math.round((used / vals.MemTotal) * 1000) / 10;
  }
  if (sysinfo?.memory?.total > 0) {
    const m = sysinfo.memory;
    const avail = m.available !== undefined ? m.available : (m.free || 0) + (m.buffered || 0) + (m.cached || 0);
    const used = Math.max(0, m.total - avail);
    return Math.round((used / m.total) * 1000) / 10;
  }
  return null;
}

function channelToCenterFreq(band, channel) {
  const ch = Number(channel);
  if (!ch) return 0;
  if (band === '2.4GHz') return ch === 14 ? 2484 : 2412 + 5 * (ch - 1);
  if (band === '5GHz') return 5000 + 5 * ch;
  if (band === '6GHz') return 5950 + 5 * ch;
  return 0;
}

function htmodeToWidth(htmode) {
  if (!htmode || typeof htmode !== 'string') return 20;
  if (htmode.includes('320')) return 320;
  if (htmode.includes('160')) return 160;
  if (htmode.includes('80')) return 80;
  if (htmode.includes('40')) return 40;
  return 20;
}

function freqToBand(freqMhz) {
  const f = Number(freqMhz);
  if (f >= 2400 && f <= 2500) return '2.4GHz';
  if (f >= 5000 && f <= 5900) return '5GHz';
  if (f >= 5925 && f <= 7125) return '6GHz';
  return null;
}

/**
 * Collects full telemetry from a real OpenWrt host via SSH (or HTTP ubus fallback).
 */
export async function pollRealHost(hostConfig, prevSample = null) {
  const remoteScript = [
    'echo "===BOARD==="',
    'ubus call system board 2>/dev/null',
    'echo "===RELEASE==="',
    'cat /etc/openwrt_release 2>/dev/null',
    'echo "===MODEL==="',
    'cat /tmp/sysinfo/model 2>/dev/null',
    'echo "===SYSINFO==="',
    'ubus call system info 2>/dev/null',
    'echo "===UPTIME==="',
    'cat /proc/uptime 2>/dev/null',
    'echo "===MEMINFO==="',
    'cat /proc/meminfo 2>/dev/null',
    'echo "===CPUSTAT1==="',
    "grep '^cpu ' /proc/stat 2>/dev/null",
    'sleep 1',
    'echo "===CPUSTAT2==="',
    "grep '^cpu ' /proc/stat 2>/dev/null",
    'echo "===MAC==="',
    'cat /sys/class/net/br-lan/address /sys/class/net/eth0/address 2>/dev/null | head -n 1',
    'echo "===NETDEV==="',
    'cat /proc/net/dev 2>/dev/null',
    'echo "===WAN==="',
    'ubus call network.interface.wan status 2>/dev/null',
    'echo "===WIRELESS==="',
    'ubus call network.wireless status 2>/dev/null',
    'echo "===IWDEV==="',
    'iw dev 2>/dev/null',
    'echo "===STATIONS==="',
    'for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do echo "---IFACE:$iface---"; iw dev "$iface" station dump 2>/dev/null; done',
    'echo "===DHCP==="',
    'cat /tmp/dhcp.leases 2>/dev/null',
    'echo "===ARP==="',
    'cat /proc/net/arp 2>/dev/null',
  ].join('; ');

  try {
    const { stdout } = await execSshCommand(hostConfig, remoteScript, { timeoutMs: 12000 });
    return parseSshTelemetryOutput(hostConfig, stdout, prevSample);
  } catch (sshErr) {
    // If protocol is ubus_http or ubus_https, try HTTP ubus RPC
    if (hostConfig.protocol === 'ubus_http' || hostConfig.protocol === 'ubus_https') {
      try {
        const client = new OpenWrtUbusClient(hostConfig);
        await client.login();
        const [boardRes, infoRes] = await Promise.all([
          client.getBoardInfo().catch(() => null),
          client.getSystemInfo().catch(() => null),
        ]);
        const board = boardRes && boardRes[1] ? boardRes[1] : null;
        const sysinfo = infoRes && infoRes[1] ? infoRes[1] : null;
        if (board || sysinfo) {
          const uptimeSec = sysinfo?.uptime ? Math.floor(sysinfo.uptime) : hostConfig.uptimeSec || 0;
          const memUsagePct = parseMeminfo('', sysinfo) ?? hostConfig.memUsagePct ?? 0;
          const load1 = sysinfo?.load?.[0] ? Math.min(100, Math.round((sysinfo.load[0] / 655.36) * 10) / 10) : 0;
          return {
            online: true,
            hostname: board?.hostname || hostConfig.hostname,
            model: board?.model || board?.system || hostConfig.model,
            firmware: board?.release?.description || hostConfig.firmware,
            uptimeSec,
            cpuUsagePct: load1,
            memUsagePct,
            mac: hostConfig.mac || null,
            rxRateBps: 0,
            txRateBps: 0,
            wan: hostConfig.wan || null,
            radios: [],
            clients: [],
            sample: { timestamp: Date.now() },
          };
        }
      } catch {
        // Fall through to offline return
      }
    }
    return {
      online: false,
      error: sshErr.message || 'SSH connection failed',
    };
  }
}

export function parseSshTelemetryOutput(hostConfig, stdout, prevSample = null) {
  const sections = {};
  let currentKey = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^===([A-Z0-9_]+)===\r?$/);
    if (m) {
      currentKey = m[1];
      sections[currentKey] = [];
    } else if (currentKey) {
      sections[currentKey].push(line);
    }
  }

  const getSectionText = (k) => (sections[k] || []).join('\n').trim();
  const getSectionJson = (k) => {
    const txt = getSectionText(k);
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  };

  const board = getSectionJson('BOARD');
  const sysinfo = getSectionJson('SYSINFO');
  const releaseTxt = getSectionText('RELEASE');
  const modelTxt = getSectionText('MODEL');
  const uptimeTxt = getSectionText('UPTIME');
  const meminfoTxt = getSectionText('MEMINFO');
  const cpu1Txt = getSectionText('CPUSTAT1');
  const cpu2Txt = getSectionText('CPUSTAT2');
  const macTxt = getSectionText('MAC');
  const netdevTxt = getSectionText('NETDEV');
  const wanJson = getSectionJson('WAN');
  const wirelessJson = getSectionJson('WIRELESS');
  const iwdevTxt = getSectionText('IWDEV');
  const stationsTxt = getSectionText('STATIONS');
  const dhcpTxt = getSectionText('DHCP');
  const arpTxt = getSectionText('ARP');

  // 1. Identity, Model & Firmware
  let hostname = board?.hostname || hostConfig.hostname || hostConfig.name;
  let model = board?.model || modelTxt || board?.board_name || board?.system || hostConfig.model || 'OpenWrt Device';
  let firmware = board?.release?.description || null;
  if (!firmware && releaseTxt) {
    const descMatch = releaseTxt.match(/DISTRIB_DESCRIPTION=['"]?([^'"\n]+)['"]?/);
    if (descMatch) firmware = descMatch[1];
  }
  if (!firmware && board?.release) {
    firmware = [board.release.distribution, board.release.version, board.release.revision].filter(Boolean).join(' ');
  }
  firmware = firmware || hostConfig.firmware || 'OpenWrt';

  // 2. Uptime (seconds)
  let uptimeSec = 0;
  if (uptimeTxt) {
    const parsedUptime = parseFloat(uptimeTxt.split(/\s+/)[0]);
    if (Number.isFinite(parsedUptime) && parsedUptime >= 0) {
      uptimeSec = Math.floor(parsedUptime);
    }
  }
  if (!uptimeSec && sysinfo?.uptime) {
    uptimeSec = Math.floor(Number(sysinfo.uptime) || 0);
  }

  // 3. Memory Usage (%)
  const memUsagePct = parseMeminfo(meminfoTxt, sysinfo) ?? 0;

  // 4. CPU Usage (%) from /proc/stat delta
  const stat1 = parseCpuLine(cpu1Txt);
  const stat2 = parseCpuLine(cpu2Txt);
  let cpuUsagePct = 0;
  if (stat1 && stat2 && stat2.total > stat1.total) {
    const dTotal = stat2.total - stat1.total;
    const dIdle = stat2.idle - stat1.idle;
    cpuUsagePct = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10));
  } else if (stat2 && prevSample?.cpuStat && stat2.total > prevSample.cpuStat.total) {
    const dTotal = stat2.total - prevSample.cpuStat.total;
    const dIdle = stat2.idle - prevSample.cpuStat.idle;
    cpuUsagePct = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10));
  } else if (sysinfo?.load?.[0]) {
    cpuUsagePct = Math.min(100, Math.round((sysinfo.load[0] / 655.36) * 10) / 10);
  }

  // 5. Primary MAC
  const mac = macTxt && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(macTxt.trim()) ? macTxt.trim().toLowerCase() : (hostConfig.mac || null);

  // 6. Network Interface Counters & Live Throughput
  const nowMs = Date.now();
  const netCounters = {};
  for (const line of netdevTxt.split('\n')) {
    const m = line.trim().match(/^([a-zA-Z0-9._-]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (m) {
      netCounters[m[1]] = { rxBytes: Number(m[2]), txBytes: Number(m[3]) };
    }
  }

  const wanDev = wanJson?.l3_device || wanJson?.device || null;
  const primaryDev =
    (wanDev && netCounters[wanDev] ? wanDev : null) ||
    (netCounters['br-lan'] ? 'br-lan' : null) ||
    (netCounters['eth0'] ? 'eth0' : null) ||
    Object.keys(netCounters).find((k) => k !== 'lo');

  let rxRateBps = 0;
  let txRateBps = 0;
  if (primaryDev && prevSample?.netCounters?.[primaryDev] && prevSample?.timestamp) {
    const dtSec = Math.max(1, (nowMs - prevSample.timestamp) / 1000);
    const prev = prevSample.netCounters[primaryDev];
    const curr = netCounters[primaryDev];
    if (curr.rxBytes >= prev.rxBytes) {
      rxRateBps = Math.round(((curr.rxBytes - prev.rxBytes) * 8) / dtSec);
    }
    if (curr.txBytes >= prev.txBytes) {
      txRateBps = Math.round(((curr.txBytes - prev.txBytes) * 8) / dtSec);
    }
  }

  let wanInfo = null;
  if (wanJson && Array.isArray(wanJson['ipv4-address']) && wanJson['ipv4-address'][0]?.address) {
    wanInfo = {
      ip: wanJson['ipv4-address'][0].address,
      gateway: wanJson.route?.[0]?.nexthop || '',
      dns: Array.isArray(wanJson['dns-server']) ? wanJson['dns-server'] : [],
      speedMbps: 1000,
    };
  }

  // 7. Parse `iw dev` interfaces + `ubus call network.wireless status` for active radios
  const iwInterfaces = new Map(); // ifname -> { ifname, ssid, channel, freqMhz, widthMhz, centerFreqMhz, txPowerDbm, band }
  let currentIface = null;
  for (const rawLine of iwdevTxt.split('\n')) {
    const line = rawLine.trim();
    const ifaceMatch = line.match(/^Interface\s+(\S+)/);
    if (ifaceMatch) {
      currentIface = {
        ifname: ifaceMatch[1],
        ssid: null,
        channel: null,
        freqMhz: null,
        widthMhz: 20,
        centerFreqMhz: null,
        txPowerDbm: 20,
        band: null,
      };
      iwInterfaces.set(currentIface.ifname, currentIface);
      continue;
    }
    if (!currentIface) continue;

    const ssidMatch = line.match(/^ssid\s+(.+)$/);
    if (ssidMatch) {
      currentIface.ssid = ssidMatch[1].trim();
      continue;
    }
    const chanMatch = line.match(/^channel\s+(\d+)\s+\((\d+)\s*MHz\)(?:,\s*width:\s*(\d+)\s*MHz)?(?:,\s*center1:\s*(\d+)\s*MHz)?/);
    if (chanMatch) {
      currentIface.channel = Number(chanMatch[1]);
      currentIface.freqMhz = Number(chanMatch[2]);
      if (chanMatch[3]) currentIface.widthMhz = Number(chanMatch[3]);
      currentIface.centerFreqMhz = chanMatch[4] ? Number(chanMatch[4]) : Number(chanMatch[2]);
      currentIface.band = freqToBand(currentIface.freqMhz);
      continue;
    }
    const txMatch = line.match(/^txpower\s+([\d.]+)\s*dBm/);
    if (txMatch) {
      currentIface.txPowerDbm = Math.round( parseFloat(txMatch[1]) );
    }
  }

  // Also enrich from ubus network.wireless status
  if (wirelessJson && typeof wirelessJson === 'object') {
    for (const [radioName, radioData] of Object.entries(wirelessJson)) {
      if (!radioData || typeof radioData !== 'object') continue;
      const rCfg = radioData.config || {};
      const bandCode = rCfg.band; // '2g', '5g', '6g'
      const bandName = bandCode === '2g' ? '2.4GHz' : bandCode === '5g' ? '5GHz' : bandCode === '6g' ? '6GHz' : null;
      const ch = Number(rCfg.channel) || null;
      const widthMhz = htmodeToWidth(rCfg.htmode);
      const txPowerDbm = Number(rCfg.txpower) || 20;

      const ifaces = Array.isArray(radioData.interfaces) ? radioData.interfaces : [];
      for (const ifaceObj of ifaces) {
        const ifname = ifaceObj.ifname || `${radioName}`;
        const iCfg = ifaceObj.config || {};
        const existing = iwInterfaces.get(ifname) || {
          ifname,
          ssid: iCfg.ssid || null,
          channel: ch,
          freqMhz: null,
          widthMhz,
          centerFreqMhz: null,
          txPowerDbm,
          band: bandName,
        };
        if (!existing.ssid && iCfg.ssid) existing.ssid = iCfg.ssid;
        if (!existing.band && bandName) existing.band = bandName;
        if (!existing.channel && ch) existing.channel = ch;
        if (!existing.centerFreqMhz && existing.band && existing.channel) {
          existing.centerFreqMhz = channelToCenterFreq(existing.band, existing.channel);
        }
        iwInterfaces.set(ifname, existing);
      }
    }
  }

  // 8. Parse DHCP leases & ARP table
  const dhcpByMac = new Map();
  const nowEpoch = Math.floor(nowMs / 1000);
  for (const line of dhcpTxt.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4) {
      const expiry = Number(parts[0]);
      const lMac = parts[1].toLowerCase();
      const lIp = parts[2];
      const lHost = parts[3] && parts[3] !== '*' ? parts[3] : lIp;
      dhcpByMac.set(lMac, {
        ip: lIp,
        hostname: lHost,
        dhcpLeaseRemainingSec: expiry > nowEpoch ? expiry - nowEpoch : 36000,
      });
    }
  }

  const arpByMac = new Map();
  for (const line of arpTxt.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6 && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(parts[3])) {
      const aMac = parts[3].toLowerCase();
      if (aMac !== '00:00:00:00:00:00') {
        arpByMac.set(aMac, {
          ip: parts[0],
          flags: parts[2],
          device: parts[5],
        });
      }
    }
  }

  // 9. Parse associated WiFi stations per interface
  const clients = [];
  const stationCountByIface = new Map();
  let stationIface = null;
  let currentStation = null;

  const flushStation = () => {
    if (!currentStation || !currentStation.mac) return;
    const sMac = currentStation.mac.toLowerCase();
    const ifaceInfo = iwInterfaces.get(currentStation.iface) || {};
    const dhcp = dhcpByMac.get(sMac);
    const arp = arpByMac.get(sMac);
    const band = ifaceInfo.band || '5GHz';
    const connType = band === '2.4GHz' ? 'wifi_2g' : band === '6GHz' ? 'wifi_6g' : 'wifi_5g';
    const signalDbm = currentStation.signalDbm ?? -60;
    const noiseDbm = -95;

    let cRxBps = 0;
    let cTxBps = 0;
    if (prevSample?.clientBytes?.[sMac] && prevSample?.timestamp) {
      const dtSec = Math.max(1, (nowMs - prevSample.timestamp) / 1000);
      const prevC = prevSample.clientBytes[sMac];
      if (currentStation.rxBytesTotal >= prevC.rxBytes) {
        cRxBps = Math.round(((currentStation.rxBytesTotal - prevC.rxBytes) * 8) / dtSec);
      }
      if (currentStation.txBytesTotal >= prevC.txBytes) {
        cTxBps = Math.round(((currentStation.txBytesTotal - prevC.txBytes) * 8) / dtSec);
      }
    }

    stationCountByIface.set(currentStation.iface, (stationCountByIface.get(currentStation.iface) || 0) + 1);

    clients.push({
      mac: sMac,
      ip: dhcp?.ip || arp?.ip || '0.0.0.0',
      hostname: dhcp?.hostname || arp?.ip || sMac,
      vendor: lookupVendor(sMac),
      connectionType: connType,
      connectedTo: {
        hostId: hostConfig.id,
        hostName: hostConfig.name || hostname,
        iface: currentStation.iface,
      },
      ssid: ifaceInfo.ssid || 'OpenWrt',
      channel: ifaceInfo.channel || 36,
      band,
      channelWidthMhz: ifaceInfo.widthMhz || 80,
      signalDbm,
      noiseDbm,
      snrDb: signalDbm - noiseDbm,
      rxRateMbps: currentStation.rxRateMbps || 100,
      txRateMbps: currentStation.txRateMbps || 100,
      rxRateBps: cRxBps,
      txRateBps: cTxBps,
      rxBytesTotal: currentStation.rxBytesTotal || 0,
      txBytesTotal: currentStation.txBytesTotal || 0,
      dhcpLeaseRemainingSec: dhcp?.dhcpLeaseRemainingSec || 36000,
      vlan: 1,
      isGuest: Boolean(ifaceInfo.ssid && /guest/i.test(ifaceInfo.ssid)),
      lastSeen: new Date().toISOString(),
    });
    currentStation = null;
  };

  for (const rawLine of stationsTxt.split('\n')) {
    const line = rawLine.trim();
    const hdr = line.match(/^---IFACE:(.+)---$/);
    if (hdr) {
      flushStation();
      stationIface = hdr[1].trim();
      continue;
    }
    const stMatch = line.match(/^Station\s+(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})/);
    if (stMatch && stationIface) {
      flushStation();
      currentStation = {
        mac: stMatch[1].toLowerCase(),
        iface: stationIface,
        rxBytesTotal: 0,
        txBytesTotal: 0,
        signalDbm: -60,
        rxRateMbps: 0,
        txRateMbps: 0,
      };
      continue;
    }
    if (!currentStation) continue;

    const rxB = line.match(/^rx bytes:\s*(\d+)/);
    if (rxB) {
      currentStation.rxBytesTotal = Number(rxB[1]);
      continue;
    }
    const txB = line.match(/^tx bytes:\s*(\d+)/);
    if (txB) {
      currentStation.txBytesTotal = Number(txB[1]);
      continue;
    }
    const sig = line.match(/^signal:\s*(-?\d+)/);
    if (sig) {
      currentStation.signalDbm = Number(sig[1]);
      continue;
    }
    const txRate = line.match(/^tx bitrate:\s*([\d.]+)/);
    if (txRate) {
      currentStation.txRateMbps = Math.round(parseFloat(txRate[1]));
      continue;
    }
    const rxRate = line.match(/^rx bitrate:\s*([\d.]+)/);
    if (rxRate) {
      currentStation.rxRateMbps = Math.round(parseFloat(rxRate[1]));
    }
  }
  flushStation();

  // If this host has DHCP leases (e.g. gateway) and wired clients in ARP/DHCP not seen in WiFi stations
  const wifiMacs = new Set(clients.map((c) => c.mac));
  if (dhcpByMac.size > 0) {
    for (const [dMac, dhcp] of dhcpByMac.entries()) {
      if (wifiMacs.has(dMac)) continue;
      if (mac && dMac === mac) continue;
      const arp = arpByMac.get(dMac);
      if (arp && arp.flags === '0x0') continue; // incomplete ARP entry
      clients.push({
        mac: dMac,
        ip: dhcp.ip,
        hostname: dhcp.hostname,
        vendor: lookupVendor(dMac),
        connectionType: 'wired',
        connectedTo: {
          hostId: hostConfig.id,
          hostName: hostConfig.name || hostname,
          iface: arp?.device || 'br-lan',
        },
        vlan: 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: 1000,
        rxRateMbps: 1000,
        txRateMbps: 1000,
        rxRateBps: 0,
        txRateBps: 0,
        rxBytesTotal: 0,
        txBytesTotal: 0,
        dhcpLeaseRemainingSec: dhcp.dhcpLeaseRemainingSec,
        lastSeen: new Date().toISOString(),
      });
    }
  }

  // 10. Build active radios list for this host
  const radios = [];
  for (const ifaceInfo of iwInterfaces.values()) {
    if (!ifaceInfo.band || !ifaceInfo.channel) continue;
    const cCount = stationCountByIface.get(ifaceInfo.ifname) || 0;
    radios.push({
      id: `radio-${hostConfig.id}-${ifaceInfo.ifname}`,
      hostId: hostConfig.id,
      hostName: hostConfig.name || hostname,
      device: ifaceInfo.ifname,
      ssid: ifaceInfo.ssid || 'OpenWrt',
      band: ifaceInfo.band,
      channel: ifaceInfo.channel,
      centerFreqMhz: ifaceInfo.centerFreqMhz || channelToCenterFreq(ifaceInfo.band, ifaceInfo.channel),
      widthMhz: ifaceInfo.widthMhz || 20,
      txPowerDbm: ifaceInfo.txPowerDbm || 20,
      signalDbm: -45,
      clientCount: cCount,
      utilizationPct: Math.min(95, Math.max(5, cCount * 6)),
    });
  }

  const clientBytes = {};
  for (const c of clients) {
    clientBytes[c.mac] = { rxBytes: c.rxBytesTotal || 0, txBytes: c.txBytesTotal || 0 };
  }

  return {
    online: true,
    hostname,
    model,
    firmware,
    uptimeSec,
    cpuUsagePct,
    memUsagePct,
    mac,
    rxRateBps,
    txRateBps,
    wan: wanInfo,
    radios,
    clients,
    sample: {
      timestamp: nowMs,
      cpuStat: stat2 || stat1,
      netCounters,
      clientBytes,
    },
  };
}

/**
 * Tests connection to an OpenWrt host (supports SSH, ubus HTTP/HTTPS, and unit test simulator).
 */
export async function testHostConnection(hostConfig, simulator) {
  const startTime = Date.now();

  const validationError = validateHostParameters(hostConfig);
  if (validationError) {
    return {
      success: false,
      latencyMs: 0,
      ubusConnected: false,
      sshConnected: false,
      error: validationError,
      message: validationError,
    };
  }

  const isSimulated =
    hostConfig.isSimulated === true ||
    (hostConfig.isSimulated !== false &&
      config.demoMode &&
      simulator &&
      simulator.getHosts().some((h) => h.ip === hostConfig.ip));

  if (isSimulated) {
    const matched = simulator ? simulator.getHosts().find((h) => h.ip === hostConfig.ip) : null;
    return {
      success: true,
      latencyMs: Math.floor(2 + Math.random() * 8),
      ubusConnected: true,
      sshConnected: true,
      detectedModel: matched ? matched.model : hostConfig.model || 'OpenWrt Virtual Node',
      detectedFirmware: matched ? matched.firmware : 'OpenWrt 23.05.4',
    };
  }

  // If protocol is SSH (or fallback to SSH), test via SSH
  if (hostConfig.protocol === 'ssh') {
    const telemetry = await pollRealHost(hostConfig);
    const latencyMs = Date.now() - startTime;
    if (telemetry.online) {
      return {
        success: true,
        latencyMs,
        ubusConnected: true,
        sshConnected: true,
        detectedModel: telemetry.model || 'OpenWrt Device',
        detectedFirmware: telemetry.firmware || 'OpenWrt',
        telemetry,
      };
    }
    return {
      success: false,
      latencyMs,
      ubusConnected: false,
      sshConnected: false,
      error: telemetry.error || 'SSH connection failed',
      message: telemetry.error || 'SSH connection failed',
    };
  }

  // Attempt HTTP/HTTPS ubus call, with SSH fallback
  const client = new OpenWrtUbusClient(hostConfig);
  try {
    const loginOk = await client.login();
    const board = await client.getBoardInfo().catch(() => null);
    const latencyMs = Date.now() - startTime;

    return {
      success: true,
      latencyMs,
      ubusConnected: loginOk,
      sshConnected: true,
      detectedModel: board && board[1] && board[1].model ? board[1].model : 'Generic OpenWrt Device',
      detectedFirmware: board && board[1] && board[1].release ? board[1].release.description : 'OpenWrt',
    };
  } catch (err) {
    // Try SSH fallback in case router only has Dropbear SSH enabled
    const sshTelemetry = await pollRealHost({ ...hostConfig, protocol: 'ssh' });
    const latencyMs = Date.now() - startTime;
    if (sshTelemetry.online) {
      return {
        success: true,
        latencyMs,
        ubusConnected: true,
        sshConnected: true,
        detectedModel: sshTelemetry.model || 'OpenWrt Device',
        detectedFirmware: sshTelemetry.firmware || 'OpenWrt',
        telemetry: sshTelemetry,
      };
    }

    const errorMsg = err.message || 'Connection failed';
    return {
      success: false,
      latencyMs,
      ubusConnected: false,
      sshConnected: false,
      error: errorMsg,
      message: errorMsg,
    };
  }
}
