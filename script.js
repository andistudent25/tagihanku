/* =========================================================
   TAGIHANKU — frontend dengan backend Google Apps Script.
   Mode akun menggunakan server + Google Sheets; pembayaran tetap simulasi.
   Data pratinjau lokal hanya dipakai sebelum pengguna masuk.
   ========================================================= */
'use strict';

// Tandai enhancement hanya setelah file JavaScript eksternal berhasil dimuat.
document.documentElement.classList.add('js');

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const STORAGE_KEY = 'tagihanku:demo:v1.6';
const LEGACY_STORAGE_KEYS = ['tagihanku:demo:v1.5', 'tagihanku:demo:v1.4', 'tagihanku:demo:v1.3', 'tagihanku:demo:v1.2'];
const PREFERENCES_KEY = 'tagihanku:preferences:v1.6';
const LEGACY_PREFERENCES_KEYS = ['tagihanku:preferences:v1.5', 'tagihanku:preferences:v1.4', 'tagihanku:preferences:v1.3'];
const NOTIFICATIONS_KEY = 'tagihanku:notifications:v1.6';
const REMINDER_LEDGER_KEY = 'tagihanku:reminder-ledger:v1.6';
const MAX_NOTIFICATIONS = 80;
const MAX_REMINDER_LEDGER = 500;
const rupiah = (value) => new Intl.NumberFormat('id-ID').format(value);
const money = (value) => `Rp ${rupiah(value)}`;
const formatDate = (date) => new Intl.DateTimeFormat('id-ID', {
  day: '2-digit', month: 'short', year: 'numeric'
}).format(date);
const formatDateTime = (date) => new Intl.DateTimeFormat('id-ID', {
  day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(date);

const DEFAULT_BILLS = {
  internet: { name: 'Internet Fiber', amount: 385000, status: 'pending', due: '15 Nov 2026', dueISO: '2026-11-15', paidAt: null },
  electricity: { name: 'Listrik Pascabayar', amount: 215000, status: 'pending', due: '20 Nov 2026', dueISO: '2026-11-20', paidAt: null },
  water: { name: 'Air PDAM', amount: 50000, status: 'paid', due: '03 Nov 2026', dueISO: '2026-11-03', paidAt: '2026-11-03T09:30:00.000Z' }
};

function createDefaultTransactions() {
  return [
    { id: 'TK-20261103-0001', billIds: ['water'], items: [{ id: 'water', name: 'Air PDAM', amount: 50000 }], total: 50000, method: 'QRIS', status: 'paid', createdAt: '2026-11-03T09:30:00.000Z' },
    { id: 'TK-20261109-0002', billIds: ['internet'], items: [{ id: 'internet', name: 'Internet Fiber', amount: 385000 }], total: 385000, method: '—', status: 'pending', createdAt: '2026-11-09T08:00:00.000Z' },
    { id: 'TK-20261109-0003', billIds: ['electricity'], items: [{ id: 'electricity', name: 'Listrik Pascabayar', amount: 215000 }], total: 215000, method: '—', status: 'pending', createdAt: '2026-11-09T08:05:00.000Z' }
  ];
}

function normalizeTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return null;
  const allowedBillIds = new Set(Object.keys(DEFAULT_BILLS));
  const validItems = Array.isArray(transaction.items)
    ? transaction.items.filter((item) => item && typeof item.id === 'string' && allowedBillIds.has(item.id)
        && Number.isSafeInteger(Number(item.amount)) && Number(item.amount) >= 0 && Number(item.amount) <= 50000000)
      .map((item) => ({
        id: item.id,
        // The service name comes from the fixed application catalogue, never from stored HTML.
        name: DEFAULT_BILLS[item.id].name,
        amount: Math.round(Number(item.amount))
      }))
    : [];
  const createdAt = typeof transaction.createdAt === 'string' && !Number.isNaN(Date.parse(transaction.createdAt))
    ? transaction.createdAt : new Date().toISOString();
  if (typeof transaction.id !== 'string' || !/^TK-\d{8}-\d{4,8}$/.test(transaction.id) || !validItems.length) return null;
  const allowedMethods = ['QRIS', 'Transfer bank', 'E-wallet', '—'];
  const computedTotal = validItems.reduce((sum, item) => sum + item.amount, 0);
  return {
    id: transaction.id.slice(0, 60),
    billIds: validItems.map((item) => item.id),
    items: validItems,
    total: computedTotal,
    method: allowedMethods.includes(transaction.method) ? transaction.method : '—',
    status: transaction.status === 'paid' ? 'paid' : 'pending',
    createdAt
  };
}

function loadInitialState() {
  const defaultBills = JSON.parse(JSON.stringify(DEFAULT_BILLS));
  const defaults = { bills: defaultBills, transactions: createDefaultTransactions() };
  try {
    const storedValue = localStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean) || 'null';
    const saved = JSON.parse(storedValue);
    if (!saved || typeof saved !== 'object') return defaults;
    Object.keys(defaultBills).forEach((id) => {
      const previous = saved.bills && saved.bills[id];
      if (!previous) return;
      defaultBills[id].status = previous.status === 'paid' ? 'paid' : 'pending';
      defaultBills[id].paidAt = typeof previous.paidAt === 'string' && !Number.isNaN(Date.parse(previous.paidAt))
        ? previous.paidAt : (defaultBills[id].status === 'paid' ? defaultBills[id].paidAt : null);
    });
    const savedTransactions = Array.isArray(saved.transactions)
      ? saved.transactions.map(normalizeTransaction).filter(Boolean).slice(0, 500)
      : defaults.transactions;
    return { bills: defaultBills, transactions: savedTransactions.length ? savedTransactions : defaults.transactions };
  } catch (error) {
    // Mode privat atau browser dengan storage nonaktif tetap dapat menjalankan demo.
    return defaults;
  }
}

const initialState = loadInitialState();
const bills = initialState.bills;
let transactions = initialState.transactions;
const selectedBills = new Set();
let activeFilter = 'all';
let activeBillFilter = 'all';
let toastTimer;
let persistenceAvailable = true;

/* ---------- v1.6: notification storage and reminder engine ---------- */
function normalizeNotification(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
  const createdAt = typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt))
    ? item.createdAt : new Date().toISOString();
  const allowedTypes = ['due_soon', 'due_today', 'overdue', 'test', 'system'];
  return {
    id: item.id.slice(0, 90),
    uniqueKey: typeof item.uniqueKey === 'string' ? item.uniqueKey.slice(0, 160) : item.id.slice(0, 90),
    type: allowedTypes.includes(item.type) ? item.type : 'system',
    billId: typeof item.billId === 'string' ? item.billId.slice(0, 40) : null,
    title: typeof item.title === 'string' ? item.title.slice(0, 100) : 'Notifikasi TagihanKu',
    message: typeof item.message === 'string' ? item.message.slice(0, 260) : '',
    createdAt,
    read: item.read === true
  };
}

function loadNotifications() {
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) || '[]');
    return Array.isArray(stored) ? stored.map(normalizeNotification).filter(Boolean).slice(0, MAX_NOTIFICATIONS) : [];
  } catch (error) {
    return [];
  }
}

let notifications = loadNotifications();
let notificationFilter = 'all';

function loadReminderLedger(storageKey = REMINDER_LEDGER_KEY) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(saved) ? saved.filter((key) => typeof key === 'string').slice(0, MAX_REMINDER_LEDGER) : [];
  } catch (error) {
    return [];
  }
}

let reminderLedger = loadReminderLedger();

function persistReminderLedger() {
  try {
    const storageKey = backendAuthenticated && backendUserId ? `${REMINDER_LEDGER_KEY}:${backendUserId}` : REMINDER_LEDGER_KEY;
    localStorage.setItem(storageKey, JSON.stringify(reminderLedger.slice(0, MAX_REMINDER_LEDGER)));
    return true;
  } catch (error) {
    return false;
  }
}

function persistNotifications() {
  if (backendAuthenticated) return true; // Data akun berasal dari Google Sheets.
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
    return true;
  } catch (error) {
    showToast('Notifikasi tidak dapat disimpan oleh browser ini.');
    return false;
  }
}

function unreadNotificationCount() {
  return notifications.filter((item) => !item.read).length;
}

function formatNotificationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Waktu tidak diketahui';
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function updateBrowserNotificationButton() {
  const button = $('#browser-notification-enable');
  if (!button) return;
  if (!('Notification' in window)) {
    button.textContent = 'Notifikasi browser tidak didukung';
    button.disabled = true;
    return;
  }
  const permission = Notification.permission;
  if (permission === 'granted') button.textContent = 'Notifikasi browser aktif ✓';
  else if (permission === 'denied') button.textContent = 'Izin notifikasi ditolak';
  else button.textContent = 'Aktifkan notifikasi browser';
  button.disabled = permission === 'denied';
}

