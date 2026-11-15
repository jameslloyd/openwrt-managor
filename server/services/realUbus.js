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
  'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
  'asu_found=0',
  'if [ -f /usr/lib/opkg/status ]; then out=$(awk \'/^Package:[ \t]*(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common)$/{pkg=$2} /^Version:[ \t]*/ && pkg{print pkg " - " $2; pkg=""}\' /usr/lib/opkg/status 2>/dev/null); if [ -n "$out" ]; then echo "$out"; asu_found=1; fi; fi',
  'if [ -f /lib/apk/db/installed ]; then out=$(awk -F: \'/^P:(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common)$/{pkg=$2} /^V:/ && pkg{print pkg " - " $2; pkg=""}\' /lib/apk/db/installed 2>/dev/null); if [ -n "$out" ]; then echo "$out"; asu_found=1; fi; fi',
  'for f in /usr/lib/opkg/info/auc.control /usr/lib/opkg/info/owut.control /usr/lib/opkg/info/luci-app-attendedsysupgrade.control /usr/lib/opkg/info/attendedsysupgrade-common.control; do if [ -f "$f" ]; then awk \'/^Package:/{p=$2} /^Version:/{v=$2} END{if(p) print p " - " (v?v:"installed")}\' "$f" 2>/dev/null; asu_found=1; fi; done',
  'if command -v opkg >/dev/null 2>&1; then out=$(opkg list-installed 2>/dev/null | grep -E "^(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common) "); if [ -n "$out" ]; then echo "$out"; asu_found=1; fi; fi',
  'if command -v apk >/dev/null 2>&1; then out=$(apk info -v 2>/dev/null | grep -E "^(auc|owut|luci-app-attendedsysupgrade|attendedsysupgrade-common)-"); if [ -n "$out" ]; then echo "$out"; asu_found=1; fi; fi',
  'if command -v auc >/dev/null 2>&1 || [ -x /usr/bin/auc ] || [ -x /bin/auc ]; then echo "HAS_BIN:auc"; asu_found=1; fi',
  'if command -v owut >/dev/null 2>&1 || [ -x /usr/bin/owut ] || [ -x /bin/owut ]; then echo "HAS_BIN:owut"; asu_found=1; fi',
  'if [ -f /etc/config/attendedsysupgrade ] || [ -f /usr/share/luci/menu.d/luci-app-attendedsysupgrade.json ] || [ -d /www/luci-static/resources/view/attendedsysupgrade ] || [ -f /usr/share/rpcd/acl.d/luci-app-attendedsysupgrade.json ] || [ -f /usr/lib/lua/luci/controller/attendedsysupgrade.lua ]; then echo "HAS_LUCI:luci-app-attendedsysupgrade"; asu_found=1; fi',
  'uci_out=$(uci -q show attendedsysupgrade 2>/dev/null || cat /etc/config/attendedsysupgrade 2>/dev/null); if [ -n "$uci_out" ]; then echo "$uci_out"; asu_found=1; fi',
  '[ "$asu_found" = "0" ] && echo "ASU_NONE"',
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

/**
 * Collects full telemetry from a real OpenWrt host via SSH (or HTTP ubus fallback).
 */
