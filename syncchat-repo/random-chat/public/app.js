// WebSocket-first: when multiple server instances run behind a load
// balancer there is no session affinity, so the connection must not depend
// on repeated polling requests landing on the same instance. A single
// WebSocket connection pins the client to one instance for its lifetime and
// cross-instance delivery happens server-side via the Redis adapter. Polling
// remains only as a fallback for networks that block WebSockets (and still
// works against a single instance).
const socket = io({ transports: ['websocket', 'polling'] });

let localStream = null;
let pc = null;

// ---- Auth: Google or email/password (accounts are what make history/
// resume possible) ----
let authToken = localStorage.getItem('syncchat_token') || null;
let currentUser = null; // { id, username, gender }
let authMode = 'login'; // 'login' | 'signup'

const authGateEl = document.getElementById('authGate');
const gateEl = document.getElementById('gate');
const authIdentifierInput = document.getElementById('authIdentifier');
const authPasswordLoginInput = document.getElementById('authPasswordLogin');
const authFullNameInput = document.getElementById('authFullName');
const authUsernameInput = document.getElementById('authUsername');
const authIdentifierSignupInput = document.getElementById('authIdentifierSignup');
const authPasswordSignupInput = document.getElementById('authPasswordSignup');
const usernameHintEl = document.getElementById('usernameHint');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authStatusEl = document.getElementById('authStatus');
const historyBtn = document.getElementById('historyBtn');
const topbarStatusEl = document.getElementById('topbarStatus');

// ---- Country / Nearby picker (top bar) ----
// Mirrors the Instagram/Facebook-style "who can find/match me" picker:
// Nearby (geolocation), a specific country (default India, admin-configurable),
// Random (anyone), or any other named country. The selection is sent to the
// server on every search (find-partner/skip) and can also be changed while
// already waiting for a match — see 'set-country-mode' below.
let countryMode = localStorage.getItem('syncchat_country_mode'); // 'nearby' | 'india' | 'random' | 'country' | null (not chosen yet)
let countryCode = localStorage.getItem('syncchat_country_code') || null; // ISO code, only meaningful when countryMode === 'country'
let countryLat = null;
let countryLon = null;
let isSearchingForPartner = false; // true only while actually waiting in queue (not yet matched)

const countryBtn = document.getElementById('countryBtn');
const countryBtnLabel = document.getElementById('countryBtnLabel');
const countryBackdrop = document.getElementById('countryBackdrop');
const countryModal = document.getElementById('countryModal');
const countryQuick = document.getElementById('countryQuick');
const countryListEl = document.getElementById('countryList');
const countrySearchInput = document.getElementById('countrySearchInput');

const QUICK_LABELS = { nearby: 'Nearby', india: 'India', random: 'Random' };

// Load the platform-wide default (admin-configurable) once, but only apply
// it if this browser hasn't picked anything before.
if (!countryMode) {
  countryMode = 'india'; // sensible immediate default while the fetch below resolves
  fetch('/api/match-settings').then(r => r.json()).then(({ defaults }) => {
    if (localStorage.getItem('syncchat_country_mode')) return; // user (or an earlier tab) already chose in the meantime
    countryMode = defaults?.mode || 'india';
    countryCode = defaults?.mode === 'country' ? (defaults.country || null) : null;
    renderCountryLabel();
    renderCountrySelection();
  }).catch(() => { /* keep the India fallback if this fails */ });
}

function renderCountryLabel() {
  if (countryMode === 'country' && countryCode) {
    const c = (window.SYNCCHAT_COUNTRIES || []).find(c => c.code === countryCode);
    countryBtnLabel.textContent = c ? c.name : countryCode;
  } else {
    countryBtnLabel.textContent = QUICK_LABELS[countryMode] || 'India';
  }
}
renderCountryLabel();

function renderCountrySelection() {
  countryQuick.querySelectorAll('.country-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.mode === countryMode);
  });
  renderCountryList(countrySearchInput.value.trim());
}

function renderCountryList(filter) {
  const all = window.SYNCCHAT_COUNTRIES || [];
  const q = filter.toLowerCase();
  const filtered = q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
  if (!filtered.length) {
    countryListEl.innerHTML = '<div class="country-empty">No countries match your search.</div>';
    return;
  }
  // Cap the render for perf when unfiltered; typing narrows it down.
  const shown = filtered.slice(0, q ? filtered.length : 60);
  countryListEl.innerHTML = shown.map(c => `
    <div class="country-option${countryMode === 'country' && countryCode === c.code ? ' selected' : ''}" data-country="${c.code}">
      <span class="flag">${c.flag}</span><span class="name">${c.name}</span><span class="check">&#10003;</span>
    </div>
  `).join('');
  countryListEl.querySelectorAll('[data-country]').forEach(el => {
    el.addEventListener('click', () => selectCountry(el.dataset.country));
  });
}

function persistCountrySelection() {
  localStorage.setItem('syncchat_country_mode', countryMode);
  if (countryMode === 'country' && countryCode) localStorage.setItem('syncchat_country_code', countryCode);
  else localStorage.removeItem('syncchat_country_code');
}

// If already waiting for a match (searching overlay is up, no partner
// yet), apply the change to the live search immediately instead of
// waiting for the next Skip.
function pushCountryModeToServer() {
  if (!isSearchingForPartner) return;
  socket.emit('set-country-mode', { countryMode, country: countryCode, lat: countryLat, lon: countryLon });
}

function selectQuickMode(mode) {
  if (mode === 'nearby') {
    countryMode = 'nearby';
    countryCode = null;
    // Ask for precise geolocation; if denied/unavailable we still proceed
    // with 'nearby' — the server falls back to a country-level match.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          countryLat = pos.coords.latitude;
          countryLon = pos.coords.longitude;
          pushCountryModeToServer();
        },
        () => { countryLat = null; countryLon = null; pushCountryModeToServer(); },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
      );
    }
  } else {
    countryMode = mode; // 'india' | 'random'
    countryCode = null;
    countryLat = null; countryLon = null;
  }
  finishCountrySelection();
}

function selectCountry(code) {
  countryMode = 'country';
  countryCode = code;
  countryLat = null; countryLon = null;
  finishCountrySelection();
}

function finishCountrySelection() {
  persistCountrySelection();
  renderCountryLabel();
  renderCountrySelection();
  pushCountryModeToServer();
  closeCountryModal();
}

countryQuick.querySelectorAll('.country-option').forEach(el => {
  el.addEventListener('click', () => selectQuickMode(el.dataset.mode));
});
countrySearchInput.addEventListener('input', (e) => renderCountryList(e.target.value.trim()));

function openCountryModal() {
  renderCountrySelection();
  countrySearchInput.value = '';
  countryBackdrop.classList.add('show');
  countryModal.classList.add('show');
}
function closeCountryModal() {
  countryBackdrop.classList.remove('show');
  countryModal.classList.remove('show');
}
countryBtn.addEventListener('click', openCountryModal);
document.getElementById('countryCloseBtn').addEventListener('click', closeCountryModal);
countryBackdrop.addEventListener('click', closeCountryModal);

function buildCountryPayload() {
  return { countryMode, country: countryCode, lat: countryLat, lon: countryLon };
}


function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('loginTabBtn').classList.toggle('selected', mode === 'login');
  document.getElementById('signupTabBtn').classList.toggle('selected', mode === 'signup');
  authSubmitBtn.textContent = mode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('loginFields').style.display = mode === 'login' ? 'block' : 'none';
  document.getElementById('signupFields').style.display = mode === 'signup' ? 'block' : 'none';
  authStatusEl.textContent = '';
  authStatusEl.className = '';
}
document.getElementById('loginTabBtn').addEventListener('click', () => setAuthMode('login'));
document.getElementById('signupTabBtn').addEventListener('click', () => setAuthMode('signup'));

