/**
 * OpenWrt Manager (openwrt-managor)
 * Reusable Sortable Data Table Component
 */

import { renderIcon } from '../utils/icons.js';

export class DataTable {
  constructor({ container, columns = [], rows = [], pageSize = 15, onRowClick = null, emptyState = null }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.columns = columns;
    this.rows = rows;
    this.pageSize = pageSize;
    this.currentPage = 1;
    this.sortKey = null;
    this.sortAsc = true;
    this.onRowClick = onRowClick;
    this.emptyState = emptyState;
  }

  setRows(newRows) {
    this.rows = newRows || [];
    this.render();
  }

  sort(key) {
    if (this.sortKey === key) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortKey = key;
      this.sortAsc = true;
    }
    this.render();
  }

  getSortedRows() {
    if (!this.sortKey) return [...this.rows];
    return [...this.rows].sort((a, b) => {
      let valA = a[this.sortKey];
      let valB = b[this.sortKey];

      if (valA === undefined || valA === null) valA = '';
      if (valB === undefined || valB === null) valB = '';

      if (typeof valA === 'number' && typeof valB === 'number') {
        return this.sortAsc ? valA - valB : valB - valA;
      }
      return this.sortAsc
        ? String(valA).localeCompare(String(valB))
        : String(valB).localeCompare(String(valA));
    });
  }

  render() {
    if (!this.container) return;

    if (this.rows.length === 0) {
      if (this.emptyState) {
        this.container.innerHTML = this.emptyState;
      } else {
        this.container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-title">No Records Found</div>
            <div class="empty-state-desc">There are currently no items matching your criteria.</div>
          </div>
        `;
      }
      return;
    }

    const sorted = this.getSortedRows();
    const totalPages = Math.ceil(sorted.length / this.pageSize) || 1;
    if (this.currentPage > totalPages) this.currentPage = totalPages;

    const start = (this.currentPage - 1) * this.pageSize;
    const pageRows = sorted.slice(start, start + this.pageSize);

    // Build Table HTML
    let html = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
    `;

    for (const col of this.columns) {
      let sortIcon = '';
      if (col.sortable) {
        if (this.sortKey === col.key) {
          sortIcon = this.sortAsc ? ' ↑' : ' ↓';
        }
      }
      html += `<th data-key="${col.key}" class="${col.sortable ? 'sortable' : ''}">${col.label}${sortIcon}</th>`;
    }

    html += `
            </tr>
          </thead>
          <tbody>
    `;

    for (let idx = 0; idx < pageRows.length; idx++) {
      const row = pageRows[idx];
      html += `<tr data-index="${start + idx}">`;
      for (const col of this.columns) {
        const val = col.render ? col.render(row) : (row[col.key] ?? '');
        html += `<td>${val}</td>`;
      }
      html += `</tr>`;
    }

    html += `
          </tbody>
        </table>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--color-border); font-size: 12px; color: var(--color-text-secondary);">
        <div>Showing ${start + 1}–${Math.min(start + this.pageSize, sorted.length)} of ${sorted.length} records</div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary btn-prev" ${this.currentPage <= 1 ? 'disabled' : ''}>Previous</button>
          <span style="display: flex; align-items: center; padding: 0 4px;">Page ${this.currentPage} of ${totalPages}</span>
          <button type="button" class="btn btn-secondary btn-next" ${this.currentPage >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    this.container.innerHTML = html;

    // Attach Event Listeners
    const ths = this.container.querySelectorAll('th.sortable');
    ths.forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-key');
        if (key) this.sort(key);
      });
    });

    if (this.onRowClick) {
      const trs = this.container.querySelectorAll('tbody tr');
      trs.forEach(tr => {
        tr.addEventListener('click', () => {
          const index = parseInt(tr.getAttribute('data-index'), 10);
          if (!isNaN(index) && sorted[index]) {
            this.onRowClick(sorted[index]);
          }
        });
      });
    }

    const prevBtn = this.container.querySelector('.btn-prev');
    const nextBtn = this.container.querySelector('.btn-next');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.currentPage > 1) {
          this.currentPage--;
          this.render();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.currentPage < totalPages) {
          this.currentPage++;
          this.render();
        }
      });
    }
  }
}
