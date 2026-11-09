/**
 * TAGIHANKU — Google Apps Script + Google Sheets backend
 *
 * Install as a script BOUND to a Google Spreadsheet. Run setupTagihanKu() once,
 * then deploy as a Web App that executes as the owner and is accessible to anyone.
 *
 * Security notes:
 * - Passwords are stored as PBKDF2-HMAC-SHA256 hashes with per-user salt + server pepper.
 * - Session tokens are random bearer tokens; only their SHA-256 hashes are stored.
 * - All reads/writes are scoped by the authenticated user ID.
 * - Payments are SIMULATED only. No bank, QRIS, e-wallet, utility provider, or gateway is connected.
 * - Apps Script + Sheets is suitable for a small academic prototype, not a high-volume financial system.
 */
'use strict';

const TK_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Jakarta',
  SESSION_DAYS: 7,
  PASSWORD_ITERATIONS: 12000,
  MIN_PASSWORD_LENGTH: 10,
  MAX_REQUEST_LENGTH: 30000,
  MAX_TRANSACTIONS: 500,
  MAX_NOTIFICATIONS: 100,
  LOGIN_MAX_FAILURES: 5,
  LOGIN_LOCK_MINUTES: 15,
  SERVICES: [
    { id: 'internet', name: 'Internet Fiber', description: 'Paket keluarga · 50 Mbps', amount: 385000, dueOffsetDays: 6 },
    { id: 'electricity', name: 'Listrik Pascabayar', description: 'Pelanggan listrik rumah', amount: 215000, dueOffsetDays: 11 },
    { id: 'water', name: 'Air PDAM', description: 'Tagihan air bersih', amount: 50000, dueOffsetDays: 18 }
  ],
  SHEETS: {
    Users: ['userId', 'email', 'name', 'passwordHash', 'passwordSalt', 'createdAt', 'status', 'preferencesJson'],
    Sessions: ['tokenHash', 'userId', 'createdAt', 'expiresAt', 'revokedAt', 'lastSeenAt'],
    Bills: ['billId', 'userId', 'service', 'name', 'description', 'amount', 'dueDate', 'status', 'paidAt', 'createdAt', 'updatedAt'],
    Transactions: ['transactionId', 'userId', 'billIdsJson', 'itemsJson', 'total', 'method', 'status', 'createdAt'],
    Notifications: ['notificationId', 'userId', 'billId', 'type', 'title', 'message', 'createdAt', 'readAt', 'uniqueKey'],
    LoginAttempts: ['emailKey', 'failedCount', 'lockedUntil', 'updatedAt'],
    AuditLogs: ['logId', 'userId', 'action', 'entityId', 'createdAt', 'metadataJson']
  }
});

const TK_PROPERTY_KEYS = Object.freeze({
  spreadsheetId: 'TAGIHANKU_SPREADSHEET_ID',
  passwordPepper: 'TAGIHANKU_PASSWORD_PEPPER',
  tokenPepper: 'TAGIHANKU_TOKEN_PEPPER',
  setupVersion: 'TAGIHANKU_SETUP_VERSION'
});

/** Run once from the bound spreadsheet's Apps Script editor. */
function setupTagihanKu() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Buka Apps Script dari Google Sheet melalui Extensions > Apps Script.');

  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(TK_PROPERTY_KEYS.spreadsheetId, spreadsheet.getId());
  if (!properties.getProperty(TK_PROPERTY_KEYS.passwordPepper)) {
    properties.setProperty(TK_PROPERTY_KEYS.passwordPepper, Utilities.getUuid() + Utilities.getUuid());
  }
  if (!properties.getProperty(TK_PROPERTY_KEYS.tokenPepper)) {
    properties.setProperty(TK_PROPERTY_KEYS.tokenPepper, Utilities.getUuid() + Utilities.getUuid());
  }

  Object.keys(TK_CONFIG.SHEETS).forEach(function (sheetName) {
    const headers = TK_CONFIG.SHEETS[sheetName];
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
      headers.forEach(function (header, index) {
        if (existing[index] !== header) {
          throw new Error('Header sheet ' + sheetName + ' tidak cocok. Jangan ubah nama/urutan kolom. Jalankan setup pada spreadsheet kosong.');
        }
      });
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#211b42').setFontColor('#ffffff').setFontWeight('bold');
    sheet.autoResizeColumns(1, headers.length);
  });

  properties.setProperty(TK_PROPERTY_KEYS.setupVersion, '1');
  return 'TagihanKu backend siap. Spreadsheet: ' + spreadsheet.getName();
}