// Live username availability check while typing — same UX as Instagram's
// green-check/red-x under the username field at signup.
let usernameCheckDebounce = null;
let usernameIsAvailable = false;
authUsernameInput.addEventListener('input', () => {
  const raw = authUsernameInput.value.trim();
  authUsernameInput.value = raw; // keep as typed; server also normalizes to lowercase
  usernameIsAvailable = false;
  clearTimeout(usernameCheckDebounce);
  if (!raw) { usernameHintEl.textContent = ''; usernameHintEl.className = 'username-hint'; return; }
  usernameHintEl.textContent = 'Checking...';
  usernameHintEl.className = 'username-hint checking';
  usernameCheckDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/check-username?u=${encodeURIComponent(raw)}`);
      const data = await res.json();
      if (authUsernameInput.value.trim() !== raw) return; // stale response, superseded by a newer keystroke
      usernameIsAvailable = !!data.available;
      usernameHintEl.textContent = data.available ? 'Username is available' : (data.error || 'That username is taken');
      usernameHintEl.className = `username-hint ${data.available ? 'ok' : 'err'}`;
    } catch (e) {
      usernameHintEl.textContent = '';
      usernameHintEl.className = 'username-hint';
    }
  }, 350);
});

authSubmitBtn.addEventListener('click', async () => {
  authStatusEl.className = '';
  let payload, url;
  if (authMode === 'login') {
    const identifier = authIdentifierInput.value.trim();
    const password = authPasswordLoginInput.value;
    if (!identifier || !password) {
      authStatusEl.textContent = 'Enter your username/email and password.';
      authStatusEl.className = 'err';
      return;
    }
    url = '/api/login';
    payload = { identifier, password };
  } else {
    const fullName = authFullNameInput.value.trim();
    const username = authUsernameInput.value.trim();
    const identifier = authIdentifierSignupInput.value.trim();
    const birthDate = document.getElementById('authBirthDate').value;
    const password = authPasswordSignupInput.value;
    const youtubeLink = document.getElementById('authYoutubeSignup').value.trim();
    if (!fullName) { authStatusEl.textContent = 'Enter your name.'; authStatusEl.className = 'err'; return; }
    if (!username) { authStatusEl.textContent = 'Choose a username.'; authStatusEl.className = 'err'; return; }
    if (!usernameIsAvailable) { authStatusEl.textContent = 'Pick an available username.'; authStatusEl.className = 'err'; return; }
    if (!identifier) { authStatusEl.textContent = 'Enter a mobile number or email.'; authStatusEl.className = 'err'; return; }
    const isEmail = identifier.includes('@');
    if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
      authStatusEl.textContent = 'Enter a valid email address.'; authStatusEl.className = 'err'; return;
    }
    if (!isEmail && identifier.replace(/\D/g, '').length < 7) {
      authStatusEl.textContent = 'Enter a valid mobile number or email.'; authStatusEl.className = 'err'; return;
    }
    if (!password) { authStatusEl.textContent = 'Enter a password.'; authStatusEl.className = 'err'; return; }
    if (password.length < 6) { authStatusEl.textContent = 'Password must be at least 6 characters.'; authStatusEl.className = 'err'; return; }
    if (!birthDate) { authStatusEl.textContent = 'Enter your date of birth.'; authStatusEl.className = 'err'; return; }
    url = '/api/signup';
    payload = { fullName, username, identifier, birthDate, password, youtubeLink };
  }
  authSubmitBtn.disabled = true;
  authStatusEl.textContent = authMode === 'login' ? 'Logging in...' : 'Creating account...';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    onAuthenticated(data.token, data.user);
  } catch (err) {
    authStatusEl.textContent = err.message;
    authStatusEl.className = 'err';
  } finally {
    authSubmitBtn.disabled = false;
  }
});

function onAuthenticated(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem('syncchat_token', token);
  socket.emit('auth', { token });
  authGateEl.style.display = 'none';
  gateEl.style.display = 'block';
  historyBtn.style.display = 'flex';
  const notifBtnEl = document.getElementById('notifBtn');
  if (notifBtnEl) notifBtnEl.style.display = 'flex';
  document.getElementById('avatarMenuBtn').style.display = 'flex';
  renderAvatarBtn();
  showOnboardingStep();
  captureMyLocation();
}

// Precise location for "Suggested" (people-nearby) — separate consent
// prompt from the per-search "Nearby" matching mode; asked once per
// login/session (browser caches the permission decision itself, and this
// just skips re-asking within the same page load).
let locationCaptured = false;
function captureMyLocation() {
  if (locationCaptured || !navigator.geolocation) return;
  locationCaptured = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fetch('/api/location', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude })
      }).catch(() => {});
    },
    () => { /* denied/unavailable — suggestions fall back to country-level nearby */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
  );
}

async function tryRestoreSession() {
  if (!authToken) return;
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) throw new Error('expired');
    const data = await res.json();
    onAuthenticated(authToken, data.user);
  } catch {
    authToken = null;
    localStorage.removeItem('syncchat_token');
  }
}

// A successful social login redirects back here with #auth_token=...
async function handleOAuthRedirect() {
  const match = window.location.hash.match(/auth_token=([^&]+)/);
  if (!match) return false;
  history.replaceState(null, '', window.location.pathname);
  try {
    const token = decodeURIComponent(match[1]);
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('expired');
    const data = await res.json();
    onAuthenticated(token, data.user);
    return true;
  } catch {
    return false;
  }
}
(async () => {
  const handled = await handleOAuthRedirect();
  if (!handled) tryRestoreSession();
})();

// ---- One-time birthdate step (social-login accounts only — email/
// password accounts already collected it at signup), then phone, then
// gender, then match ----
const birthdateStepEl = document.getElementById('birthdateStep');
const birthdateStepInput = document.getElementById('birthdateStepInput');
const birthdateContinueBtn = document.getElementById('birthdateContinueBtn');
const birthdateStepStatus = document.getElementById('birthdateStepStatus');

// ---- One-time phone step (social-login accounts only — email/password
// accounts already collected it at signup) then gender, then match ----
const phoneStepEl = document.getElementById('phoneStep');
const phoneStepInput = document.getElementById('phoneStepInput');
const phoneContinueBtn = document.getElementById('phoneContinueBtn');
const phoneStepStatus = document.getElementById('phoneStepStatus');

// ---- One-time gender step (shown on the landing gate, not at signup) ----
const genderStepEl = document.getElementById('genderStep');
const matchStepEl = document.getElementById('matchStep');
const genderSetRow = document.getElementById('genderSetRow');
const genderContinueBtn = document.getElementById('genderContinueBtn');
const genderStatusEl = document.getElementById('genderStatus');
const genderDeclareCheck = document.getElementById('genderDeclareCheck');
let pendingGender = null;

function showOnboardingStep() {
  birthdateStepEl.style.display = 'none';
  phoneStepEl.style.display = 'none';
  genderStepEl.style.display = 'none';
  matchStepEl.style.display = 'none';
  if (currentUser && !currentUser.hasBirthDate) {
    birthdateStepEl.style.display = 'block';
  } else if (currentUser && !currentUser.hasPhone) {
    phoneStepEl.style.display = 'block';
  } else if (currentUser && currentUser.gender) {
    matchStepEl.style.display = 'block';
  } else {
    genderStepEl.style.display = 'block';
  }
}

birthdateContinueBtn.addEventListener('click', async () => {
  const birthDate = birthdateStepInput.value;
  if (!birthDate) {
    birthdateStepStatus.textContent = 'Enter your date of birth.';
    birthdateStepStatus.className = 'err';
    return;
  }
  birthdateContinueBtn.disabled = true;
  birthdateStepStatus.textContent = 'Saving...';
  birthdateStepStatus.className = '';
  try {
    const res = await fetch('/api/set-birthdate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ birthDate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    currentUser = data.user;
    showOnboardingStep();
  } catch (err) {
    birthdateStepStatus.textContent = err.message;
    birthdateStepStatus.className = 'err';
  } finally {
    birthdateContinueBtn.disabled = false;
  }
});

phoneContinueBtn.addEventListener('click', async () => {
  const phone = phoneStepInput.value.trim();
  if (phone.replace(/\D/g, '').length < 7) {
    phoneStepStatus.textContent = 'Enter a valid phone number.';
    phoneStepStatus.className = 'err';
    return;
  }
  phoneContinueBtn.disabled = true;
  phoneStepStatus.textContent = 'Saving...';
  phoneStepStatus.className = '';
  try {
    const res = await fetch('/api/set-phone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    currentUser = data.user;
    showOnboardingStep();
  } catch (err) {
    phoneStepStatus.textContent = err.message;
    phoneStepStatus.className = 'err';
  } finally {
    phoneContinueBtn.disabled = false;
  }
});

genderSetRow.querySelectorAll('.gender-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    genderSetRow.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('selected', 'male', 'female'));
    btn.classList.add('selected', btn.dataset.g);
    pendingGender = btn.dataset.g;
    genderContinueBtn.disabled = !(pendingGender && genderDeclareCheck.checked);
  });
});
genderDeclareCheck.addEventListener('change', () => {
  genderContinueBtn.disabled = !(pendingGender && genderDeclareCheck.checked);
});

genderContinueBtn.addEventListener('click', async () => {
  if (!pendingGender || !genderDeclareCheck.checked) return;
  genderContinueBtn.disabled = true;
  genderStatusEl.textContent = 'Saving...';
  genderStatusEl.className = '';
  try {
    const res = await fetch('/api/set-gender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ gender: pendingGender })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    currentUser = data.user;
    showOnboardingStep();
  } catch (err) {
    genderStatusEl.textContent = err.message;
    genderStatusEl.className = 'err';
    genderContinueBtn.disabled = false;
  }
});

// Re-send auth on (re)connect, e.g. after the server restarts.
socket.on('connect', () => { if (authToken) socket.emit('auth', { token: authToken }); });

// ---- Gate / gender selection ----
let myGender = null;
let lookingFor = null;
let chatMode = null; // 'video' | 'text'
let permissionGranted = false;

const lookingRow = document.getElementById('lookingRow');
const modeRow = document.getElementById('modeRow');
const startBtn = document.getElementById('startBtn');
const permStatus = document.getElementById('permStatus');

function wireRow(row, onSelect) {
  row.querySelectorAll('.gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return; // e.g. Video mode is locked until unlocked via chat
      row.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('selected', 'male', 'female', 'video', 'text'));
      btn.classList.add('selected', btn.dataset.g);
      onSelect(btn.dataset.g);
    });
  });
}
wireRow(lookingRow, g => { lookingFor = g; checkReady(); });
wireRow(modeRow, g => { chatMode = g; checkReady(); });

// Default to Text mode selected — it's the recommended starting point
// (see mode-tip copy above); user can still switch to Video explicitly.
modeRow.querySelector('[data-g="text"]').click();

// Camera & mic permission is mandatory regardless of mode — it's how we
// verify a real person is behind the account, and it's what powers the
// blurred-video verification feature in text mode.
async function requestMediaPermission() {
  // Re-use the existing camera/mic stream where possible, but never trust a
  // stale flag blindly — if the previous stream's tracks died (e.g. after
  // a prior video call ended, or the device was reclaimed), silently
  // holding onto a dead stream is exactly what makes Verify recording (and
  // the partner's blurred clip) fail without any visible error. Always
  // re-bind the local preview too, since the fast path used to skip it.
  const hasLiveVideoTrack = localStream && localStream.getVideoTracks().some(t => t.readyState === 'live');
  if (permissionGranted && hasLiveVideoTrack) {
    document.getElementById('localVideo').srcObject = localStream;
    return true;
  }
  permissionGranted = false;
  const highQualityConstraints = {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, min: 15 },
      aspectRatio: { ideal: 16 / 9 },
      facingMode: 'user'
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(highQualityConstraints);
  } catch (err) {
    // Some webcams (older laptops, some external USB cams) throw
    // OverconstrainedError on a specific ideal resolution/frame rate
    // rather than just giving their best match — without this fallback
    // those devices would get no camera at all instead of a lower-res one.
    if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: highQualityConstraints.audio });
      } catch {
        return false;
      }
    } else {
      return false;
    }
  }
  document.getElementById('localVideo').srcObject = localStream;
  permissionGranted = true;
  return true;
}

async function checkReady() {
  myGender = currentUser ? currentUser.gender : null;
  const selectionsMade = myGender && lookingFor && chatMode;
  if (!selectionsMade) return;

  if (!permissionGranted) {
    permStatus.textContent = 'Requesting camera & mic access...';
    permStatus.className = '';
    const ok = await requestMediaPermission();
    if (!ok) {
      permStatus.textContent = 'Camera & mic access is required to use this site — please allow access and try again.';
      permStatus.className = 'err';
      startBtn.disabled = true;
      return;
    }
    permStatus.textContent = 'Camera & mic access granted.';
    permStatus.className = 'ok';
  }

  startBtn.disabled = false;
  startBtn.textContent = 'Start Chatting';
}

startBtn.addEventListener('click', () => {
  if (!permissionGranted) return;
  document.getElementById('gate').style.display = 'none';
  document.getElementById('chatScreen').classList.add('active');
  document.getElementById('topbarControls').classList.add('active');
  topbarStatusEl.style.display = 'flex';
  applyModeUI();
  showSearching();
  isSearchingForPartner = true;
  setSearchUiState('searching');
  socket.emit('find-partner', { gender: myGender, lookingFor, ...buildCountryPayload() });
});

// ---- Start/Stop search controls (topbar) ----
// 'idle': nobody connected, not searching — shows the Start button.
// 'searching': waiting in queue / connecting — the round red indicator
//   cancels the search instead of ending the whole session.
// 'connected': matched with a partner — the round red indicator stays
//   visible so *either* side can independently stop/end the chat (text or
//   video) at any time, without forcing an immediate new search the way
//   Skip does. Start stays hidden until you're back to idle.
function setSearchUiState(state) {
  const startBtnEl = document.getElementById('searchStartBtn');
  const stopIndEl = document.getElementById('searchStopIndicator');
  if (!startBtnEl || !stopIndEl) return;
  startBtnEl.style.display = state === 'idle' ? 'flex' : 'none';
  stopIndEl.style.display = state === 'idle' ? 'none' : 'flex';
  stopIndEl.title = state === 'searching' ? 'Cancel searching' : 'Stop this chat';
}

function beginSearch() {
  setStatus('Looking for a new partner...', false);
  partnerLabel.textContent = 'Waiting for partner...';
  showSearching();
  isSearchingForPartner = true;
  setSearchUiState('searching');
  socket.emit('find-partner', { gender: myGender, lookingFor, ...buildCountryPayload() });
}
document.getElementById('searchStartBtn').addEventListener('click', beginSearch);

document.getElementById('searchStopIndicator').addEventListener('click', () => {
  if (isSearchingForPartner) {
    // Still in queue / connecting — just cancel the search.
    isSearchingForPartner = false;
    socket.emit('cancel-search');
    hideSearching();
    setStatus('Not connected', false);
    partnerLabel.textContent = 'Not connected';
    setSearchUiState('idle');
    showGlobalToast('Search cancelled — tap Start whenever you\u2019re ready to look again.', 'stop');
    return;
  }
  // Already matched — end this chat/call independently of the partner,
  // without immediately searching for someone new (that's what Skip is
  // for). Lands back on an idle text-chat screen with Start available.
  socket.emit('leave-chat');
  endCurrentChatUI('Chat ended — tap Start whenever you\u2019re ready to look again.');
});

// Shared UI reset for "this chat is now over, back to idle" — used by the
// Stop button above and by Block (top-bar ⋮ menu), which also ends the
// current chat. Does NOT touch the socket connection itself; callers emit
// whatever socket event (leave-chat / block-user) triggered the end first.
function endCurrentChatUI(toastText) {
  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  if (chatMode === 'video') { chatMode = 'text'; applyModeUI(); }
  messagesEl.innerHTML = '';
  messagesEl.classList.remove('text-hidden');
  activeConversationId = null;
  currentPartnerId = null;
  currentPartnerMuted = false;
  clearReplyBar();
  currentDisappearingMode = 'none';
  updateDisappearingBtnVisibility();
  updateMoreBtnVisibility();
  hideResumeBanner();
  resetVideoUnlock();
  setChatEnabled(false);
  hideSearching();
  setStatus('Not connected', false);
  partnerLabel.textContent = 'Not connected';
  setSearchUiState('idle');
  if (toastText) showGlobalToast(toastText, 'stop');
}

function applyModeUI() {
  const videoStage = document.getElementById('videoStage');
  const verifyBtn = document.getElementById('verifyBtn');
  const voiceBtn = document.getElementById('voiceBtn');
  const switchBtn = document.getElementById('switchModeBtn');
  const micBtn = document.getElementById('micBtn');
  if (chatMode === 'text') {
    // Keep camera stream alive in background for verification clips,
    // but hide both video panels — chat fills the whole stage.
    videoStage.style.display = 'none';
    messagesEl.classList.add('full-chat');
    messagesEl.style.display = ''; // text mode: always visible, no preview gate to wait on
    verifyBtn.style.display = 'flex';
    voiceBtn.style.display = 'flex';
    micBtn.style.display = 'flex';
    switchBtn.querySelector('.lb').textContent = 'Switch to Video';
    // Locked until enough back-and-forth has happened (see trackVideoUnlock)
    // — matches the same "vibe check first" gate as the onboarding screen.
    switchBtn.disabled = !videoUnlocked;
    switchBtn.classList.toggle('locked', !videoUnlocked);
    switchBtn.title = videoUnlocked ? '' : 'Unlocks automatically';
  } else {
    videoStage.style.display = 'flex';
    messagesEl.classList.remove('full-chat');
    verifyBtn.style.display = 'none';
    voiceBtn.style.display = 'none';
    micBtn.style.display = 'none'; // voice messages are a text-mode-only feature, like Verify/Voice
    endVoiceCallIfActive(true);
    switchBtn.querySelector('.lb').textContent = 'Switch to Text';
    // Switching back to text is never locked.
    switchBtn.disabled = false;
    switchBtn.classList.remove('locked');
    switchBtn.title = '';
  }
  switchBtn.style.display = 'flex';
}

// ---- Mid-chat mode switching (text <-> video) ----
const switchModeBtn = document.getElementById('switchModeBtn');
switchModeBtn.addEventListener('click', () => {
  const targetMode = chatMode === 'text' ? 'video' : 'text';
  switchModeBtn.disabled = true;
  addMessage(`Requesting to switch to ${targetMode} chat...`, 'system');
  socket.emit('switch-mode-request', { toMode: targetMode });
});

const switchModeOverlay = document.getElementById('switchModeOverlay');

function showSwitchModeCard(card) {
  if (chatMode === 'video') {
    // Its own floating layer over a dimmed backdrop — never mixed into the
    // typed-message list, so it can't collide with chat text. Only one at
    // a time: clear anything already there first.
    switchModeOverlay.innerHTML = '';
    switchModeOverlay.appendChild(card);
    switchModeOverlay.classList.add('show');
  } else {
    addCard(card);
  }
}

function hideSwitchModeCard(card) {
  if (chatMode === 'video') {
    switchModeOverlay.classList.remove('show');
    switchModeOverlay.innerHTML = '';
  } else {
    card.remove();
  }
}

socket.on('switch-mode-request', ({ toMode }) => {
  const card = document.createElement('div');
  card.className = 'verify-card';
  card.innerHTML = `
    <div>Your partner wants to switch to ${toMode} chat. Agree?</div>
    <div class="actions">
      <button class="accept">Agree</button>
      <button class="decline">Decline</button>
    </div>
  `;
  card.querySelector('.accept').addEventListener('click', () => {
    socket.emit('switch-mode-response', { accepted: true, toMode });
    hideSwitchModeCard(card);
    applySwitchMode(toMode, true); // acceptor initiates the WebRTC offer
  });
  card.querySelector('.decline').addEventListener('click', () => {
    socket.emit('switch-mode-response', { accepted: false, toMode });
    hideSwitchModeCard(card);
  });
  showSwitchModeCard(card);
});

socket.on('switch-mode-response', ({ accepted, toMode }) => {
  switchModeBtn.disabled = false;
  if (accepted) {
    addMessage(`Partner agreed. Switching to ${toMode} chat.`, 'system');
    applySwitchMode(toMode, false); // requester waits for the acceptor's offer
  } else {
    addMessage(`Partner declined switching to ${toMode} chat.`, 'system');
  }
});

function applySwitchMode(toMode, initiator) {
  const wasVideo = chatMode === 'video';
  chatMode = toMode;
  applyModeUI();

  if (toMode === 'video' && !wasVideo) {
    // Moving into video: verify/reveal is a text-mode-only feature (see the
    // socket handlers below), so any pending verify card and its blurred
    // clip need to be torn down here — otherwise it sits stale inside
    // messagesEl, which is reused as the video-mode text overlay, and
    // reappears floating on top of the live video once Continue is clicked.
    // Status/system lines ("Connected with a ___ partner!", "Partner
    // agreed...", etc.) get cleared for the same reason — they're
    // text-mode-only status noise, not part of the actual conversation, so
    // they shouldn't resurface over the video either. Plain self/partner
    // chat messages are the only thing kept — the video screen is meant to
    // keep showing that same running conversation, just without the
    // verify/status clutter that belongs to text mode only.
    pendingVerifyCard = null;
    messagesEl.querySelectorAll('.verify-card, .msg.system, .voice-msg').forEach(el => el.remove());
    messagesEl.classList.remove('text-hidden');

    // (re)build the peer connection and show the blurred preview +
    // Continue/Skip gate, same as an initial video match. Keep the chat
    // overlay hidden until Continue is clicked, same as a fresh match —
    // otherwise it would sit on top of and block the preview's
    // Continue/Skip buttons.
    //
    // Order matters here: startPeerConnection() calls cleanupPeerConnection()
    // internally as its first step (to tear down any old connection), and
    // that also strips the 'blurred' class + hides previewOverlay as part
    // of its own reset. So blurred must be added AFTER startPeerConnection()
    // runs, not before — adding it first meant it got wiped out again a
    // line later, and the "blurred" preview was never actually blurred.
    const remoteVideo = document.getElementById('remoteVideo');
    messagesEl.style.display = 'none';
    startPeerConnection(initiator, false);
    remoteVideo.classList.add('blurred');
    document.getElementById('previewOverlay').style.display = 'none';
    startConnectFailTimer();
  } else if (toMode === 'text' && wasVideo) {
    // Moving into text: tear down the live video connection.
    cleanupPeerConnection();
  }
}

// ---- Chat UI ----
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const partnerLabel = document.getElementById('partnerLabel');
const topbarDot = document.getElementById('topbarDot');
const topbarStatusText = document.getElementById('topbarStatusText');
const statusToast = document.getElementById('statusToast');

const partnerStatusChipText = document.getElementById('partnerStatusChipText');
const partnerStatusDot = document.getElementById('partnerStatusDot');
const partnerStatusAvatar = document.getElementById('partnerStatusAvatar');

function setStatus(text, live) {
  topbarStatusText.textContent = text;
  topbarDot.classList.toggle('on', !!live);
  if (partnerStatusChipText) partnerStatusChipText.textContent = text;
  if (partnerStatusDot) partnerStatusDot.classList.toggle('on', !!live);
  if (partnerStatusAvatar && !live) partnerStatusAvatar.classList.remove('male', 'female');
  if (['Not connected', 'Partner left', 'Looking for a new partner...'].includes(text)) {
    currentPartnerId = null;
  }
}

let toastTimer = null;
function showStatusToast(text) {
  if (!statusToast) return;
  statusToast.textContent = text;
  statusToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => statusToast.classList.remove('show'), 3000);
}

// The stranger's video screen only ever shows, at most one at a time: the
// blurred preview gate, plain typed messages, the switch-mode agree/decline
// card, and a single fading status toast. Everything else (verify/voice
// request cards, verify clips, voice messages) is suppressed there entirely
// and only ever shown in text mode.
// `opts` (optional) carries the server-assigned message id, a reply-quote
// to render above the bubble, and its deleted state — used for real
// messages (text/voice, both text mode and the video-mode overlay); plain
// system/status lines are called without it and stay non-interactive.
function addMessage(text, type, opts = {}) {
  if (chatMode === 'video' && type !== 'self' && type !== 'partner') {
    if (type === 'system') showStatusToast(text);
    return;
  }
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  if (opts.id) div.dataset.id = opts.id;
  if (opts.replyTo) {
    const quote = document.createElement('span');
    quote.className = 'msg-reply-quote';
    quote.textContent = opts.replyTo.text || 'Voice message';
    div.appendChild(quote);
  }
  const body = document.createElement('span');
  body.className = 'msg-body';
  body.textContent = text;
  div.appendChild(body);
  if (opts.deleted) div.classList.add('deleted');
  if ((type === 'self' || type === 'partner') && opts.id && !opts.deleted) {
    div.addEventListener('click', (e) => {
      if (selectionMode) { e.stopPropagation(); toggleMessageSelection(div); return; }
      openMsgActionMenu(e, div, type === 'self');
    });
    attachLongPress(div);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Appends an interactive card (accept/decline, reveal, etc) to the text-mode
// chat log. Verify/voice/voice-message features don't exist in video mode at
// all, so this is never called for them there; the switch-to-text card is
// handled separately via showSwitchModeCard() since it needs to float above
// the video mode message text rather than live inside the message list.
function addCard(card) {
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return card;
}

// ---- Video mode: click the stranger's screen to fade typed text in/out ----
// Only fades plain chat text (.msg) — cards like the switch-mode
// Agree/Decline stay put so a stray click can't hide something the user
// still needs to act on.
messagesEl.addEventListener('click', (e) => {
  if (chatMode !== 'video') return;
  if (messagesEl.style.display === 'none') return; // preview gate still up, nothing to toggle yet
  if (e.target.closest('.verify-card, button')) return; // let card buttons work normally
  messagesEl.classList.toggle('text-hidden');
});

function setChatEnabled(enabled) {
  msgInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const text = msgInput.value.trim().slice(0, 1000);
  if (!text) return;
  socket.emit('chat-message', { text, replyToId: pendingReplyTo ? pendingReplyTo.id : null });
  msgInput.value = '';
  clearReplyBar();
  // Bubble is rendered from the server's echo (see socket.on('chat-message')
  // below), not optimistically here — that's what gives every message a
  // real id to reply to / delete, on both sides, symmetrically.
}

socket.on('chat-message', ({ id, text, replyTo, self }) => {
  addMessage(text, self ? 'self' : 'partner', { id, replyTo });
  if (self) myMessageCount++; else partnerMessageCount++;
  trackVideoUnlock();
  if (!self) { maybeMarkSeen(); if (!currentPartnerMuted) playSound('message'); }
});

// ---- "Confirm your vibe, then switch to video" gate ----
// Switch-to-Video starts locked/faded in a text chat (same idea as the
// onboarding screen locking Video mode outright) and unlocks only once
// BOTH sides have sent at least VIDEO_UNLOCK_THRESHOLD messages each —
// not a combined total, so one talkative side can't unlock it alone.
const VIDEO_UNLOCK_THRESHOLD = 10;
let myMessageCount = 0;
let partnerMessageCount = 0;
let videoUnlocked = false;
function trackVideoUnlock() {
  if (chatMode !== 'text' || videoUnlocked) return;
  if (myMessageCount >= VIDEO_UNLOCK_THRESHOLD && partnerMessageCount >= VIDEO_UNLOCK_THRESHOLD) {
    videoUnlocked = true;
    switchModeBtn.disabled = false;
    switchModeBtn.classList.remove('locked');
    switchModeBtn.title = '';
    showGlobalToast("You're vibing! 🎉 Video chat is now unlocked — switch anytime.");
  } else {
    switchModeBtn.title = 'Unlocks automatically';
  }
}
function resetVideoUnlock() {
  myMessageCount = 0;
  partnerMessageCount = 0;
  videoUnlocked = false;
}

const globalToastEl = document.getElementById('globalToast');
let globalToastTimer = null;
function showGlobalToast(text, soundCat = 'notification') {
  if (!globalToastEl) return;
  globalToastEl.textContent = text;
  globalToastEl.classList.add('show');
  clearTimeout(globalToastTimer);
  globalToastTimer = setTimeout(() => globalToastEl.classList.remove('show'), 4000);
  playSound(soundCat);
}

const searchingOverlay = document.getElementById('searchingOverlay');
const searchingSub = document.getElementById('searchingSub');
const textSearchingOverlay = document.getElementById('textSearchingOverlay');
const textSearchingSub = document.getElementById('textSearchingSub');

function showSearching() {
  const subLabel = lookingFor === 'female' ? 'GIRLS' : lookingFor === 'male' ? 'BOYS' : 'MATCHING';
  if (chatMode === 'video') {
    if (searchingOverlay) {
      searchingSub.textContent = subLabel;
      searchingOverlay.style.display = 'flex';
    }
    // Nothing shows over the stranger's video panel while searching either.
    messagesEl.style.display = 'none';
    if (textSearchingOverlay) textSearchingOverlay.classList.remove('show');
  } else {
    // Text mode: an attractive full-stage overlay over the chat itself
    // (used both for the very first search and for reconnecting after a
    // video call ends — see backToTextAndSearch()).
    if (textSearchingOverlay) {
      textSearchingSub.textContent = subLabel;
      textSearchingOverlay.classList.add('show');
    }
    if (searchingOverlay) searchingOverlay.style.display = 'none';
  }
}
function hideSearching() {
  if (searchingOverlay) searchingOverlay.style.display = 'none';
  if (textSearchingOverlay) textSearchingOverlay.classList.remove('show');
}

// Whenever a video call ends for any reason mid-chat — you skip, they skip,
// someone reports (which auto-bans + disconnects), or the partner stops —
// the app drops back to plain text chat rather than staying on the video
// stage while it searches for the next partner. `reason`, if given, is
// surfaced as a toast so it's clear *why* you landed back on text chat.
function backToTextAndSearch(reason, soundCat) {
  const wasVideo = chatMode === 'video';
  if (wasVideo) {
    chatMode = 'text';
    applyModeUI();
    if (reason) showGlobalToast(reason, soundCat);
  }
  return wasVideo;
}

// ---- Controls ----
document.getElementById('skipBtn').addEventListener('click', () => {
  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  backToTextAndSearch('You skipped the video call — back to text chat, searching for someone new.', 'skip');
  playSound('skip');
  messagesEl.innerHTML = '';
  messagesEl.classList.remove('text-hidden');
  activeConversationId = null;
  currentPartnerId = null;
  currentPartnerMuted = false;
  clearReplyBar();
  currentDisappearingMode = 'none';
  updateDisappearingBtnVisibility();
  updateMoreBtnVisibility();
  hideResumeBanner();
  resetVideoUnlock();
  setChatEnabled(false);
  setStatus('Looking for a new partner...', false);
  partnerLabel.textContent = 'Waiting for partner...';
  showSearching();
  isSearchingForPartner = true;
  setSearchUiState('searching');
  socket.emit('skip');
});

// ---- Report modal ----
const reportBackdrop = document.getElementById('reportBackdrop');
const reportModal = document.getElementById('reportModal');
const reportDetails = document.getElementById('reportDetails');
const reportSubmitBtn = document.getElementById('reportSubmitBtn');

function openReportModal() {
  reportModal.querySelectorAll('input[name="reportReason"]').forEach(r => { r.checked = false; });
  reportDetails.value = '';
  reportDetails.style.display = 'none';
  reportSubmitBtn.disabled = true;
  reportBackdrop.classList.add('show');
  reportModal.classList.add('show');
}
function closeReportModal() {
  reportBackdrop.classList.remove('show');
  reportModal.classList.remove('show');
}
document.getElementById('reportBtn').addEventListener('click', openReportModal);
document.getElementById('reportCancelBtn').addEventListener('click', closeReportModal);
reportBackdrop.addEventListener('click', closeReportModal);

document.getElementById('reportReasons').addEventListener('change', (e) => {
  const selected = e.target.value;
  reportDetails.style.display = selected === 'other' ? 'block' : 'none';
  reportSubmitBtn.disabled = false;
});

reportSubmitBtn.addEventListener('click', () => {
  const selected = document.querySelector('input[name="reportReason"]:checked');
  if (!selected) return;
  socket.emit('report', { reason: selected.value, details: reportDetails.value.trim() });
  closeReportModal();
  addMessage('Report submitted. Thank you — this account will be banned if the report is confirmed.', 'system');
});

socket.on('report-ack', ({ banned }) => {
  if (banned) addMessage('The reported account has been permanently banned.', 'system');
});

// If this account itself gets banned (e.g. someone reported it, or an
// admin acted on a report mid-session), stop everything immediately.
socket.on('banned', () => {
  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  localStorage.removeItem('syncchat_token');
  alert('Your account has been permanently banned.');
  location.reload();
});

// ---- Matching events ----
socket.on('matched', ({ roomId, initiator, partnerGender, resumed, conversationId, partnerId, partnerMuted }) => {
  isSearchingForPartner = false;
  currentPartnerId = partnerId || null;
  currentPartnerMuted = !!partnerMuted;
  setSearchUiState('connected');
  playSound('connect');
  activeConversationId = conversationId || null;
  if (!resumed) currentDisappearingMode = 'none'; // resumed sessions keep whatever resumeConversation() already loaded
  updateDisappearingBtnVisibility();
  updateMoreBtnVisibility();
  resetVideoUnlock();
  if (resumed) {
    // Restored history is already rendered; just append a divider instead
    // of wiping it out, and clear the "partner offline" banner if it's up.
    addMessage(`Resumed — you're both here now.`, 'system');
    hideResumeBanner();
  } else {
    messagesEl.innerHTML = '';
    messagesEl.classList.remove('text-hidden');
    addMessage(`Connected with a ${partnerGender} partner!`, 'system');
  }
  setStatus('Connected', true);
  if (partnerStatusAvatar) {
    partnerStatusAvatar.classList.remove('male', 'female');
    if (partnerGender === 'male' || partnerGender === 'female') partnerStatusAvatar.classList.add(partnerGender);
  }
  partnerLabel.textContent = partnerGender.charAt(0).toUpperCase() + partnerGender.slice(1);
  setChatEnabled(true);
  maybeMarkSeen();
  hideSearching();
  if (chatMode === 'video') {
    messagesEl.style.display = 'none'; // stays hidden until Continue is clicked on the preview
    // Resumed conversations restore prior history without clearing it (see
    // above) — strip any leftover verify cards, status lines, and voice
    // message bubbles from that history so they can't resurface over the
    // video, same reasoning as the mode-switch case in applySwitchMode().
    pendingVerifyCard = null;
    messagesEl.querySelectorAll('.verify-card, .msg.system, .voice-msg').forEach(el => el.remove());
  }
  // Order matters: startPeerConnection() calls cleanupPeerConnection()
  // internally first, which also strips 'blurred'/hides previewOverlay —
  // so blurred has to be (re)added AFTER this call, not before, or it gets
  // wiped out immediately and the preview is never actually blurred.
  startPeerConnection(initiator, false);
  if (chatMode === 'video') {
    document.getElementById('remoteVideo').classList.add('blurred');
    document.getElementById('previewOverlay').style.display = 'none'; // shown once stream actually arrives
    startConnectFailTimer();
  }
});