function renderNotificationCenter() {
  const unread = unreadNotificationCount();
  const badge = $('#notification-badge');
  const sidebarBadge = $('#sidebar-notification-count');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = unread === 0;
  if (sidebarBadge) {
    sidebarBadge.textContent = unread > 99 ? '99+' : String(unread);
    sidebarBadge.hidden = unread === 0;
  }
  $('#notification-open').setAttribute('aria-label', `Buka notifikasi, ${unread} belum dibaca`);
  $('#notification-unread-count').textContent = `${unread} belum dibaca`;
  $('#notification-total-count').textContent = `${notifications.length} notifikasi`;
  $('#mark-all-notifications-read').disabled = unread === 0;
  $('#clear-notifications').disabled = notifications.length === 0;
  $$('[data-notification-filter]').forEach((button) => {
    const active = button.dataset.notificationFilter === notificationFilter;
    button.classList.toggle('is-current', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const list = $('#notification-list');
  list.replaceChildren();
  const visible = notifications.filter((item) => notificationFilter === 'all' || !item.read);
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'notification-empty';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✦';
    const title = document.createElement('strong');
    title.textContent = notificationFilter === 'unread' ? 'Semua sudah dibaca' : 'Belum ada notifikasi';
    const copy = document.createElement('p');
    copy.textContent = notificationFilter === 'unread' ? 'Tidak ada notifikasi baru yang perlu diperiksa.' : 'Pengingat tagihan akan muncul di sini saat memenuhi jadwal.';
    empty.append(icon, title, copy);
    list.append(empty);
    return;
  }

  visible.forEach((item) => {
    const card = document.createElement('article');
    card.className = `notification-item notification-${item.type}${item.read ? '' : ' is-unread'}`;
    card.dataset.notificationId = item.id;
    const icon = document.createElement('span');
    icon.className = 'notification-item-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.type === 'overdue' ? '!' : item.type === 'due_today' ? '◷' : item.type === 'due_soon' ? '⌛' : '✦';
    const content = document.createElement('div');
    content.className = 'notification-item-content';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const message = document.createElement('p');
    message.textContent = item.message;
    const time = document.createElement('time');
    time.dateTime = item.createdAt;
    time.textContent = formatNotificationTime(item.createdAt);
    content.append(title, message, time);
    const actions = document.createElement('div');
    actions.className = 'notification-item-actions';
    if (item.billId && bills[item.billId]) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'notification-item-link';
      jump.dataset.notificationOpen = item.id;
      jump.textContent = 'Lihat tagihan';
      actions.append(jump);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'notification-item-remove';
    remove.dataset.notificationDelete = item.id;
    remove.setAttribute('aria-label', 'Hapus notifikasi');
    remove.textContent = '×';
    actions.append(remove);
    card.append(icon, content, actions);
    list.append(card);
  });
}

function addNotification({ type = 'system', billId = null, title, message, uniqueKey = null, native = true }) {
  const key = uniqueKey || `${type}:${billId || 'general'}:${toISODate(new Date())}:${title}`;
  if (notifications.some((item) => item.uniqueKey === key)) return null;
  const item = normalizeNotification({
    id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    uniqueKey: key,
    type,
    billId,
    title,
    message,
    createdAt: new Date().toISOString(),
    read: false
  });
  notifications.unshift(item);
  notifications = notifications.slice(0, MAX_NOTIFICATIONS);
  if (backendAuthenticated && backendApi) {
    backendApi.pushNotification(item).then((result) => {
      if (!result || !result.notification) return;
      const stored = normalizeNotification(result.notification);
      const currentIndex = notifications.findIndex((entry) => entry.uniqueKey === item.uniqueKey || entry.id === item.id);
      if (currentIndex >= 0) notifications[currentIndex] = stored;
      renderNotificationCenter();
    }).catch(() => {
      showToast('Pengingat tampil di perangkat, tetapi belum tersimpan di akun.');
    });
  } else {
    persistNotifications();
  }
  renderNotificationCenter();
  if (native && appPreferences.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const notice = new Notification(item.title, { body: item.message, tag: item.uniqueKey, icon: 'favicon.svg' });
      notice.onclick = () => {
        window.focus();
        if (item.billId) jumpToBill(item.billId);
        notice.close();
      };
    } catch (error) {
      // Pusat notifikasi tetap berfungsi walaupun notifikasi sistem tidak tersedia.
    }
  }
  return item;
}

function syncReminderNotifications() {
  if (!appPreferences.remindersEnabled) return;
  if (backendConfigured && !backendAuthenticated) return;
  const now = new Date();
  const [hour, minute] = appPreferences.reminderTime.split(':').map(Number);
  const scheduledMinutes = hour * 60 + minute;
  if (now.getHours() * 60 + now.getMinutes() < scheduledMinutes) return;
  const todayISO = toISODate(now);
  Object.entries(bills).forEach(([id, bill]) => {
    if (bill.status !== 'pending' || !bill.dueISO) return;
    const days = daysUntilDue(bill, now);
    let type = null;
    let title = '';
    let message = '';
    if (days < 0 && appPreferences.remindOverdue) {
      type = 'overdue';
      title = `Tagihan ${bill.name} terlambat`;
      message = `Tagihan sebesar ${money(bill.amount)} melewati jatuh tempo ${Math.abs(days)} hari. Periksa dan prioritaskan pembayaran.`;
    } else if (days === 0) {
      type = 'due_today';
      title = `${bill.name} jatuh tempo hari ini`;
      message = `Siapkan ${money(bill.amount)} untuk tagihan yang jatuh tempo hari ini.`;
    } else if (days > 0 && days <= Number(appPreferences.reminderLeadDays)) {
      type = 'due_soon';
      title = `${bill.name} segera jatuh tempo`;
      message = `Tagihan ${money(bill.amount)} jatuh tempo ${days} hari lagi. Siapkan pembayaran sebelum tanggal tersebut.`;
    }
    if (type) {
      const uniqueKey = `${todayISO}:${id}:${type}`;
      if (reminderLedger.includes(uniqueKey)) return;
      const created = addNotification({ type, billId: id, title, message, uniqueKey });
      if (created) {
        reminderLedger.unshift(uniqueKey);
        reminderLedger = reminderLedger.slice(0, MAX_REMINDER_LEDGER);
        persistReminderLedger();
      }
    }
  });
}

function updateReminderSettingsUI() {
  $('#pref-reminders').checked = appPreferences.remindersEnabled;
  $('#pref-overdue-reminders').checked = appPreferences.remindOverdue;
  $('#reminder-lead-days').value = String(appPreferences.reminderLeadDays);
  $('#reminder-time').value = appPreferences.reminderTime;
  const status = appPreferences.remindersEnabled
    ? `Pengingat otomatis aktif. Pemeriksaan berjalan saat halaman terbuka setelah pukul ${appPreferences.reminderTime.replace(':', '.')}.`
    : 'Pengingat otomatis sedang dijeda. Pusat notifikasi dan riwayat yang sudah ada tetap tersimpan.';
  $('#reminder-status-label').textContent = status;
  updateBrowserNotificationButton();
}

function jumpToBill(billId) {
  // Cari berdasarkan dataset agar nilai dari penyimpanan lokal tidak menjadi selector CSS.
  const card = $$('[data-bill-id]').find((candidate) => candidate.dataset.billId === billId);
  if (!card) return;
  activeBillFilter = 'all';
  updateBillFilters();
  card.scrollIntoView({ behavior: appPreferences.reduceMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('notification-highlight');
  requestAnimationFrame(() => card.classList.add('notification-highlight'));
  window.setTimeout(() => card.classList.remove('notification-highlight'), 2200);
}

function handleNotificationClick(event) {
  const openButton = event.target.closest('[data-notification-open]');
  const deleteButton = event.target.closest('[data-notification-delete]');
  if (openButton) {
    const item = notifications.find((entry) => entry.id === openButton.dataset.notificationOpen);
    if (!item) return;
    item.read = true;
    if (backendAuthenticated && backendApi) backendApi.markNotificationRead(item.id).catch(() => showToast('Status notifikasi belum tersinkron.'));
    persistNotifications();
    renderNotificationCenter();
    if (item.billId) jumpToBill(item.billId);
    return;
  }
  if (deleteButton) {
    const deletedId = deleteButton.dataset.notificationDelete;
    if (backendAuthenticated && backendApi) backendApi.deleteNotification(deletedId).catch(() => showToast('Notifikasi belum dapat dihapus dari akun.'));
    notifications = notifications.filter((item) => item.id !== deletedId);
    persistNotifications();
    renderNotificationCenter();
  }
}

$('#notification-list').addEventListener('click', handleNotificationClick);
$('#notification-open').addEventListener('click', () => {
  $('#notifikasi').scrollIntoView({ behavior: appPreferences.reduceMotion ? 'auto' : 'smooth' });
});
$$('[data-notification-filter]').forEach((button) => button.addEventListener('click', () => {
  notificationFilter = button.dataset.notificationFilter;
  renderNotificationCenter();
}));
$('#mark-all-notifications-read').addEventListener('click', () => {
  notifications.forEach((item) => {
    item.read = true;
    if (backendAuthenticated && backendApi) backendApi.markNotificationRead(item.id).catch(() => {});
  });
  persistNotifications();
  renderNotificationCenter();
  showToast('Semua notifikasi ditandai sudah dibaca.');
});
$('#clear-notifications').addEventListener('click', () => {
  if (!notifications.length) return;
  notifications = [];
  if (backendAuthenticated && backendApi) backendApi.clearNotifications().catch(() => showToast('Notifikasi belum dapat dibersihkan dari akun.'));
  persistNotifications();
  renderNotificationCenter();
  showToast('Pusat notifikasi berhasil dibersihkan.');
});
$('#test-reminder').addEventListener('click', () => {
  addNotification({
    type: 'test',
    title: 'Pengingat percobaan berhasil',
    message: 'Pusat notifikasi TagihanKu berfungsi. Pengingat otomatis akan tampil ketika tagihan memenuhi aturan jadwal.',
    uniqueKey: `test:${Date.now()}`
  });
  showToast('Pengingat tes ditambahkan ke pusat notifikasi.');
});
$('#browser-notification-enable').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    showToast('Browser ini tidak mendukung notifikasi sistem.');
    return;
  }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    showToast('Notifikasi browser membutuhkan HTTPS atau localhost.');
    return;
  }
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    appPreferences.browserNotifications = permission === 'granted';
    persistUserPreferences();
    updateBrowserNotificationButton();
    showToast(permission === 'granted' ? 'Izin notifikasi browser berhasil diaktifkan.' : 'Izin notifikasi browser belum diberikan.');
  } catch (error) {
    showToast('Permintaan izin notifikasi tidak dapat diselesaikan.');
  }
});
$('#pref-reminders').addEventListener('change', (event) => {
  appPreferences.remindersEnabled = event.currentTarget.checked;
  persistUserPreferences();
  updateReminderSettingsUI();
  syncReminderNotifications();
});
$('#pref-overdue-reminders').addEventListener('change', (event) => {
  appPreferences.remindOverdue = event.currentTarget.checked;
  persistUserPreferences();
  syncReminderNotifications();
});
$('#reminder-lead-days').addEventListener('change', (event) => {
  appPreferences.reminderLeadDays = Number(event.currentTarget.value);
  persistUserPreferences();
  syncReminderNotifications();
});
$('#reminder-time').addEventListener('change', (event) => {
  appPreferences.reminderTime = event.currentTarget.value;
  persistUserPreferences();
  updateReminderSettingsUI();
  syncReminderNotifications();
});

function persistState() {
  if (backendAuthenticated) return true; // Tagihan dan transaksi akun disimpan oleh backend.
  try {
    const serializable = {
      version: 1.6,
      bills: Object.fromEntries(Object.entries(bills).map(([id, bill]) => [id, { status: bill.status, paidAt: bill.paidAt }])),
      transactions
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    persistenceAvailable = true;
    return true;
  } catch (error) {
    persistenceAvailable = false;
    return false;
  }
}

/* ---------- Toast ---------- */
function showToast(message) {
  const toast = $('#toast');
  $('#toast-message').textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* ---------- v1.4: tema, personalisasi dashboard, dan profil lokal ---------- */
const DEFAULT_PREFERENCES = {
  theme: 'system',
  reduceMotion: false,
  compactMode: false,
  showHeroVisual: true,
  showAssistant: true,
  remindersEnabled: true,
  remindOverdue: true,
  reminderLeadDays: 3,
  reminderTime: '09:00',
  browserNotifications: false
};
const DEFAULT_PROFILE = { name: 'Pengunjung', email: 'Belum masuk', signedIn: false };

function loadUserPreferences() {
  try {
    const savedValue = localStorage.getItem(PREFERENCES_KEY) || LEGACY_PREFERENCES_KEYS.map((key) => localStorage.getItem(key)).find(Boolean) || 'null';
    const saved = JSON.parse(savedValue);
    if (!saved || typeof saved !== 'object') {
      return { ...DEFAULT_PREFERENCES, profile: { ...DEFAULT_PROFILE } };
    }
    const profile = saved.profile && typeof saved.profile === 'object' ? saved.profile : {};
    return {
      theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : DEFAULT_PREFERENCES.theme,
      reduceMotion: saved.reduceMotion === true,
      compactMode: saved.compactMode === true,
      showHeroVisual: saved.showHeroVisual !== false,
      showAssistant: saved.showAssistant !== false,
      remindersEnabled: saved.remindersEnabled !== false,
      remindOverdue: saved.remindOverdue !== false,
      reminderLeadDays: [1, 3, 7].includes(Number(saved.reminderLeadDays)) ? Number(saved.reminderLeadDays) : 3,
      reminderTime: ['08:00', '09:00', '12:00', '18:00'].includes(saved.reminderTime) ? saved.reminderTime : '09:00',
      browserNotifications: saved.browserNotifications === true,
      profile: {
        name: typeof profile.name === 'string' && profile.name.trim()
          ? profile.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || DEFAULT_PROFILE.name
          : DEFAULT_PROFILE.name,
        email: typeof profile.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email.trim())
          ? profile.email.trim().slice(0, 100).toLowerCase()
          : DEFAULT_PROFILE.email,
        signedIn: profile.signedIn === true
      }
    };
  } catch (error) {
    return { ...DEFAULT_PREFERENCES, profile: { ...DEFAULT_PROFILE } };
  }
}

const appPreferences = loadUserPreferences();
const profile = appPreferences.profile;
const backendApi = window.TagihanKuBackend || null;
const backendConfigured = Boolean(backendApi && backendApi.isConfigured());
let backendAuthenticated = false;
let backendServiceReady = false;
let backendUserId = '';
let applyingServerDashboard = false;

// Jangan mewarisi status login demo lama saat endpoint akun sungguhan aktif.
if (backendConfigured) {
  profile.signedIn = false;
  notifications = [];
  reminderLedger = [];
}

function persistUserPreferences() {
  try {
    const localSnapshot = { ...appPreferences, profile: backendAuthenticated ? { ...DEFAULT_PROFILE } : profile };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(localSnapshot));
    if (backendAuthenticated && backendApi && !applyingServerDashboard) {
      const remotePreferences = { ...appPreferences };
      delete remotePreferences.profile;
      backendApi.savePreferences(remotePreferences).catch(() => {
        // Kegagalan sinkronisasi preferensi tidak boleh memunculkan error teknis ke pengguna.
        showToast('Preferensi tersimpan di perangkat, tetapi belum tersinkron ke akun.');
      });
    }
    return true;
  } catch (error) {
    showToast('Preferensi tidak dapat disimpan oleh browser ini.');
    return false;
  }
}

