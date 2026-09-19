let adminToken = localStorage.getItem('syncchat_admin_token') || null;

const authScreen = document.getElementById('authScreen');
const appEl = document.getElementById('app');
const authHeading = document.getElementById('authHeading');
const authSub = document.getElementById('authSub');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authStatus = document.getElementById('authStatus');

let isBootstrap = false;

function authHeaders() {
  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 2500);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- Bootstrap / login ----
async function initAuth() {
  const status = await fetch('/api/admin/bootstrap-status').then(r => r.json());
  isBootstrap = !status.hasAdmin;
  if (isBootstrap) {
    authHeading.textContent = 'Create Admin Account';
    authSub.textContent = 'No admin account exists yet. Create the first one — this only works once.';
    authSubmitBtn.textContent = 'Create Account';
  } else {
    authHeading.textContent = 'Admin Login';
    authSub.textContent = 'Sign in to manage SyncChat — users, reports, ads, premium plans, and monetization settings.';
    authSubmitBtn.textContent = 'Log In';
  }
  if (adminToken) {
    // Just trust the stored token; a real deploy would verify it here too,
    // but any protected call will 401 and bounce back to login if it's stale.
    enterApp();
  }
}

authSubmitBtn.addEventListener('click', async () => {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) {
    authStatus.textContent = 'Enter a username and password.';
    authStatus.className = 'err';
    return;
  }
  authSubmitBtn.disabled = true;
  try {
    const endpoint = isBootstrap ? '/api/admin/bootstrap' : '/api/admin/login';
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    adminToken = data.token;
    localStorage.setItem('syncchat_admin_token', adminToken);
    enterApp();
  } catch (e) {
    authStatus.textContent = e.message;
    authStatus.className = 'err';
  } finally {
    authSubmitBtn.disabled = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('syncchat_admin_token');
  location.reload();
});

function enterApp() {
  authScreen.style.display = 'none';
  appEl.style.display = 'flex';
  loadDashboard();
}

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.getElementById(`page-${page}`).classList.add('active');
    if (page === 'dashboard') loadDashboard();
    if (page === 'users') loadUsers();
    if (page === 'reports') loadReports();
    if (page === 'ads') loadAds();
    if (page === 'premium') loadPlans();
    if (page === 'monetization') loadMonetization();
    if (page === 'match-settings') loadMatchSettings();
  });
});

// ---- Dashboard ----
async function loadDashboard() {
  try {
    const d = await api('GET', '/api/dashboard');
    const cards = [
      ['Total Users', d.totalUsers], ['Banned', d.bannedUsers], ['Premium', d.premiumUsers],
      ['Conversations', d.totalConversations], ['Messages', d.totalMessages],
      ['Reports Filed', d.totalReports], ['Active Ads', d.activeAds], ['Active Plans', d.activePlans]
    ];
    document.getElementById('statGrid').innerHTML = cards.map(([lbl, num]) =>
      `<div class="stat-card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`
    ).join('');
  } catch (e) { handleAuthError(e); }
}

function handleAuthError(e) {
  if (e.message === 'Not authenticated') {
    localStorage.removeItem('syncchat_admin_token');
    location.reload();
  } else {
    showToast(e.message);
  }
}

// ---- Users ----
let userFilterState = 'all';
let userSearchState = '';