const previewOverlay = document.getElementById('previewOverlay');
const connectFailOverlay = document.getElementById('connectFailOverlay');

// If the two browsers can't establish a direct P2P media connection (common
// behind strict NATs/firewalls — this app only has a STUN server, no TURN
// relay as a fallback), pc.ontrack simply never fires and the video would
// otherwise sit blurred forever with no explanation and nothing to click.
// This timeout catches that and swaps in a clear "couldn't connect" state
// with a Skip button instead of a silent, permanent hang.
const CONNECT_FAIL_TIMEOUT_MS = 15000;
let connectFailTimer = null;
function startConnectFailTimer() {
  clearConnectFailTimer();
  connectFailTimer = setTimeout(() => {
    // Only fire if we're still waiting — if the preview already appeared
    // (connected fine) or the mode/match changed in the meantime, this is
    // stale and should do nothing.
    if (chatMode !== 'video' || previewOverlay.style.display !== 'none') return;
    connectFailOverlay.style.display = 'flex';
  }, CONNECT_FAIL_TIMEOUT_MS);
}
function clearConnectFailTimer() {
  if (connectFailTimer) { clearTimeout(connectFailTimer); connectFailTimer = null; }
  connectFailOverlay.style.display = 'none';
}
document.getElementById('connectFailSkipBtn').addEventListener('click', () => {
  document.getElementById('skipBtn').click();
});

document.getElementById('previewGoBtn').addEventListener('click', () => {
  document.getElementById('remoteVideo').classList.remove('blurred');
  previewOverlay.style.display = 'none';
  if (chatMode === 'video') messagesEl.style.display = 'flex'; // chat only appears now, never blocking the preview buttons
});
document.getElementById('previewSkipBtn').addEventListener('click', () => {
  document.getElementById('skipBtn').click();
});

