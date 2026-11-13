/**
 * Computes the Longest Common Subsequence (LCS) matrix for two arrays of strings.
 */
function computeLcs(aLines, bLines) {
  const m = aLines.length;
  const n = bLines.length;
  // Use typed array or 1D array if small to moderate
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (aLines[i] === bLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  return dp;
}

/**
 * Builds raw line diff actions ('context', 'delete', 'add') from LCS matrix.
 */
function buildDiffOps(aLines, bLines) {
  const dp = computeLcs(aLines, bLines);
  let i = aLines.length;
  let j = bLines.length;
  const ops = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: 'context', text: aLines[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', text: bLines[j - 1], newLine: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      ops.push({ type: 'delete', text: aLines[i - 1], oldLine: i });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Groups diff operations into unified diff hunks with context lines.
 * @param {string} oldText
 * @param {string} newText
 * @param {number} contextLines
 */
export function computeDiff(oldText = '', newText = '', contextLines = 3) {
  const aLines = oldText ? oldText.split(/\r?\n/) : [];
  const bLines = newText ? newText.split(/\r?\n/) : [];

  if (oldText === newText) {
    return {
      hasDifferences: false,
      hunks: [],
    };
  }

  const ops = buildDiffOps(aLines, bLines);
  const diffIndices = [];

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'context') {
      diffIndices.push(i);
    }
  }

  if (diffIndices.length === 0) {
    return {
      hasDifferences: false,
      hunks: [],
    };
  }

  // Group diff indices within 2 * contextLines of each other into clusters
  const clusters = [];
  let currentCluster = [diffIndices[0]];

  for (let k = 1; k < diffIndices.length; k++) {
    const idx = diffIndices[k];
    const prevIdx = diffIndices[k - 1];
    if (idx - prevIdx <= 2 * contextLines + 1) {
      currentCluster.push(idx);
    } else {
      clusters.push(currentCluster);
      currentCluster = [idx];
    }
  }
  clusters.push(currentCluster);

  const hunks = [];

  for (const cluster of clusters) {
    const startIdx = Math.max(0, cluster[0] - contextLines);
    const endIdx = Math.min(ops.length - 1, cluster[cluster.length - 1] + contextLines);

    const slice = ops.slice(startIdx, endIdx + 1);

    // Compute oldStart, oldLines, newStart, newLines
    let oldStart = 1;
    let newStart = 1;
    let oldLinesCount = 0;
    let newLinesCount = 0;

    // Find the starting line numbers
    let foundOld = false;
    let foundNew = false;
    for (const op of slice) {
      if (!foundOld && (op.type === 'context' || op.type === 'delete')) {
        oldStart = op.oldLine;
        foundOld = true;
      }
      if (!foundNew && (op.type === 'context' || op.type === 'add')) {
        newStart = op.newLine;
        foundNew = true;
      }
      if (op.type === 'context' || op.type === 'delete') {
        oldLinesCount++;
      }
      if (op.type === 'context' || op.type === 'add') {
        newLinesCount++;
      }
    }

    hunks.push({
      oldStart,
      oldLines: oldLinesCount,
      newStart,
      newLines: newLinesCount,
      lines: slice.map((op) => ({
        type: op.type,
        text: op.text,
      })),
    });
  }

  return {
    hasDifferences: true,
    hunks,
  };
}