async function loadUsers() {
  try {
    const params = new URLSearchParams({ filter: userFilterState, q: userSearchState });
    const { users } = await api('GET', `/api/users?${params}`);
    const tbody = document.getElementById('usersTableBody');
    document.getElementById('usersEmpty').style.display = users.length ? 'none' : 'block';
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${u.gender || '—'}</td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
        <td>
          ${u.is_banned ? '<span class="pill banned">Banned</span>' : '<span class="pill active">Active</span>'}
          ${u.is_premium ? '<span class="pill premium">Premium</span>' : ''}
        </td>
        <td>
          ${u.is_banned
            ? `<button class="btn-sm accent" data-unban="${u.id}">Unban</button>`
            : `<button class="btn-sm danger" data-ban="${u.id}">Ban</button>`}
          <button class="btn-sm" data-premium="${u.id}" data-current="${u.is_premium}">${u.is_premium ? 'Remove Premium' : 'Grant Premium'}</button>
        </td>
      </tr>
    `).join('');
  } catch (e) { handleAuthError(e); }
}

document.getElementById('usersTableBody').addEventListener('click', async (e) => {
  const banId = e.target.dataset.ban;
  const unbanId = e.target.dataset.unban;
  const premiumId = e.target.dataset.premium;
  try {
    if (banId) { await api('POST', `/api/users/${banId}/ban`); showToast('User banned.'); loadUsers(); }
    if (unbanId) { await api('POST', `/api/users/${unbanId}/unban`); showToast('User unbanned.'); loadUsers(); }
    if (premiumId) {
      const isCurrentlyPremium = e.target.dataset.current === '1';
      await api('POST', `/api/users/${premiumId}/premium`, { isPremium: !isCurrentlyPremium });
      showToast(isCurrentlyPremium ? 'Premium removed.' : 'Premium granted.');
      loadUsers();
    }
  } catch (e2) { handleAuthError(e2); }
});

document.getElementById('userSearch').addEventListener('input', debounce((e) => {
  userSearchState = e.target.value;
  loadUsers();
}, 300));
document.getElementById('userFilter').addEventListener('change', (e) => {
  userFilterState = e.target.value;
  loadUsers();
});

// ---- Reports ----
async function loadReports() {
  try {
    const { reports } = await api('GET', '/api/reports');
    const tbody = document.getElementById('reportsTableBody');
    document.getElementById('reportsEmpty').style.display = reports.length ? 'none' : 'block';
    const reasonLabels = { incorrect_gender: 'Incorrect gender', inappropriate: 'Inappropriate', fraud: 'Fraud / scam', other: 'Other' };
    tbody.innerHTML = reports.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.reported_username || 'Deleted user')}</strong></td>
        <td>${reasonLabels[r.reason] || escapeHtml(r.reason)}</td>
        <td style="max-width:160px; white-space:normal;">${r.details ? escapeHtml(r.details) : '<span style="color:var(--muted-2)">—</span>'}</td>
        <td>${escapeHtml(r.reporter_username || 'Deleted user')}</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.reported_is_banned ? '<span class="pill banned">Banned</span>' : '<span class="pill muted">Not banned</span>'}</td>
        <td>${r.reported_is_banned ? `<button class="btn-sm accent" data-reverse="${r.reported_id}">Reverse Ban</button>` : ''}</td>
      </tr>
    `).join('');
  } catch (e) { handleAuthError(e); }
}

document.getElementById('reportsTableBody').addEventListener('click', async (e) => {
  const id = e.target.dataset.reverse;
  if (!id) return;
  try {
    await api('POST', `/api/reports/${id}/reverse-ban`);
    showToast('Ban reversed.');
    loadReports();
  } catch (e2) { handleAuthError(e2); }
});

// ---- Ads ----
let editingAdId = null;
async function loadAds() {
  try {
    const { ads } = await api('GET', '/api/ads');
    document.getElementById('adsEmpty').style.display = ads.length ? 'none' : 'block';
    const placementLabels = { gate: 'Onboarding / Gate', chat_banner: 'In-chat banner', history_panel: 'History panel' };
    document.getElementById('adsList').innerHTML = ads.map(a => `
      <div class="card">
        <div class="item-row">
          <div class="left">
            <div class="title">${escapeHtml(a.title)} ${a.enabled ? '<span class="pill active">Live</span>' : '<span class="pill muted">Off</span>'}</div>
            <div class="desc">${placementLabels[a.placement] || a.placement} · ${a.impressions} impressions · ${a.clicks} clicks</div>
          </div>
          <div class="right">
            <button class="btn-sm" data-edit-ad="${a.id}">Edit</button>
            <button class="btn-sm danger" data-delete-ad="${a.id}">Delete</button>
          </div>
        </div>
      </div>
    `).join('');
    window._ads = ads;
  } catch (e) { handleAuthError(e); }
}

document.getElementById('adsList').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editAd;
  const delId = e.target.dataset.deleteAd;
  if (editId) openAdModal(window._ads.find(a => a.id === editId));
  if (delId) {
    if (!confirm('Delete this ad?')) return;
    try { await api('DELETE', `/api/ads/${delId}`); showToast('Ad deleted.'); loadAds(); } catch (e2) { handleAuthError(e2); }
  }
});

