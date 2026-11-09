/* TagihanKu API client — Google Apps Script Web App. */
(function () {
  'use strict';

  const CONFIG = window.TAGIHANKU_CONFIG || {};
  const SESSION_KEY = 'tagihanku:auth:session';
  const RAW_API_URL = String(CONFIG.apiUrl || '').trim();

  function normalizeApiUrl(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    // Accept either the full Web App URL or the deployment ID copied from Google.
    if (/^AK[a-zA-Z0-9_-]+\/exec$/.test(input)) return 'https://script.google.com/macros/s/' + input;
    if (/^AK[a-zA-Z0-9_-]+$/.test(input)) return 'https://script.google.com/macros/s/' + input + '/exec';
    return input;
  }

  const API_URL = normalizeApiUrl(RAW_API_URL);
  const SESSION_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/AK[a-zA-Z0-9_-]+\/exec$/;

  function isConfigured() {
    return SESSION_PATTERN.test(API_URL);
  }

  function getToken() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; }
    catch (error) { return ''; }
  }

  function storeToken(token) {
    try {
      if (token) sessionStorage.setItem(SESSION_KEY, token);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (error) {
      throw new Error('Browser tidak dapat menyimpan sesi. Aktifkan penyimpanan situs lalu coba kembali.');
    }
  }

  async function request(action, payload = {}, tokenOverride) {
    if (!isConfigured()) throw new Error('Layanan akun belum dikonfigurasi dengan benar.');
    if (!navigator.onLine) throw new Error('Koneksi internet diperlukan untuk mengakses akun.');

    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          action: action,
          payload: payload,
          token: tokenOverride === undefined ? getToken() : tokenOverride
        })
      });
    } catch (error) {
      throw new Error('Layanan akun belum dapat dihubungi. Periksa koneksi internet atau coba kembali beberapa saat lagi.');
    }

    if (!response.ok) throw new Error('Layanan akun sedang mengalami kendala. Coba kembali beberapa saat lagi.');
    let result;
    try { result = await response.json(); }
    catch (error) { throw new Error('Respons layanan tidak dapat dibaca. Pastikan deployment Web App masih aktif.'); }
    if (!result || result.ok !== true) {
      const serverError = result && result.error ? result.error : {};
      const error = new Error(serverError.message || 'Permintaan tidak dapat diproses.');
      error.code = serverError.code || 'API_ERROR';
      throw error;
    }
    return result.data;
  }

  async function authenticate(action, payload) {
    const result = await request(action, payload, '');
    if (!result || !result.token || !result.user || !result.dashboard) {
      throw new Error('Layanan akun mengirimkan respons yang tidak lengkap.');
    }
    storeToken(result.token);
    return result;
  }

  async function register(payload) { return authenticate('register', payload); }
  async function login(payload) { return authenticate('login', payload); }

  async function logout() {
    const token = getToken();
    try {
      if (token && isConfigured() && navigator.onLine) await request('logout', {}, token);
    } finally {
      storeToken('');
    }
    return { loggedOut: true };
  }

  async function restore() {
    const token = getToken();
    if (!isConfigured() || !token) return null;
    try { return await request('getDashboard', {}, token); }
    catch (error) {
      if (error.code === 'UNAUTHORIZED' || error.code === 'USER_NOT_FOUND') storeToken('');
      throw error;
    }
  }

  async function health() { return request('health', {}, ''); }
  async function getDashboard() { return request('getDashboard'); }
  async function saveProfile(profile) { return request('saveProfile', profile); }
  async function savePreferences(preferences) { return request('savePreferences', { preferences: preferences }); }
  async function payBills(billIds, method) { return request('payBills', { billIds: billIds, method: method }); }
  async function pushNotification(notification) { return request('pushNotification', notification); }
  async function markNotificationRead(id) { return request('markNotificationRead', { id: id }); }
  async function deleteNotification(id) { return request('deleteNotification', { id: id }); }
  async function clearNotifications() { return request('clearNotifications'); }

  window.TagihanKuBackend = Object.freeze({
    isConfigured: isConfigured,
    isAuthenticated: function () { return Boolean(getToken()); },
    register: register,
    login: login,
    logout: logout,
    restore: restore,
    health: health,
    getDashboard: getDashboard,
    saveProfile: saveProfile,
    savePreferences: savePreferences,
    payBills: payBills,
    pushNotification: pushNotification,
    markNotificationRead: markNotificationRead,
    deleteNotification: deleteNotification,
    clearNotifications: clearNotifications
  });
})();
