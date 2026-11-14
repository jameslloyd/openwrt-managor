import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../storage/db.js';
import { hostManager } from '../services/hostManager.js';
import { topologyEngine } from '../services/topologyEngine.js';
import { clientEngine } from '../services/clientEngine.js';
import { simulator } from '../services/simulator.js';
import { analyzeInterference } from '../services/wifiEngine.js';
import { backupEngine } from '../services/backupEngine.js';
import {
  resolveHostByIdentifier,
  buildAgentHostPayload,
  buildFleetAgentStatus,
  generateAgentApiKey,
  verifyAgentRequestAuth,
  getAgentToolManifest,
  getOpenApiSpec,
} from '../services/agentApi.js';

const startTime = Date.now();

// Helper to read JSON request body with DoS/OOM protection
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let destroyed = false;
    req.on('data', (chunk) => {
      if (destroyed) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        // 5MB max
        destroyed = true;
        req.destroy();
        const err = new Error('Payload too large (max 5MB)');
        err.statusCode = 413;
        reject(err);
      }
    });
    req.on('end', () => {
      if (destroyed) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        const jsonErr = new Error('Invalid JSON');
        jsonErr.statusCode = 400;
        reject(jsonErr);
      }
    });
    req.on('error', (err) => {
      if (!destroyed) reject(err);
    });
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  });
  res.end(payload);
}

function sendError(res, statusCode, message, code = 'ERROR') {
  sendJson(res, statusCode, {
    error: true,
    message,
    code,
  });
}

/**
 * Main API request dispatcher
 */
