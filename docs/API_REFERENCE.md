# REST API, Hermes Agent Integration & Testing Reference

[&larr; Back to Main README](../README.md)

This document catalogs all HTTP REST API endpoints exposed by **OpenWrt Manager (`openwrt-managor`)**, the **Hermes / External AI Agent** integration layer, and the automated test suite.

---

## 1. REST API Endpoint Catalog

### System & Global Settings

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Container healthcheck (`status`, `uptime`, volume checks) |
| `GET` | `/api/system/info` | Host system info, Node.js runtime, and memory metrics |
| `GET` | `/api/settings` | Global settings (polling interval, retention rules, alerts) |
| `PUT` | `/api/settings` | Update global settings (automatically syncs backup retention rules) |

### OpenWrt Host Management & Telemetry

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/hosts` | List all managed OpenWrt routers, APs, and mesh nodes |
| `POST` | `/api/hosts` | Register a new OpenWrt host |
| `GET` | `/api/hosts/:id` | Get single host configuration and live telemetry |
| `PUT` | `/api/hosts/:id` | Update host configuration, `mapPosition`, or `latitude`/`longitude`/`altitude` |
| `DELETE` | `/api/hosts/:id` | Remove host from the managed fleet |
| `POST` | `/api/hosts/test` | Test credentials and live connectivity for an unsaved host |
| `POST` | `/api/hosts/:id/test` | Test credentials and live connectivity for a registered host |

### Background Software Package & Attended Sysupgrade Firmware Jobs

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/hosts/:id/updates/check` | Check pending `opkg` / `apk` package updates and Attended Sysupgrade (`auc` / `owut`) firmware advisories |
| `POST` | `/api/hosts/:id/updates/upgrade` | Start a background package upgrade job (`all: true` or selected `packages[]`) |
| `POST` | `/api/hosts/:id/sysupgrade` | Start a background Attended Sysupgrade firmware image build and flash job |
| `GET` | `/api/upgrades/jobs` | Poll active and recently completed background software/firmware upgrade jobs |
| `GET` | `/api/upgrades/jobs/:jobId` | Get detailed step progress and live console log lines for a specific upgrade job |

### Network Topology & Client Inventory

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/topology` | Synthesized multi-tier network topology graph (`nodes` and `links`) |
| `GET` | `/api/clients` | Consolidated, de-duplicated network client inventory (DHCP + ARP/rDNS + multi-AP `iwinfo` + OUI vendor) |
| `GET` | `/api/clients/:mac` | Detailed client record with signal history and multi-AP roaming state |

### Wi-Fi RF Spectrum & 3D Location Triangulation

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/wifi/channels` | Tri-band (`2.4`/`5`/`6 GHz`) radios, `iw survey dump` airtime utilization, scanned neighbors, wireless AP anchors, and 3D triangulated positions |
| `GET` | `/api/wifi/interference` | Airtime congestion scores, overlapping frequency zones, and cleanest channel recommendations |
| `POST` | `/api/wifi/scan` | Trigger active wireless scan (`iw dev <iface> scan`) across all wireless OpenWrt hosts |

### Configuration Backups, Cron Schedules & UCI Diffs

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/backups` | List all stored OpenWrt `.tar.gz` backup archives and sidecar metadata |
| `POST` | `/api/backups/run` | Execute an on-demand configuration backup (`hostId` or `"all"`) |
| `GET` | `/api/backups/:id/download` | Download raw `.tar.gz` configuration archive |
| `GET` | `/api/backups/:id/files` | In-memory listing of files inside a `.tar.gz` archive |
| `GET` | `/api/backups/:id/file-content` | Stream textual content of a specific UCI config file (`?path=etc/config/network`) |
| `GET` | `/api/backups/:id/diff/:otherId` | Unified line-by-line UCI configuration diff between two backups |
| `DELETE` | `/api/backups/:id` | Delete a backup archive and its `.meta.json` sidecar |
| `GET` | `/api/backups/schedules` | List automated cron/interval backup schedules |
| `PUT` | `/api/backups/schedules` | Update automated cron/interval backup schedules |
| `POST` | `/api/backups/schedules/:id/run` | Immediately execute a scheduled backup job |

### Live Multi-Host Simulator

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/simulator/status` | Get simulator state and active mock topology metrics |
| `POST` | `/api/simulator/configure` | Adjust simulation parameters (`trafficSpike`, `forceRoam`, `injectInterference`) |
| `POST` | `/api/simulator/reset` | Reseed default 4-node simulated homelab fleet |

