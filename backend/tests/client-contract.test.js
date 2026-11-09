'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const storage = new Map();
const calls = [];
let nextResponse = { ok: true, data: { status: 'ready' } };
const sandbox = {
  window: {
    TAGIHANKU_CONFIG: {
      // Also verifies that a copied deployment ID is normalized to the canonical URL.
      apiUrl: 'AKfycbzj29oXacNqT-cnQnThFfF9uij_A5LpLWxMTK_7qDw9iBySyM9HpDQy4-hCL4KitrAR/exec'
    }
  },
  navigator: { onLine: true },
  sessionStorage: {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  fetch: async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => nextResponse
    };
  },
  Promise,
  Object,
  String,
  Boolean,
  Error,
  RegExp
};
vm.createContext(sandbox);
const source = fs.readFileSync(require('node:path').join(__dirname, '..', '..', 'backend-client.js'), 'utf8');
vm.runInContext(source, sandbox, { filename: 'backend-client.js' });

(async () => {
  const api = sandbox.window.TagihanKuBackend;
  assert.equal(api.isConfigured(), true, 'deployment ID should normalize');

  const user = { id: 'usr_test_1', name: 'Pengguna Uji', email: 'uji@example.com' };
  const dashboard = { user, bills: [], transactions: [], notifications: [], preferences: {} };
  nextResponse = { ok: true, data: { token: 'session-token-example-long-enough-for-test', user, dashboard } };
  const auth = await api.register({ name: user.name, email: user.email, password: 'StrongPassword123' });
  assert.equal(auth.user.email, user.email);
  assert.equal(api.isAuthenticated(), true, 'register should store session token');

  nextResponse = { ok: true, data: dashboard };
  const restored = await api.restore();
  assert.equal(restored.user.id, user.id, 'restore should return dashboard');

  nextResponse = { ok: true, data: { loggedOut: true } };
  await api.logout();
  assert.equal(api.isAuthenticated(), false, 'logout should clear session token');

  const request = calls[0];
  assert.match(request.url, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'follow');
  assert.equal(request.options.credentials, 'omit');
  assert.match(request.options.headers['Content-Type'], /^text\/plain/);

  console.log('Backend client contract: PASS (URL normalization, register, token, restore, logout, text/plain transport)');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