document.getElementById('newAdBtn').addEventListener('click', () => openAdModal(null));
function openAdModal(ad) {
  editingAdId = ad ? ad.id : null;
  document.getElementById('adModalTitle').textContent = ad ? 'Edit Ad' : 'New Ad';
  document.getElementById('adTitle').value = ad ? ad.title : '';
  document.getElementById('adBody').value = ad ? (ad.body || '') : '';
  document.getElementById('adImageUrl').value = ad ? (ad.image_url || '') : '';
  document.getElementById('adLinkUrl').value = ad ? (ad.link_url || '') : '';
  document.getElementById('adPlacement').value = ad ? ad.placement : 'gate';
  document.getElementById('adEnabled').checked = ad ? !!ad.enabled : true;
  document.getElementById('adModalBackdrop').style.display = 'block';
  document.getElementById('adModal').style.display = 'block';
}
function closeAdModal() {
  document.getElementById('adModalBackdrop').style.display = 'none';
  document.getElementById('adModal').style.display = 'none';
}
document.getElementById('adCancelBtn').addEventListener('click', closeAdModal);
document.getElementById('adModalBackdrop').addEventListener('click', closeAdModal);
document.getElementById('adSaveBtn').addEventListener('click', async () => {
  const payload = {
    title: document.getElementById('adTitle').value.trim(),
    body: document.getElementById('adBody').value.trim(),
    imageUrl: document.getElementById('adImageUrl').value.trim(),
    linkUrl: document.getElementById('adLinkUrl').value.trim(),
    placement: document.getElementById('adPlacement').value,
    enabled: document.getElementById('adEnabled').checked
  };
  if (!payload.title) { showToast('Title is required.'); return; }
  try {
    if (editingAdId) await api('PUT', `/api/ads/${editingAdId}`, payload);
    else await api('POST', '/api/ads', payload);
    showToast('Ad saved.');
    closeAdModal();
    loadAds();
  } catch (e) { handleAuthError(e); }
});

// ---- Premium plans ----
let editingPlanId = null;
async function loadPlans() {
  try {
    const { plans } = await api('GET', '/api/premium-plans');
    document.getElementById('plansEmpty').style.display = plans.length ? 'none' : 'block';
    document.getElementById('plansList').innerHTML = plans.map(p => `
      <div class="card">
        <div class="item-row">
          <div class="left">
            <div class="title">${escapeHtml(p.name)} ${p.enabled ? '<span class="pill active">Live</span>' : '<span class="pill muted">Off</span>'}</div>
            <div class="desc">${formatPrice(p.price_cents, p.currency)} / ${p.interval} · ${p.features.length} feature${p.features.length === 1 ? '' : 's'}</div>
          </div>
          <div class="right">
            <button class="btn-sm" data-edit-plan="${p.id}">Edit</button>
            <button class="btn-sm danger" data-delete-plan="${p.id}">Delete</button>
          </div>
        </div>
      </div>
    `).join('');
    window._plans = plans;
  } catch (e) { handleAuthError(e); }
}

function formatPrice(cents, currency) {
  if (!cents) return 'Free';
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

document.getElementById('plansList').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editPlan;
  const delId = e.target.dataset.deletePlan;
  if (editId) openPlanModal(window._plans.find(p => p.id === editId));
  if (delId) {
    if (!confirm('Delete this plan?')) return;
    try { await api('DELETE', `/api/premium-plans/${delId}`); showToast('Plan deleted.'); loadPlans(); } catch (e2) { handleAuthError(e2); }
  }
});

document.getElementById('newPlanBtn').addEventListener('click', () => openPlanModal(null));
function openPlanModal(plan) {
  editingPlanId = plan ? plan.id : null;
  document.getElementById('planModalTitle').textContent = plan ? 'Edit Plan' : 'New Plan';
  document.getElementById('planName').value = plan ? plan.name : '';
  document.getElementById('planPrice').value = plan ? plan.price_cents : '';
  document.getElementById('planCurrency').value = plan ? plan.currency : 'USD';
  document.getElementById('planInterval').value = plan ? plan.interval : 'monthly';
  document.getElementById('planFeatures').value = plan ? plan.features.join('\n') : '';
  document.getElementById('planEnabled').checked = plan ? !!plan.enabled : true;
  document.getElementById('planModalBackdrop').style.display = 'block';
  document.getElementById('planModal').style.display = 'block';
}
function closePlanModal() {
  document.getElementById('planModalBackdrop').style.display = 'none';
  document.getElementById('planModal').style.display = 'none';
}
document.getElementById('planCancelBtn').addEventListener('click', closePlanModal);
document.getElementById('planModalBackdrop').addEventListener('click', closePlanModal);
document.getElementById('planSaveBtn').addEventListener('click', async () => {
  const payload = {
    name: document.getElementById('planName').value.trim(),
    priceCents: parseInt(document.getElementById('planPrice').value, 10) || 0,
    currency: document.getElementById('planCurrency').value.trim() || 'USD',
    interval: document.getElementById('planInterval').value,
    features: document.getElementById('planFeatures').value.split('\n').map(s => s.trim()).filter(Boolean),
    enabled: document.getElementById('planEnabled').checked
  };
  if (!payload.name) { showToast('Plan name is required.'); return; }
  try {
    if (editingPlanId) await api('PUT', `/api/premium-plans/${editingPlanId}`, payload);
    else await api('POST', '/api/premium-plans', payload);
    showToast('Plan saved.');
    closePlanModal();
    loadPlans();
  } catch (e) { handleAuthError(e); }
});