function getEffectiveTheme(theme = appPreferences.theme) {
  if (theme !== 'system') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'PD';
}

function renderProfileSummary() {
  const initials = getInitials(profile.name);
  $('#header-profile-avatar').textContent = initials;
  $('#settings-profile-avatar').textContent = initials;
  $('#settings-profile-name').textContent = profile.name;
  $('#settings-profile-email').textContent = profile.email;
  $('#header-profile-label').textContent = profile.signedIn ? profile.name.split(/\s+/)[0] : 'Masuk';
  $('#profile-open').setAttribute('aria-label', profile.signedIn ? `Buka profil ${profile.name}` : 'Masuk ke akun TagihanKu');
  $('#profile-open').title = profile.signedIn ? `Profil ${profile.name}` : 'Masuk ke akun TagihanKu';
}

function applyUserPreferences() {
  const root = document.documentElement;
  const effectiveTheme = getEffectiveTheme();
  root.dataset.theme = effectiveTheme;
  const browserThemeMeta = $('#app-theme-color');
  if (browserThemeMeta) browserThemeMeta.content = effectiveTheme === 'dark' ? '#101522' : '#f7f8fc';
  root.classList.toggle('reduce-motion', appPreferences.reduceMotion);
  root.classList.toggle('compact-mode', appPreferences.compactMode);
  $('.hero-visual').hidden = !appPreferences.showHeroVisual;
  $('#asisten').hidden = !appPreferences.showAssistant;
  $('#theme-toggle').textContent = effectiveTheme === 'dark' ? '☼' : '◐';
  $('#theme-toggle').setAttribute('aria-label', effectiveTheme === 'dark' ? 'Aktifkan tema terang' : 'Aktifkan tema gelap');
  $('#theme-toggle').title = effectiveTheme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap';
  const themeMeta = $('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = effectiveTheme === 'dark' ? '#101522' : '#f7f8fc';

  $$('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === appPreferences.theme));
    button.classList.toggle('is-selected', button.dataset.themeChoice === appPreferences.theme);
  });
  $('#pref-reduced-motion').checked = appPreferences.reduceMotion;
  $('#pref-compact').checked = appPreferences.compactMode;
  $('#pref-hero').checked = appPreferences.showHeroVisual;
  $('#pref-assistant').checked = appPreferences.showAssistant;
  updateReminderSettingsUI();
  renderProfileSummary();
}

function updatePreference(name, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PREFERENCES, name)) return;
  appPreferences[name] = value;
  applyUserPreferences();
  persistUserPreferences();
}

function openProfileDialog() {
  if (!backendAuthenticated) {
    openDialog($('#login-dialog'));
    return;
  }
  $('#profile-name-input').value = profile.name;
  $('#profile-email-input').value = profile.email;
  $('#profile-mode-hint').textContent = 'Perubahan profil disimpan ke akun TagihanKu.';
  $('#logout-button').hidden = false;
  openDialog($('#profile-dialog'));
  window.setTimeout(() => $('#profile-name-input').focus(), 30);
}

$('#profile-open').addEventListener('click', () => {
  if (backendAuthenticated && profile.signedIn) openProfileDialog();
  else openDialog($('#login-dialog'));
});
$('#edit-profile').addEventListener('click', openProfileDialog);
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  if (!backendAuthenticated || !backendApi) {
    showToast('Masuk ke akun TagihanKu untuk mengubah profil.');
    return;
  }
  const data = new FormData(form);
  const name = String(data.get('name') || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  const email = String(data.get('email') || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 48 || email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Periksa kembali nama dan alamat email.');
    return;
  }
  const saveButton = $('#profile-save');
  saveButton.disabled = true;
  const originalLabel = saveButton.textContent;
  saveButton.textContent = 'Menyimpan…';
  try {
    const dashboard = await backendApi.saveProfile({ name, email });
    applyBackendDashboard(dashboard);
    closeDialog($('#profile-dialog'));
    showToast('Profil akun berhasil diperbarui.');
  } catch (error) {
    showToast(toFriendlyAuthError(error));
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
});

$('#logout-button').addEventListener('click', async () => {
  const button = $('#logout-button');
  button.disabled = true;
  try {
    if (backendApi) await backendApi.logout();
    backendAuthenticated = false;
    backendUserId = '';
    reminderLedger = loadReminderLedger();
    profile.name = DEFAULT_PROFILE.name;
    profile.email = DEFAULT_PROFILE.email;
    profile.signedIn = false;
    notifications = [];
    closeDialog($('#profile-dialog'));
    renderProfileSummary();
    renderNotificationCenter();
    updateAuthCopy(backendServiceReady);
    // Kembalikan data pratinjau, tanpa menyalin data akun ke penyimpanan lokal.
    Object.keys(DEFAULT_BILLS).forEach((id) => Object.assign(bills[id], DEFAULT_BILLS[id]));
    transactions = createDefaultTransactions();
    renderBillCards();
    updateSummaryCards();
    renderHistory();
    showToast('Kamu telah keluar dari akun.');
  } catch (error) {
    showToast('Belum dapat keluar dari akun. Periksa koneksi lalu coba lagi.');
  } finally {
    button.disabled = false;
  }
});

$('#theme-toggle').addEventListener('click', () => {
  const nextTheme = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  updatePreference('theme', nextTheme);
  showToast(`Tema ${nextTheme === 'dark' ? 'gelap' : 'terang'} diaktifkan.`);
});
$$('[data-theme-choice]').forEach((button) => {
  button.addEventListener('click', () => {
    updatePreference('theme', button.dataset.themeChoice);
    const labels = { light: 'terang', dark: 'gelap', system: 'sesuai perangkat' };
    showToast(`Tema ${labels[button.dataset.themeChoice]} dipilih.`);
  });
});
$('#pref-reduced-motion').addEventListener('change', (event) => updatePreference('reduceMotion', event.currentTarget.checked));
$('#pref-compact').addEventListener('change', (event) => updatePreference('compactMode', event.currentTarget.checked));
$('#pref-hero').addEventListener('change', (event) => updatePreference('showHeroVisual', event.currentTarget.checked));
$('#pref-assistant').addEventListener('change', (event) => updatePreference('showAssistant', event.currentTarget.checked));
$('#reset-preferences').addEventListener('click', () => {
  Object.assign(appPreferences, DEFAULT_PREFERENCES);
  applyUserPreferences();
  persistUserPreferences();
  showToast('Preferensi kembali ke pengaturan awal.');
});

if (window.matchMedia) {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  systemTheme.addEventListener?.('change', () => {
    if (appPreferences.theme === 'system') applyUserPreferences();
  });
}
applyUserPreferences();

/* ---------- Dialog helpers ---------- */
function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.body.classList.add('dialog-open');
}
function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  if (!$('dialog[open]')) document.body.classList.remove('dialog-open');
}
$$('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => closeDialog(button.closest('dialog')));
});
$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.addEventListener('close', () => {
    if (!$('dialog[open]')) document.body.classList.remove('dialog-open');
  });
});

/* ---------- Sidebar navigation and accurate section positioning ---------- */
const navToggle = $('#nav-toggle');
const primaryNav = $('#primary-nav');
const sidebarBackdrop = $('#sidebar-backdrop');
function closeMobileNav() {
  navToggle.setAttribute('aria-expanded', 'false');
  navToggle.setAttribute('aria-label', 'Buka menu navigasi');
  primaryNav.classList.remove('is-open');
  sidebarBackdrop.classList.remove('is-visible');
  document.body.classList.remove('sidebar-open');
}
function openMobileNav() {
  navToggle.setAttribute('aria-expanded', 'true');
  navToggle.setAttribute('aria-label', 'Tutup menu navigasi');
  primaryNav.classList.add('is-open');
  sidebarBackdrop.classList.add('is-visible');
  document.body.classList.add('sidebar-open');
}
navToggle.addEventListener('click', () => {
  const isOpen = navToggle.getAttribute('aria-expanded') === 'true';
  if (isOpen) closeMobileNav();
  else openMobileNav();
});
sidebarBackdrop.addEventListener('click', closeMobileNav);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') closeMobileNav();
});

