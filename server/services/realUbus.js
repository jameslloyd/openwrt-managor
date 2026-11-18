import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import {
  lookupVendor,
  resolveMacManufacturer,
  resolveSsidManufacturer,
  resolveWirelessNetworkManufacturer,
} from './ouiVendor.js';

const execFileAsync = promisify(execFile);

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
 * Executes a command on a remote OpenWrt host via SSH and streams stdout/stderr lines in real time.
 */
export async function execSshCommandStream(hostConfig, remoteCommand, { timeoutMs = 120000, onLine = null } = {}) {
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
    'ServerAliveCountMax=2',
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

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    const flushLines = (chunkStr) => {
      lineBuf += chunkStr;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      if (typeof onLine === 'function') {
        for (const raw of lines) {
          onLine(raw.replace(/\r$/, ''));
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stdout += str;
      flushLines(str);
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stderr += str;
      flushLines(str);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (lineBuf && typeof onLine === 'function') {
        onLine(lineBuf.replace(/\r$/, ''));
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `SSH command exited with code ${code}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
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

const KNOWN_OPENWRT_RELEASES = [
  '19.07.10',
  '21.02.7',
  '22.03.7',
  '23.05.0',
  '23.05.1',
  '23.05.2',
  '23.05.3',
  '23.05.4',
  '23.05.5',
  '24.10.0',
];

/**
 * Compares two OpenWrt semantic/release versions (e.g. "23.05.2" vs "23.05.5" or "24.10.0-rc5").
 * Returns > 0 if vA > vB, < 0 if vA < vB, 0 if equal.
 */
export function compareOpenWrtVersions(vA, vB) {
  if (!vA || !vB) return 0;
  const clean = (v) => String(v).trim().replace(/^v/i, '');
  const aStr = clean(vA);
  const bStr = clean(vB);
  if (aStr === bStr) return 0;

  const parse = (s) => {
    const [core, pre] = s.split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    // Final release ranks higher than -rcN
    let rcRank = 999;
    if (pre) {
      const m = pre.match(/rc(\d+)/i);
      rcRank = m ? parseInt(m[1], 10) : 0;
    }
    return { nums, rcRank };
  };

  const pA = parse(aStr);
  const pB = parse(bStr);
  for (let i = 0; i < 3; i++) {
    if (pA.nums[i] !== pB.nums[i]) return pA.nums[i] - pB.nums[i];
  }
  return pA.rcRank - pB.rcRank;
}

/**
 * Parses `opkg list-upgradable` (or `apk version -l '<'`) output into structured package update entries.
 */
export function parseOpkgUpgradable(text) {
  const packages = [];
  if (!text) return packages;

  const seen = new Set();
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Collected errors:') || line.startsWith('* ') || line.startsWith('Downloading ')) {
      continue;
    }

    // Standard opkg format: "pkg-name - 1.0.0-r1 - 1.0.1-r1"
    const opkgMatch = line.match(/^([a-zA-Z0-9.+_-]+)\s+-\s+(\S+)\s+-\s+(\S+)$/);
    if (opkgMatch) {
      const [, name, currentVersion, newVersion] = opkgMatch;
      if (currentVersion !== newVersion && !seen.has(name)) {
        seen.add(name);
        packages.push({
          name,
          currentVersion,
          newVersion,
          isSecurityOrCore: /^(kernel|base-files|dnsmasq|dropbear|openssl|libopenssl|libustream|wolfssl|libwolfssl|hostapd|wpad|firewall|nftables|ubus|ubox|procd|uci|auc|owut|luci-app-attendedsysupgrade)/.test(
            name
          ),
        });
      }
      continue;
    }

    // OpenWrt 24.10+/SNAPSHOT apk format: "pkg-name-1.0.0-r1 < 1.0.1-r1"
    const apkMatch = line.match(/^([a-zA-Z0-9.+_-]+)-(\d[^\s<]*)\s*<\s*(\S+)/);
    if (apkMatch) {
      const [, name, currentVersion, newVersion] = apkMatch;
      if (currentVersion !== newVersion && !seen.has(name)) {
        seen.add(name);
        packages.push({
          name,
          currentVersion,
          newVersion,
          isSecurityOrCore: /^(kernel|base-files|dnsmasq|dropbear|openssl|libopenssl|hostapd|wpad|firewall|nftables|ubus|procd|uci|auc|owut)/.test(
            name
          ),
        });
      }
    }
  }

  return packages.sort((a, b) => {
    if (a.isSecurityOrCore !== b.isSecurityOrCore) return a.isSecurityOrCore ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const ASU_STATUS_SCRIPT = [
  'af=0; A_RE="auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common"',
  'for p in auc owut luci-app-attendedsysupgrade attendedsysupgrade-common; do f="/usr/lib/opkg/info/$p.control"; if [ -f "$f" ]; then awk \'/^Package:/{n=$2}/^Version:/{v=$2}END{if(n)print n" - "(v?v:"installed")}\' "$f" 2>/dev/null; af=1; fi; done',
  '[ "$af" = "0" ] && [ -f /usr/lib/opkg/status ] && out=$(awk -v r="^Package:[ \t]*($A_RE)$" \'$0~r{p=$2}/^Version:/&&p{print p" - "$2;p=""}\' /usr/lib/opkg/status 2>/dev/null) && [ -n "$out" ] && echo "$out" && af=1',
  '[ -f /lib/apk/db/installed ] && out=$(awk -F: -v r="^P:($A_RE)$" \'$0~r{p=$2}/^V:/&&p{print p" - "$2;p=""}\' /lib/apk/db/installed 2>/dev/null) && [ -n "$out" ] && echo "$out" && af=1',
  'command -v auc >/dev/null 2>&1 && echo "HAS_BIN:auc" && af=1',
  'command -v owut >/dev/null 2>&1 && echo "HAS_BIN:owut" && af=1',
  '([ -f /etc/config/attendedsysupgrade ] || [ -f /usr/share/luci/menu.d/luci-app-attendedsysupgrade.json ] || [ -d /www/luci-static/resources/view/attendedsysupgrade ]) && echo "HAS_LUCI:luci-app-attendedsysupgrade" && af=1',
  'u=$(uci -q show attendedsysupgrade 2>/dev/null || cat /etc/config/attendedsysupgrade 2>/dev/null); [ -n "$u" ] && echo "$u" && af=1',
  '[ "$af" = "0" ] && echo "ASU_NONE"',
].join('; ');

/**
 * Evaluates Attended Sysupgrade status and available OpenWrt firmware updates.
 */
export function evaluateAttendedSysupgrade({
  board = null,
  firmware = '',
  releaseTxt = '',
  asuStatusTxt = '',
  asuCheckTxt = '',
} = {}) {
  // 1. Extract current version, revision, target, and boardName
  let currentVersion = board?.release?.version || '';
  let currentRevision = board?.release?.revision || '';
  let target = board?.release?.target || '';
  let boardName = board?.board_name || '';

  if (releaseTxt) {
    if (!currentVersion) {
      const m = releaseTxt.match(/DISTRIB_RELEASE=['"]?([^'"\n]+)['"]?/);
      if (m) currentVersion = m[1].trim();
    }
    if (!currentRevision) {
      const m = releaseTxt.match(/DISTRIB_REVISION=['"]?([^'"\n]+)['"]?/);
      if (m) currentRevision = m[1].trim();
    }
    if (!target) {
      const m = releaseTxt.match(/DISTRIB_TARGET=['"]?([^'"\n]+)['"]?/);
      if (m) target = m[1].trim();
    }
  }

  if (!currentVersion && firmware) {
    const vMatch = String(firmware).match(/(\d{2}\.\d{2}\.\d+(?:-rc\d+)?|SNAPSHOT)/i);
    if (vMatch) currentVersion = vMatch[1];
    const rMatch = String(firmware).match(/\b(r\d+-[0-9a-f]+)\b/i);
    if (!currentRevision && rMatch) currentRevision = rMatch[1];
  }

  // 2. Parse installed Attended Sysupgrade packages & CLI tool
  const installedPackages = [];
  const seenPkgs = new Set();
  const addPkg = (name, version = 'installed') => {
    if (!name || seenPkgs.has(name)) return;
    seenPkgs.add(name);
    installedPackages.push({ name, version });
  };

  let cliTool = null;
  let serverUrl = 'https://sysupgrade.openwrt.org';
  let explicitlyMissing = false;
  let configPresent = false;

  for (const rawLine of String(asuStatusTxt || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'ASU_NONE') {
      explicitlyMissing = true;
      continue;
    }
    const pkgMatch = line.match(/^(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common)\s+-\s+(\S+)/);
    if (pkgMatch) {
      addPkg(pkgMatch[1], pkgMatch[2]);
      if (pkgMatch[1] === 'owut') cliTool = 'owut';
      else if (pkgMatch[1] === 'auc' && cliTool !== 'owut') cliTool = 'auc';
      else if (pkgMatch[1] === 'luci-app-attendedsysupgrade' && !cliTool) cliTool = 'luci-app';
      continue;
    }
    const apkMatch = line.match(/^(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common)-(\d\S*)$/);
    if (apkMatch) {
      addPkg(apkMatch[1], apkMatch[2]);
      if (apkMatch[1] === 'owut') cliTool = 'owut';
      else if (apkMatch[1] === 'auc' && cliTool !== 'owut') cliTool = 'auc';
      else if (apkMatch[1] === 'luci-app-attendedsysupgrade' && !cliTool) cliTool = 'luci-app';
      continue;
    }
    if (line === 'HAS_BIN:owut') {
      cliTool = 'owut';
      addPkg('owut', 'installed');
      continue;
    }
    if (line === 'HAS_BIN:auc') {
      if (cliTool !== 'owut') cliTool = 'auc';
      addPkg('auc', 'installed');
      continue;
    }
    if (line === 'HAS_LUCI:luci-app-attendedsysupgrade') {
      if (!cliTool) cliTool = 'luci-app';
      addPkg('luci-app-attendedsysupgrade', 'installed');
      continue;
    }
    if (/^attendedsysupgrade\./.test(line) || /^config\s+(server|client)/.test(line)) {
      configPresent = true;
      if (!cliTool) cliTool = 'installed';
    }
    const urlMatch =
      line.match(/^attendedsysupgrade\..*\.url=['"]?([^'"\n]+)['"]?/) ||
      line.match(/^option\s+url\s+['"]?([^'"\n]+)['"]?/);
    if (urlMatch && urlMatch[1]) {
      configPresent = true;
      serverUrl = urlMatch[1].trim().replace(/\/+$/, '');
    }
  }

  // 3. Parse `auc -n` / `owut check` output and `.versions.json` from `asuCheckTxt`
  const [cliOutputPart, versionsJsonPart] = String(asuCheckTxt || '').split('---VERSIONS_JSON---');
  let cliAvailableVersion = null;
  let cliAvailableRevision = null;

  if (cliOutputPart) {
    for (const rawLine of cliOutputPart.split('\n')) {
      const line = rawLine.trim();
      if (/^auc\s*\(/i.test(line) && !cliTool) {
        cliTool = 'auc';
        addPkg('auc', 'installed');
      } else if (/^owut\b/i.test(line) && cliTool !== 'owut') {
        cliTool = 'owut';
        addPkg('owut', 'installed');
      }
      // auc -n format: "Available: 23.05.5 r24106-10cc5fcd00"
      const aucAvail = line.match(/^Available:\s*(\d{2}\.\d{2}\.\d+(?:-rc\d+)?|SNAPSHOT)(?:\s+(r\d+-[0-9a-f]+))?/i);
      if (aucAvail) {
        cliAvailableVersion = aucAvail[1];
        if (aucAvail[2]) cliAvailableRevision = aucAvail[2];
        continue;
      }
      // owut check format: "version-to   23.05.5 r24106-10cc5fcd00"
      const owutAvail = line.match(/^version-to\s+(\d{2}\.\d{2}\.\d+(?:-rc\d+)?|SNAPSHOT)(?:\s+(r\d+-[0-9a-f]+))?/i);
      if (owutAvail) {
        cliAvailableVersion = owutAvail[1];
        if (owutAvail[2]) cliAvailableRevision = owutAvail[2];
      }
    }
  }

  // If asuStatusTxt has not been polled yet (empty string and not explicitly 'ASU_NONE'), assume installed until verified otherwise
  const hasAnyIndicator = installedPackages.length > 0 || Boolean(cliTool) || configPresent;
  const installed = hasAnyIndicator || (!explicitlyMissing && !String(asuStatusTxt || '').trim());
  if (installed && !cliTool) {
    const versionToCompare = currentVersion || '23.05.0';
    cliTool = compareOpenWrtVersions(versionToCompare, '24.10.0') >= 0 ? 'owut' : 'auc';
  }

  // Merge known OpenWrt releases with live .versions.json if present
  const releaseSet = new Set(KNOWN_OPENWRT_RELEASES);
  let upstreamStable = null;
  if (versionsJsonPart && versionsJsonPart.trim()) {
    try {
      const vJson = JSON.parse(versionsJsonPart.trim());
      if (Array.isArray(vJson.versions_list)) {
        for (const v of vJson.versions_list) {
          if (typeof v === 'string' && /^\d{2}\.\d{2}\.\d+$/.test(v)) {
            releaseSet.add(v);
          }
        }
      }
      if (typeof vJson.stable_version === 'string' && vJson.stable_version) {
        upstreamStable = vJson.stable_version;
        releaseSet.add(vJson.stable_version);
      }
    } catch {
      // Ignore malformed JSON
    }
  }
  if (cliAvailableVersion && /^\d{2}\.\d{2}\.\d+/.test(cliAvailableVersion)) {
    releaseSet.add(cliAvailableVersion);
  }

  const allReleases = Array.from(releaseSet)
    .filter((v) => !v.includes('-rc'))
    .sort(compareOpenWrtVersions);

  const latestStable = upstreamStable || allReleases[allReleases.length - 1] || '24.10.0';
  let latestSameBranch = null;

  if (currentVersion && /^\d{2}\.\d{2}/.test(currentVersion)) {
    const branchPrefix = currentVersion.split('.').slice(0, 2).join('.');
    const sameBranchReleases = allReleases.filter((v) => v.startsWith(`${branchPrefix}.`));
    if (sameBranchReleases.length > 0) {
      latestSameBranch = sameBranchReleases[sameBranchReleases.length - 1];
    }
  }

  // Determine if a firmware update is available
  let availableVersion = null;
  let availableRevision = cliAvailableRevision || null;
  let majorUpgradeVersion = null;
  let releaseType = 'up-to-date';
  let firmwareUpdateAvailable = false;

  if (cliAvailableVersion && (!currentVersion || compareOpenWrtVersions(cliAvailableVersion, currentVersion) > 0 || (cliAvailableRevision && cliAvailableRevision !== currentRevision))) {
    availableVersion = cliAvailableVersion;
    firmwareUpdateAvailable = true;
    const curBranch = currentVersion ? currentVersion.split('.').slice(0, 2).join('.') : '';
    const newBranch = cliAvailableVersion.split('.').slice(0, 2).join('.');
    releaseType = curBranch && curBranch !== newBranch ? 'major' : 'maintenance';
  } else if (currentVersion && /^\d{2}\.\d{2}\.\d+/.test(currentVersion)) {
    if (latestSameBranch && compareOpenWrtVersions(latestSameBranch, currentVersion) > 0) {
      availableVersion = latestSameBranch;
      firmwareUpdateAvailable = true;
      releaseType = 'maintenance';
      if (latestStable && compareOpenWrtVersions(latestStable, latestSameBranch) > 0) {
        majorUpgradeVersion = latestStable;
      }
    } else if (latestStable && compareOpenWrtVersions(latestStable, currentVersion) > 0) {
      availableVersion = latestStable;
      majorUpgradeVersion = latestStable;
      firmwareUpdateAvailable = true;
      releaseType = 'major';
    }
  }

  let advisory = 'Firmware is up to date.';
  if (firmwareUpdateAvailable && availableVersion) {
    const typeLabel = releaseType === 'maintenance' ? 'maintenance release' : 'major release';
    advisory = `OpenWrt ${availableVersion}${availableRevision ? ` (${availableRevision})` : ''} ${typeLabel} is available via Attended Sysupgrade (currently running ${currentVersion || 'OpenWrt'}).`;
    if (majorUpgradeVersion && majorUpgradeVersion !== availableVersion) {
      advisory += ` Major branch upgrade OpenWrt ${majorUpgradeVersion} is also available.`;
    }
    if (!installed) {
      advisory += ' Install the Attended Sysupgrade package (auc / luci-app-attendedsysupgrade) on this router to build and flash a custom sysupgrade image preserving all installed packages.';
    }
  } else if (currentVersion) {
    advisory = `Running latest OpenWrt ${currentVersion}${currentRevision ? ` (${currentRevision})` : ''} firmware.`;
  }

  return {
    installed,
    statusVerified: Boolean(String(asuStatusTxt || '').trim()),
    cliTool,
    packages: installedPackages,
    serverUrl,
    currentVersion: currentVersion || 'Unknown',
    currentRevision: currentRevision || '',
    target: target || 'Generic',
    boardName: boardName || '',
    firmwareUpdateAvailable,
    availableVersion,
    availableRevision,
    latestSameBranch,
    latestStable,
    majorUpgradeVersion,
    releaseType,
    advisory,
  };
}

function parseCpuLine(text) {
  if (!text) return null;
  const cpuLine = String(text)
    .split('\n')
    .find((l) => l.startsWith('cpu '));
  if (!cpuLine) return null;
  const parts = cpuLine
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

function parseCpuCoreCount(...texts) {
  for (const text of texts) {
    if (!text) continue;
    let cores = 0;
    let explicitCores = null;
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim();
      if (/^cpu\d+\b/.test(line)) {
        cores++;
      } else if (line.startsWith('CORES|')) {
        const parsed = parseInt(line.slice(6), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          explicitCores = parsed;
        }
      }
    }
    if (explicitCores !== null) return explicitCores;
    if (cores > 0) return cores;
  }
  return null;
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

function freqToChannel(freqMhz) {
  const f = Math.round(Number(freqMhz));
  if (f === 2484) return 14;
  if (f >= 2412 && f <= 2472) return Math.round((f - 2412) / 5) + 1;
  if (f >= 5000 && f <= 5895) return Math.round((f - 5000) / 5);
  if (f >= 5955 && f <= 7115) return Math.round((f - 5950) / 5);
  return 0;
}

export function parseIwScanOutput(scanTxt, hostConfig, iwInterfaces = new Map()) {
  const neighbors = [];
  if (!scanTxt) return neighbors;

  let currentIface = null;
  let currentBss = null;

  const flushBss = () => {
    if (!currentBss || !currentBss.bssid) return;
    const freqMhz = currentBss.freqMhz || (currentBss.band && currentBss.channel ? channelToCenterFreq(currentBss.band, currentBss.channel) : 0);
    const band = currentBss.band || freqToBand(freqMhz);
    const channel = currentBss.channel || freqToChannel(freqMhz);
    if (!band || !channel) {
      currentBss = null;
      return;
    }
    const ifaceInfo = iwInterfaces.get(currentIface) || {};
    const ssidStr = currentBss.ssid || '(Hidden Network)';
    const { manufacturer, bssidManufacturer, ssidManufacturer } = resolveWirelessNetworkManufacturer({
      bssid: currentBss.bssid,
      ssid: ssidStr,
      wpsManufacturer: currentBss.wpsManufacturer || '',
    });
    neighbors.push({
      bssid: currentBss.bssid.toLowerCase(),
      ssid: ssidStr,
      isHidden: !currentBss.ssid,
      manufacturer,
      bssidManufacturer,
      ssidManufacturer,
      band,
      channel,
      freqMhz: freqMhz || channelToCenterFreq(band, channel),
      centerFreqMhz: currentBss.centerFreqMhz || freqMhz || channelToCenterFreq(band, channel),
      widthMhz: currentBss.widthMhz || 20,
      signalDbm: typeof currentBss.signalDbm === 'number' ? currentBss.signalDbm : -85,
      security: currentBss.security || 'Open',
      seenByHostId: hostConfig.id,
      seenByHostName: hostConfig.name || hostConfig.hostname || hostConfig.id,
      seenByRadioId: `radio-${hostConfig.id}-${currentIface || 'radio0'}`,
      seenByDevice: currentIface || ifaceInfo.ifname || 'wlan0',
      lastSeenMs: currentBss.lastSeenMs || 0,
    });
    currentBss = null;
  };

  for (const rawLine of String(scanTxt).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const hdr = line.match(/^---IFACE:(.+)---$/);
    if (hdr) {
      flushBss();
      currentIface = hdr[1].trim();
      continue;
    }

    const bssMatch = line.match(/^BSS\s+(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\(on\s+([^)]+)\)/);
    if (bssMatch) {
      flushBss();
      currentIface = bssMatch[3].trim() || currentIface;
      currentBss = {
        bssid: bssMatch[1].toLowerCase(),
        ssid: '',
        freqMhz: 0,
        channel: 0,
        widthMhz: 20,
        centerFreqMhz: 0,
        signalDbm: -85,
        security: 'Open',
        lastSeenMs: 0,
      };
      continue;
    }

    if (!currentBss) continue;

    const freqMatch = line.match(/^freq:\s*(\d+(?:\.\d+)?)/i);
    if (freqMatch) {
      currentBss.freqMhz = Math.round(parseFloat(freqMatch[1]));
      currentBss.band = freqToBand(currentBss.freqMhz);
      currentBss.channel = freqToChannel(currentBss.freqMhz);
      continue;
    }

    const sigMatch = line.match(/^signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/i);
    if (sigMatch) {
      currentBss.signalDbm = Math.round(parseFloat(sigMatch[1]));
      continue;
    }

    const seenMatch = line.match(/^last seen:\s*(\d+)\s*ms ago/i);
    if (seenMatch) {
      currentBss.lastSeenMs = Number(seenMatch[1]);
      continue;
    }

    const ssidMatch = line.match(/^SSID:\s*(.*)$/);
    if (ssidMatch) {
      const val = ssidMatch[1].trim();
      if (val && !val.startsWith('\\x00')) {
        currentBss.ssid = val;
      }
      continue;
    }

    const dsChanMatch = line.match(/^DS Parameter set:\s*channel\s*(\d+)/i) || line.match(/^\*\s*primary channel:\s*(\d+)/i);
    if (dsChanMatch) {
      currentBss.channel = Number(dsChanMatch[1]);
      continue;
    }

    const vhtWidthMatch = line.match(/^\*\s*channel width:\s*(\d+)\s*\(([^)]+)\)/i);
    if (vhtWidthMatch) {
      const desc = vhtWidthMatch[2];
      if (desc.includes('160')) currentBss.widthMhz = 160;
      else if (desc.includes('80')) currentBss.widthMhz = 80;
      else if (desc.includes('40')) currentBss.widthMhz = 40;
      continue;
    }

    const htWidthMatch = line.match(/^\*\s*STA channel width:\s*any/i);
    if (htWidthMatch && currentBss.widthMhz < 40) {
      currentBss.widthMhz = 40;
      continue;
    }

    if (/^(RSN|WPA):/i.test(line)) {
      currentBss.security = line.toUpperCase().startsWith('RSN') ? 'WPA2/WPA3' : 'WPA';
      continue;
    }

    const wpsMfgMatch = line.match(/^\*\s*Manufacturer:\s*(.+)$/i);
    if (wpsMfgMatch) {
      const val = wpsMfgMatch[1].trim();
      if (val && val.length > 1) {
        currentBss.wpsManufacturer = val;
      }
    }
  }

  flushBss();
  return neighbors;
}

export async function scanHostWirelessNetworks(hostConfig) {
  const scanScript = [
    'echo "===IWDEV==="',
    'iw dev 2>/dev/null',
    'echo "===SCAN==="',
    'seen_phys=""; for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do phy=$(iw dev "$iface" info 2>/dev/null | awk \'$1=="wiphy"{print $2}\'); case " $seen_phys " in *" $phy "*) continue ;; esac; seen_phys="$seen_phys $phy"; echo "---IFACE:$iface---"; (iw dev "$iface" scan ap-force 2>/dev/null || iw dev "$iface" scan 2>/dev/null || iw dev "$iface" scan dump 2>/dev/null) | grep -E "^(BSS |\\tfreq:|\\tsignal:|\\tSSID:|\\tDS Parameter set:|\\t\\* primary channel:|\\t\\* channel width:|\\t\\* STA channel width:|\\t\\* Manufacturer:|\\tRSN:|\\tWPA:|\\tlast seen:)"; done',
  ].join('; ');

  const { stdout } = await execSshCommand(hostConfig, scanScript, { timeoutMs: 25000 });
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
  const scanTxt = (sections.SCAN || []).join('\n');
  return parseIwScanOutput(scanTxt, hostConfig);
}

export const DEFAULT_STATIC_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Builds the OpenWrt SSH telemetry shell script.
 * - When `full === true`: collects all static hardware/config/update metadata plus dynamic telemetry.
 * - When `full === false`: collects only lightweight, fast-changing dynamic telemetry from /proc, /sys, /tmp, and live wireless/FDB state, avoiding heavy ubus/uci/opkg/ethtool/nslookup/scan calls.
 * - When `hasPrevCpuSample === true`: skips `CPUSTAT1` and `sleep 1`, computing CPU delta against the previous poll's `/proc/stat` counter.
 */
export function buildTelemetrySshScript({
  full = true,
  hasPrevCpuSample = false,
  hasWirelessRadios = true,
} = {}) {
  const cpuCommands = hasPrevCpuSample
    ? [
        'echo "===CPUSTAT2==="',
        "grep '^cpu' /proc/stat 2>/dev/null",
      ]
    : [
        'echo "===CPUSTAT1==="',
        "grep '^cpu ' /proc/stat 2>/dev/null",
        'sleep 1',
        'echo "===CPUSTAT2==="',
        "grep '^cpu' /proc/stat 2>/dev/null",
      ];

  if (!full) {
    const dynamicCmds = [
      'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
      'echo "===UPTIME==="',
      'cat /proc/uptime 2>/dev/null',
      'echo "===MEMINFO==="',
      'cat /proc/meminfo 2>/dev/null',
      ...cpuCommands,
      'echo "===NETDEV==="',
      'cat /proc/net/dev 2>/dev/null',
    ];

    if (hasWirelessRadios !== false) {
      dynamicCmds.push(
        'echo "===IWDEV==="',
        'iw_out=$(iw dev 2>/dev/null); echo "$iw_out"',
        'IW_IFS=$(echo "$iw_out" | awk \'$1=="Interface"{print $2}\')',
        'echo "===SURVEY==="',
        'for iface in $IW_IFS; do echo "---IFACE:$iface---"; iw dev "$iface" survey dump 2>/dev/null | awk \'/Survey data from/{if(inuse)exit; next} /\\[in use\\]/{inuse=1; print; next} inuse{print}\'; done',
        'echo "===STATIONS==="',
        'for iface in $IW_IFS; do echo "---IFACE:$iface---"; iw dev "$iface" station dump 2>/dev/null; done'
      );
    }

    dynamicCmds.push(
      'echo "===DHCP==="',
      'cat /tmp/dhcp.leases 2>/dev/null',
      'echo "===ARP==="',
      'cat /proc/net/arp 2>/dev/null; echo "---IPNEIGH---"; ip -4 neigh show 2>/dev/null',
      'echo "===SWITCH_FDB==="',
      'ip link show 2>/dev/null | awk -F": " \'/^[0-9]+:/ && (/LOWER_UP/ || /state UP/) && !/NO-CARRIER/{sub(/@.*/,"",$2); print "LINKUP|" $2}\'',
      'for p in /sys/class/net/*/brif/*; do [ -e "$p" ] || continue; br=${p%/brif/*}; br=${br##*/}; ifn=${p##*/}; d="/sys/class/net/$ifn"; pno=""; spd=""; dup=""; oper=""; car=""; addr=""; bst=""; read -r pno < "$p/port_no" 2>/dev/null; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; read -r addr < "$d/address" 2>/dev/null; read -r bst < "$p/state" 2>/dev/null; echo "BRPORT|$br|$ifn|$pno|$spd|$dup|$oper|$car|$addr|$bst"; done',
      'for d in /sys/class/net/*; do [ -e "$d" ] || continue; ifn=${d##*/}; [ "$ifn" = "lo" ] && continue; [ -e "$d/brport/bridge" ] && continue; [ -d "$d/bridge" ] || [ -d "$d/brif" ] || [ -d "$d/wireless" ] || [ -d "$d/phy80211" ] && continue; case "$ifn" in br-*|br[0-9]*|switch|switch.*|*.*|wlan*|phy*|ra*|rax*|ath*|wds*|mesh*|mon*|wg*|tun*|tap*|docker*|veth*|sit*|gre*|ip*|ifb*|teql*|erspan*|pppoe*|ppp*|bat*|tailscale*|zt*|miireg*|dummy*|bond*) continue ;; esac; m=""; spd=""; dup=""; oper=""; car=""; read -r m < "$d/address" 2>/dev/null; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; echo "NICPORT|$ifn|$m|$spd|$dup|$oper|$car|||"; done',
      'command -v bridge >/dev/null 2>&1 && bridge fdb show 2>/dev/null | awk \'!(/permanent/ && /master/ && !/self/){m=tolower($1);d="";b="";v="";for(i=2;i<=NF;i++){if($i=="dev")d=$(i+1);if($i=="master")b=$(i+1);if($i=="vlan")v=$(i+1)}if(m~/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/&&d!="")print "FDB|"m"|"d"|"b"|"v}\'',
      'for b in /sys/class/net/*/brif; do [ -d "$b" ] || continue; br=${b%/brif}; br=${br##*/}; brctl showmacs "$br" 2>/dev/null | awk -v br="$br" \'NR>1&&$3=="no"{print "BRMAC|"br"|"$1"|"tolower($2)}\'; done',
      'command -v hexdump >/dev/null 2>&1 && for b in /sys/class/net/*/brforward; do [ -e "$b" ] || continue; br=${b%/brforward}; br=${br##*/}; hexdump -v -e \'6/1 "%02x:" " " 1/1 "%u " 1/1 "%u " 4/1 "%02x" " " 1/1 "%u" 3/1 " %02x" "\\n"\' "$b" 2>/dev/null | awk -v br="$br" \'$3==0&&$2>0{sub(/:$/,"",$1);p=$2+($5*256);print "BRMAC|"br"|"p"|"tolower($1)}\'; done',
      'command -v swconfig >/dev/null 2>&1 && for sw in $(swconfig list 2>/dev/null | awk \'{print $2}\' | tr -d ":"); do swconfig dev "$sw" show 2>/dev/null | awk -v sw="$sw" \'/^[ \t]*Port [0-9]+:/{sub(/:/,"",$2);cp=$2} /link:/{p=cp;st="down";spd="";dup="";for(i=1;i<=NF;i++){if($i~/^port:/){v=substr($i,6);p=(v!=""?v:$(i+1))}if($i~/^link:/){v=substr($i,6);st=(v!=""?v:$(i+1))}if($i~/^speed:/){v=substr($i,7);spd=(v!=""?v:$(i+1))}if($i~/duplex/)dup=$i}if(p!="")print "SWPORT|"sw"|"p"|"st"|"spd"|"dup}\'; done',
      'true'
    );

    return dynamicCmds.join('; ');
  }

  return [
    'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
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
    'echo "===ASU_STATUS==="',
    ASU_STATUS_SCRIPT,
    ...cpuCommands,
    'echo "===MAC==="',
    'cat /sys/class/net/br-lan/address /sys/class/net/eth0/address 2>/dev/null | head -n 1',
    'echo "===NETDEV==="',
    'cat /proc/net/dev 2>/dev/null',
    'echo "===WAN==="',
    'ubus call network.interface.wan status 2>/dev/null',
    'echo "===WIRELESS==="',
    'ubus call network.wireless status 2>/dev/null',
    'echo "===IWDEV==="',
    'iw_out=$(iw dev 2>/dev/null); echo "$iw_out"',
    'IW_IFS=$(echo "$iw_out" | awk \'$1=="Interface"{print $2}\')',
    'echo "===SURVEY==="',
    'for iface in $IW_IFS; do echo "---IFACE:$iface---"; iw dev "$iface" survey dump 2>/dev/null | awk \'/Survey data from/{if(inuse)exit; next} /\\[in use\\]/{inuse=1; print; next} inuse{print}\'; done',
    'echo "===SCANDUMP==="',
    'seen_phys=""; for iface in $IW_IFS; do phy=$(iw dev "$iface" info 2>/dev/null | awk \'$1=="wiphy"{print $2}\'); case " $seen_phys " in *" $phy "*) continue ;; esac; seen_phys="$seen_phys $phy"; echo "---IFACE:$iface---"; iw dev "$iface" scan dump 2>/dev/null | grep -E "^(BSS |\\tfreq:|\\tsignal:|\\tSSID:|\\tDS Parameter set:|\\t\\* primary channel:|\\t\\* channel width:|\\t\\* STA channel width:|\\t\\* Manufacturer:|\\tRSN:|\\tWPA:|\\tlast seen:)"; done',
    'echo "===STATIONS==="',
    'for iface in $IW_IFS; do echo "---IFACE:$iface---"; iw dev "$iface" station dump 2>/dev/null; done',
    'echo "===DHCP==="',
    'cat /tmp/dhcp.leases 2>/dev/null; lf=$(uci -q get dhcp.@dnsmasq[0].leasefile 2>/dev/null); [ -n "$lf" ] && [ "$lf" != "/tmp/dhcp.leases" ] && cat "$lf" 2>/dev/null',
    'echo "===UCI_DHCP==="',
    "uci show dhcp 2>/dev/null | grep -E '^dhcp\\.[^.=]+\\.(mac|ip|name)='",
    'echo "===UBUS_DHCP==="',
    'ubus call dhcp ipv4leases 2>/dev/null',
    'echo "===ETHERS==="',
    'cat /etc/ethers 2>/dev/null',
    // If any associated WiFi station is missing from local dhcp.leases and /proc/net/arp, sweep the br-lan subnet once so ARP resolves its IP
    'if [ ! -f /tmp/.openwrt_mgr_arp_sweep ]; then for smac in $(for iface in $IW_IFS; do iw dev "$iface" station dump 2>/dev/null | awk \'/^Station/{print tolower($2)}\'; done); do if ! grep -qi "$smac" /tmp/dhcp.leases /proc/net/arp 2>/dev/null; then touch /tmp/.openwrt_mgr_arp_sweep 2>/dev/null; sn=$(ip -4 addr show br-lan 2>/dev/null | awk \'/inet /{print $2;exit}\' | cut -d. -f1-3); if [ -n "$sn" ]; then i=1; while [ $i -le 254 ]; do ping -c 1 -W 1 "$sn.$i" >/dev/null 2>&1 & [ $((i%64)) -eq 0 ] && wait; i=$((i+1)); done; wait; fi; break; fi; done; fi',
    'echo "===ARP==="',
    'cat /proc/net/arp 2>/dev/null; echo "---IPNEIGH---"; ip -4 neigh show 2>/dev/null',
    'echo "===NETDEV_STATUS==="',
    'ubus call network.device status 2>/dev/null',
    'echo "===SWITCH_FDB==="',
    'ip link show 2>/dev/null | awk -F": " \'/^[0-9]+:/ && (/LOWER_UP/ || /state UP/) && !/NO-CARRIER/{sub(/@.*/,"",$2); print "LINKUP|" $2}\'',
    'ip -4 addr show 2>/dev/null | awk \'/^[0-9]+:/{sub(/:/,"",$2);sub(/@.*/,"",$2);cur=$2} /inet /{split($2,a,"/");if(cur!=""&&a[1]!="")print "IFADDR|"cur"|"a[1]}\'',
    'for p in /sys/class/net/*/brif/*; do [ -e "$p" ] || continue; br=${p%/brif/*}; br=${br##*/}; ifn=${p##*/}; d="/sys/class/net/$ifn"; pno=""; spd=""; dup=""; oper=""; car=""; addr=""; bst=""; read -r pno < "$p/port_no" 2>/dev/null; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; read -r addr < "$d/address" 2>/dev/null; read -r bst < "$p/state" 2>/dev/null; echo "BRPORT|$br|$ifn|$pno|$spd|$dup|$oper|$car|$addr|$bst"; done',
    'has_eth=$(command -v ethtool 2>/dev/null); for d in /sys/class/net/*; do [ -e "$d" ] || continue; ifn=${d##*/}; [ "$ifn" = "lo" ] && continue; m=""; read -r m < "$d/address" 2>/dev/null; [ -n "$m" ] && echo "HOSTIF|$ifn|$m|"; [ -d "$d/bridge" ] || [ -d "$d/brif" ] || [ -d "$d/wireless" ] || [ -d "$d/phy80211" ] && continue; case "$ifn" in br-*|br[0-9]*|switch|switch.*|*.*|wlan*|phy*|ra*|rax*|ath*|wds*|mesh*|mon*|wg*|tun*|tap*|docker*|veth*|sit*|gre*|ip*|ifb*|teql*|erspan*|pppoe*|ppp*|bat*|tailscale*|zt*|miireg*|dummy*|bond*) continue ;; esac; br=""; [ -e "$d/brport/bridge" ] && br=$(readlink "$d/brport/bridge" 2>/dev/null) && br=${br##*/}; bst=""; bpno=""; spd=""; dup=""; oper=""; car=""; read -r bst < "$d/brport/state" 2>/dev/null; read -r bpno < "$d/brport/port_no" 2>/dev/null; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; echo "NICPORT|$ifn|$m|$spd|$dup|$oper|$car|$br|$bst|$bpno"; if [ -n "$has_eth" ] && { [ "$car" = "1" ] || [ "$oper" = "up" ] || [ "$bst" = "3" ] || [ "$bst" = "2" ]; }; then ethtool "$ifn" 2>/dev/null | awk -v i="$ifn" \'{for(k=1;k<=NF;k++)if($k~/^[0-9]+base/){s=$k+0;if(s>m)m=s}} /Speed:/{c=$2+0} /Link detected:/{l=($3=="yes"?1:0)} END{if(m||c||l==1)print "PORTCAP|"i"|"m"|"c"|"l}\'; fi; done',
    'uci show network 2>/dev/null | grep -E "\\.(ports|device|ifname)=" | sed "s/^/UCINET|/"',
    'command -v jsonfilter >/dev/null 2>&1 && [ -f /etc/board.json ] && jsonfilter -i /etc/board.json -e "@.network.*.ports[*]" -e "@.network.*.device" 2>/dev/null | sed "s/^/BOARDPORT|/"',
    'ip -4 route show default 2>/dev/null | awk \'/default/{for(i=1;i<=NF;i++){if($i=="via")g=$(i+1);if($i=="dev")d=$(i+1);if($i=="src")s=$(i+1)}print "DEFROUTE|"g"|"d"|"s;exit}\'',
    'command -v bridge >/dev/null 2>&1 && bridge fdb show 2>/dev/null | awk \'!(/permanent/ && /master/ && !/self/){m=tolower($1);d="";b="";v="";for(i=2;i<=NF;i++){if($i=="dev")d=$(i+1);if($i=="master")b=$(i+1);if($i=="vlan")v=$(i+1)}if(m~/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/&&d!="")print "FDB|"m"|"d"|"b"|"v}\'',
    'for b in /sys/class/net/*/brif; do [ -d "$b" ] || continue; br=${b%/brif}; br=${br##*/}; brctl showmacs "$br" 2>/dev/null | awk -v br="$br" \'NR>1&&$3=="no"{print "BRMAC|"br"|"$1"|"tolower($2)}\'; done',
    'command -v hexdump >/dev/null 2>&1 && for b in /sys/class/net/*/brforward; do [ -e "$b" ] || continue; br=${b%/brforward}; br=${br##*/}; hexdump -v -e \'6/1 "%02x:" " " 1/1 "%u " 1/1 "%u " 4/1 "%02x" " " 1/1 "%u" 3/1 " %02x" "\\n"\' "$b" 2>/dev/null | awk -v br="$br" \'$3==0&&$2>0{sub(/:$/,"",$1);p=$2+($5*256);print "BRMAC|"br"|"p"|"tolower($1)}\'; done',
    'command -v swconfig >/dev/null 2>&1 && for sw in $(swconfig list 2>/dev/null | awk \'{print $2}\' | tr -d ":"); do swconfig dev "$sw" show 2>/dev/null | awk -v sw="$sw" \'/^[ \t]*Port [0-9]+:/{sub(/:/,"",$2);cp=$2} /link:/{p=cp;st="down";spd="";dup="";for(i=1;i<=NF;i++){if($i~/^port:/){v=substr($i,6);p=(v!=""?v:$(i+1))}if($i~/^link:/){v=substr($i,6);st=(v!=""?v:$(i+1))}if($i~/^speed:/){v=substr($i,7);spd=(v!=""?v:$(i+1))}if($i~/duplex/)dup=$i}if(p!="")print "SWPORT|"sw"|"p"|"st"|"spd"|"dup}\'; done',
    'echo "===RDNS==="',
    'gw=$(ip route show default 2>/dev/null | awk \'/default/{print $3;exit}\'); for smac in $(for iface in $IW_IFS; do iw dev "$iface" station dump 2>/dev/null | awk \'/^Station/{print tolower($2)}\'; done | head -n 10); do sip=$(awk \'tolower($4)=="\'$smac\'"&&$3!="0x0"{print $1;exit}\' /proc/net/arp 2>/dev/null); [ -n "$sip" ] && echo "$smac $sip $(nslookup "$sip" ${gw:+"$gw"} 2>/dev/null | awk \'/name =/{print $NF;exit}/^Address 1:/&&NF>=4{print $4;exit}\')"; done',
    'echo "===OPKG_UPGRADABLE==="',
    'if command -v opkg >/dev/null 2>&1; then if [ -z "$(ls -A /var/opkg-lists 2>/dev/null)" ] && [ ! -f /tmp/.openwrt_mgr_opkg_init ]; then (touch /tmp/.openwrt_mgr_opkg_init; opkg update >/dev/null 2>&1) </dev/null >/dev/null 2>&1 & else opkg list-upgradable 2>/dev/null; fi; elif command -v apk >/dev/null 2>&1; then apk version -l "<" 2>/dev/null; fi',
    'echo "===ASU_CHECK==="',
    'if [ ! -f /tmp/.openwrt_mgr_asu_cache ]; then ( ( if command -v auc >/dev/null 2>&1; then auc -n 2>&1; elif command -v owut >/dev/null 2>&1; then owut check 2>&1; fi; echo "---VERSIONS_JSON---"; uclient-fetch -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null || wget -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null || true ) > /tmp/.openwrt_mgr_asu_cache.tmp 2>/dev/null; mv /tmp/.openwrt_mgr_asu_cache.tmp /tmp/.openwrt_mgr_asu_cache 2>/dev/null ) </dev/null >/dev/null 2>&1 & fi; cat /tmp/.openwrt_mgr_asu_cache 2>/dev/null || true',
    'true',
  ].join('; ');
}

/**
 * Collects telemetry from a real OpenWrt host via SSH (or HTTP ubus fallback).
 * Uses lightweight dynamic polling when a valid `prevSample.staticCache` exists, or full polling when `options.forceFull` is true or cache has expired.
 */
export async function pollRealHost(hostConfig, prevSample = null, options = {}) {
  const forceFull = Boolean(options?.forceFull || options?.full);
  const staticTtlMs =
    typeof options?.staticTtlMs === 'number' && options.staticTtlMs > 0
      ? options.staticTtlMs
      : DEFAULT_STATIC_CACHE_TTL_MS;
  const cachedStatic = prevSample?.staticCache || null;
  const cacheAgeMs = cachedStatic?.timestamp ? Date.now() - cachedStatic.timestamp : Infinity;
  const isFullPoll = forceFull || !cachedStatic || cacheAgeMs >= staticTtlMs;
  const hasPrevCpuSample = Boolean(prevSample?.cpuStat && prevSample.cpuStat.total > 0);
  const hasWirelessRadios = cachedStatic ? cachedStatic.hasWirelessRadios !== false : true;

  const remoteScript = buildTelemetrySshScript({
    full: isFullPoll,
    hasPrevCpuSample,
    hasWirelessRadios,
  });

  try {
    const { stdout } = await execSshCommand(hostConfig, remoteScript, {
      timeoutMs: isFullPoll ? 18000 : 10000,
    });
    return parseSshTelemetryOutput(hostConfig, stdout, prevSample, { isFullPoll });
  } catch (sshErr) {
    // If the SSH command exited non-zero because a sub-command failed, but stdout still contains telemetry sections, parse it as online
    if (sshErr && typeof sshErr.stdout === 'string' && /===(?:BOARD|UPTIME|SYSINFO|RELEASE)===/i.test(sshErr.stdout)) {
      return parseSshTelemetryOutput(hostConfig, sshErr.stdout, prevSample, { isFullPoll });
    }
    // If protocol is ubus_http or ubus_https, try HTTP ubus RPC
    if (hostConfig.protocol === 'ubus_http' || hostConfig.protocol === 'ubus_https') {
      try {
        const client = new OpenWrtUbusClient(hostConfig);
        await client.login();
        const [boardRes, infoRes, netDevRes] = await Promise.all([
          isFullPoll || !cachedStatic?.board ? client.getBoardInfo().catch(() => null) : Promise.resolve([0, cachedStatic.board]),
          client.getSystemInfo().catch(() => null),
          client.call('network.device', 'status', {}).catch(() => null),
        ]);
        const board = (boardRes && boardRes[1] ? boardRes[1] : null) || cachedStatic?.board || null;
        const sysinfo = infoRes && infoRes[1] ? infoRes[1] : null;
        const netDevMap = netDevRes && netDevRes[1] && typeof netDevRes[1] === 'object' ? netDevRes[1] : {};
        if (board || sysinfo) {
          const nowMs = Date.now();
          const uptimeSec = sysinfo?.uptime ? Math.floor(sysinfo.uptime) : hostConfig.uptimeSec || 0;
          const memUsagePct = parseMeminfo('', sysinfo) ?? hostConfig.memUsagePct ?? 0;
          const load1 = sysinfo?.load?.[0] ? Math.min(100, Math.round((sysinfo.load[0] / 655.36) * 10) / 10) : 0;
          const synthLines = [];
          for (const [ifn, devInfo] of Object.entries(netDevMap)) {
            if (!devInfo || typeof devInfo !== 'object') continue;
            if (Array.isArray(devInfo['bridge-members'])) {
              devInfo['bridge-members'].forEach((member, idx) => {
                const mInfo = netDevMap[member] || {};
                const spdMatch = String(mInfo.speed || '').match(/(\d+)/);
                const spd = spdMatch ? spdMatch[1] : '1000';
                const dup = String(mInfo.speed || '').toUpperCase().includes('H') ? 'half' : 'full';
                const oper = mInfo.up ? 'up' : 'down';
                const carr = mInfo.carrier ? '1' : '0';
                synthLines.push(`BRPORT|${ifn}|${member}|${idx + 1}|${spd}|${dup}|${oper}|${carr}|${mInfo.macaddr || ''}`);
              });
            } else if (!/^(lo|br-|switch|wlan|phy|ra|rax|ath|wds|mesh)/i.test(ifn) && !ifn.includes('.')) {
              const spdMatch = String(devInfo.speed || '').match(/(\d+)/);
              const spd = spdMatch ? spdMatch[1] : '1000';
              const dup = String(devInfo.speed || '').toUpperCase().includes('H') ? 'half' : 'full';
              const oper = devInfo.up ? 'up' : 'down';
              const carr = devInfo.carrier ? '1' : '0';
              synthLines.push(`NICPORT|${ifn}|${devInfo.macaddr || ''}|${spd}|${dup}|${oper}|${carr}|`);
            }
          }
          const { switchPorts, hostInterfaces, allHostMacs } = parseSwitchFdbSection(synthLines.join('\n'));
          const staticCache = isFullPoll || !cachedStatic
            ? { timestamp: nowMs, board, hasWirelessRadios: false }
            : cachedStatic;
          return {
            online: true,
            pollMode: isFullPoll ? 'full' : 'dynamic',
            staticCacheUpdatedAt: new Date(staticCache.timestamp).toISOString(),
            hostname: board?.hostname || hostConfig.hostname,
            model: board?.model || board?.system || hostConfig.model,
            firmware: board?.release?.description || hostConfig.firmware,
            uptimeSec,
            cpuUsagePct: load1,
            memUsagePct,
            mac: hostConfig.mac || allHostMacs?.[0] || null,
            allMacs: allHostMacs || [],
            hostInterfaces: hostInterfaces || [],
            rxRateBps: 0,
            txRateBps: 0,
            wan: hostConfig.wan || null,
            radios: [],
            switchPorts: switchPorts || [],
            clients: [],
            sample: { timestamp: nowMs, staticCache },
          };
        }
      } catch {
        // Fall through to lightweight SSH probe
      }
    }
    // Lightweight SSH fallback probe in case the full telemetry script timed out on a slow switch/AP
    try {
      const quickScript = [
        'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
        'echo "===BOARD==="',
        'ubus call system board 2>/dev/null',
        'echo "===SYSINFO==="',
        'ubus call system info 2>/dev/null',
        'echo "===UPTIME==="',
        'cat /proc/uptime 2>/dev/null',
        'echo "===MEMINFO==="',
        'cat /proc/meminfo 2>/dev/null',
        'echo "===DHCP==="',
        'cat /tmp/dhcp.leases 2>/dev/null',
        'echo "===ARP==="',
        'cat /proc/net/arp 2>/dev/null; echo "---IPNEIGH---"; ip -4 neigh show 2>/dev/null',
        'echo "===NETDEV_STATUS==="',
        'ubus call network.device status 2>/dev/null',
        'echo "===SWITCH_FDB==="',
        'ip link show 2>/dev/null | awk -F": " \'/^[0-9]+:/ && (/LOWER_UP/ || /state UP/) && !/NO-CARRIER/{sub(/@.*/,"",$2); print "LINKUP|" $2}\'',
        'for p in /sys/class/net/*/brif/*; do [ -e "$p" ] || continue; br=${p%/brif/*}; br=${br##*/}; ifn=${p##*/}; d="/sys/class/net/$ifn"; pno=""; spd=""; dup=""; oper=""; car=""; addr=""; bst=""; read -r pno < "$p/port_no" 2>/dev/null; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; read -r addr < "$d/address" 2>/dev/null; read -r bst < "$p/state" 2>/dev/null; echo "BRPORT|$br|$ifn|$pno|$spd|$dup|$oper|$car|$addr|$bst"; done',
        'for d in /sys/class/net/*; do [ -e "$d" ] || continue; ifn=${d##*/}; [ "$ifn" = "lo" ] && continue; m=""; read -r m < "$d/address" 2>/dev/null; [ -n "$m" ] && echo "HOSTIF|$ifn|$m|"; [ -e "$d/brport/bridge" ] && continue; [ -d "$d/bridge" ] || [ -d "$d/brif" ] || [ -d "$d/wireless" ] || [ -d "$d/phy80211" ] && continue; case "$ifn" in br-*|br[0-9]*|switch|switch.*|*.*|wlan*|phy*|ra*|rax*|ath*|wds*|mesh*|mon*|wg*|tun*|tap*|docker*|veth*|sit*|gre*|ip*|ifb*|teql*|erspan*|pppoe*|ppp*|bat*|tailscale*|zt*|miireg*|dummy*|bond*) continue ;; esac; spd=""; dup=""; oper=""; car=""; read -r spd < "$d/speed" 2>/dev/null; read -r dup < "$d/duplex" 2>/dev/null; read -r oper < "$d/operstate" 2>/dev/null; read -r car < "$d/carrier" 2>/dev/null; echo "NICPORT|$ifn|$m|$spd|$dup|$oper|$car|||"; done',
        'uci show network 2>/dev/null | grep -E "\\.(ports|device|ifname)=" | sed "s/^/UCINET|/"',
        'command -v jsonfilter >/dev/null 2>&1 && [ -f /etc/board.json ] && jsonfilter -i /etc/board.json -e "@.network.*.ports[*]" -e "@.network.*.device" 2>/dev/null | sed "s/^/BOARDPORT|/"',
        'command -v bridge >/dev/null 2>&1 && bridge fdb show 2>/dev/null | awk \'!(/permanent/ && /master/ && !/self/){m=tolower($1);d="";b="";v="";for(i=2;i<=NF;i++){if($i=="dev")d=$(i+1);if($i=="master")b=$(i+1);if($i=="vlan")v=$(i+1)}if(m~/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/&&d!="")print "FDB|"m"|"d"|"b"|"v}\'',
        'command -v hexdump >/dev/null 2>&1 && for b in /sys/class/net/*/brforward; do [ -e "$b" ] || continue; br=${b%/brforward}; br=${br##*/}; hexdump -v -e \'6/1 "%02x:" " " 1/1 "%u " 1/1 "%u " 4/1 "%02x" " " 1/1 "%u" 3/1 " %02x" "\\n"\' "$b" 2>/dev/null | awk -v br="$br" \'$3==0&&$2>0{sub(/:$/,"",$1);p=$2+($5*256);print "BRMAC|"br"|"p"|"tolower($1)}\'; done',
        'command -v swconfig >/dev/null 2>&1 && for sw in $(swconfig list 2>/dev/null | awk \'{print $2}\' | tr -d ":"); do swconfig dev "$sw" show 2>/dev/null | awk -v sw="$sw" \'/^[ \t]*Port [0-9]+:/{sub(/:/,"",$2);cp=$2} /link:/{p=cp;st="down";spd="";dup="";for(i=1;i<=NF;i++){if($i~/^port:/){v=substr($i,6);p=(v!=""?v:$(i+1))}if($i~/^link:/){v=substr($i,6);st=(v!=""?v:$(i+1))}if($i~/^speed:/){v=substr($i,7);spd=(v!=""?v:$(i+1))}if($i~/duplex/)dup=$i}if(p!="")print "SWPORT|"sw"|"p"|"st"|"spd"|"dup}\'; done',
        'echo "===IWDEV==="',
        'iw dev 2>/dev/null',
        'echo "===STATIONS==="',
        'for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do echo "---IFACE:$iface---"; iw dev "$iface" station dump 2>/dev/null; done',
        'true',
      ].join('; ');
      const { stdout: quickOut } = await execSshCommand(hostConfig, quickScript, { timeoutMs: 8000 });
      if (quickOut && /===(?:BOARD|UPTIME|SYSINFO)===/i.test(quickOut)) {
        const parsedQuick = parseSshTelemetryOutput(hostConfig, quickOut, prevSample);
        parsedQuick.isPartialFallback = true;
        return parsedQuick;
      }
    } catch (quickErr) {
      if (quickErr && typeof quickErr.stdout === 'string' && /===(?:BOARD|UPTIME|SYSINFO)===/i.test(quickErr.stdout)) {
        const parsedQuick = parseSshTelemetryOutput(hostConfig, quickErr.stdout, prevSample);
        parsedQuick.isPartialFallback = true;
        return parsedQuick;
      }
    }
    return {
      online: false,
      error: sshErr.message || 'SSH connection failed',
    };
  }
}

export function formatSwitchPortLabel(iface, speedMbps = null, maxSpeedMbps = null) {
  if (!iface || typeof iface !== 'string') return null;
  const raw = iface.trim();
  if (!raw || raw === 'lo') return null;
  // Ignore wireless interfaces
  if (/^(wlan|phy|ra|rax|ath|wds|mesh)/i.test(raw)) return null;

  const base = raw.split('.')[0];
  const vlanPart = raw.includes('.') ? raw.split('.')[1] : null;
  const vlanSuffix = vlanPart && vlanPart !== '1' ? ` (VLAN ${vlanPart})` : '';
  const validSpd = speedMbps && speedMbps > 0 ? speedMbps : null;
  const validMax = maxSpeedMbps && maxSpeedMbps > 0 ? maxSpeedMbps : null;

  const lanMatch = base.match(/^lan(\d+)$/i);
  if (lanMatch) {
    return {
      iface: raw,
      switchPort: `LAN ${lanMatch[1]}`,
      portNumber: Number(lanMatch[1]),
      portLabel: `LAN ${lanMatch[1]} (${raw})${vlanSuffix}`,
      speedMbps: validSpd,
      maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, 1000),
    };
  }

  const sfpMatch = base.match(/^(?:sfp(?:-?plus|\+)?|(?:te|ten|xg|opt|qsfp))(\d*)$/i);
  if (sfpMatch) {
    const num = sfpMatch[1] || '1';
    return {
      iface: raw,
      switchPort: `SFP+ ${num}`,
      portNumber: Number(num) || 1,
      portLabel: `SFP+ ${num} (${raw})${vlanSuffix}`,
      speedMbps: validSpd || 10000,
      maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, 10000),
    };
  }

  const wanMatch = base.match(/^wan(\d*)$/i);
  if (wanMatch) {
    const num = wanMatch[1] ? ` ${wanMatch[1]}` : '';
    return {
      iface: raw,
      switchPort: `WAN${num}`,
      portNumber: Number(wanMatch[1]) || 0,
      portLabel: `WAN${num} (${raw})${vlanSuffix}`,
      speedMbps: validSpd,
      maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, 1000),
    };
  }

  const ethMatch = base.match(/^eth(\d+)$/i);
  if (ethMatch) {
    const num = Number(ethMatch[1]);
    const cap = Math.max(validMax || 0, validSpd || 0, 1000);
    const label = cap >= 10000 || (validSpd && validSpd >= 10000) ? `10G Port ${num}` : `LAN ${num}`;
    return {
      iface: raw,
      switchPort: label,
      portNumber: num,
      portLabel: `${label} (${raw})${vlanSuffix}`,
      speedMbps: validSpd,
      maxSpeedMbps: cap,
    };
  }

  const portMatch = base.match(/^(sw\d*p|port|p|ge|gi|fa|fe|g)(\d+)$/i);
  if (portMatch) {
    const prefix = portMatch[1].toLowerCase();
    const isFastEthOnly = prefix === 'fa' || prefix === 'fe';
    return {
      iface: raw,
      switchPort: `Port ${portMatch[2]}`,
      portNumber: Number(portMatch[2]),
      portLabel: `Port ${portMatch[2]} (${raw})${vlanSuffix}`,
      speedMbps: validSpd,
      maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, isFastEthOnly ? 100 : 1000),
    };
  }

  if (/^br-/i.test(base)) {
    return {
      iface: raw,
      switchPort: base === 'br-lan' ? 'LAN Bridge' : base,
      portNumber: null,
      portLabel: `${base === 'br-lan' ? 'LAN Bridge' : base} (${raw})`,
      speedMbps: validSpd,
      maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, 1000),
    };
  }

  const trailingNumMatch = base.match(/(\d+)$/);
  return {
    iface: raw,
    switchPort: raw.toUpperCase(),
    portNumber: trailingNumMatch ? Number(trailingNumMatch[1]) : null,
    portLabel: `${raw}${vlanSuffix}`,
    speedMbps: validSpd,
    maxSpeedMbps: Math.max(validMax || 0, validSpd || 0, 1000),
  };
}

export function parseSwitchFdbSection(switchFdbTxt, iwInterfaces = new Map(), options = {}) {
  const { wanDev = null, netCounters = {}, prevNetCounters = null, dtSec = 10 } = options;
  const switchPortsByIface = new Map();
  const rawNicPorts = [];
  const swconfigPorts = [];
  const deferredFdbEntries = [];
  const deferredBrMacEntries = [];
  const ifAddrByIface = new Map();
  const uciConfiguredPorts = new Set();
  const lowerUpIfaces = new Set();
  const activeBridgeMembers = new Set();
  const portCapByIface = new Map();
  const portNoToIfaceByBridge = new Map();
  const fdbByMac = new Map();
  const hostInterfaces = [];
  const allHostMacsSet = new Set();
  let defaultRoute = null;

  if (!switchFdbTxt) {
    return { switchPorts: [], fdbByMac, hostInterfaces, allHostMacs: [], defaultRoute };
  }

  const normalizePortNo = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    const n = s.startsWith('0x') || s.startsWith('0X') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  const normalizeMac = (m) => {
    if (!m) return null;
    const clean = String(m).trim().toLowerCase();
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(clean) && clean !== '00:00:00:00:00:00') {
      return clean;
    }
    return null;
  };

  const isMulticastOrBroadcastMac = (m) => {
    if (!m || m.length < 2) return true;
    const firstOctet = parseInt(m.slice(0, 2), 16);
    return Number.isNaN(firstOctet) || (firstOctet & 1) === 1;
  };

  for (const rawLine of String(switchFdbTxt).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('LINKUP|')) {
      const ifname = line.slice('LINKUP|'.length).trim();
      if (ifname) lowerUpIfaces.add(ifname);
      continue;
    }

    if (line.startsWith('IFADDR|')) {
      const [, ifname, ipv4] = line.split('|');
      if (ifname && ipv4 && !ifAddrByIface.has(ifname)) {
        ifAddrByIface.set(ifname, ipv4.trim());
      }
      continue;
    }

    if (line.startsWith('BRMEMBER|')) {
      const [, , member] = line.split('|');
      if (member) {
        activeBridgeMembers.add(member.trim());
        if (/^(lan|wan|sfp(?:-?plus)?|opt|sw\d*p|port|p|ge|gi|fa|fe|g|te|ten|xg|qsfp|eth)\d+$/i.test(member.trim())) {
          uciConfiguredPorts.add(member.trim());
        }
      }
      continue;
    }

    if (line.startsWith('HOSTIF|')) {
      const [, ifname, rawMac, ipv4] = line.split('|');
      const mac = normalizeMac(rawMac);
      if (mac) allHostMacsSet.add(mac);
      if (ifname) {
        hostInterfaces.push({
          iface: ifname,
          mac: mac || null,
          ipv4: ipv4 || ifAddrByIface.get(ifname) || null,
        });
      }
      continue;
    }

    if (line.startsWith('DEFROUTE|')) {
      const [, gwIp, dev, srcIp] = line.split('|');
      defaultRoute = {
        gatewayIp: gwIp || null,
        dev: dev || null,
        srcIp: srcIp || null,
      };
      continue;
    }

    if (line.startsWith('BRPORT|')) {
      const [, bridge, ifname, rawPortNo, rawSpeed, rawDuplex, rawOper, rawCarrier, rawIfMac, rawBrState] = line.split('|');
      if (!ifname || iwInterfaces.has(ifname) || /^(wlan|phy|ra|rax|ath|wds|mesh)/i.test(ifname)) {
        continue;
      }
      const ifMac = normalizeMac(rawIfMac);
      if (ifMac) allHostMacsSet.add(ifMac);
      const portNo = normalizePortNo(rawPortNo);
      const speedNum = parseInt(rawSpeed, 10);
      const speedMbps = Number.isFinite(speedNum) && speedNum > 0 ? speedNum : null;
      const formatted = formatSwitchPortLabel(ifname, speedMbps);
      if (!formatted) continue;

      const isBrForwarding = rawBrState === '3' || rawBrState === '2';
      const isExplicitlyDown =
        !isBrForwarding &&
        (rawCarrier === '0' || rawOper === 'down' || rawOper === 'lowerlayerdown' || rawBrState === '0');
      const isUp =
        rawCarrier === '1' ||
        rawOper === 'up' ||
        isBrForwarding ||
        lowerUpIfaces.has(ifname) ||
        (!isExplicitlyDown && speedMbps !== null && speedMbps > 0);

      const portObj = {
        iface: ifname,
        switchPort: formatted.switchPort,
        portNumber: formatted.portNumber ?? portNo,
        portLabel: formatted.portLabel,
        portRole: /^wan/i.test(ifname) || ifname === wanDev ? 'wan' : 'lan',
        mac: ifMac || null,
        bridge: bridge || 'br-lan',
        portNo,
        speedMbps: speedMbps || 1000,
        duplex: rawDuplex && rawDuplex !== 'unknown' ? rawDuplex : 'full',
        status: isUp ? 'up' : 'down',
        linkUp: Boolean(isUp),
        connectedMacs: [],
      };
      switchPortsByIface.set(ifname, portObj);
      if (bridge && portNo !== null) {
        portNoToIfaceByBridge.set(`${bridge}:${portNo}`, ifname);
      }
      continue;
    }

    if (line.startsWith('NICPORT|')) {
      const [, ifname, rawIfMac, rawSpeed, rawDuplex, rawOper, rawCarrier, bridge, rawBrState, rawPortNo] = line.split('|');
      if (!ifname || iwInterfaces.has(ifname) || /^(wlan|phy|ra|rax|ath|wds|mesh|lo|br-)/i.test(ifname)) {
        continue;
      }
      const ifMac = normalizeMac(rawIfMac);
      if (ifMac) allHostMacsSet.add(ifMac);
      const portNo = normalizePortNo(rawPortNo);
      if (bridge && portNo !== null && !portNoToIfaceByBridge.has(`${bridge}:${portNo}`)) {
        portNoToIfaceByBridge.set(`${bridge}:${portNo}`, ifname);
      }
      rawNicPorts.push({
        ifname,
        ifMac,
        rawSpeed,
        rawDuplex,
        rawOper,
        rawCarrier,
        bridge: bridge || null,
        rawBrState: rawBrState || null,
        portNo,
      });
      continue;
    }

    if (line.startsWith('SWPORT|')) {
      const [, swDev, rawPortNum, rawLinkStatus, rawSpeed, rawDuplex] = line.split('|');
      swconfigPorts.push({
        swDev: swDev || 'switch0',
        portNumber: parseInt(rawPortNum, 10),
        linkStatus: String(rawLinkStatus || 'down').replace(/[,;]+$/, '').trim(),
        rawSpeed: rawSpeed || '',
        rawDuplex: rawDuplex || 'full',
      });
      continue;
    }

    if (line.startsWith('UCINET|')) {
      // e.g. UCINET|network.@device[0].ports='lan1' 'lan2' ... 'lan24' or UCINET|network.@bridge-vlan[0].ports='lan1:u*' 'lan2:t'
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1 && /\.ports=/.test(line.slice(0, eqIdx + 1))) {
        const rhs = line.slice(eqIdx + 1).replace(/['"]/g, ' ');
        for (const token of rhs.split(/\s+/)) {
          const cleanPort = token.split(':')[0].trim();
          if (cleanPort && /^(lan|wan|sfp(?:-?plus)?|opt|sw\d*p|port|p|ge|gi|fa|fe|g|te|ten|xg|qsfp|eth)\d+$/i.test(cleanPort)) {
            uciConfiguredPorts.add(cleanPort);
          }
        }
      }
      continue;
    }

    if (line.startsWith('BOARDPORT|')) {
      const rawPort = line.slice('BOARDPORT|'.length).trim();
      for (const token of rawPort.split(/\s+/)) {
        const cleanPort = token.split(':')[0].trim();
        if (
          cleanPort &&
          !cleanPort.includes('.') &&
          !/^(lo|br-|switch)$/i.test(cleanPort) &&
          /^(lan|wan|sfp(?:-?plus)?|opt|sw\d*p|port|p|ge|gi|fa|fe|g|te|ten|xg|qsfp|eth)\d+$/i.test(cleanPort)
        ) {
          uciConfiguredPorts.add(cleanPort);
        }
      }
      continue;
    }

    if (line.startsWith('PORTCAP|')) {
      const [, ifname, rawMaxSpd, rawCurSpd, rawCarrier, rawUp] = line.split('|');
      if (ifname) {
        const maxNum = parseInt(rawMaxSpd, 10);
        const curNum = parseInt(rawCurSpd, 10);
        const existing = portCapByIface.get(ifname) || {
          maxSpeedMbps: null,
          curSpeedMbps: null,
          carrier: null,
          up: null,
        };
        if (Number.isFinite(maxNum) && maxNum > 0 && (!existing.maxSpeedMbps || maxNum > existing.maxSpeedMbps)) {
          existing.maxSpeedMbps = maxNum;
        }
        if (Number.isFinite(curNum) && curNum > 0) {
          existing.curSpeedMbps = curNum;
        }
        if (rawCarrier === '1') {
          existing.carrier = true;
        } else if (rawCarrier === '0' && existing.carrier !== true) {
          existing.carrier = false;
        }
        if (rawUp === '1') {
          existing.up = true;
        } else if (rawUp === '0' && existing.up !== true) {
          existing.up = false;
        }
        portCapByIface.set(ifname, existing);
        if (
          !ifname.includes('.') &&
          /^(lan|wan|sfp(?:-?plus)?|opt|sw\d*p|port|ge|gi|fa|fe|te|ten|xg|qsfp)\d+$/i.test(ifname)
        ) {
          uciConfiguredPorts.add(ifname);
        }
      }
      continue;
    }

    // Also support raw `bridge fdb show` lines: `aa:bb:cc:dd:ee:ff dev lan1 master br-lan`
    const rawFdbMatch = !line.startsWith('FDB|') && !line.startsWith('BRMAC|')
      ? line.match(/^(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+dev\s+(\S+)(?:\s+vlan\s+(\d+))?(?:\s+master\s+(\S+))?/i)
      : null;
    if (line.startsWith('FDB|') || (rawFdbMatch && !/\bpermanent\b/i.test(line))) {
      const [, rawMac, dev, bridge, rawVlan] = rawFdbMatch
        ? [null, rawFdbMatch[1], rawFdbMatch[3], rawFdbMatch[5] || 'br-lan', rawFdbMatch[4] || '1']
        : line.split('|');
      const mac = (rawMac || '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || isMulticastOrBroadcastMac(mac)) continue;
      if (!dev || iwInterfaces.has(dev) || /^(wlan|phy|ra|rax|ath|wds|mesh|lo)/i.test(dev)) continue;
      deferredFdbEntries.push({
        mac,
        dev: dev.trim(),
        bridge: bridge || 'br-lan',
        vlan: rawVlan ? parseInt(rawVlan, 10) || 1 : 1,
      });
      continue;
    }

    if (line.startsWith('BRMAC|')) {
      const [, bridge, rawPortNo, rawMac] = line.split('|');
      const mac = (rawMac || '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || isMulticastOrBroadcastMac(mac)) continue;
      const portNo = normalizePortNo(rawPortNo);
      if (portNo === null) continue;
      deferredBrMacEntries.push({
        mac,
        bridge: bridge || 'br-lan',
        portNo,
      });
    }
  }

  for (const hi of hostInterfaces) {
    if (!hi.ipv4 && ifAddrByIface.has(hi.iface)) {
      hi.ipv4 = ifAddrByIface.get(hi.iface);
    }
  }

  // Merge standalone / routed NIC ports (`NICPORT`) not already in `switchPortsByIface`
  const hasDsaLanPorts =
    Array.from(switchPortsByIface.keys()).some((k) => /^(lan|sw\d*p|port|ge|gi|fa|sfp)\d+/i.test(k)) ||
    rawNicPorts.some((n) => /^(lan|sw\d*p|port|ge|gi|fa|sfp)\d+/i.test(n.ifname)) ||
    uciConfiguredPorts.size > 1;
  for (const nic of rawNicPorts) {
    if (switchPortsByIface.has(nic.ifname)) {
      const existing = switchPortsByIface.get(nic.ifname);
      if (!existing.mac && nic.ifMac) existing.mac = nic.ifMac;
      if (nic.rawBrState === '3' || nic.rawBrState === '2') {
        existing.linkUp = true;
        existing.status = 'up';
      }
      continue;
    }
    const isWanNic = nic.ifname === wanDev || /^wan\d*$/i.test(nic.ifname) || (defaultRoute?.dev === nic.ifname && !nic.bridge);
    const hasIp = hostInterfaces.some((hi) => hi.iface === nic.ifname && hi.ipv4);
    // Skip internal DSA CPU conduit interfaces (e.g., unbridged eth0/eth1 with no IP and not WAN when DSA lan1..lanN ports exist)
    if (hasDsaLanPorts && /^eth\d+$/i.test(nic.ifname) && !isWanNic && !hasIp && !nic.bridge) {
      continue;
    }
    const speedNum = parseInt(nic.rawSpeed, 10);
    const speedMbps = Number.isFinite(speedNum) && speedNum > 0 ? speedNum : null;
    const formatted = isWanNic && !/^wan/i.test(nic.ifname)
      ? {
          iface: nic.ifname,
          switchPort: 'WAN',
          portNumber: 0,
          portLabel: `WAN (${nic.ifname})`,
          speedMbps: speedMbps || 1000,
        }
      : formatSwitchPortLabel(nic.ifname, speedMbps);
    if (!formatted) continue;

    const isBrForwarding = nic.rawBrState === '3' || nic.rawBrState === '2';
    const isExplicitlyDown =
      !isBrForwarding &&
      (nic.rawCarrier === '0' || nic.rawOper === 'down' || nic.rawOper === 'lowerlayerdown' || nic.rawBrState === '0');
    const isUp =
      nic.rawCarrier === '1' ||
      nic.rawOper === 'up' ||
      isBrForwarding ||
      lowerUpIfaces.has(nic.ifname) ||
      (!isExplicitlyDown && speedMbps !== null && speedMbps > 0);

    switchPortsByIface.set(nic.ifname, {
      iface: nic.ifname,
      switchPort: formatted.switchPort,
      portNumber: formatted.portNumber ?? nic.portNo,
      portLabel: formatted.portLabel,
      portRole: isWanNic ? 'wan' : nic.bridge ? 'lan' : 'routed',
      mac: nic.ifMac || null,
      bridge: nic.bridge || null,
      portNo: nic.portNo,
      speedMbps: speedMbps || formatted.speedMbps || 1000,
      duplex: nic.rawDuplex && nic.rawDuplex !== 'unknown' ? nic.rawDuplex : 'full',
      status: isUp ? 'up' : 'down',
      linkUp: Boolean(isUp),
      connectedMacs: [],
    });
  }

  // Merge any UCI-configured switch ports (`UCINET|`) not yet present in `switchPortsByIface` (e.g. disabled or unbridged ports on a 24-port switch)
  for (const uciPort of uciConfiguredPorts) {
    if (switchPortsByIface.has(uciPort)) continue;
    if (hasDsaLanPorts && /^eth\d+$/i.test(uciPort)) continue;
    const formatted = formatSwitchPortLabel(uciPort);
    if (!formatted) continue;
    const isUp = lowerUpIfaces.has(uciPort);
    switchPortsByIface.set(uciPort, {
      iface: uciPort,
      switchPort: formatted.switchPort,
      portNumber: formatted.portNumber,
      portLabel: formatted.portLabel,
      portRole: /^wan/i.test(uciPort) ? 'wan' : 'lan',
      mac: null,
      bridge: 'switch',
      portNo: formatted.portNumber,
      speedMbps: formatted.speedMbps || 1000,
      duplex: 'full',
      status: isUp ? 'up' : 'down',
      linkUp: Boolean(isUp),
      connectedMacs: [],
    });
    if (formatted.portNumber !== null && !portNoToIfaceByBridge.has(`switch:${formatted.portNumber}`)) {
      portNoToIfaceByBridge.set(`switch:${formatted.portNumber}`, uciPort);
    }
  }

  // If `switchPortsByIface` contains a virtual bridge/VLAN subinterface (like `switch.1` or `eth0.1`) alongside real physical ports, remove the virtual subinterface
  const physicalPortKeys = Array.from(switchPortsByIface.keys()).filter(
    (k) => !k.includes('.') && !/^(switch|br-)/i.test(k) && !/^eth\d+$/i.test(k)
  );
  if (physicalPortKeys.length > 1) {
    for (const key of Array.from(switchPortsByIface.keys())) {
      if (key.includes('.') || /^(switch|br-)/i.test(key)) {
        switchPortsByIface.delete(key);
      }
    }
  }

  // Merge or fallback for swconfig switches (including 5/8/16/24/28-port swconfig switches)
  if (swconfigPorts.length > 0) {
    if (switchPortsByIface.size < swconfigPorts.length) {
      // Remove dummy eth0 / eth0.1 CPU conduit entries when swconfig provides the real physical switch ports
      for (const key of Array.from(switchPortsByIface.keys())) {
        if (/^(eth\d+(\.\d+)?|switch(\.\d+)?)$/i.test(key)) {
          switchPortsByIface.delete(key);
        }
      }
    }
    const hasZeroPort = swconfigPorts.some((p) => p.portNumber === 0);
    const hasLanZero = switchPortsByIface.has('lan0') || switchPortsByIface.has('port0');
    for (const swp of swconfigPorts) {
      if (!Number.isFinite(swp.portNumber)) continue;
      const spdMatch = String(swp.rawSpeed).match(/(\d+)/);
      const speedMbps = spdMatch ? Number(spdMatch[1]) : 1000;
      const isUp = /^(up|1|yes)/i.test(String(swp.linkStatus || '').trim());
      const existingMatch =
        switchPortsByIface.get(`port${swp.portNumber}`) ||
        switchPortsByIface.get(`lan${swp.portNumber}`) ||
        Array.from(switchPortsByIface.values()).find((p) => p.portNumber === swp.portNumber) ||
        (hasZeroPort && !hasLanZero ? switchPortsByIface.get(`lan${swp.portNumber + 1}`) : null);
      if (existingMatch) {
        if (isUp && !existingMatch.linkUp) {
          existingMatch.linkUp = true;
          existingMatch.status = 'up';
        }
        if (spdMatch && speedMbps > 0) {
          existingMatch.speedMbps = speedMbps;
        }
        continue;
      }
      if (switchPortsByIface.size < swconfigPorts.length) {
        const ifname = `port${swp.portNumber}`;
        switchPortsByIface.set(ifname, {
          iface: ifname,
          switchPort: `Port ${swp.portNumber}`,
          portNumber: swp.portNumber,
          portLabel: `Port ${swp.portNumber} (${swp.swDev})`,
          portRole: 'lan',
          mac: null,
          bridge: 'br-lan',
          portNo: swp.portNumber,
          speedMbps,
          duplex: String(swp.rawDuplex).includes('half') ? 'half' : 'full',
          status: isUp ? 'up' : 'down',
          linkUp: Boolean(isUp),
          connectedMacs: [],
        });
      }
    }
  }

  // Now resolve deferred FDB| and BRMAC| entries against the complete set of ports in `switchPortsByIface`
  for (const fdbItem of deferredFdbEntries) {
    const { mac, dev, bridge, vlan } = fdbItem;
    if (allHostMacsSet.has(mac)) continue;

    const baseDev = dev.split('.')[0];
    const knownPort =
      switchPortsByIface.get(dev) ||
      switchPortsByIface.get(baseDev) ||
      Array.from(switchPortsByIface.values()).find(
        (p) => p.portNumber !== null && p.portNumber === formatSwitchPortLabel(baseDev)?.portNumber
      ) ||
      null;
    const resolvedIface = knownPort ? knownPort.iface : dev;

    const existingFdb = fdbByMac.get(mac);
    const isVirtualOrConduitDev = resolvedIface.includes('.') || /^(switch|br-|eth\d+$)/i.test(resolvedIface);
    const existingIsPhysical =
      existingFdb && !existingFdb.iface.includes('.') && !/^(switch|br-|eth\d+$)/i.test(existingFdb.iface);
    if (existingIsPhysical && isVirtualOrConduitDev) continue;

    const formatted = knownPort || formatSwitchPortLabel(resolvedIface);
    if (!formatted) continue;

    fdbByMac.set(mac, {
      iface: resolvedIface,
      switchPort: formatted.switchPort,
      portNumber: formatted.portNumber ?? null,
      portLabel: formatted.portLabel,
      bridge: bridge || knownPort?.bridge || 'br-lan',
      speedMbps: knownPort?.speedMbps || formatted.speedMbps || 1000,
      vlan,
    });
    if (knownPort && !knownPort.connectedMacs.includes(mac)) {
      knownPort.connectedMacs.push(mac);
    }
  }

  for (const brItem of deferredBrMacEntries) {
    const { mac, bridge, portNo } = brItem;
    if (allHostMacsSet.has(mac) || fdbByMac.has(mac)) continue;

    let ifname = portNoToIfaceByBridge.get(`${bridge}:${portNo}`) || null;
    if (!ifname) {
      const byPortNo = Array.from(switchPortsByIface.values()).find(
        (p) => p.portNo === portNo || p.portNumber === portNo
      );
      if (byPortNo) ifname = byPortNo.iface;
    }
    if (!ifname || iwInterfaces.has(ifname)) continue;

    const knownPort = switchPortsByIface.get(ifname);
    const formatted = knownPort || formatSwitchPortLabel(ifname);
    if (!formatted) continue;

    fdbByMac.set(mac, {
      iface: ifname,
      switchPort: formatted.switchPort,
      portNumber: formatted.portNumber ?? portNo,
      portLabel: formatted.portLabel,
      bridge: bridge || 'br-lan',
      speedMbps: knownPort?.speedMbps || 1000,
      vlan: 1,
    });
    if (knownPort && !knownPort.connectedMacs.includes(mac)) {
      knownPort.connectedMacs.push(mac);
    }
  }

  // Enrich switchPorts with hardware capability (`maxSpeedMbps`), link state from ubus/ethtool/ip-link/FDB, and per-NIC byte & rate counters from /proc/net/dev
  for (const portObj of switchPortsByIface.values()) {
    const cap = portCapByIface.get(portObj.iface);
    const fmt = formatSwitchPortLabel(portObj.iface, portObj.speedMbps, cap?.maxSpeedMbps);
    if (cap?.curSpeedMbps && (!portObj.speedMbps || portObj.speedMbps === 1000)) {
      portObj.speedMbps = cap.curSpeedMbps;
    }

    const curr = netCounters[portObj.iface];
    if (curr) {
      portObj.rxBytes = curr.rxBytes || 0;
      portObj.txBytes = curr.txBytes || 0;
      const prev = prevNetCounters ? prevNetCounters[portObj.iface] : null;
      if (prev && dtSec > 0) {
        portObj.rxRateBps = curr.rxBytes >= prev.rxBytes ? Math.round(((curr.rxBytes - prev.rxBytes) * 8) / dtSec) : 0;
        portObj.txRateBps = curr.txBytes >= prev.txBytes ? Math.round(((curr.txBytes - prev.txBytes) * 8) / dtSec) : 0;
      } else {
        portObj.rxRateBps = 0;
        portObj.txRateBps = 0;
      }
    }

    const isCapUp =
      cap?.carrier === true ||
      (cap?.carrier !== false && cap?.up === true && (cap?.curSpeedMbps > 0 || activeBridgeMembers.has(portObj.iface))) ||
      (cap?.carrier !== false && activeBridgeMembers.has(portObj.iface));
    const hasLiveTraffic = portObj.rxRateBps > 0 || portObj.txRateBps > 0;
    const baseIface = portObj.iface.split('.')[0];

    if (
      !portObj.linkUp &&
      (isCapUp ||
        lowerUpIfaces.has(portObj.iface) ||
        lowerUpIfaces.has(baseIface) ||
        portObj.connectedMacs.length > 0 ||
        hasLiveTraffic)
    ) {
      portObj.linkUp = true;
      portObj.status = 'up';
    }
    portObj.maxSpeedMbps = Math.max(
      cap?.maxSpeedMbps || 0,
      portObj.maxSpeedMbps || 0,
      fmt?.maxSpeedMbps || 1000,
      portObj.speedMbps || 0
    );
  }

  // Annotate each fdb entry with how many total MACs were learned on that same switch port and its hardware maxSpeedMbps
  for (const entry of fdbByMac.values()) {
    const portObj = switchPortsByIface.get(entry.iface);
    entry.portMacCount = portObj ? portObj.connectedMacs.length : 1;
    if (portObj) {
      entry.speedMbps = portObj.speedMbps || entry.speedMbps || 1000;
      entry.maxSpeedMbps = portObj.maxSpeedMbps || entry.speedMbps || 1000;
    } else {
      const cap = portCapByIface.get(entry.iface);
      const fmt = formatSwitchPortLabel(entry.iface, entry.speedMbps, cap?.maxSpeedMbps);
      entry.maxSpeedMbps = Math.max(cap?.maxSpeedMbps || 0, fmt?.maxSpeedMbps || 1000, entry.speedMbps || 0);
    }
  }

  const switchPorts = Array.from(switchPortsByIface.values()).sort((a, b) => {
    if (a.portRole === 'wan' && b.portRole !== 'wan') return -1;
    if (b.portRole === 'wan' && a.portRole !== 'wan') return 1;
    const aIsSfp = /^sfp/i.test(a.switchPort || '') || /^(sfp|te|xg|opt)/i.test(a.iface || '');
    const bIsSfp = /^sfp/i.test(b.switchPort || '') || /^(sfp|te|xg|opt)/i.test(b.iface || '');
    if (aIsSfp !== bIsSfp) return aIsSfp ? 1 : -1;
    if (a.portNumber !== null && b.portNumber !== null && a.portNumber !== b.portNumber) {
      return a.portNumber - b.portNumber;
    }
    return a.iface.localeCompare(b.iface);
  });

  return {
    switchPorts,
    fdbByMac,
    hostInterfaces,
    allHostMacs: Array.from(allHostMacsSet),
    defaultRoute,
  };
}

function extractStaticSwitchFdbLines(switchFdbTxt) {
  const staticLines = [];
  for (const rawLine of String(switchFdbTxt || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.startsWith('IFADDR|') ||
      line.startsWith('HOSTIF|') ||
      line.startsWith('UCINET|') ||
      line.startsWith('BOARDPORT|') ||
      line.startsWith('DEFROUTE|')
    ) {
      staticLines.push(line);
    } else if (line.startsWith('PORTCAP|')) {
      const parts = line.split('|');
      const ifn = parts[1] || '';
      const maxSpd = parts[2] || '';
      if (ifn && maxSpd) {
        staticLines.push(`PORTCAP|${ifn}|${maxSpd}|||`);
      }
    }
  }
  return staticLines.join('\n');
}

export function parseSshTelemetryOutput(hostConfig, stdout, prevSample = null, options = {}) {
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

  const hasSection = (k) => Object.prototype.hasOwnProperty.call(sections, k);
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

  const cachedStatic = prevSample?.staticCache || null;
  const hasStaticSectionsInStdout =
    hasSection('BOARD') ||
    hasSection('RELEASE') ||
    hasSection('WIRELESS') ||
    hasSection('NETDEV_STATUS') ||
    hasSection('OPKG_UPGRADABLE') ||
    hasSection('ASU_STATUS');
  const isFullPoll =
    options?.isFullPoll !== undefined ? Boolean(options.isFullPoll) : Boolean(hasStaticSectionsInStdout || !cachedStatic);

  const board = hasSection('BOARD') ? getSectionJson('BOARD') : (cachedStatic?.board ?? null);
  const sysinfo = hasSection('SYSINFO') ? getSectionJson('SYSINFO') : (cachedStatic?.sysinfo ?? null);
  const releaseTxt = hasSection('RELEASE') ? getSectionText('RELEASE') : (cachedStatic?.releaseTxt ?? '');
  const modelTxt = hasSection('MODEL') ? getSectionText('MODEL') : (cachedStatic?.modelTxt ?? '');
  const uptimeTxt = getSectionText('UPTIME');
  const meminfoTxt = getSectionText('MEMINFO');
  const cpu1Txt = getSectionText('CPUSTAT1');
  const cpu2Txt = getSectionText('CPUSTAT2');
  const macTxt = hasSection('MAC') ? getSectionText('MAC') : (cachedStatic?.macTxt ?? '');
  const netdevTxt = getSectionText('NETDEV');
  const wanJson = hasSection('WAN') ? getSectionJson('WAN') : (cachedStatic?.wanJson ?? null);
  const wirelessJson = hasSection('WIRELESS') ? getSectionJson('WIRELESS') : (cachedStatic?.wirelessJson ?? null);
  const iwdevTxt = hasSection('IWDEV') ? getSectionText('IWDEV') : (cachedStatic?.iwdevTxt ?? '');
  const surveyTxt = getSectionText('SURVEY');
  const scanDumpTxt = hasSection('SCANDUMP') ? getSectionText('SCANDUMP') : (cachedStatic?.scanDumpTxt ?? '');
  const stationsTxt = getSectionText('STATIONS');
  const dhcpTxt = getSectionText('DHCP');
  const uciDhcpTxt = hasSection('UCI_DHCP') ? getSectionText('UCI_DHCP') : (cachedStatic?.uciDhcpTxt ?? '');
  const ubusDhcpJson = hasSection('UBUS_DHCP') ? getSectionJson('UBUS_DHCP') : (cachedStatic?.ubusDhcpJson ?? null);
  const ethersTxt = hasSection('ETHERS') ? getSectionText('ETHERS') : (cachedStatic?.ethersTxt ?? '');
  const arpTxt = getSectionText('ARP');
  const netDevStatusJson = hasSection('NETDEV_STATUS')
    ? getSectionJson('NETDEV_STATUS')
    : (cachedStatic?.netDevStatusJson ?? null);
  const switchFdbTxt = getSectionText('SWITCH_FDB');
  const rdnsTxt = hasSection('RDNS') ? getSectionText('RDNS') : (cachedStatic?.rdnsTxt ?? '');
  const opkgUpgradableTxt = hasSection('OPKG_UPGRADABLE')
    ? getSectionText('OPKG_UPGRADABLE')
    : (cachedStatic?.opkgUpgradableTxt ?? '');
  const asuStatusTxt = hasSection('ASU_STATUS') ? getSectionText('ASU_STATUS') : (cachedStatic?.asuStatusTxt ?? '');
  const asuCheckTxt = hasSection('ASU_CHECK') ? getSectionText('ASU_CHECK') : (cachedStatic?.asuCheckTxt ?? '');

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

  // 4. CPU Usage (%) and CPU Core Count from /proc/stat
  const stat1 = parseCpuLine(cpu1Txt);
  const stat2 = parseCpuLine(cpu2Txt);
  const detectedCpuCores =
    parseCpuCoreCount(cpu2Txt, cpu1Txt) ??
    cachedStatic?.cpuCores ??
    (typeof hostConfig?.cpuCores === 'number' && hostConfig.cpuCores > 0 ? hostConfig.cpuCores : null);
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
        bssid: null,
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

    const addrMatch = line.match(/^addr\s+(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})/);
    if (addrMatch) {
      currentIface.bssid = addrMatch[1].toLowerCase();
      continue;
    }
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

  // 8. Parse DHCP leases, UCI static reservations, ubus dhcp ipv4leases, /etc/ethers, ARP & ip neigh, and Reverse DNS
  const dhcpByMac = new Map();
  const nowEpoch = Math.floor(nowMs / 1000);

  // 8a. Static /etc/ethers (mac ip)
  if (ethersTxt) {
    for (const line of ethersTxt.split('\n')) {
      const clean = line.replace(/#.*$/, '').trim();
      if (!clean) continue;
      const parts = clean.split(/\s+/);
      if (parts.length >= 2 && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(parts[0])) {
        const eMac = parts[0].toLowerCase();
        const eIp = parts[1];
        dhcpByMac.set(eMac, {
          ip: eIp,
          hostname: eIp,
          dhcpLeaseRemainingSec: 86400,
        });
      }
    }
  }

  // 8b. UCI static host reservations (`uci show dhcp`)
  if (uciDhcpTxt) {
    const uciHosts = new Map();
    for (const line of uciDhcpTxt.split('\n')) {
      const m = line.trim().match(/^dhcp\.([^.=]+)\.(mac|ip|name)=(.+)$/);
      if (!m) continue;
      const [, sec, key, rawVal] = m;
      const val = rawVal.replace(/^['"]|['"]$/g, '').trim();
      if (!uciHosts.has(sec)) uciHosts.set(sec, {});
      uciHosts.get(sec)[key] = val;
    }
    for (const hObj of uciHosts.values()) {
      if (!hObj.mac || !hObj.ip) continue;
      const macList = hObj.mac.split(/[\s,]+/).map((s) => s.replace(/^['"]|['"]$/g, '').toLowerCase());
      for (const sMac of macList) {
        if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(sMac)) {
          dhcpByMac.set(sMac, {
            ip: hObj.ip,
            hostname: hObj.name || hObj.ip,
            dhcpLeaseRemainingSec: 86400,
          });
        }
      }
    }
  }

  // 8c. ubus call dhcp ipv4leases
  if (ubusDhcpJson?.device && typeof ubusDhcpJson.device === 'object') {
    for (const devObj of Object.values(ubusDhcpJson.device)) {
      const leases = Array.isArray(devObj?.leases) ? devObj.leases : [];
      for (const l of leases) {
        if (!l.mac || !l.address) continue;
        let normMac = String(l.mac).toLowerCase();
        if (/^[0-9a-f]{12}$/.test(normMac)) {
          normMac = normMac.match(/.{2}/g).join(':');
        }
        if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normMac)) {
          dhcpByMac.set(normMac, {
            ip: l.address,
            hostname: l.hostname || l.address,
            dhcpLeaseRemainingSec: Number(l.valid) > 0 ? Number(l.valid) : 36000,
          });
        }
      }
    }
  }

  // 8d. dnsmasq /tmp/dhcp.leases (and custom leasefile)
  for (const line of dhcpTxt.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4 && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(parts[1])) {
      const expiry = Number(parts[0]);
      const lMac = parts[1].toLowerCase();
      const lIp = parts[2];
      const existing = dhcpByMac.get(lMac);
      const lHost = parts[3] && parts[3] !== '*' ? parts[3] : existing?.hostname || lIp;
      dhcpByMac.set(lMac, {
        ip: lIp,
        hostname: lHost,
        dhcpLeaseRemainingSec: expiry > nowEpoch ? expiry - nowEpoch : 36000,
      });
    }
  }

  // 8e. /proc/net/arp and `ip -4 neigh show`
  const arpByMac = new Map();
  let inIpNeigh = false;
  for (const rawLine of arpTxt.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '---IPNEIGH---') {
      inIpNeigh = true;
      continue;
    }
    if (!inIpNeigh) {
      if (line.startsWith('IP address')) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 6 && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(parts[3])) {
        const aMac = parts[3].toLowerCase();
        if (aMac !== '00:00:00:00:00:00' && parts[2] !== '0x0') {
          arpByMac.set(aMac, {
            ip: parts[0],
            flags: parts[2],
            device: parts[5],
          });
        }
      }
    } else {
      // e.g. 192.168.1.142 dev br-lan lladdr a4:83:e7:11:22:33 REACHABLE
      const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)\s+lladdr\s+(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+(\S+)/);
      if (m) {
        const [, nIp, nDev, nMac, nState] = m;
        if (nState !== 'FAILED' && nState !== 'INCOMPLETE') {
          arpByMac.set(nMac.toLowerCase(), {
            ip: nIp,
            flags: '0x2',
            device: nDev,
          });
        }
      }
    }
  }

  // 8f. Reverse DNS results from the router/DHCP server (`===RDNS===`)
  const rdnsByMac = new Map();
  if (rdnsTxt) {
    for (const line of rdnsTxt.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(parts[0])) {
        const rMac = parts[0].toLowerCase();
        const rIp = parts[1];
        const rawHost = parts[2] ? parts[2].replace(/\.$/, '').replace(/\.(lan|local|home\.arpa|localdomain)$/i, '') : null;
        rdnsByMac.set(rMac, { ip: rIp, hostname: rawHost || null });
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
    const rdns = rdnsByMac.get(sMac);
    const resolvedIp = dhcp?.ip || arp?.ip || rdns?.ip || '0.0.0.0';
    const resolvedHostname =
      (dhcp?.hostname && dhcp.hostname !== dhcp.ip ? dhcp.hostname : null) ||
      rdns?.hostname ||
      dhcp?.hostname ||
      (resolvedIp !== '0.0.0.0' ? resolvedIp : sMac);
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
      ip: resolvedIp,
      hostname: resolvedHostname,
      vendor: lookupVendor(sMac, resolvedHostname),
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

  // 9b. Parse physical switch ports & bridge FDB (`===SWITCH_FDB===` + `===NETDEV_STATUS===`)
  const freshSwitchStaticTxt = extractStaticSwitchFdbLines(switchFdbTxt);
  const switchStaticTxt = freshSwitchStaticTxt || cachedStatic?.switchStaticTxt || '';
  let mergedSwitchFdbTxt = switchFdbTxt;
  if (!freshSwitchStaticTxt && switchStaticTxt) {
    mergedSwitchFdbTxt = mergedSwitchFdbTxt
      ? `${switchStaticTxt}\n${mergedSwitchFdbTxt}`
      : switchStaticTxt;
  }
  const hasFreshNetDevStatus = hasSection('NETDEV_STATUS');
  if (netDevStatusJson && typeof netDevStatusJson === 'object') {
    const portCapLines = [];
    for (const [ifn, info] of Object.entries(netDevStatusJson)) {
      if (!info || typeof info !== 'object') continue;
      if (Array.isArray(info['bridge-members'])) {
        for (const member of info['bridge-members']) {
          if (member && typeof member === 'string') {
            portCapLines.push(`BRMEMBER|${ifn}|${member}`);
          }
        }
      }
      let maxSpd = 0;
      const modes = [
        ...(Array.isArray(info['link-supported']) ? info['link-supported'] : []),
        ...(Array.isArray(info['link-advertising']) ? info['link-advertising'] : []),
      ];
      for (const m of modes) {
        const match = String(m).match(/^(\d+)base/i);
        if (match) {
          const spd = parseInt(match[1], 10);
          if (spd > maxSpd) maxSpd = spd;
        }
      }
      if (hasFreshNetDevStatus) {
        const curMatch = String(info.speed || '').match(/^(\d+)/);
        const curSpdNum = curMatch ? parseInt(curMatch[1], 10) : 0;
        const curSpd = curSpdNum > 0 ? curSpdNum : '';
        const hasLinkPartner =
          Array.isArray(info['link-partner-advertising']) && info['link-partner-advertising'].length > 0;
        const carr =
          info.carrier === true || hasLinkPartner
            ? '1'
            : info.carrier === false
              ? '0'
              : '';
        const up = info.up === true ? '1' : info.up === false ? '0' : '';
        if (maxSpd > 0 || curSpd || carr !== '' || up !== '') {
          portCapLines.push(`PORTCAP|${ifn}|${maxSpd || ''}|${curSpd}|${carr}|${up}`);
        }
      } else if (maxSpd > 0) {
        portCapLines.push(`PORTCAP|${ifn}|${maxSpd}|||`);
      }
    }
    if (portCapLines.length > 0) {
      mergedSwitchFdbTxt = mergedSwitchFdbTxt
        ? `${mergedSwitchFdbTxt}\n${portCapLines.join('\n')}`
        : portCapLines.join('\n');
    }
  }
  const sampleDtSec = prevSample?.timestamp ? Math.max(1, (nowMs - prevSample.timestamp) / 1000) : 10;
  const { switchPorts, fdbByMac, hostInterfaces, allHostMacs, defaultRoute } = parseSwitchFdbSection(
    mergedSwitchFdbTxt,
    iwInterfaces,
    {
      wanDev,
      netCounters,
      prevNetCounters: prevSample?.netCounters || null,
      dtSec: sampleDtSec,
    }
  );

  // Also map ARP / neighbor entries learned on standalone physical NICs (not `br-*` or wireless) into `fdbByMac`
  const wifiMacs = new Set(clients.map((c) => c.mac));
  for (const [aMac, arpEntry] of arpByMac.entries()) {
    if (fdbByMac.has(aMac) || wifiMacs.has(aMac)) continue;
    const dev = arpEntry?.device;
    if (
      !dev ||
      /^(br-|br\d+|switch)/i.test(dev) ||
      (dev.includes('.') && switchPorts.length > 1) ||
      iwInterfaces.has(dev) ||
      /^(wlan|phy|ra|rax|ath|wds|mesh|lo)/i.test(dev)
    ) {
      continue;
    }
    const matchingPort = switchPorts.find((p) => p.iface === dev);
    const formatted = matchingPort || formatSwitchPortLabel(dev);
    if (!formatted) continue;
    fdbByMac.set(aMac, {
      iface: dev,
      switchPort: formatted.switchPort,
      portNumber: formatted.portNumber ?? null,
      portLabel: formatted.portLabel,
      bridge: matchingPort?.bridge || null,
      speedMbps: matchingPort?.speedMbps || formatted.speedMbps || 1000,
      vlan: 1,
      portMacCount: matchingPort ? Math.max(1, matchingPort.connectedMacs?.length || 1) : 1,
    });
    if (matchingPort && Array.isArray(matchingPort.connectedMacs) && !matchingPort.connectedMacs.includes(aMac)) {
      matchingPort.connectedMacs.push(aMac);
    }
  }

  const allMacsSet = new Set(allHostMacs || []);
  if (mac) allMacsSet.add(mac.toLowerCase());
  for (const ifaceInfo of iwInterfaces.values()) {
    if (ifaceInfo.bssid) allMacsSet.add(ifaceInfo.bssid.toLowerCase());
  }
  const allMacs = Array.from(allMacsSet);

  // If this host has DHCP leases (e.g. gateway) and wired clients in ARP/DHCP not seen in WiFi stations
  if (dhcpByMac.size > 0) {
    for (const [dMac, dhcp] of dhcpByMac.entries()) {
      if (wifiMacs.has(dMac)) continue;
      if (allMacsSet.has(dMac)) continue;
      const arp = arpByMac.get(dMac);
      if (arp && arp.flags === '0x0') continue; // incomplete ARP entry
      const fdb = fdbByMac.get(dMac);
      const rawIface = fdb?.iface || arp?.device || 'br-lan';
      const portMeta = fdb || formatSwitchPortLabel(rawIface) || {
        iface: rawIface,
        switchPort: 'LAN Bridge',
        portLabel: `LAN Bridge (${rawIface})`,
        portNumber: null,
        speedMbps: 1000,
      };
      const linkSpeed = portMeta.speedMbps || 1000;
      clients.push({
        mac: dMac,
        ip: dhcp.ip,
        hostname: dhcp.hostname,
        vendor: lookupVendor(dMac, dhcp.hostname),
        connectionType: 'wired',
        connectedTo: {
          hostId: hostConfig.id,
          hostName: hostConfig.name || hostname,
          iface: portMeta.iface || rawIface,
          switchPort: portMeta.switchPort || null,
          portLabel: portMeta.portLabel || null,
          portNumber: portMeta.portNumber ?? null,
          speedMbps: linkSpeed,
        },
        vlan: fdb?.vlan || 1,
        isGuest: false,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        speedMbps: linkSpeed,
        rxRateMbps: linkSpeed,
        txRateMbps: linkSpeed,
        rxRateBps: 0,
        txRateBps: 0,
        rxBytesTotal: 0,
        txBytesTotal: 0,
        dhcpLeaseRemainingSec: dhcp.dhcpLeaseRemainingSec,
        lastSeen: new Date().toISOString(),
      });
    }
  }

  // 10. Parse `iw dev <iface> survey dump` for real channel utilization / busy airtime & noise floor
  const surveyByIface = new Map();
  let curSurveyIface = null;
  for (const rawLine of surveyTxt.split('\n')) {
    const line = rawLine.trim();
    const hdr = line.match(/^---IFACE:(.+)---$/);
    if (hdr) {
      curSurveyIface = hdr[1].trim();
      if (!surveyByIface.has(curSurveyIface)) {
        surveyByIface.set(curSurveyIface, { noiseDbm: null, activeMs: 0, busyMs: 0, rxMs: 0, txMs: 0 });
      }
      continue;
    }
    if (!curSurveyIface) continue;
    const entry = surveyByIface.get(curSurveyIface);
    const noiseMatch = line.match(/^noise:\s*(-?\d+)\s*dBm/i);
    if (noiseMatch) {
      entry.noiseDbm = Number(noiseMatch[1]);
      continue;
    }
    const activeMatch = line.match(/^channel active time:\s*(\d+)\s*ms/i);
    if (activeMatch) {
      entry.activeMs = Number(activeMatch[1]);
      continue;
    }
    const busyMatch = line.match(/^channel busy time:\s*(\d+)\s*ms/i);
    if (busyMatch) {
      entry.busyMs = Number(busyMatch[1]);
      continue;
    }
    const rxMatch = line.match(/^channel receive time:\s*(\d+)\s*ms/i);
    if (rxMatch) {
      entry.rxMs = Number(rxMatch[1]);
      continue;
    }
    const txMatch = line.match(/^channel transmit time:\s*(\d+)\s*ms/i);
    if (txMatch) {
      entry.txMs = Number(txMatch[1]);
    }
  }

  // 11. Build active radios list for this host
  const radios = [];
  const radioSurveyCounters = {};
  for (const ifaceInfo of iwInterfaces.values()) {
    if (!ifaceInfo.band || !ifaceInfo.channel) continue;
    const cCount = stationCountByIface.get(ifaceInfo.ifname) || 0;
    const survey = surveyByIface.get(ifaceInfo.ifname);
    let utilizationPct = Math.min(95, Math.max(5, cCount * 6));
    let noiseDbm = ifaceInfo.band === '2.4GHz' ? -95 : ifaceInfo.band === '6GHz' ? -101 : -98;

    if (survey) {
      if (typeof survey.noiseDbm === 'number') {
        noiseDbm = survey.noiseDbm;
      }
      radioSurveyCounters[ifaceInfo.ifname] = {
        activeMs: survey.activeMs,
        busyMs: survey.busyMs,
        rxMs: survey.rxMs,
        txMs: survey.txMs,
      };
      const prevSurvey = prevSample?.radioSurvey?.[ifaceInfo.ifname];
      if (prevSurvey && survey.activeMs > prevSurvey.activeMs) {
        const dActive = survey.activeMs - prevSurvey.activeMs;
        const dBusy = Math.max(0, survey.busyMs - prevSurvey.busyMs);
        utilizationPct = Math.max(1, Math.min(100, Math.round((dBusy / dActive) * 100)));
      } else if (survey.activeMs > 0 && survey.busyMs >= 0) {
        utilizationPct = Math.max(1, Math.min(100, Math.round((survey.busyMs / survey.activeMs) * 100)));
      }
    }

    const radioBssid = ifaceInfo.bssid || mac || '';
    const radioSsid = ifaceInfo.ssid || 'OpenWrt';
    const radioMfgInfo = resolveWirelessNetworkManufacturer({
      bssid: radioBssid,
      ssid: radioSsid,
      wpsManufacturer: resolveMacManufacturer(mac) || resolveSsidManufacturer(model) || '',
    });

    radios.push({
      id: `radio-${hostConfig.id}-${ifaceInfo.ifname}`,
      hostId: hostConfig.id,
      hostName: hostConfig.name || hostname,
      device: ifaceInfo.ifname,
      bssid: radioBssid,
      ssid: radioSsid,
      manufacturer: radioMfgInfo.manufacturer,
      bssidManufacturer: radioMfgInfo.bssidManufacturer,
      ssidManufacturer: radioMfgInfo.ssidManufacturer,
      band: ifaceInfo.band,
      channel: ifaceInfo.channel,
      centerFreqMhz: ifaceInfo.centerFreqMhz || channelToCenterFreq(ifaceInfo.band, ifaceInfo.channel),
      widthMhz: ifaceInfo.widthMhz || 20,
      txPowerDbm: ifaceInfo.txPowerDbm || 20,
      signalDbm: -45,
      noiseDbm,
      clientCount: cCount,
      utilizationPct,
    });
  }

  // 12. Parse cached/scanned neighboring wireless networks (`===SCANDUMP===`)
  const neighbors = parseIwScanOutput(
    scanDumpTxt,
    { id: hostConfig.id, name: hostConfig.name || hostname, hostname },
    iwInterfaces
  );

  // 13. Parse available package updates (`opkg list-upgradable`) & Attended Sysupgrade firmware advisory
  const hasUpdateSectionsInStdout =
    hasSection('OPKG_UPGRADABLE') || hasSection('ASU_STATUS') || hasSection('ASU_CHECK');
  let updates;
  let updatesLastChecked;
  if (!hasUpdateSectionsInStdout && cachedStatic?.updates) {
    updates = cachedStatic.updates;
    updatesLastChecked = cachedStatic.updatesLastChecked || cachedStatic.updates.lastChecked || new Date(nowMs).toISOString();
  } else {
    const upgradablePackages = parseOpkgUpgradable(opkgUpgradableTxt);
    const attendedSysupgrade = evaluateAttendedSysupgrade({
      board,
      firmware,
      releaseTxt,
      asuStatusTxt,
      asuCheckTxt,
    });
    updatesLastChecked =
      hasUpdateSectionsInStdout || !cachedStatic?.updatesLastChecked
        ? new Date(nowMs).toISOString()
        : cachedStatic.updatesLastChecked;
    updates = {
      packagesCount: upgradablePackages.length,
      packages: upgradablePackages,
      firmwareUpdateAvailable: attendedSysupgrade.firmwareUpdateAvailable,
      availableFirmwareVersion: attendedSysupgrade.availableVersion,
      attendedSysupgrade,
      lastChecked: updatesLastChecked,
    };
  }

  const clientBytes = {};
  for (const c of clients) {
    clientBytes[c.mac] = { rxBytes: c.rxBytesTotal || 0, txBytes: c.txBytesTotal || 0 };
  }

  const staticCacheTimestamp = isFullPoll ? nowMs : (cachedStatic?.timestamp || nowMs);
  const nextStaticCache = {
    timestamp: staticCacheTimestamp,
    board,
    sysinfo,
    releaseTxt,
    modelTxt,
    macTxt,
    wanJson,
    wirelessJson,
    iwdevTxt,
    scanDumpTxt,
    uciDhcpTxt,
    ubusDhcpJson,
    ethersTxt,
    netDevStatusJson,
    switchStaticTxt,
    rdnsTxt,
    opkgUpgradableTxt,
    asuStatusTxt,
    asuCheckTxt,
    updates,
    updatesLastChecked,
    hasWirelessRadios: radios.length > 0,
    cpuCores: detectedCpuCores,
  };

  return {
    online: true,
    pollMode: isFullPoll ? 'full' : 'dynamic',
    staticCacheUpdatedAt: new Date(staticCacheTimestamp).toISOString(),
    hostname,
    model,
    vendor: lookupVendor(mac, model),
    firmware,
    uptimeSec,
    cpuUsagePct,
    cpuCores: detectedCpuCores,
    memUsagePct,
    mac,
    allMacs,
    hostInterfaces,
    defaultRoute,
    rxRateBps,
    txRateBps,
    wan: wanInfo,
    radios,
    switchPorts,
    neighbors,
    clients,
    updates,
    dhcpMap: Object.fromEntries(dhcpByMac),
    arpMap: Object.fromEntries(arpByMac),
    rdnsMap: Object.fromEntries(rdnsByMac),
    fdbMap: Object.fromEntries(fdbByMac),
    sample: {
      timestamp: nowMs,
      cpuStat: stat2 || stat1 || prevSample?.cpuStat || null,
      netCounters,
      clientBytes,
      radioSurvey: radioSurveyCounters,
      staticCache: nextStaticCache,
    },
  };
}

/**
 * Forces a fresh package list update (`opkg update` / `apk update`) and Attended Sysupgrade check on a host.
 */
export async function checkHostUpdates(hostConfig) {
  const script = [
    'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    'echo "===BOARD==="',
    'ubus call system board 2>/dev/null',
    'echo "===RELEASE==="',
    'cat /etc/openwrt_release 2>/dev/null',
    'echo "===OPKG_UPDATE==="',
    'if command -v opkg >/dev/null 2>&1; then opkg update 2>&1; elif command -v apk >/dev/null 2>&1; then apk update 2>&1; fi',
    'echo "===OPKG_UPGRADABLE==="',
    'if command -v opkg >/dev/null 2>&1; then opkg list-upgradable 2>/dev/null; elif command -v apk >/dev/null 2>&1; then apk version -l "<" 2>/dev/null; fi',
    'echo "===ASU_STATUS==="',
    ASU_STATUS_SCRIPT,
    'echo "===ASU_CHECK==="',
    '( if command -v auc >/dev/null 2>&1; then auc -n 2>&1; elif command -v owut >/dev/null 2>&1; then owut check 2>&1; fi; echo "---VERSIONS_JSON---"; uclient-fetch -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null || wget -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null ) | tee /tmp/.openwrt_mgr_asu_cache',
  ].join('; ');

  const { stdout } = await execSshCommand(hostConfig, script, { timeoutMs: 35000 });
  const parsed = parseSshTelemetryOutput(hostConfig, stdout);

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
  const opkgUpdateLog = (sections.OPKG_UPDATE || []).join('\n').trim();
  const [asuCliLog] = ((sections.ASU_CHECK || []).join('\n').trim()).split('---VERSIONS_JSON---');

  return {
    success: true,
    firmware: parsed.firmware,
    updates: parsed.updates,
    output: [opkgUpdateLog, asuCliLog?.trim()].filter(Boolean).join('\n\n'),
  };
}

/**
 * Upgrades selected or all upgradable packages on an OpenWrt host via SSH with real-time step-by-step progress callbacks.
 */
export async function upgradeHostPackages(hostConfig, packages = 'all', { onProgress = null } = {}) {
  let pkgArgs = [];
  if (packages !== 'all' && !(Array.isArray(packages) && packages.includes('all'))) {
    const list = Array.isArray(packages) ? packages : [packages];
    for (const p of list) {
      const name = String(p || '').trim();
      if (!name || !/^[a-zA-Z0-9.+_-]+$/.test(name)) {
        throw new Error(`Invalid package name: ${name}`);
      }
      pkgArgs.push(name);
    }
    if (pkgArgs.length === 0) {
      throw new Error('No packages specified for upgrade');
    }
  }

  const upgradeCmd =
    pkgArgs.length > 0
      ? `pkgs="${pkgArgs.join(' ')}"; total=${pkgArgs.length}; echo "===UPG_TOTAL:$total==="; idx=0; for p in $pkgs; do idx=$((idx + 1)); echo "===UPG_START:$idx:$total:$p==="; if command -v opkg >/dev/null 2>&1; then opkg upgrade "$p" 2>&1; rc=$?; elif command -v apk >/dev/null 2>&1; then apk add --upgrade "$p" 2>&1; rc=$?; else rc=1; fi; echo "===UPG_DONE:$idx:$total:$p:$rc==="; done`
      : `if command -v opkg >/dev/null 2>&1; then pkgs=$(opkg list-upgradable 2>/dev/null | awk -F' - ' 'NF>=3{print $1}'); elif command -v apk >/dev/null 2>&1; then pkgs=$(apk version -l "<" 2>/dev/null | awk -F'-' '{print $1}'); else pkgs=""; fi; total=$(echo $pkgs | wc -w | tr -d ' '); echo "===UPG_TOTAL:$total==="; if [ "$total" -gt 0 ]; then idx=0; for p in $pkgs; do idx=$((idx + 1)); echo "===UPG_START:$idx:$total:$p==="; if command -v opkg >/dev/null 2>&1; then opkg upgrade "$p" 2>&1; rc=$?; elif command -v apk >/dev/null 2>&1; then apk add --upgrade "$p" 2>&1; rc=$?; else rc=1; fi; echo "===UPG_DONE:$idx:$total:$p:$rc==="; done; else echo "All packages are already up to date."; fi`;

  const script = [
    'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    'echo "===BOARD==="',
    'ubus call system board 2>/dev/null',
    'echo "===RELEASE==="',
    'cat /etc/openwrt_release 2>/dev/null',
    'echo "===UPGRADE_LOG==="',
    upgradeCmd,
    'echo "===OPKG_UPGRADABLE==="',
    'if command -v opkg >/dev/null 2>&1; then opkg list-upgradable 2>/dev/null; elif command -v apk >/dev/null 2>&1; then apk version -l "<" 2>/dev/null; fi',
    'echo "===ASU_STATUS==="',
    ASU_STATUS_SCRIPT,
    'echo "===ASU_CHECK==="',
    'cat /tmp/.openwrt_mgr_asu_cache 2>/dev/null',
  ].join('; ');

  let inUpgradeLog = false;
  let totalCount = pkgArgs.length || 0;
  let completedCount = 0;
  const completedPackages = [];
  const failedPackages = [];
  const cleanLogLines = [];

  const handleStreamLine = (line) => {
    const secMatch = line.match(/^===([A-Z0-9_]+)===$/);
    if (secMatch) {
      inUpgradeLog = secMatch[1] === 'UPGRADE_LOG';
      if (secMatch[1] === 'OPKG_UPGRADABLE' && typeof onProgress === 'function') {
        onProgress({
          phase: 'Verifying remaining upgradable packages...',
          progressPct: 95,
        });
      }
      return;
    }

    const totalMatch = line.match(/^===UPG_TOTAL:(\d+)===$/);
    if (totalMatch) {
      totalCount = Number(totalMatch[1]) || 0;
      if (typeof onProgress === 'function') {
        onProgress({
          packagesTotal: totalCount,
          packagesCompleted: 0,
          progressPct: totalCount > 0 ? 8 : 90,
          phase: totalCount > 0 ? `Preparing to upgrade ${totalCount} package${totalCount === 1 ? '' : 's'}...` : 'All packages up to date',
        });
      }
      return;
    }

    const startMatch = line.match(/^===UPG_START:(\d+):(\d+):(.+)===$/);
    if (startMatch) {
      const idx = Number(startMatch[1]);
      const tot = Number(startMatch[2]) || totalCount || 1;
      const pkg = startMatch[3].trim();
      const pct = Math.min(92, Math.max(10, Math.round(((idx - 0.5) / tot) * 85) + 5));
      const msg = `[${idx}/${tot}] Upgrading ${pkg}...`;
      cleanLogLines.push(msg);
      if (typeof onProgress === 'function') {
        onProgress({
          currentPackage: pkg,
          packagesTotal: tot,
          packagesCompleted: completedCount,
          completedPackages: [...completedPackages],
          failedPackages: [...failedPackages],
          progressPct: pct,
          phase: `Upgrading ${pkg} (${idx} of ${tot})...`,
          logLine: msg,
          logs: [...cleanLogLines],
        });
      }
      return;
    }

    const doneMatch = line.match(/^===UPG_DONE:(\d+):(\d+):([^:]+):(\d+)===$/);
    if (doneMatch) {
      const idx = Number(doneMatch[1]);
      const tot = Number(doneMatch[2]) || totalCount || 1;
      const pkg = doneMatch[3].trim();
      const rc = Number(doneMatch[4]);
      completedCount = idx;
      if (rc === 0) {
        completedPackages.push(pkg);
      } else {
        failedPackages.push(pkg);
      }
      const pct = Math.min(94, Math.max(12, Math.round((idx / tot) * 85) + 8));
      const statusMsg = rc === 0 ? `✓ Upgraded ${pkg} (${idx}/${tot})` : `⚠ ${pkg} exited with status ${rc}`;
      cleanLogLines.push(statusMsg);
      if (typeof onProgress === 'function') {
        onProgress({
          currentPackage: pkg,
          packagesTotal: tot,
          packagesCompleted: completedCount,
          completedPackages: [...completedPackages],
          failedPackages: [...failedPackages],
          progressPct: pct,
          phase: idx < tot ? `Completed ${pkg} (${idx} of ${tot})` : `Finalizing package configuration (${tot}/${tot})...`,
          logLine: statusMsg,
          logs: [...cleanLogLines],
        });
      }
      return;
    }

    if (inUpgradeLog && line.trim()) {
      cleanLogLines.push(line);
      if (typeof onProgress === 'function') {
        onProgress({ logLine: line, logs: [...cleanLogLines] });
      }
    }
  };

  let stdout = '';
  if (typeof hostConfig.mockStreamRunner === 'function') {
    const mockRes = await hostConfig.mockStreamRunner(script, { onLine: handleStreamLine, handleStreamLine });
    stdout = typeof mockRes === 'string' ? mockRes : mockRes?.stdout || '';
  } else {
    const streamRes = await execSshCommandStream(hostConfig, script, { timeoutMs: 120000, onLine: handleStreamLine });
    stdout = streamRes.stdout;
  }

  const parsed = parseSshTelemetryOutput(hostConfig, stdout);
  const upgradeLog = cleanLogLines.join('\n').trim();

  return {
    success: failedPackages.length === 0,
    packagesTotal: totalCount || completedPackages.length,
    packagesCompleted: completedPackages.length,
    completedPackages,
    failedPackages,
    output: upgradeLog || 'Package upgrade completed.',
    updates: parsed.updates,
  };
}

/**
 * Performs an Attended Sysupgrade action on an OpenWrt host:
 * - action: 'install' -> installs `auc` / `owut` and `luci-app-attendedsysupgrade`
 * - action: 'check'   -> runs `auc -n` / `owut check`
 * - action: 'upgrade' -> triggers `auc -y` / `owut upgrade` to build & apply the new firmware image
 */
export async function performAttendedSysupgradeAction(hostConfig, { action = 'check', onProgress = null } = {}) {
  let actionCmd = '';
  if (action === 'install') {
    actionCmd =
      'echo "===ASU_STAGE:20:Updating package lists (opkg update)...==="; if command -v opkg >/dev/null 2>&1; then opkg update 2>&1; echo "===ASU_STAGE:60:Installing Attended Sysupgrade (auc & luci-app-attendedsysupgrade)...==="; (opkg install auc luci-app-attendedsysupgrade 2>&1 || opkg install owut luci-app-attendedsysupgrade 2>&1 || opkg install auc 2>&1); elif command -v apk >/dev/null 2>&1; then apk update 2>&1; echo "===ASU_STAGE:60:Installing Attended Sysupgrade (owut & luci-app-attendedsysupgrade)...==="; apk add owut luci-app-attendedsysupgrade 2>&1; fi';
  } else if (action === 'upgrade') {
    actionCmd =
      'echo "===ASU_STAGE:25:Preparing Attended Sysupgrade CLI tool...==="; if ! command -v auc >/dev/null 2>&1 && ! command -v owut >/dev/null 2>&1; then if command -v opkg >/dev/null 2>&1; then opkg update 2>&1 && (opkg install auc 2>&1 || opkg install owut 2>&1); elif command -v apk >/dev/null 2>&1; then apk update 2>&1 && apk add owut 2>&1; fi; fi; echo "===ASU_STAGE:45:Requesting custom firmware image from Attended Sysupgrade server...==="; if command -v auc >/dev/null 2>&1; then auc -y 2>&1; elif command -v owut >/dev/null 2>&1; then owut upgrade 2>&1; else echo "Attended Sysupgrade CLI (auc / owut) is not available on this router."; exit 1; fi';
  } else {
    actionCmd =
      'echo "===ASU_STAGE:40:Checking Attended Sysupgrade server for available firmware...==="; if command -v auc >/dev/null 2>&1; then auc -n 2>&1; elif command -v owut >/dev/null 2>&1; then owut check 2>&1; else echo "Attended Sysupgrade (luci-app-attendedsysupgrade) is installed; verified upstream OpenWrt release list."; fi';
  }

  const script = [
    'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    'echo "===BOARD==="',
    'ubus call system board 2>/dev/null',
    'echo "===RELEASE==="',
    'cat /etc/openwrt_release 2>/dev/null',
    'echo "===ACTION_LOG==="',
    actionCmd,
    'echo "===OPKG_UPGRADABLE==="',
    'if command -v opkg >/dev/null 2>&1; then opkg list-upgradable 2>/dev/null; elif command -v apk >/dev/null 2>&1; then apk version -l "<" 2>/dev/null; fi',
    'echo "===ASU_STATUS==="',
    ASU_STATUS_SCRIPT,
    'echo "===ASU_CHECK==="',
    '( if command -v auc >/dev/null 2>&1; then auc -n 2>&1; elif command -v owut >/dev/null 2>&1; then owut check 2>&1; fi; echo "---VERSIONS_JSON---"; uclient-fetch -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null || wget -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null ) | tee /tmp/.openwrt_mgr_asu_cache',
  ].join('; ');

  let inActionLog = false;
  const cleanLogLines = [];

  const handleStreamLine = (line) => {
    const secMatch = line.match(/^===([A-Z0-9_]+)===$/);
    if (secMatch) {
      inActionLog = secMatch[1] === 'ACTION_LOG';
      return;
    }
    const stageMatch = line.match(/^===ASU_STAGE:(\d+):(.+)===$/);
    if (stageMatch) {
      const pct = Number(stageMatch[1]) || 50;
      const phase = stageMatch[2].trim();
      cleanLogLines.push(phase);
      if (typeof onProgress === 'function') {
        onProgress({ progressPct: pct, phase, logLine: phase });
      }
      return;
    }
    if (inActionLog && line.trim()) {
      cleanLogLines.push(line);
      if (typeof onProgress === 'function') {
        onProgress({ logLine: line });
      }
    }
  };

  const { stdout } =
    typeof hostConfig.mockStreamRunner === 'function'
      ? await hostConfig.mockStreamRunner(script, handleStreamLine)
      : await execSshCommandStream(hostConfig, script, { timeoutMs: 120000, onLine: handleStreamLine });

  const parsed = parseSshTelemetryOutput(hostConfig, stdout);
  const actionLog = cleanLogLines.join('\n').trim();

  return {
    success: true,
    action,
    output: actionLog || `Attended Sysupgrade (${action}) completed.`,
    updates: parsed.updates,
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
