// ─────────────────────────────────────────────────────────────────
//  Mapleproof — admin.js
//  - Token-gated user management UI
//  - List, search, view, delete users
//  - Token kept only in sessionStorage (cleared on browser close)
// ─────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const SS_KEY = 'mapleproof_admin_token';

  const loginSection = document.getElementById('login-section');
  const adminSection = document.getElementById('admin-section');
  const tokenInput   = document.getElementById('admin-token-input');
  const loginBtn     = document.getElementById('login-btn');
  const loginErr     = document.getElementById('login-error');
  const logoutBtn    = document.getElementById('logout-btn');
  const refreshBtn   = document.getElementById('refresh-btn');
  const searchInput  = document.getElementById('search-input');
  const grid         = document.getElementById('users-grid');
  const emptyMsg     = document.getElementById('users-empty');

  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmTokenEl = document.getElementById('confirm-token');
  const cancelDelete   = document.getElementById('cancel-delete');
  const confirmDelete  = document.getElementById('confirm-delete');

  let pendingDeleteToken = null;
  let searchDebounce = null;

  // ── Token storage (sessionStorage, cleared on close) ────────────
  function getToken()  { return sessionStorage.getItem(SS_KEY) || ''; }
  function setToken(t) { sessionStorage.setItem(SS_KEY, t); }
  function clearToken(){ sessionStorage.removeItem(SS_KEY); }

  function authHeaders() {
    return { 'Authorization': `Bearer ${getToken()}` };
  }

  // ── Login flow ──────────────────────────────────────────────────
  async function tryLogin(token) {
    loginErr.hidden = true;
    try {
      const resp = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!resp.ok) throw new Error('bad token');
      setToken(token);
      showAdmin();
    } catch {
      loginErr.textContent = 'Invalid admin token. Check the server console.';
      loginErr.hidden = false;
    }
  }

  loginBtn.addEventListener('click', () => {
    const t = tokenInput.value.trim();
    if (t) tryLogin(t);
  });
  tokenInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginBtn.click();
  });

  logoutBtn.addEventListener('click', () => {
    clearToken();
    loginSection.hidden = false;
    adminSection.hidden = true;
    tokenInput.value = '';
    tokenInput.focus();
  });

  // ── Admin dashboard ─────────────────────────────────────────────
  async function showAdmin() {
    loginSection.hidden = true;
    adminSection.hidden = false;
    await Promise.all([loadStats(), loadUsers()]);
  }

  async function loadStats() {
    try {
      const resp = await fetch('/api/admin/stats', { headers: authHeaders() });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) return;
      const s = data.stats;
      document.getElementById('stat-total').textContent   = s.total;
      document.getElementById('stat-19').textContent      = s.tier19Plus;
      document.getElementById('stat-25').textContent      = s.tier25Plus;
      document.getElementById('stat-expired').textContent = s.expired;
      document.getElementById('stat-scans').textContent   = s.totalScans;
      const fraudEl = document.getElementById('stat-fraud');
      const delEl   = document.getElementById('stat-deletions');
      const retEl   = document.getElementById('stat-retailers');
      const retPEl  = document.getElementById('stat-retailers-pending');
      if (fraudEl) fraudEl.textContent = s.fraudHolds || 0;
      if (delEl)   delEl.textContent   = s.pendingDeletions || 0;
      if (retEl)   retEl.textContent   = s.retailerCount || 0;
      if (retPEl)  retPEl.textContent  = s.pendingRetailers || 0;
    } catch (err) { console.error(err); }
  }

  async function loadUsers(query = '') {
    grid.innerHTML = '<p class="loading">Loading…</p>';
    try {
      const url = query
        ? `/api/admin/users?q=${encodeURIComponent(query)}`
        : '/api/admin/users';
      const resp = await fetch(url, { headers: authHeaders() });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) {
        grid.innerHTML = `<p class="loading">${data.error || 'Failed to load.'}</p>`;
        return;
      }
      renderUsers(data.users);
    } catch (err) {
      grid.innerHTML = '<p class="loading">Network error.</p>';
    }
  }

  function renderUsers(users) {
    if (!users.length) {
      grid.innerHTML = '';
      emptyMsg.hidden = false;
      return;
    }
    emptyMsg.hidden = true;
    grid.innerHTML = users.map(u => {
      const tierBadgeClass =
        u.ageBadge === '25+' ? 'tier-25' :
        u.ageBadge === '19+' ? 'tier-19' :
        u.ageBadge === '18+' ? 'tier-18' : 'tier-under';
      const expClass =
        u.expiryStatus === 'expired'        ? 'exp-bad' :
        u.expiryStatus === 'expiring_soon'  ? 'exp-warn' : 'exp-ok';
      const nextTierBadge = u.nextTierIn
        ? `<span class="next-tier" title="Days until next age tier">→ ${u.nextTierIn.nextTier} in ${u.nextTierIn.days}d</span>`
        : '';
      const lastSeen = u.lastSeenAt
        ? `Last scanned ${formatRelative(u.lastSeenAt)}`
        : 'Never scanned';
      return `
        <div class="user-card" data-token="${escapeAttr(u.token)}">
          <img class="user-thumb" src="${escapeAttr(u.thumbnail || '')}" alt="">
          <div class="user-meta">
            <div class="user-token">${escapeHtml(u.token)}</div>
            <div class="user-row">
              <span class="badge ${tierBadgeClass}">${u.ageBadge}</span>
              <span class="user-age">age ${u.age}</span>
              ${nextTierBadge}
            </div>
            <div class="user-row small">
              <span class="${expClass}">ID expires ${formatDate(u.expiry)}</span>
              <span>·</span>
              <span>${u.scanCount} scans</span>
            </div>
            <div class="user-row small muted">
              <span>${lastSeen}</span>
            </div>
            <div class="user-actions">
              <button class="btn-danger small" data-delete="${escapeAttr(u.token)}">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');

    // Wire delete buttons
    grid.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => askDelete(btn.dataset.delete));
    });
  }

  // ── Delete confirmation ─────────────────────────────────────────
  function askDelete(token) {
    pendingDeleteToken = token;
    confirmTokenEl.textContent = token;
    confirmOverlay.hidden = false;
  }
  cancelDelete.addEventListener('click', () => {
    pendingDeleteToken = null;
    confirmOverlay.hidden = true;
  });
  confirmDelete.addEventListener('click', async () => {
    if (!pendingDeleteToken) return;
    try {
      const resp = await fetch(`/api/admin/users/${encodeURIComponent(pendingDeleteToken)}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) {
        alert(data.error || 'Delete failed.');
        return;
      }
      confirmOverlay.hidden = true;
      pendingDeleteToken = null;
      await Promise.all([loadStats(), loadUsers(searchInput.value.trim())]);
    } catch (err) {
      alert('Network error during delete.');
    }
  });

  // ── Search + refresh ────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadUsers(searchInput.value.trim()), 250);
  });
  refreshBtn.addEventListener('click', () => {
    Promise.all([loadStats(), loadUsers(searchInput.value.trim())]);
  });

  // Auto-refresh every 30 seconds while idle (so age tiers stay live)
  setInterval(() => {
    if (!adminSection.hidden && document.visibilityState === 'visible') {
      loadStats();
      loadUsers(searchInput.value.trim());
    }
  }, 30_000);

  // ── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function formatRelative(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }

  // ── TABS ───────────────────────────────────────────────────────
  document.querySelectorAll('.admin-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.admin-tabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.admin-tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `tab-${tab}`);
      });
      // Lazy-load tab data on first open
      if (tab === 'retailers') loadRetailers();
      if (tab === 'audit')     loadAuditLog();
      if (tab === 'deletions') loadDeletions();
    });
  });

  // ── RETAILERS ──────────────────────────────────────────────────
  async function loadRetailers() {
    const tbody = document.getElementById('retailers-tbody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#5a7065;padding:30px;">Loading…</td></tr>';
    try {
      const resp = await fetch('/api/admin/retailers', { headers: authHeaders() });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) return;
      if (!data.retailers.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#5a7065;padding:30px;">No retailers yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.retailers.map(r => `
        <tr>
          <td>${escapeHtml(r.business_name)}<br><small style="color:#5a7065;font-family:monospace;">${escapeHtml(r.retailer_id)}</small></td>
          <td>${escapeHtml(r.store_name || '—')}<br><small style="color:#5a7065;">${escapeHtml(r.store_address || '')}</small></td>
          <td>${escapeHtml(r.contact_email || '—')}</td>
          <td>${formatRelative(r.created_at)}</td>
          <td>${r.last_used_at ? formatRelative(r.last_used_at) : '—'}</td>
          <td>${r.active
              ? '<span class="retailer-badge-active">Active</span>'
              : '<span class="retailer-badge-pending">Pending</span>'}</td>
          <td>
            ${!r.active ? `<button class="btn-mini" onclick="approveRetailer('${escapeAttr(r.retailer_id)}')">Approve</button>` : ''}
            ${r.active  ? `<button class="btn-mini btn-mini-danger" onclick="disableRetailer('${escapeAttr(r.retailer_id)}')">Disable</button>` : ''}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#c8362b;padding:30px;">Network error.</td></tr>';
    }
  }
  window.approveRetailer = async function(id) {
    const resp = await fetch(`/api/admin/retailers/${id}/approve`, { method: 'POST', headers: authHeaders() });
    if (resp.ok) { loadRetailers(); loadStats(); }
    else alert('Failed to approve.');
  };
  window.disableRetailer = async function(id) {
    if (!confirm(`Disable retailer ${id}? Their API key will stop working immediately.`)) return;
    const resp = await fetch(`/api/admin/retailers/${id}/disable`, { method: 'POST', headers: authHeaders() });
    if (resp.ok) { loadRetailers(); loadStats(); }
    else alert('Failed to disable.');
  };
  document.getElementById('refresh-retailers-btn')?.addEventListener('click', loadRetailers);

  // ── AUDIT LOG ──────────────────────────────────────────────────
  async function loadAuditLog() {
    const tbody = document.getElementById('audit-tbody');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#5a7065;padding:30px;">Loading…</td></tr>';
    try {
      const resp = await fetch('/api/admin/audit-log?limit=200', { headers: authHeaders() });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) return;
      if (!data.entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#5a7065;padding:30px;">No audit entries yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.entries.map(e => `
        <tr>
          <td class="col-ts">${new Date(e.ts).toISOString().replace('T',' ').substring(0,19)}</td>
          <td>${escapeHtml(e.actor)}</td>
          <td class="col-action">${escapeHtml(e.action)}</td>
          <td class="col-target">${escapeHtml(e.target || '—')}</td>
          <td style="font-family:monospace;font-size:11px;color:#5a7065;">${escapeHtml(e.ip || '—')}</td>
          <td class="col-details">${escapeHtml(e.details || '—')}</td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#c8362b;padding:30px;">Network error.</td></tr>';
    }
  }
  document.getElementById('refresh-audit-btn')?.addEventListener('click', loadAuditLog);
  document.getElementById('verify-audit-btn')?.addEventListener('click', async () => {
    const banner = document.getElementById('audit-integrity-banner');
    banner.innerHTML = '<div class="integrity-banner" style="background:#f3f7f4;color:#5a7065;">Verifying chain…</div>';
    try {
      const resp = await fetch('/api/admin/audit-verify', { headers: authHeaders() });
      const data = await resp.json();
      if (data.integrity.ok) {
        banner.innerHTML = `<div class="integrity-banner integrity-ok">✓ Audit chain verified. ${data.integrity.count} entries, no tampering detected.</div>`;
      } else {
        banner.innerHTML = `<div class="integrity-banner integrity-bad">✗ TAMPERING DETECTED at entry #${data.integrity.brokenAt}. ${data.integrity.reason || 'Hash mismatch.'}</div>`;
      }
    } catch (err) {
      banner.innerHTML = '<div class="integrity-banner integrity-bad">Verification failed: network error.</div>';
    }
  });

  // ── DELETIONS ──────────────────────────────────────────────────
  async function loadDeletions() {
    const tbody = document.getElementById('deletions-tbody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#5a7065;padding:30px;">Loading…</td></tr>';
    try {
      const resp = await fetch('/api/admin/deletion-requests', { headers: authHeaders() });
      if (resp.status === 401) return logoutBtn.click();
      const data = await resp.json();
      if (!data.ok) return;
      if (!data.requests.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#5a7065;padding:30px;">No pending deletion requests.</td></tr>';
        return;
      }
      tbody.innerHTML = data.requests.map(r => `
        <tr>
          <td style="font-family:monospace;">${escapeHtml(r.token)}</td>
          <td>${formatRelative(r.requested_at)}</td>
          <td>${escapeHtml(r.reason || '—')}</td>
          <td><button class="btn-mini btn-mini-danger" onclick="executeDeletion(${r.id})">Execute deletion</button></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#c8362b;padding:30px;">Network error.</td></tr>';
    }
  }
  window.executeDeletion = async function(id) {
    if (!confirm(`Execute deletion request #${id}? This permanently removes the customer.`)) return;
    const resp = await fetch(`/api/admin/deletion-requests/${id}/execute`, { method: 'POST', headers: authHeaders() });
    if (resp.ok) { loadDeletions(); loadStats(); }
    else alert('Failed to execute deletion.');
  };
  document.getElementById('refresh-deletions-btn')?.addEventListener('click', loadDeletions);

  // ── Boot ────────────────────────────────────────────────────────
  if (getToken()) {
    tryLogin(getToken());
  } else {
    tokenInput.focus();
  }
})();
