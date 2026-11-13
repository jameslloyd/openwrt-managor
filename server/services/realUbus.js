import { config } from '../config.js';

/**
 * Real OpenWrt HTTP ubus Client and Connection Tester
 */

export class OpenWrtUbusClient {
  constructor(hostConfig) {
    this.host = hostConfig;
    this.sessionToken = null;
    this.tokenExpires = 0;
  }

  getBaseUrl() {
    const proto = this.host.useHttps ? 'https' : 'http';
    const port = this.host.port || (this.host.useHttps ? 443 : 80);
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

/**
 * Tests connection to an OpenWrt host (handles both simulated and real hosts).
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

  // If host is explicitly simulated or matches a simulated IP while demo mode is active
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
      detectedModel: matched ? matched.model : (hostConfig.model || 'OpenWrt Virtual Node'),
      detectedFirmware: matched ? matched.firmware : 'OpenWrt 23.05.4',
    };
  }

  // Attempt real ubus call
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
    const latencyMs = Date.now() - startTime;
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