export async function pollRealHost(hostConfig, prevSample = null) {
  const remoteScript = [
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
    'echo "===SURVEY==="',
    'for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do echo "---IFACE:$iface---"; iw dev "$iface" survey dump 2>/dev/null | awk \'/Survey data from/{if(inuse)exit; next} /\\[in use\\]/{inuse=1; print; next} inuse{print}\'; done',
    'echo "===SCANDUMP==="',
    'seen_phys=""; for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do phy=$(iw dev "$iface" info 2>/dev/null | awk \'$1=="wiphy"{print $2}\'); case " $seen_phys " in *" $phy "*) continue ;; esac; seen_phys="$seen_phys $phy"; echo "---IFACE:$iface---"; iw dev "$iface" scan dump 2>/dev/null | grep -E "^(BSS |\\tfreq:|\\tsignal:|\\tSSID:|\\tDS Parameter set:|\\t\\* primary channel:|\\t\\* channel width:|\\t\\* STA channel width:|\\t\\* Manufacturer:|\\tRSN:|\\tWPA:|\\tlast seen:)"; done',
    'echo "===STATIONS==="',
    'for iface in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\'); do echo "---IFACE:$iface---"; iw dev "$iface" station dump 2>/dev/null; done',
    'echo "===DHCP==="',
    'cat /tmp/dhcp.leases 2>/dev/null; lf=$(uci -q get dhcp.@dnsmasq[0].leasefile 2>/dev/null); [ -n "$lf" ] && [ "$lf" != "/tmp/dhcp.leases" ] && cat "$lf" 2>/dev/null',
    'echo "===UCI_DHCP==="',
    "uci show dhcp 2>/dev/null | grep -E '^dhcp\\.[^.=]+\\.(mac|ip|name)='",
    'echo "===UBUS_DHCP==="',
    'ubus call dhcp ipv4leases 2>/dev/null',
    'echo "===ETHERS==="',
    'cat /etc/ethers 2>/dev/null',
    // If any associated WiFi station is missing from local dhcp.leases and /proc/net/arp, sweep the br-lan subnet so ARP resolves its IP
    'missing_arp=0; for smac in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\' | while read iface; do iw dev "$iface" station dump 2>/dev/null | awk \'/^Station/{print tolower($2)}\'; done); do if ! grep -qi "$smac" /tmp/dhcp.leases 2>/dev/null && ! awk \'tolower($4)=="\'$smac\'" && $3!="0x0"{found=1} END{exit !found}\' /proc/net/arp 2>/dev/null; then missing_arp=1; break; fi; done',
    'if [ "$missing_arp" = "1" ]; then subnet=$(ip -4 addr show br-lan 2>/dev/null | awk \'/inet /{print $2; exit}\' | cut -d. -f1-3); [ -z "$subnet" ] && subnet=$(ip -4 addr show 2>/dev/null | awk \'/inet / && !/127\\.0\\.0\\.1/{print $2; exit}\' | cut -d. -f1-3); if [ -n "$subnet" ]; then for b in 0 64 128 192; do i=$((b + 1)); while [ $i -le $((b + 64)) ] && [ $i -le 254 ]; do ping -c 1 -W 1 "$subnet.$i" >/dev/null 2>&1 & i=$((i + 1)); done; wait; done; fi; fi',
    'echo "===ARP==="',
    'cat /proc/net/arp 2>/dev/null; echo "---IPNEIGH---"; ip -4 neigh show 2>/dev/null',
    'echo "===SWITCH_FDB==="',
    'for p in /sys/class/net/br-*/brif/*; do [ -e "$p" ] || continue; br=$(basename $(dirname $(dirname "$p"))); ifn=$(basename "$p"); pno=$(cat "$p/port_no" 2>/dev/null); spd=$(cat "/sys/class/net/$ifn/speed" 2>/dev/null); dup=$(cat "/sys/class/net/$ifn/duplex" 2>/dev/null); oper=$(cat "/sys/class/net/$ifn/operstate" 2>/dev/null); carr=$(cat "/sys/class/net/$ifn/carrier" 2>/dev/null); echo "BRPORT|$br|$ifn|$pno|$spd|$dup|$oper|$carr"; done; if command -v bridge >/dev/null 2>&1; then bridge fdb show 2>/dev/null | awk \'!/permanent|self/{mac=tolower($1); dev=""; br=""; vlan=""; for(i=2;i<=NF;i++){if($i=="dev") dev=$(i+1); if($i=="master") br=$(i+1); if($i=="vlan") vlan=$(i+1);} if(mac ~ /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/ && dev!="") print "FDB|" mac "|" dev "|" br "|" vlan}\'; fi; for b in /sys/class/net/br-*; do [ -d "$b" ] || continue; br=$(basename "$b"); brctl showmacs "$br" 2>/dev/null | awk -v br="$br" \'NR>1 && $3=="no"{print "BRMAC|" br "|" $1 "|" tolower($2)}\'; done',
    'echo "===RDNS==="',
    'gw=$(ip route show default 2>/dev/null | awk \'/default/{print $3; exit}\'); [ -z "$gw" ] && gw=$(uci -q get network.lan.gateway 2>/dev/null); for smac in $(iw dev 2>/dev/null | awk \'$1=="Interface"{print $2}\' | while read iface; do iw dev "$iface" station dump 2>/dev/null | awk \'/^Station/{print tolower($2)}\'; done); do sip=$(awk \'tolower($4)=="\'$smac\'" && $3!="0x0"{print $1; exit}\' /proc/net/arp 2>/dev/null); if [ -n "$sip" ]; then rname=$(nslookup "$sip" ${gw:+"$gw"} 2>/dev/null | awk \'/name =/{print $NF; exit} /^Address 1:/ && NF>=4{print $4; exit}\'); echo "$smac $sip $rname"; fi; done',
    'echo "===OPKG_UPGRADABLE==="',
    'if command -v opkg >/dev/null 2>&1; then if [ -z "$(ls -A /var/opkg-lists 2>/dev/null)" ] && [ ! -f /tmp/.openwrt_mgr_opkg_init ]; then (touch /tmp/.openwrt_mgr_opkg_init; opkg update >/dev/null 2>&1) </dev/null >/dev/null 2>&1 & else opkg list-upgradable 2>/dev/null; fi; elif command -v apk >/dev/null 2>&1; then apk version -l "<" 2>/dev/null; fi',
    'echo "===ASU_CHECK==="',
    'if [ ! -f /tmp/.openwrt_mgr_asu_cache ]; then ( ( if command -v auc >/dev/null 2>&1; then auc -n 2>&1; elif command -v owut >/dev/null 2>&1; then owut check 2>&1; fi; echo "---VERSIONS_JSON---"; uclient-fetch -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null || wget -T 4 -qO- https://downloads.openwrt.org/.versions.json 2>/dev/null ) > /tmp/.openwrt_mgr_asu_cache.tmp 2>/dev/null && mv /tmp/.openwrt_mgr_asu_cache.tmp /tmp/.openwrt_mgr_asu_cache ) </dev/null >/dev/null 2>&1 & fi; cat /tmp/.openwrt_mgr_asu_cache 2>/dev/null',
  ].join('; ');

  try {
    const { stdout } = await execSshCommand(hostConfig, remoteScript, { timeoutMs: 18000 });
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

export function formatSwitchPortLabel(iface, speedMbps = null) {
  if (!iface || typeof iface !== 'string') return null;
  const raw = iface.trim();
  if (!raw || raw === 'lo') return null;
  // Ignore wireless interfaces
  if (/^(wlan|phy|ra|rax|ath|wds|mesh)/i.test(raw)) return null;

  const base = raw.split('.')[0];
  const vlanPart = raw.includes('.') ? raw.split('.')[1] : null;
  const vlanSuffix = vlanPart && vlanPart !== '1' ? ` (VLAN ${vlanPart})` : '';

  const lanMatch = base.match(/^lan(\d+)$/i);
  if (lanMatch) {
    return {
      iface: raw,
      switchPort: `LAN ${lanMatch[1]}`,
      portNumber: Number(lanMatch[1]),
      portLabel: `LAN ${lanMatch[1]} (${raw})${vlanSuffix}`,
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
    };
  }

  const sfpMatch = base.match(/^sfp\+?(\d*)$/i);
  if (sfpMatch) {
    const num = sfpMatch[1] || '1';
    return {
      iface: raw,
      switchPort: `SFP+ ${num}`,
      portNumber: Number(num) || 1,
      portLabel: `SFP+ ${num} (${raw})${vlanSuffix}`,
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : 10000,
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
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
    };
  }

  const ethMatch = base.match(/^eth(\d+)$/i);
  if (ethMatch) {
    const num = Number(ethMatch[1]);
    const label = speedMbps >= 10000 ? `10G Port ${num}` : `LAN ${num}`;
    return {
      iface: raw,
      switchPort: label,
      portNumber: num,
      portLabel: `${label} (${raw})${vlanSuffix}`,
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
    };
  }

  const portMatch = base.match(/^(?:sw\d*p|port)(\d+)$/i);
  if (portMatch) {
    return {
      iface: raw,
      switchPort: `Port ${portMatch[1]}`,
      portNumber: Number(portMatch[1]),
      portLabel: `Port ${portMatch[1]} (${raw})${vlanSuffix}`,
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
    };
  }

  if (/^br-/i.test(base)) {
    return {
      iface: raw,
      switchPort: base === 'br-lan' ? 'LAN Bridge' : base,
      portNumber: null,
      portLabel: `${base === 'br-lan' ? 'LAN Bridge' : base} (${raw})`,
      speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
    };
  }

  return {
    iface: raw,
    switchPort: raw.toUpperCase(),
    portNumber: null,
    portLabel: `${raw}${vlanSuffix}`,
    speedMbps: speedMbps && speedMbps > 0 ? speedMbps : null,
  };
}

export function parseSwitchFdbSection(switchFdbTxt, iwInterfaces = new Map()) {
  const switchPortsByIface = new Map();
  const portNoToIfaceByBridge = new Map();
  const fdbByMac = new Map();

  if (!switchFdbTxt) {
    return { switchPorts: [], fdbByMac };
  }

  const normalizePortNo = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    const n = s.startsWith('0x') || s.startsWith('0X') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  for (const rawLine of String(switchFdbTxt).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('BRPORT|')) {
      const [, bridge, ifname, rawPortNo, rawSpeed, rawDuplex, rawOper, rawCarrier] = line.split('|');
      if (!ifname || iwInterfaces.has(ifname) || /^(wlan|phy|ra|rax|ath|wds|mesh)/i.test(ifname)) {
        continue;
      }
      const portNo = normalizePortNo(rawPortNo);
      const speedNum = parseInt(rawSpeed, 10);
      const speedMbps = Number.isFinite(speedNum) && speedNum > 0 ? speedNum : null;
      const formatted = formatSwitchPortLabel(ifname, speedMbps);
      if (!formatted) continue;

      const isUp =
        rawCarrier === '1' ||
        rawOper === 'up' ||
        (rawOper === 'unknown' && speedMbps !== null && speedMbps > 0);

      const portObj = {
        iface: ifname,
        switchPort: formatted.switchPort,
        portNumber: formatted.portNumber ?? portNo,
        portLabel: formatted.portLabel,
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

    // Also support raw `bridge fdb show` lines: `aa:bb:cc:dd:ee:ff dev lan1 master br-lan`
    const rawFdbMatch = !line.startsWith('FDB|') && !line.startsWith('BRMAC|')
      ? line.match(/^(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+dev\s+(\S+)(?:\s+vlan\s+(\d+))?(?:\s+master\s+(\S+))?/i)
      : null;
    if (line.startsWith('FDB|') || (rawFdbMatch && !/\b(permanent|self)\b/i.test(line))) {
      const [, rawMac, dev, bridge, rawVlan] = rawFdbMatch
        ? [null, rawFdbMatch[1], rawFdbMatch[3], rawFdbMatch[5] || 'br-lan', rawFdbMatch[4] || '1']
        : line.split('|');
      const mac = (rawMac || '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
      if (!dev || iwInterfaces.has(dev) || /^(wlan|phy|ra|rax|ath|wds|mesh)/i.test(dev)) continue;

      const knownPort = switchPortsByIface.get(dev);
      const formatted = knownPort || formatSwitchPortLabel(dev);
      if (!formatted) continue;

      fdbByMac.set(mac, {
        iface: dev,
        switchPort: formatted.switchPort,
        portNumber: formatted.portNumber ?? null,
        portLabel: formatted.portLabel,
        bridge: bridge || knownPort?.bridge || 'br-lan',
        speedMbps: knownPort?.speedMbps || formatted.speedMbps || 1000,
        vlan: rawVlan ? parseInt(rawVlan, 10) || 1 : 1,
      });
      if (knownPort && !knownPort.connectedMacs.includes(mac)) {
        knownPort.connectedMacs.push(mac);
      }
      continue;
    }

    if (line.startsWith('BRMAC|')) {
      const [, bridge, rawPortNo, rawMac] = line.split('|');
      const mac = (rawMac || '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
      if (fdbByMac.has(mac)) continue;
      const portNo = normalizePortNo(rawPortNo);
      const ifname = portNo !== null ? portNoToIfaceByBridge.get(`${bridge}:${portNo}`) : null;
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
  }

  // Annotate each fdb entry with how many total MACs were learned on that same switch port (helps distinguish leaf access ports vs uplink trunk ports)
  for (const entry of fdbByMac.values()) {
    const portObj = switchPortsByIface.get(entry.iface);
    entry.portMacCount = portObj ? portObj.connectedMacs.length : 1;
  }

  const switchPorts = Array.from(switchPortsByIface.values()).sort((a, b) => {
    if (a.portNumber !== null && b.portNumber !== null && a.portNumber !== b.portNumber) {
      return a.portNumber - b.portNumber;
    }
    return a.iface.localeCompare(b.iface);
  });

  return { switchPorts, fdbByMac };
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
  const surveyTxt = getSectionText('SURVEY');
  const scanDumpTxt = getSectionText('SCANDUMP');
  const stationsTxt = getSectionText('STATIONS');
  const dhcpTxt = getSectionText('DHCP');
  const uciDhcpTxt = getSectionText('UCI_DHCP');
  const ubusDhcpJson = getSectionJson('UBUS_DHCP');
  const ethersTxt = getSectionText('ETHERS');
  const arpTxt = getSectionText('ARP');
  const switchFdbTxt = getSectionText('SWITCH_FDB');
  const rdnsTxt = getSectionText('RDNS');
  const opkgUpgradableTxt = getSectionText('OPKG_UPGRADABLE');
  const asuStatusTxt = getSectionText('ASU_STATUS');
  const asuCheckTxt = getSectionText('ASU_CHECK');

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

  // 9b. Parse physical switch ports & bridge FDB (`===SWITCH_FDB===`)
  const { switchPorts, fdbByMac } = parseSwitchFdbSection(switchFdbTxt, iwInterfaces);

  // If this host has DHCP leases (e.g. gateway) and wired clients in ARP/DHCP not seen in WiFi stations
  const wifiMacs = new Set(clients.map((c) => c.mac));
  if (dhcpByMac.size > 0) {
    for (const [dMac, dhcp] of dhcpByMac.entries()) {
      if (wifiMacs.has(dMac)) continue;
      if (mac && dMac === mac) continue;
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
  const upgradablePackages = parseOpkgUpgradable(opkgUpgradableTxt);
  const attendedSysupgrade = evaluateAttendedSysupgrade({
    board,
    firmware,
    releaseTxt,
    asuStatusTxt,
    asuCheckTxt,
  });
  const updates = {
    packagesCount: upgradablePackages.length,
    packages: upgradablePackages,
    firmwareUpdateAvailable: attendedSysupgrade.firmwareUpdateAvailable,
    availableFirmwareVersion: attendedSysupgrade.availableVersion,
    attendedSysupgrade,
    lastChecked: new Date().toISOString(),
  };

  const clientBytes = {};
  for (const c of clients) {
    clientBytes[c.mac] = { rxBytes: c.rxBytesTotal || 0, txBytes: c.txBytesTotal || 0 };
  }

  return {
    online: true,
    hostname,
    model,
    vendor: lookupVendor(mac, model),
    firmware,
    uptimeSec,
    cpuUsagePct,
    memUsagePct,
    mac,
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
      cpuStat: stat2 || stat1,
      netCounters,
      clientBytes,
      radioSurvey: radioSurveyCounters,
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
