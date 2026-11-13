import { hostManager } from './hostManager.js';
import { db } from '../storage/db.js';

export class ClientEngine {
  async getClients(filter = {}) {
    let list = hostManager.getLiveClients();

    if (filter.q) {
      const q = filter.q.toLowerCase();
      list = list.filter(
        (c) =>
          (c.hostname && c.hostname.toLowerCase().includes(q)) ||
          (c.ip && c.ip.includes(q)) ||
          (c.mac && c.mac.toLowerCase().includes(q)) ||
          (c.vendor && c.vendor.toLowerCase().includes(q))
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

    const aliases = (await db.getClientAliases()) || {};

    return list.map((c) => {
      const alias = aliases[c.mac.toLowerCase()];
      return {
        ...c,
        nickname: alias || null,
        displayName: alias || c.hostname,
      };
    });
  }

  async getClientByMac(mac) {
    if (!mac || typeof mac !== 'string') return null;
    const normalized = mac.toLowerCase().trim();
    const list = hostManager.getLiveClients();
    const client = list.find((c) => c.mac.toLowerCase() === normalized);
    if (!client) return null;

    const aliases = (await db.getClientAliases()) || {};
    const alias = aliases[normalized];

    return {
      ...client,
      nickname: alias || null,
      displayName: alias || client.hostname,
    };
  }

  async setClientAlias(mac, nickname) {
    if (!mac || typeof mac !== 'string') return null;
    const normalized = mac.toLowerCase().trim();
    if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(normalized)) {
      throw new Error('Invalid MAC address format');
    }
    if (normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
      throw new Error('Invalid identifier');
    }

    const rawAliases = (await db.getClientAliases()) || {};
    const aliases = Object.assign(Object.create(null), rawAliases);
    if (nickname) {
      aliases[normalized] = String(nickname).slice(0, 100);
    } else {
      delete aliases[normalized];
    }
    await db.saveClientAliases({ ...aliases });
    return (
      (await this.getClientByMac(mac)) || {
        mac: normalized,
        nickname: aliases[normalized] || null,
        displayName: aliases[normalized] || normalized,
      }
    );
  }
}

export const clientEngine = new ClientEngine();