socket.on('partner-left', () => {
  addMessage('Your partner disconnected.', 'system');
  setStatus('Partner left', false);
  partnerLabel.textContent = 'Waiting for partner...';
  setChatEnabled(false);
  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  // Whatever mode the call was in (including video), the next search
  // always happens from the plain text chat screen.
  backToTextAndSearch('Your partner left the video call — back to text chat, searching for someone new.', 'stop');
  playSound('stop');
  messagesEl.innerHTML = '';
  messagesEl.classList.remove('text-hidden');
  activeConversationId = null;
  currentPartnerId = null;
  currentPartnerMuted = false;
  clearReplyBar();
  currentDisappearingMode = 'none';
  updateDisappearingBtnVisibility();
  updateMoreBtnVisibility();
  hideResumeBanner();
  resetVideoUnlock();
  setStatus('Looking for a new partner...', false);
  showSearching();
  isSearchingForPartner = true;
  setSearchUiState('searching');
  socket.emit('find-partner', { gender: myGender, lookingFor, ...buildCountryPayload() });
});

// ---- WebRTC ----
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};
// The server can inject a TURN relay (env TURN_URLS/TURN_USERNAME/
// TURN_CREDENTIAL) — upgrade the config at load so calls still connect for
// users behind strict NATs/firewalls where plain STUN/P2P fails.
fetch('/api/rtc-config').then(r => (r.ok ? r.json() : null)).then(cfg => {
  if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
    rtcConfig.iceServers = cfg.iceServers;
  }
}).catch(() => { /* keep the STUN default */ });

// audioOnly is used for the text-mode "Voice" feature — same pc/signaling
// channel, just without a video track attached.
function startPeerConnection(initiator, audioOnly) {
  if (chatMode === 'text' && !audioOnly) return; // no P2P video connection needed in plain text mode

  cleanupPeerConnection();
  pc = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    const tracks = audioOnly ? localStream.getAudioTracks() : localStream.getTracks();
    tracks.forEach(track => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video' && sender.setParameters) {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 4_000_000; // ~4 Mbps, sized for the 1080p capture above
        params.encodings[0].scaleResolutionDownBy = 1; // send at full captured resolution, no downscaling
        // Prefer staying sharp over staying smooth if bandwidth gets tight —
        // a random-chat video call is mostly people sitting still talking,
        // so resolution/clarity matters more here than frame rate.
        params.degradationPreference = 'maintain-resolution';
        sender.setParameters(params).catch(() => {});
      }
    });
  }

  pc.ontrack = (event) => {
    document.getElementById('remoteVideo').srcObject = event.streams[0];
    if (chatMode === 'video') {
      document.getElementById('previewOverlay').style.display = 'flex';
      clearConnectFailTimer();
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { candidate: event.candidate });
    }
  };

  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { sdp: offer });
    });
  }
}

socket.on('webrtc-offer', async ({ sdp }) => {
  if (!pc) startPeerConnection(false, chatMode === 'text');
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { sdp: answer });
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (pc) {
    try { await pc.addIceCandidate(candidate); } catch (e) { console.error(e); }
  }
});

function cleanupPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject = null;
  }
  remoteVideo.classList.remove('blurred');
  remoteVideo.classList.remove('partner-away-blur');
  document.getElementById('partnerAwayNote')?.remove();
  viewingPartnerProfile = false;
  document.getElementById('previewOverlay').style.display = 'none';
  clearConnectFailTimer(); // no-op if it wasn't running; also hides the fail overlay if it was showing
}

// ---- Text-mode live voice call (audio-only), consent-gated ----
const voiceBtn = document.getElementById('voiceBtn');
let voiceActive = false;

function setVoiceUI(active) {
  voiceActive = active;
  voiceBtn.classList.toggle('report', active); // reuse the red "report" styling to signal "live/end"
  voiceBtn.querySelector('.lb').textContent = active ? 'End Voice' : 'Voice';
}

voiceBtn.addEventListener('click', () => {
  if (voiceActive) {
    endVoiceCallIfActive(true);
    return;
  }
  voiceBtn.disabled = true;
  addMessage('Requesting a voice call...', 'system');
  socket.emit('voice-request');
});

socket.on('voice-request', () => {
  if (chatMode === 'video') { socket.emit('voice-response', { accepted: false }); return; }
  const card = document.createElement('div');
  card.className = 'verify-card';
  card.innerHTML = `
    <div>Your partner wants to start a voice call while you text. Agree?</div>
    <div class="actions">
      <button class="accept">Agree</button>
      <button class="decline">Decline</button>
    </div>
  `;
  card.querySelector('.accept').addEventListener('click', () => {
    socket.emit('voice-response', { accepted: true });
    card.remove();
    startPeerConnection(true, true); // acceptor initiates
    setVoiceUI(true);
  });
  card.querySelector('.decline').addEventListener('click', () => {
    socket.emit('voice-response', { accepted: false });
    card.remove();
  });
  addCard(card);
});

socket.on('voice-response', ({ accepted }) => {
  if (chatMode === 'video') return;
  voiceBtn.disabled = false;
  if (accepted) {
    addMessage('Partner agreed. Starting voice call...', 'system');
    startPeerConnection(false, true); // requester waits for acceptor's offer
    setVoiceUI(true);
  } else {
    addMessage('Partner declined the voice call.', 'system');
  }
});

function endVoiceCallIfActive(notify) {
  if (!voiceActive) return;
  cleanupPeerConnection();
  setVoiceUI(false);
  voiceBtn.disabled = false;
  if (notify) socket.emit('voice-end');
}

socket.on('voice-end', () => {
  if (voiceActive) {
    cleanupPeerConnection();
    setVoiceUI(false);
    if (chatMode !== 'video') addMessage('Partner ended the voice call.', 'system');
  }
});

// ---- Gender verification (blurred short video clip, text mode) ----
// Flow: clicking Verify immediately triggers a blurred clip exchange on
// BOTH sides automatically — no accept/decline, since a blurred clip poses
// no exposure risk and requiring consent would let a scammer just refuse.
// "Revealing" (unblurring) later is a separate, still consent-gated step.
const verifyBtn = document.getElementById('verifyBtn');
let pendingVerifyCard = null;

verifyBtn.addEventListener('click', () => {
  if (!localStream) {
    addMessage('Camera unavailable, cannot verify.', 'system');
    return;
  }
  verifyBtn.disabled = true;
  setTimeout(() => { verifyBtn.disabled = false; }, 4000);
  addMessage('Requesting mutual verification clip...', 'system');
  socket.emit('verify-request');
  recordVerifyClip();
});

// No accept/decline: partner's camera fires automatically too. Since the
// clip is blurred on arrival, there's no exposure risk in sending it —
// requiring consent here would just let a scammer refuse and dodge
// verification entirely.
socket.on('verify-request', () => {
  if (chatMode === 'video') return; // verify is a text-mode-only feature
  addMessage('Partner requested verification — sending your clip too.', 'system');
  recordVerifyClip();
});

function recordVerifyClip() {
  if (!localStream || localStream.getVideoTracks().length === 0) return;
  const clipStream = new MediaStream(localStream.getVideoTracks());
  let recorder;
  try {
    recorder = new MediaRecorder(clipStream, { mimeType: 'video/webm', videoBitsPerSecond: 2_500_000 });
  } catch (e) {
    return; // MediaRecorder / codec unsupported — silently skip
  }
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      socket.emit('verify-video', { video: reader.result });
      showVerifyClip(reader.result, true);
    };
    reader.readAsDataURL(blob);
  };
  recorder.start();
  setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 2500);
}

function showVerifyClip(dataUrl, isMine) {
  const card = document.createElement('div');
  card.className = 'verify-card';
  card.innerHTML = `
    <div>${isMine ? 'Your clip (sent, still blurred to them until they reveal)' : "Partner's clip (blurred)"}</div>
    <video src="${dataUrl}" autoplay loop muted playsinline class="${isMine ? 'mine' : ''}"></video>
    ${isMine ? '' : '<div class="actions"><button class="reveal-btn">Request Reveal</button></div>'}
  `;
  if (!isMine) {
    card.querySelector('.reveal-btn').addEventListener('click', () => {
      socket.emit('reveal-request');
      card.querySelector('.reveal-btn').disabled = true;
      card.querySelector('.reveal-btn').textContent = 'Reveal requested...';
    });
    card._media = card.querySelector('video');
  }
  addCard(card);
  if (!isMine) pendingVerifyCard = card;
}

socket.on('verify-video', ({ video }) => {
  if (chatMode === 'video') return;
  showVerifyClip(video, false);
});

socket.on('reveal-request', () => {
  if (chatMode === 'video') return;
  const card = document.createElement('div');
  card.className = 'verify-card';
  card.innerHTML = `
    <div>Your partner wants to reveal your verification clip (unblur it). Allow?</div>
    <div class="actions">
      <button class="accept">Allow</button>
      <button class="decline">Deny</button>
    </div>
  `;
  card.querySelector('.accept').addEventListener('click', () => {
    socket.emit('reveal-response', { accepted: true });
    card.remove();
  });
  card.querySelector('.decline').addEventListener('click', () => {
    socket.emit('reveal-response', { accepted: false });
    card.remove();
  });
  addCard(card);
});

socket.on('reveal-response', ({ accepted }) => {
  if (chatMode === 'video') return;
  if (accepted && pendingVerifyCard && pendingVerifyCard._media) {
    pendingVerifyCard._media.classList.add('revealed');
    addMessage('Partner allowed the reveal.', 'system');
  } else if (!accepted) {
    addMessage('Partner denied the reveal request.', 'system');
  }
});

// ---- Voice messages (hold-to-record, WhatsApp-style) ----
const micBtn = document.getElementById('micBtn');
const recordingHint = document.getElementById('recordingHint');
let voiceRecorder = null;
let voiceChunks = [];
let isRecordingMsg = false;

function startVoiceMessageRecording() {
  if (chatMode !== 'text' || !localStream || msgInput.disabled || isRecordingMsg) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  const audioStream = new MediaStream(audioTracks);
  try {
    voiceRecorder = new MediaRecorder(audioStream);
  } catch (e) {
    return;
  }
  voiceChunks = [];
  voiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
  voiceRecorder.onstop = () => {
    isRecordingMsg = false;
    micBtn.classList.remove('recording');
    recordingHint.classList.remove('show');
    if (voiceChunks.length === 0) return;
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      socket.emit('voice-message', { audio: reader.result });
      // Rendered from the server echo below (like text messages) so it
      // gets a real id for delete support, instead of optimistically here.
    };
    reader.readAsDataURL(blob);
  };
  voiceRecorder.start();
  isRecordingMsg = true;
  micBtn.classList.add('recording');
  recordingHint.classList.add('show');
}

function stopVoiceMessageRecording() {
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.stop();
  }
}

micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startVoiceMessageRecording(); });
micBtn.addEventListener('pointerup', stopVoiceMessageRecording);
micBtn.addEventListener('pointerleave', stopVoiceMessageRecording);
micBtn.addEventListener('pointercancel', stopVoiceMessageRecording);

