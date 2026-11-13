/**
 * OpenWrt Manager (openwrt-managor)
 * High-Contrast UCI Configuration Diff Renderer
 */

export function renderDiff(diffData) {
  if (!diffData) {
    return `<div class="empty-state"><p class="empty-state-desc">No diff data available.</p></div>`;
  }

  if (!diffData.hasDifferences && (!diffData.hunks || diffData.hunks.length === 0)) {
    return `
      <div class="empty-state" style="padding: 24px;">
        <p class="empty-state-title" style="font-size: 14px; color: var(--color-success);">No Configuration Differences Found</p>
        <p class="empty-state-desc" style="font-size: 12px;">The selected configuration files in both backup archives are identical.</p>
      </div>
    `;
  }

  const hunks = diffData.hunks || [];
  let html = `<div class="diff-viewer" role="region" aria-label="Configuration File Differences">`;

  let oldLineNum = 1;
  let newLineNum = 1;

  for (const hunk of hunks) {
    if (hunk.oldStart) oldLineNum = hunk.oldStart;
    if (hunk.newStart) newLineNum = hunk.newStart;

    html += `
      <div class="diff-hunk-header" style="padding: 4px 8px; background: var(--color-surface-hover); color: var(--color-text-muted); font-size: 11px;">
        @@ -${hunk.oldStart || 1},${hunk.oldLines || 0} +${hunk.newStart || 1},${hunk.newLines || 0} @@
      </div>
    `;

    for (const line of hunk.lines) {
      const type = line.type || 'context';
      let sign = ' ';
      let leftNum = '';
      let rightNum = '';

      if (type === 'delete') {
        sign = '-';
        leftNum = oldLineNum++;
      } else if (type === 'add') {
        sign = '+';
        rightNum = newLineNum++;
      } else {
        sign = ' ';
        leftNum = oldLineNum++;
        rightNum = newLineNum++;
      }

      const escapedText = escapeHtml(line.text || '');

      html += `
        <div class="diff-line ${type}">
          <span class="diff-num">${leftNum}</span>
          <span class="diff-num">${rightNum}</span>
          <span class="diff-sign">${sign}</span>
          <span class="diff-text">${escapedText}</span>
        </div>
      `;
    }
  }

  html += `</div>`;
  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