/** Optional administrator controls. Run manually from the Apps Script editor. */
function closePublicRegistration() {
  PropertiesService.getScriptProperties().setProperty('TAGIHANKU_REGISTRATION_OPEN', 'false');
  return 'Pendaftaran publik ditutup.';
}
function openPublicRegistration() {
  PropertiesService.getScriptProperties().deleteProperty('TAGIHANKU_REGISTRATION_OPEN');
  return 'Pendaftaran publik dibuka.';
}

/** Public health endpoint. Does not expose spreadsheet IDs, secrets, or user data. */
function doGet() {
  const configured = Boolean(PropertiesService.getScriptProperties().getProperty(TK_PROPERTY_KEYS.spreadsheetId));
  return jsonOutput_({ ok: true, service: 'TagihanKu API', status: configured ? 'ready' : 'not_configured', timestamp: new Date().toISOString() });
}

/** All API calls use POST text/plain JSON to avoid CORS preflight. */
function doPost(event) {
  try {
    if (!event || !event.postData || !event.postData.contents) {
      return jsonOutput_({ ok: false, error: { code: 'EMPTY_REQUEST', message: 'Permintaan kosong.' } });
    }
    const raw = String(event.postData.contents);
    if (raw.length > TK_CONFIG.MAX_REQUEST_LENGTH) {
      return jsonOutput_({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Permintaan terlalu besar.' } });
    }
    const request = JSON.parse(raw);
    const action = String(request.action || '').trim();
    const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
    const token = typeof request.token === 'string' ? request.token : '';
    const result = dispatch_(action, payload, token);
    return jsonOutput_({ ok: true, data: result });
  } catch (error) {
    const safe = toPublicError_(error);
    console.error('TagihanKu API error: ' + (error && error.stack ? error.stack : error));
    return jsonOutput_({ ok: false, error: safe });
  }
}

function dispatch_(action, payload, token) {
  assertSetup_();
  switch (action) {
    case 'health':
      return { service: 'TagihanKu API', status: 'ready', timestamp: new Date().toISOString() };
    case 'register':
      return registerUser_(payload);
    case 'login':
      return loginUser_(payload);
    case 'logout':
      return logoutUser_(token);
    case 'getDashboard':
      return getDashboard_(requireSession_(token));
    case 'saveProfile':
      return saveProfile_(requireSession_(token), payload);
    case 'savePreferences':
      return savePreferences_(requireSession_(token), payload);
    case 'payBills':
      return payBills_(requireSession_(token), payload);
    case 'pushNotification':
      return pushNotification_(requireSession_(token), payload);
    case 'markNotificationRead':
      return markNotificationRead_(requireSession_(token), payload);
    case 'deleteNotification':
      return deleteNotification_(requireSession_(token), payload);
    case 'clearNotifications':
      return clearNotifications_(requireSession_(token));
    default:
      throw apiError_('UNKNOWN_ACTION', 'Aksi API tidak dikenal.');
  }
}

function registerUser_(payload) {
  if (PropertiesService.getScriptProperties().getProperty('TAGIHANKU_REGISTRATION_OPEN') === 'false') {
    throw apiError_('REGISTRATION_CLOSED', 'Pendaftaran akun sedang ditutup oleh administrator.');
  }
  const email = normalizeEmail_(payload.email);
  const name = normalizeName_(payload.name);
  const password = validatePassword_(payload.password);
  return withScriptLock_(function () {
    const existing = findRecord_('Users', 'email', email);
    if (existing) throw apiError_('EMAIL_EXISTS', 'Email sudah terdaftar. Silakan masuk.');
    const userId = 'usr_' + Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    const salt = Utilities.getUuid() + Utilities.getUuid();
    const passwordHash = hashPassword_(password, salt);
    const createdAt = new Date().toISOString();
    appendRecord_('Users', {
      userId: userId, email: email, name: name, passwordHash: passwordHash,
      passwordSalt: salt, createdAt: createdAt, status: 'active', preferencesJson: '{}'
    });
    createDefaultBills_(userId);
    const session = createSession_(userId);
    audit_(userId, 'REGISTER', userId, { email: email });
    const user = { id: userId, email: email, name: name };
    return { token: session.token, user: user, dashboard: buildDashboard_(userId) };
  });
}

function loginUser_(payload) {
  const email = normalizeEmail_(payload.email);
  const password = String(payload.password || '');
  if (password.length < 1 || password.length > 128) throw apiError_('INVALID_CREDENTIALS', 'Email atau kata sandi tidak sesuai.');

  return withScriptLock_(function () {
    const emailKey = digestText_(email + getSecret_(TK_PROPERTY_KEYS.tokenPepper));
    const attempt = findRecord_('LoginAttempts', 'emailKey', emailKey);
    const now = new Date();
    if (attempt && attempt.record.lockedUntil && new Date(attempt.record.lockedUntil).getTime() > now.getTime()) {
      throw apiError_('LOGIN_LOCKED', 'Terlalu banyak percobaan. Coba lagi setelah 15 menit.');
    }

    const userRecord = findRecord_('Users', 'email', email);
    const activeUser = userRecord && userRecord.record.status === 'active' ? userRecord.record : null;
    const valid = activeUser ? constantTimeEquals_(hashPassword_(password, activeUser.passwordSalt), activeUser.passwordHash) : false;
    if (!valid) {
      recordLoginFailure_(emailKey, attempt);
      throw apiError_('INVALID_CREDENTIALS', 'Email atau kata sandi tidak sesuai.');
    }

    resetLoginFailure_(emailKey, attempt);
    const session = createSession_(activeUser.userId);
    audit_(activeUser.userId, 'LOGIN', activeUser.userId, {});
    const user = { id: activeUser.userId, email: activeUser.email, name: activeUser.name };
    return { token: session.token, user: user, dashboard: buildDashboard_(activeUser.userId) };
  });
}

function logoutUser_(token) {
  if (!token) return { loggedOut: true };
  return withScriptLock_(function () {
    const tokenHash = hashToken_(token);
    const session = findRecord_('Sessions', 'tokenHash', tokenHash);
    if (session && !session.record.revokedAt) {
      updateRecord_('Sessions', session.rowNumber, Object.assign({}, session.record, { revokedAt: new Date().toISOString() }));
      audit_(session.record.userId, 'LOGOUT', session.record.userId, {});
    }
    return { loggedOut: true };
  });
}

function saveProfile_(userId, payload) {
  const name = normalizeName_(payload.name);
  const email = normalizeEmail_(payload.email);
  return withScriptLock_(function () {
    const userRow = findRecord_('Users', 'userId', userId);
    if (!userRow) throw apiError_('USER_NOT_FOUND', 'Akun tidak ditemukan.');
    const duplicate = findRecord_('Users', 'email', email);
    if (duplicate && duplicate.record.userId !== userId) throw apiError_('EMAIL_EXISTS', 'Email sudah digunakan akun lain.');
    const updated = Object.assign({}, userRow.record, { name: name, email: email });
    updateRecord_('Users', userRow.rowNumber, updated);
    audit_(userId, 'PROFILE_UPDATE', userId, { email: email });
    return buildDashboard_(userId);
  });
}

function savePreferences_(userId, payload) {
  const source = payload.preferences && typeof payload.preferences === 'object' ? payload.preferences : {};
  const clean = {};
  if (['light', 'dark', 'system'].includes(source.theme)) clean.theme = source.theme;
  ['reduceMotion', 'compactMode', 'showHeroVisual', 'showAssistant', 'remindersEnabled', 'remindOverdue', 'browserNotifications']
    .forEach(function (key) { if (typeof source[key] === 'boolean') clean[key] = source[key]; });
  if ([1, 3, 7].indexOf(Number(source.reminderLeadDays)) >= 0) clean.reminderLeadDays = Number(source.reminderLeadDays);
  if (['08:00', '09:00', '12:00', '18:00'].indexOf(source.reminderTime) >= 0) clean.reminderTime = source.reminderTime;
  const json = JSON.stringify(clean);
  return withScriptLock_(function () {
    const record = findRecord_('Users', 'userId', userId);
    if (!record) throw apiError_('USER_NOT_FOUND', 'Akun tidak ditemukan.');
    updateRecord_('Users', record.rowNumber, Object.assign({}, record.record, { preferencesJson: json }));
    return { saved: true };
  });
}

function payBills_(userId, payload) {
  const billIds = Array.isArray(payload.billIds) ? payload.billIds.map(String).slice(0, 10) : [];
  const method = String(payload.method || 'QRIS');
  if (!billIds.length || new Set(billIds).size !== billIds.length) throw apiError_('INVALID_BILLS', 'Pilih minimal satu tagihan yang valid.');
  if (!['QRIS', 'Transfer bank', 'E-wallet'].includes(method)) throw apiError_('INVALID_METHOD', 'Metode pembayaran tidak dikenal.');

  return withScriptLock_(function () {
    const rows = billIds.map(function (id) { return findRecord_('Bills', 'billId', id + '|' + userId); });
    if (rows.some(function (entry) { return !entry || entry.record.userId !== userId; })) throw apiError_('BILL_NOT_FOUND', 'Satu atau lebih tagihan tidak ditemukan.');
    if (rows.some(function (entry) { return entry.record.status !== 'pending'; })) throw apiError_('BILL_NOT_PAYABLE', 'Ada tagihan yang sudah lunas atau tidak dapat dibayar. Muat ulang data.');

    const items = rows.map(function (entry) {
      // Frontend memakai ID layanan publik (internet/electricity/water),
      // bukan kunci internal billId yang mengandung userId.
      return { id: entry.record.service, name: entry.record.name, amount: Number(entry.record.amount) };
    });
    const total = items.reduce(function (sum, item) { return sum + item.amount; }, 0);
    if (!Number.isSafeInteger(total) || total < 1 || total > 150000000) throw apiError_('INVALID_TOTAL', 'Total pembayaran tidak valid.');
    const now = new Date();
    const datePart = Utilities.formatDate(now, TK_CONFIG.TIME_ZONE, 'yyyyMMdd');
    const prefix = 'TK-' + datePart + '-';
    const highestSequence = getRecords_('Transactions').filter(function (entry) {
      return entry.record.userId === userId && String(entry.record.transactionId).indexOf(prefix) === 0;
    }).reduce(function (highest, entry) {
      const value = Number(String(entry.record.transactionId).slice(prefix.length));
      return Number.isFinite(value) ? Math.max(highest, value) : highest;
    }, 0);
    const sequence = String(highestSequence + 1).padStart(4, '0');
    const transaction = {
      transactionId: prefix + sequence,
      userId: userId,
      billIdsJson: JSON.stringify(billIds),
      itemsJson: JSON.stringify(items),
      total: total,
      method: method,
      status: 'paid',
      createdAt: now.toISOString()
    };

    // Under the script lock, create the transaction and update only this user's selected bills.
    appendRecord_('Transactions', transaction);
    rows.forEach(function (entry) {
      updateRecord_('Bills', entry.rowNumber, Object.assign({}, entry.record, {
        status: 'paid', paidAt: now.toISOString(), updatedAt: now.toISOString()
      }));
    });
    audit_(userId, 'DEMO_PAYMENT', transaction.transactionId, { total: total, billIds: billIds });
    return {
      transaction: {
        id: transaction.transactionId, billIds: billIds, items: items, total: total,
        method: method, status: 'paid', createdAt: transaction.createdAt
      },
      dashboard: buildDashboard_(userId)
    };
  });
}

function pushNotification_(userId, payload) {
  return withScriptLock_(function () {
    const clientUniqueKey = String(payload.uniqueKey || '').slice(0, 140);
    if (!clientUniqueKey) throw apiError_('INVALID_NOTIFICATION', 'Kunci notifikasi tidak valid.');
    const uniqueKey = userId + ':' + clientUniqueKey;
    const existing = findRecord_('Notifications', 'uniqueKey', uniqueKey);
    if (existing && existing.record.userId === userId) return { notification: notificationDto_(existing.record), created: false };
    const title = String(payload.title || 'Notifikasi TagihanKu').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    const message = String(payload.message || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 260);
    if (/^[=+@-]/.test(title) || /^[=+@-]/.test(message)) {
      throw apiError_('INVALID_NOTIFICATION', 'Teks notifikasi tidak boleh diawali karakter formula spreadsheet.');
    }
    const type = ['due_soon', 'due_today', 'overdue', 'test', 'system'].includes(payload.type) ? payload.type : 'system';
    const requestedBillId = payload.billId ? String(payload.billId) : '';
    const billId = ['internet', 'electricity', 'water'].includes(requestedBillId) ? requestedBillId : '';
    const id = 'ntf_' + Utilities.getUuid().replace(/-/g, '');
    const record = {
      notificationId: id, userId: userId, billId: billId, type: type,
      title: title, message: message, createdAt: new Date().toISOString(), readAt: '', uniqueKey: uniqueKey
    };
    appendRecord_('Notifications', record);
    audit_(userId, 'NOTIFICATION_CREATE', id, { type: type });
    return { notification: notificationDto_(record), created: true };
  });
}

function markNotificationRead_(userId, payload) {
  return withScriptLock_(function () {
    const id = String(payload.id || '');
    const record = findRecord_('Notifications', 'notificationId', id);
    if (!record || record.record.userId !== userId) throw apiError_('NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
    updateRecord_('Notifications', record.rowNumber, Object.assign({}, record.record, { readAt: new Date().toISOString() }));
    return { updated: true };
  });
}

function deleteNotification_(userId, payload) {
  return withScriptLock_(function () {
    const id = String(payload.id || '');
    const record = findRecord_('Notifications', 'notificationId', id);
    if (!record || record.record.userId !== userId) throw apiError_('NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
    getSheet_('Notifications').deleteRow(record.rowNumber);
    return { deleted: true };
  });
}

function clearNotifications_(userId) {
  return withScriptLock_(function () {
    const sheet = getSheet_('Notifications');
    const records = getRecords_('Notifications');
    const rows = records.filter(function (entry) { return entry.record.userId === userId; })
      .map(function (entry) { return entry.rowNumber; }).sort(function (a, b) { return b - a; });
    rows.forEach(function (row) { sheet.deleteRow(row); });
    return { deleted: rows.length };
  });
}

function getDashboard_(userId) {
  return buildDashboard_(userId);
}

function buildDashboard_(userId) {
  const userRow = findRecord_('Users', 'userId', userId);
  if (!userRow) throw apiError_('USER_NOT_FOUND', 'Akun tidak ditemukan.');
  const user = userRow.record;
  const bills = getRecords_('Bills').filter(function (entry) { return entry.record.userId === userId; })
    .map(function (entry) {
      const row = entry.record;
      return {
        id: row.service,
        service: row.service,
        name: row.name,
        description: row.description,
        amount: Number(row.amount),
        // Sheets dapat mengembalikan sel tanggal sebagai Date penuh atau teks ISO.
        dueISO: String(row.dueDate || '').slice(0, 10),
        status: row.status,
        paidAt: row.paidAt || null
      };
    });
  const transactions = getRecords_('Transactions').filter(function (entry) { return entry.record.userId === userId; })
    .map(function (entry) {
      const row = entry.record;
      return {
        id: row.transactionId,
        billIds: safeJsonArray_(row.billIdsJson),
        items: safeJsonArray_(row.itemsJson),
        total: Number(row.total), method: row.method, status: row.status, createdAt: row.createdAt
      };
    }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
    .slice(0, TK_CONFIG.MAX_TRANSACTIONS);
  const notifications = getRecords_('Notifications').filter(function (entry) { return entry.record.userId === userId; })
    .map(function (entry) { return notificationDto_(entry.record); })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
    .slice(0, TK_CONFIG.MAX_NOTIFICATIONS);
  let preferences = {};
  try { preferences = JSON.parse(user.preferencesJson || '{}'); } catch (ignore) { preferences = {}; }
  return {
    user: { id: user.userId, email: user.email, name: user.name },
    bills: bills,
    transactions: transactions,
    notifications: notifications,
    preferences: preferences
  };
}

function notificationDto_(row) {
  return {
    id: row.notificationId, uniqueKey: row.uniqueKey, type: row.type,
    billId: row.billId || null, title: row.title, message: row.message,
    createdAt: row.createdAt, read: Boolean(row.readAt)
  };
}

function createDefaultBills_(userId) {
  const now = new Date();
  TK_CONFIG.SERVICES.forEach(function (service) {
    const dueDate = addDaysISO_(now, service.dueOffsetDays);
    appendRecord_('Bills', {
      billId: service.id + '|' + userId,
      userId: userId,
      service: service.id,
      name: service.name,
      description: service.description,
      amount: service.amount,
      dueDate: dueDate,
      status: 'pending',
      paidAt: '',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
  });
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const expires = new Date(now.getTime() + TK_CONFIG.SESSION_DAYS * 24 * 60 * 60 * 1000);
  appendRecord_('Sessions', {
    tokenHash: hashToken_(token), userId: userId, createdAt: now.toISOString(),
    expiresAt: expires.toISOString(), revokedAt: '', lastSeenAt: now.toISOString()
  });
  return { token: token, expiresAt: expires.toISOString() };
}

function requireSession_(token) {
  if (!token || token.length < 40 || token.length > 160) throw apiError_('UNAUTHORIZED', 'Silakan masuk kembali.');
  const session = findRecord_('Sessions', 'tokenHash', hashToken_(token));
  if (!session || session.record.revokedAt || new Date(session.record.expiresAt).getTime() <= Date.now()) {
    throw apiError_('UNAUTHORIZED', 'Sesi berakhir. Silakan masuk kembali.');
  }
  const user = findRecord_('Users', 'userId', session.record.userId);
  if (!user || user.record.status !== 'active') throw apiError_('UNAUTHORIZED', 'Akun tidak aktif.');
  updateRecord_('Sessions', session.rowNumber, Object.assign({}, session.record, { lastSeenAt: new Date().toISOString() }));
  return user.record.userId;
}

function hashPassword_(password, salt) {
  const pepper = getSecret_(TK_PROPERTY_KEYS.passwordPepper);
  const passwordBytes = Utilities.newBlob(String(password) + '\u0000' + pepper).getBytes();
  const saltBytes = Utilities.newBlob(String(salt)).getBytes();
  const block = saltBytes.concat([0, 0, 0, 1]);
  let u = Utilities.computeHmacSha256Signature(block, passwordBytes);
  let result = u.slice();
  for (let iteration = 1; iteration < TK_CONFIG.PASSWORD_ITERATIONS; iteration += 1) {
    u = Utilities.computeHmacSha256Signature(u, passwordBytes);
    for (let index = 0; index < result.length; index += 1) {
      const xor = (result[index] & 255) ^ (u[index] & 255);
      result[index] = xor > 127 ? xor - 256 : xor;
    }
  }
  return Utilities.base64Encode(result);
}

function hashToken_(token) {
  return digestText_(String(token) + getSecret_(TK_PROPERTY_KEYS.tokenPepper));
}

function digestText_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function constantTimeEquals_(left, right) {
  left = String(left || ''); right = String(right || '');
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

function recordLoginFailure_(emailKey, previous) {
  const failed = previous ? Number(previous.record.failedCount || 0) + 1 : 1;
  const lockedUntil = failed >= TK_CONFIG.LOGIN_MAX_FAILURES
    ? new Date(Date.now() + TK_CONFIG.LOGIN_LOCK_MINUTES * 60 * 1000).toISOString() : '';
  const row = { emailKey: emailKey, failedCount: failed, lockedUntil: lockedUntil, updatedAt: new Date().toISOString() };
  if (previous) updateRecord_('LoginAttempts', previous.rowNumber, row);
  else appendRecord_('LoginAttempts', row);
}

function resetLoginFailure_(emailKey, previous) {
  const clean = { emailKey: emailKey, failedCount: 0, lockedUntil: '', updatedAt: new Date().toISOString() };
  if (previous) updateRecord_('LoginAttempts', previous.rowNumber, clean);
  else appendRecord_('LoginAttempts', clean);
}

function audit_(userId, action, entityId, metadata) {
  appendRecord_('AuditLogs', {
    logId: 'log_' + Utilities.getUuid().replace(/-/g, ''),
    userId: userId || '', action: action, entityId: entityId || '',
    createdAt: new Date().toISOString(), metadataJson: JSON.stringify(metadata || {}).slice(0, 2000)
  });
}

function normalizeEmail_(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 6 || email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw apiError_('INVALID_EMAIL', 'Alamat email tidak valid.');
  }
  return email;
}

function normalizeName_(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 48 || /^[=+@-]/.test(name)) {
    throw apiError_('INVALID_NAME', 'Nama harus terdiri dari 2–48 karakter dan tidak boleh diawali karakter formula spreadsheet.');
  }
  return name;
}

function validatePassword_(value) {
  const password = String(value || '');
  if (password.length < TK_CONFIG.MIN_PASSWORD_LENGTH || password.length > 128 ||
      !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw apiError_('WEAK_PASSWORD', 'Kata sandi minimal 10 karakter dan harus memuat huruf kecil, huruf besar, serta angka.');
  }
  return password;
}

function addDaysISO_(date, days) {
  const today = Utilities.formatDate(date, TK_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const parts = today.split('-').map(Number);
  const target = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return Utilities.formatDate(target, 'GMT', 'yyyy-MM-dd');
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return callback(); } finally { lock.releaseLock(); }
}

function assertSetup_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(TK_PROPERTY_KEYS.spreadsheetId) || !props.getProperty(TK_PROPERTY_KEYS.passwordPepper) || !props.getProperty(TK_PROPERTY_KEYS.tokenPepper)) {
    throw apiError_('NOT_CONFIGURED', 'Backend belum disiapkan. Jalankan setupTagihanKu() pada Apps Script.');
  }
}

function getSecret_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw apiError_('NOT_CONFIGURED', 'Konfigurasi keamanan backend belum lengkap.');
  return value;
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(TK_PROPERTY_KEYS.spreadsheetId);
  if (!id) throw apiError_('NOT_CONFIGURED', 'Spreadsheet backend belum dikonfigurasi.');
  return SpreadsheetApp.openById(id);
}

function getSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw apiError_('SHEET_MISSING', 'Sheet ' + sheetName + ' tidak ditemukan. Jalankan setupTagihanKu().');
  return sheet;
}

function getRecords_(sheetName) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map(function (row, index) {
    const record = {};
    headers.forEach(function (header, column) {
      const value = row[column];
      record[header] = value instanceof Date ? value.toISOString() : value;
    });
    return { record: record, rowNumber: index + 2 };
  }).filter(function (entry) { return Object.values(entry.record).some(function (value) { return value !== ''; }); });
}

function findRecord_(sheetName, key, value) {
  const target = String(value);
  const records = getRecords_(sheetName);
  for (let i = 0; i < records.length; i += 1) {
    if (String(records[i].record[key]) === target) return records[i];
  }
  return null;
}

function appendRecord_(sheetName, record) {
  const headers = TK_CONFIG.SHEETS[sheetName];
  const row = headers.map(function (header) {
    const value = record[header];
    return value === undefined || value === null ? '' : value;
  });
  getSheet_(sheetName).appendRow(row);
}

function updateRecord_(sheetName, rowNumber, record) {
  const headers = TK_CONFIG.SHEETS[sheetName];
  const values = headers.map(function (header) {
    const value = record[header];
    return value === undefined || value === null ? '' : value;
  });
  getSheet_(sheetName).getRange(rowNumber, 1, 1, headers.length).setValues([values]);
}

function safeJsonArray_(value) {
  try { const result = JSON.parse(String(value || '[]')); return Array.isArray(result) ? result : []; }
  catch (ignore) { return []; }
}

function apiError_(code, message) {
  const error = new Error(message);
  error.apiCode = code;
  return error;
}

function toPublicError_(error) {
  const known = error && error.apiCode;
  if (known) return { code: String(known), message: String(error.message || 'Permintaan gagal.') };
  return { code: 'SERVER_ERROR', message: 'Server mengalami kendala. Coba lagi beberapa saat.' };
}

function jsonOutput_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}

/** Manual smoke test from Apps Script editor; creates no account and changes no data. */
function testTagihanKuSetup() {
  assertSetup_();
  const names = Object.keys(TK_CONFIG.SHEETS);
  names.forEach(function (name) { getSheet_(name); });
  return 'OK: ' + names.join(', ');
}