function addVoiceMessage(dataUrl, isMine, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${isMine ? 'self' : 'partner'} voice-msg`;
  if (opts.id) wrap.dataset.id = opts.id;
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = dataUrl;
  wrap.appendChild(audio);
  if (opts.id) wrap.addEventListener('click', (e) => {
    if (e.target.closest('audio')) return; // let the player's own controls work
    if (selectionMode) { e.stopPropagation(); toggleMessageSelection(wrap); return; }
    openMsgActionMenu(e, wrap, isMine);
  });
  if (opts.id) attachLongPress(wrap);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

socket.on('voice-message', ({ id, audio, self }) => {
  if (chatMode === 'video') return;
  addVoiceMessage(audio, self, { id });
  if (!self) maybeMarkSeen();
});

// ---- Reply-to (Instagram/Facebook-style: tap a message, pick Reply, a
// quoted preview rides above the composer until sent or cancelled) and
// per-message delete — both work identically whether the message came
// through plain text mode or the video-mode chat overlay, since they
// share the same message pipeline. ----
let pendingReplyTo = null; // { id, text }
const replyBarEl = document.getElementById('replyBar');
const replyBarSenderEl = document.getElementById('replyBarSender');
const replyBarTextEl = document.getElementById('replyBarText');
document.getElementById('replyBarCancel').addEventListener('click', clearReplyBar);

function clearReplyBar() {
  pendingReplyTo = null;
  replyBarEl.style.display = 'none';
}

function startReply(id, text, isMine) {
  pendingReplyTo = { id, text };
  replyBarSenderEl.textContent = isMine ? 'yourself' : (partnerLabel.textContent || 'them');
  replyBarTextEl.textContent = text || 'Voice message';
  replyBarEl.style.display = 'flex';
  msgInput.focus();
}

const msgActionMenu = document.getElementById('msgActionMenu');
let msgActionTargetEl = null;
function openMsgActionMenu(e, el, isMine) {
  e.stopPropagation();
  msgActionTargetEl = el;
  msgActionMenu.querySelector('[data-act="delete-everyone"]').style.display = isMine ? 'block' : 'none';
  msgActionMenu.style.display = 'block';
  const rect = el.getBoundingClientRect();
  const menuRect = msgActionMenu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight) top = rect.top - menuRect.height - 6;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuRect.width - 10);
  msgActionMenu.style.top = `${Math.max(8, top)}px`;
  msgActionMenu.style.left = `${left}px`;
}
function closeMsgActionMenu() { msgActionMenu.style.display = 'none'; msgActionTargetEl = null; }
document.addEventListener('click', (e) => {
  if (msgActionMenu.style.display !== 'none' && !msgActionMenu.contains(e.target)) closeMsgActionMenu();
});
msgActionMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const el = msgActionTargetEl;
  if (!btn || !el) return;
  const id = el.dataset.id;
  const isMine = el.classList.contains('self');
  const bodyEl = el.querySelector('.msg-body');
  const text = bodyEl ? bodyEl.textContent : (el.classList.contains('voice-msg') ? 'Voice message' : '');
  if (btn.dataset.act === 'reply') startReply(id, text, isMine);
  else if (btn.dataset.act === 'delete-me') socket.emit('delete-message', { messageId: id, mode: 'me' });
  else if (btn.dataset.act === 'delete-everyone') socket.emit('delete-message', { messageId: id, mode: 'everyone' });
  closeMsgActionMenu();
});

// ---- Multi-select messages (long-press to start, WhatsApp/Telegram-style)
// Works identically in text mode and the video-mode chat overlay, since
// both render into this same #messages element. ----
let selectionMode = false;
const selectedMessageIds = new Set();
const selectionBarEl = document.getElementById('selectionBar');
const selCountEl = document.getElementById('selCount');
const selAllBtn = document.getElementById('selAllBtn');

function attachLongPress(el) {
  let timer = null;
  let fired = false;
  const start = (e) => {
    if (e.type === 'pointerdown' && e.button !== undefined && e.button !== 0) return;
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      if (!selectionMode) enterSelectionMode(el);
      else toggleMessageSelection(el);
    }, 480);
  };
  const cancel = () => { clearTimeout(timer); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  // Suppress the click that immediately follows a long-press firing, so it
  // doesn't also open the single-message action menu on release.
  el.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); fired = false; } }, true);
}

function enterSelectionMode(el) {
  selectionMode = true;
  closeMsgActionMenu();
  messagesEl.classList.add('selecting');
  document.querySelector('.chat-input').style.display = 'none';
  clearReplyBar();
  toggleMessageSelection(el);
}

function toggleMessageSelection(el) {
  const id = el.dataset.id;
  if (!id) return;
  if (selectedMessageIds.has(id)) {
    selectedMessageIds.delete(id);
    el.classList.remove('selected');
  } else {
    selectedMessageIds.add(id);
    el.classList.add('selected');
  }
  if (selectedMessageIds.size === 0) { exitSelectionMode(); return; }
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = selectedMessageIds.size;
  selCountEl.textContent = `${n} selected`;
  const selectableTotal = messagesEl.querySelectorAll('.msg[data-id]:not(.deleted)').length;
  selAllBtn.textContent = n >= selectableTotal ? 'Deselect all' : 'Select all';
  selectionBarEl.classList.add('show');
}

function exitSelectionMode() {
  selectionMode = false;
  selectedMessageIds.clear();
  messagesEl.classList.remove('selecting');
  messagesEl.querySelectorAll('.msg.selected').forEach(el => el.classList.remove('selected'));
  selectionBarEl.classList.remove('show');
  document.querySelector('.chat-input').style.display = '';
}

document.getElementById('selCancelBtn').addEventListener('click', exitSelectionMode);

selAllBtn.addEventListener('click', () => {
  const all = messagesEl.querySelectorAll('.msg[data-id]:not(.deleted)');
  const allSelected = selectedMessageIds.size >= all.length;
  all.forEach(el => {
    if (allSelected) el.classList.remove('selected');
    else { el.classList.add('selected'); selectedMessageIds.add(el.dataset.id); }
  });
  if (allSelected) selectedMessageIds.clear();
  if (selectedMessageIds.size === 0) { exitSelectionMode(); return; }
  updateSelectionBar();
});

document.getElementById('selDeleteBtn').addEventListener('click', () => {
  const n = selectedMessageIds.size;
  if (n === 0) return;
  if (!confirm(`Delete ${n} selected message${n > 1 ? 's' : ''} for you?`)) return;
  selectedMessageIds.forEach(id => socket.emit('delete-message', { messageId: id, mode: 'me' }));
  exitSelectionMode();
});

socket.on('message-deleted', ({ messageId, onlyForMe }) => {
  const el = messagesEl.querySelector(`[data-id="${messageId}"]`);
  if (!el) return;
  if (selectedMessageIds.has(messageId)) {
    selectedMessageIds.delete(messageId);
    if (selectionMode) { if (selectedMessageIds.size === 0) exitSelectionMode(); else updateSelectionBar(); }
  }
  if (onlyForMe) { el.remove(); return; }
  el.classList.add('deleted');
  el.querySelectorAll('audio, .msg-reply-quote').forEach(n => n.remove());
  const bodyEl = el.querySelector('.msg-body');
  if (bodyEl) bodyEl.textContent = 'This message was deleted';
  else el.textContent = 'This message was deleted';
  el.replaceWith(el.cloneNode(true)); // deleted messages aren't actionable — drop the old click listener
});

// ---- Disappearing messages: Never / 24 hours / Once seen — a shared
// per-conversation setting either person can change (Telegram-style),
// applying to every message in the thread whether sent from plain text
// mode or the video-mode chat overlay. ----
const disappearingBtn = document.getElementById('disappearingBtn');
const disappearingMenu = document.getElementById('disappearingMenu');
let currentDisappearingMode = 'none';

function updateDisappearingBtnVisibility() {
  disappearingBtn.style.display = activeConversationId ? 'inline-block' : 'none';
}

disappearingBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  disappearingMenu.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === currentDisappearingMode));
  const rect = disappearingBtn.getBoundingClientRect();
  disappearingMenu.style.display = 'block';
  const menuRect = disappearingMenu.getBoundingClientRect();
  disappearingMenu.style.top = `${rect.bottom + 6}px`;
  disappearingMenu.style.left = `${Math.min(Math.max(8, rect.left - 60), window.innerWidth - menuRect.width - 10)}px`;
});
document.addEventListener('click', (e) => {
  if (disappearingMenu.style.display !== 'none' && !disappearingMenu.contains(e.target) && e.target !== disappearingBtn) {
    disappearingMenu.style.display = 'none';
  }
});
disappearingMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  socket.emit('set-disappearing', { mode: btn.dataset.mode });
  disappearingMenu.style.display = 'none';
});
socket.on('disappearing-changed', ({ mode }) => {
  currentDisappearingMode = mode;
  const labels = { '24h': 'Messages now disappear after 24 hours', on_view: 'Messages now disappear once seen', none: 'Disappearing messages turned off' };
  if (labels[mode]) addMessage(labels[mode], 'system');
});

// ---- "More" (\u22ee) menu: Reviews / Clear chat / Mute / Block ----
const moreBtn = document.getElementById('moreBtn');
const moreMenu = document.getElementById('moreMenu');
const moreMenuMuteItem = document.getElementById('moreMenuMuteItem');
const moreMenuBlockItem = document.getElementById('moreMenuBlockItem');

function updateMoreBtnVisibility() {
  moreBtn.style.display = activeConversationId && currentPartnerId ? 'inline-block' : 'none';
  // The top-bar partner chip (avatar + status) doubles as the profile
  // link now that the old left-side bar is gone — only clickable once we
  // actually know who we're talking to.
  document.getElementById('partnerStatusChip')?.classList.toggle('disabled', !currentPartnerId);
}

moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenuMuteItem.textContent = currentPartnerMuted ? '\ud83d\udd15 Unmute notifications' : '\ud83d\udd07 Mute notifications';
  moreMenuBlockItem.textContent = '\ud83d\udeab Block';
  const rect = moreBtn.getBoundingClientRect();
  moreMenu.style.display = 'block';
  const menuRect = moreMenu.getBoundingClientRect();
  moreMenu.style.top = `${rect.bottom + 6}px`;
  moreMenu.style.left = `${Math.min(Math.max(8, rect.left - 140), window.innerWidth - menuRect.width - 10)}px`;
});
document.addEventListener('click', (e) => {
  if (moreMenu.style.display !== 'none' && !moreMenu.contains(e.target) && e.target !== moreBtn) {
    moreMenu.style.display = 'none';
  }
});
moreMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  moreMenu.style.display = 'none';
  if (btn.dataset.act === 'reviews') openReviewsPopup();
  else if (btn.dataset.act === 'clear-chat') clearCurrentChat();
  else if (btn.dataset.act === 'toggle-mute') toggleMuteCurrentPartner();
  else if (btn.dataset.act === 'toggle-block') blockCurrentPartner();
});

function clearCurrentChat() {
  if (!activeConversationId) return;
  if (!confirm('Clear this chat? This deletes the message history for both of you.')) return;
  fetch(`/api/history/${activeConversationId}/clear`, { method: 'POST', headers: authHeaders() })
    .then(r => r.json())
    .then(() => {
      messagesEl.innerHTML = '';
      showGlobalToast('Chat cleared.');
    })
    .catch(() => showGlobalToast('Could not clear chat — try again.'));
}

function toggleMuteCurrentPartner() {
  if (!currentPartnerId) return;
  const willMute = !currentPartnerMuted;
  socket.emit(willMute ? 'mute-user' : 'unmute-user', { userId: currentPartnerId });
  currentPartnerMuted = willMute; // optimistic; corrected by mute-ack if needed
  showGlobalToast(willMute ? 'Notifications muted for this person.' : 'Notifications unmuted.');
}
socket.on('mute-ack', ({ userId, muted }) => {
  if (userId === currentPartnerId) currentPartnerMuted = muted;
});

function blockCurrentPartner() {
  if (!currentPartnerId) return;
  if (!confirm('Block this person? You\u2019ll never be matched with them again, and this chat will end now.')) return;
  socket.emit('block-user', { userId: currentPartnerId });
  socket.emit('leave-chat');
  endCurrentChatUI('Blocked \u2014 you won\u2019t be matched with them again.');
}
socket.on('block-ack', () => { /* handled optimistically in blockCurrentPartner() */ });

// ---- Reviews & recent-chats popup ----
const reviewsBackdrop = document.getElementById('reviewsBackdrop');
const reviewsPopup = document.getElementById('reviewsPopup');
const reviewsPopupHeader = document.getElementById('reviewsPopupHeader');
const reviewsPopupContent = document.getElementById('reviewsPopupContent');
const reviewsPopupLoading = document.getElementById('reviewsPopupLoading');
const reviewsPopupEmpty = document.getElementById('reviewsPopupEmpty');
const reviewsPartnerPanel = document.getElementById('reviewsPartnerPanel');
const reviewsPartnerHead = document.getElementById('reviewsPartnerHead');
const reviewsList = document.getElementById('reviewsList');
const reviewsMessagesList = document.getElementById('reviewsMessagesList');
const reviewsPrevBtn = document.getElementById('reviewsPrevBtn');
const reviewsNextBtn = document.getElementById('reviewsNextBtn');
const reviewsPager = document.getElementById('reviewsPager');

let reviewsPartnersData = [];
let reviewsCurrentIndex = 0;
let reviewsLoadedOnce = false;

function openReviewsPopup() {
  reviewsBackdrop.classList.add('show');
  reviewsPopup.classList.add('show');
  resetReviewsPopupPosition();
  if (!reviewsLoadedOnce) loadReviewsPartners();
}
function closeReviewsPopup() {
  reviewsBackdrop.classList.remove('show');
  reviewsPopup.classList.remove('show');
}
document.getElementById('reviewsPopupClose').addEventListener('click', closeReviewsPopup);
reviewsBackdrop.addEventListener('click', closeReviewsPopup);

function resetReviewsPopupPosition() {
  reviewsPopup.style.top = '18%';
  reviewsPopup.style.left = '50%';
  reviewsPopup.style.transform = 'translateX(-50%)';
}

function loadReviewsPartners() {
  reviewsPopupLoading.style.display = 'flex';
  reviewsPopupEmpty.style.display = 'none';
  reviewsPartnerPanel.style.display = 'none';
  reviewsPager.innerHTML = '';
  reviewsPrevBtn.disabled = true;
  reviewsNextBtn.disabled = true;
  fetch('/api/history/recent-partners', { headers: authHeaders() })
    .then(r => r.json())
    .then(({ partners }) => {
      reviewsLoadedOnce = true;
      reviewsPartnersData = partners || [];
      reviewsCurrentIndex = 0;
      reviewsPopupLoading.style.display = 'none';
      if (!reviewsPartnersData.length) {
        reviewsPopupEmpty.style.display = 'flex';
        return;
      }
      buildReviewsPager();
      renderReviewsPartner();
    })
    .catch(() => {
      reviewsPopupLoading.style.display = 'none';
      reviewsPopupEmpty.style.display = 'flex';
      reviewsPopupEmpty.textContent = 'Could not load your chat history — try again.';
    });
}

// "<  1 2 3 ... 10  >" pager across the (up to 10) recent partners.
function buildReviewsPager() {
  reviewsPager.innerHTML = reviewsPartnersData.map((_, i) =>
    `<button type="button" class="reviews-pager-num" data-idx="${i}">${i + 1}</button>`
  ).join('');
}
reviewsPager.addEventListener('click', (e) => {
  const btn = e.target.closest('.reviews-pager-num');
  if (!btn) return;
  reviewsCurrentIndex = Number(btn.dataset.idx);
  renderReviewsPartner();
});

function renderReviewsPartner() {
  const data = reviewsPartnersData[reviewsCurrentIndex];
  if (!data) return;
  reviewsPartnerPanel.style.display = 'flex';
  reviewsPrevBtn.disabled = reviewsCurrentIndex === 0;
  reviewsNextBtn.disabled = reviewsCurrentIndex === reviewsPartnersData.length - 1;
  reviewsPager.querySelectorAll('.reviews-pager-num').forEach((btn, i) => btn.classList.toggle('active', i === reviewsCurrentIndex));

  const p = data.partner;
  const initial = (p.displayName || p.username || '?').charAt(0).toUpperCase();
  const avatarInner = p.photoUrl ? `<img src="${p.photoUrl}" alt="">` : initial;
  reviewsPartnerHead.innerHTML = `
    <div class="reviews-partner-avatar">${avatarInner}</div>
    <div class="reviews-partner-name">${escapeHtml(p.displayName || p.username || 'Stranger')}</div>
    <div class="reviews-partner-sub">${data.summary && data.summary.count ? `${data.summary.average.toFixed(1)}\u2605 \u00b7 ${data.summary.count} review${data.summary.count === 1 ? '' : 's'}` : 'No reviews yet'}</div>
    <button type="button" class="reviews-partner-view-link" data-user="${p.id}">View profile</button>`;
  reviewsPartnerHead.querySelector('.reviews-partner-view-link').addEventListener('click', () => openProfile(p.id));

  if (data.reviews && data.reviews.length) {
    reviewsList.innerHTML = data.reviews.map(r => `
      <div class="review-card">
        <div class="review-card-top">
          <span class="review-card-author">${escapeHtml(r.reviewer.displayName || r.reviewer.username || 'Anonymous')}</span>
          <span class="review-card-tag ${escapeHtml(r.tag || '')}">${escapeHtml(r.tag || '')}</span>
        </div>
        ${r.comment ? `<div class="review-card-comment">${escapeHtml(r.comment)}</div>` : ''}
      </div>`).join('');
  } else {
    reviewsList.innerHTML = '<div class="reviews-list-empty">No reviews left for this person yet.</div>';
  }

  if (data.messages && data.messages.length) {
    reviewsMessagesList.innerHTML = data.messages.map(m => `
      <div class="reviews-msg-row ${m.mine ? 'mine' : ''}">
        <div class="reviews-msg-bubble">${escapeHtml(m.deleted ? 'Message deleted' : (m.type === 'voice' ? 'Voice message' : (m.text || '')))}</div>
      </div>`).join('');
  } else {
    reviewsMessagesList.innerHTML = '<div class="reviews-messages-empty">No messages with this person yet.</div>';
  }
  reviewsMessagesList.scrollTop = reviewsMessagesList.scrollHeight;
}

reviewsPrevBtn.addEventListener('click', () => {
  if (reviewsCurrentIndex > 0) { reviewsCurrentIndex--; renderReviewsPartner(); }
});
reviewsNextBtn.addEventListener('click', () => {
  if (reviewsCurrentIndex < reviewsPartnersData.length - 1) { reviewsCurrentIndex++; renderReviewsPartner(); }
});

// Draggable popup: grab the header and move the whole box around the
// screen with the pointer; released position is remembered until closed.
(function makeReviewsPopupDraggable() {
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  reviewsPopupHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.reviews-popup-close')) return;
    dragging = true;
    const rect = reviewsPopup.getBoundingClientRect();
    // Switch from the initial centered transform to absolute left/top so
    // dragging math stays simple.
    reviewsPopup.style.left = `${rect.left}px`;
    reviewsPopup.style.top = `${rect.top}px`;
    reviewsPopup.style.transform = 'none';
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    reviewsPopupHeader.setPointerCapture(e.pointerId);
  });
  reviewsPopupHeader.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const maxLeft = window.innerWidth - reviewsPopup.offsetWidth - 4;
    const maxTop = window.innerHeight - reviewsPopup.offsetHeight - 4;
    reviewsPopup.style.left = `${Math.min(Math.max(4, startLeft + dx), Math.max(4, maxLeft))}px`;
    reviewsPopup.style.top = `${Math.min(Math.max(4, startTop + dy), Math.max(4, maxTop))}px`;
  });
  reviewsPopupHeader.addEventListener('pointerup', (e) => { dragging = false; try { reviewsPopupHeader.releasePointerCapture(e.pointerId); } catch (_) {} });
  reviewsPopupHeader.addEventListener('pointercancel', () => { dragging = false; });
})();

// Momentum/inertia scroll for the previous-messages list: dragging with a
// mouse (or a touch drag that starts here) scrolls the list, and letting
// go keeps it scrolling with a decaying velocity — the same feel as
// native touch-scroll momentum, but also works for a desktop mouse drag.
// Native touch scrolling (finger drag without JS involvement) still works
// as normal and already gets iOS's built-in momentum via
// -webkit-overflow-scrolling: touch in the CSS above.
function initInertiaScroll(el) {
  let dragging = false, moved = false, startY = 0, startScroll = 0, lastY = 0, lastT = 0, velocity = 0, rafId = null;

  function stopMomentum() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function momentumStep() {
    velocity *= 0.95; // decay per frame
    el.scrollTop -= velocity;
    if (Math.abs(velocity) > 0.5 && el.scrollTop > 0 && el.scrollTop < el.scrollHeight - el.clientHeight) {
      rafId = requestAnimationFrame(momentumStep);
    } else {
      rafId = null;
    }
  }

  el.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false;
    stopMomentum();
    startY = lastY = e.clientY;
    startScroll = el.scrollTop;
    lastT = performance.now();
    velocity = 0;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    el.scrollTop = startScroll - dy;
    const now = performance.now();
    const dt = now - lastT || 16;
    velocity = (e.clientY - lastY) / dt * 16; // px per ~frame
    lastY = e.clientY; lastT = now;
  });
  function release(e) {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved && Math.abs(velocity) > 0.5) momentumStep();
  }
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}
initInertiaScroll(reviewsMessagesList);

// ---- Read receipts: tell the server we're actively viewing this chat
// (also what drives 'on_view' disappearing deletion server-side) ----
function maybeMarkSeen() {
  if (document.getElementById('chatScreen').classList.contains('active')) socket.emit('mark-seen');
}

// ---- Chat history panel (Telegram-style: renamed "All Chats") & resuming
// a past stranger, plus (new) people search, friend requests and profiles ----
let activeConversationId = null;
let currentPartnerId = null; // real user id of whoever we're currently matched with, if known
let currentPartnerMuted = false; // have I muted notifications from the current partner?
let viewingPartnerProfile = false; // true while the partner's profile overlay is open (drives the remote blur signal)
const historyPanel = document.getElementById('historyPanel');
const historyBackdrop = document.getElementById('historyBackdrop');
const historyList = document.getElementById('historyList');
const userSearchInput = document.getElementById('userSearchInput');
const requestsBadge = document.getElementById('requestsBadge');
let activeTab = 'chats'; // 'chats' | 'requests' | 'friends'
let allChatsCache = [];

function showResumeBanner(text) {
  // Surfaces connection notices (offline/busy partner, etc.) as a toast —
  // fixed-position, so it never squeezes the chat screen's height the way
  // an inline banner would.
  showGlobalToast(text);
}
function hideResumeBanner() {
  // No-op now that these are toasts (they auto-dismiss on their own), kept
  // so existing call sites don't need to change.
}

function authHeaders() {
  return { Authorization: `Bearer ${authToken}` };
}

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function previewFor(lastMessage) {
  if (!lastMessage) return 'No messages yet';
  const prefix = lastMessage.mine ? 'You: ' : '';
  if (lastMessage.type === 'voice') return `${prefix}🎤 Voice message`;
  return `${prefix}${lastMessage.text || ''}`;
}

async function openHistory() {
  if (!authToken) return;
  historyBackdrop.classList.add('show');
  historyPanel.classList.add('show');
  userSearchInput.value = '';
  setTab('chats');
  refreshRequestsBadge();
}

function closeHistory() {
  historyBackdrop.classList.remove('show');
  historyPanel.classList.remove('show');
}

historyBtn.addEventListener('click', openHistory);

// Notifications: no dedicated notification feed exists on the server yet,
// so this is wired up as a placeholder entry point (badge stays hidden
// until there's a real unread count to show).
document.getElementById('notifBtn')?.addEventListener('click', () => {
  showGlobalToast('No new notifications.');
});
document.getElementById('closeHistoryBtn').addEventListener('click', closeHistory);
historyBackdrop.addEventListener('click', closeHistory);

document.getElementById('historyTabs').querySelectorAll('.history-tab').forEach(el => {
  el.addEventListener('click', () => setTab(el.dataset.tab));
});

document.getElementById('deleteAllChatsBtn').addEventListener('click', async () => {
  if (!confirm('Delete all conversations? This removes every chat for both you and the other person, and cannot be undone.')) return;
  try {
    await fetch('/api/history/delete-all', { method: 'POST', headers: authHeaders() });
    historyList.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
    if (activeConversationId) {
      addMessage('This conversation was deleted.', 'system');
      activeConversationId = null;
      updateDisappearingBtnVisibility();
      updateMoreBtnVisibility();
      setChatEnabled(false);
    }
  } catch (e) {
    showStatusToast("Couldn't delete conversations. Try again.");
  }
});

// The other participant in a conversation we just deleted (or that they
// deleted on their end) gets this so their open chat/history reflects it
// live instead of silently going stale.
socket.on('conversation-deleted', ({ conversationId }) => {
  if (activeConversationId === conversationId) {
    addMessage('This conversation was deleted.', 'system');
    activeConversationId = null;
    updateDisappearingBtnVisibility();
    updateMoreBtnVisibility();
    setChatEnabled(false);
  }
  if (historyPanel.classList.contains('show')) loadChatsTab();
});

function setTab(tab) {
  activeTab = tab;
  document.getElementById('historyTabs').querySelectorAll('.history-tab').forEach(el => {
    el.classList.toggle('selected', el.dataset.tab === tab);
  });
  document.getElementById('contactsMatchRow').style.display = tab === 'suggested' ? 'flex' : 'none';
  const q = userSearchInput.value.trim();
  if (q) { runUserSearch(q); return; }
  if (tab === 'chats') loadChatsTab();
  else if (tab === 'requests') loadRequestsTab();
  else if (tab === 'friends') loadFriendsTab();
  else if (tab === 'suggested') loadSuggestedTab();
}

let searchDebounce = null;
userSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = userSearchInput.value.trim();
  if (!q) { setTab(activeTab); return; }
  searchDebounce = setTimeout(() => runUserSearch(q), 250);
});

async function runUserSearch(q) {
  historyList.innerHTML = '<div class="history-empty">Searching...</div>';
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
    const data = await res.json();
    renderPeopleList(data.users || [], { emptyText: 'No people found.' });
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Search failed.</div>';
  }
}

async function loadChatsTab() {
  historyList.innerHTML = '<div class="history-empty">Loading...</div>';
  try {
    const res = await fetch('/api/history', { headers: authHeaders() });
    const data = await res.json();
    allChatsCache = data.conversations || [];
    renderHistoryList(allChatsCache);
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Could not load chats.</div>';
  }
}

async function loadRequestsTab() {
  historyList.innerHTML = '<div class="history-empty">Loading...</div>';
  try {
    const res = await fetch('/api/friends/requests', { headers: authHeaders() });
    const data = await res.json();
    renderRequestsList(data.requests || []);
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Could not load requests.</div>';
  }
}

async function loadFriendsTab() {
  historyList.innerHTML = '<div class="history-empty">Loading...</div>';
  try {
    const res = await fetch('/api/friends', { headers: authHeaders() });
    const data = await res.json();
    renderPeopleList(data.friends || [], { emptyText: "You haven't added any friends yet." });
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Could not load friends.</div>';
  }
}

async function loadSuggestedTab() {
  historyList.innerHTML = '<div class="history-empty">Loading...</div>';
  try {
    const res = await fetch('/api/users/suggestions', { headers: authHeaders() });
    const data = await res.json();
    renderPeopleList(data.suggestions || [], { emptyText: 'No suggestions yet — add a few friends and we\'ll find more people you may know.' });
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Could not load suggestions.</div>';
  }
}

// ---- Contacts matching ----
// Same idea as WhatsApp/Instagram's "find people from your contacts":
// the phone book itself never leaves the device — each number is
// normalized and hashed locally, and only the hashes are sent to the
// server to check against existing accounts (see normalizePhoneHash in
// db.js for the identical server-side algorithm).
function normalizePhoneForHash(raw) {
  return String(raw || '').replace(/\D/g, '').slice(-10);
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const contactsMatchBtn = document.getElementById('contactsMatchBtn');
const contactsMatchStatus = document.getElementById('contactsMatchStatus');

contactsMatchBtn.addEventListener('click', async () => {
  // The Contact Picker API only exists on Chrome for Android today — feature-detect and explain rather than fail silently elsewhere.
  if (!('contacts' in navigator) || !navigator.contacts?.select) {
    contactsMatchStatus.textContent = "Contacts access isn't supported in this browser — try Chrome on Android.";
    return;
  }
  contactsMatchBtn.disabled = true;
  contactsMatchStatus.textContent = '';
  try {
    const contacts = await navigator.contacts.select(['tel'], { multiple: true });
    const numbers = contacts.flatMap(c => c.tel || []);
    const digitsSet = new Set(numbers.map(normalizePhoneForHash).filter(d => d.length >= 7));
    if (!digitsSet.size) {
      contactsMatchStatus.textContent = 'No phone numbers found in the selected contacts.';
      return;
    }
    const hashes = await Promise.all([...digitsSet].map(sha256Hex));
    const res = await fetch('/api/contacts/match', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    const data = await res.json();
    const matches = (data.matches || []).map(u => ({ ...u, reason: 'contacts' }));
    if (!matches.length) {
      contactsMatchStatus.textContent = "None of your contacts are on SyncChat yet.";
      return;
    }
    contactsMatchStatus.textContent = `Found ${matches.length} from your contacts.`;
    // Merge on top of whatever's currently shown (suggestions), de-duping by id.
    const existingIds = new Set([...historyList.querySelectorAll('[data-user]')].map(el => el.dataset.user));
    const merged = [...matches.filter(m => !existingIds.has(m.id)), ...(await (async () => {
      const r = await fetch('/api/users/suggestions', { headers: authHeaders() });
      const d = await r.json();
      return d.suggestions || [];
    })())];
    renderPeopleList(merged, { emptyText: 'No suggestions yet.' });
  } catch (e) {
    // User cancelling the picker throws too — not a real error, just no-op.
    if (e && e.name !== 'AbortError') contactsMatchStatus.textContent = "Couldn't access contacts.";
  } finally {
    contactsMatchBtn.disabled = false;
  }
});

async function refreshRequestsBadge() {
  try {
    const res = await fetch('/api/friends/requests', { headers: authHeaders() });
    const data = await res.json();
    const n = (data.requests || []).length;
    requestsBadge.textContent = String(n);
    requestsBadge.style.display = n > 0 ? 'inline-block' : 'none';
  } catch (e) { /* non-critical */ }
}

function renderHistoryList(conversations) {
  if (conversations.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
    return;
  }
  historyList.innerHTML = '';
  conversations.forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const unread = item.unreadCount || 0;
    if (unread > 0) el.classList.add('has-unread');
    const badgeHtml = unread > 0 ? `<span class="history-unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    el.innerHTML = `
      ${smallAvatarHtml(item.partner, `<span class="online-dot ${item.online ? 'on' : ''}"></span>`)}
      <div class="history-item-body">
        <div class="history-item-top">
          <span class="history-item-name">${item.partner.displayName || item.partner.username}</span>
          <span class="history-item-time">${formatWhen(item.updatedAt)}</span>
        </div>
        <div class="history-item-preview">${previewFor(item.lastMessage)}</div>
      </div>
      ${badgeHtml}
    `;
    // Tapping the round photo opens their profile; tapping the rest of the
    // row (name/preview/time) opens the text chat itself — same split as
    // Instagram/Facebook's chat list.
    el.querySelector('.history-avatar').addEventListener('click', (e) => {
      e.stopPropagation();
      closeHistory();
      openProfile(item.partner.id);
    });
    el.querySelector('.history-item-body').addEventListener('click', () => resumeConversation(item));
    historyList.appendChild(el);
  });
}

// ---- People search / friends / requests rendering ----
function smallAvatarHtml(u, extra = '') {
  const genderClass = u.gender === 'female' ? 'female' : 'male';
  const initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
  const inner = u.photoUrl ? `<img src="${u.photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : initial;
  return `<div class="history-avatar ${genderClass}">${inner}${extra}</div>`;
}