// ---- Monetization settings ----
async function loadMonetization() {
  try {
    const { settings } = await api('GET', '/api/settings');
    document.getElementById('autoBanToggle').checked = !!settings.auto_ban_on_report;
    document.getElementById('videoUnlockThresholdInput').value = settings.video_unlock_threshold_per_side ?? 10;
    renderMonetizationMethods(settings.monetization_methods || {});
  } catch (e) { handleAuthError(e); }
}

document.getElementById('autoBanToggle').addEventListener('change', async (e) => {
  try {
    await api('PUT', '/api/settings/auto_ban_on_report', { value: e.target.checked });
    showToast(e.target.checked ? 'Auto-ban enabled.' : 'Auto-ban disabled — reports now need manual review.');
  } catch (e2) { handleAuthError(e2); }
});

document.getElementById('videoUnlockThresholdInput').addEventListener('change', debounce(async (e) => {
  const n = Math.max(1, parseInt(e.target.value, 10) || 10);
  e.target.value = n;
  try {
    await api('PUT', '/api/settings/video_unlock_threshold_per_side', { value: n });
    showToast('Saved.');
  } catch (e2) { handleAuthError(e2); }
}, 400));

function renderMonetizationMethods(methods) {
  const rateFieldKeys = { pay_per_minute_video: 'rateCents', coin_gifting: 'coinPriceCents', referral_program: 'bonusCents' };
  const container = document.getElementById('monetizationMethodsList');
  container.innerHTML = Object.entries(methods).map(([key, m]) => `
    <div class="item-row" data-method="${key}">
      <div class="left"><div class="title">${escapeHtml(m.label || key)}</div><div class="desc">${escapeHtml(m.note || '')}</div></div>
      <div class="right">
        ${rateFieldKeys[key] ? `<input type="number" min="0" placeholder="cents" value="${m[rateFieldKeys[key]] ?? 0}" data-rate-key="${rateFieldKeys[key]}">` : ''}
        <label class="toggle"><input type="checkbox" ${m.enabled ? 'checked' : ''} data-method-toggle><span class="slider"></span></label>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-method-toggle]').forEach(cb => {
    cb.addEventListener('change', () => saveMonetizationMethod(cb.closest('[data-method]').dataset.method, methods));
  });
  container.querySelectorAll('[data-rate-key]').forEach(input => {
    input.addEventListener('change', () => saveMonetizationMethod(input.closest('[data-method]').dataset.method, methods));
  });
}

async function saveMonetizationMethod(key, methods) {
  const row = document.querySelector(`[data-method="${key}"]`);
  const enabled = row.querySelector('[data-method-toggle]').checked;
  const rateInput = row.querySelector('[data-rate-key]');
  const updated = { ...methods[key], enabled };
  if (rateInput) updated[rateInput.dataset.rateKey] = parseInt(rateInput.value, 10) || 0;
  methods[key] = updated;
  try {
    await api('PUT', '/api/settings/monetization_methods', { value: methods });
    showToast('Saved.');
  } catch (e) { handleAuthError(e); }
}

// ---- Match settings (default country/nearby picker scope) ----
let matchSettingsCountriesPopulated = false;
function populateMatchCountrySelect() {
  if (matchSettingsCountriesPopulated) return;
  const select = document.getElementById('matchModeCountrySelect');
  const countries = window.SYNCCHAT_COUNTRIES || [];
  select.innerHTML = countries.map(c => `<option value="${c.code}">${c.flag} ${escapeHtml(c.name)}</option>`).join('');
  matchSettingsCountriesPopulated = true;
}

async function loadMatchSettings() {
  populateMatchCountrySelect();
  try {
    const { settings } = await api('GET', '/api/settings');
    const defaults = settings.country_match_defaults || { mode: 'india', country: null };
    document.querySelectorAll('input[name="defaultMatchMode"]').forEach(r => { r.checked = r.value === defaults.mode; });
    if (defaults.country) document.getElementById('matchModeCountrySelect').value = defaults.country;
  } catch (e) { handleAuthError(e); }
}

async function saveMatchSettings() {
  const mode = document.querySelector('input[name="defaultMatchMode"]:checked')?.value || 'india';
  const country = mode === 'country' ? document.getElementById('matchModeCountrySelect').value : null;
  try {
    await api('PUT', '/api/settings/country_match_defaults', { value: { mode, country } });
    showToast('Default match scope saved.');
  } catch (e) { handleAuthError(e); }
}

document.querySelectorAll('input[name="defaultMatchMode"]').forEach(r => r.addEventListener('change', saveMatchSettings));
document.getElementById('matchModeCountrySelect').addEventListener('change', () => {
  // Picking a country implies "specific country" mode, matching how a
  // real settings UI behaves rather than requiring two separate clicks.
  document.getElementById('matchModeCountry').checked = true;
  saveMatchSettings();
});

// ---- Helpers ----
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

initAuth();
