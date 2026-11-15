/**
 * WiFi Spectrum Analyzer, Fleet-Wide Congestion & Interference Engine
 */

export function getChannelCenterFreq(band, channel) {
  if (band === '2.4GHz') {
    if (channel === 14) return 2484;
    return 2412 + 5 * (channel - 1);
  }
  if (band === '5GHz') {
    return 5000 + 5 * channel;
  }
  if (band === '6GHz') {
    return 5950 + 5 * channel;
  }
  return 0;
}

const CANDIDATE_CHANNELS = {
  '2.4GHz': [
    { channel: 1, widthMhz: 20 },
    { channel: 6, widthMhz: 20 },
    { channel: 11, widthMhz: 20 },
  ],
  '5GHz': [
    { channel: 36, widthMhz: 80, centerFreqMhz: 5210, label: 'UNII-1 (Ch 36)' },
    { channel: 52, widthMhz: 80, centerFreqMhz: 5290, label: 'UNII-2A DFS (Ch 52)' },
    { channel: 100, widthMhz: 80, centerFreqMhz: 5530, label: 'UNII-2C DFS (Ch 100)' },
    { channel: 116, widthMhz: 80, centerFreqMhz: 5610, label: 'UNII-2C DFS (Ch 116)' },
    { channel: 149, widthMhz: 80, centerFreqMhz: 5775, label: 'UNII-3 (Ch 149)' },
  ],
  '6GHz': [
    { channel: 1, widthMhz: 80, centerFreqMhz: 5985, label: 'UNII-5 (Ch 1)' },
    { channel: 17, widthMhz: 80, centerFreqMhz: 6065, label: 'UNII-5 (Ch 17)' },
    { channel: 33, widthMhz: 80, centerFreqMhz: 6145, label: 'UNII-5 (Ch 33)' },
    { channel: 49, widthMhz: 80, centerFreqMhz: 6225, label: 'UNII-5 (Ch 49)' },
    { channel: 65, widthMhz: 80, centerFreqMhz: 6305, label: 'UNII-5 (Ch 65)' },
    { channel: 81, widthMhz: 80, centerFreqMhz: 6385, label: 'UNII-5 (Ch 81)' },
  ],
};

function getRadioSpan(radio, bandName) {
  const center = radio.centerFreqMhz || getChannelCenterFreq(bandName, radio.channel);
  const width = radio.widthMhz || 20;
  return {
    center,
    width,
    start: center - width / 2,
    end: center + width / 2,
  };
}

function findLeastCongestedChannel(bandName, radios, neighbors = []) {
  const candidates = CANDIDATE_CHANNELS[bandName] || [];
  let best = null;

  for (const cand of candidates) {
    const center = cand.centerFreqMhz || getChannelCenterFreq(bandName, cand.channel);
    const start = center - cand.widthMhz / 2;
    const end = center + cand.widthMhz / 2;

    let overlappingRadios = 0;
    let overlappingNeighbors = 0;
    let combinedUtil = 0;

    for (const r of radios) {
      const span = getRadioSpan(r, bandName);
      if (Math.max(start, span.start) < Math.min(end, span.end)) {
        overlappingRadios++;
        combinedUtil += r.utilizationPct || 15;
      }
    }

    for (const n of neighbors) {
      if (n.isManagedFleet) continue;
      const nCenter = n.centerFreqMhz || getChannelCenterFreq(bandName, n.channel);
      const nWidth = n.widthMhz || 20;
      const nStart = nCenter - nWidth / 2;
      const nEnd = nCenter + nWidth / 2;
      if (Math.max(start, nStart) < Math.min(end, nEnd)) {
        overlappingNeighbors++;
        const sigDbm = n.strongestSignalDbm ?? n.signalDbm ?? -85;
        // Stronger neighbor signals contribute more RF contention
        const neighborWeight = sigDbm >= -60 ? 22 : sigDbm >= -72 ? 12 : 5;
        combinedUtil += neighborWeight;
      }
    }

    const score = overlappingRadios * 40 + overlappingNeighbors * 15 + combinedUtil;
    if (!best || score < best.score) {
      best = {
        channel: cand.channel,
        centerFreqMhz: center,
        widthMhz: cand.widthMhz,
        label: cand.label || `Channel ${cand.channel}`,
        overlappingRadios,
        overlappingNeighbors,
        combinedUtilPct: Math.min(100, combinedUtil),
        score,
      };
    }
  }

  return best;
}

/**
 * Analyzes active radios across all bands and identifies co-channel interference,
 * adjacent-channel overlap, high airtime utilization, and congested spectrum zones.
 */