function friendBtnHtml(status, userId) {
  if (status === 'friends') return `<button class="friend-btn muted" data-action="unfriend" data-user="${userId}">Friends &#10003;</button>`;
  if (status === 'pending_outgoing') return `<button class="friend-btn muted" disabled>Requested</button>`;
  if (status === 'pending_incoming') {
    return `<button class="friend-btn primary" data-action="accept-from" data-user="${userId}">Accept</button>
      <button class="friend-btn muted" data-action="reject-from" data-user="${userId}">Reject</button>`;
  }
  return `<button class="friend-btn primary" data-action="add" data-user="${userId}">Add Friend</button>`;
}

function reasonText(u) {
  if (u.reason === 'contacts') return 'From your contacts';
  if (u.reason === 'mutual') return `${u.mutualCount} mutual friend${u.mutualCount === 1 ? '' : 's'}`;
  if (u.reason === 'nearby') return 'Near you';
  return u.online ? 'Online' : 'Offline';
}

function videoCallBtnHtml(u) {
  if (u.friendStatus !== 'friends') return '';
  return `<button class="friend-btn primary" data-action="call" data-user="${u.id}" data-name="${(u.displayName || u.username || '').replace(/"/g, '&quot;')}" ${u.online ? '' : 'disabled'}>&#128249; ${u.online ? 'Video Call' : 'Offline'}</button>`;
}

