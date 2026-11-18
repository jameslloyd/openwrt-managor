import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../storage/db.js';
import { hostManager } from './hostManager.js';
import { clientEngine } from './clientEngine.js';
import { analyzeInterference } from './wifiEngine.js';
import { backupEngine } from './backupEngine.js';

function formatUptimeHuman(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

/**
 * Resolves a host by ID, display name, hostname, IP address, or MAC address (case-insensitive).
 */
export async function resolveHostByIdentifier(identifier) {
  if (!identifier) return null;
  const raw = decodeURIComponent(String(identifier)).trim();
  const needle = raw.toLowerCase();
  const hosts = await hostManager.getAllHosts();

  // 1. Exact match on id, ip, mac, name, or hostname
  let match = hosts.find(
    (h) =>
      (h.id && h.id.toLowerCase() === needle) ||
      (h.ip && h.ip.toLowerCase() === needle) ||
      (h.mac && h.mac.toLowerCase() === needle) ||
      (h.name && h.name.toLowerCase() === needle) ||
      (h.hostname && h.hostname.toLowerCase() === needle)
  );
  if (match) return match;

  // 2. Normalized slug / substring match on name or hostname (e.g., "living-room-ap" -> "Living Room AP")
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const needleSlug = slugify(needle);
  match = hosts.find(
    (h) =>
      (h.name && (h.name.toLowerCase().includes(needle) || slugify(h.name) === needleSlug)) ||
      (h.hostname && (h.hostname.toLowerCase().includes(needle) || slugify(h.hostname) === needleSlug))
  );
  return match || null;
}

/**
 * Enriches a sanitized host object with live connected clients, backups, and human-readable status fields for agents.
 */
export function buildAgentHostPayload(host, allClients = [], allBackups = []) {
  const hostClients = allClients.filter((c) => c.connectedTo?.hostId === host.id);
  const wifiClients = hostClients.filter((c) => c.connectionType === 'wifi');
  const wiredClients = hostClients.filter((c) => c.connectionType === 'wired');
  const hostBackups = allBackups.filter((b) => b.hostId === host.id);
  const latestBackup = hostBackups.length > 0 ? hostBackups[0] : null;

  const updates = host.updates || {};
  const packages = Array.isArray(updates.packages) ? updates.packages : [];
  const securityPackagesCount = packages.filter((p) => p.isSecurityOrCore).length;
  const asu = updates.attendedSysupgrade || {};
  const firmwareUpdateAvailable = Boolean(updates.firmwareUpdateAvailable || asu.firmwareUpdateAvailable);
  const availableFirmwareVersion = updates.availableFirmwareVersion || asu.availableVersion || null;

  return {
    id: host.id,
    name: host.name || host.hostname,
    hostname: host.hostname || host.name,
    ip: host.ip,
    mac: host.mac || null,
    vendor: host.vendor || 'Unknown Manufacturer',
    model: host.model || 'OpenWrt Device',
    role: host.role || 'ap',
    protocol: host.protocol || 'ssh',
    status: host.status || 'offline',
    online: host.status === 'online',
    firmware: host.firmware || 'OpenWrt',
    uptimeSec: host.uptimeSec || 0,
    uptimeFormatted: formatUptimeHuman(host.uptimeSec || 0),
    metrics: {
      cpuUsagePct: host.cpuUsagePct ?? 0,
      cpuCores: host.cpuCores ?? null,
      pollIntervalMs: host.pollIntervalMs ?? null,
      memUsagePct: host.memUsagePct ?? 0,
      rxRateBps: host.rxRateBps ?? 0,
      txRateBps: host.txRateBps ?? 0,
      clientCount: host.clientCount ?? hostClients.length,
      wirelessClientCount: wifiClients.length,
      wiredClientCount: wiredClients.length,
    },
    wan: host.wan || null,
    radios: Array.isArray(host.radios) ? host.radios : [],
    updates: {
      packagesCount: packages.length,
      securityPackagesCount,
      packages,
      firmwareUpdateAvailable,
      availableFirmwareVersion,
      attendedSysupgrade: asu,
      lastChecked: updates.lastChecked || null,
    },
    activeUpgradeJob: host.activeUpgradeJob || hostManager.getUpgradeJobForHost(host.id) || null,
    latestBackup: latestBackup
      ? {
          id: latestBackup.id,
          filename: latestBackup.filename,
          timestamp: latestBackup.timestamp,
          sizeBytes: latestBackup.sizeBytes,
          type: latestBackup.type,
        }
      : null,
    backupsCount: hostBackups.length,
    lastSeen: host.lastSeen || null,
  };
}

/**
 * Builds the comprehensive fleet status snapshot for Hermes and external AI/monitoring agents.
 */
export async function buildFleetAgentStatus() {
  const [hosts, clients, backups, schedules, settings] = await Promise.all([
    hostManager.getAllHosts(),
    clientEngine.getClients(),
    backupEngine.listBackups(),
    db.getSchedules(),
    db.getSettings(),
  ]);

  const bands = hostManager.getLiveWifiBands();
  const wifiAnalysis = analyzeInterference(bands);
  const upgradeJobs = hostManager.getAllUpgradeJobs();
  const activeUpgradeJobs = upgradeJobs.filter((j) => j.status === 'running');

  const agentHosts = hosts.map((h) => buildAgentHostPayload(h, clients, backups));

  const hostsOnline = agentHosts.filter((h) => h.online).length;
  const hostsOffline = agentHosts.length - hostsOnline;
  const wirelessClientsTotal = clients.filter((c) => c.connectionType === 'wifi').length;
  const wiredClientsTotal = clients.filter((c) => c.connectionType === 'wired').length;
  const packageUpdatesPendingTotal = agentHosts.reduce((acc, h) => acc + (h.updates?.packagesCount || 0), 0);
  const securityUpdatesPendingTotal = agentHosts.reduce((acc, h) => acc + (h.updates?.securityPackagesCount || 0), 0);
  const hostsWithFirmwareUpdates = agentHosts.filter((h) => h.updates?.firmwareUpdateAvailable);

  const cpuThreshold = settings?.alerts?.highCpuThresholdPct || 85;
  const memThreshold = settings?.alerts?.highMemoryThresholdPct || 90;

  // Build actionable alerts list for Hermes / monitoring agents
  const alerts = [];
  for (const h of agentHosts) {
    if (!h.online) {
      alerts.push({
        severity: 'critical',
        type: 'host_offline',
        hostId: h.id,
        hostName: h.name,
        ip: h.ip,
        message: `OpenWrt host "${h.name}" (${h.ip}) is offline.`,
      });
    } else {
      if (h.metrics.cpuUsagePct >= cpuThreshold) {
        alerts.push({
          severity: 'warning',
          type: 'high_cpu',
          hostId: h.id,
          hostName: h.name,
          valuePct: h.metrics.cpuUsagePct,
          message: `High CPU utilization (${h.metrics.cpuUsagePct}%) on "${h.name}" (${h.ip}).`,
        });
      }
      if (h.metrics.memUsagePct >= memThreshold) {
        alerts.push({
          severity: 'warning',
          type: 'high_memory',
          hostId: h.id,
          hostName: h.name,
          valuePct: h.metrics.memUsagePct,
          message: `High RAM utilization (${h.metrics.memUsagePct}%) on "${h.name}" (${h.ip}).`,
        });
      }
    }

    if (h.updates.firmwareUpdateAvailable) {
      alerts.push({
        severity: 'info',
        type: 'firmware_update_available',
        hostId: h.id,
        hostName: h.name,
        currentFirmware: h.firmware,
        availableVersion: h.updates.availableFirmwareVersion,
        message: h.updates.attendedSysupgrade?.advisory || `New OpenWrt firmware ${h.updates.availableFirmwareVersion} is available for "${h.name}".`,
      });
    }

    if (h.updates.packagesCount > 0) {
      alerts.push({
        severity: h.updates.securityPackagesCount > 0 ? 'warning' : 'info',
        type: 'package_updates_available',
        hostId: h.id,
        hostName: h.name,
        packagesCount: h.updates.packagesCount,
        securityPackagesCount: h.updates.securityPackagesCount,
        message: `"${h.name}" has ${h.updates.packagesCount} upgradable package(s)${h.updates.securityPackagesCount > 0 ? ` (${h.updates.securityPackagesCount} core/security)` : ''}.`,
      });
    }
  }

  for (const w of wifiAnalysis.warnings || []) {
    alerts.push({
      severity: w.severity === 'high' ? 'warning' : 'info',
      type: 'wifi_congestion',
      band: w.band,
      channel: w.channel,
      message: w.description || w.title,
    });
  }

  let overallHealth = 'healthy';
  if (hostsOffline > 0) {
    overallHealth = 'degraded';
  } else if (alerts.some((a) => a.severity === 'warning')) {
    overallHealth = 'warning';
  }

  const textSummaryParts = [
    `${hostsOnline} of ${agentHosts.length} OpenWrt host(s) online`,
    `${clients.length} active client(s) (${wirelessClientsTotal} WiFi, ${wiredClientsTotal} wired)`,
  ];
  if (packageUpdatesPendingTotal > 0) {
    textSummaryParts.push(`${packageUpdatesPendingTotal} package update(s) available`);
  }
  if (hostsWithFirmwareUpdates.length > 0) {
    textSummaryParts.push(
      `firmware upgrade available on ${hostsWithFirmwareUpdates.map((h) => `${h.name} (-> ${h.updates.availableFirmwareVersion})`).join(', ')}`
    );
  }
  if (activeUpgradeJobs.length > 0) {
    textSummaryParts.push(`${activeUpgradeJobs.length} background upgrade job(s) currently running`);
  }

  return {
    timestamp: new Date().toISOString(),
    version: config.appVersion,
    summary: {
      overallHealth,
      textSummary: `${textSummaryParts.join('; ')}.`,
      hostsTotal: agentHosts.length,
      hostsOnline,
      hostsOffline,
      activeClientsTotal: clients.length,
      wirelessClientsTotal,
      wiredClientsTotal,
      packageUpdatesPendingTotal,
      securityUpdatesPendingTotal,
      firmwareUpdatesAvailableCount: hostsWithFirmwareUpdates.length,
      activeUpgradeJobsCount: activeUpgradeJobs.length,
      wifiHealthScore: wifiAnalysis.summary?.healthScore ?? 100,
      wifiWarningsCount: wifiAnalysis.warnings?.length ?? 0,
      backupsTotal: backups.length,
      lastBackupAt: backups[0]?.timestamp || null,
    },
    alerts,
    hosts: agentHosts,
    activeUpgradeJobs,
    wifi: {
      healthScore: wifiAnalysis.summary?.healthScore ?? 100,
      status: wifiAnalysis.summary?.status || 'healthy',
      warningsCount: wifiAnalysis.warnings?.length ?? 0,
      warnings: wifiAnalysis.warnings || [],
      bands: Object.fromEntries(
        Object.entries(bands).map(([bandName, b]) => [
          bandName,
          {
            activeRadiosCount: b.radios?.length || 0,
            neighborNetworksCount: b.neighbors?.length || 0,
            noiseFloorDbm: b.noiseFloorDbm,
          },
        ])
      ),
    },
    backups: {
      totalArchives: backups.length,
      latestTimestamp: backups[0]?.timestamp || null,
      schedules: schedules || [],
    },
  };
}

/**
 * Generates or retrieves the Agent API settings.
 */
export async function getAgentApiConfig() {
  const settings = (await db.getSettings()) || {};
  const agentApi = settings.agentApi || {
    enabled: true,
    requireApiKey: false,
    apiKey: '',
  };
  return agentApi;
}

export function generateAgentApiKey() {
  return `owrt_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Verifies API key authentication if `settings.agentApi.requireApiKey` is enabled.
 */
export async function verifyAgentRequestAuth(req, searchParams) {
  const agentApi = await getAgentApiConfig();
  if (agentApi.enabled === false) {
    return { allowed: false, statusCode: 403, message: 'Agent REST API is disabled in settings', code: 'AGENT_API_DISABLED' };
  }
  if (!agentApi.requireApiKey || !agentApi.apiKey) {
    return { allowed: true };
  }

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  const queryKey = searchParams?.get('api_key') || searchParams?.get('apiKey') || '';
  const provided = bearerToken || apiKeyHeader || queryKey;

  if (!provided || provided !== agentApi.apiKey) {
    return {
      allowed: false,
      statusCode: 401,
      message: 'Valid API key required via Authorization: Bearer <key> or X-API-Key header',
      code: 'UNAUTHORIZED',
    };
  }
  return { allowed: true };
}

/**
 * Returns the Hermes / MCP / Function-Calling Tool Manifest and OpenAPI 3.1.0 specification.
 */
export function getAgentToolManifest(baseUrl = 'http://localhost:3030') {
  return {
    schemaVersion: '1.0',
    nameForHuman: 'OpenWrt Manager Fleet API',
    nameForModel: 'openwrt_manager',
    descriptionForModel:
      'Query real-time status, CPU/RAM/uptime telemetry, wireless clients, RF spectrum congestion, backups, and available software/firmware updates across all managed OpenWrt routers and access points.',
    openapiUrl: `${baseUrl}/api/openapi.json`,
    endpoints: {
      fleetStatus: `${baseUrl}/api/agent/status`,
      listHosts: `${baseUrl}/api/agent/hosts`,
      getHostByIdOrName: `${baseUrl}/api/agent/hosts/{idOrName}`,
      pollHostNow: `${baseUrl}/api/agent/hosts/{idOrName}/poll`,
      listClients: `${baseUrl}/api/agent/clients`,
      getUpdates: `${baseUrl}/api/agent/updates`,
      getWifiSpectrum: `${baseUrl}/api/agent/wifi`,
    },
    tools: [
      {
        name: 'get_openwrt_fleet_status',
        description:
          'Returns a complete status summary of all OpenWrt hosts, online/offline counts, CPU/RAM metrics, active clients, WiFi health, alerts, and pending software/firmware updates.',
        method: 'GET',
        path: '/api/agent/status',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'list_openwrt_hosts',
        description:
          'Lists all registered OpenWrt hosts with optional filtering by search query (name, IP, MAC, model), status (online/offline), role (gateway/ap), or pending updates.',
        method: 'GET',
        path: '/api/agent/hosts',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Filter by host name, hostname, IP address, MAC, or model' },
            status: { type: 'string', enum: ['online', 'offline'], description: 'Filter by online/offline status' },
            role: { type: 'string', enum: ['gateway', 'ap', 'mesh', 'switch'], description: 'Filter by device role' },
            updates: { type: 'boolean', description: 'If true, only return hosts with pending package or firmware updates' },
          },
        },
      },
      {
        name: 'get_openwrt_host_status',
        description:
          'Returns detailed telemetry, connected WiFi/wired clients, radios, package updates, Attended Sysupgrade firmware advisories, and backups for a specific OpenWrt host by ID, name, hostname, IP, or MAC.',
        method: 'GET',
        path: '/api/agent/hosts/{idOrName}',
        parameters: {
          type: 'object',
          required: ['idOrName'],
          properties: {
            idOrName: { type: 'string', description: 'Host ID, display name, hostname, IP address, or MAC address' },
            refresh: { type: 'boolean', description: 'Set to true to force a live SSH poll before returning' },
          },
        },
      },
      {
        name: 'poll_openwrt_host',
        description: 'Forces an immediate live SSH telemetry poll on a specific OpenWrt host (or "all" hosts) and returns updated status.',
        method: 'POST',
        path: '/api/agent/hosts/{idOrName}/poll',
        parameters: {
          type: 'object',
          required: ['idOrName'],
          properties: {
            idOrName: { type: 'string', description: 'Host ID, display name, IP address, or "all"' },
          },
        },
      },
      {
        name: 'list_openwrt_clients',
        description: 'Lists connected wireless and wired clients across the OpenWrt fleet with IP, MAC, hostname, manufacturer, and WiFi signal strength.',
        method: 'GET',
        path: '/api/agent/clients',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search by hostname, IP, MAC, or manufacturer' },
            host: { type: 'string', description: 'Filter by OpenWrt host ID, name, or IP' },
            type: { type: 'string', enum: ['wifi', 'wired'], description: 'Filter by connection type' },
          },
        },
      },
      {
        name: 'get_openwrt_updates_status',
        description: 'Returns available opkg/apk package updates, Attended Sysupgrade firmware advisories, and active background upgrade jobs across all OpenWrt hosts.',
        method: 'GET',
        path: '/api/agent/updates',
        parameters: { type: 'object', properties: {} },
      },
    ],
  };
}

export function getOpenApiSpec(baseUrl = 'http://localhost:3030') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenWrt Manager — Hermes & Agent REST API',
      version: config.appVersion,
      description:
        'REST API for Hermes, AI agents, and automation systems to query OpenWrt host status, telemetry, connected clients, RF spectrum health, backups, and software/firmware updates.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/api/agent/status': {
        get: {
          operationId: 'getFleetStatus',
          summary: 'Get complete OpenWrt fleet status snapshot and actionable alerts',
          responses: {
            200: { description: 'Complete fleet summary, alerts, hosts status, WiFi health, and active upgrade jobs' },
          },
        },
      },
      '/api/agent/hosts': {
        get: {
          operationId: 'listHostsStatus',
          summary: 'List all OpenWrt hosts and their live status',
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'Search by name, hostname, IP, MAC, or model' },
            { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['online', 'offline'] } },
            { name: 'role', in: 'query', required: false, schema: { type: 'string', enum: ['gateway', 'ap', 'mesh', 'switch'] } },
            { name: 'updates', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Filter to hosts with available updates' },
          ],
          responses: {
            200: { description: 'List of OpenWrt hosts with telemetry and update status' },
          },
        },
      },
      '/api/agent/hosts/{idOrName}': {
        get: {
          operationId: 'getHostStatus',
          summary: 'Get detailed status of a single OpenWrt host by ID, name, hostname, IP, or MAC',
          parameters: [
            { name: 'idOrName', in: 'path', required: true, schema: { type: 'string' }, description: 'Host ID, name, hostname, IP address, or MAC' },
            { name: 'refresh', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Force a live SSH poll before returning' },
          ],
          responses: {
            200: { description: 'Detailed host status, connected clients, radios, updates, and backups' },
            404: { description: 'Host not found' },
          },
        },
      },
      '/api/agent/hosts/{idOrName}/poll': {
        post: {
          operationId: 'pollHostStatus',
          summary: 'Trigger an immediate live SSH poll for a specific OpenWrt host or "all"',
          parameters: [
            { name: 'idOrName', in: 'path', required: true, schema: { type: 'string' }, description: 'Host ID, name, IP, or "all"' },
          ],
          responses: {
            200: { description: 'Updated host telemetry after live poll' },
          },
        },
      },
      '/api/agent/clients': {
        get: {
          operationId: 'listClientsStatus',
          summary: 'List connected wireless and wired clients across all OpenWrt hosts',
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'host', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['wifi', 'wired'] } },
          ],
          responses: {
            200: { description: 'Connected clients with DHCP IPs, manufacturers, and signal metrics' },
          },
        },
      },
      '/api/agent/updates': {
        get: {
          operationId: 'getFleetUpdatesStatus',
          summary: 'Get pending package updates, Attended Sysupgrade firmware advisories, and background upgrade jobs',
          responses: {
            200: { description: 'Fleet software & firmware update status' },
          },
        },
      },
      '/api/agent/wifi': {
        get: {
          operationId: 'getWifiSpectrumStatus',
          summary: 'Get WiFi spectrum congestion analysis, radios, and triangulated neighboring networks',
          responses: {
            200: { description: 'RF spectrum health and radio telemetry' },
          },
        },
      },
    },
  };
}
