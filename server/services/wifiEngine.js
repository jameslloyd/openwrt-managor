/**
 * WiFi Spectrum Analyzer and Interference Engine
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

/**
 * Analyzes active radios across all bands and identifies co-channel and adjacent-channel interference.
 */
export function analyzeInterference(bandsData) {
  const warnings = [];
  let scoreDeductions = 0;

  for (const [bandName, bandInfo] of Object.entries(bandsData)) {
    const radios = bandInfo.radios || [];
    if (radios.length < 2) continue;

    for (let i = 0; i < radios.length; i++) {
      for (let j = i + 1; j < radios.length; j++) {
        const r1 = radios[i];
        const r2 = radios[j];

        const f1Start = r1.centerFreqMhz - r1.widthMhz / 2;
        const f1End = r1.centerFreqMhz + r1.widthMhz / 2;
        const f2Start = r2.centerFreqMhz - r2.widthMhz / 2;
        const f2End = r2.centerFreqMhz + r2.widthMhz / 2;

        const isOverlapping = Math.max(f1Start, f2Start) < Math.min(f1End, f2End);

        if (isOverlapping) {
          const isExactChannel = r1.channel === r2.channel;
          const warningId = `warn-${isExactChannel ? 'cci' : 'aci'}-${r1.id}-${r2.id}`;

          if (isExactChannel) {
            const severity = bandName === '2.4GHz' ? 'medium' : 'high';
            scoreDeductions += bandName === '2.4GHz' ? 10 : 15;

            let recommendation = `Recommend moving ${r2.hostName} to a non-overlapping channel.`;
            if (bandName === '2.4GHz') {
              recommendation = `${r1.hostName} and ${r2.hostName} share 2.4GHz Channel ${r1.channel}. Recommend moving ${r2.hostName} to Channel 11 or Channel 1.`;
            } else if (bandName === '5GHz') {
              recommendation = `${r1.hostName} and ${r2.hostName} share 5GHz Channel ${r1.channel} (${r1.widthMhz}MHz). Recommend moving ${r2.hostName} to UNII-3 Channel 149 or UNII-2C DFS Channel 100.`;
            }

            warnings.push({
              id: warningId,
              type: 'co_channel',
              severity,
              band: bandName,
              channel: r1.channel,
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
              affectedRadios: [r1.id, r2.id],
              message: `Adjacent channel overlap between ${r1.hostName} (Ch ${r1.channel}) and ${r2.hostName} (Ch ${r2.channel}) on ${bandName}. Causes frame collisions.`,
            });
          }
        }
      }
    }
  }

  const healthScore = Math.max(0, 100 - scoreDeductions);
  let status = 'optimal';
  if (warnings.length > 0) {
    status = healthScore < 75 ? 'critical' : 'warning';
  }

  return {
    summary: {
      status,
      warningsCount: warnings.length,
      healthScore,
    },
    warnings,
  };
}