function followBtnHtml(u) {
  return u.isFollowing
    ? `<button class="friend-btn" data-action="unfollow" data-user="${u.id}">Following</button>`
    : `<button class="friend-btn primary" data-action="follow" data-user="${u.id}">Follow</button>`;
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="follow"], [data-action="unfollow"]');
  if (!btn) return;
  const isFollow = btn.dataset.action === 'follow';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/users/${btn.dataset.user}/${isFollow ? 'follow' : 'unfollow'}`, {
      method: 'POST', headers: authHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    if (currentProfileUser && currentProfileUser.id === btn.dataset.user) {
      currentProfileUser.isFollowing = data.isFollowing;
      currentProfileUser.followers = data.followers;
      currentProfileUser.following = data.following;
      renderProfile(currentProfileUser);
    }
  } catch (err) {
    showGlobalToast(err.message || 'Could not update follow status.');
    btn.disabled = false;
  }
});

function renderPeopleList(users, { emptyText }) {
  if (!users.length) {
    historyList.innerHTML = `<div class="history-empty">${emptyText}</div>`;
    return;
  }
  historyList.innerHTML = '';
  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      ${smallAvatarHtml(u, `<span class="online-dot ${u.online ? 'on' : ''}"></span>`)}
      <div class="history-item-body">
        <div class="history-item-top"><span class="history-item-name">${u.displayName || u.username}</span></div>
        <div class="history-item-preview">${reasonText(u)}</div>
      </div>
      <div class="friend-btn-row">${videoCallBtnHtml(u)}${friendBtnHtml(u.friendStatus, u.id)}</div>
    `;
    el.querySelector('.history-item-body').addEventListener('click', () => openProfile(u.id));
    wireFriendButtons(el);
    historyList.appendChild(el);
  });
}

function renderRequestsList(requests) {
  if (!requests.length) {
    historyList.innerHTML = '<div class="history-empty">No pending friend requests.</div>';
    return;
  }
  historyList.innerHTML = '';
  requests.forEach(r => {
    const u = r.from;
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      ${smallAvatarHtml(u)}
      <div class="history-item-body">
        <div class="history-item-top"><span class="history-item-name">${u.displayName || u.username}</span></div>
        <div class="history-item-preview">Wants to be friends</div>
      </div>
      <div class="friend-btn-row">
        <button class="friend-btn primary" data-request-action="accept" data-request="${r.id}">Accept</button>
        <button class="friend-btn muted" data-request-action="reject" data-request="${r.id}">Reject</button>
      </div>
    `;
    el.querySelector('.history-item-body').addEventListener('click', () => openProfile(u.id));
    el.querySelector('[data-request-action="accept"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/friends/requests/${r.id}/accept`, { method: 'POST', headers: authHeaders() });
      loadRequestsTab(); refreshRequestsBadge();
    });
    el.querySelector('[data-request-action="reject"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/friends/requests/${r.id}/reject`, { method: 'POST', headers: authHeaders() });
      loadRequestsTab(); refreshRequestsBadge();
    });
    historyList.appendChild(el);
  });
}

function wireFriendButtons(container) {
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.user;
      const action = btn.dataset.action;
      if (action === 'call') {
        callFriend(userId, btn.dataset.name || 'Friend');
        return;
      }
      if (action === 'add') {
        await fetch('/api/friends/request', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      } else if (action === 'unfriend') {
        if (!confirm('Remove this friend?')) return;
        await fetch(`/api/friends/${userId}`, { method: 'DELETE', headers: authHeaders() });
      } else if (action === 'accept-from') {
        // Requests list here is keyed by user, not request id — resolve via the requests endpoint.
        const res = await fetch('/api/friends/requests', { headers: authHeaders() });
        const data = await res.json();
        const req = (data.requests || []).find(r => r.from.id === userId);
        if (req) await fetch(`/api/friends/requests/${req.id}/accept`, { method: 'POST', headers: authHeaders() });
      } else if (action === 'reject-from') {
        const res = await fetch('/api/friends/requests', { headers: authHeaders() });
        const data = await res.json();
        const req = (data.requests || []).find(r => r.from.id === userId);
        if (req) await fetch(`/api/friends/requests/${req.id}/reject`, { method: 'POST', headers: authHeaders() });
      }
      refreshRequestsBadge();
      setTab(activeTab);
    });
  });
}

// ---- Profile (full-page view, Instagram/Facebook-style) ----
const profileModal = document.getElementById('profileModal');
const profileBody = document.getElementById('profileBody');
const profileEditBtn = document.getElementById('profileEditBtn');
const profileHeaderTitle = document.getElementById('profileHeaderTitle');
let currentProfileUser = null;

async function openProfile(userId) {
  profileModal.classList.add('show');
  profileBody.innerHTML = '<div class="history-empty">Loading...</div>';
  profileEditBtn.style.display = 'none';
  // If we're opening our current video-call partner's profile, tell their
  // side to blur its view of us until we come back (see closeProfile()).
  if (chatMode === 'video' && userId && userId === currentPartnerId) {
    viewingPartnerProfile = true;
    socket.emit('viewing-profile', { viewing: true });
  }
  try {
    const res = await fetch(`/api/users/${userId}`, { headers: authHeaders() });
    const data = await res.json();
    currentProfileUser = data.user;
    renderProfile(data.user);
  } catch (e) {
    profileBody.innerHTML = '<div class="history-empty">Could not load profile.</div>';
  }
}
function closeProfile() {
  profileModal.classList.remove('show');
  if (viewingPartnerProfile) {
    viewingPartnerProfile = false;
    socket.emit('viewing-profile', { viewing: false });
  }
}
document.getElementById('profileCloseBtn').addEventListener('click', closeProfile);
profileEditBtn.addEventListener('click', () => { if (currentProfileUser) renderEditProfile(currentProfileUser); });

// Clicking the stranger's own video tile / name opens their profile without
// interrupting the call or chat underneath (the profile is just an overlay).
partnerLabel.addEventListener('click', () => { if (currentPartnerId) openProfile(currentPartnerId); });
const partnerStatusChip = document.getElementById('partnerStatusChip');
partnerStatusChip.addEventListener('click', () => { if (currentPartnerId) openProfile(currentPartnerId); });
partnerStatusChip.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && currentPartnerId) { e.preventDefault(); openProfile(currentPartnerId); }
});

// The partner is telling us they've stepped away to view our profile —
// blur our view of their incoming video until they come back.
socket.on('partner-viewing-profile', ({ viewing }) => {
  const remoteVideo = document.getElementById('remoteVideo');
  if (!remoteVideo) return;
  remoteVideo.classList.toggle('partner-away-blur', !!viewing);
  let note = document.getElementById('partnerAwayNote');
  if (viewing) {
    if (!note) {
      note = document.createElement('div');
      note.id = 'partnerAwayNote';
      note.className = 'partner-away-note';
      note.textContent = 'Stepped away to view your profile...';
      document.querySelector('#remoteVideo').parentElement.appendChild(note);
    }
  } else if (note) {
    note.remove();
  }
});

// ---- Round avatar button + right-side menu (Instagram/Facebook-style) ----
function renderAvatarBtn() {
  const btn = document.getElementById('avatarMenuBtn');
  if (!btn || !currentUser) return;
  const genderClass = currentUser.gender === 'female' ? 'female' : 'male';
  const initial = (currentUser.displayName || currentUser.username || '?').charAt(0).toUpperCase();
  btn.className = `avatar-btn ${genderClass}`;
  btn.innerHTML = currentUser.photoUrl ? `<img src="${currentUser.photoUrl}" alt="">` : initial;
}

const sideMenu = document.getElementById('sideMenu');
const sideMenuBackdrop = document.getElementById('sideMenuBackdrop');

function openSideMenu() {
  if (!currentUser) return;
  renderAvatarBtn();
  const avatarEl = document.getElementById('sideMenuAvatar');
  const genderClass = currentUser.gender === 'female' ? 'female' : 'male';
  const initial = (currentUser.displayName || currentUser.username || '?').charAt(0).toUpperCase();
  avatarEl.className = `side-menu-avatar ${genderClass}`;
  avatarEl.innerHTML = currentUser.photoUrl ? `<img src="${currentUser.photoUrl}" alt="">` : initial;
  document.getElementById('sideMenuName').textContent = currentUser.displayName || currentUser.username;
  sideMenuBackdrop.classList.add('show');
  sideMenu.classList.add('show');
}
function closeSideMenu() {
  sideMenuBackdrop.classList.remove('show');
  sideMenu.classList.remove('show');
  document.getElementById('smiSettingsToggle').classList.remove('expanded');
  document.getElementById('smiSettingsSub').classList.remove('show');
}
document.getElementById('avatarMenuBtn').addEventListener('click', openSideMenu);
document.getElementById('sideMenuCloseBtn').addEventListener('click', closeSideMenu);
sideMenuBackdrop.addEventListener('click', closeSideMenu);
document.getElementById('sideMenuHeader').addEventListener('click', () => {
  closeSideMenu();
  openProfile(currentUser.id);
});

document.getElementById('smiProfile').addEventListener('click', () => {
  closeSideMenu();
  openProfile(currentUser.id);
});
document.getElementById('smiEditProfile').addEventListener('click', async () => {
  closeSideMenu();
  await openProfile(currentUser.id);
  renderEditProfile(currentProfileUser);
});
document.getElementById('smiAllChats').addEventListener('click', () => {
  closeSideMenu();
  openHistory();
});
document.getElementById('smiMatchPrefs').addEventListener('click', () => {
  closeSideMenu();
  openCountryModal();
});
document.getElementById('smiSettingsToggle').addEventListener('click', function () {
  this.classList.toggle('expanded');
  document.getElementById('smiSettingsSub').classList.toggle('show');
});

// Sound settings: five independent, persisted categories (chat messages,
// generic notifications, connect, stop/end, skip) plus a master switch —
// each plays its own short, distinct synthesized tone so you can tell
// what happened without looking at the screen.
document.getElementById('smiSoundToggle').addEventListener('click', function () {
  this.classList.toggle('expanded');
  document.getElementById('smiSoundSub').classList.toggle('show');
});

const SOUND_CATEGORIES = ['message', 'notification', 'connect', 'stop', 'skip'];
const soundPrefs = {};
SOUND_CATEGORIES.forEach(cat => { soundPrefs[cat] = localStorage.getItem(`syncchat_sound_${cat}`) !== 'off'; });

function updateSoundToggleUI() {
  SOUND_CATEGORIES.forEach(cat => {
    const el = document.querySelector(`[data-sound-cat="${cat}"]`);
    if (el) el.checked = soundPrefs[cat];
  });
  document.getElementById('soundMasterToggle').checked = SOUND_CATEGORIES.every(cat => soundPrefs[cat]);
}
updateSoundToggleUI();

document.getElementById('soundMasterToggle').addEventListener('change', (e) => {
  const on = e.target.checked;
  SOUND_CATEGORIES.forEach(cat => {
    soundPrefs[cat] = on;
    localStorage.setItem(`syncchat_sound_${cat}`, on ? 'on' : 'off');
  });
  updateSoundToggleUI();
});
SOUND_CATEGORIES.forEach(cat => {
  const el = document.querySelector(`[data-sound-cat="${cat}"]`);
  if (!el) return;
  el.addEventListener('change', () => {
    soundPrefs[cat] = el.checked;
    localStorage.setItem(`syncchat_sound_${cat}`, el.checked ? 'on' : 'off');
    updateSoundToggleUI();
  });
});