// Anchor targets now align the actual section heading below the sticky header,
// not the outer section's large decorative top padding.
function getSidebarFocusTarget(id) {
  if (id === 'beranda') return $('#hero-title');
  const section = document.getElementById(id);
  if (!section) return null;
  if (id === 'asisten') return section.querySelector('.planner-panel-head') || section;
  if (id === 'bantuan') return section.querySelector('.help-copy h2') || section;
  return section.querySelector('.section-heading') || section;
}
function scrollToSidebarHash(hash, behavior = 'smooth') {
  const id = String(hash || '').replace(/^#/, '');
  if (!id) return;
  const focusTarget = getSidebarFocusTarget(id);
  if (!focusTarget) return;
  const headerHeight = $('.site-header')?.getBoundingClientRect().height || 0;
  const targetTop = window.scrollY + focusTarget.getBoundingClientRect().top - headerHeight - 22;
  window.scrollTo({ top: Math.max(0, targetTop), behavior: appPreferences.reduceMotion ? 'auto' : behavior });
  $$('.nav-link').forEach((link) => {
    const active = link.getAttribute('href') === `#${id}`;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
function handleSidebarNavigation(event) {
  const link = event.currentTarget;
  const hash = link.getAttribute('href');
  if (!hash || !hash.startsWith('#')) {
    closeMobileNav();
    return;
  }
  const id = hash.slice(1);
  if (!document.getElementById(id) && id !== 'beranda') return;
  event.preventDefault();
  closeMobileNav();
  if (window.location.hash !== hash) history.pushState(null, '', hash);
  requestAnimationFrame(() => scrollToSidebarHash(hash));
}
$$('.nav-link, .sidebar-brand, .sidebar-footer-card a').forEach((link) => {
  link.addEventListener('click', handleSidebarNavigation);
});
window.addEventListener('popstate', () => scrollToSidebarHash(window.location.hash, 'auto'));
window.addEventListener('load', () => {
  if (window.location.hash) window.setTimeout(() => scrollToSidebarHash(window.location.hash, 'auto'), 80);
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 1024) closeMobileNav();
});

/* ---------- Authentication: Google Apps Script backend ---------- */
function toFriendlyAuthError(error) {
  const code = error && error.code;
  const messages = {
    EMAIL_EXISTS: 'Email ini sudah terdaftar. Silakan masuk.',
    INVALID_CREDENTIALS: 'Email atau kata sandi tidak sesuai.',
    LOGIN_LOCKED: 'Terlalu banyak percobaan masuk. Coba lagi setelah 15 menit.',
    WEAK_PASSWORD: 'Kata sandi perlu minimal 10 karakter dengan huruf kecil, huruf besar, dan angka.',
    INVALID_EMAIL: 'Format alamat email belum benar.',
    INVALID_NAME: 'Nama perlu 2–48 karakter dan tidak boleh diawali simbol formula.',
    REGISTRATION_CLOSED: 'Pendaftaran akun sedang ditutup. Hubungi pengelola.',
    NOT_CONFIGURED: 'Layanan akun belum siap. Hubungi pengelola TagihanKu.',
    UNAUTHORIZED: 'Sesi akun berakhir. Silakan masuk kembali.',
    USER_NOT_FOUND: 'Akun tidak ditemukan. Silakan daftar atau masuk kembali.'
  };
  if (messages[code]) return messages[code];
  const safeMessage = error && typeof error.message === 'string' ? error.message : '';
  if (/belum dapat dihubungi|respons layanan|deployment|koneksi/i.test(safeMessage)) {
    return 'Layanan akun belum dapat dihubungi. Periksa koneksi internet atau coba kembali beberapa saat lagi.';
  }
  return safeMessage || 'Permintaan belum dapat diproses. Coba kembali.';
}

function updateAuthCopy(serviceReady = false) {
  backendServiceReady = Boolean(backendConfigured && serviceReady);
  $('#login-mode-hint').textContent = backendServiceReady
    ? 'Masuk menggunakan email dan kata sandi akun TagihanKu.'
    : 'Layanan akun sedang disiapkan atau tidak dapat dijangkau. Coba kembali beberapa saat lagi.';
  $('#login-disclaimer').textContent = 'Jangan bagikan kata sandi kepada siapa pun. TagihanKu tidak akan meminta kata sandi melalui pesan.';
  $('#register-open').disabled = !backendServiceReady;
  $('#register-open').textContent = backendServiceReady ? 'Buat akun' : 'Pendaftaran sementara tidak tersedia';
  $('#logout-button').hidden = !backendAuthenticated;
  $('#profile-save').disabled = !backendAuthenticated;
  $('#profile-mode-hint').textContent = backendAuthenticated
    ? 'Perubahan profil disimpan ke akun TagihanKu.'
    : 'Masuk untuk mengelola profil akun.';
  $('#reset-demo').hidden = backendConfigured;
  const reportLabel = $('.report-demo-label');
  if (reportLabel) reportLabel.textContent = backendAuthenticated ? 'LAPORAN AKUN' : 'PRATINJAU';
  $$('.secure-note').forEach((node) => {
    const icon = node.querySelector('span');
    node.replaceChildren();
    if (icon) node.append(icon, document.createTextNode(' '));
    node.append(document.createTextNode(backendAuthenticated ? 'Data akun tersinkron ke server' : 'Masuk untuk menyimpan data secara pribadi'));
  });
  const assistantNote = $('.assistant-disclaimer');
  if (assistantNote) assistantNote.textContent = backendAuthenticated
    ? 'Asisten memberikan saran berdasarkan data akun. Rekomendasi bersifat informatif, bukan nasihat keuangan.'
    : 'Asisten menggunakan data pratinjau pada halaman ini. Masuk untuk melihat ringkasan akun pribadi.';
  const settingsNotes = $$('.settings-footnote');
  if (settingsNotes[0]) settingsNotes[0].textContent = backendAuthenticated
    ? 'Profil dan preferensi akun disimpan melalui layanan TagihanKu. Tema dan kenyamanan tampilan juga dapat tersimpan pada perangkat ini.'
    : 'Masuk ke akun TagihanKu untuk menyimpan profil, preferensi, dan data secara pribadi.';
  if (settingsNotes[1]) settingsNotes[1].textContent = 'Agar PWA dan cache offline aktif, jalankan melalui HTTPS atau localhost. Operasi akun dan sinkronisasi data memerlukan koneksi internet.';
}

function mergeServerPreferences(preferences) {
  if (!preferences || typeof preferences !== 'object') return;
  const booleanKeys = ['reduceMotion', 'compactMode', 'showHeroVisual', 'showAssistant', 'remindersEnabled', 'remindOverdue', 'browserNotifications'];
  booleanKeys.forEach((key) => { if (typeof preferences[key] === 'boolean') appPreferences[key] = preferences[key]; });
  if (['light', 'dark', 'system'].includes(preferences.theme)) appPreferences.theme = preferences.theme;
  if ([1, 3, 7].includes(Number(preferences.reminderLeadDays))) appPreferences.reminderLeadDays = Number(preferences.reminderLeadDays);
  if (['08:00', '09:00', '12:00', '18:00'].includes(preferences.reminderTime)) appPreferences.reminderTime = preferences.reminderTime;
}

function applyBackendDashboard(response, authenticatedUser) {
  const dashboard = response && response.dashboard ? response.dashboard : response;
  if (!dashboard || !dashboard.user || !Array.isArray(dashboard.bills) || !Array.isArray(dashboard.transactions)) {
    throw new Error('Data akun dari server belum lengkap. Muat ulang halaman dan coba lagi.');
  }
  applyingServerDashboard = true;
  try {
    const serverBills = new Map(dashboard.bills.map((bill) => [String(bill.id || bill.service), bill]));
    Object.keys(DEFAULT_BILLS).forEach((id) => {
      const source = serverBills.get(id);
      if (!source) return;
      const amount = Number(source.amount);
      const dueISO = String(source.dueISO || '').slice(0, 10);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 50000000 || !/^\d{4}-\d{2}-\d{2}$/.test(dueISO)) return;
      bills[id].name = DEFAULT_BILLS[id].name;
      bills[id].amount = amount;
      bills[id].description = String(source.description || '').slice(0, 100);
      bills[id].dueISO = dueISO;
      bills[id].due = formatDate(new Date(dueISO + 'T12:00:00'));
      bills[id].status = source.status === 'paid' ? 'paid' : 'pending';
      bills[id].paidAt = typeof source.paidAt === 'string' && !Number.isNaN(Date.parse(source.paidAt)) ? source.paidAt : null;
    });

    transactions = dashboard.transactions.map(normalizeTransaction).filter(Boolean).slice(0, 500);
    notifications = Array.isArray(dashboard.notifications)
      ? dashboard.notifications.map(normalizeNotification).filter(Boolean).slice(0, MAX_NOTIFICATIONS)
      : [];
    mergeServerPreferences(dashboard.preferences);

    const user = authenticatedUser || dashboard.user;
    profile.name = String(user.name || 'Pengguna').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'Pengguna';
    profile.email = String(user.email || '').trim().toLowerCase().slice(0, 100);
    profile.signedIn = true;
    backendUserId = String(user.id || dashboard.user.id || '');
    backendAuthenticated = true;
    reminderLedger = loadReminderLedger(`${REMINDER_LEDGER_KEY}:${backendUserId}`);
    selectedBills.clear();
    notificationFilter = 'all';
    renderProfileSummary();
    applyUserPreferences();
    renderBillCards();
    updateSummaryCards();
    renderHistory();
    renderNotificationCenter();
    updateSelectionUI();
    updateAuthCopy(true);
  } finally {
    applyingServerDashboard = false;
  }
}

function setAuthButtonBusy(button, busy, idleText) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? 'Memproses…' : idleText;
}

$$('.js-login').forEach((button) => {
  button.addEventListener('click', () => openDialog($('#login-dialog')));
});
$('#register-open').addEventListener('click', () => {
  if (!backendConfigured || !backendServiceReady || $('#register-open').disabled) {
    showToast('Pendaftaran akun sedang tidak tersedia. Coba kembali nanti.');
    return;
  }
  closeDialog($('#login-dialog'));
  $('#register-form').reset();
  openDialog($('#register-dialog'));
});
$('#back-to-login').addEventListener('click', () => {
  closeDialog($('#register-dialog'));
  openDialog($('#login-dialog'));
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  if (!backendConfigured || !backendServiceReady || !backendApi) {
    showToast('Layanan akun belum siap. Coba kembali beberapa saat lagi.');
    return;
  }
  const data = new FormData(form);
  const email = String(data.get('email') || '').trim().toLowerCase();
  const password = String(data.get('password') || '');
  const button = $('#login-submit');
  const original = 'Masuk sekarang →';
  setAuthButtonBusy(button, true, original);
  try {
    const result = await backendApi.login({ email, password });
    applyBackendDashboard(result.dashboard, result.user);
    closeDialog($('#login-dialog'));
    form.reset();
    showToast(`Selamat datang kembali, ${profile.name}.`);
  } catch (error) {
    showToast(toFriendlyAuthError(error));
  } finally {
    setAuthButtonBusy(button, false, original);
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  if (!backendConfigured || !backendServiceReady || !backendApi) {
    showToast('Pendaftaran akun belum siap. Coba kembali beberapa saat lagi.');
    return;
  }
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim().replace(/\s+/g, ' ');
  const email = String(data.get('email') || '').trim().toLowerCase();
  const password = String(data.get('password') || '');
  const passwordConfirm = String(data.get('passwordConfirm') || '');
  if (password !== passwordConfirm) {
    showToast('Konfirmasi kata sandi belum sama.');
    $('#register-password-confirm').focus();
    return;
  }
  if (password.length < 10 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    showToast('Gunakan minimal 10 karakter, huruf kecil, huruf besar, dan angka.');
    $('#register-password').focus();
    return;
  }
  const button = $('#register-submit');
  const original = 'Buat akun →';
  setAuthButtonBusy(button, true, original);
  try {
    const result = await backendApi.register({ name, email, password });
    applyBackendDashboard(result.dashboard, result.user);
    closeDialog($('#register-dialog'));
    form.reset();
    showToast(`Akun berhasil dibuat. Selamat datang, ${profile.name}.`);
  } catch (error) {
    showToast(toFriendlyAuthError(error));
  } finally {
    setAuthButtonBusy(button, false, original);
  }
});

async function restoreBackendAccount() {
  updateAuthCopy(false);
  if (!backendConfigured || !backendApi) return;
  if (backendApi.isAuthenticated()) {
    try {
      const dashboard = await backendApi.restore();
      if (dashboard) {
        applyBackendDashboard(dashboard);
        return;
      }
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED' && error.code !== 'USER_NOT_FOUND') {
        updateAuthCopy(false);
      }
    }
  }
  try {
    const health = await backendApi.health();
    updateAuthCopy(Boolean(health && health.status === 'ready'));
  } catch (error) {
    updateAuthCopy(false);
  }
}

$('#password-toggle').addEventListener('click', (event) => {
  const password = $('#login-password');
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  event.currentTarget.textContent = reveal ? 'Sembunyi' : 'Lihat';
  event.currentTarget.setAttribute('aria-label', reveal ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
});

/* ---------- Selection and totals ---------- */
function getSelectedTotal() {
  return [...selectedBills].reduce((total, id) => total + (bills[id]?.amount || 0), 0);
}
function updateSelectionUI() {
  const count = selectedBills.size;
  $$('.selection-count').forEach((node) => { node.textContent = count; });
  $$('.pay-selected').forEach((button) => { button.disabled = count === 0; });
  $('#selection-bar').classList.toggle('is-visible', count > 0);
  $$('.select-bill').forEach((button) => {
    const selected = selectedBills.has(button.dataset.id);
    button.setAttribute('aria-pressed', String(selected));
    const label = document.createTextNode(selected ? 'Dipilih' : 'Pilih tagihan');
    const symbol = document.createElement('span');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = selected ? '✓' : '＋';
    button.replaceChildren(label, document.createTextNode(' '), symbol);
  });
}

/* ---------- Bill cards render from one source of truth ---------- */
function renderBillCards() {
  $$('.bill-card').forEach((card) => {
    const id = card.dataset.billId;
    const bill = bills[id];
    if (!bill) return;
    card.dataset.status = bill.status;
    card.classList.toggle('bill-paid', bill.status === 'paid');
    const status = $('.status', card);
    status.className = `status ${bill.status === 'paid' ? 'status-paid' : 'status-pending'}`;
    status.textContent = bill.status === 'paid' ? 'Lunas' : 'Belum dibayar';
    const dueLabel = $('.bill-due span', card);
    const dueValue = $('.bill-due strong', card);
    if (bill.status === 'paid') {
      dueLabel.textContent = 'Dibayarkan';
      dueValue.textContent = bill.paidAt ? formatDate(new Date(bill.paidAt)) : 'Sudah lunas';
      dueValue.classList.remove('due-soon');
    } else {
      dueLabel.textContent = 'Jatuh tempo';
      dueValue.textContent = bill.due;
      dueValue.classList.toggle('due-soon', id === 'internet');
    }
    const oldButton = $('.select-bill, .button-paid', card);
    if (bill.status === 'paid') {
      const paidButton = document.createElement('button');
      paidButton.type = 'button';
      paidButton.className = 'button button-paid';
      paidButton.disabled = true;
      const paidIcon = document.createElement('span');
      paidIcon.setAttribute('aria-hidden', 'true');
      paidIcon.textContent = '✓';
      paidButton.append(paidIcon, document.createTextNode(' Sudah dibayar'));
      oldButton.replaceWith(paidButton);
      selectedBills.delete(id);
    } else if (!oldButton.classList.contains('select-bill')) {
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'button button-select select-bill';
      selectButton.dataset.id = id;
      selectButton.setAttribute('aria-pressed', 'false');
      const selectIcon = document.createElement('span');
      selectIcon.setAttribute('aria-hidden', 'true');
      selectIcon.textContent = '＋';
      selectButton.append(document.createTextNode('Pilih tagihan '), selectIcon);
      oldButton.replaceWith(selectButton);
    }
  });
  updateSelectionUI();
}

$('.bill-grid').addEventListener('click', (event) => {
  const button = event.target.closest('.select-bill');
  if (!button) return;
  const id = button.dataset.id;
  if (!bills[id] || bills[id].status !== 'pending') return;
  if (selectedBills.has(id)) selectedBills.delete(id);
  else selectedBills.add(id);
  updateSelectionUI();
});

/* ---------- Payment dialog and transaction creation ---------- */
function openPaymentDialog() {
  if (selectedBills.size === 0) return;
  if (backendConfigured && !backendAuthenticated) {
    showToast('Masuk atau buat akun untuk menyimpan pembayaran ke akunmu.');
    openDialog($('#login-dialog'));
    return;
  }
  const items = $('#payment-items');
  items.replaceChildren();
  selectedBills.forEach((id) => {
    const item = document.createElement('div');
    item.className = 'payment-item';
    const name = document.createElement('span');
    name.textContent = bills[id].name;
    const amount = document.createElement('strong');
    amount.textContent = money(bills[id].amount);
    item.append(name, amount);
    items.append(item);
  });
  $('#payment-total').textContent = money(getSelectedTotal());
  openDialog($('#payment-dialog'));
}
$$('.pay-selected').forEach((button) => button.addEventListener('click', openPaymentDialog));

function createTransactionId(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const prefix = `TK-${year}${month}${day}-`;
  const sequence = transactions.reduce((max, transaction) => {
    if (!transaction.id.startsWith(prefix)) return max;
    const suffix = Number(transaction.id.slice(prefix.length));
    return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
  }, 0) + 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (selectedBills.size === 0) return;
  const requestedMethod = new FormData(event.currentTarget).get('method');
  const method = ['QRIS', 'Transfer bank', 'E-wallet'].includes(requestedMethod) ? requestedMethod : 'QRIS';
  const paidIds = [...selectedBills].filter((id) => bills[id] && bills[id].status === 'pending');
  if (!paidIds.length) return;

  if (backendAuthenticated && backendApi) {
    const submitButton = $('#payment-form button[type="submit"]');
    const originalLabel = submitButton ? submitButton.textContent : 'Konfirmasi pembayaran';
    if (submitButton) setAuthButtonBusy(submitButton, true, originalLabel);
    try {
      const result = await backendApi.payBills(paidIds, method);
      if (!result || !result.transaction || !result.dashboard) throw new Error('Respons pembayaran belum lengkap.');
      applyBackendDashboard(result.dashboard);
      closeDialog($('#payment-dialog'));
      $('#payment-form').reset();
      showToast(`Pembayaran simulasi ${money(result.transaction.total)} berhasil dicatat.`);
      showReceipt(result.transaction.id);
    } catch (error) {
      showToast(toFriendlyAuthError(error));
    } finally {
      if (submitButton) setAuthButtonBusy(submitButton, false, originalLabel);
    }
    return;
  }

  // Mode pratinjau lokal hanya digunakan jika endpoint backend tidak diatur.
  if (backendConfigured) {
    showToast('Masuk ke akun TagihanKu sebelum melanjutkan.');
    openDialog($('#login-dialog'));
    return;
  }
  const now = new Date();
  const items = paidIds.map((id) => ({ id, name: bills[id].name, amount: bills[id].amount }));
  const transaction = {
    id: createTransactionId(now), billIds: paidIds, items,
    total: items.reduce((sum, item) => sum + item.amount, 0),
    method: String(method), status: 'paid', createdAt: now.toISOString()
  };
  paidIds.forEach((id) => { bills[id].status = 'paid'; bills[id].paidAt = now.toISOString(); });
  const paidSet = new Set(paidIds);
  transactions = transactions.filter((item) => !(item.status === 'pending' && item.billIds.some((id) => paidSet.has(id))));
  transactions.unshift(transaction);
  selectedBills.clear();
  closeDialog($('#payment-dialog'));
  $('#payment-form').reset();
  renderBillCards(); updateSummaryCards(); renderHistory();
  const saved = persistState();
  showToast(saved ? `Pembayaran pratinjau ${money(transaction.total)} berhasil dicatat.` : 'Pembayaran pratinjau tercatat sementara di halaman ini.');
  showReceipt(transaction.id);
});

/* ---------- Transaction history ---------- */
function getVisibleTransactions() {
  const query = $('#history-search').value.trim().toLocaleLowerCase('id-ID');
  return [...transactions]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((transaction) => {
      const statusMatches = activeFilter === 'all' || transaction.status === activeFilter;
      const searchable = [transaction.id, transaction.method, ...transaction.items.map((item) => item.name), formatDate(new Date(transaction.createdAt)), rupiah(transaction.total)]
        .join(' ').toLocaleLowerCase('id-ID');
      return statusMatches && searchable.includes(query);
    });
}

function createHistoryCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderHistory() {
  const body = $('#history-body');
  const visibleTransactions = getVisibleTransactions();
  body.replaceChildren();

  visibleTransactions.forEach((transaction) => {
    const row = document.createElement('tr');
    row.dataset.historyStatus = transaction.status;

    const idCell = document.createElement('td');
    const idText = document.createElement('span');
    idText.className = 'transaction-id';
    idText.textContent = transaction.id;
    idCell.append(idText);

    const serviceCell = document.createElement('td');
    const service = document.createElement('span');
    service.className = 'table-service';
    const icon = document.createElement('span');
    const firstItemId = transaction.items[0]?.id;
    icon.className = `table-service-icon ${firstItemId === 'internet' ? 'service-internet' : firstItemId === 'electricity' ? 'service-electric' : 'service-water'}`;
    icon.textContent = transaction.status === 'paid' ? '✓' : '•';
    const serviceText = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = transaction.items.length === 1 ? transaction.items[0].name : `${transaction.items.length} layanan`;
    const subtitle = document.createElement('small');
    subtitle.textContent = transaction.items.map((item) => item.name).join(', ');
    serviceText.append(title, subtitle);
    service.append(icon, serviceText);
    serviceCell.append(service);

    const dateCell = createHistoryCell(formatDate(new Date(transaction.createdAt)));
    const methodCell = createHistoryCell(transaction.method);
    const amountCell = createHistoryCell(money(transaction.total), 'table-amount');
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status ${transaction.status === 'paid' ? 'status-paid' : 'status-pending'}`;
    status.textContent = transaction.status === 'paid' ? 'Berhasil' : 'Menunggu';
    statusCell.append(status);

    const actionCell = document.createElement('td');
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'history-receipt-button';
    if (transaction.status === 'paid') {
      action.dataset.viewReceipt = transaction.id;
      action.textContent = 'Lihat bukti';
    } else {
      action.disabled = true;
      action.textContent = 'Belum lunas';
    }
    actionCell.append(action);
    row.append(idCell, serviceCell, dateCell, methodCell, amountCell, statusCell, actionCell);
    body.append(row);
  });

  $('#visible-count').textContent = visibleTransactions.length;
  $('#empty-state').hidden = visibleTransactions.length !== 0;
}

$('#history-search').addEventListener('input', renderHistory);
$$('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    $$('.filter-tab').forEach((item) => {
      const current = item === tab;
      item.classList.toggle('is-current', current);
      item.setAttribute('aria-pressed', String(current));
    });
    renderHistory();
  });
});
$('#history-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view-receipt]');
  if (button) showReceipt(button.dataset.viewReceipt);
});

/* ---------- Payment receipt / print to PDF ---------- */
function showReceipt(transactionId) {
  const transaction = transactions.find((item) => item.id === transactionId);
  if (!transaction || transaction.status !== 'paid') return;
  $('#receipt-number').textContent = transaction.id;
  $('#receipt-date').textContent = formatDateTime(new Date(transaction.createdAt));
  $('#receipt-method').textContent = transaction.method;
  $('#receipt-status').textContent = 'Berhasil · Simulasi';
  $('#receipt-total').textContent = money(transaction.total);
  const itemContainer = $('#receipt-items');
  itemContainer.replaceChildren();
  transaction.items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'receipt-item-row';
    const name = document.createElement('span');
    name.textContent = item.name;
    const amount = document.createElement('strong');
    amount.textContent = money(item.amount);
    row.append(name, amount);
    itemContainer.append(row);
  });
  openDialog($('#receipt-dialog'));
}
$('#print-receipt').addEventListener('click', () => window.print());

/* ---------- CSV export: exports the current search/filter result ---------- */
function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet formula injection: neutralize cells beginning with formula operators.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
$('#export-history').addEventListener('click', () => {
  const rows = getVisibleTransactions();
  if (!rows.length) {
    showToast('Tidak ada transaksi untuk diekspor.');
    return;
  }
  const header = ['ID Transaksi', 'Layanan', 'Tanggal', 'Metode', 'Nominal', 'Status'];
  const csvRows = rows.map((transaction) => [
    transaction.id,
    transaction.items.map((item) => item.name).join(' + '),
    formatDate(new Date(transaction.createdAt)),
    transaction.method,
    transaction.total,
    transaction.status === 'paid' ? 'Berhasil' : 'Menunggu'
  ]);
  const csv = '\uFEFF' + [header, ...csvRows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tagihanku-riwayat-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`${rows.length} transaksi diekspor ke CSV.`);
});


/* ---------- v1.5: analytics dashboard and financial reporting ---------- */
function getMonthKey(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonthKey(monthKey, offset) {
  const [year, month] = monthKey.split('-').map(Number);
  return getMonthKey(new Date(year, month - 1 + offset, 1));
}

function monthLabel(monthKey, style = 'long') {
  const [year, month] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { month: style, year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function getTransactionsForMonth(monthKey) {
  return transactions
    .filter((transaction) => getMonthKey(new Date(transaction.createdAt)) === monthKey)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function getAnalyticsMetrics(monthKey) {
  const currentMonth = getMonthKey(new Date());
  const monthTransactions = getTransactionsForMonth(monthKey);
  const paidTransactions = monthTransactions.filter((transaction) => transaction.status === 'paid');
  const pendingTransactions = monthTransactions.filter((transaction) => transaction.status === 'pending');
  const paidTotal = paidTransactions.reduce((sum, transaction) => sum + transaction.total, 0);
  const categoryTotals = { internet: 0, electricity: 0, water: 0 };
  let billedTotal = 0;
  let pendingTotal = 0;
  let pendingCount = 0;
  let billedCount = 0;

  if (monthKey === currentMonth) {
    Object.entries(bills).forEach(([id, bill]) => {
      billedTotal += bill.amount;
      billedCount += 1;
      categoryTotals[id] = (categoryTotals[id] || 0) + bill.amount;
      if (bill.status === 'pending') {
        pendingTotal += bill.amount;
        pendingCount += 1;
      }
    });
  } else {
    paidTransactions.forEach((transaction) => {
      transaction.items.forEach((item) => {
        billedTotal += item.amount;
        billedCount += 1;
        categoryTotals[item.id] = (categoryTotals[item.id] || 0) + item.amount;
      });
    });
    pendingTransactions.forEach((transaction) => {
      pendingTotal += transaction.total;
      pendingCount += transaction.items.length;
      transaction.items.forEach((item) => {
        categoryTotals[item.id] = (categoryTotals[item.id] || 0) + item.amount;
        billedTotal += item.amount;
        billedCount += 1;
      });
    });
  }

  return {
    monthKey,
    monthTransactions,
    paidTransactions,
    pendingTransactions,
    paidTotal,
    pendingTotal,
    billedTotal,
    billedCount,
    pendingCount,
    transactionCount: paidTransactions.length,
    categoryTotals
  };
}

let analyticsMonthKey = getMonthKey(new Date());

function renderAnalytics() {
  const monthInput = $('#analytics-month');
  if (!monthInput) return;
  if (!monthInput.value) monthInput.value = analyticsMonthKey;
  const selected = monthInput.value;
  if (!/^\d{4}-\d{2}$/.test(selected)) return;
  analyticsMonthKey = selected;
  const metrics = getAnalyticsMetrics(analyticsMonthKey);
  const currentMonth = getMonthKey(new Date());
  const isCurrentMonth = analyticsMonthKey === currentMonth;
  const paidLabel = `${metrics.transactionCount} transaksi berhasil`;

  $('#analytics-total-billed').textContent = money(metrics.billedTotal);
  $('#analytics-billed-caption').textContent = isCurrentMonth
    ? `${metrics.billedCount} layanan pada periode ini`
    : `${metrics.billedCount} rincian layanan tercatat`;
  $('#analytics-total-paid').textContent = money(metrics.paidTotal);
  $('#analytics-paid-caption').textContent = paidLabel;
  $('#analytics-total-pending').textContent = money(metrics.pendingTotal);
  $('#analytics-pending-caption').textContent = `${metrics.pendingCount} layanan menunggu`;
  $('#analytics-transaction-count').textContent = rupiah(metrics.transactionCount);

  renderAnalyticsTrend(analyticsMonthKey, metrics.paidTotal);
  renderAnalyticsCategories(metrics, isCurrentMonth);
  renderAnalyticsComparison(analyticsMonthKey, metrics.paidTotal);
  renderAnalyticsInsight(metrics, isCurrentMonth);
  renderAnalyticsReport(metrics);
}

function renderAnalyticsTrend(monthKey, selectedMonthTotal) {
  const chart = $('#analytics-month-chart');
  const monthKeys = Array.from({ length: 6 }, (_, index) => shiftMonthKey(monthKey, index - 5));
  const values = monthKeys.map((key) => ({ key, total: getTransactionsForMonth(key)
    .filter((transaction) => transaction.status === 'paid')
    .reduce((sum, transaction) => sum + transaction.total, 0) }));
  const maxValue = Math.max(1, ...values.map((item) => item.total));
  chart.replaceChildren();
  values.forEach((item) => {
    const column = document.createElement('div');
    column.className = `analytics-bar-column${item.key === monthKey ? ' is-selected' : ''}`;
    column.setAttribute('aria-label', `${monthLabel(item.key)}: ${money(item.total)} dibayarkan`);
    const value = document.createElement('span');
    value.className = 'analytics-bar-value';
    value.textContent = item.total ? money(item.total) : '—';
    const track = document.createElement('div');
    track.className = 'analytics-bar-track';
    const fill = document.createElement('span');
    fill.className = 'analytics-bar-fill';
    fill.style.height = item.total ? `${Math.max(7, (item.total / maxValue) * 100)}%` : '3px';
    track.append(fill);
    const month = document.createElement('small');
    const [year, monthNumber] = item.key.split('-').map(Number);
    month.textContent = new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(new Date(year, monthNumber - 1, 1));
    column.append(value, track, month);
    chart.append(column);
  });
  $('#analytics-trend-total').textContent = money(selectedMonthTotal);
  $('#analytics-trend-caption').textContent = `Pembayaran berhasil · ${monthLabel(monthKey)}`;
  const hasPrevious = values.some((item) => item.total > 0 && item.key !== monthKey);
  $('#analytics-chart-note').textContent = hasPrevious
    ? 'Grafik memakai transaksi dengan status berhasil. Periode tanpa transaksi ditampilkan nol.'
    : 'Belum ada riwayat pembayaran pada lima bulan sebelumnya. Grafik akan terisi saat transaksi demo tercatat.';
  chart.setAttribute('aria-label', `Grafik pembayaran enam bulan hingga ${monthLabel(monthKey)}. Total bulan terpilih ${money(selectedMonthTotal)}.`);
}

function renderAnalyticsCategories(metrics, isCurrentMonth) {
  const categoryList = $('#analytics-category-list');
  const definitions = [
    { id: 'internet', label: 'Internet', tone: 'purple' },
    { id: 'electricity', label: 'Listrik', tone: 'orange' },
    { id: 'water', label: 'Air PDAM', tone: 'blue' }
  ];
  const entries = definitions.map((item) => ({ ...item, total: metrics.categoryTotals[item.id] || 0 }));
  const total = entries.reduce((sum, item) => sum + item.total, 0);
  $('#analytics-category-total').textContent = money(total);
  $('#analytics-category-caption').textContent = isCurrentMonth ? 'Total tagihan periode ini' : 'Total rincian pada periode ini';
  categoryList.replaceChildren();
  if (!total) {
    const empty = document.createElement('p');
    empty.className = 'analytics-empty-inline';
    empty.textContent = 'Belum ada rincian kategori pada periode ini.';
    categoryList.append(empty);
  } else {
    entries.filter((item) => item.total > 0).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'analytics-category-row';
      const top = document.createElement('div');
      top.className = 'analytics-category-row-top';
      const name = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = `analytics-category-dot ${item.tone}`;
      dot.setAttribute('aria-hidden', 'true');
      name.append(dot, document.createTextNode(item.label));
      name.append(document.createTextNode(item.label));
      const amount = document.createElement('strong');
      amount.textContent = money(item.total);
      top.append(name, amount);
      const track = document.createElement('div');
      track.className = 'analytics-category-track';
      const fill = document.createElement('span');
      fill.className = `analytics-category-fill ${item.tone}`;
      const share = (item.total / total) * 100;
      fill.style.width = `${share.toFixed(2)}%`;
      track.append(fill);
      const meta = document.createElement('small');
      meta.textContent = `${share.toLocaleString('id-ID', { maximumFractionDigits: 1 })}% dari total kategori`;
      row.append(top, track, meta);
      categoryList.append(row);
    });
  }
  $('#analytics-category-note').textContent = isCurrentMonth
    ? 'Komposisi menunjukkan seluruh tagihan bulan berjalan, baik yang sudah lunas maupun menunggu.'
    : 'Komposisi dihitung dari rincian transaksi yang tercatat pada periode terpilih.';
}

function renderAnalyticsComparison(monthKey, currentPaid) {
  const previousKey = shiftMonthKey(monthKey, -1);
  const previousPaid = getTransactionsForMonth(previousKey)
    .filter((transaction) => transaction.status === 'paid')
    .reduce((sum, transaction) => sum + transaction.total, 0);
  const deltaNode = $('#analytics-compare-delta');
  const statusNode = $('#analytics-compare-status');
  const descriptionNode = $('#analytics-compare-description');
  if (!previousPaid) {
    deltaNode.textContent = '—';
    statusNode.textContent = 'Belum ada data bulan sebelumnya.';
    descriptionNode.textContent = `Belum ada transaksi berhasil untuk ${monthLabel(previousKey)}. Perbandingan akan tersedia setelah data periode tersebut tercatat.`;
    return;
  }
  const difference = currentPaid - previousPaid;
  const percentage = (Math.abs(difference) / previousPaid) * 100;
  deltaNode.textContent = `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${percentage.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`;
  deltaNode.classList.toggle('is-increase', difference > 0);
  deltaNode.classList.toggle('is-decrease', difference < 0);
  statusNode.textContent = difference > 0 ? 'Pembayaran lebih tinggi' : difference < 0 ? 'Pembayaran lebih rendah' : 'Sama dengan bulan sebelumnya';
  descriptionNode.textContent = `${money(currentPaid)} pada ${monthLabel(monthKey)} dibanding ${money(previousPaid)} pada ${monthLabel(previousKey)}.`;
}

function renderAnalyticsInsight(metrics, isCurrentMonth) {
  const pending = isCurrentMonth
    ? Object.entries(bills).filter(([, bill]) => bill.status === 'pending').map(([id, bill]) => ({ id, ...bill }))
    : metrics.pendingTransactions.flatMap((transaction) => transaction.items.map((item) => ({ ...item, dueISO: null })));
  const categories = Object.entries(metrics.categoryTotals).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const largest = categories[0];
  let insight = '';
  let tag = 'Analisis lokal';
  if (isCurrentMonth && pending.length) {
    const overdue = pending.filter((bill) => bill.dueISO && daysUntilDue(bill) < 0);
    const nextDue = [...pending].filter((bill) => bill.dueISO).sort((a, b) => a.dueISO.localeCompare(b.dueISO))[0];
    if (overdue.length) {
      insight = `${overdue.length} tagihan melewati tanggal jatuh tempo. Prioritaskan ${overdue[0].name} sebesar ${money(overdue[0].amount)}. Periksa rincian sebelum melakukan pembayaran demo.`;
      tag = 'Perlu perhatian';
    } else if (nextDue) {
      insight = `${pending.length} layanan masih menunggu pembayaran. Jadwal terdekat adalah ${nextDue.name} pada ${formatDate(fromISODate(nextDue.dueISO))}. Siapkan ${money(nextDue.amount)} agar tidak terlambat.`;
      tag = 'Rencana pembayaran';
    }
  } else if (!metrics.paidTotal && !metrics.billedTotal) {
    insight = 'Belum ada data tagihan atau pembayaran pada periode ini. Pilih bulan lain atau catat transaksi demo untuk mulai melihat pola pengeluaran.';
    tag = 'Belum ada data';
  } else if (!pending.length) {
    insight = 'Tidak ada tagihan yang menunggu pada periode ini. Semua tagihan demo yang tercatat telah dibayarkan atau tidak memiliki saldo tertunda.';
    tag = 'Terkendali';
  } else {
    insight = `Terdapat ${metrics.pendingCount} rincian menunggu dengan total ${money(metrics.pendingTotal)} pada periode ini.`;
  }
  if (largest) insight += ` Kategori terbesar adalah ${largest[0] === 'internet' ? 'Internet' : largest[0] === 'electricity' ? 'Listrik' : 'Air PDAM'} (${money(largest[1])}).`;
  $('#analytics-insight-text').textContent = insight;
  $('#analytics-insight-tag').textContent = tag;
}

function renderAnalyticsReport(metrics) {
  const body = $('#analytics-report-body');
  body.replaceChildren();
  metrics.monthTransactions.forEach((transaction) => {
    const row = document.createElement('tr');
    const values = [
      formatDate(new Date(transaction.createdAt)),
      transaction.id,
      transaction.items.map((item) => item.name).join(' + '),
      transaction.method,
      transaction.status === 'paid' ? 'Berhasil' : 'Menunggu',
      money(transaction.total)
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 5) cell.className = 'analytics-report-amount';
      if (index === 4) {
        const status = document.createElement('span');
        status.className = `analytics-report-status ${transaction.status === 'paid' ? 'is-paid' : 'is-pending'}`;
        status.textContent = value;
        cell.replaceChildren(status);
      }
      row.append(cell);
    });
    body.append(row);
  });
  $('#analytics-report-period').textContent = `Periode: ${monthLabel(metrics.monthKey)}`;
  $('#analytics-report-empty').hidden = metrics.monthTransactions.length > 0;
  $('#analytics-report-count').textContent = `${metrics.monthTransactions.length} transaksi ditampilkan`;
  $('#analytics-report-total').textContent = `Total berhasil: ${money(metrics.paidTotal)}`;
}

function exportAnalyticsCsv() {
  const metrics = getAnalyticsMetrics(analyticsMonthKey);
  const rows = [
    ['TagihanKu — Laporan Keuangan Demo'],
    ['Periode', monthLabel(analyticsMonthKey)],
    ['Total tagihan tercatat', metrics.billedTotal],
    ['Total sudah dibayar', metrics.paidTotal],
    ['Total belum dibayar', metrics.pendingTotal],
    [],
    ['Tanggal', 'ID Transaksi', 'Layanan', 'Metode', 'Status', 'Nominal']
  ];
  metrics.monthTransactions.forEach((transaction) => rows.push([
    formatDate(new Date(transaction.createdAt)),
    transaction.id,
    transaction.items.map((item) => item.name).join(' + '),
    transaction.method,
    transaction.status === 'paid' ? 'Berhasil' : 'Menunggu',
    transaction.total
  ]));
  const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tagihanku-laporan-${analyticsMonthKey}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Laporan ${monthLabel(analyticsMonthKey)} berhasil diekspor.`);
}

$('#analytics-month').addEventListener('change', renderAnalytics);
$('#analytics-current-month').addEventListener('click', () => {
  analyticsMonthKey = getMonthKey(new Date());
  $('#analytics-month').value = analyticsMonthKey;
  renderAnalytics();
});
$('#analytics-export').addEventListener('click', exportAnalyticsCsv);
$('#analytics-print').addEventListener('click', () => {
  document.body.classList.add('print-analytics');
  window.print();
});
window.addEventListener('afterprint', () => document.body.classList.remove('print-analytics'));

/* ---------- Dashboard summary ---------- */
function updateSummaryCards() {
  const entries = Object.values(bills);
  const total = entries.reduce((sum, bill) => sum + bill.amount, 0);
  const paidEntries = entries.filter((bill) => bill.status === 'paid');
  const pendingEntries = entries.filter((bill) => bill.status === 'pending');
  const paid = paidEntries.reduce((sum, bill) => sum + bill.amount, 0);
  const pending = total - paid;
  const values = [total, paid, pending];

  $$('.stats-section [data-count]').forEach((node, index) => {
    node.dataset.count = values[index];
    node.textContent = rupiah(values[index]);
  });
  const heroTotal = $('.hero-visual [data-count]');
  heroTotal.dataset.count = total;
  heroTotal.textContent = rupiah(total);
  $('#paid-caption').textContent = `● ${paidEntries.length} tagihan lunas`;
  $('#pending-caption').textContent = `● ${pendingEntries.length} tagihan belum dibayar`;
  const paidProgress = total > 0 ? (paid / total) * 100 : 0;
  $('#payment-progress-label').textContent = `${paidProgress.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`;
  $('#payment-progress-bar').style.width = `${paidProgress.toFixed(2)}%`;
  $('#payment-progress-note').textContent = `${paidEntries.length} dari ${entries.length} layanan sudah lunas`;
  updateSpendingBreakdown(total);
  updateBillFilters();
  updateDueCountdowns();
  updateAssistantOverview();
  renderCalendar();
  renderAnalytics();
  syncReminderNotifications();
}

/* ---------- Smart due-date countdown ---------- */
function updateDueCountdowns() {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const oneDay = 24 * 60 * 60 * 1000;

  $$('[data-due-id]').forEach((item) => {
    const id = item.dataset.dueId;
    const bill = bills[id];
    const output = $('[data-due-countdown]', item);
    if (!bill || !output) return;
    output.classList.remove('is-today', 'is-overdue', 'is-paid');
    if (bill.status === 'paid') {
      output.textContent = 'Sudah dibayar';
      output.classList.add('is-paid');
      item.setAttribute('aria-label', `${bill.name}, sudah dibayar`);
      return;
    }
    const [year, month, day] = bill.dueISO.split('-').map(Number);
    const dueDate = new Date(year, month - 1, day);
    const daysLeft = Math.round((dueDate - todayStart) / oneDay);
    if (daysLeft < 0) {
      output.textContent = `Terlambat ${Math.abs(daysLeft)} hari`;
      output.classList.add('is-overdue');
    } else if (daysLeft === 0) {
      output.textContent = 'Jatuh tempo hari ini';
      output.classList.add('is-today');
    } else if (daysLeft === 1) {
      output.textContent = 'Besok';
    } else {
      output.textContent = `${daysLeft} hari lagi`;
    }
    item.setAttribute('aria-label', `${bill.name}, ${output.textContent}`);
  });
}

/* ---------- Spending breakdown ---------- */
function updateSpendingBreakdown(total = Object.values(bills).reduce((sum, bill) => sum + bill.amount, 0)) {
  $('#spending-total').textContent = money(total);
  $$('.spending-row').forEach((row) => {
    const bill = bills[row.dataset.spendingId];
    if (!bill) return;
    const percentage = total > 0 ? (bill.amount / total) * 100 : 0;
    $('.spending-label strong', row).textContent = money(bill.amount);
    $('.spending-fill', row).style.width = `${percentage.toFixed(2)}%`;
    row.setAttribute('aria-label', `${bill.name}: ${rupiah(bill.amount)} rupiah, ${percentage.toFixed(1)} persen`);
  });
}

/* ---------- Bill status filters ---------- */
function updateBillFilters() {
  const counts = {
    all: Object.keys(bills).length,
    pending: Object.values(bills).filter((bill) => bill.status === 'pending').length,
    paid: Object.values(bills).filter((bill) => bill.status === 'paid').length
  };
  $$('[data-bill-filter]').forEach((button) => {
    const filter = button.dataset.billFilter;
    const count = $('span', button);
    if (count) count.textContent = counts[filter] ?? 0;
    const active = filter === activeBillFilter;
    button.classList.toggle('is-current', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $$('.bill-card').forEach((card) => {
    const visible = activeBillFilter === 'all' || card.dataset.status === activeBillFilter;
    card.hidden = !visible;
  });
}
$$('[data-bill-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    activeBillFilter = button.dataset.billFilter;
    updateBillFilters();
  });
});

/* ---------- Restore demo to its original state ---------- */
$('#reset-demo').addEventListener('click', () => {
  const confirmed = window.confirm('Kembalikan tagihan dan riwayat ke data demo awal? Perubahan lokal akan dihapus.');
  if (!confirmed) return;
  Object.keys(DEFAULT_BILLS).forEach((id) => {
    bills[id].status = DEFAULT_BILLS[id].status;
    bills[id].paidAt = DEFAULT_BILLS[id].paidAt;
  });
  transactions = createDefaultTransactions();
  notifications = [];
  reminderLedger = [];
  persistNotifications();
  persistReminderLedger();
  renderNotificationCenter();
  selectedBills.clear();
  activeFilter = 'all';
  activeBillFilter = 'all';
  $('#history-search').value = '';
  $$('.filter-tab').forEach((tab) => {
    const active = tab.dataset.filter === 'all';
    tab.classList.toggle('is-current', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  renderBillCards();
  updateSummaryCards();
  renderHistory();
  persistState();
  showToast('Data demo berhasil dikembalikan ke kondisi awal.');
});

/* ---------- v1.3: calendar helpers and interactive monthly calendar ---------- */
const calendarCursor = new Date();
calendarCursor.setDate(1);
let selectedCalendarISO = toISODate(new Date());

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fromISODate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function getBillsForDate(isoDate) {
  return Object.entries(bills)
    .filter(([, bill]) => bill.dueISO === isoDate)
    .map(([id, bill]) => ({ id, ...bill }));
}

function renderCalendar() {
  const grid = $('#calendar-grid');
  if (!grid) return;

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $('#calendar-month-label').textContent = new Intl.DateTimeFormat('id-ID', {
    month: 'long', year: 'numeric'
  }).format(calendarCursor);

  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const todayISO = toISODate(new Date());
  grid.replaceChildren();
  let currentWeek = null;

  for (let index = 0; index < cellCount; index += 1) {
    if (index % 7 === 0) {
      currentWeek = document.createElement('div');
      currentWeek.className = 'calendar-week-row';
      currentWeek.setAttribute('role', 'row');
      grid.append(currentWeek);
    }
    const dayNumber = index - mondayOffset + 1;
    const inMonth = dayNumber >= 1 && dayNumber <= daysInMonth;
    const cellDate = new Date(year, month, dayNumber);
    const isoDate = toISODate(cellDate);
    const dayBills = inMonth ? getBillsForDate(isoDate) : [];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.setAttribute('role', 'gridcell');
    button.disabled = !inMonth;
    button.textContent = String(cellDate.getDate());

    if (!inMonth) button.classList.add('is-outside');
    if (isoDate === todayISO && inMonth) {
      button.classList.add('is-today');
      button.setAttribute('aria-current', 'date');
    }
    if (inMonth) button.setAttribute('aria-selected', String(isoDate === selectedCalendarISO));
    if (isoDate === selectedCalendarISO && inMonth) button.classList.add('is-selected');
    if (dayBills.length) {
      const hasPending = dayBills.some((bill) => bill.status === 'pending');
      const hasPaid = dayBills.some((bill) => bill.status === 'paid');
      button.classList.add('has-events');
      if (hasPending) button.classList.add('has-pending');
      if (hasPaid && !hasPending) button.classList.add('has-paid');
      button.setAttribute('aria-label', `${formatDate(cellDate)}: ${dayBills.map((bill) => `${bill.name}, ${bill.status === 'paid' ? 'lunas' : 'belum dibayar'}`).join('; ')}`);
      const marker = document.createElement('span');
      marker.className = 'calendar-day-markers';
      marker.setAttribute('aria-hidden', 'true');
      dayBills.slice(0, 3).forEach((bill) => {
        const dot = document.createElement('i');
        dot.className = bill.status === 'paid' ? 'is-paid' : 'is-pending';
        marker.append(dot);
      });
      button.append(marker);
    } else {
      button.setAttribute('aria-label', formatDate(cellDate));
    }

    if (inMonth) button.dataset.calendarDate = isoDate;
    if (currentWeek) currentWeek.append(button);
  }
  renderCalendarDetails();
}

function renderCalendarDetails() {
  const selectedDate = fromISODate(selectedCalendarISO);
  $('#calendar-selected-label').textContent = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(selectedDate);
  const dayBills = getBillsForDate(selectedCalendarISO);
  $('#calendar-event-count').textContent = `${dayBills.length} tagihan`;
  const list = $('#calendar-events-list');
  list.replaceChildren();

  if (!dayBills.length) {
    const empty = document.createElement('p');
    empty.className = 'calendar-empty';
    empty.textContent = 'Tidak ada tagihan jatuh tempo pada tanggal ini. Kamu bisa menikmati hari dengan lebih tenang.';
    list.append(empty);
    return;
  }

  dayBills.forEach((bill) => {
    const row = document.createElement('div');
    row.className = 'calendar-event-row';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = bill.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = bill.status === 'paid' ? 'Sudah dibayar' : 'Perlu diselesaikan';
    copy.append(title, subtitle);
    const trailing = document.createElement('div');
    trailing.className = 'calendar-event-trailing';
    const amount = document.createElement('strong');
    amount.textContent = money(bill.amount);
    const status = document.createElement('span');
    status.className = `calendar-event-status ${bill.status === 'paid' ? 'is-paid' : 'is-pending'}`;
    status.textContent = bill.status === 'paid' ? 'Lunas' : 'Menunggu';
    trailing.append(amount, status);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'calendar-event-jump';
    action.dataset.jumpBill = bill.id;
    action.textContent = 'Lihat';
    action.setAttribute('aria-label', `Lihat tagihan ${bill.name}`);
    row.append(copy, trailing, action);
    list.append(row);
  });
}

$('#calendar-grid').addEventListener('click', (event) => {
  const day = event.target.closest('[data-calendar-date]');
  if (!day) return;
  selectedCalendarISO = day.dataset.calendarDate;
  renderCalendar();
});

$('#calendar-prev').addEventListener('click', () => {
  calendarCursor.setMonth(calendarCursor.getMonth() - 1);
  selectedCalendarISO = toISODate(new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1));
  renderCalendar();
});

$('#calendar-next').addEventListener('click', () => {
  calendarCursor.setMonth(calendarCursor.getMonth() + 1);
  selectedCalendarISO = toISODate(new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1));
  renderCalendar();
});

$('#calendar-today').addEventListener('click', () => {
  const today = new Date();
  calendarCursor.setFullYear(today.getFullYear(), today.getMonth(), 1);
  selectedCalendarISO = toISODate(today);
  renderCalendar();
});

$('#calendar-events-list').addEventListener('click', (event) => {
  const action = event.target.closest('[data-jump-bill]');
  if (!action) return;
  const card = $(`[data-bill-id="${action.dataset.jumpBill}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.setAttribute('tabindex', '-1');
  card.focus({ preventScroll: true });
  card.classList.add('calendar-highlight');
  window.setTimeout(() => card.classList.remove('calendar-highlight'), 1800);
});

/* ---------- v1.3: local rule-based Smart Assistant ---------- */
function getPendingBillEntries() {
  return Object.entries(bills)
    .filter(([, bill]) => bill.status === 'pending')
    .map(([id, bill]) => ({ id, ...bill }))
    .sort((a, b) => a.dueISO.localeCompare(b.dueISO));
}

function daysUntilDue(bill, reference = new Date()) {
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const due = fromISODate(bill.dueISO);
  return Math.round((due - today) / (24 * 60 * 60 * 1000));
}

function updateAssistantOverview() {
  const pending = getPendingBillEntries();
  const pendingTotal = pending.reduce((sum, bill) => sum + bill.amount, 0);
  $('#assistant-pending-total').textContent = money(pendingTotal);
  $('#assistant-pending-count').textContent = `${pending.length} ${pending.length === 1 ? 'layanan' : 'layanan'}`;
  const title = $('#assistant-priority-title');
  const description = $('#assistant-priority-description');
  const priorityBox = $('#assistant-priority');
  priorityBox.classList.remove('is-urgent', 'is-clear');

  if (!pending.length) {
    title.textContent = 'Semua tagihan sudah lunas';
    description.textContent = 'Tidak ada tagihan demo yang menunggu pembayaran. Kamu bisa melihat kembali riwayat transaksi.';
    priorityBox.classList.add('is-clear');
    return;
  }

  const priority = pending[0];
  const days = daysUntilDue(priority);
  title.textContent = priority.name;
  if (days < 0) {
    description.textContent = `Sudah terlambat ${Math.abs(days)} hari. Jadikan tagihan ini prioritas pertama.`;
    priorityBox.classList.add('is-urgent');
  } else if (days === 0) {
    description.textContent = 'Jatuh tempo hari ini. Sebaiknya selesaikan sekarang agar tidak terlambat.';
    priorityBox.classList.add('is-urgent');
  } else if (days === 1) {
    description.textContent = 'Jatuh tempo besok. Siapkan pembayaran agar tidak terlewat.';
  } else {
    description.textContent = `Jatuh tempo ${formatDate(fromISODate(priority.dueISO))}, sekitar ${days} hari lagi. Siapkan pembayaran lebih awal.`;
  }
}

function answerAssistant(question) {
  const query = question.toLocaleLowerCase('id-ID').trim();
  const pending = getPendingBillEntries();
  const pendingTotal = pending.reduce((sum, bill) => sum + bill.amount, 0);
  const overdue = pending.filter((bill) => daysUntilDue(bill) < 0);
  let answer;

  if (/terlambat|telat|lewat|menunggak|overdue/.test(query)) {
    answer = overdue.length
      ? `Ada ${overdue.length} tagihan yang terlambat: ${overdue.map((bill) => `${bill.name} (${Math.abs(daysUntilDue(bill))} hari, ${money(bill.amount)})`).join('; ')}. Prioritaskan tagihan dengan tanggal jatuh tempo paling lama.`
      : 'Tidak ada tagihan demo yang terlambat saat ini. Tetap periksa jadwal agar pembayaran berikutnya tidak terlewat.';
  } else if (/minggu|7 hari|dekat|segera|jatuh tempo|tempo/.test(query)) {
    const dueSoon = pending.filter((bill) => daysUntilDue(bill) >= 0 && daysUntilDue(bill) <= 7);
    if (dueSoon.length) {
      answer = `Dalam 7 hari ke depan, ${dueSoon.length} tagihan perlu diperhatikan: ${dueSoon.map((bill) => `${bill.name} pada ${formatDate(fromISODate(bill.dueISO))} (${money(bill.amount)})`).join('; ')}.`;
    } else if (pending.length) {
      const next = pending[0];
      answer = `Tidak ada tagihan dalam 7 hari ke depan. Jadwal berikutnya adalah ${next.name} pada ${formatDate(fromISODate(next.dueISO))}.`;
    } else {
      answer = 'Semua tagihan demo sudah lunas. Tidak ada jadwal pembayaran yang menunggu.';
    }
  } else if (/internet|fiber|listrik|pdam|air/.test(query)) {
    const matched = pending.concat(Object.entries(bills).filter(([, bill]) => bill.status === 'paid').map(([id, bill]) => ({ id, ...bill })))
      .filter((bill) => {
        const terms = bill.id === 'internet' ? /internet|fiber/.test(query)
          : bill.id === 'electricity' ? /listrik/.test(query)
            : /pdam|air/.test(query);
        return terms;
      });
    answer = matched.length
      ? matched.map((bill) => `${bill.name}: ${money(bill.amount)}, status ${bill.status === 'paid' ? 'lunas' : 'belum dibayar'}, jatuh tempo ${formatDate(fromISODate(bill.dueISO))}.`).join(' ')
      : 'Aku belum menemukan layanan yang cocok dengan pertanyaan itu.';
  } else if (/total|berapa|nominal|jumlah|semua tagihan/.test(query)) {
    answer = pending.length
      ? `Total tagihan yang belum dibayar adalah ${money(pendingTotal)} untuk ${pending.length} layanan: ${pending.map((bill) => `${bill.name} ${money(bill.amount)}`).join(', ')}.`
      : 'Total tagihan yang belum dibayar adalah Rp 0. Semua layanan demo sudah lunas.';
  } else if (/prioritas|dulu|saran|bayar yang|mulai/.test(query)) {
    if (!pending.length) answer = 'Semua tagihan demo sudah lunas. Belum ada pembayaran yang perlu diprioritaskan.';
    else {
      const priority = pending[0];
      const days = daysUntilDue(priority);
      answer = `Prioritaskan ${priority.name} (${money(priority.amount)}). ${days < 0 ? `Tagihan ini terlambat ${Math.abs(days)} hari.` : days === 0 ? 'Tagihan ini jatuh tempo hari ini.' : `Jatuh tempo ${formatDate(fromISODate(priority.dueISO))}, ${days} hari lagi.`} Setelah itu, periksa tagihan lain yang masih menunggu.`;
    }
  } else {
    answer = `Saat ini ada ${pending.length} tagihan yang belum dibayar dengan total ${money(pendingTotal)}. Kamu bisa bertanya tentang total tagihan, tanggal jatuh tempo, layanan tertentu, atau tagihan yang terlambat.`;
  }

  $('#assistant-answer').classList.remove('is-updated');
  $('#assistant-answer').querySelector('p').textContent = answer;
  requestAnimationFrame(() => $('#assistant-answer').classList.add('is-updated'));
}

$('#assistant-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#assistant-question');
  const question = input.value.trim();
  if (!question) {
    input.focus();
    return;
  }
  answerAssistant(question);
  input.value = '';
});

$$('[data-ask]').forEach((button) => {
  button.addEventListener('click', () => answerAssistant(button.dataset.ask));
});

/* ---------- Animated count-up and scroll reveal ---------- */
function animateCount(node) {
  if (node.dataset.animated === 'true') return;
  node.dataset.animated = 'true';
  const target = Number(node.dataset.count || 0);
  const duration = 1100;
  const start = performance.now();
  const frame = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    node.textContent = rupiah(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        $$('[data-count]', entry.target).forEach(animateCount);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -35px 0px' })
  : null;

if (revealObserver) {
  $$('.reveal').forEach((element) => revealObserver.observe(element));
  $$('[data-count]').forEach((node) => {
    if (!node.closest('.reveal')) animateCount(node);
  });
} else {
  $$('.reveal').forEach((element) => element.classList.add('is-visible'));
  $$('[data-count]').forEach(animateCount);
}

/* ---------- Active navigation based on visible section ---------- */
const navSections = ['beranda', 'tagihan', 'analitik', 'notifikasi', 'jadwal', 'kalender', 'asisten', 'riwayat', 'preferensi', 'bantuan'].map((id) => document.getElementById(id));
if ('IntersectionObserver' in window) {
  const navObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      $$('.nav-link').forEach((link) => {
        const active = link.getAttribute('href') === `#${entry.target.id}`;
        link.classList.toggle('is-active', active);
      });
    });
  }, { rootMargin: '-35% 0px -55% 0px' });
  navSections.forEach((section) => { if (section) navObserver.observe(section); });
}

