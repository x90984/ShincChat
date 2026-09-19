// OAuth2 authorization-code-with-PKCE login for Google — the site's only
// sign-in method, kept deliberately simple (one provider, one button).
//
// SETUP REQUIRED: register a real app in Google Cloud Console, which gives
// you a client ID and secret. Put them in a .env file or your host's
// environment variables:
//
//   GOOGLE_CLIENT_ID=...
//   GOOGLE_CLIENT_SECRET=...
//   OAUTH_BASE_URL=https://your-deployed-domain.com   (no trailing slash)
//
// The redirect/callback URL to register with Google is:
//   {OAUTH_BASE_URL}/auth/google/callback
//
// Without GOOGLE_CLIENT_ID set, /api/oauth-providers simply returns an
// empty list and the button disables itself client-side — nothing crashes.

const crypto = require('crypto');

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    mapProfile: (p) => ({ oauthId: p.sub, username: p.email ? p.email.split('@')[0] : p.name }),
  },
};

function configuredProviders() {
  return Object.keys(PROVIDERS).filter(k => PROVIDERS[k].clientId);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE/state store. Short-lived (a login round-trip). When the app's shared
// Redis state layer is available (`oauthState` passed to mount), it lives
// there so a login started on one server instance can finish on another;
// otherwise a local Map is used (single-instance deployments).
const pending = new Map(); // state -> { provider, verifier, expires }
setInterval(() => {
  const now = Date.now();
  for (const [state, v] of pending) if (v.expires < now) pending.delete(state);
}, 60_000).unref();

function mount(app, db, { createSession, oauthState = null }) {
  const baseUrl = process.env.OAUTH_BASE_URL || '';
  const stateStore = oauthState || {
    set: async (key, data) => pending.set(key, { ...data, expires: Date.now() + 5 * 60_000 }),
    take: async (key) => { const v = pending.get(key); pending.delete(key); return v || null; },
  };

  app.get('/api/oauth-providers', (req, res) => {
    res.json({ providers: configuredProviders(), baseUrlConfigured: !!baseUrl });
  });

  app.get('/auth/:provider', async (req, res) => {
    const provider = PROVIDERS[req.params.provider];
    if (!provider || !provider.clientId) {
      return res.status(404).send(
        `${req.params.provider} login isn't configured yet — the site owner needs to add API credentials for it. See server/oauth.js for setup instructions.`
      );
    }
    if (!baseUrl) {
      return res.status(500).send('OAUTH_BASE_URL is not set on the server — required so the provider knows where to redirect back to.');
    }

    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));
    await stateStore.set(state, { provider: req.params.provider, verifier, expires: Date.now() + 5 * 60_000 }, 300);

    const redirectUri = `${baseUrl}/auth/${req.params.provider}/callback`;
    const url = new URL(provider.authUrl);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    res.redirect(url.toString());
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const providerName = req.params.provider;
    const provider = PROVIDERS[providerName];
    const { code, state, error } = req.query;
    const entry = state ? await stateStore.take(state) : null;
    if (error) return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
    if (!provider || !entry || entry.provider !== providerName) {
      return res.redirect('/?auth_error=invalid_state');
    }

    try {
      const redirectUri = `${baseUrl}/auth/${providerName}/callback`;
      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri,
          client_id: provider.clientId,
          ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}),
          code_verifier: entry.verifier,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        console.error(`${providerName} token exchange failed:`, tokenData);
        return res.redirect('/?auth_error=token_exchange_failed');
      }

      const profileRes = await fetch(provider.userInfoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = await profileRes.json();
      const { oauthId, username } = provider.mapProfile(profile);
      if (!oauthId) return res.redirect('/?auth_error=no_profile_id');

      const user = await db.findOrCreateOAuthUser({ provider: providerName, providerId: String(oauthId), displayName: username });
      if (user.is_banned) return res.redirect('/?auth_error=banned');

      const token = await createSession(user.id);
      // Hand the token to the page via a short-lived hash fragment (never
      // sent to the server in a Referer/log line) — app.js picks it up on load.
      res.redirect(`/#auth_token=${token}`);
    } catch (err) {
      console.error(`${providerName} OAuth error:`, err);
      res.redirect('/?auth_error=server_error');
    }
  });
}

module.exports = { mount, configuredProviders };