export function analyzeInterference(bandsData) {
  const warnings = [];
  const bandCongestion = {};
  let scoreDeductions = 0;

  for (const [bandName, bandInfo] of Object.entries(bandsData || {})) {
    const radios = bandInfo?.radios || [];
    const neighbors = bandInfo?.neighbors || [];
    const externalNeighbors = neighbors.filter((n) => !n.isManagedFleet);
    const totalClients = radios.reduce((acc, r) => acc + (r.clientCount || 0), 0);
    const avgUtilizationPct =
      radios.length > 0 ? Math.round(radios.reduce((acc, r) => acc + (r.utilizationPct || 0), 0) / radios.length) : 0;
    const peakUtilizationPct =
      radios.length > 0 ? Math.max(...radios.map((r) => r.utilizationPct || 0)) : 0;

    const overlappingZones = [];
    const channelStatsMap = new Map();
    const bestCandidate = findLeastCongestedChannel(bandName, radios, externalNeighbors);

    // Build per-channel congestion metrics across all radios on this band
    for (const r of radios) {
      const chKey = r.channel;
      if (!channelStatsMap.has(chKey)) {
        channelStatsMap.set(chKey, {
          channel: r.channel,
          centerFreqMhz: r.centerFreqMhz || getChannelCenterFreq(bandName, r.channel),
          widthMhz: r.widthMhz || 20,
          radioCount: 0,
          neighborCount: 0,
          strongestNeighborDbm: null,
          clientCount: 0,
          combinedUtilizationPct: 0,
          radios: [],
        });
      }
      const stat = channelStatsMap.get(chKey);
      stat.radioCount += 1;
      stat.clientCount += r.clientCount || 0;
      stat.combinedUtilizationPct = Math.min(100, stat.combinedUtilizationPct + (r.utilizationPct || 0));
      stat.widthMhz = Math.max(stat.widthMhz, r.widthMhz || 20);
      stat.radios.push({
        id: r.id,
        hostId: r.hostId,
        hostName: r.hostName,
        ssid: r.ssid,
        utilizationPct: r.utilizationPct || 0,
        clientCount: r.clientCount || 0,
      });

      // Individual radio high airtime congestion warning
      if ((r.utilizationPct || 0) >= 70) {
        scoreDeductions += 8;
        warnings.push({
          id: `warn-util-${r.id}`,
          type: 'airtime_congestion',
          severity: (r.utilizationPct || 0) >= 85 ? 'high' : 'medium',
          band: bandName,
          channel: r.channel,
          affectedRadios: [r.id],
          combinedUtilizationPct: r.utilizationPct,
          recommendedChannel: bestCandidate?.channel || null,
          message: `High airtime congestion (${r.utilizationPct}% busy, ${r.clientCount || 0} clients) on ${r.hostName} (${bandName} Ch ${r.channel}).${
            bestCandidate && bestCandidate.channel !== r.channel ? ` Consider offloading to ${bestCandidate.label}.` : ''
          }`,
        });
      }
    }

    // Include external neighboring networks in channel stats and check for strong external interference
    for (const n of externalNeighbors) {
      const sigDbm = n.strongestSignalDbm ?? n.signalDbm ?? -85;
      const chKey = n.channel;
      if (channelStatsMap.has(chKey)) {
        const stat = channelStatsMap.get(chKey);
        stat.neighborCount += 1;
        if (stat.strongestNeighborDbm === null || sigDbm > stat.strongestNeighborDbm) {
          stat.strongestNeighborDbm = sigDbm;
        }
      }

      // Check if this external neighbor strongly overlaps with any managed radio (signal >= -70 dBm)
      if (sigDbm >= -70) {
        const nCenter = n.centerFreqMhz || getChannelCenterFreq(bandName, n.channel);
        const nWidth = n.widthMhz || 20;
        const nStart = nCenter - nWidth / 2;
        const nEnd = nCenter + nWidth / 2;

        for (const r of radios) {
          const rSpan = getRadioSpan(r, bandName);
          if (Math.max(nStart, rSpan.start) < Math.min(nEnd, rSpan.end)) {
            scoreDeductions += 5;
            warnings.push({
              id: `warn-ext-${r.id}-${n.bssid}`,
              type: 'external_interference',
              severity: sigDbm >= -60 ? 'high' : 'medium',
              band: bandName,
              channel: r.channel,
              affectedRadios: [r.id],
              neighborBssid: n.bssid,
              neighborSsid: n.ssid,
              signalDbm: sigDbm,
              recommendedChannel: bestCandidate?.channel || null,
              message: `External network "${n.ssid}" (${n.bssid.toUpperCase()}, Ch ${n.channel}) detected at ${sigDbm} dBm by ${
                n.strongestHostName || r.hostName
              }, overlapping ${r.hostName} on ${bandName} Ch ${r.channel}.${
                bestCandidate && bestCandidate.channel !== r.channel ? ` Least congested channel: ${bestCandidate.label}.` : ''
              }`,
            });
          }
        }
      }
    }

    // Pairwise RF spectrum overlap & co-channel / adjacent-channel congestion analysis
    for (let i = 0; i < radios.length; i++) {
      for (let j = i + 1; j < radios.length; j++) {
        const r1 = radios[i];
        const r2 = radios[j];

        const s1 = getRadioSpan(r1, bandName);
        const s2 = getRadioSpan(r2, bandName);

        const overlapStart = Math.max(s1.start, s2.start);
        const overlapEnd = Math.min(s1.end, s2.end);
        const isOverlapping = overlapStart < overlapEnd;

        if (isOverlapping) {
          const isExactChannel = r1.channel === r2.channel;
          const combinedUtil = Math.min(100, (r1.utilizationPct || 15) + (r2.utilizationPct || 15));
          const combinedClients = (r1.clientCount || 0) + (r2.clientCount || 0);
          const warningId = `warn-${isExactChannel ? 'cci' : 'aci'}-${r1.id}-${r2.id}`;

          overlappingZones.push({
            id: `zone-${r1.id}-${r2.id}`,
            band: bandName,
            type: isExactChannel ? 'co_channel' : 'adjacent_channel',
            startFreqMhz: overlapStart,
            endFreqMhz: overlapEnd,
            centerFreqMhz: Math.round((overlapStart + overlapEnd) / 2),
            bandwidthMhz: overlapEnd - overlapStart,
            channels: isExactChannel ? [r1.channel] : [r1.channel, r2.channel],
            affectedRadios: [r1.id, r2.id],
            hostNames: [r1.hostName, r2.hostName],
            combinedUtilizationPct: combinedUtil,
            combinedClients,
            severity: combinedUtil >= 60 || !isExactChannel || bandName !== '2.4GHz' ? 'high' : 'medium',
          });

          if (isExactChannel) {
            const severity = bandName === '2.4GHz' && combinedUtil < 60 ? 'medium' : 'high';
            scoreDeductions += bandName === '2.4GHz' ? 10 : 15;

            let recommendation = `Recommend moving ${r2.hostName} to a non-overlapping channel.`;
            const altCh = bestCandidate?.channel;
            if (bandName === '2.4GHz') {
              const targetCh = altCh && altCh !== r1.channel ? altCh : r1.channel === 6 ? 11 : 6;
              recommendation = `${r1.hostName} and ${r2.hostName} share 2.4GHz Channel ${r1.channel} (${combinedUtil}% combined airtime, ${combinedClients} clients). Recommend moving ${r2.hostName} to Channel ${targetCh} or Channel 1.`;
            } else if (bandName === '5GHz') {
              recommendation = `${r1.hostName} and ${r2.hostName} share 5GHz Channel ${r1.channel} (${r1.widthMhz}MHz, ${combinedUtil}% combined airtime). Recommend moving ${r2.hostName} to UNII-3 Channel 149 or UNII-2C DFS Channel 100.`;
            } else if (bandName === '6GHz') {
              const targetCh = altCh && altCh !== r1.channel ? altCh : 33;
              recommendation = `${r1.hostName} and ${r2.hostName} share 6GHz Channel ${r1.channel} (${r1.widthMhz}MHz, ${combinedUtil}% combined airtime). Recommend moving ${r2.hostName} to Channel ${targetCh}.`;
            }

            warnings.push({
              id: warningId,
              type: 'co_channel',
              severity,
              band: bandName,
              channel: r1.channel,
              startFreqMhz: overlapStart,
              endFreqMhz: overlapEnd,
              combinedUtilizationPct: combinedUtil,
              combinedClients,
              recommendedChannel: bestCandidate?.channel || null,
              affectedRadios: [r1.id, r2.id],
              message: recommendation,
            });
          } else {
            scoreDeductions += 12;
            warnings.push({
              id: warningId,
              type: 'adjacent_channel',
              severity: 'high',
              band: bandName,
              channel: `${r1.channel}/${r2.channel}`,
              startFreqMhz: overlapStart,
              endFreqMhz: overlapEnd,
              combinedUtilizationPct: combinedUtil,
              combinedClients,
              recommendedChannel: bestCandidate?.channel || null,
              affectedRadios: [r1.id, r2.id],
              message: `Adjacent channel overlap (${overlapStart}–${overlapEnd} MHz, ${combinedUtil}% combined airtime) between ${r1.hostName} (Ch ${r1.channel}) and ${r2.hostName} (Ch ${r2.channel}) on ${bandName}. Causes frame collisions.`,
            });
          }
        }
      }
    }

    // Calculate overall band congestion score (0-100)
    const overlapPenalty = overlappingZones.reduce(
      (acc, z) => acc + (z.type === 'adjacent_channel' ? 25 : 18) + Math.round(z.combinedUtilizationPct * 0.25),
      0
    );
    const neighborPenalty = externalNeighbors.reduce((acc, n) => {
      const sig = n.strongestSignalDbm ?? n.signalDbm ?? -85;
      return acc + (sig >= -60 ? 12 : sig >= -72 ? 6 : 2);
    }, 0);
    const congestionScore =
      radios.length === 0 && externalNeighbors.length === 0
        ? 0
        : Math.min(100, Math.round(avgUtilizationPct * 0.55 + overlapPenalty + neighborPenalty));

    let congestionLevel = 'low';
    if (congestionScore >= 65 || overlappingZones.some((z) => z.severity === 'high')) {
      congestionLevel = 'high';
    } else if (congestionScore >= 35 || overlappingZones.length > 0 || externalNeighbors.some((n) => (n.strongestSignalDbm ?? -85) >= -65)) {
      congestionLevel = 'moderate';
    }

    bandCongestion[bandName] = {
      band: bandName,
      radiosCount: radios.length,
      neighborsCount: externalNeighbors.length,
      totalClients,
      avgUtilizationPct,
      peakUtilizationPct,
      overlappingCount: overlappingZones.length,
      congestionScore,
      congestionLevel,
      recommendedChannel: bestCandidate,
      overlappingZones,
      channels: Array.from(channelStatsMap.values()).sort((a, b) => a.channel - b.channel),
    };
  }

  const healthScore = Math.max(0, 100 - scoreDeductions);
  let status = 'optimal';
  if (warnings.length > 0) {
    status = healthScore < 75 ? 'critical' : 'warning';
  }

  const allRadiosCount = Object.values(bandCongestion).reduce((acc, b) => acc + b.radiosCount, 0);
  const mostCongestedBand =
    Object.values(bandCongestion)
      .filter((b) => b.radiosCount > 0)
      .sort((a, b) => b.congestionScore - a.congestionScore)[0]?.band || null;

  return {
    summary: {
      status,
      warningsCount: warnings.length,
      healthScore,
      totalRadios: allRadiosCount,
      mostCongestedBand,
    },
    bandCongestion,
    warnings,
  };
}