// A single, reused AudioContext. Creating a brand-new one for every single
// sound (the old approach) meant most of them silently never played —
// browsers suspend audio contexts that aren't tied to a genuine user
// gesture, and a fresh context created deep inside an event handler is
// exactly the case that gets suspended. Reusing one context and resuming
// it on demand is what actually makes sound playback reliable.
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) {
    try { sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}
// Warm up the context on the very first tap/click anywhere, so it's ready
// (and un-suspended) well before the first sound needs to play.
document.addEventListener('click', () => { getAudioCtx(); }, { once: true });

function playTone(freq, duration, delay = 0, waveform = 'sine', peakGain = 0.13) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = waveform;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peakGain, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function playSound(category) {
  if (!soundPrefs[category]) return;
  switch (category) {
    case 'message': playTone(760, 0.16); break;
    case 'notification': playTone(560, 0.14); playTone(840, 0.18, 0.09); break;
    case 'connect': playTone(440, 0.12); playTone(660, 0.12, 0.1); playTone(880, 0.22, 0.2); break;
    case 'stop': playTone(320, 0.22, 0, 'sine', 0.11); break;
    case 'skip': playTone(600, 0.09); playTone(600, 0.09, 0.11); break;
  }
}

document.getElementById('smiPrivacy').addEventListener('click', () => {
  showGlobalToast('Every chat is anonymous by default — reporting someone bans them immediately, and you can block or delete any conversation from All Chats.');
});
document.getElementById('smiHelp').addEventListener('click', () => {
  showGlobalToast('Need help? Reach out to us at support@syncchat.app');
});
document.getElementById('smiAbout').addEventListener('click', () => {
  showGlobalToast('SyncChat — Verified Random Chat. Meet new people, safely.');
});
document.getElementById('smiLogout').addEventListener('click', () => {
  if (!confirm('Log out of SyncChat?')) return;
  socket.emit('skip');
  localStorage.removeItem('syncchat_token');
  location.reload();
});

function avatarLgHtml(u) {
  const genderClass = u.gender === 'female' ? 'female' : 'male';
  const initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
  return u.photoUrl
    ? `<div class="profile-avatar-lg ${genderClass}"><img src="${u.photoUrl}" alt=""></div>`
    : `<div class="profile-avatar-lg ${genderClass}">${initial}</div>`;
}

function renderProfile(u) {
  const isSelf = u.friendStatus === 'self';
  const headerEl = document.querySelector('.profile-page-header');
  headerEl.classList.add('on-cover');
  profileHeaderTitle.textContent = isSelf ? 'My Profile' : (u.displayName || u.username);
  profileEditBtn.style.display = isSelf ? 'block' : 'none';
  const actionsHtml = isSelf ? '' : `<div class="profile-actions">${videoCallBtnHtml(u)}${friendBtnHtml(u.friendStatus, u.id)}${followBtnHtml(u)}</div>`;
  const showUsername = (u.displayName && u.displayName !== u.username) ? `<div class="profile-username">@${u.username}</div>` : '';
  const bioHtml = u.bio ? `<div class="profile-bio">${escapeHtml(u.bio)}</div>` : `<div class="profile-bio empty">${isSelf ? 'Add a bio to tell people about yourself.' : 'No bio yet.'}</div>`;
  const genderClass = u.gender === 'female' ? 'female' : 'male';
  const statsHtml = `
    <div class="profile-stats">
      <div class="profile-stat"><span class="profile-stat-n">${u.followers ?? 0}</span><span class="profile-stat-lb">Followers</span></div>
      <div class="profile-stat"><span class="profile-stat-n">${u.following ?? 0}</span><span class="profile-stat-lb">Following</span></div>
    </div>`;
  const badgesHtml = `
    <div class="profile-badges">
      <span class="profile-badge ${u.online ? 'online' : ''}"><span class="dot"></span>${u.online ? 'Online now' : 'Offline'}</span>
      ${u.isPremium ? `<span class="profile-badge premium">&#11088; Premium</span>` : ''}
      <span class="profile-badge">${u.gender === 'female' ? '&#9792;' : '&#9794;'} ${u.gender === 'female' ? 'Female' : 'Male'}</span>
    </div>`;
  const youtubeHtml = u.youtubeLink
    ? `<a class="profile-youtube-link" href="${escapeHtml(u.youtubeLink)}" target="_blank" rel="noopener noreferrer">&#9654; Verify on YouTube</a>`
    : (isSelf ? `<div class="profile-youtube-link empty">Add your YouTube channel link in Edit Profile to help others trust you're real.</div>` : '');
  profileBody.innerHTML = `
    <div class="profile-cover ${genderClass}"></div>
    <div class="profile-avatar-wrap ${u.online ? 'online' : ''}">${avatarLgHtml(u)}</div>
    <div class="profile-top">
      <div class="profile-name-row">
        <div class="profile-name">${u.displayName || u.username}</div>
        ${u.isPremium ? '<span class="verified-badge" title="Premium member">&#10004;</span>' : ''}
      </div>
      ${showUsername}
      ${statsHtml}
      ${badgesHtml}
      ${youtubeHtml}
    </div>
    <div class="profile-bio-card"><div class="profile-bio-label">About</div>${bioHtml}</div>
    ${actionsHtml}
    <div class="profile-reviews-section" id="profileReviewsSection"><div class="history-empty">Loading reviews...</div></div>
  `;
  wireFriendButtons(profileBody);
  profileBody.querySelectorAll('[data-action]').forEach(btn => {
    if (btn.dataset.action === 'call' || btn.dataset.action === 'follow' || btn.dataset.action === 'unfollow') return; // handled elsewhere
    // Refresh the profile itself after any friend action (badges/buttons live-update).
    btn.addEventListener('click', () => setTimeout(() => openProfile(u.id), 300));
  });
  loadReviewsSection(u);
}

// ---- Public reviews (genuine/fake/suspicious ratings left by past chat partners) ----
const REVIEW_TAG_LABELS = { genuine: 'Genuine', fake: 'Fake', suspicious: 'Suspicious' };

function starsHtml(rating) {
  let out = '';
  for (let i = 1; i <= 5; i++) out += `<span class="review-star ${i <= rating ? 'on' : ''}">&#9733;</span>`;
  return out;
}

async function loadReviewsSection(u) {
  const isSelf = u.friendStatus === 'self';
  const section = document.getElementById('profileReviewsSection');
  if (!section) return;
  try {
    const res = await fetch(`/api/users/${u.id}/reviews`, { headers: authHeaders() });
    const data = await res.json();
    if (!document.getElementById('profileReviewsSection')) return; // navigated away while loading
    const { reviews, summary, myReview } = data;
    const summaryHtml = summary.count
      ? `<div class="reviews-summary"><span class="reviews-avg">${summary.average.toFixed(1)}</span>${starsHtml(Math.round(summary.average))}<span class="reviews-count">${summary.count} review${summary.count === 1 ? '' : 's'}</span></div>
         <div class="reviews-tag-breakdown">${Object.entries(summary.tagCounts).filter(([, n]) => n > 0).map(([tag, n]) => `<span class="review-tag-chip ${tag}">${REVIEW_TAG_LABELS[tag]} · ${n}</span>`).join('')}</div>`
      : `<div class="history-empty" style="padding:8px 0;">No reviews yet.</div>`;
    const listHtml = reviews.map(r => `
      <div class="review-item" data-review-id="${r.id}">
        <div class="review-item-head">
          <span class="review-item-author">${escapeHtml(r.reviewer.displayName)}</span>
          <span class="review-tag-chip ${r.tag}">${REVIEW_TAG_LABELS[r.tag] || r.tag}</span>
        </div>
        <div class="review-item-stars">${starsHtml(r.rating)}</div>
        ${r.comment ? `<div class="review-item-comment">${escapeHtml(r.comment)}</div>` : ''}
        <button class="review-report-btn" data-report-review="${r.id}">Report</button>
      </div>`).join('');
    const formHtml = (!isSelf && u.canReview) ? `
      <div class="review-form">
        <div class="profile-field-label">${myReview ? 'Update your review' : 'Leave a review'}</div>
        <div class="review-star-picker" id="reviewStarPicker">${[1, 2, 3, 4, 5].map(n => `<span class="review-star ${myReview && n <= myReview.rating ? 'on' : ''}" data-star="${n}">&#9733;</span>`).join('')}</div>
        <select id="reviewTagSelect">
          ${REVIEW_TAGS_CLIENT.map(t => `<option value="${t}" ${myReview && myReview.tag === t ? 'selected' : ''}>${REVIEW_TAG_LABELS[t]}</option>`).join('')}
        </select>
        <textarea id="reviewCommentInput" maxlength="500" rows="2" placeholder="Optional comment...">${myReview ? escapeHtml(myReview.comment || '') : ''}</textarea>
        <div class="profile-edit-status" id="reviewFormStatus"></div>
        <button class="profile-edit-save" id="reviewSubmitBtn" type="button">${myReview ? 'Update review' : 'Submit review'}</button>
      </div>` : (!isSelf ? `<div class="history-empty" style="padding:8px 0;">You can review this person once you've chatted with them.</div>` : '');
    section.innerHTML = `
      <div class="profile-bio-label">Reviews</div>
      ${summaryHtml}
      ${listHtml}
      ${formHtml}
    `;
    section.querySelectorAll('[data-report-review]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Reporting...';
        try {
          await fetch(`/api/reviews/${btn.dataset.reportReview}/report`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'reported from profile' })
          });
          btn.textContent = 'Reported';
        } catch {
          btn.disabled = false;
          btn.textContent = 'Report';
        }
      });
    });
    const starPicker = document.getElementById('reviewStarPicker');
    let pickedRating = myReview ? myReview.rating : 0;
    if (starPicker) {
      starPicker.querySelectorAll('.review-star').forEach(star => {
        star.addEventListener('click', () => {
          pickedRating = Number(star.dataset.star);
          starPicker.querySelectorAll('.review-star').forEach(s => s.classList.toggle('on', Number(s.dataset.star) <= pickedRating));
        });
      });
    }
    const submitBtn = document.getElementById('reviewSubmitBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const statusEl = document.getElementById('reviewFormStatus');
        if (!pickedRating) { statusEl.textContent = 'Pick a star rating.'; statusEl.classList.add('err'); return; }
        submitBtn.disabled = true;
        statusEl.classList.remove('err');
        statusEl.textContent = 'Saving...';
        try {
          const res2 = await fetch(`/api/users/${u.id}/reviews`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: pickedRating, tag: document.getElementById('reviewTagSelect').value, comment: document.getElementById('reviewCommentInput').value })
          });
          const d2 = await res2.json();
          if (!res2.ok) throw new Error(d2.error || 'Could not save review.');
          loadReviewsSection(u);
        } catch (err) {
          statusEl.textContent = err.message || 'Could not save review.';
          statusEl.classList.add('err');
          submitBtn.disabled = false;
        }
      });
    }
  } catch {
    section.innerHTML = '<div class="history-empty">Could not load reviews.</div>';
  }
}
const REVIEW_TAGS_CLIENT = ['genuine', 'fake', 'suspicious'];

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---- Edit profile (name, bio, photo) — own profile only ----
function renderEditProfile(u) {
  document.querySelector('.profile-page-header').classList.remove('on-cover');
  profileHeaderTitle.textContent = 'Edit Profile';
  profileEditBtn.style.display = 'none';
  profileBody.innerHTML = `
    <div class="profile-edit-form" style="padding: 24px 20px 0;">
      <div class="profile-edit-avatar-row">
        <div id="editAvatarPreview">${avatarLgHtml(u)}</div>
        <label for="editPhotoInput">Change photo</label>
        <input type="file" id="editPhotoInput" accept="image/*" style="display:none;">
      </div>
      <div>
        <div class="profile-field-label">Name</div>
        <input type="text" id="editNameInput" maxlength="50" placeholder="Your name" value="${(u.displayName || '').replace(/"/g, '&quot;')}">
      </div>
      <div>
        <div class="profile-field-label">Bio</div>
        <textarea id="editBioInput" maxlength="280" rows="4" placeholder="Tell people a bit about yourself...">${u.bio || ''}</textarea>
        <div class="profile-char-count"><span id="bioCharCount">${(u.bio || '').length}</span>/280</div>
      </div>
      <div>
        <div class="profile-field-label">YouTube channel link <span style="font-weight:400;color:var(--muted);">(optional, encouraged)</span></div>
        <input type="url" id="editYoutubeInput" placeholder="https://youtube.com/@yourchannel" value="${(u.youtubeLink || '').replace(/"/g, '&quot;')}">
        <div class="profile-char-count" style="text-align:left;">Helps other people trust you're a real person, not a fraud account.</div>
      </div>
      <div class="profile-edit-status" id="editStatus"></div>
      <div class="profile-edit-actions">
        <button class="profile-edit-cancel" id="editCancelBtn" type="button">Cancel</button>
        <button class="profile-edit-save" id="editSaveBtn" type="button">Save</button>
      </div>
    </div>
  `;
  let pendingPhoto = null; // data URL, set once the picked image finishes compressing
  const bioInput = document.getElementById('editBioInput');
  bioInput.addEventListener('input', () => {
    document.getElementById('bioCharCount').textContent = String(bioInput.value.length);
  });
  document.getElementById('editPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('editStatus');
    try {
      pendingPhoto = await compressImageToDataUrl(file, 400);
      document.getElementById('editAvatarPreview').innerHTML = `<div class="profile-avatar-lg"><img src="${pendingPhoto}" alt=""></div>`;
    } catch (err) {
      statusEl.textContent = "Couldn't read that image.";
      statusEl.classList.add('err');
    }
  });
  document.getElementById('editCancelBtn').addEventListener('click', () => renderProfile(u));
  document.getElementById('editSaveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('editSaveBtn');
    const statusEl = document.getElementById('editStatus');
    saveBtn.disabled = true;
    statusEl.classList.remove('err');
    statusEl.textContent = 'Saving...';
    try {
      const body = { displayName: document.getElementById('editNameInput').value.trim(), bio: bioInput.value.trim(), youtubeLink: document.getElementById('editYoutubeInput').value.trim() };
      if (pendingPhoto) body.photo = pendingPhoto;
      const res = await fetch('/api/profile', {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save profile.');
      currentUser = data.user;
      currentProfileUser = { ...data.user, friendStatus: 'self', online: true };
      renderAvatarBtn();
      renderProfile(currentProfileUser);
    } catch (err) {
      statusEl.textContent = err.message || 'Could not save profile.';
      statusEl.classList.add('err');
      saveBtn.disabled = false;
    }
  });
}

// Resizes/compresses a picked image client-side (down to maxDim px on the
// long edge, JPEG) before it ever reaches the server — keeps profile
// photos small in the database without needing object storage.
function compressImageToDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Mutual friends can call each other directly — straight into video, no
// message required first, same as tapping "video call" on a contact in
// Instagram/Facebook/Snapchat.
async function callFriend(userId, name) {
  closeProfile();
  closeHistory();

  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  socket.emit('skip');

  await requestMediaPermission(); // best-effort; degrades gracefully if denied

  chatMode = 'video';
  resetVideoUnlock();
  document.getElementById('gate').style.display = 'none';
  document.getElementById('chatScreen').classList.add('active');
  document.getElementById('topbarControls').classList.add('active');
  topbarStatusEl.style.display = 'flex';
  applyModeUI();
  hideSearching();
  hideResumeBanner();

  messagesEl.innerHTML = '';
  messagesEl.classList.remove('text-hidden');
  activeConversationId = null;
  partnerLabel.textContent = name;
  setChatEnabled(false);
  setStatus('Calling...', false);

  socket.emit('call-friend', { friendUserId: userId });
}

socket.on('call-failed', ({ reason }) => {
  const messages = {
    'not-friends': "You can only video call mutual friends.",
    offline: "They're offline right now.",
    busy: "They're in another chat right now.",
    'not-authenticated': 'Please sign in again.'
  };
  setStatus('Call failed', false);
  addMessage(messages[reason] || "Couldn't start the call.", 'system');
});

async function resumeConversation(item) {
  // If this is the conversation already live on screen right now, just
  // bring the history panel away and leave it exactly as it is — whatever
  // mode (text or video) it's currently in keeps running, uninterrupted.
  const alreadyLive = activeConversationId === item.conversationId
    && document.getElementById('chatScreen').classList.contains('active');
  if (alreadyLive) {
    closeHistory();
    return;
  }

  closeHistory();

  // Leave whatever's happening now (random matching, an active chat, etc.)
  // before switching into the restored conversation. Any other saved
  // conversation always reopens in text mode — video calls aren't persisted.
  cleanupPeerConnection();
  endVoiceCallIfActive(true);
  socket.emit('skip');

  await requestMediaPermission(); // best-effort; degrades gracefully if denied

  chatMode = 'text';
  resetVideoUnlock();
  setSearchUiState('connected'); // resuming a specific saved chat — Start/Stop don't apply here
  document.getElementById('gate').style.display = 'none';
  document.getElementById('chatScreen').classList.add('active');
  document.getElementById('topbarControls').classList.add('active');
  topbarStatusEl.style.display = 'flex';
  applyModeUI();
  hideSearching();
  hideResumeBanner();

  messagesEl.innerHTML = '';
  messagesEl.classList.remove('text-hidden');
  currentDisappearingMode = 'none';
  try {
    const res = await fetch(`/api/history/${item.conversationId}/messages`, { headers: authHeaders() });
    const data = await res.json();
    currentDisappearingMode = data.disappearingMode || 'none';
    (data.messages || []).forEach(m => {
      if (m.deleted) {
        addMessage('This message was deleted', m.mine ? 'self' : 'partner', { id: m.id, deleted: true });
      } else if (m.type === 'voice') {
        addVoiceMessage(m.audio, m.mine, { id: m.id });
      } else {
        addMessage(m.text, m.mine ? 'self' : 'partner', { id: m.id, replyTo: m.replyTo });
      }
    });
  } catch (e) {
    addMessage('Could not load earlier messages.', 'system');
  }

  activeConversationId = item.conversationId;
  currentPartnerId = item.partner.id;
  currentPartnerMuted = false; // corrected below once we know for sure
  updateDisappearingBtnVisibility();
  updateMoreBtnVisibility();
  fetch(`/api/users/${item.partner.id}`, { headers: authHeaders() })
    .then(r => r.json())
    .then(d => { if (currentPartnerId === item.partner.id) currentPartnerMuted = !!(d.user && d.user.isMuted); })
    .catch(() => {});
  partnerLabel.textContent = item.partner.username;
  setChatEnabled(false);
  maybeMarkSeen();

  if (item.online) {
    setStatus('Reconnecting...', false);
    socket.emit('resume-chat', { conversationId: item.conversationId });
  } else {
    setStatus('Partner offline', false);
    showResumeBanner(`${item.partner.username} is offline right now — you're viewing your saved conversation.`);
  }
}

socket.on('resume-failed', ({ reason }) => {
  setChatEnabled(false);
  setStatus('Not connected', false);
  if (reason === 'offline') showResumeBanner('Your partner just went offline.');
  else if (reason === 'busy') showResumeBanner('Your partner is currently in another chat.');
  else showResumeBanner('This conversation is no longer available.');
});