export async function handleApiRequest(req, res, pathname, searchParams) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    });
    res.end();
    return true;
  }

  try {
    // -------------------------------------------------------------
    // Hermes & External Agent REST API (/api/agent/*, /api/v1/*, /api/openapi.json)
    // -------------------------------------------------------------
    const reqProto = req.headers['x-forwarded-proto'] || 'http';
    const reqHost = req.headers.host || `localhost:${config.port}`;
    const originBaseUrl = `${reqProto}://${reqHost}`;

    if ((pathname === '/api/openapi.json' || pathname === '/api/v1/openapi.json') && req.method === 'GET') {
      sendJson(res, 200, getOpenApiSpec(originBaseUrl));
      return true;
    }

    if ((pathname === '/api/agent/manifest' || pathname === '/api/v1/agent/manifest') && req.method === 'GET') {
      sendJson(res, 200, getAgentToolManifest(originBaseUrl));
      return true;
    }

    if (pathname.startsWith('/api/agent/') || pathname.startsWith('/api/v1/')) {
      const authCheck = await verifyAgentRequestAuth(req, searchParams);
      if (!authCheck.allowed) {
        sendError(res, authCheck.statusCode || 401, authCheck.message, authCheck.code || 'UNAUTHORIZED');
        return true;
      }

      // Normalize /api/v1/* and /api/agent/* subpaths
      const subPath = pathname.startsWith('/api/agent/')
        ? pathname.slice('/api/agent'.length)
        : pathname.slice('/api/v1'.length);

      // GET /api/agent/status | /api/v1/status | /api/v1/fleet/status
      if ((subPath === '/status' || subPath === '/fleet/status') && req.method === 'GET') {
        if (searchParams.get('refresh') === 'true') {
          await hostManager.pollAllHosts();
        }
        const statusPayload = await buildFleetAgentStatus();
        sendJson(res, 200, statusPayload);
        return true;
      }

      // GET /api/agent/hosts | /api/v1/hosts
      if (subPath === '/hosts' && req.method === 'GET') {
        if (searchParams.get('refresh') === 'true') {
          await hostManager.pollAllHosts();
        }
        const [hosts, clients, backups] = await Promise.all([
          hostManager.getAllHosts(),
          clientEngine.getClients(),
          backupEngine.listBackups(),
        ]);
        const q = (searchParams.get('q') || '').trim().toLowerCase();
        const statusFilter = (searchParams.get('status') || '').trim().toLowerCase();
        const roleFilter = (searchParams.get('role') || '').trim().toLowerCase();
        const updatesFilter = searchParams.get('updates') === 'true';

        let items = hosts.map((h) => buildAgentHostPayload(h, clients, backups));
        if (q) {
          items = items.filter(
            (h) =>
              (h.name && h.name.toLowerCase().includes(q)) ||
              (h.hostname && h.hostname.toLowerCase().includes(q)) ||
              (h.ip && h.ip.toLowerCase().includes(q)) ||
              (h.mac && h.mac.toLowerCase().includes(q)) ||
              (h.model && h.model.toLowerCase().includes(q)) ||
              (h.vendor && h.vendor.toLowerCase().includes(q))
          );
        }
        if (statusFilter === 'online' || statusFilter === 'offline') {
          items = items.filter((h) => h.status === statusFilter);
        }
        if (roleFilter) {
          items = items.filter((h) => (h.role || '').toLowerCase() === roleFilter);
        }
        if (updatesFilter) {
          items = items.filter((h) => h.updates.packagesCount > 0 || h.updates.firmwareUpdateAvailable);
        }

        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          count: items.length,
          onlineCount: items.filter((h) => h.online).length,
          offlineCount: items.filter((h) => !h.online).length,
          hosts: items,
        });
        return true;
      }

      // POST /api/agent/hosts/:idOrName/poll | /api/v1/hosts/:idOrName/poll
      const agentHostPollMatch = subPath.match(/^\/hosts\/([^/]+)\/poll$/);
      if (agentHostPollMatch && req.method === 'POST') {
        const idOrName = decodeURIComponent(agentHostPollMatch[1]);
        if (idOrName.toLowerCase() === 'all') {
          await hostManager.pollAllHosts();
          const statusPayload = await buildFleetAgentStatus();
          sendJson(res, 200, { polled: 'all', ...statusPayload });
          return true;
        }
        const resolved = await resolveHostByIdentifier(idOrName);
        if (!resolved) {
          sendError(res, 404, `OpenWrt host "${idOrName}" not found`, 'HOST_NOT_FOUND');
          return true;
        }
        const freshHost = (await hostManager.pollSingleHost(resolved.id)) || resolved;
        const [clients, backups] = await Promise.all([clientEngine.getClients(), backupEngine.listBackups()]);
        const payload = buildAgentHostPayload(freshHost, clients, backups);
        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          polled: true,
          host: payload,
          clients: clients.filter((c) => c.connectedTo?.hostId === freshHost.id),
        });
        return true;
      }

      // GET /api/agent/hosts/:idOrName | /api/v1/hosts/:idOrName
      const agentHostMatch = subPath.match(/^\/hosts\/([^/]+)$/);
      if (agentHostMatch && req.method === 'GET') {
        const idOrName = decodeURIComponent(agentHostMatch[1]);
        let resolved = await resolveHostByIdentifier(idOrName);
        if (!resolved) {
          sendError(res, 404, `OpenWrt host "${idOrName}" not found`, 'HOST_NOT_FOUND');
          return true;
        }
        if (searchParams.get('refresh') === 'true') {
          resolved = (await hostManager.pollSingleHost(resolved.id)) || resolved;
        }
        const [clients, backups] = await Promise.all([clientEngine.getClients(), backupEngine.listBackups()]);
        const hostPayload = buildAgentHostPayload(resolved, clients, backups);
        const hostClients = clients.filter((c) => c.connectedTo?.hostId === resolved.id);
        const hostBackups = backups.filter((b) => b.hostId === resolved.id);

        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          host: hostPayload,
          clients: hostClients,
          backups: hostBackups,
        });
        return true;
      }

      // GET /api/agent/clients | /api/v1/clients
      if (subPath === '/clients' && req.method === 'GET') {
        const q = searchParams.get('q') || '';
        const type = searchParams.get('type') || '';
        const hostParam = searchParams.get('host') || searchParams.get('hostId') || '';
        let resolvedHostId = '';
        if (hostParam) {
          const matchedHost = await resolveHostByIdentifier(hostParam);
          resolvedHostId = matchedHost ? matchedHost.id : hostParam;
        }
        const clients = await clientEngine.getClients({ q, hostId: resolvedHostId, type });
        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          count: clients.length,
          wifiCount: clients.filter((c) => c.connectionType === 'wifi').length,
          wiredCount: clients.filter((c) => c.connectionType === 'wired').length,
          clients,
        });
        return true;
      }

      // GET /api/agent/updates | /api/v1/updates
      if (subPath === '/updates' && req.method === 'GET') {
        const hosts = await hostManager.getAllHosts();
        const jobs = hostManager.getAllUpgradeJobs();
        const hostUpdates = hosts.map((h) => ({
          hostId: h.id,
          hostName: h.name || h.hostname,
          ip: h.ip,
          online: h.status === 'online',
          firmware: h.firmware,
          packagesCount: h.updates?.packagesCount || 0,
          packages: h.updates?.packages || [],
          firmwareUpdateAvailable: Boolean(h.updates?.firmwareUpdateAvailable),
          availableFirmwareVersion: h.updates?.availableFirmwareVersion || null,
          attendedSysupgrade: h.updates?.attendedSysupgrade || null,
          activeUpgradeJob: h.activeUpgradeJob || null,
          lastChecked: h.updates?.lastChecked || null,
        }));
        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          packagesPendingTotal: hostUpdates.reduce((acc, h) => acc + h.packagesCount, 0),
          firmwareUpdatesAvailableCount: hostUpdates.filter((h) => h.firmwareUpdateAvailable).length,
          activeJobsCount: jobs.filter((j) => j.status === 'running').length,
          hosts: hostUpdates,
          jobs,
        });
        return true;
      }

      // GET /api/agent/wifi | /api/v1/wifi
      if (subPath === '/wifi' && req.method === 'GET') {
        await hostManager.getAllHosts();
        const bands = hostManager.getLiveWifiBands();
        const analysis = analyzeInterference(bands);
        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          healthScore: analysis.summary?.healthScore ?? 100,
          status: analysis.summary?.status || 'healthy',
          warningsCount: analysis.warnings?.length ?? 0,
          warnings: analysis.warnings || [],
          bands,
        });
        return true;
      }
    }

    // -------------------------------------------------------------
    // System & Health APIs
    // -------------------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      const dataDirOk = fs.existsSync(config.dataDir);
      const backupDirOk = fs.existsSync(config.backupDir);
      const hosts = await hostManager.getAllHosts();

      sendJson(res, 200, {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor((Date.now() - startTime) / 1000),
        version: config.appVersion,
        demoMode: config.demoMode,
        hostsCount: hosts.length,
        storage: {
          dataDirOk,
          backupDirOk,
          dataDir: config.dataDir,
          backupDir: config.backupDir,
        },
      });
      return true;
    }

    if (pathname === '/api/system/info' && req.method === 'GET') {
      const mem = process.memoryUsage();
      sendJson(res, 200, {
        app: 'OpenWrt Manager',
        version: config.appVersion,
        nodeVersion: process.version,
        platform: process.platform,
        memoryUsage: {
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
        },
        dataDir: config.dataDir,
        backupDir: config.backupDir,
      });
      return true;
    }

    if (pathname === '/api/settings/agent-key/regenerate' && req.method === 'POST') {
      const current = (await db.getSettings()) || {};
      const newKey = generateAgentApiKey();
      const updated = {
        ...current,
        agentApi: {
          enabled: true,
          requireApiKey: current.agentApi?.requireApiKey ?? false,
          ...(current.agentApi || {}),
          apiKey: newKey,
        },
      };
      await db.saveSettings(updated);
      sendJson(res, 200, { apiKey: newKey, agentApi: updated.agentApi });
      return true;
    }

    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const settings = (await db.getSettings()) || {};
        if (!settings.agentApi) {
          settings.agentApi = { enabled: true, requireApiKey: false, apiKey: '' };
        }
        sendJson(res, 200, settings);
        return true;
      }
      if (req.method === 'PUT') {
        const body = await parseJsonBody(req);
        const current = (await db.getSettings()) || {};
        const mergedAgentApi = {
          enabled: true,
          requireApiKey: false,
          apiKey: '',
          ...(current.agentApi || {}),
          ...(body.agentApi || {}),
        };
        if (mergedAgentApi.requireApiKey && !mergedAgentApi.apiKey) {
          mergedAgentApi.apiKey = generateAgentApiKey();
        }
        const updated = {
          ...current,
          ...body,
          retention: { ...current.retention, ...(body.retention || {}) },
          alerts: { ...current.alerts, ...(body.alerts || {}) },
          agentApi: mergedAgentApi,
        };
        await db.saveSettings(updated);

        // Keep primary backup schedule retention in sync with settings
        if (updated.retention?.maxBackupsPerHost) {
          const schedules = (await db.getSchedules()) || [];
          if (schedules.length > 0) {
            schedules[0].retentionMaxBackups = Number(updated.retention.maxBackupsPerHost);
            await db.saveSchedules(schedules);
          }
          await backupEngine.applyAllRetention();
        }

        sendJson(res, 200, updated);
        return true;
      }
    }

    // -------------------------------------------------------------
    // Hosts CRUD & Testing APIs
    // -------------------------------------------------------------
    if (pathname === '/api/hosts/test' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const testResult = await hostManager.testHost(body);
      sendJson(res, 200, testResult);
      return true;
    }

    if (pathname === '/api/hosts' && req.method === 'GET') {
      const hosts = await hostManager.getAllHosts();
      sendJson(res, 200, hosts);
      return true;
    }

    if (pathname === '/api/hosts' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.ip || typeof body.ip !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(body.ip)) {
        sendError(res, 400, 'Valid host IP or hostname is required', 'INVALID_FIELD');
        return true;
      }
      if (body.id && (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(body.id))) {
        sendError(res, 400, 'Host ID must contain only alphanumeric characters, dashes, and underscores', 'INVALID_ID');
        return true;
      }
      if (body.port && (typeof body.port !== 'number' || body.port < 1 || body.port > 65535)) {
        sendError(res, 400, 'Port must be an integer between 1 and 65535', 'INVALID_PORT');
        return true;
      }
      if (body.username && (typeof body.username !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(body.username))) {
        sendError(res, 400, 'Invalid username format', 'INVALID_USERNAME');
        return true;
      }
      const newHost = await hostManager.createHost(body);
      sendJson(res, 201, newHost);
      return true;
    }

    // Dynamic Host routes: /api/hosts/updates/jobs, /api/hosts/updates/check, /api/hosts/:id/updates/*, /api/hosts/:id, /api/hosts/:id/test
    if (pathname === '/api/hosts/updates/jobs' && req.method === 'GET') {
      const activeOnly = searchParams.get('activeOnly') === 'true';
      const jobs = hostManager.getAllUpgradeJobs({ activeOnly });
      sendJson(res, 200, { jobs });
      return true;
    }

    const jobByIdMatch = pathname.match(/^\/api\/hosts\/updates\/jobs\/([^/]+)$/);
    if (jobByIdMatch && req.method === 'GET') {
      const jobId = jobByIdMatch[1];
      const job = hostManager.getUpgradeJob(jobId);
      if (!job) {
        sendError(res, 404, `Upgrade job ${jobId} not found`, 'JOB_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, { job });
      return true;
    }

    if (pathname === '/api/hosts/updates/check' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body && body.hostId && body.hostId !== 'all') {
        const resSingle = await hostManager.checkUpdatesForHost(body.hostId);
        if (!resSingle) {
          sendError(res, 404, `Host ${body.hostId} not found`, 'HOST_NOT_FOUND');
          return true;
        }
        sendJson(res, 200, resSingle);
        return true;
      }
      const resAll = await hostManager.checkUpdatesForAllHosts();
      sendJson(res, 200, resAll);
      return true;
    }

    const hostUpdatesJobMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/updates\/job$/);
    if (hostUpdatesJobMatch && req.method === 'GET') {
      const hostId = hostUpdatesJobMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, {
        hostId: host.id,
        job: host.activeUpgradeJob || hostManager.getUpgradeJobForHost(hostId),
      });
      return true;
    }

    const hostUpdatesGetMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/updates$/);
    if (hostUpdatesGetMatch && req.method === 'GET') {
      const hostId = hostUpdatesGetMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, {
        hostId: host.id,
        hostName: host.name || host.hostname,
        firmware: host.firmware,
        updates: host.updates,
        activeUpgradeJob: host.activeUpgradeJob || hostManager.getUpgradeJobForHost(hostId),
      });
      return true;
    }

    const hostUpdatesCheckMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/updates\/check$/);
    if (hostUpdatesCheckMatch && req.method === 'POST') {
      const hostId = hostUpdatesCheckMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      const checkRes = await hostManager.checkUpdatesForHost(hostId);
      sendJson(res, 200, checkRes);
      return true;
    }

    const hostUpdatesUpgradeMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/updates\/upgrade$/);
    if (hostUpdatesUpgradeMatch && req.method === 'POST') {
      const hostId = hostUpdatesUpgradeMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      const body = await parseJsonBody(req);
      const packages = body?.packages || 'all';
      const upgradeRes = await hostManager.upgradePackagesForHost(hostId, packages);
      sendJson(res, 200, upgradeRes);
      return true;
    }

    const hostAsuMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/updates\/attended-sysupgrade$/);
    if (hostAsuMatch && req.method === 'POST') {
      const hostId = hostAsuMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      const body = await parseJsonBody(req);
      const action = ['check', 'install', 'upgrade'].includes(body?.action) ? body.action : 'check';
      const asuRes = await hostManager.attendedSysupgradeForHost(hostId, { action });
      sendJson(res, 200, asuRes);
      return true;
    }

    const hostTestMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/test$/);
    if (hostTestMatch && req.method === 'POST') {
      const hostId = hostTestMatch[1];
      const host = await hostManager.getHost(hostId);
      if (!host) {
        sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
        return true;
      }
      const testResult = await hostManager.testHost(host);
      sendJson(res, 200, testResult);
      return true;
    }

    const hostMatch = pathname.match(/^\/api\/hosts\/([^/]+)$/);
    if (hostMatch) {
      const hostId = hostMatch[1];
      if (req.method === 'GET') {
        const host = await hostManager.getHost(hostId);
        if (!host) {
          sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
          return true;
        }
        sendJson(res, 200, host);
        return true;
      }
      if (req.method === 'PUT') {
        const body = await parseJsonBody(req);
        const updated = await hostManager.updateHost(hostId, body);
        if (!updated) {
          sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
          return true;
        }
        sendJson(res, 200, updated);
        return true;
      }
      if (req.method === 'DELETE') {
        const deleteBackups = searchParams.get('deleteBackups') === 'true';
        const deleted = await hostManager.deleteHost(hostId, deleteBackups);
        if (!deleted) {
          sendError(res, 404, `Host ${hostId} not found`, 'HOST_NOT_FOUND');
          return true;
        }
        sendJson(res, 200, { success: true });
        return true;
      }
    }

    // -------------------------------------------------------------
    // Topology API
    // -------------------------------------------------------------
    if (pathname === '/api/topology' && req.method === 'GET') {
      const topo = await topologyEngine.getTopology();
      sendJson(res, 200, topo);
      return true;
    }

    // -------------------------------------------------------------
    // Clients APIs
    // -------------------------------------------------------------
    if (pathname === '/api/clients' && req.method === 'GET') {
      const filter = {
        q: searchParams.get('q') || '',
        hostId: searchParams.get('hostId') || '',
        type: searchParams.get('type') || '',
        vlan: searchParams.get('vlan') || '',
      };
      const clients = await clientEngine.getClients(filter);
      sendJson(res, 200, clients);
      return true;
    }

    const clientAliasMatch = pathname.match(/^\/api\/clients\/([^/]+)\/alias$/);
    if (clientAliasMatch && (req.method === 'PUT' || req.method === 'POST')) {
      const mac = decodeURIComponent(clientAliasMatch[1]);
      const body = await parseJsonBody(req);
      const updated = await clientEngine.setClientAlias(mac, body.nickname || body.alias || '');
      if (!updated) {
        sendError(res, 404, `Client with MAC ${mac} not found`, 'CLIENT_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, updated);
      return true;
    }

    const clientMacMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientMacMatch && req.method === 'GET') {
      const mac = decodeURIComponent(clientMacMatch[1]);
      const client = await clientEngine.getClientByMac(mac);
      if (!client) {
        sendError(res, 404, `Client with MAC ${mac} not found`, 'CLIENT_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, client);
      return true;
    }

    // -------------------------------------------------------------
    // WiFi Spectrum & Interference APIs
    // -------------------------------------------------------------
    if (pathname === '/api/wifi/scan' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const targetHostId = body?.hostId || 'all';
      if (targetHostId !== 'all' && !/^[a-zA-Z0-9_-]+$/.test(targetHostId)) {
        sendError(res, 400, 'Invalid hostId format', 'INVALID_HOST_ID');
        return true;
      }
      const bands = await hostManager.scanAllWifiNetworks(targetHostId);
      const analysis = analyzeInterference(bands);
      sendJson(res, 200, { bands, analysis });
      return true;
    }

    if ((pathname === '/api/wifi/channels' || pathname === '/api/wifi/interference') && req.method === 'GET') {
      await hostManager.getAllHosts();
      const bands = hostManager.getLiveWifiBands();

      if (pathname === '/api/wifi/channels') {
        sendJson(res, 200, { bands });
        return true;
      }

      const analysis = analyzeInterference(bands);
      sendJson(res, 200, analysis);
      return true;
    }

    // -------------------------------------------------------------
    // Backups & Schedules APIs
    // -------------------------------------------------------------
    if (pathname === '/api/backups' && req.method === 'GET') {
      const hostId = searchParams.get('hostId') || null;
      if (hostId && !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
        sendError(res, 400, 'Invalid hostId query parameter', 'INVALID_PARAM');
        return true;
      }
      const backups = await backupEngine.listBackups(hostId);
      sendJson(res, 200, backups);
      return true;
    }

    if (pathname === '/api/backups/run' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const hostId = body.hostId || 'all';
      if (hostId !== 'all' && !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
        sendError(res, 400, 'Invalid hostId format', 'INVALID_HOST_ID');
        return true;
      }
      const result = await backupEngine.runBackup(hostId, 'manual');
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/backups/schedules') {
      if (req.method === 'GET') {
        const schedules = await db.getSchedules();
        sendJson(res, 200, { schedules: schedules || [] });
        return true;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await parseJsonBody(req);
        const existing = (await db.getSchedules()) || [];
        const rawList = Array.isArray(body.schedules)
          ? body.schedules
          : Array.isArray(body)
            ? body
            : body && typeof body === 'object'
              ? [body]
              : [];

        const now = new Date();
        const normalizedList = rawList.map((item, idx) => {
          const prev = existing.find((s) => s.id === item.id) || existing[idx] || {};
          const cron = String(item.cron || prev.cron || '0 3 * * *').trim();
          const enabled = item.enabled !== undefined ? Boolean(item.enabled) : prev.enabled !== false;
          const rawRet = Number(item.retentionMaxBackups ?? prev.retentionMaxBackups ?? 14);
          const retentionMaxBackups = Number.isFinite(rawRet) ? Math.max(2, Math.min(100, Math.round(rawRet))) : 14;

          return {
            id: item.id || prev.id || 'sched-nightly-fleet',
            name: item.name || prev.name || 'Nightly Fleet Backup',
            cron,
            enabled,
            targets: Array.isArray(item.targets) && item.targets.length > 0 ? item.targets : prev.targets || ['all'],
            retentionMaxBackups,
            lastRun: item.lastRun !== undefined ? item.lastRun : prev.lastRun || null,
            nextRun: enabled ? backupEngine.computeNextRun(cron, now) : null,
          };
        });

        await db.saveSchedules(normalizedList);

        // Sync primary schedule retention count with settings.retention.maxBackupsPerHost
        if (normalizedList.length > 0) {
          const currentSettings = (await db.getSettings()) || {};
          const updatedSettings = {
            ...currentSettings,
            retention: {
              ...(currentSettings.retention || { maxAgeDays: 30, minRetainedPerHost: 2 }),
              maxBackupsPerHost: normalizedList[0].retentionMaxBackups,
            },
          };
          await db.saveSettings(updatedSettings);
          await backupEngine.applyAllRetention();
        }

        sendJson(res, 200, { schedules: normalizedList });
        return true;
      }
    }

    const schedRunMatch = pathname.match(/^\/api\/backups\/schedules\/([^/]+)\/run$/);
    if (schedRunMatch && req.method === 'POST') {
      const schedId = schedRunMatch[1];
      const schedules = (await db.getSchedules()) || [];
      const sched = schedules.find((s) => s.id === schedId);
      if (!sched) {
        sendError(res, 404, `Schedule ${schedId} not found`, 'SCHEDULE_NOT_FOUND');
        return true;
      }
      const target = sched.targets && sched.targets.length === 1 ? sched.targets[0] : 'all';
      const runResult = await backupEngine.runBackup(target, 'scheduled');

      // Update schedule lastRun and nextRun based on its cron expression
      const now = new Date();
      sched.lastRun = now.toISOString();
      sched.nextRun = sched.enabled === false ? null : backupEngine.computeNextRun(sched.cron, now);
      await db.saveSchedules(schedules);

      sendJson(res, 200, {
        scheduleId: schedId,
        status: 'completed',
        schedule: sched,
        job: runResult,
      });
      return true;
    }

    // /api/backups/:id/diff/:otherId?file=etc/config/network
    const diffMatch = pathname.match(/^\/api\/backups\/([^/]+)\/diff\/([^/]+)$/);
    if (diffMatch && req.method === 'GET') {
      const backupIdA = diffMatch[1];
      const backupIdB = diffMatch[2];
      const file = searchParams.get('file') || 'etc/config/network';
      try {
        const diffData = await backupEngine.diffBackups(backupIdA, backupIdB, file);
        sendJson(res, 200, diffData);
      } catch (err) {
        sendError(res, 404, err.message, 'DIFF_ERROR');
      }
      return true;
    }

    // /api/backups/:id/download
    const downloadMatch = pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
    if (downloadMatch && req.method === 'GET') {
      const backupId = downloadMatch[1];
      const meta = await backupEngine.getBackupMeta(backupId);
      if (!meta) {
        sendError(res, 404, `Backup ${backupId} not found`, 'BACKUP_NOT_FOUND');
        return true;
      }
      const buf = await backupEngine.getBackupBuffer(backupId);
      if (!buf) {
        sendError(res, 404, `Backup file archive not found on disk`, 'FILE_NOT_FOUND');
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="${meta.filename}"`,
      });
      res.end(buf);
      return true;
    }

    // /api/backups/:id/files
    const filesMatch = pathname.match(/^\/api\/backups\/([^/]+)\/files$/);
    if (filesMatch && req.method === 'GET') {
      const backupId = filesMatch[1];
      const files = await backupEngine.getBackupFiles(backupId);
      if (!files) {
        sendError(res, 404, `Backup ${backupId} not found`, 'BACKUP_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, {
        backupId,
        files,
      });
      return true;
    }

    // /api/backups/:id/file-content?path=etc/config/network
    const fileContentMatch = pathname.match(/^\/api\/backups\/([^/]+)\/file-content$/);
    if (fileContentMatch && req.method === 'GET') {
      const backupId = fileContentMatch[1];
      const filePath = searchParams.get('path');
      if (!filePath) {
        sendError(res, 400, 'Query param "path" is required', 'MISSING_PARAM');
        return true;
      }
      const content = await backupEngine.getBackupFileContent(backupId, filePath);
      if (content === null) {
        sendError(res, 404, `File ${filePath} not found in backup ${backupId}`, 'FILE_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, {
        path: filePath,
        content,
      });
      return true;
    }

    // /api/backups/:id (DELETE)
    const backupIdMatch = pathname.match(/^\/api\/backups\/([^/]+)$/);
    if (backupIdMatch && req.method === 'DELETE') {
      const backupId = backupIdMatch[1];
      const success = await backupEngine.deleteBackup(backupId);
      if (!success) {
        sendError(res, 404, `Backup ${backupId} not found`, 'BACKUP_NOT_FOUND');
        return true;
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    // -------------------------------------------------------------
    // Simulator Controls APIs
    // -------------------------------------------------------------
    if (pathname === '/api/simulator/status' && req.method === 'GET') {
      sendJson(res, 200, simulator.getStatus());
      return true;
    }

    if (pathname === '/api/simulator/configure' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const status = simulator.configure(body);
      sendJson(res, 200, status);
      return true;
    }

    if (pathname === '/api/simulator/reset' && req.method === 'POST') {
      const status = simulator.reset();
      sendJson(res, 200, status);
      return true;
    }

    // If matches /api/* but no route handled
    if (pathname.startsWith('/api/')) {
      sendError(res, 404, `API route ${req.method} ${pathname} not found`, 'ROUTE_NOT_FOUND');
      return true;
    }

    return false;
  } catch (err) {
    const status = err.statusCode || 500;
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR';
    sendError(res, status, err.message || 'Internal server error', code);
    return true;
  }
}