/**
 * Estimates distance in meters from RSSI (dBm) using the indoor log-distance path loss model:
 *   RSSI = P_ref(1m) - 10 * n * log10(d)
 *   d = 10 ^ ((P_ref(1m) - RSSI) / (10 * n))
 */
export function rssiToDistanceMeters(signalDbm, band = '5GHz') {
  const rssi = Math.max(-100, Math.min(-25, Number(signalDbm) || -85));
  const refDbm = band === '2.4GHz' ? -38 : band === '6GHz' ? -45 : -42;
  const pathLossExp = band === '2.4GHz' ? 2.7 : band === '6GHz' ? 3.2 : 3.0;
  const rawMeters = Math.pow(10, (refDbm - rssi) / (10 * pathLossExp));
  return Math.round(Math.max(0.5, Math.min(65.0, rawMeters)) * 10) / 10;
}

function hashString(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function computeCompassBearing(dx, dy) {
  // SVG coordinate system: +x is East, -y is North
  const angleDeg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(angleDeg / 45) % 8];
}

/**
 * Extracts normalized GPS (latitude, longitude) and altitude (meters) from a host object.
 */
export function extractHostGeolocation(host = {}) {
  const rawLat = host?.latitude ?? host?.lat ?? host?.geoLocation?.lat ?? host?.geoLocation?.latitude;
  const rawLng =
    host?.longitude ??
    host?.lng ??
    host?.lon ??
    host?.geoLocation?.lng ??
    host?.geoLocation?.lon ??
    host?.geoLocation?.longitude;
  const rawAlt = host?.altitude ?? host?.alt ?? host?.geoLocation?.alt ?? host?.geoLocation?.altitude;

  const latNum = rawLat !== null && rawLat !== undefined && rawLat !== '' ? Number(rawLat) : NaN;
  const lngNum = rawLng !== null && rawLng !== undefined && rawLng !== '' ? Number(rawLng) : NaN;
  const altNum = rawAlt !== null && rawAlt !== undefined && rawAlt !== '' ? Number(rawAlt) : NaN;

  const hasGps =
    Number.isFinite(latNum) &&
    Number.isFinite(lngNum) &&
    latNum >= -90 &&
    latNum <= 90 &&
    lngNum >= -180 &&
    lngNum <= 180;
  const hasAlt = Number.isFinite(altNum) && altNum >= -500 && altNum <= 10000;

  return {
    latitude: hasGps ? Math.round(latNum * 1e6) / 1e6 : null,
    longitude: hasGps ? Math.round(lngNum * 1e6) / 1e6 : null,
    altitude: hasAlt ? Math.round(altNum * 100) / 100 : null,
    hasGps,
    hasAlt,
  };
}