---

## 2. Hermes & External AI Agent REST API (`/api/agent/*` & `/api/v1/*`)

OpenWrt Manager provides dedicated endpoints designed for **Hermes** and external AI agents or automation workflows. All `/api/*` endpoints are also aliased under `/api/v1/*`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/openapi.json` | Full OpenAPI 3.1.0 specification for automatic tool import in Hermes / LLM agents |
| `GET` | `/api/agent/manifest` | Concise JSON manifest describing available agent endpoints, parameters, and auth status |
| `GET` | `/api/agent/status` | Single-call fleet health summary: online/degraded/offline host counts, CPU/RAM averages, active alerts, pending package/firmware updates, and Wi-Fi congestion summary |
| `GET` | `/api/agent/hosts` | Agent-friendly list of all OpenWrt hosts with live telemetry, radios, and update status |
| `GET` | `/api/agent/hosts/:idOrName` | Flexible host lookup by exact ID, hostname, display name, or IP address (`?refreshUpdates=true` supported) |
| `GET` | `/api/agent/wifi` | Consolidated Wi-Fi spectrum congestion, channel recommendations, and triangulated neighboring networks |

### Optional API Key Authentication
When the `OPENWRT_MANAGER_API_KEY` environment variable is set, requests can authenticate via either:
- `Authorization: Bearer <OPENWRT_MANAGER_API_KEY>`
- `X-API-Key: <OPENWRT_MANAGER_API_KEY>`

---

## 3. Testing & Quality Assurance

The automated test suite uses Node.js's built-in test runner (`node:test` and `node:assert/strict`) with zero external test dependencies:

```bash
npm test
```

### Test Suite Coverage (31 Passing Tests in [`tests/api.test.js`](../tests/api.test.js)):
- **Health & System Info:** Validates HTTP 200 healthchecks, memory telemetry, and volume checks.
- **Host Management & Connection Probes:** Validates host CRUD, password masking, and live connection probing.
- **Topology Synthesis:** Verifies multi-tier node hierarchies, link capacities, and VLAN tags.
- **Client De-Duplication, DHCP/ARP/rDNS & Manufacturer Resolution:** Verifies multi-AP roaming de-duplication, gateway ARP/DHCP/rDNS IP lookup, IEEE OUI lookup, locally-administered virtual BSSID bit-masking, and SSID vendor heuristics.
- **Wi-Fi RF Spectrum Congestion & Neighbor Scanning:** Verifies `iw survey dump` airtime busy/active ratio aggregation, overlapping congestion zones, and multi-radio `iw scan` RSSI sorting.
- **3D Foreign AP RF Triangulation & Geodetic Calibration:** Verifies wireless-only OpenWrt anchor filtering (excluding wired-only gateways), log-distance path-loss trilateration, East-North-Up (ENU) GPS coordinate projection, and multi-floor altitude slant-range compensation.
- **Package Updates, Background Jobs & Attended Sysupgrade:** Verifies `opkg` / `apk` update checks, `auc` / `owut` / LuCI Attended Sysupgrade detection, and streaming background upgrade jobs.
- **Hermes & External Agent REST API:** Verifies OpenAPI 3.1.0 schema, agent manifest, fleet status summary, flexible host lookup, and optional Bearer / `X-API-Key` enforcement.
- **Tarball Inspection, Cron Schedules & UCI Diff:** Verifies in-memory `.tar.gz` unpacking, schedule persistence, retention syncing, and unified line diff generation.
- **Atomic Flat-File Storage Engine:** Verifies collision-free atomic writes with `fsync` and `0o600` file permissions.
