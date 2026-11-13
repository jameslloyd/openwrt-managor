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