/**
 * Filters a list of OpenWrt hosts to only those with wireless radios.
 */
export function filterWirelessHosts(hosts = [], bandsData = null) {
  const radioHostIds = new Set();
  if (bandsData && typeof bandsData === 'object') {
    for (const bandInfo of Object.values(bandsData)) {
      for (const r of bandInfo?.radios || []) {
        if (r?.hostId) radioHostIds.add(r.hostId);
      }
    }
  }

  return (hosts || []).filter((host) => {
    if (!host || !host.id) return false;
    if (Array.isArray(host.radios)) {
      return host.radios.length > 0 || radioHostIds.has(host.id);
    }
    if (typeof host.hasWirelessRadios === 'boolean') {
      return host.hasWirelessRadios || radioHostIds.has(host.id);
    }
    return radioHostIds.size === 0 || radioHostIds.has(host.id);
  });
}

/**
 * Computes 2D/3D coordinate anchors (on a 0..100 meter floorplan grid) for managed OpenWrt hosts with wireless radios.
 * Projects GPS (latitude, longitude) into local East-North-Up (ENU) meters when configured,
 * preserves altitude (meters) for 3D slant-range triangulation, and honors `host.mapPosition` ({ x, y }).
 */
export function computeHostAnchorPositions(hosts = []) {
  const wirelessHosts = filterWirelessHosts(hosts);
  const total = wirelessHosts.length;

  const hostGeoList = wirelessHosts.map((h) => ({
    host: h,
    geo: extractHostGeolocation(h),
  }));

  const gpsItems = hostGeoList.filter((item) => item.geo.hasGps);
  const altItems = hostGeoList.filter((item) => item.geo.hasAlt);

  let gpsOrigin = null;
  const enuByHostId = new Map();

  if (gpsItems.length > 0) {
    const refLat = gpsItems.reduce((acc, item) => acc + item.geo.latitude, 0) / gpsItems.length;
    const refLng = gpsItems.reduce((acc, item) => acc + item.geo.longitude, 0) / gpsItems.length;
    const refAlt =
      altItems.length > 0
        ? altItems.reduce((acc, item) => acc + item.geo.altitude, 0) / altItems.length
        : 0;

    const metersPerDegLat = (Math.PI / 180) * 6371000;
    const metersPerDegLng = metersPerDegLat * Math.max(0.05, Math.cos((refLat * Math.PI) / 180));

    let maxAbsMeters = 0;
    for (const item of gpsItems) {
      const eastMeters = (item.geo.longitude - refLng) * metersPerDegLng;
      const northMeters = (item.geo.latitude - refLat) * metersPerDegLat;
      enuByHostId.set(item.host.id, { eastMeters, northMeters });
      maxAbsMeters = Math.max(maxAbsMeters, Math.abs(eastMeters), Math.abs(northMeters));
    }

    // Fit GPS perimeter into [18..82] (radius 32 around 50,50) so foreign APs outside the perimeter stay visible
    const spanMeters = Math.max(12, maxAbsMeters * 2);
    const canvasUnitsPerMeter =
      gpsItems.length >= 2 && maxAbsMeters > 0.25
        ? Math.round((64 / spanMeters) * 1000) / 1000
        : 1.8;

    gpsOrigin = {
      refLat: Math.round(refLat * 1e6) / 1e6,
      refLng: Math.round(refLng * 1e6) / 1e6,
      refAlt: Math.round(refAlt * 100) / 100,
      metersPerDegLat,
      metersPerDegLng,
      canvasUnitsPerMeter,
      gpsAnchorCount: gpsItems.length,
    };
  }

  return hostGeoList.map(({ host, geo }, idx) => {
    const customX = Number(host?.mapPosition?.x);
    const customY = Number(host?.mapPosition?.y);
    const hasCustomPos = Number.isFinite(customX) && Number.isFinite(customY);
    const enu = enuByHostId.get(host.id);

    // If GPS is provided on 2+ hosts (or on this host when no custom mapPosition overrides it), project from GPS ENU
    if (geo.hasGps && enu && gpsOrigin && (gpsItems.length >= 2 || !hasCustomPos)) {
      const projX = 50 + enu.eastMeters * gpsOrigin.canvasUnitsPerMeter;
      const projY = 50 - enu.northMeters * gpsOrigin.canvasUnitsPerMeter;
      return {
        hostId: host.id,
        hostName: host.name || host.hostname || host.id,
        role: host.role || 'ap',
        hasWirelessRadios: true,
        x: Math.round(Math.max(6, Math.min(94, projX)) * 10) / 10,
        y: Math.round(Math.max(6, Math.min(94, projY)) * 10) / 10,
        altitude: geo.altitude,
        latitude: geo.latitude,
        longitude: geo.longitude,
        hasGps: true,
        hasAlt: geo.hasAlt,
        eastMeters: Math.round(enu.eastMeters * 10) / 10,
        northMeters: Math.round(enu.northMeters * 10) / 10,
        gpsOrigin,
        isCustomPosition: true,
        isGpsProjected: true,
      };
    }

    if (hasCustomPos) {
      return {
        hostId: host.id,
        hostName: host.name || host.hostname || host.id,
        role: host.role || 'ap',
        hasWirelessRadios: true,
        x: Math.round(Math.max(6, Math.min(94, customX)) * 10) / 10,
        y: Math.round(Math.max(6, Math.min(94, customY)) * 10) / 10,
        altitude: geo.altitude,
        latitude: geo.latitude,
        longitude: geo.longitude,
        hasGps: geo.hasGps,
        hasAlt: geo.hasAlt,
        gpsOrigin,
        isCustomPosition: true,
        isGpsProjected: false,
      };
    }

    let x = 50;
    let y = 50;
    if (total === 2) {
      x = idx === 0 ? 32 : 68;
      y = 50;
    } else if (total === 3) {
      const coords = [
        { x: 50, y: 27 },
        { x: 28, y: 67 },
        { x: 72, y: 67 },
      ];
      x = coords[idx].x;
      y = coords[idx].y;
    } else if (total >= 4) {
      const angle = -Math.PI / 2 + (2 * Math.PI * idx) / total;
      const radius = 26;
      x = Math.round((50 + radius * Math.cos(angle)) * 10) / 10;
      y = Math.round((50 + radius * Math.sin(angle)) * 10) / 10;
    }

    return {
      hostId: host.id,
      hostName: host.name || host.hostname || host.id,
      role: host.role || 'ap',
      hasWirelessRadios: true,
      x,
      y,
      altitude: geo.altitude,
      latitude: geo.latitude,
      longitude: geo.longitude,
      hasGps: geo.hasGps,
      hasAlt: geo.hasAlt,
      gpsOrigin,
      isCustomPosition: false,
      isGpsProjected: false,
    };
  });
}