// Render data pertama kali agar seluruh komponen memakai sumber data yang sama.
renderProfileSummary();
renderBillCards();
updateSummaryCards();
renderHistory();
renderNotificationCenter();
updateReminderSettingsUI();
// Migrasikan data, preferensi, dan pengingat ke key v1.6 tanpa menghapus riwayat lokal.
persistState();
persistUserPreferences();
persistNotifications();
persistReminderLedger();
syncReminderNotifications();
// Pulihkan sesi server setelah UI dasar siap. Data akun tidak pernah dicampur ke penyimpanan demo.
restoreBackendAccount();
window.setInterval(() => {
  updateDueCountdowns();
  syncReminderNotifications();
}, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncReminderNotifications();
});
window.addEventListener('focus', syncReminderNotifications);


/* ---------- PWA v1.8: offline app shell, installation, and connection status ---------- */
let deferredInstallPrompt = null;
let activeServiceWorkerRegistration = null;

function renderConnectionStatus() {
  const label = $('#network-status-label');
  if (!label) return;
  const online = navigator.onLine !== false;
  label.textContent = online ? 'Terhubung' : 'Offline — mode lokal';
  label.dataset.state = online ? 'online' : 'offline';
}

function renderPwaStatus(message) {
  const label = $('#pwa-status-label');
  if (label && message) label.textContent = message;
}