/**
 * Solves for the approximate 2D/3D location (and GPS Lat/Lng/Altitude when configured) of a foreign AP
 * from multi-AP RSSI observations using log-distance path loss + 3D altitude slant-range compensation +
 * radical-axis initialization + weighted non-linear least squares.
 */
export function triangulateForeignAp(neighbor, anchorsByHostId) {
  const band = neighbor.band || '5GHz';
  const rawObs = Array.isArray(neighbor.observations) ? neighbor.observations : [];

  // Deduplicate observations by hostId (keep strongest radio per physical OpenWrt host)
  const byHost = new Map();
  let gpsOrigin = null;

  for (const obs of rawObs) {
    const anchor = anchorsByHostId.get(obs.hostId);
    if (!anchor) continue;
    if (!gpsOrigin && anchor.gpsOrigin) {
      gpsOrigin = anchor.gpsOrigin;
    }

    const slantDistanceMeters = rssiToDistanceMeters(obs.signalDbm, band);
    obs.slantDistanceMeters = slantDistanceMeters;
    obs.distanceMeters = slantDistanceMeters;
    obs.anchorX = anchor.x;
    obs.anchorY = anchor.y;
    obs.anchorAltitude = anchor.hasAlt ? anchor.altitude : null;
    obs.anchorLatitude = anchor.hasGps ? anchor.latitude : null;
    obs.anchorLongitude = anchor.hasGps ? anchor.longitude : null;

    const existing = byHost.get(obs.hostId);
    if (!existing || obs.signalDbm > existing.signalDbm) {
      const normSig = Math.max(0.08, Math.min(1.0, ((obs.signalDbm || -85) + 98) / 63));
      byHost.set(obs.hostId, {
        hostId: obs.hostId,
        hostName: obs.hostName || anchor.hostName,
        device: obs.device,
        signalDbm: obs.signalDbm,
        slantDistanceMeters,
        distanceMeters: slantDistanceMeters,
        horizontalDistanceMeters: slantDistanceMeters,
        anchorX: anchor.x,
        anchorY: anchor.y,
        anchorAltitude: anchor.hasAlt ? anchor.altitude : null,
        anchorLatitude: anchor.hasGps ? anchor.latitude : null,
        anchorLongitude: anchor.hasGps ? anchor.longitude : null,
        hasAlt: Boolean(anchor.hasAlt),
        hasGps: Boolean(anchor.hasGps),
        weight: Math.round(normSig * normSig * 1000) / 1000,
      });
    }
  }

  const measurements = Array.from(byHost.values()).sort((a, b) => b.signalDbm - a.signalDbm);
  const apCount = measurements.length;
  if (apCount === 0) {
    return null;
  }

  // Estimate foreign AP altitude (z) if any observing OpenWrt AP has a configured altitude
  const altMeasurements = measurements.filter((m) => m.hasAlt && typeof m.anchorAltitude === 'number');
  let estAltitudeMeters = null;
  if (altMeasurements.length > 0) {
    let zWeightSum = 0;
    let zWeightedVal = 0;
    for (const m of altMeasurements) {
      const wZ = m.weight / Math.max(0.5, m.slantDistanceMeters * m.slantDistanceMeters);
      zWeightedVal += m.anchorAltitude * wZ;
      zWeightSum += wZ;
    }
    estAltitudeMeters = zWeightSum > 0 ? zWeightedVal / zWeightSum : altMeasurements[0].anchorAltitude;

    // Refine altitude with vertical path-loss gradient when APs are at different elevations
    for (let iter = 0; iter < 25; iter++) {
      let gz = 0;
      let wTot = 0;
      for (const m of altMeasurements) {
        const dz = estAltitudeMeters - m.anchorAltitude;
        const maxDz = m.slantDistanceMeters * 0.85;
        if (Math.abs(dz) > maxDz) {
          gz += m.weight * (dz - Math.sign(dz) * maxDz);
        }
        wTot += m.weight;
      }
      if (wTot > 0) {
        estAltitudeMeters -= 0.25 * (gz / wTot);
      }
    }
    estAltitudeMeters = Math.round(estAltitudeMeters * 10) / 10;

    // Project 3D slant distance onto the horizontal ground plane: d_horiz = sqrt(max(0.5^2, d_slant^2 - dz^2))
    for (const m of measurements) {
      if (m.hasAlt && typeof m.anchorAltitude === 'number') {
        const dz = Math.min(m.slantDistanceMeters * 0.88, Math.abs(estAltitudeMeters - m.anchorAltitude));
        const horiz = Math.sqrt(Math.max(0.25, m.slantDistanceMeters * m.slantDistanceMeters - dz * dz));
        m.horizontalDistanceMeters = Math.round(horiz * 10) / 10;
        m.distanceMeters = m.horizontalDistanceMeters;
      }
    }

    // Also update rawObs so UI table shows horizontal ground distance alongside slant distance
    for (const obs of rawObs) {
      const matched = byHost.get(obs.hostId);
      if (matched) {
        obs.horizontalDistanceMeters = matched.horizontalDistanceMeters;
      }
    }
  }

  // Nominal scale: 1 meter = 1.8 canvas units (or GPS-derived scale when GPS anchors exist).
  // Adapt scale so pairwise horizontal distance circles meet when anchors are placed far apart.
  let canvasScale = gpsOrigin?.canvasUnitsPerMeter || 1.8;
  if (apCount >= 2) {
    for (let i = 0; i < apCount; i++) {
      for (let j = i + 1; j < apCount; j++) {
        const m1 = measurements[i];
        const m2 = measurements[j];
        const anchorDist = Math.hypot(m2.anchorX - m1.anchorX, m2.anchorY - m1.anchorY);
        const sumMeters = m1.horizontalDistanceMeters + m2.horizontalDistanceMeters;
        if (sumMeters > 0 && sumMeters * canvasScale < anchorDist * 1.04) {
          canvasScale = (anchorDist * 1.04) / sumMeters;
        }
      }
    }
  }

  for (const m of measurements) {
    m.canvasRadius = Math.round(Math.max(3, Math.min(85, m.horizontalDistanceMeters * canvasScale)) * 10) / 10;
  }

  const hash = hashString(`${neighbor.bssid || ''}:${neighbor.ssid || ''}:${neighbor.channel || 0}`);
  let estX = measurements[0].anchorX;
  let estY = measurements[0].anchorY;
  let method = 'proximity_ring';
  let confidence = 'low';
  let confidencePct = 36;
  let errorRadiusMeters = Math.round(Math.max(3.5, measurements[0].horizontalDistanceMeters * 0.35) * 10) / 10;

  if (apCount === 1) {
    const m1 = measurements[0];
    // Bias angle outward from center (50,50) with deterministic spread per BSSID
    const outDx = m1.anchorX - 50;
    const outDy = m1.anchorY - 50;
    const baseAngle =
      Math.hypot(outDx, outDy) > 2
        ? Math.atan2(outDy, outDx)
        : ((hash % 360) * Math.PI) / 180;
    const offsetAngle = (((hash % 140) - 70) * Math.PI) / 180;
    const angle = baseAngle + offsetAngle;
    const rCanvas = Math.min(34, m1.canvasRadius);
    estX = m1.anchorX + rCanvas * Math.cos(angle);
    estY = m1.anchorY + rCanvas * Math.sin(angle);
    method = 'proximity_ring';
    confidence = 'low';
    confidencePct = Math.min(48, Math.max(25, Math.round(45 - m1.horizontalDistanceMeters * 0.4)));
  } else {
    // 2 or more APs: compute Radical Axis / Circle-Circle intersection between top 2 APs as seed
    const m1 = measurements[0];
    const m2 = measurements[1];
    const dx = m2.anchorX - m1.anchorX;
    const dy = m2.anchorY - m1.anchorY;
    const D = Math.max(0.01, Math.hypot(dx, dy));
    const ux = dx / D;
    const uy = dy / D;
    const nx = -uy;
    const ny = ux;

    const r1 = m1.canvasRadius;
    const r2 = m2.canvasRadius;

    // Radical axis distance along A -> B (can be negative if foreign AP is exterior behind A)
    const rawA = (r1 * r1 - r2 * r2 + D * D) / (2 * D);
    const a = Math.max(-r1 * 0.9, Math.min(D + r2 * 0.9, rawA));
    const hSq = Math.max(0, r1 * r1 - a * a);
    const h = Math.sqrt(hSq) * (apCount === 2 ? 0.65 : 0.9);
    const sign = hash % 2 === 0 ? 1 : -1;

    const candA = {
      x: m1.anchorX + a * ux + sign * h * nx,
      y: m1.anchorY + a * uy + sign * h * ny,
    };
    const candB = {
      x: m1.anchorX + a * ux - sign * h * nx,
      y: m1.anchorY + a * uy - sign * h * ny,
    };

    // Weighted inverse-distance centroid seed
    let wSum = 0;
    let cx = 0;
    let cy = 0;
    for (const m of measurements) {
      const invD = m.weight / Math.max(0.5, m.horizontalDistanceMeters);
      cx += m.anchorX * invD;
      cy += m.anchorY * invD;
      wSum += invD;
    }
    const candCentroid = {
      x: wSum > 0 ? cx / wSum : (m1.anchorX + m2.anchorX) / 2,
      y: wSum > 0 ? cy / wSum : (m1.anchorY + m2.anchorY) / 2,
    };

    const lossFn = (pt) => {
      let loss = 0;
      for (const m of measurements) {
        const d = Math.hypot(pt.x - m.anchorX, pt.y - m.anchorY);
        const diff = d - m.canvasRadius;
        loss += m.weight * diff * diff;
      }
      // Mild penalty if outside [6..94] bounds
      if (pt.x < 6 || pt.x > 94 || pt.y < 6 || pt.y > 94) {
        loss += 250;
      }
      return loss;
    };

    // Pick best initial seed among candA, candB, candCentroid
    let bestPt = [candA, candB, candCentroid].sort((p1, p2) => lossFn(p1) - lossFn(p2))[0];
    let curX = bestPt.x;
    let curY = bestPt.y;

    // Refine with 65 iterations of damped weighted non-linear least squares (Gauss-Newton / gradient descent)
    const totalWeight = measurements.reduce((acc, m) => acc + m.weight, 0) || 1;
    for (let iter = 0; iter < 65; iter++) {
      let gx = 0;
      let gy = 0;
      for (const m of measurements) {
        const ddx = curX - m.anchorX;
        const ddy = curY - m.anchorY;
        const dist = Math.hypot(ddx, ddy) + 1e-4;
        const residual = dist - m.canvasRadius;
        gx += m.weight * residual * (ddx / dist);
        gy += m.weight * residual * (ddy / dist);
      }
      const step = 0.45 * (1 - iter / 80);
      curX -= step * (gx / totalWeight);
      curY -= step * (gy / totalWeight);
    }

    estX = curX;
    estY = curY;

    // Compute residual RMSE in meters
    let weightedSqErrMeters = 0;
    for (const m of measurements) {
      const solvedMeters = Math.hypot(estX - m.anchorX, estY - m.anchorY) / canvasScale;
      const errM = solvedMeters - m.horizontalDistanceMeters;
      weightedSqErrMeters += m.weight * errM * errM;
    }
    const rmseMeters = Math.sqrt(weightedSqErrMeters / totalWeight);

    if (apCount >= 3) {
      method = 'trilateration';
      confidence = 'high';
      errorRadiusMeters = Math.round(Math.max(1.2, Math.min(10.0, 1.5 + rmseMeters * 0.55)) * 10) / 10;
      confidencePct = Math.min(96, Math.max(72, Math.round(92 - rmseMeters * 2.2 + Math.min(6, (apCount - 3) * 3))));
    } else {
      method = 'bilateration';
      confidence = 'medium';
      errorRadiusMeters = Math.round(Math.max(2.5, Math.min(12.0, 3.0 + rmseMeters * 0.65)) * 10) / 10;
      confidencePct = Math.min(78, Math.max(52, Math.round(70 - rmseMeters * 1.8)));
    }
  }

  estX = Math.round(Math.max(6, Math.min(94, estX)) * 10) / 10;
  estY = Math.round(Math.max(6, Math.min(94, estY)) * 10) / 10;

  const closest = measurements[0];
  const bearing = computeCompassBearing(estX - closest.anchorX, estY - closest.anchorY);
  let verticalDeltaMeters = null;
  let verticalLabel = null;
  if (estAltitudeMeters !== null && typeof closest.anchorAltitude === 'number') {
    verticalDeltaMeters = Math.round((estAltitudeMeters - closest.anchorAltitude) * 10) / 10;
    if (Math.abs(verticalDeltaMeters) < 0.8) {
      verticalLabel = `level with ${closest.hostName} (${estAltitudeMeters}m alt)`;
    } else if (verticalDeltaMeters > 0) {
      verticalLabel = `+${verticalDeltaMeters}m above ${closest.hostName} (${estAltitudeMeters}m alt)`;
    } else {
      verticalLabel = `${verticalDeltaMeters}m below ${closest.hostName} (${estAltitudeMeters}m alt)`;
    }
  }

  const bearingLabel = `~${closest.horizontalDistanceMeters}m ${bearing} of ${closest.hostName}${
    verticalLabel ? ` • ${verticalLabel}` : ''
  }`;

  // Back-project solved (estX, estY) to estimated GPS (latitude, longitude) when GPS anchors are configured
  let estLatitude = null;
  let estLongitude = null;
  if (gpsOrigin) {
    const scaleForGps = gpsOrigin.canvasUnitsPerMeter || canvasScale || 1.8;
    const eastMetersFromOrigin = (estX - 50) / scaleForGps;
    const northMetersFromOrigin = (50 - estY) / scaleForGps;
    estLatitude = Math.round((gpsOrigin.refLat + northMetersFromOrigin / gpsOrigin.metersPerDegLat) * 1e6) / 1e6;
    estLongitude = Math.round((gpsOrigin.refLng + eastMetersFromOrigin / gpsOrigin.metersPerDegLng) * 1e6) / 1e6;
  }

  return {
    x: estX,
    y: estY,
    altitudeMeters: estAltitudeMeters,
    verticalDeltaMeters,
    verticalLabel,
    latitude: estLatitude,
    longitude: estLongitude,
    gpsCalibrated: Boolean(gpsOrigin),
    altitudeCalibrated: estAltitudeMeters !== null,
    method,
    confidence,
    confidencePct,
    apCount,
    errorRadiusMeters,
    closestHostId: closest.hostId,
    closestHostName: closest.hostName,
    minDistanceMeters: closest.horizontalDistanceMeters,
    minSlantDistanceMeters: closest.slantDistanceMeters,
    bearing,
    bearingLabel,
    anchorMeasurements: measurements,
  };
}

/**
 * Enriches all bands in `bandsData` with host anchor positions (wireless hosts only) and per-neighbor RF triangulation.
 */
export function triangulateBandNeighbors(bandsData, hosts = []) {
  const wirelessHosts = filterWirelessHosts(hosts, bandsData);
  const anchors = computeHostAnchorPositions(wirelessHosts);
  const anchorsByHostId = new Map(anchors.map((a) => [a.hostId, a]));

  for (const bandInfo of Object.values(bandsData || {})) {
    if (!bandInfo) continue;
    bandInfo.anchors = anchors;
    const neighbors = bandInfo.neighbors || [];
    for (const nb of neighbors) {
      nb.triangulation = triangulateForeignAp(nb, anchorsByHostId);
    }
  }

  return bandsData;
}