async function registerPwaServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    renderPwaStatus('Browser ini belum mendukung service worker.');
    return;
  }
  if (!window.isSecureContext) {
    renderPwaStatus('Buka melalui HTTPS atau localhost untuk mengaktifkan offline.');
    return;
  }
  try {
    activeServiceWorkerRegistration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    await navigator.serviceWorker.ready;
    renderPwaStatus('Offline support aktif pada perangkat ini.');
    if (activeServiceWorkerRegistration.waiting) {
      renderPwaStatus('Pembaruan siap diterapkan saat halaman dimuat ulang.');
    }
  } catch (error) {
    renderPwaStatus('Offline support belum aktif. Periksa izin dan koneksi situs.');
  }
}

window.addEventListener('online', renderConnectionStatus);
window.addEventListener('offline', renderConnectionStatus);
renderConnectionStatus();
registerPwaServiceWorker();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const installButton = $('#install-app-button');
  installButton.hidden = false;
  installButton.disabled = false;
  renderPwaStatus('TagihanKu siap dipasang sebagai aplikasi.');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('#install-app-button').hidden = true;
  renderPwaStatus('TagihanKu sudah terpasang pada perangkat ini.');
  showToast('TagihanKu berhasil dipasang.');
});

$('#install-app-button').addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    showToast('Gunakan menu browser: Install app atau Add to Home Screen.');
    return;
  }
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  if (result && result.outcome === 'accepted') {
    renderPwaStatus('Permintaan pemasangan diterima.');
  } else {
    renderPwaStatus('Pemasangan belum dilakukan. Kamu dapat mencoba lagi nanti.');
  }
  deferredInstallPrompt = null;
  $('#install-app-button').hidden = true;
});

$('#check-app-update').addEventListener('click', async () => {
  if (!activeServiceWorkerRegistration) {
    showToast('Pembaruan PWA tersedia saat situs dibuka melalui HTTPS atau localhost.');
    return;
  }
  try {
    await activeServiceWorkerRegistration.update();
    showToast('Pemeriksaan pembaruan selesai.');
  } catch (error) {
    showToast('Pembaruan belum dapat diperiksa.');
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    renderPwaStatus('Versi offline terbaru sudah aktif.');
  });
}
