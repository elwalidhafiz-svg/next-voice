// نيكست الصوتي — مكالمة حية مع Gemini Live، تقرأ من الـ Vault (عبر GitHub) وتكتب في Inbox/ فقط.
import {
  GoogleGenAI,
  Modality,
  FunctionResponseScheduling,
} from 'https://cdn.jsdelivr.net/npm/@google/genai@2.27.0/+esm';

const MODEL = 'gemini-3.8-live';
// سعر Gemini 3.8 Live المدفوع (ai.google.dev/gemini-api/docs/pricing، 2026-10): 0.005$/د إدخال صوت + 0.018$/د إخراج صوت
const COST_IN_PER_MIN = 0.005;
const COST_OUT_PER_MIN = 0.018;
const VOICES = [
  ['Orus', 'Orus — رجالي ثابت'],
  ['Charon', 'Charon — رجالي هادئ'],
  ['Puck', 'Puck — رجالي حيوي'],
  ['Fenrir', 'Fenrir — رجالي متحمس'],
  ['Kore', 'Kore — نسائي ثابت'],
  ['Aoede', 'Aoede — نسائي خفيف'],
  ['Leda', 'Leda — نسائي شاب'],
  ['Zephyr', 'Zephyr — نسائي مشرق'],
];
// Pending Approvals وToday Board: نسختان تلقائيتان من سكربت الماك (اعتمادات الشيتين، ولوحة اليوم من Open Loops وواتساب)
const CORE_FILES = ['_System/Voice Assistant.md', '_System/identity.md', '_System/soul.md', '_System/user.md', '_System/Pending Approvals.md', '_System/Today Board.md'];
const OPEN_LOOPS = '_System/Open Loops.md';
// وضع العرض: التطبيق قد يُعرض على الناس، فعند كل فتح (وبعد كل قفل) تُخفى المبالغ، وتبويب «الفرص» وبنود البحث عن فرص، وسطر التكلفة.
// زر العين في رأس اللوحة يكشفها لهذه الجلسة فقط (لا يُحفظ). moneyShown = true معناه «مكشوف».
let moneyShown = false;

// ---------- تخزين محلي دائم ----------
// iOS قد يمسح localStorage أو يمنعه، فتُحفظ الإعدادات في ثلاثة أماكن وتُستعاد من أيها بقي:
// localStorage و IndexedDB و Cache Storage. الذاكرة هي المصدر أثناء التشغيل.
const memory = new Map();
const LS_PREFIX = 'nv.';
const storage = { ls: false, idb: false, cache: false, persisted: false };

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('next-voice', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get('settings');
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(obj) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(obj, 'settings');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const CACHE_URL = new URL('__nv_settings__', location.href).href;
async function cacheGet() {
  const res = await (await caches.open('next-voice')).match(CACHE_URL);
  return res ? res.json() : null;
}
async function cachePut(obj) {
  await (await caches.open('next-voice')).put(CACHE_URL, new Response(JSON.stringify(obj)));
}
function lsGet() {
  const obj = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith(LS_PREFIX)) obj[k.slice(LS_PREFIX.length)] = localStorage.getItem(k);
  }
  return Object.keys(obj).length ? obj : null;
}

// مع قفل Face ID المشفّر (lock.mode = prf) لا يُحفظ المفتاح والرمز إلا مشفّرين في secrets.enc
const SECRET_KEYS = ['key', 'token'];
async function persistAll() {
  const encrypted = memory.get('lock.mode') === 'prf';
  const obj = Object.fromEntries([...memory].filter(([k]) => !(encrypted && SECRET_KEYS.includes(k))));
  try {
    for (const [k, v] of Object.entries(obj)) localStorage.setItem(LS_PREFIX + k, v);
    if (encrypted) for (const k of SECRET_KEYS) localStorage.removeItem(LS_PREFIX + k);
    storage.ls = true;
  } catch { storage.ls = false; }
  try { await idbPut(obj); storage.idb = true; } catch { storage.idb = false; }
  try { await cachePut(obj); storage.cache = true; } catch { storage.cache = false; }
}

async function initStore() {
  let found = null;
  for (const read of [async () => lsGet(), idbGet, cacheGet]) {
    try { found = await read(); } catch { found = null; }
    if (found && (found.key || found.token || found['secrets.enc'])) break;
  }
  if (found) for (const [k, v] of Object.entries(found)) memory.set(k, String(v));
  try { storage.persisted = (await navigator.storage?.persist?.()) || false; } catch {}
  await persistAll(); // يعيد الكتابة في كل الأماكن، فما مُسح من أحدها يُستعاد
}

const store = {
  get(k, d = '') { return memory.get(k) ?? d; },
  set(k, v) { memory.set(k, v); persistAll(); },
};
await initStore();

// ---------- قفل Face ID (Passkey) ----------
// مفتاح مرور على الجهاز (iCloud Keychain) يُطلب عند الفتح وبعد 5 دقائق في الخلفية.
// إن دعم Safari خاصية PRF: يُشتق منه مفتاح AES يشفّر مفتاح Gemini ورمز GitHub، فلا يُقرآن دون Face ID.
// وإلا: قفل للواجهة فقط (lock.mode = gate).
const LOCK_AFTER_MS = 5 * 60 * 1000;
const lock = { aesKey: null, locked: false, hiddenAt: 0 };
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const lockEnabled = () => !!store.get('lock.cred');

async function aesFromPrf(prfBytes) {
  const base = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('next-voice-secrets') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function sealSecrets() {
  if (!lock.aesKey) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ key: memory.get('key') || '', token: memory.get('token') || '' }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, lock.aesKey, plain);
  memory.set('secrets.enc', JSON.stringify({ iv: b64u.enc(iv), ct: b64u.enc(ct) }));
  await persistAll();
}
async function openSecrets() {
  const box = JSON.parse(store.get('secrets.enc') || 'null');
  if (!box) return;
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(box.iv) }, lock.aesKey, b64u.dec(box.ct));
  const s = JSON.parse(new TextDecoder().decode(plain));
  memory.set('key', s.key); memory.set('token', s.token);
}

async function passkeyGet() {
  const salt = b64u.dec(store.get('lock.salt'));
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: b64u.dec(store.get('lock.cred')) }],
    userVerification: 'required',
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } },
  } });
  return cred.getClientExtensionResults()?.prf?.results?.first || null;
}

async function enableLock() {
  if (!window.PublicKeyCredential) throw new Error('هذا المتصفح لا يدعم Face ID للمواقع.');
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'نيكست', id: location.hostname },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'next-voice', displayName: 'نيكست الصوتي' },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } },
  } });
  store.set('lock.cred', b64u.enc(cred.rawId));
  store.set('lock.salt', b64u.enc(salt));
  // نتيجة PRF لا تصل دائماً عند الإنشاء؛ نطلبها بقراءة فورية
  let prf = cred.getClientExtensionResults()?.prf?.results?.first || null;
  if (!prf) { try { prf = await passkeyGet(); } catch { prf = null; } }
  if (prf) {
    lock.aesKey = await aesFromPrf(prf);
    memory.set('lock.mode', 'prf');
    await sealSecrets();
  } else {
    store.set('lock.mode', 'gate');
  }
  return store.get('lock.mode');
}

async function disableLock() {
  for (const k of ['lock.cred', 'lock.salt', 'lock.mode', 'secrets.enc']) memory.delete(k);
  lock.aesKey = null;
  try { for (const k of ['lock.cred', 'lock.salt', 'lock.mode', 'secrets.enc']) localStorage.removeItem(LS_PREFIX + k); } catch {}
  await persistAll(); // يعيد المفتاح والرمز مكشوفين كما كانا قبل القفل
}

async function unlock() {
  const prf = await passkeyGet();
  if (store.get('lock.mode') === 'prf') {
    if (!prf) throw new Error('لم يُرجع Face ID مفتاح فك التشفير.');
    lock.aesKey = await aesFromPrf(prf);
    await openSecrets();
  }
  lock.locked = false;
  document.getElementById('lockScreen').hidden = true;
  setTimeout(() => { refreshIdle(true); showComposer(); }, 0);
}

function lockNow() {
  if (!lockEnabled()) return;
  lock.locked = true;
  moneyShown = false; // القفل يعيد وضع العرض
  if (store.get('lock.mode') === 'prf') { memory.delete('key'); memory.delete('token'); lock.aesKey = null; }
  try { document.getElementById('settings').close(); } catch {}
  document.getElementById('lockScreen').hidden = false;
  document.getElementById('lockError').textContent = '';
}
const LANG_OPTIONS = ['العربية المصرية', 'العربية الفصحى', 'العربية الخليجية', 'العربية السودانية', 'الإنجليزية', 'الفرنسية', 'الأوردو', 'الهندية', 'التركية', 'الإسبانية', 'الألمانية'];
const DEFAULT_LANGS = 'العربية المصرية، العربية الفصحى، الإنجليزية';
const splitLangs = (s) => s.split(/[،,]/).map((x) => x.trim()).filter(Boolean);
// #local للتجربة على الماك فقط
const devRepo = location.hash === '#local' && ['localhost', '127.0.0.1'].includes(location.hostname) ? 'local' : '';
const settings = () => ({
  key: store.get('key'),
  token: store.get('token'),
  repo: devRepo || store.get('repo').trim(),
  voice: store.get('voice', 'Orus'),
  langs: store.get('langs').trim() || DEFAULT_LANGS,
  barge: store.get('barge', 'on'),
  taskCheck: store.get('taskCheck', 'on'),
  boardFix: store.get('boardFix', 'on'),
  opener: store.get('opener', 'on'),
  tasksPanel: store.get('tasksPanel', 'on'),
  chat: store.get('chat', 'on'),
});

// ---------- ذاكرة مكالمات اليوم ----------
// ما حدث فعلاً في كل مكالمة (أفعال نُفّذت، أسئلة أُرسلت، مراجعة المهام) يُحفظ على الجهاز لليوم نفسه،
// فتبدأ المكالمة التالية وهي تعرف ما قيل، ويُعرض ملخص المكالمة عند إنهائها. من الكود لا من النموذج، فلا يُختلق.
function callMemory() {
  try {
    const d = JSON.parse(store.get('calls.today') || '{}');
    return d.date === riyadhNow().date ? d.calls : [];
  } catch { return []; }
}
function callEvent(text) {
  if (!call.active) { memoryEvent(text); return; } // من الدردشة: إلى ذاكرة اليوم مباشرة
  if (call.events && !call.events.includes(text)) call.events.push(text);
}
// حدث من الدردشة: يُضاف إلى مدخل «دردشة» واحد لكل جلسة كتابة (منذ فتح التطبيق)
function memoryEvent(text) {
  const calls = callMemory();
  let last = calls[calls.length - 1];
  if (!last || last.sid !== chat.sid) {
    last = { at: clockNow(), via: 'دردشة', sid: chat.sid, events: [] };
    calls.push(last);
  }
  if (!last.events.includes(text)) last.events.push(text);
  store.set('calls.today', JSON.stringify({ date: riyadhNow().date, calls: calls.slice(-8) }));
}
function saveCallMemory() {
  const ev = call.events || [];
  if (!ev.length) return;
  const { time } = riyadhNow();
  const [hh, mm] = time.split(':').map(Number);
  const at = `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`;
  const calls = [...callMemory(), { at, events: ev.slice(0, 12) }].slice(-6);
  store.set('calls.today', JSON.stringify({ date: riyadhNow().date, calls }));
}

// ---------- واجهة ----------
const $ = (id) => document.getElementById(id);
const ui = {
  orb: $('orb'), dot: $('dot'), status: $('statusText'), log: $('log'),
  timer: $('timer'), cost: $('cost'), mute: $('muteBtn'), end: $('endBtn'),
  composer: $('composer'), text: $('textInput'),
  meter: $('meter'), meterFill: $('meterFill'),
};
function setStatus(text, state = '') {
  ui.status.textContent = text;
  ui.dot.className = 'dot ' + state;
}
let bubble = { role: null, el: null };
function say(role, text) {
  if (!text) return;
  if (bubble.role !== role || !bubble.el) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    ui.log.appendChild(el);
    bubble = { role, el };
  }
  bubble.el.textContent += text;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function note(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  ui.log.appendChild(el);
  bubble = { role: null, el: null };
  ui.log.scrollTop = ui.log.scrollHeight;
}

// ---------- الـ Vault ----------
const vault = { notes: [], byPath: new Map(), built: '' };

const AR_DIACRITICS = /[ً-ٰٟـ]/g;
function norm(s) {
  return (s || '').toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
}
const STOP = new Set(['في', 'من', 'عن', 'على', 'الى', 'الي', 'ما', 'هل', 'او', 'و', 'مع', 'ايش', 'ايه', 'اللي', 'التي', 'الذي', 'هو', 'هي']);
function terms(q) {
  const out = new Set();
  for (const t of norm(q).split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
    if (t.startsWith('ال') && t.length > 4) out.add(t.slice(2));
  }
  return [...out];
}

function indexNotes(notes) {
  vault.notes = notes.map((n) => ({
    ...n,
    _title: norm(n.title),
    _aliases: (n.aliases || []).map(norm),
    _path: norm(n.path),
    _text: norm(n.text),
  }));
  vault.byPath = new Map(vault.notes.map((n) => [n.path, n]));
}

// الكتابة في GitHub قد ترفض بـ 409 إن رفع الماك في اللحظة نفسها؛ نعيد المحاولة
async function ghWrite(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !/GitHub 409/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
}

async function gh(path, opts = {}) {
  const { token, repo } = settings();
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('رمز GitHub غير صالح أو منتهي — أنشئ رمزاً جديداً.');
  if (res.status === 404) throw new Error(`لا يرى الرمز المستودع ${repo}: تأكد أن الرمز Fine-grained، وفي Repository access اخترت Only select repositories ثم ${repo.split('/')[1] || 'المستودع'}، ومعه Contents: Read and write.`);
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res;
}

async function loadVault() {
  const { repo, token } = settings();
  let data;
  if (repo === 'local') {
    // للتجربة على الماك فقط: local-index.json يبنيه next_voice_sync.py --index-only --out
    data = await (await fetch('local-index.json', { cache: 'no-store' })).json();
  } else {
    if (!repo || !token) throw new Error('أكمل الإعدادات: رمز GitHub والمستودع');
    const res = await gh('contents/.next-voice/index.json', {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    data = await res.json();
  }
  indexNotes(data.notes || []);
  vault.built = data.built || '';
  return vault.notes.length;
}

function searchVault(query, limit = 6) {
  const ts = terms(query);
  if (!ts.length) return [];
  const scored = [];
  for (const n of vault.notes) {
    let score = 0, hits = 0;
    for (const t of ts) {
      if (n._title.includes(t)) score += 10;
      if (n._aliases.some((a) => a.includes(t))) score += 8;
      if (n._path.includes(t)) score += 3;
      let i = -1, c = 0;
      while ((i = n._text.indexOf(t, i + 1)) !== -1 && c < 8) c++;
      if (c) { score += c; hits++; }
    }
    if (score > 0) scored.push({ n, score: score + hits * 2 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ n }) => ({
    path: n.path,
    title: n.title,
    aliases: n.aliases,
    snippet: snippet(n, ts),
  }));
}

// المقتطف: الأسطر التي فيها أكثر كلمات السؤال (حتى 3 أسطر)، لا نافذة حول أول كلمة —
// فيصل نيكست إلى السطر الذي فيه الإجابة دون أن يقرأ الملف كله
function snippet(n, ts) {
  const lines = n.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 8 && !/^(---|aliases:|type:|tags:)/.test(l));
  const scored = lines.map((l, i) => {
    const nl = norm(l);
    let s = 0;
    for (const t of ts) if (nl.includes(t)) s += t.length >= 4 ? 2 : 1;
    return { l, i, s };
  }).filter((x) => x.s > 0).sort((a, b) => (b.s - a.s) || (b.i - a.i)); // التعادل: الأحدث (الأسفل في السجل) أولاً
  if (!scored.length) return n.text.slice(0, 320).replace(/\s+/g, ' ').trim();
  return scored.slice(0, 3).map((x) => (x.l.length > 300 ? x.l.slice(0, 300) + '…' : x.l)).join('\n');
}

function findNote(name) {
  if (vault.byPath.has(name)) return vault.byPath.get(name);
  const q = norm(name).replace(/\.md$/, '');
  return (
    vault.notes.find((n) => n._title === q || n._aliases.includes(q) || n._path === q + '.md') ||
    vault.notes.find((n) => n._title.includes(q) || n._aliases.some((a) => a.includes(q))) ||
    null
  );
}

function openLoopsText() {
  const n = vault.byPath.get(OPEN_LOOPS);
  if (!n) return 'ملف Open Loops غير موجود في الفهرس.';
  const t = n.text;
  const a = t.indexOf('## مفتوح');
  const b = t.indexOf('## مُغلق');
  return t.slice(a === -1 ? 0 : a, b === -1 ? undefined : b).trim();
}

// ما انتهى خلال اليوم ولم يُغلق بعد في Open Loops: ما قاله الوليد «خلص» (يُحفظ على الجهاز لليوم)،
// وما يرى ملخص واتساب أنه أُنجز (يُسأل عنه قبل إغلاقه).
function doneToday() {
  const today = riyadhNow().date;
  try { const d = JSON.parse(store.get('done.today') || '{}'); return d.date === today ? d.items : []; } catch { return []; }
}
function addDoneToday(item) {
  store.set('done.today', JSON.stringify({ date: riyadhNow().date, items: [...doneToday(), item] }));
}
// ---------- تصحيح اللوحة من Open Loops الحالي (مفتاح «تصحيح اللوحة») ----------
// اللوحة يبنيها الماك كل ساعتين، وOpen Loops يتحدث كل دقيقتين عبر المزامنة: ما أُغلق يُحذف من العرض،
// وما فُتح بعد آخر لوحة يُضاف قسماً. قراءة وعرض فقط — الملف نفسه لا يُمس. عند الشك يبقى البند (أهون أن يظهر مُغلق من أن يختفي مفتوح).
function simTerms(s) {
  const out = new Set();
  for (const t of norm(s).split(/[^\p{L}\p{N}]+/u)) {
    if (/\p{N}/u.test(t) ? t.length < 2 : t.length < 3) continue;
    if (CHECK_STOP.has(t)) continue;
    out.add(t);
    if (t.startsWith('ال') && t.length > 4) out.add(t.slice(2)); // «الباقة» تطابق «باقة»
  }
  return out;
}
function coreOf(line) { // وصف البند وحده: بلا التاريخ وسياق البند («المشروع · الشخص · القناة») وصاحب الفعل والموعد وملاحظة واتساب والأقواس
  let s = line.replace(/^- /, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').split(' · واتساب:')[0].split(' ← ')[0];
  const parts = s.split(' · ').filter((p) => !/^متابعة\s*:/.test(p.trim())); // وسم «متابعة: يومية» ليس وصفاً
  s = parts[parts.length - 1] || '';
  return s.split(' — ')[0].replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\([^)]*\)/g, ' ');
}
function taskOf(line) { // كذلك بلا «صاحب الفعل:» في أوله — للمقارنة مع أسطر الإغلاق فقط
  const s = coreOf(line);
  const i = s.indexOf(': ');
  return i > -1 && i <= 30 ? s.slice(i + 1) : s;
}
function shared(A, B) { let n = 0; for (const w of A) if (B.has(w)) n++; return n; }
// إزالة بند من اللوحة لأنه أُغلق: وصف بند اللوحة يكاد يكون كله داخل سطر الإغلاق —
// الخطأ هنا يُخفي بنداً مفتوحاً، فالشرط متشدد من جهة اللوحة
function closedMatch(boardLine, closedLine) {
  const A = simTerms(taskOf(boardLine)), B = simTerms(taskOf(closedLine));
  if (A.size < 3 || B.size < 3) return false;
  const n = shared(A, B);
  return n >= 3 && n / A.size >= 0.8 && n / B.size >= 0.6;
}
// منع تكرار بند مفتوح في قسم «جديد»: تطابق متساهل — الخطأ هنا مجرد تكرار في العرض
function looseMatch(a, b) {
  const A = simTerms(coreOf(a)), B = simTerms(coreOf(b));
  if (!A.size || !B.size) return false;
  const n = shared(A, B);
  return n >= 2 && n / Math.min(A.size, B.size) >= 0.5;
}
// الأقسام التي تُصحَّح؛ «أُنجز ومُغلق» و«ينتظر ردك» و«الجديد في واتساب» تبقى كما كتبها الماك
const FIX_SECTIONS = /^(مفتوح الآن|يبدو أنه أُنجز|مقترحات للـ)/;
let boardCache = { key: '', text: '' };
function boardText() {
  const n = vault.byPath.get('_System/Today Board.md');
  if (!n) return '';
  if (settings().boardFix === 'off') return n.text;
  const done = doneToday();
  const key = (vault.built || '') + '|' + n.text.length + '|' + done.length;
  if (boardCache.key === key) return boardCache.text;
  const { open, closed } = openLoopsLines();
  // المطابقة على ما أُغلق اليوم وأمس فقط — المُغلق القديم يشبه مهامَّ متكررة ويرفع الخطأ
  const d = new Date(Date.now() + 3 * 3600000);
  const dates = [0, 1].map((k) => new Date(d - k * 86400000).toISOString().slice(0, 10));
  const closedRef = [...closed.filter((c) => dates.some((x) => c.includes(x))), ...done.map((x) => '- ' + x)];
  let removed = 0, section = '';
  const kept = n.text.split('\n').filter((l) => {
    if (l.startsWith('## ')) { section = l.slice(3); return true; }
    if (!l.startsWith('- ') || !FIX_SECTIONS.test(section)) return true;
    if (closedRef.some((c) => closedMatch(l, c))) { removed++; return false; }
    return true;
  });
  const boardItems = n.text.split('\n').filter((l) => l.startsWith('- '));
  const fresh = open.filter((o) => !/متابعة: يومية/.test(o) && !boardItems.some((b) => looseMatch(b, o)));
  let text = kept.join('\n');
  if (fresh.length) text += '\n\n## جديد بعد آخر لوحة (من Open Loops مباشرة، بلا سياق واتساب — قد يكرر بنداً أعلاه بصياغة أخرى)\n' + fresh.map((o) => '- ' + spoken(o.slice(2))).join('\n');
  if (removed || fresh.length) text = text.replace(/(آخر تحديث:[^\n]*)/, `$1\n(صُحّحت داخل التطبيق من Open Loops الحالي: أُزيل ${removed} بند أُغلق بعدها، وأُضيف ${fresh.length} جديد. ملاحظات واتساب بعمر آخر لوحة كاملة.)`);
  boardCache = { key, text };
  return text;
}
function boardSection(title) {
  const sec = (boardText().split('## ' + title)[1] || '').split('\n## ')[0].replace(/^[^\n]*\n/, '').trim();
  return sec && !/^- لا شيء/.test(sec) ? sec : '';
}
function whatsappDone() { return boardSection('يبدو أنه أُنجز اليوم'); }

// ---------- «مهامي»: قائمة اليوم مرقّمة ----------
// من قسم «موعده اليوم» في اللوحة، وبنود «تابع مهام <الشخص> لليوم» مفصولة بنداً بنداً،
// فيقرؤها نيكست كما هي بلا اختصار، والتطبيق يتحقق بعد السرد (checkTasksSaid).
function splitTop(s, seps) { // تقسيم خارج الأقواس فقط («هابي تايم (أ، وب)» بند واحد)
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth) {
      const sep = seps.find((x) => s.startsWith(x, i));
      if (sep) { if (cur.trim()) out.push(cur.trim()); cur = ''; i += sep.length - 1; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function taskText(line) {
  return line.replace(/^- /, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').split(' · واتساب:')[0].trim();
}
function boardCount(title) {
  return boardSection(title).split('\n').filter((l) => l.startsWith('- ')).length;
}
function myTasks() {
  const items = [];
  for (const raw of boardSection('مفتوح الآن — موعده اليوم').split('\n')) {
    if (!raw.startsWith('- ')) continue;
    const line = taskText(raw);
    const m = line.match(/^تابع مهام (.+?) لليوم:\s*(.*)$/);
    if (!m) { items.push(line); continue; }
    let lastDay = '';
    for (const seg of splitTop(m[2], ['؛'])) {
      const late = /^و?المتأخر\s*:/.test(seg);
      const body = seg.replace(/^و?المتأخر\s*:\s*/, '');
      // اللوحة قد تفصل أيام الخطة بـ« · » وتسبق كل يوم بـ«من الأحد 18:» — كلاهما ليس من المهمة
      for (const sub of splitTop(body, [' · ', '، و', '، '])) {
        const s0 = sub.replace(/^و/, '');
        const from = s0.match(/^من\s+(\S+\s+\d{1,2})\s*:/);
        if (from) lastDay = from[1]; // يوم الخطة يسري على ما بعده حتى يوم جديد
        const task = s0.replace(/^من\s+\S+\s+\d{1,2}\s*:\s*/, '').trim();
        if (!task || /^لا شيء/.test(task)) continue;
        items.push(`متابعة ${m[1]}: ${task}${late ? (lastDay ? ` — متأخر منذ ${lastDay}` : ' — متأخر') : ''}`);
      }
    }
  }
  return notDoneToday(items);
}
// ما أُغلق يختفي من القوائم فوراً، من ثلاثة مصادر:
// 1) ما أكّد إغلاقه بـ mark_done (طابقه التطبيق ببند محدد) — طوال اليوم؛
// 2) طلب إغلاق جماعي أكّده عبر نيكست الكبير — 15 دقيقة فقط (حتى تصل المزامنة؛ فلا يبقى بند مخفياً خطأً)؛
// 3) أسطر «مُغلق» بتاريخ اليوم/أمس في Open Loops — اللوحة قد تتأخر ساعتين عنها.
// المطابقة داخل مقطع واحد (بين «؛» أو «،») لا في النص كله: أندر كلمة في البند + 60% من كلماته وكلمتان على الأقل.
const PENDING_CLOSE_MS = 15 * 60000;
function pendingCloses() {
  try { return JSON.parse(store.get('done.pending') || '[]').filter((x) => Date.now() - x.at < PENDING_CLOSE_MS).map((x) => x.text); } catch { return []; }
}
function addPendingClose(text) {
  const keep = (() => { try { return JSON.parse(store.get('done.pending') || '[]').filter((x) => Date.now() - x.at < PENDING_CLOSE_MS); } catch { return []; } })();
  store.set('done.pending', JSON.stringify([...keep, { text, at: Date.now() }]));
}
function closedRecently() {
  const d = new Date(Date.now() + 3 * 3600000);
  const dates = [0, 1].map((k) => new Date(d - k * 86400000).toISOString().slice(0, 10));
  return openLoopsLines().closed.filter((c) => dates.some((x) => c.startsWith('- ' + x)));
}
// جذر خفيف للكلمة: «التسليم»/«تسليمها»/«وخطة» ← «تسليم»/«خطه» — حتى تتطابق صيغ البند مع صيغ سطر الإغلاق
function stem(w) {
  let s = norm(w);
  for (const p of ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل']) if (s.startsWith(p) && s.length - p.length >= 3) { s = s.slice(p.length); break; }
  for (let pass = 0; pass < 2; pass++) { // «حملاتها» ← «حملات» ← «حمل»
    const x = ['ها', 'هم', 'ات', 'ه'].find((x) => s.endsWith(x) && s.length - x.length >= 3);
    if (!x) break;
    s = s.slice(0, -x.length);
  }
  return s;
}
function stems(text) {
  return new Set(norm(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !CHECK_STOP.has(w)).map(stem));
}
// ربط البطاقة بسطرها في Open Loops بمطابقة الإغلاق نفسها (IDF على كل البنود): تُخفى فقط إن كان سطرها
// — أو الجزء المقصود منه في سطر خطة — قد أُغلق. يلتقط اختلاف الصياغة بين اللوحة وOpen Loops («الذكاء الاصطناعي»/«AI»)
function closedByLine(item, done, recent) {
  const { open, closed } = openLoopsLines();
  // الوصف وحده (قبل «—»): أسطر «مُغلق» تذكر أحياناً بعده الجزء الباقي المفتوح («باقي البند (…) مفتوح»)
  const cut = (l) => l.split(' — ')[0];
  const openCut = open.map(cut), recentCut = recent.map(cut);
  const all = [...openCut, ...closed.map(cut)];
  const r = rankLines(all, item, all);
  if (!r.length || (r[1] && r[1].s >= r[0].s * 0.83)) return false; // لا ربط واضح ← لا إخفاء
  const top = r[0].l;
  if (recentCut.includes(top)) return true; // سطره أُغلق اليوم/أمس (أسطر الإغلاق لا تحمل إلا الجزء المُغلق)
  if (!openCut.includes(top)) return false; // مُغلق قديم: لا يُبنى عليه
  // سطره ما زال مفتوحاً في النسخة: يُخفى فقط إن أكّد إغلاقه في هذه الجلسة (وجزؤه المقصود إن كان سطر خطة)
  const line = open[openCut.indexOf(top)].replace(/^- /, '');
  const segs = lineSegments(line);
  const part = segs.length > 1 ? bestSegment(line, item) : null;
  if (segs.length > 1 && !part) return false;
  return done.some((d) => d.length > 40 && (line.startsWith(d.slice(0, 120)) || d.startsWith(line.slice(0, 120)))) && (!part || done.includes(part));
}
function notDoneToday(items) {
  const done = doneToday();
  const recent = closedRecently();
  const refs = [...done, ...pendingCloses(), ...recent.map((c) => taskOf(c))];
  if (!refs.length) return items;
  items = items.filter((x) => !closedByLine(x, done, recent));
  const segs = refs.flatMap((r) => r.split(/[؛،\n]/)).filter((s) => s.trim().length > 3).map(stems);
  const terms = checkTerms(items); // مرتبة بالندرة بين البنود: الأولى أندرها
  return items.filter((x, i) => {
    if (done.includes(x)) return false;
    const ts = [...new Set((terms[i] || []).map(stem))];
    if (ts.length < 2) return true;
    return !segs.some((S) => {
      if (!S.has(ts[0])) return false;
      const hit = ts.filter((t) => S.has(t)).length;
      return hit >= 2 && hit / ts.length >= 0.6;
    });
  });
}
// قوائم القسم من اللوحة (للأسبوع والمقترحات): أسطر نظيفة، بلا ملاحظة واتساب، وبلا ما أُغلق اليوم
function boardItems(title) {
  return notDoneToday(boardSection(title).split('\n').filter((l) => l.startsWith('- ')).map(taskText));
}
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
// «— الأحد 25 أكتوبر» ← هل موعده خلال 7 أيام؟ (ما لا يُفهم تاريخه يُعدّ ضمن الأسبوع حتى لا يختفي)
function withinWeek(line, days = 7) {
  const m = line.match(/(\d{1,2})\s+(يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/);
  if (!m) return true;
  const mo = AR_MONTHS.findIndex((x) => norm(x) === norm(m[2]));
  const { date } = riyadhNow();
  const [y, cm, cd] = date.split('-').map(Number);
  let due = Date.UTC(y, mo, +m[1]);
  const today = Date.UTC(y, cm - 1, cd);
  if (due < today - 180 * 864e5) due = Date.UTC(y + 1, mo, +m[1]); // ديسمبر ← يناير
  return (due - today) / 864e5 <= days;
}
// كلمات كل بند المميزة (الأندر بين البنود تحسم؛ العامة والتواريخ لا).
// CHECK_STOP معرّف بعد ITEM_STOP أدناه، ويُستعمل هنا وقت الاستدعاء فقط.
function checkTerms(items) {
  const words = items.map((it) => [...new Set(norm(it).split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && !CHECK_STOP.has(w)))]);
  const df = new Map();
  for (const ws of words) for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
  return words.map((ws) => ws.sort((a, b) => (df.get(a) - df.get(b)) || (b.length - a.length)).slice(0, 4));
}
// ---------- المهام على الشاشة (مفتاح «المهام على الشاشة») ----------
// عرض فقط: نفس قائمة my_tasks مجمّعة، ✓ على ما ذكره نيكست في المكالمة، والضغط على بند يطلب من نيكست الحديث عنه
// (قراءة لا فعل — أي إغلاق يمر بالتأكيد الصوتي كالعادة).
// ---------- زر «أغلق» على كل بند (اليوم، الأسبوع، مقترحات) ----------
// بضغطتين (طلب ثم تأكيد) يُرسل طلب «فعل» لنيكست الكبير: البند ينتقل إلى «مُغلق» في Open Loops، والمقترح يُغلق بسبب
// «تجاهله الوليد». البند يختفي من القوائم فوراً (done.today) ولا يُلمس Open Loops من التطبيق.
// عمر المقترح: من تاريخ ظهوره في قسم «مقترحات» في Open Loops (سطر اللوحة لا يحمله)؛ بلا ربط واضح لا تُعرض علامة.
const PROPOSAL_OLD_DAYS = 10;
function proposalAge(item) {
  if (/\((جديد|موعد صريح)/.test(item)) return null; // لم يُكتب في Open Loops بعد: لا تاريخ ظهور له
  const n = vault.byPath.get(OPEN_LOOPS);
  if (!n) return null;
  const i = n.text.indexOf('\n## مقترحات');
  if (i === -1) return null;
  const j = n.text.indexOf('\n## ', i + 5);
  const lines = n.text.slice(i, j === -1 ? undefined : j).split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l));
  const r = rankLines(lines, item, lines);
  if (!r.length || (r[1] && r[1].s >= r[0].s * 0.83)) return null;
  const top = norm(r[0].l);
  if (itemTerms(item.split(' ← ')[0]).filter((t) => top.includes(t)).length < 2) return null; // كلمة واحدة مشتركة لا تكفي للربط
  const days = Math.round((Date.parse(riyadhNow().date) - Date.parse(r[0].l.slice(2, 12))) / 864e5);
  return Number.isFinite(days) && days >= 0 ? days : null;
}
function closeRequest(x, kind) {
  const short = x.replace(/^عليك:\s*/, '').split(' ← ')[0];
  if (kind === 'proposal') {
    return {
      title: `تجاهل مقترح: ${short}`,
      content: `في _System/Open Loops.md، قسم «مقترحات»: المقترح «${x}» ← انقله إلى «مُغلق» بتاريخ اليوم وبسبب «تجاهله الوليد (زر الإغلاق في التطبيق)».\nإن لم تجده في «مقترحات» (التقطته اللوحة ولم يُكتب بعد): اكتب له سطراً في «مُغلق» بالسبب نفسه حتى لا يُقترح مجدداً، ولا تغيّر غيره.\nإن طابق أكثر من مقترح ولم يتضح المقصود فلا تغيّر شيئاً وأبلغه.`,
    };
  }
  const m = x.match(/^متابعة ([^:]+):\s*(.*)$/);
  const part = m ? m[2].replace(/ — متأخر.*$/, '').trim() : '';
  return {
    part,
    title: `إغلاق: ${part || short}`,
    content: `أغلق في _System/Open Loops.md البند: ${x}\n${part ? `الجزء المقصود تحديداً: «${part}» (من متابعة ${m[1]})\n` : ''}(انقله إلى «مُغلق» بتاريخ اليوم وسطر قصير بالسبب: ضغط الوليد زر «أغلق» في التطبيق وأكّده.)\nوإن كان البند سطر خطة أو متابعة يضم عدة أجزاء: أغلق الجزء المقصود وحده (احذفه من السطر واذكره في «مُغلق»)، وأبقِ باقي السطر مفتوحاً كما هو.\nإن لم تجد البند أو طابق أكثر من بند ولم يتضح المقصود فلا تغيّر شيئاً وأبلغه.`,
  };
}
async function closeItem(x, kind, btn) {
  if (btn.dataset.step !== 'confirm') {
    btn.dataset.step = 'confirm'; btn.textContent = 'تأكيد؟'; btn.classList.add('on');
    setTimeout(() => { if (btn.isConnected && btn.dataset.step === 'confirm') { btn.dataset.step = ''; btn.textContent = btn.dataset.label || 'أغلق'; btn.classList.remove('on'); } }, 5000);
    return;
  }
  btn.dataset.step = 'sending'; btn.disabled = true; btn.textContent = '…';
  const req = closeRequest(x, kind);
  try {
    await addToInbox({ title: req.title.slice(0, 60), content: req.content, kind: BIG_KIND, type: 'فعل' });
    addDoneToday(x);
    if (req.part) addDoneToday(req.part);
    renderTasks();
  } catch (e) {
    btn.dataset.step = ''; btn.disabled = false; btn.classList.remove('on'); btn.textContent = 'تعذّر';
  }
}
const panel = { said: '', terms: [], items: [], tab: '', sub: '' };
// عرض مبسّط (2026-11-12): سطر واحد لكل بند (يُقصّ إن طال) وتحته شارات صغيرة: المشروع، والموعد أو «متأخر n»، و«قديم · n يوماً».
// الضغط على البند يفتحه: النص كاملاً وتاريخه وزرّا «اتصال» و«شات» (وفي المكالمة «حدّثني عنه»). «أغلق» أيقونة: ✓ للمهام و✕ للمقترحات
// (تجاهل لا إنجاز)، بالضغطتين نفسيهما.
function itemLate(x) { // عدد أيام التأخر، أو true إن كان متأخراً بلا تاريخ مفهوم، أو 0
  if (/ — مفتوح منذ /.test(x)) return 0; // بلا موعد: ليس متأخراً
  const info = dueInfo(x.split(' ← ')[0]);
  if (info && info.days > 0) return info.days;
  return / — متأخر/.test(x) ? true : 0;
}
function panelList(items, opts = {}) {
  const said = norm(panel.said);
  const terms = checkTerms(items);
  const ul = document.createElement('ul');
  items.forEach((x, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    const info = dueInfo(x.split(' ← ')[0]);
    const text = x.replace(/^عليك:\s*/, '').replace(/^متابعة يومية — ([^:]+):\s*(بند واحد، هو |\S+ بنود؛ )?/, 'متابعة $1: ').replace(/^متابعة (?!يومية)[^:]+:\s*/, opts.kind ? '$&' : '').split(' ← ')[0].replace(/ — [^—]*$/, '');
    const main = document.createElement('div');
    main.className = 'main';
    main.append(uiEl('div', 't', maskItem(text)));
    const chips = uiEl('div', 'chips');
    const proj = projectOf(x);
    if (proj && !opts.noProj) chips.append(uiEl('span', 'chip', proj)); // داخل لوحة المشروع اسمه مكرر
    const late = itemLate(x);
    const lbl = lateLabel(info?.days);
    const nodate = / — مفتوح منذ /.test(x);
    if (late) chips.append(uiEl('span', 'chip warn', lbl || 'متأخر'));
    else if (nodate) chips.append(uiEl('span', 'chip', 'بلا موعد'));
    else if (info && info.due && !/^بلا موعد/.test(info.due)) chips.append(uiEl('span', 'chip', info.due));
    let age = null;
    if (opts.kind === 'proposal') { try { age = proposalAge(x); } catch { /* العلامة اختيارية */ } }
    if (age != null && age >= PROPOSAL_OLD_DAYS) chips.append(uiEl('span', 'chip old', `قديم · ${age} يوماً`));
    if (chips.children.length) main.append(chips);
    // التفاصيل عند الفتح: الموعد الأصلي للمتأخر، ومصدر المقترح، وزرّا الحديث عنه
    const more = uiEl('div', 'more');
    more.hidden = true;
    const bits = [];
    if (late && info && info.due) bits.push('كان موعده ' + info.due.replace(/^متأخر منذ /, ''));
    if (nodate && info && info.due) bits.push(info.due);
    const src = x.split(' ← ')[1];
    if (src) bits.push('من: ' + maskItem(src));
    if (bits.length) more.append(uiEl('div', 'meta-sm', bits.join(' · ')));
    const row = uiEl('div', 'choice');
    more.append(row);
    const fillRow = () => { // يُبنى عند الفتح: حالة المكالمة والشات قد تتغير بعد الرسم
      const mk = (label, fn) => { const b = uiEl('button', 'pill sm', label); b.type = 'button'; b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
      if (call.session) row.replaceChildren(mk('حدّثني عنه', () => askAbout(x, opts.kind)));
      else if (call.active) row.replaceChildren();
      else row.replaceChildren(mk('📞 اتصال', () => askAbout(x, opts.kind)), ...(chatOn() ? [mk('💬 شات', () => chatAbout(x, opts.kind))] : []));
    };
    main.append(more);
    li.append(main);
    // ✓ عرضيّ متشدد: أندر كلمة في البند + كلمتان (كلمات مثل «صرة» و«خطة» تتكرر في بنود كثيرة)
    const ts = terms[i] || [];
    const hit = ts.filter((t) => said.includes(t)).length;
    if (ts.length && said.includes(ts[0]) && hit >= Math.min(2, ts.length)) li.classList.add('said');
    const icon = opts.kind === 'proposal' ? '✕' : '✓';
    const xb = uiEl('button', 'pill sm xbtn ico', icon);
    xb.type = 'button';
    xb.dataset.label = icon;
    xb.setAttribute('aria-label', opts.kind === 'proposal' ? 'تجاهل المقترح' : 'أغلق البند');
    xb.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); closeItem(x, opts.kind, xb); });
    li.append(xb);
    li.addEventListener('click', () => { more.hidden = !more.hidden; li.classList.toggle('open', !more.hidden); if (!more.hidden) fillRow(); });
    ul.append(li);
  });
  return ul;
}
// قسم بنود يُطوى بالضغط على عنوانه. القسم الذي فيه بند متأخر لا يُطوى ابتداءً، وعنوانه يحمل «متأخر n».
function taskGroup(body, title, list, opts = {}) {
  const lateN = list.filter((x) => itemLate(x)).length;
  const open = opts.open || lateN > 0;
  const h = uiEl('div', 'grp fold');
  const lab = uiEl('span', '', `${title} · ${list.length}`);
  const arrow = uiEl('span', 'arrow', open ? ' ▴' : ' ▾');
  h.append(lab, arrow);
  if (lateN) h.append(uiEl('span', 'chip warn', lateN === list.length && lateN === 1 ? 'متأخر' : `متأخر ${lateN}`));
  const ul = panelList(list, opts.list);
  ul.hidden = !open;
  h.addEventListener('click', () => { ul.hidden = !ul.hidden; arrow.textContent = ul.hidden ? ' ▾' : ' ▴'; });
  body.append(h, ul);
}
// ---------- لوحة الفرص (تبويب «الفرص») ----------
// _System/Opportunities Board.md ملف تلقائي من شيت البحث عن فرص جديدة (يكتبه سكربت الماك). العرض قراءة فقط؛
// الفعل الوحيد زر «قدّمت»: بضغطتين (طلب ثم تأكيد) يُرسل طلب «فعل» لنيكست الكبير ليسجّل التقديم في الشيت.
// شكل الملف: أقسام «## عنوان» تحتها أسطر «- …». قسم «قدّم على الإعلانات» أسطره:
//   - OPP-123 | الشركة | المسمى | الدرجة | https://رابط-الإعلان
const OPPS_FILE = '_System/Opportunities Board.md';
const OPPS_SHEET = '15Jihl4OMeHZNz8HqaZy50teiKXFLaVZyqu098bGHDvU';
function oppsBoard() {
  const n = vault.byPath.get(OPPS_FILE);
  if (!n) return null;
  const out = { updated: (n.text.match(/^آخر تحديث:\s*(.+)$/m) || [])[1] || '', sections: [] };
  let cur = null;
  for (const line of n.text.split('\n')) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { cur = { title: h[1].trim(), lines: [] }; out.sections.push(cur); continue; }
    if (cur && line.startsWith('- ')) cur.lines.push(line.slice(2).trim());
  }
  return out;
}
function oppsApplied() { try { return JSON.parse(store.get('opps.applied') || '{}'); } catch { return {}; } }
const oppsIsApply = (sec) => sec.title.startsWith('قدّم');
const oppsReal = (lines) => lines.filter((l) => l && l !== 'لا شيء');
function oppsBadLinks() { try { return JSON.parse(store.get('opps.badlink') || '{}'); } catch { return {}; } }
// «لا أريد التقديم»: الوليد يتخطى إعلاناً لا يريده. الضغطة تفتح أسباباً سريعة (اختيار أحدها هو التأكيد)، ثم يُكتب طلب «فعل»
// لنيكست الكبير: M = «متخطّى» وسطر في آخر T بالسبب، في صف المعرّف وحده. الإعلان يختفي فوراً على هذا الجهاز.
const OPPS_SKIP_REASONS = ['المسمى لا يناسبني', 'الشركة لا تناسبني', 'المستوى أو الراتب', 'بعيدة عن خبرتي', 'بلا سبب'];
function oppsSkipped() { // الإخفاء المحلي 24 ساعة: إن كُتب «متخطّى» في الشيت خرج الإعلان من اللوحة أصلاً، وإن لم يُكتب عاد ليظهر
  let o = {};
  try { o = JSON.parse(store.get('opps.skipped') || '{}'); } catch { o = {}; }
  const now = Date.now();
  for (const k of Object.keys(o)) if (now - o[k] > 24 * 3600 * 1000) delete o[k];
  return o;
}
async function oppsSkip(x, reason, btn) {
  btn.disabled = true; btn.textContent = '…';
  const { date } = riyadhNow();
  const why = reason === 'بلا سبب' ? '' : reason;
  try {
    await addToInbox({
      title: `تخطّي فرصة ${x.id} ${x.company}`.slice(0, 60),
      content: `الوليد ضغط «لا أريد التقديم» على ${x.id} (${x.company} — ${x.role}) يوم ${date} وأكّد باختيار السبب: ${why || 'لم يذكر سبباً'}.
في شيت البحث عن فرص جديدة (${OPPS_SHEET})، تبويب «الفرص»، صف هذا المعرّف فقط (ابحث عنه في العمود A، وتأكد أن الشركة في C تطابق «${x.company}»؛ إن لم تطابق فلا تكتب شيئاً وأبلغ):
1) اكتب في M: متخطّى
2) أضف في آخر T دون مسح الموجود: «تخطّاها الوليد ${date}${why ? ': ' + why : ''} (من التطبيق)»
لا تكتب في أي خلية أخرى، ولا في K ولا S ولا U، ولا تغيّر جهات الاتصال ولا ملفات المسودات. ردك سطر واحد بما تم.`,
      kind: BIG_KIND, type: 'فعل',
    });
    const s = oppsSkipped(); s[x.id] = Date.now(); store.set('opps.skipped', JSON.stringify(s));
    renderTasks();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function oppsApplyItems(sec) {
  const done = oppsApplied(), bad = oppsBadLinks(), skipped = oppsSkipped(); // المبلَّغ عن رابطه يختفي حتى يتغير رابطه في اللوحة
  return oppsReal(sec.lines).map((l) => {
    // حقل سادس اختياري «السيرة: <اسم النسخة>»: النسخة التي اختارتها مهمة الالتقاط بعد قراءة الإعلان (من الشيت)
    // وحقل سابع اختياري «بديل: <اسم النسخة> (<متى تُستعمل>)»: نسخة ثانية ذكرتها المهمة، والسبب بين قوسين اختياري
    const [id = '', company = '', role = '', score = '', url = '', cvField = '', altField = ''] = l.split(' | ').map((x) => x.trim());
    const am = altField.match(/^بديل:\s*(.+?)(?:\s*\((.+)\))?$/);
    return { id, company, role, score, url: /^https?:\/\//.test(url) ? url : '', cv: cvField.replace(/^السيرة:\s*/, '').trim(), alt: am ? am[1].trim() : '', altWhy: am && am[2] ? am[2].trim() : '' };
  }).filter((x) => x.id && !done[x.id] && !skipped[x.id] && bad[x.id] !== (x.url || '-'));
}
function oppsCount() { // ما يحتاج فعلاً منه في هذا التبويب: رسائل تنتظر اعتماده + إعلانات لم يقدّم عليها
  let n = 0;
  try { n += outreachDrafts().length; } catch { /* لا مسودات */ }
  const b = oppsBoard();
  if (b) b.sections.forEach((sec) => { if (oppsIsApply(sec)) n += oppsApplyItems(sec).length; });
  return n;
}
// روابط السير الذاتية على Drive: _System/CV Links.md، أسطره «- الاسم | كلمات مفتاحية بفواصل | الرابط».
// السطر الأول الذي تطابق إحدى كلماته المسمى هو النسخة المقترحة؛ الكلمة * = الافتراضية. الملفات خاصة بحساب الوليد.
const CV_FILE = '_System/CV Links.md';
function cvLinks() {
  const n = vault.byPath.get(CV_FILE);
  if (!n) return [];
  return n.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => {
    const p = l.slice(2).split(' | ').map((x) => x.trim());
    const url = p[p.length - 1] || '';
    if (p.length < 3 || !/^https:\/\//.test(url)) return null;
    return { name: p[0], keys: p[1].split(/[،,]/).map((k) => k.trim().toLowerCase()).filter(Boolean), url };
  }).filter(Boolean);
}
function cvFor(role, list) {
  const r = (role || '').toLowerCase();
  return list.find((c) => c.keys.some((k) => k !== '*' && r.includes(k))) || list.find((c) => c.keys.includes('*')) || null;
}
function cvLink(c, label) {
  const a = document.createElement('a');
  a.className = 'pill sm'; a.href = c.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
  return a;
}
async function oppsMarkApplied(x, btn) {
  if (btn.dataset.step !== 'confirm') { // الضغطة الأولى تطلب التأكيد، وتعود لحالها بعد 5 ثوانٍ
    btn.dataset.step = 'confirm'; btn.textContent = 'تأكيد: قدّمت؟'; btn.classList.add('on');
    setTimeout(() => { if (btn.isConnected && btn.dataset.step === 'confirm') { btn.dataset.step = ''; btn.textContent = 'قدّمت'; btn.classList.remove('on'); } }, 5000);
    return;
  }
  btn.dataset.step = 'sending'; btn.disabled = true; btn.textContent = 'يُسجَّل…';
  const { date } = riyadhNow();
  try {
    await addToInbox({
      title: `تسجيل تقديم ${x.id} ${x.company}`.slice(0, 60),
      content: `سجّل في شيت البحث عن فرص جديدة (${OPPS_SHEET})، تبويب «الفرص»: الوليد قدّم بنفسه على ${x.id} (${x.company} — ${x.role}) يوم ${date}.\nاكتب في العمود U «تقديم مباشر» لصف هذا المعرّف: «قدّمت بنفسي ${date}». لا تغيّر أي عمود آخر، ولا تكتب في K ولا S.\nإن لم تجد المعرّف في العمود A فلا تكتب شيئاً وأبلغه.`,
      kind: BIG_KIND, type: 'فعل',
    });
    const done = oppsApplied(); done[x.id] = date; store.set('opps.applied', JSON.stringify(done));
    renderTasks();
  } catch (e) {
    btn.dataset.step = ''; btn.disabled = false; btn.classList.remove('on'); btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
// زر «الرابط لا يعمل»: بضغطتين يطلب من نيكست الكبير رابطاً يعمل للوظيفة نفسها (يكتبه في E)، وإن لم يجد يجعل الفرصة «متخطّى».
// الإعلان يختفي من القائمة ما دام رابطه في اللوحة هو الرابط المبلَّغ عنه؛ إن صُحّح الرابط عاد للظهور مع تحديث اللوحة.
async function oppsBadLink(x, btn) {
  if (btn.dataset.step !== 'confirm') {
    btn.dataset.step = 'confirm'; btn.textContent = 'تأكيد: لا يعمل؟'; btn.classList.add('on');
    setTimeout(() => { if (btn.isConnected && btn.dataset.step === 'confirm') { btn.dataset.step = ''; btn.textContent = 'الرابط لا يعمل'; btn.classList.remove('on'); } }, 5000);
    return;
  }
  btn.dataset.step = 'sending'; btn.disabled = true; btn.textContent = 'يُبلَّغ…';
  const { date } = riyadhNow();
  try {
    await addToInbox({
      title: `رابط لا يعمل ${x.id} ${x.company}`.slice(0, 60),
      content: `الوليد ضغط «الرابط لا يعمل» (وأكّد) على ${x.id} (${x.company} — ${x.role}) يوم ${date}. الرابط المسجّل: ${x.url || 'لا رابط'}\nفي شيت البحث عن فرص جديدة (${OPPS_SHEET})، تبويب «الفرص»، صف هذا المعرّف فقط:\n1) ابحث عن صفحة الوظيفة نفسها (المسمى + الشركة + الرياض) في صفحة توظيف الشركة أو لوحة ATS أو لينكدإن، وافتحها للتأكد أنها تعمل وفيها زر التقديم.\n2) إن وجدت رابطاً يعمل: اكتبه في العمود E، وأضف في آخر T «صُحّح الرابط ${date}: <من أين>» دون مسح ما فيه.\n3) إن لم تجد، أو الإعلان مغلق: اكتب في M «متخطّى»، وأضف في آخر T «رابط لا يعمل ${date}: <السبب>» دون مسح ما فيه.\nلا تغيّر أي عمود آخر ولا أي صف آخر، ولا تكتب في K ولا S، ولا تخمّن رابطاً. إن لم تجد المعرّف، أو لم تسمح تعليماتك بهذه الكتابة، فلا تكتب شيئاً وأبلغه.`,
      kind: BIG_KIND, type: 'فعل',
    });
    const bad = oppsBadLinks(); bad[x.id] = x.url || '-'; store.set('opps.badlink', JSON.stringify(bad));
    renderTasks();
  } catch (e) {
    btn.dataset.step = ''; btn.disabled = false; btn.classList.remove('on'); btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
// ---------- اعتماد إيميلات التواصل من التطبيق ----------
// مسودات «مهمة التواصل» ملفات في _System/Outreach Drafts/ (الشكل في «_شكل الملف.md» هناك). التطبيق يعرض ما حالته
// «بانتظار الموافقة» بنصه كاملاً، والأفعال الثلاثة (اعتمد / عدّل / ألغِ) طلبات «فعل» لنيكست الكبير بمسار الملف نفسه.
// لا يُرسل شيء من هنا: نيكست الكبير يغيّر حالة الملف فقط، ومهمة التواصل وحدها ترسل في تشغيلها التالي.
const DRAFTS_DIR = '_System/Outreach Drafts/';
function draftParse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (!m) return { meta, body: text };
  for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { meta, body: text.slice(m[0].length) };
}
function draftsActed() { // ما ضغط عليه يختفي فوراً، وحتى 24 ساعة إن تأخر الماك في تنفيذ الطلب
  let o = {};
  try { o = JSON.parse(store.get('drafts.acted') || '{}'); } catch { o = {}; }
  const now = Date.now();
  for (const k of Object.keys(o)) if (now - o[k] > 24 * 3600 * 1000) delete o[k];
  return o;
}
function outreachDrafts() {
  const acted = draftsActed();
  return (vault.notes || []).filter((n) => n.path.startsWith(DRAFTS_DIR) && !acted[n.path]).map((n) => {
    const { meta, body } = draftParse(n.text);
    if (meta.kind !== 'outreach-draft' || meta.status !== 'بانتظار الموافقة') return null;
    const subject = (body.match(/^\*\*الموضوع:\*\*\s*(.+)$/m) || [])[1] || '';
    const parts = body.split(/\n## /);
    const text = parts[0].replace(/^# .*\n/, '').replace(/^\*\*الموضوع:\*\*.*\n?/m, '').trim();
    const why = (parts.find((x) => x.startsWith('لماذا هو')) || '').replace(/^لماذا هو\s*/, '').trim();
    return { path: n.path, meta, subject, text, why };
  }).filter(Boolean).sort((a, b) => (a.path < b.path ? 1 : -1));
}
function draftRequest(d, act, note = '') {
  const who = `${d.meta.name || ''} — ${d.meta.company || ''} (${d.meta.contact || ''})`;
  const file = `الملف: \`${d.path}\``;
  return {
    approve: { title: `اعتمد إيميل ${d.meta.contact || ''} ${d.meta.name || ''}`, content: `اعتمد إيميل ${who}.\n${file}\nاعتمده الوليد من تبويب «الفرص» في التطبيق بضغطتين، بعد أن عُرض عليه النص كاملاً على الشاشة (الموضوع: «${d.subject}»، طول النص ${d.text.length} حرفاً).\nتحقق أن الملف بهذا المسار وحالته «بانتظار الموافقة» وأن موضوعه هو المذكور هنا، ثم اكتب status: معتمد بالصوت و approved_at كما في قاعدة «اعتمد إيميل». إن اختلف الموضوع أو الحالة فلا تعتمد واذكر ذلك.\nلا ترسل شيئاً ولا تغيّر الشيت؛ مهمة التواصل ترسله في تشغيلها التالي.` },
    cancel: { title: `ألغِ إيميل ${d.meta.contact || ''} ${d.meta.name || ''}`, content: `ألغِ إيميل ${who}.\n${file}\nألغاه الوليد من تبويب «الفرص» في التطبيق بضغطتين. اكتب status: مُلغى في هذا الملف فقط. لا ترسل شيئاً ولا تغيّر الشيت.` },
    edit: { title: `عدّل إيميل ${d.meta.contact || ''} ${d.meta.name || ''}`, content: `عدّل إيميل ${who}: ${note.trim()}\n${file}\nطلبه الوليد كتابةً من تبويب «الفرص» في التطبيق. عدّل النص في هذا الملف بقاعدة «عدّل إيميل»، والحالة تبقى «بانتظار الموافقة» ليراجعه من جديد.` },
  }[act];
}
// «اعتمد ما فتحته»: اعتماد دفعة واحدة لما عُرض نصه على الشاشة فقط (قرار الوليد 2026-11-11؛ القاعدة: لا اعتماد لرسالة لم تُفتح).
const draftsOpened = new Set();
async function draftsApproveOpened(btn) {
  const todo = outreachDrafts().filter((d) => draftsOpened.has(d.path));
  if (!todo.length) return;
  if (btn.dataset.step !== 'confirm') {
    btn.dataset.step = 'confirm'; btn.textContent = `تأكيد اعتماد ${todo.length}؟`; btn.classList.add('on');
    setTimeout(() => { if (btn.isConnected && btn.dataset.step === 'confirm') { btn.dataset.step = ''; btn.classList.remove('on'); draftsBulkLabel(btn); } }, 5000);
    return;
  }
  btn.dataset.step = 'sending'; btn.disabled = true;
  let ok = 0;
  for (const d of todo) {
    btn.textContent = `يُرسل ${ok + 1} من ${todo.length}…`;
    try {
      const req = draftRequest(d, 'approve');
      await addToInbox({ title: req.title.slice(0, 60), content: req.content + '\n(ضمن اعتماد دفعة واحدة لما فتحه وقرأه.)', kind: BIG_KIND, type: 'فعل' });
      const o = draftsActed(); o[d.path] = Date.now(); store.set('drafts.acted', JSON.stringify(o));
      draftsOpened.delete(d.path);
      ok++;
    } catch (e) { break; }
  }
  renderTasks(); // ما تعذّر إرساله يبقى في القائمة وفي عدّاد الزر
}
function draftsBulkLabel(btn) {
  const n = outreachDrafts().filter((d) => draftsOpened.has(d.path)).length;
  btn.textContent = n ? `اعتمد ما فتحته (${n})` : 'اعتمد ما فتحته';
  btn.disabled = !n;
}
async function draftAct(d, act, btn, note = '') {
  const labels = { approve: 'اعتمد', cancel: 'ألغِ', edit: 'أرسل التعديل' };
  if (act !== 'edit' && btn.dataset.step !== 'confirm') { // ضغطتان للاعتماد والإلغاء
    btn.dataset.step = 'confirm'; btn.textContent = act === 'approve' ? 'تأكيد الاعتماد؟' : 'تأكيد الإلغاء؟'; btn.classList.add('on');
    setTimeout(() => { if (btn.isConnected && btn.dataset.step === 'confirm') { btn.dataset.step = ''; btn.textContent = labels[act]; btn.classList.remove('on'); } }, 5000);
    return;
  }
  if (act === 'edit' && !note.trim()) return;
  btn.dataset.step = 'sending'; btn.disabled = true; btn.textContent = 'يُرسل…';
  const req = draftRequest(d, act, note);
  try {
    await addToInbox({ title: req.title.slice(0, 60), content: req.content, kind: BIG_KIND, type: 'فعل' });
    if (act !== 'edit') { const o = draftsActed(); o[d.path] = Date.now(); store.set('drafts.acted', JSON.stringify(o)); renderTasks(); }
    else { btn.textContent = 'أُرسل التعديل — يعود للمراجعة بعد دقائق'; }
  } catch (e) {
    btn.dataset.step = ''; btn.disabled = false; btn.classList.remove('on'); btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function renderDrafts(body) {
  const list = outreachDrafts();
  if (!list.length) return;
  const h = document.createElement('div');
  h.className = 'grp';
  h.textContent = `رسائل تنتظر اعتمادك · ${list.length}`;
  const bulkRow = document.createElement('div');
  bulkRow.className = 'choice';
  const bulk = document.createElement('button');
  bulk.type = 'button'; bulk.className = 'pill sm';
  bulk.addEventListener('click', (ev) => { ev.preventDefault(); draftsApproveOpened(bulk); });
  draftsBulkLabel(bulk);
  bulkRow.append(bulk);
  const ul = document.createElement('ul');
  for (const d of list) {
    const li = document.createElement('li');
    li.className = 'plain';
    const main = document.createElement('div');
    main.className = 'main';
    const head = document.createElement('div');
    head.style.cursor = 'pointer';
    head.textContent = [d.meta.name, d.meta.company].filter(Boolean).join(' — ');
    const meta = document.createElement('div');
    meta.className = 'meta-sm';
    meta.textContent = [d.meta.title, d.meta.type, d.meta.email_status, d.meta.cv && d.meta.cv !== 'بلا مرفق' ? 'مرفق: ' + d.meta.cv.replace(/^ElWalid_Hafiz_CV_|\.pdf$/g, '').replace(/_/g, ' ') : 'بلا مرفق'].filter(Boolean).join(' · ');
    const box = document.createElement('div');
    box.hidden = true;
    const subj = document.createElement('div');
    subj.className = 'draft-subj'; subj.dir = 'auto'; subj.textContent = d.subject;
    const txt = document.createElement('div');
    txt.className = 'draft'; txt.dir = 'auto'; txt.textContent = d.text;
    const why = document.createElement('div');
    why.className = 'meta-sm'; why.textContent = d.why ? 'لماذا هو: ' + d.why : '';
    const row = document.createElement('div');
    row.className = 'choice';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill sm'; b.textContent = label; b.addEventListener('click', (ev) => { ev.preventDefault(); fn(b); }); return b; };
    const editRow = document.createElement('div');
    editRow.className = 'choice'; editRow.hidden = true;
    const input = document.createElement('input');
    input.className = 'draft-edit'; input.placeholder = 'اكتب التعديل المطلوب…'; input.dir = 'auto';
    editRow.append(input, mk('أرسل التعديل', (b) => draftAct(d, 'edit', b, input.value)));
    const extra = document.createElement('div');
    extra.className = 'choice'; extra.hidden = true;
    extra.append(mk('ألغِ', (b) => draftAct(d, 'cancel', b)));
    row.append(mk('اعتمد', (b) => draftAct(d, 'approve', b)), mk('عدّل', () => { editRow.hidden = !editRow.hidden; }), mk('⋯', () => { extra.hidden = !extra.hidden; }));
    box.append(meta, subj, txt, why, row, extra, editRow);
    head.addEventListener('click', () => { box.hidden = !box.hidden; if (!box.hidden) { draftsOpened.add(d.path); head.textContent = '✓ ' + head.textContent.replace(/^✓ /, ''); if (bulk.dataset.step !== 'sending') { bulk.dataset.step = ''; bulk.classList.remove('on'); draftsBulkLabel(bulk); } } });
    if (draftsOpened.has(d.path)) head.textContent = '✓ ' + head.textContent;
    main.append(head, box);
    li.append(main);
    ul.append(li);
  }
  body.append(h, bulkRow, ul);
}
// ---------- تحديث لوحة الفرص يدوياً ----------
// الزر يكتب طلباً عنوانه يبدأ بـ OPPS_REFRESH_TITLE؛ سكربت الماك يتعرف عليه بالعنوان ويشغّل opps_board(force=True) مباشرة
// (قراءة من الشيت وكتابة ملف اللوحة فقط). كل ضغطة = تشغيلة Claude على الماك، لذلك مهلة 15 دقيقة بين الطلبات.
const OPPS_REFRESH_TITLE = 'تحديث لوحة الفرص الآن';
const OPPS_REFRESH_GAP = 15 * 60000;
function oppsRefreshState() {
  const waiting = vault.notes.some((n) => n.path.startsWith('Inbox/') && n.path.includes(OPPS_REFRESH_TITLE) && /^status: (pending|working)$/m.test(n.text));
  if (waiting) return 'يتحدّث الآن… (دقائق)';
  const last = Number(store.get('opps.refreshAt') || 0);
  const left = OPPS_REFRESH_GAP - (Date.now() - last);
  return left > 0 ? `طُلب التحديث · متاح بعد ${Math.ceil(left / 60000)} د` : '';
}
async function oppsRefresh(btn) {
  if (oppsRefreshState()) { renderTasks(); return; }
  btn.disabled = true; btn.textContent = 'يُطلب…';
  try {
    await addToInbox({
      title: OPPS_REFRESH_TITLE,
      content: 'الوليد ضغط زر «حدّث» في تبويب الفرص: أعد كتابة لوحة الفرص (_System/Opportunities Board.md) الآن بنفس تحديثها المجدول.\nهذا الطلب ينفّذه سكربت الماك نفسه (opps_board) بالتعرف على العنوان. إن وصلك نصاً يا نيكست الكبير فمعناه أن السكربت لم يُحدَّث بعد: لا تكتب اللوحة بنفسك ولا تغيّر شيئاً، وأجب بسطر أن التحديث اليدوي غير مفعّل على الماك بعد.',
      kind: BIG_KIND, type: 'فعل',
    });
    store.set('opps.refreshAt', String(Date.now()));
    renderTasks();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function oppsRefreshRow(body, updated) { // سطر واحد: «آخر تحديث …» وبجانبه ↻؛ وحالة الطلب تُكتب نصاً على الزر («يتحدّث الآن…»، «متاح بعد n د»)
  const row = document.createElement('div');
  row.className = 'upd';
  const lab = document.createElement('span');
  lab.textContent = updated ? 'آخر تحديث: ' + updated : '';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'pill sm';
  const st = oppsRefreshState();
  btn.textContent = st || '↻';
  btn.setAttribute('aria-label', 'حدّث اللوحة');
  btn.disabled = !!st;
  btn.addEventListener('click', (ev) => { ev.preventDefault(); oppsRefresh(btn); });
  row.append(lab, btn);
  body.append(row);
}
// عرض مبسّط (2026-11-12): أرقام كبيرة أعلى اللوحة، بطاقة قصيرة لكل إعلان (الأزرار الثانوية خلف «⋯»)، والنتائج أرقاماً
// وشريط أسبوع، وبقية أقسام اللوحة مطوية تُفتح بالضغط على عنوانها. إن تعذّر فهم سطور «النتائج» تُعرض كما هي.
function uiEl(tag, cls, text) { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
function statTiles(list) {
  const row = uiEl('div', 'stats');
  if (!list.length) row.hidden = true;
  for (const [n, label] of list) { const t = uiEl('div', 'stat'); t.append(uiEl('b', '', String(n)), uiEl('span', '', label)); row.append(t); }
  return row;
}
function oppsResults(lines) { // «الفئة: أُرسل n · ردّ n · مقابلة n» + «تقديم مباشر: n» + «الأسبوع n من m»
  const out = { cats: [], sent: 0, replies: 0, interviews: 0, direct: null, week: null, rest: [] };
  for (const l of lines) {
    let m = l.match(/^(.+?):\s*أُرسل\s*(\d+)\s*·\s*ردّ\s*(\d+)\s*·\s*مقابلة\s*(\d+)/);
    if (m) { out.cats.push({ name: m[1].trim(), sent: +m[2], replies: +m[3], interviews: +m[4] }); out.sent += +m[2]; out.replies += +m[3]; out.interviews += +m[4]; continue; }
    m = l.match(/^تقديم مباشر:\s*(\d+)/);
    if (m) { out.direct = +m[1]; continue; }
    m = l.match(/^الأسبوع\s*(\d+)\s*من\s*(\d+)/);
    if (m) { out.week = [+m[1], +m[2]]; continue; }
    if (l && l !== 'لا شيء') out.rest.push(l);
  }
  return out.cats.length ? out : null;
}
function foldSection(body, title, lines) { // قسم مطوي: العنوان يفتحه ويغلقه
  const h = uiEl('div', 'grp fold', title + ' ▾');
  const ul = document.createElement('ul');
  ul.hidden = true;
  for (const l of (lines.length ? lines : ['لا شيء'])) ul.append(uiEl('li', 'plain', l));
  h.addEventListener('click', () => { ul.hidden = !ul.hidden; h.textContent = title + (ul.hidden ? ' ▾' : ' ▴'); });
  body.append(h, ul);
}
function oppsAdCard(x, cvs) {
  const li = uiEl('li', 'plain ad');
  const main = uiEl('div', 'main');
  const top = uiEl('div', 'ad-top');
  top.append(uiEl('span', 'ad-co', x.company));
  if (x.score) top.append(uiEl('span', 'badge', x.score));
  main.append(top, uiEl('div', 'meta-sm', x.role));
  const row = uiEl('div', 'choice');
  if (x.url) { const a = uiEl('a', 'pill sm', 'افتح الإعلان'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); }
  const btn = uiEl('button', 'pill sm', 'قدّمت');
  btn.type = 'button';
  btn.addEventListener('click', (ev) => { ev.preventDefault(); oppsMarkApplied(x, btn); });
  row.append(btn);
  const extra = uiEl('div', 'choice');
  extra.hidden = true;
  // السيرة الأنسب للمسمى ظاهرة على البطاقة (سطر تحت الأزرار)؛ باقي النسخ خلف «⋯» تحت «نسخة أخرى»
  // الأولوية لما اختارته مهمة الالتقاط (حقل «السيرة» في اللوحة، بالاسم كما في CV Links)؛ وإلا فبالكلمات المفتاحية للمسمى
  const norm2 = (s) => (s || '').toLowerCase().replace(/[^a-z\u0600-\u06ff]+/g, '');
  const picked = x.cv && x.cv !== '-' ? cvs.find((c) => norm2(c.name) === norm2(x.cv)) : null;
  const cv = picked || cvFor(x.role, cvs);
  const alt = picked && x.alt ? cvs.find((c) => c !== cv && norm2(c.name) === norm2(x.alt)) : null; // البديل يُعرض فقط مع اختيار المهمة
  const others = cvs.filter((c) => c !== cv && c !== alt);
  // باقي النسخ مجموعة في زر واحد يفتحها (خلف «⋯»)، حتى لا تملأ البطاقة
  const othersRow = uiEl('div', 'choice');
  othersRow.hidden = true;
  for (const c of others) othersRow.append(cvLink(c, c.name));
  let syncOthers = () => {};
  if (others.length) {
    const ob = uiEl('button', 'pill sm', '');
    ob.type = 'button';
    syncOthers = () => { ob.textContent = `نسخ أخرى (${others.length}) ${othersRow.hidden ? '▾' : '▴'}`; };
    syncOthers();
    ob.addEventListener('click', (ev) => { ev.preventDefault(); othersRow.hidden = !othersRow.hidden; syncOthers(); });
    extra.append(ob);
  }
  const badBtn = uiEl('button', 'pill sm', 'الرابط لا يعمل');
  badBtn.type = 'button';
  badBtn.addEventListener('click', (ev) => { ev.preventDefault(); oppsBadLink(x, badBtn); });
  extra.append(badBtn);
  const skipRow = uiEl('div', 'choice');
  skipRow.hidden = true;
  skipRow.append(uiEl('span', 'meta-sm', 'لماذا؟'));
  for (const r of OPPS_SKIP_REASONS) {
    const rb = uiEl('button', 'pill sm', r);
    rb.type = 'button';
    rb.addEventListener('click', (ev) => { ev.preventDefault(); oppsSkip(x, r, rb); });
    skipRow.append(rb);
  }
  const skipBtn = uiEl('button', 'pill sm', 'لا أريد التقديم');
  skipBtn.type = 'button';
  skipBtn.addEventListener('click', (ev) => { ev.preventDefault(); skipRow.hidden = !skipRow.hidden; skipBtn.classList.toggle('on', !skipRow.hidden); });
  extra.append(skipBtn);
  const more = uiEl('button', 'pill sm', '⋯');
  more.type = 'button';
  more.addEventListener('click', (ev) => { ev.preventDefault(); extra.hidden = !extra.hidden; if (extra.hidden) { othersRow.hidden = true; syncOthers(); skipRow.hidden = true; skipBtn.classList.remove('on'); } });
  row.append(more);
  main.append(row);
  if (cv) { // زر بشكل باقي الأزرار (لا رابط نصي مسطَّر): تسمية صغيرة ثم اسم النسخة
    const best = cvLink(cv, '');
    best.className = 'pill sm cv-best';
    const name = document.createElement('bdi');
    name.textContent = cv.name;
    best.append(uiEl('span', 'cv-label', picked ? 'السيرة الأنسب' : 'السيرة (من المسمى)'), name);
    const cvRow = uiEl('div', 'choice');
    cvRow.append(best);
    if (alt) {
      const a2 = cvLink(alt, '');
      a2.className = 'pill sm cv-best cv-alt';
      const n2 = document.createElement('bdi');
      n2.textContent = alt.name;
      a2.append(uiEl('span', 'cv-label', 'أو'), n2);
      cvRow.append(a2);
    }
    main.append(cvRow);
    if (alt && x.altWhy) main.append(uiEl('div', 'meta-sm', `البديل: ${x.altWhy}`));
  }
  main.append(extra, othersRow, skipRow, uiEl('div', 'meta-sm ad-id', x.id));
  li.append(main);
  return li;
}
function renderOpps(body, empty) {
  const b = oppsBoard();
  if (!b) { empty('لوحة الفرص لم تُجهَّز بعد (ملف «Opportunities Board» غير موجود في الـ Vault).'); try { renderDrafts(body); } catch (e) { /* العرض اختياري */ } return; }
  const applySec = b.sections.find(oppsIsApply);
  const ads = applySec ? oppsApplyItems(applySec) : [];
  const resSec = b.sections.find((x) => x.title.startsWith('النتائج'));
  let res = null;
  try { res = resSec ? oppsResults(resSec.lines) : null; } catch (e) { res = null; }
  let draftsN = 0;
  try { draftsN = outreachDrafts().length; } catch (e) { /* لا مسودات */ }
  const tiles = [[draftsN, 'رسائل تنتظرك'], [ads.length, 'إعلانات']];
  if (res) tiles.push([res.sent, 'أُرسل'], [res.replies, 'ردود']);
  body.append(statTiles(tiles));
  try { oppsRefreshRow(body, b.updated); } catch (e) { if (b.updated) empty('آخر تحديث: ' + b.updated); }
  try { renderDrafts(body); } catch (e) { empty('تعذّر عرض الرسائل: ' + (e?.message || e)); }
  body.append(uiEl('div', 'grp', 'قدّم على الإعلانات'));
  const ul = document.createElement('ul');
  const cvs = cvLinks();
  for (const x of ads) ul.append(oppsAdCard(x, cvs));
  if (!ads.length) ul.append(uiEl('li', 'plain', 'لا إعلانات تنتظر تقديمك.'));
  body.append(ul);
  if (res) {
    body.append(uiEl('div', 'grp', 'النتائج'));
    const t2 = [[res.interviews, 'مقابلات']];
    if (res.direct != null) t2.push([res.direct, 'تقديم مباشر']);
    body.append(statTiles(t2));
    if (res.week) {
      const wrap = uiEl('div', 'goal');
      wrap.style.cursor = 'default';
      wrap.append(uiEl('div', 'meta-sm', `الأسبوع ${res.week[0]} من ${res.week[1]}`));
      const bar = uiEl('div', 'goal-bar'), fill = uiEl('div', 'goal-fill');
      fill.style.width = Math.max(2, Math.min(100, Math.round((res.week[0] / res.week[1]) * 100))) + '%';
      bar.append(fill);
      wrap.append(bar);
      body.append(wrap);
    }
    foldSection(body, 'حسب القناة', [...res.cats.map((c) => `${c.name}: أُرسل ${c.sent} · ردّ ${c.replies} · مقابلة ${c.interviews}`), ...res.rest]);
  }
  for (const sec of b.sections) {
    if (sec === applySec || (res && sec === resSec)) continue;
    foldSection(body, sec.title, oppsReal(sec.lines));
  }
}
// ---------- تبويب «البراند»: أفكار المحتوى (اعتمد / ارفض / عدّل) ----------
// المصدر: قسم «أفكار محتوى جديدة» في _System/Pending Approvals.md (يكتبه سكربت الماك كل ساعتين). شكل السطر:
//   - صف <ن>: <الفكرة بجملة قصيرة> — <السلسلة> · <المنصة> | <أول 60 حرفاً من نص الفكرة الأصلي في الشيت>
// الشيت بلا معرّف ثابت للصف، فالقرار يحمل رقم الصف وأول الفكرة، ونيكست الكبير لا يكتب إلا إن تطابقا مع حالة «بانتظار الموافقة».
// سطر بلا « | أولها» (سكربت الماك لم يُحدَّث بعد) يُعرض للقراءة فقط. القرارات تُجمع على الشاشة ثم تُرسل في طلب «فعل» واحد:
// اعتمد ← `معتمدة`، ارفض ← `مرفوضة`، عدّل ← إعادة صياغة الفكرة في مكانها مع ملاحظة، وتبقى بانتظار الموافقة.
const APPROVALS_FILE = '_System/Pending Approvals.md';
const BRAND_SHEET = '1L--CVxVw1GzTHjMQypOhK80-v0NrKYwoVJOw2xhKses';
const BRAND_REFRESH_TITLE = 'تحديث ما ينتظر اعتمادي الآن';
let brandTalk = null; // الفكرة التي يناقشها الوليد مع نيكست الآن: { key, row, tags, full, text }
const ideaAsk = () => {
  const x = brandTalk;
  return `هذه فكرة محتوى للبراند الشخصي تنتظر قراره في الشيت (صف ${x.row}${x.tags.length ? '، ' + x.tags.join('، ') : ''}): «${x.full || x.text}». هو يريد أن يفهمها أو يناقشها ليصل إلى تعديل أنسب. قل له بجملتين ما الفكرة وزاويتها، واسأله ما الذي يريد تغييره. ناقشه باختصار، واقترح صياغة أو زاوية بديلة إن طلب. حين يستقر على تعديل، صُغه «ملاحظة تعديل» واضحة من جملة أو جملتين تقول ما الذي يتغير في الفكرة بالضبط، واستدعِ idea_edit_note بها، ثم قل له إنها في بطاقة الفكرة في تبويب «البراند» ليراجعها ويرسلها. لا تستدعِ ask_big_next لهذا، ولا تغيّر شيئاً في الشيت، ولا تعتمد الفكرة ولا ترفضها: القرار يرسله هو من التبويب.`;
};
const brandStaged = new Map(); // key ← { act: 'approve' | 'reject' | 'edit', note } — في الذاكرة فقط حتى الإرسال
function brandActed() { // ما أُرسل قراره يختفي فوراً، وحتى 24 ساعة إن تأخر الماك
  let o = {};
  try { o = JSON.parse(store.get('brand.acted') || '{}'); } catch { o = {}; }
  const now = Date.now();
  for (const k of Object.keys(o)) if (now - o[k] > 24 * 3600 * 1000) delete o[k];
  return o;
}
function brandData() {
  const n = vault.byPath.get(APPROVALS_FILE);
  if (!n) return null;
  const count = (head) => { const m = n.text.match(new RegExp('^## ' + head + ' \\((\\d+)\\)', 'm')); return m ? +m[1] : 0; };
  const acted = brandActed();
  const ideas = mdSection(n.text, '## أفكار محتوى جديدة').split('\n').filter((l) => /^- صف \d+:/.test(l)).map((l) => {
    const row = +l.match(/^- صف (\d+):/)[1];
    let rest = l.replace(/^- صف \d+:\s*/, '');
    let snip = '';
    const bar = rest.lastIndexOf(' | ');
    let full = '';
    if (bar !== -1) { full = rest.slice(bar + 3).trim(); snip = Array.from(full).slice(0, 60).join('').trim(); rest = rest.slice(0, bar); }
    const dash = rest.lastIndexOf(' — ');
    const text = (dash === -1 ? rest : rest.slice(0, dash)).trim();
    const tags = dash === -1 ? [] : rest.slice(dash + 3).split(' · ').map((x) => x.trim()).filter(Boolean);
    return { row, text, tags, snip, full, key: `${row}|${snip || text}` };
  }).filter((x) => !acted[x.key]);
  return { ideas, drafts: count('مسودات تنتظر مراجعتك'), designs: count('تصاميم تنتظر مراجعتك'), updated: (n.text.match(/^آخر تحديث:\s*(.+?)\.?\s*$/m) || [])[1] || '' };
}
// ردود نيكست الكبير على قرارات الأفكار خلال آخر 24 ساعة (ملفات الطلب في Inbox/ تبقى 24 ساعة بعد الرد ثم تُؤرشف):
// ما تم، وما لم يتم ولماذا — حتى لا يعتمد الوليد على تيليجرام ليعرف أن تعديلاً رُفض.
function brandReplies() {
  const out = [];
  const word = { 'اعتمد': 'اعتُمدت', 'ارفض': 'رُفضت', 'عدّل': 'عُدّلت' };
  for (const n of vault.notes) {
    if (!n.path.startsWith('Inbox/') || n.path.startsWith('Inbox/_') || !n.path.includes('أفكار المحتوى') || !n.text.includes(`kind: ${BIG_KIND}`)) continue;
    const f = (k) => (n.text.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1] || '';
    const status = f('status');
    const at = Date.parse((f('answered') || f('created')).replace(' ', 'T') + ':00+03:00');
    if (Number.isFinite(at) && Date.now() - at > 24 * 3600 * 1000) continue;
    // القرارات كما أُرسلت: «- اعتمد | صف 65 | أولها: … [| الملاحظة: …]»
    const decs = [...n.text.matchAll(/^- (اعتمد|ارفض|عدّل) \| صف (\d+) \| أولها: (.*?)(?: \| الملاحظة: .*)?$/gm)].map((m) => ({ act: m[1], row: +m[2], snip: m[3].trim() }));
    if (!decs.length) continue;
    const wait = status === 'pending' || status === 'working';
    const m = n.text.match(/\n## (ردّ نيكست الكبير|فشل التنفيذ)\n([\s\S]*?)(?=\n## |$)/);
    const reply = m ? m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : [];
    const marks = reply.filter((l) => /^[✅❌]/.test(l));
    const failedAll = (m && m[1] === 'فشل التنفيذ') || status === 'failed';
    decs.forEach((d, i) => {
      // علامة كل قرار من سطره في الرد إن تساوى العددان؛ وإلا فأي ❌ في الرد يجعل قرارات الطلب كلها «تحقق»
      const mark = marks.length === decs.length ? marks[i] : '';
      const bad = !wait && (failedAll || (mark ? mark.startsWith('❌') : marks.some((l) => l.startsWith('❌')) || !m));
      out.push({ at: at || 0, wait, bad, act: d.act, done: word[d.act], row: d.row, snip: d.snip, why: bad ? (mark || reply[0] || 'لا رد واضح من نيكست الكبير.').replace(/^❌\s*/, '') : '', full: bad ? reply : [] });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}
// عرض مختصر: سطر ملخص واحد (اعتماد n · رفض n · تعديل n). ما لم يُنفَّذ يظهر تحته بسطر واحد يُفتح بالضغط لقراءة السبب كاملاً؛
// وما تم يظهر سطراً قصيراً لكل قرار عند الضغط على الملخص فقط.
function renderBrandReplies(body) {
  const list = brandReplies();
  if (!list.length) return;
  const ok = list.filter((x) => !x.bad && !x.wait);
  const bad = list.filter((x) => x.bad);
  const waiting = list.filter((x) => x.wait);
  const c = (a) => ok.filter((x) => x.act === a).length;
  const sum = [c('اعتمد') && `اعتماد ${c('اعتمد')}`, c('ارفض') && `رفض ${c('ارفض')}`, c('عدّل') && `تعديل ${c('عدّل')}`].filter(Boolean).join(' · ');
  const h = uiEl('div', 'grp fold replies');
  h.append(uiEl('span', '', 'آخر 24 ساعة' + (sum ? ': ' + sum + ' ✓' : '')));
  if (waiting.length) h.append(uiEl('span', 'chip', `يُنفَّذ الآن ${waiting.length}`));
  if (bad.length) h.append(uiEl('span', 'chip warn', `لم يُنفَّذ ${bad.length}`));
  const arrow = uiEl('span', 'arrow', ok.length ? ' ▾' : '');
  h.append(arrow);
  body.append(h);
  const short = (x) => `صف ${x.row} · ${clip(x.snip, 38)}`;
  if (bad.length) {
    const ul = document.createElement('ul');
    for (const x of bad) {
      const li = uiEl('li', 'row plain reply bad');
      const main = uiEl('div', 'main');
      main.append(uiEl('div', 't', `✕ لم ${x.act === 'اعتمد' ? 'تُعتمد' : x.act === 'ارفض' ? 'تُرفض' : 'تُعدَّل'} · ${short(x)}`));
      const more = uiEl('div', 'meta-sm', x.full.join('\n'));
      more.hidden = true; more.style.whiteSpace = 'pre-wrap';
      main.append(uiEl('div', 'meta-sm why', x.why), more);
      li.append(main);
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { more.hidden = !more.hidden; li.classList.toggle('open', !more.hidden); });
      ul.append(li);
    }
    body.append(ul);
  }
  if (ok.length) {
    const ul = document.createElement('ul');
    ul.hidden = true;
    for (const x of ok) ul.append(uiEl('li', 'plain reply', `✓ ${x.done} · ${short(x)}`));
    h.addEventListener('click', () => { ul.hidden = !ul.hidden; arrow.textContent = ul.hidden ? ' ▾' : ' ▴'; });
    body.append(ul);
  } else h.style.cursor = 'default';
}
// لوحة البراند (المرحلة 4): _System/Brand Board.md ملف تلقائي من شيت المحتوى (يكتبه سكربت الماك مع «ما ينتظر اعتمادي»).
// متابعة وروابط فقط: المسودات والتصاميم تُعتمد في جلساتها (النص ليس في الشيت قبل الاعتماد)، فالأزرار هنا تفتح الجلسة أو المعاينة.
// شكل الملف — أقسام «## عنوان» تحتها أسطر، والفاصل « | »، والحقل الفارغ «-»:
//   ## راجع المسودات / ## راجع التصاميم / ## ينتظر منك:  - صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <ملاحظة قصيرة> | <رابط الجلسة> | <رابط التصميم أو المعاينة>
//   ## مجدول:  - صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <الموعد>
//   ## نُشر هذا الأسبوع:  - <المنصة>: <ن> من <الهدف>
const BRAND_BOARD_FILE = '_System/Brand Board.md';
const BRAND_ACTION_SECTIONS = ['راجع المسودات', 'راجع التصاميم', 'ينتظر منك'];
function brandBoard() {
  const n = vault.byPath.get(BRAND_BOARD_FILE);
  if (!n) return null;
  const sec = (title) => mdSection(n.text, '## ' + title).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l && l !== 'لا شيء');
  const link = (x) => (/^https:\/\/\S+$/.test(x || '') ? x : '');
  const item = (l) => { const p = l.split(' | ').map((x) => x.trim()); return { row: (p[0] || '').replace(/^صف\s*/, ''), platform: p[1] || '', text: p[2] || '', note: p[3] && p[3] !== '-' ? p[3] : '', session: link(p[4]), design: link(p[5]) }; };
  const out = { actions: BRAND_ACTION_SECTIONS.map((title) => ({ title, items: sec(title).map(item) })) };
  out.scheduled = sec('مجدول').map((l) => { const p = l.split(' | ').map((x) => x.trim()); return { row: (p[0] || '').replace(/^صف\s*/, ''), platform: p[1] || '', text: p[2] || '', when: p[3] || '' }; });
  out.week = sec('نُشر هذا الأسبوع').map((l) => l.match(/^(.+?):\s*(\d+)\s*من\s*(\d+)/)).filter(Boolean).map((m) => ({ name: m[1].trim(), n: +m[2], of: +m[3] }));
  return out;
}
function renderBrandBoard(body, b) {
  for (const s of b.actions) {
    if (!s.items.length) continue;
    body.append(uiEl('div', 'grp', `${s.title} · ${s.items.length}`));
    const ul = document.createElement('ul');
    for (const x of s.items) {
      const li = uiEl('li', 'row plain idea');
      const main = uiEl('div', 'main');
      const t = uiEl('div', 't', x.text);
      t.style.cursor = 'pointer';
      t.addEventListener('click', () => li.classList.toggle('open'));
      const chips = uiEl('div', 'chips');
      if (x.row) chips.append(uiEl('span', 'chip', `صف ${x.row}`));
      if (x.platform) chips.append(uiEl('span', 'chip', x.platform));
      main.append(t, chips);
      if (x.note) main.append(uiEl('div', 'meta-sm', x.note));
      const row = uiEl('div', 'choice');
      const a = (label, url) => { const e = uiEl('a', 'pill sm', label); e.href = url; e.target = '_blank'; e.rel = 'noopener noreferrer'; return e; };
      if (x.session) row.append(a('افتح الجلسة', x.session));
      if (x.design) row.append(a('شاهد التصميم', x.design));
      if (row.children.length) main.append(row); else main.append(uiEl('div', 'meta-sm', 'لا رابط مسجّلاً في الشيت: افتح جلسة المهمة من Claude.'));
      li.append(main);
      ul.append(li);
    }
    body.append(ul);
  }
  if (b.week.length) {
    body.append(uiEl('div', 'grp', 'نُشر هذا الأسبوع'));
    for (const w of b.week) {
      const wrap = uiEl('div', 'goal');
      wrap.style.cursor = 'default';
      wrap.append(uiEl('div', 'meta-sm', `${w.name}: ${w.n} من ${w.of}`));
      const bar = uiEl('div', 'goal-bar'), fill = uiEl('div', 'goal-fill');
      fill.style.width = (w.of > 0 ? Math.max(2, Math.min(100, Math.round((w.n / w.of) * 100))) : 2) + '%';
      bar.append(fill);
      wrap.append(bar);
      body.append(wrap);
    }
  }
  if (b.scheduled.length) foldSection(body, `مجدول · ${b.scheduled.length}`, b.scheduled.map((x) => `${x.when} · ${x.platform} · ${x.text}`));
}
function brandCount() { // ما يحتاج فعلاً منه: أفكار تنتظر قراره + مسودات وتصاميم وما ينتظر منه في لوحة البراند
  try { const b = brandBoard(); return (brandData()?.ideas.length || 0) + (b ? b.actions.reduce((s, x) => s + x.items.length, 0) : 0); } catch { return 0; }
}
function brandRequest(list) { // list: [{ idea, act, note }]
  const word = { approve: 'اعتمد', reject: 'ارفض', edit: 'عدّل' };
  const lines = list.map(({ idea, act, note }) => `- ${word[act]} | صف ${idea.row} | أولها: ${idea.snip}${act === 'edit' ? ` | الملاحظة: ${note.replace(/\s+/g, ' ').trim()}` : ''}`);
  const n = (a) => list.filter((x) => x.act === a).length;
  const title = 'أفكار المحتوى: ' + [n('approve') && `اعتمد ${n('approve')}`, n('reject') && `ارفض ${n('reject')}`, n('edit') && `عدّل ${n('edit')}`].filter(Boolean).join('، ');
  const content = `قرارات الوليد على أفكار المحتوى من تبويب «البراند» في التطبيق (أكّدها بالضغط). طلب واحد لكل القرارات.
الشيت: My Social Media Calendar (${BRAND_SHEET})، تبويب «نظام إدارة البراندينج». الأعمدة: B فكرة المحتوى، H حالة النشر، M ملاحظات.
لكل سطر أدناه اقرأ الصف المذكور وتحقق من شرطين معاً قبل أي كتابة: (1) حالته في H هي \`فكرة جديدة - بانتظار الموافقة\` حرفياً، (2) نص الفكرة في B يبدأ بالنص المكتوب بعد «أولها:» حرفياً. إن اختل أحدهما (أُدرج صف فتغيّرت الأرقام، أو تغيّرت الحالة) فلا تكتب شيئاً في ذلك الصف ولا تبحث عن الفكرة في صف آخر، وأبلغ.
- اعتمد ← H = \`معتمدة\`.
- ارفض ← H = \`مرفوضة\`.
- عدّل ← أعد كتابة B حسب الملاحظة (بالأسلوب واللهجة نفسيهما)، واترك H كما هي، وأضف في آخر M سطراً «عُدّلت الفكرة <تاريخ اليوم> بطلب الوليد: <الملاحظة>» دون مسح الموجود.
لا تكتب في أي عمود أو صف آخر، ولا تضع \`معتمد للنشر\` أبداً. في ردك سطر لكل صف: ما تم، أو لماذا لم يتم.

${lines.join('\n')}`;
  return { title, content };
}
async function brandSend(btn, ideas) {
  const list = ideas.filter((x) => x.snip && brandStaged.has(x.key)).map((x) => ({ idea: x, ...brandStaged.get(x.key) }));
  if (!list.length) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const req = brandRequest(list);
    await addToInbox({ title: req.title, content: req.content, kind: BIG_KIND, type: 'فعل' });
    const o = brandActed();
    for (const { idea } of list) { o[idea.key] = Date.now(); brandStaged.delete(idea.key); }
    store.set('brand.acted', JSON.stringify(o));
    renderTasks();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function brandRefreshState() {
  const waiting = vault.notes.some((n) => n.path.startsWith('Inbox/') && n.path.includes(BRAND_REFRESH_TITLE) && /^status: (pending|working)$/m.test(n.text));
  if (waiting) return 'يتحدّث الآن… (دقائق)';
  const left = OPPS_REFRESH_GAP - (Date.now() - Number(store.get('brand.refreshAt') || 0));
  return left > 0 ? `طُلب التحديث · متاح بعد ${Math.ceil(left / 60000)} د` : '';
}
async function brandRefresh(btn) {
  if (brandRefreshState()) { renderTasks(); return; }
  btn.disabled = true; btn.textContent = 'يُطلب…';
  try {
    await addToInbox({
      title: BRAND_REFRESH_TITLE,
      content: 'الوليد ضغط زر «حدّث» في تبويب البراند: أعد كتابة _System/Pending Approvals.md الآن بنفس تحديثه المجدول.\nهذا الطلب ينفّذه سكربت الماك نفسه (snapshot_approvals) بالتعرف على العنوان. إن وصلك نصاً يا نيكست الكبير فمعناه أن السكربت لم يُحدَّث بعد: لا تكتب الملف بنفسك ولا تغيّر شيئاً، وأجب بسطر أن التحديث اليدوي غير مفعّل على الماك بعد.',
      kind: BIG_KIND, type: 'فعل',
    });
    store.set('brand.refreshAt', String(Date.now()));
    renderTasks();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function renderBrand(body, empty) {
  const d = brandData();
  if (!d) { empty('قائمة الاعتمادات لم تُجهَّز بعد (ملف «Pending Approvals» غير موجود في الـ Vault).'); return; }
  let board = null;
  try { board = brandBoard(); } catch (e) { board = null; }
  const nDrafts = board ? board.actions[0].items.length : d.drafts;
  const nDesigns = board ? board.actions[1].items.length : d.designs;
  body.append(statTiles([[d.ideas.length, 'أفكار تنتظرك'], [nDrafts, 'مسودات'], [nDesigns, 'تصاميم'], [board ? board.scheduled.length : 0, 'مجدول']].filter(([n], i) => i === 0 || n > 0)));
  const ready = d.ideas.some((x) => x.snip); // سكربت الماك يكتب «أولها» ← الأزرار وزر التحديث يعملان
  const upd = uiEl('div', 'upd');
  upd.append(uiEl('span', '', d.updated ? 'آخر تحديث: ' + d.updated : ''));
  if (ready) {
    const st = brandRefreshState();
    const rb = uiEl('button', 'pill sm', st || '↻');
    rb.type = 'button'; rb.disabled = !!st; rb.setAttribute('aria-label', 'حدّث القائمة');
    rb.addEventListener('click', (ev) => { ev.preventDefault(); brandRefresh(rb); });
    upd.append(rb);
  }
  body.append(upd);
  try { renderBrandReplies(body); } catch (e) { /* القسم اختياري */ }
  if (board) { try { renderBrandBoard(body, board); } catch (e) { empty('تعذّر عرض لوحة البراند: ' + (e?.message || e)); } }
  if (board && d.ideas.length) body.append(uiEl('div', 'grp', `اعتمد الأفكار · ${d.ideas.length}`));
  if (!d.ideas.length) { empty('لا أفكار تنتظر قرارك.'); return; }
  if (!ready) empty('للقراءة فقط الآن: أزرار الاعتماد تعمل بعد تحديث سكربت الماك.');
  for (const k of [...brandStaged.keys()]) if (!d.ideas.some((x) => x.key === k)) brandStaged.delete(k);
  const bar = uiEl('div', 'choice sendbar');
  const send = uiEl('button', 'pill sm', '');
  send.type = 'button';
  send.addEventListener('click', (ev) => { ev.preventDefault(); brandSend(send, d.ideas); });
  const all = uiEl('button', 'pill sm', '');
  all.type = 'button';
  const sync = () => {
    const vals = [...brandStaged.values()];
    const c = (a) => vals.filter((v) => v.act === a).length;
    send.hidden = !vals.length;
    send.classList.toggle('go', vals.length > 0);
    send.textContent = 'أرسل: ' + [c('approve') && `اعتماد ${c('approve')}`, c('reject') && `رفض ${c('reject')}`, c('edit') && `تعديل ${c('edit')}`].filter(Boolean).join(' · ');
    all.textContent = vals.length ? 'ألغِ التحديد' : 'حدّد الكل للاعتماد';
  };
  all.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (brandStaged.size) brandStaged.clear(); else for (const x of d.ideas) if (x.snip) brandStaged.set(x.key, { act: 'approve', note: '' });
    renderTasks();
  });
  if (ready) { bar.append(send, all); body.append(bar); }
  const ul = document.createElement('ul');
  for (const x of d.ideas) {
    const li = uiEl('li', 'row plain idea');
    const main = uiEl('div', 'main');
    const t = uiEl('div', 't', x.text);
    const chips = uiEl('div', 'chips');
    chips.append(uiEl('span', 'chip', `صف ${x.row}`));
    for (const g of x.tags) chips.append(uiEl('span', 'chip', g));
    const st = brandStaged.get(x.key);
    if (st) chips.append(uiEl('span', 'chip ' + (st.act === 'approve' ? 'ok' : 'warn'), st.act === 'approve' ? 'سيُعتمد' : st.act === 'reject' ? 'سيُرفض' : 'سيُعدَّل'));
    main.append(t, chips);
    if (st?.act === 'edit') main.append(uiEl('div', 'meta-sm', 'التعديل: ' + st.note));
    const more = uiEl('div', 'more');
    more.hidden = true;
    // أقصر من 60 حرفاً = الشكل القديم (أول النص فقط): لا يُعرض كنص كامل
    if (Array.from(x.full || '').length > 60) { const f = uiEl('div', 'draft', x.full); f.dir = 'auto'; more.append(f); }
    const talk = uiEl('div', 'choice');
    more.append(talk);
    main.append(more);
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => {
      more.hidden = !more.hidden; li.classList.toggle('open', !more.hidden);
      if (more.hidden) return;
      const mkT = (label, fn) => { const b = uiEl('button', 'pill sm', label); b.type = 'button'; b.addEventListener('click', (e) => { e.preventDefault(); brandTalk = { key: x.key, row: x.row, tags: x.tags, full: x.full, text: x.text }; fn(); }); return b; };
      if (call.session) talk.replaceChildren(mkT('ناقشها الآن', () => askAbout(x.text, 'idea')));
      else if (call.active) talk.replaceChildren();
      else talk.replaceChildren(mkT('📞 اتصال', () => askAbout(x.text, 'idea')), ...(chatOn() ? [mkT('💬 شات', () => chatAbout(x.text, 'idea'))] : []));
    });
    if (x.snip) {
      const row = uiEl('div', 'choice');
      const mk = (label, fn, on) => { const b = uiEl('button', 'pill sm' + (on ? ' on' : ''), label); b.type = 'button'; b.addEventListener('click', (ev) => { ev.preventDefault(); fn(); }); return b; };
      const stage = (act) => { if (brandStaged.get(x.key)?.act === act) brandStaged.delete(x.key); else brandStaged.set(x.key, { act, note: '' }); renderTasks(); };
      const editRow = uiEl('div', 'choice');
      editRow.hidden = true;
      const input = document.createElement('input');
      input.className = 'draft-edit'; input.placeholder = 'اكتب التعديل المطلوب على الفكرة…'; input.dir = 'auto';
      if (st?.act === 'edit') { input.value = st.note; editRow.hidden = false; } // ملاحظة جاءت من النقاش أو كُتبت: تُراجَع وتُعدَّل هنا
      editRow.append(input, mk('أضف التعديل', () => { const note = input.value.trim(); if (!note) return; brandStaged.set(x.key, { act: 'edit', note }); renderTasks(); }));
      row.append(mk('اعتمد', () => stage('approve'), st?.act === 'approve'), mk('ارفض', () => stage('reject'), st?.act === 'reject'), mk('⋯', () => { editRow.hidden = !editRow.hidden; if (!editRow.hidden) input.focus(); }));
      main.append(row, editRow);
    }
    li.append(main);
    ul.append(li);
  }
  body.append(ul);
  sync();
}
// ---------- تبويب «أهدافي»: هدف الربع والعادات ----------
// الهدف من ملف الربع النشط في Strategy/ (type: quarter، status: active)، والعادات من Strategy/سجل العادات.md:
//   قسم «## العادات»: - الاسم | أسبوعي أو شهري | العدد المطلوب | الوصف      قسم «## السجل»: - YYYY-MM-DD | الاسم | تم
// زر «تم» يكتب طلباً عنوانه «عادة: <الاسم> تم <التاريخ>»؛ سكربت الماك يضيف سطر السجل مباشرة (وإن وصل لنيكست الكبير نصاً
// فنص الطلب يكفيه). الضغطة تُحفظ في الهاتف فوراً حتى يصل السطر عبر المزامنة. الأسبوع من السبت إلى الجمعة.
const HABITS_FILE = 'Strategy/سجل العادات.md';
function mdSection(text, head) {
  const i = text.indexOf('\n' + head);
  if (i === -1) return '';
  const j = text.indexOf('\n## ', i + head.length);
  return text.slice(i, j === -1 ? undefined : j);
}
const unlink = (x) => x.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/\*\*/g, '');
function activeQuarter() {
  const n = vault.notes.find((x) => x.path.startsWith('Strategy/') && /^type: quarter$/m.test(x.text) && /^status: active$/m.test(x.text));
  if (!n) return null;
  const goals = mdSection(n.text, '## الأهداف').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((r) => {
    const c = r.split('|').slice(1, -1).map((x) => unlink(x.trim()));
    return { goal: c[1] || '', target: c[3] || '', start: c[4] || '', now: c[5] || '', state: c[7] || '' };
  });
  return { title: unlink((n.text.match(/^# (.+)$/m) || [])[1] || ''), end: (n.text.match(/^period:.*?(\d{4}-\d{2}-\d{2})\s*$/m) || [])[1] || '', goals };
}
function habitsLocal() {
  try { return JSON.parse(store.get('habits.done') || '[]').filter((x) => x && x.date && x.name); } catch { return []; }
}
function habitsData() {
  const n = vault.byPath.get(HABITS_FILE);
  if (!n) return null;
  const defs = mdSection(n.text, '## العادات').split('\n').filter((l) => l.startsWith('- ')).map((l) => {
    const [name = '', rhythm = '', need = '', desc = ''] = l.slice(2).split(' | ').map((x) => x.trim());
    return { name, monthly: rhythm === 'شهري', need: Math.max(1, parseInt(need, 10) || 1), desc };
  }).filter((h) => h.name);
  const log = mdSection(n.text, '## السجل').split('\n').map((l) => l.match(/^- (\d{4}-\d{2}-\d{2}) \| (.+?) \| تم/)).filter(Boolean).map((m) => ({ date: m[1], name: m[2].trim() }));
  const seen = new Set();
  const all = [...log, ...habitsLocal()].filter((x) => { const k = x.date + '|' + x.name; if (seen.has(k)) return false; seen.add(k); return true; });
  return { defs, log: all };
}
function weekStart(date) { // السبت الذي يبدأ به أسبوع هذا التاريخ
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}
function habitState(h, log, today) {
  const mine = log.filter((x) => x.name === h.name).map((x) => x.date);
  const from = h.monthly ? today.slice(0, 8) + '01' : weekStart(today);
  return { count: mine.filter((d) => d >= from && d <= today).length, today: mine.includes(today) };
}
async function habitMark(h, btn) {
  const { date } = riyadhNow();
  btn.disabled = true; btn.textContent = '…';
  try {
    await addToInbox({
      title: `عادة: ${h.name} تم ${date}`,
      content: `الوليد ضغط «تم» لعادة «${h.name}» يوم ${date} في تبويب «أهدافي».\nأضف في ${HABITS_FILE} في آخر قسم «## السجل» سطراً واحداً بهذا الشكل حرفياً: - ${date} | ${h.name} | تم\nإن كان السطر موجوداً فلا تكرره. لا تغيّر أي شيء آخر في الملف ولا في غيره، ولا تكتب في Open Loops.\n(هذا الطلب ينفّذه سكربت الماك مباشرة بالتعرف على العنوان «عادة:»؛ إن وصلك نصاً يا نيكست الكبير فنفّذه كما هو بسطر تأكيد واحد.)`,
      kind: BIG_KIND, type: 'فعل',
    });
    const cut = new Date(Date.parse(date) - 40 * 864e5).toISOString().slice(0, 10); // يكفي لعدّاد الأسبوع والشهر
    const keep = habitsLocal().filter((x) => x.date >= cut);
    store.set('habits.done', JSON.stringify([...keep, { date, name: h.name }]));
    renderTasks();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'تعذّر — أعد المحاولة';
  }
}
function goalsPending() { // عادات لم تكتمل لفترتها ولم تُسجَّل اليوم
  try {
    const hd = habitsData();
    if (!hd) return 0;
    const { date } = riyadhNow();
    return hd.defs.filter((h) => { const st = habitState(h, hd.log, date); return st.count < h.need && !st.today; }).length;
  } catch { return 0; }
}
// خصوصية الأرقام: التطبيق قد يُعرض على الناس، فأرقام الهدف (الدخل) والمبالغ مخفية افتراضياً عند كل فتح.
// زر «إظهار الأرقام» يكشفها لهذه الجلسة فقط (لا يُحفظ)، وزر «إخفاء» يعيدها.
const maskNums = (x) => (moneyShown ? x : (x || '').replace(/\d[\d,.]*/g, '•••'));
const maskMoney = (x) => (moneyShown ? x : (x || '').replace(/\d[\d,.]*(?=\s*(ر\.س|ريال|دولار|\$|SAR|USD))/g, '•••'));
// بند فيه مبلغ بعملة: تُخفى مبالغه، ومعها أي رقم آخر من ثلاث خانات فأكثر في البند نفسه (مبلغ بلا عملة غالباً). غيره يبقى كما هو.
const MONEY_RE = /\d[\d,.]*(?=\s*(ر\.س|ريال|دولار|\$|SAR|USD))/;
const maskItem = (x) => (moneyShown || !MONEY_RE.test(x || '') ? x : maskMoney(x).replace(/\d{1,3}(?:,\d{3})+|\d{3,}/g, '•••'));
// بنود البحث عن فرص: كانت تُخفى في وضع العرض؛ بقرار الوليد (2026-11-12) صارت ظاهرة دائماً، ووضع العرض يخفي الأرقام والمبالغ فقط.
// لإعادة الإخفاء: HIDE_SEARCH = true (يخفي بطاقة الفرص وبنودها ورقمها و«إيميلات تواصل» ونص هدف الربع).
const HIDE_SEARCH = false;
const SECRET_RE = /البحث عن فرص|فرص جديدة|وظيف|السيرة الذاتية|مقابلة عمل/;
function demoFilter(list) {
  if (moneyShown || !HIDE_SEARCH) return list;
  return list.filter((x) => { if (SECRET_RE.test(x)) return false; try { return !SECRET_RE.test(projectOf(x)); } catch { return true; } });
}
function applyDemoChrome() { // زر العين وسطر التكلفة
  const eye = document.getElementById('eyeBtn');
  if (eye) { eye.classList.toggle('on', moneyShown); eye.setAttribute('aria-pressed', String(moneyShown)); }
  try { ui.cost.style.visibility = !moneyShown && settings().tasksPanel !== 'off' ? 'hidden' : ''; } catch { /* قبل تهيئة الواجهة */ }
}
const firstNum = (x) => { const m = (x || '').match(/\d[\d,]*(?:\.\d+)?/); return m ? { text: m[0], val: parseFloat(m[0].replace(/,/g, '')) } : null; };
// عرض مبسّط: عنوان قصير + الرقم الآن من المستهدف + شريط، والتفاصيل الكاملة تظهر بالضغط. العادة: اسم ونقاط بعدد المطلوب وزر.
// سطر «عادات اليوم» أعلى تبويب «اليوم»: العادات التي لم تُسجَّل اليوم ولم تكتمل لفترتها، بنقاطها وزر «تم» نفسه (habitMark).
// لا تدخل في عدّاد «اليوم» ولا في بنوده، وحين تُسجَّل كلها يختفي السطر.
function renderTodayHabits(body) {
  const hd = habitsData();
  if (!hd || !hd.defs.length) return;
  const { date } = riyadhNow();
  const due = hd.defs.map((h) => ({ h, st: habitState(h, hd.log, date) })).filter(({ h, st }) => st.count < h.need && !st.today);
  if (!due.length) return;
  const row = uiEl('div', 'habits-row');
  for (const { h, st } of due) {
    const item = uiEl('div', 'habit-chip');
    item.append(uiEl('span', 'habit-name', h.name));
    const dots = uiEl('span', 'dots');
    for (let i = 0; i < Math.min(h.need, 7); i++) dots.append(uiEl('i', i < st.count ? 'on' : ''));
    dots.title = `${st.count} من ${h.need} ${h.monthly ? 'هذا الشهر' : 'هذا الأسبوع'}`;
    const btn = uiEl('button', 'pill sm', 'تم');
    btn.type = 'button';
    btn.addEventListener('click', (ev) => { ev.preventDefault(); habitMark(h, btn); });
    item.append(dots, btn);
    row.append(item);
  }
  body.append(row);
}
function renderGoals(body, empty) {
  const { date } = riyadhNow();
  const q = activeQuarter();
  const head = (t) => { const h = document.createElement('div'); h.className = 'grp'; h.textContent = t; body.append(h); return h; };
  const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
  if (!q) empty('لا ربع نشطاً في Strategy/ (ملف type: quarter وstatus: active).');
  else {
    const left = q.end ? Math.round((Date.parse(q.end) - Date.parse(date)) / 864e5) : null;
    head('هدف الربع' + (left != null && left >= 0 ? ` · باقٍ ${left} يوماً` : left != null ? ' · انتهت مدته' : ''));
    q.goals.forEach((g, gi) => {
      const card = el('div', 'goal');
      const short = g.goal.split(/\s*[(،]/)[0].trim() || g.goal;
      card.append(el('div', 'goal-title', moneyShown ? short : HIDE_SEARCH ? `الهدف ${gi + 1}` : maskNums(short))); // مع HIDE_SEARCH يُخفى النص كله
      const now = firstNum(g.now), target = firstNum(g.target);
      if (now && target && target.val > 0) {
        const nums = el('div', 'goal-nums');
        nums.append(el('span', 'goal-now', maskNums(now.text)), el('span', 'goal-of', ` من ${maskNums(g.target)}`));
        const bar = el('div', 'goal-bar'), fill = el('div', 'goal-fill');
        // التقدم من بداية الربع (البداية ← المستهدف) لا من صفر؛ بلا بداية رقمية أو ببداية ≥ المستهدف يُقاس من صفر
        const start = firstNum(g.start);
        const frac = start && start.val < target.val ? (now.val - start.val) / (target.val - start.val) : now.val / target.val;
        fill.style.width = Math.max(2, Math.min(100, Math.round(frac * 100))) + '%';
        if (!moneyShown) bar.hidden = true; // النسبة تكشف الرقم إن عُرف أحد الطرفين
        bar.append(fill);
        card.append(nums, bar);
      } else if (g.now || g.target) card.append(el('div', 'meta-sm', maskNums([g.now && `الآن ${g.now}`, g.target && `المستهدف ${g.target}`].filter(Boolean).join(' · '))));
      const more = el('div', 'meta-sm', maskNums([g.goal !== short ? g.goal : '', g.start && `البداية: ${g.start}`, g.state && `الحالة: ${g.state}`].filter(Boolean).join(' · ')));
      more.hidden = true;
      if (moneyShown) card.append(more);
      if (moneyShown) card.addEventListener('click', () => { more.hidden = !more.hidden; }); else card.style.cursor = 'default';
      body.append(card);
    });
    if (!q.goals.length) empty('لا أهداف مكتوبة في ملف الربع.');
  }
  const hd = habitsData();
  head('العادات');
  if (!hd || !hd.defs.length) { empty('لا عادات معرّفة بعد (الملف «سجل العادات» غير موجود في الـ Vault أو قسم «العادات» فارغ).'); return; }
  const ul = document.createElement('ul');
  for (const h of hd.defs) {
    const st = habitState(h, hd.log, date);
    const li = el('li', 'plain habit');
    const main = el('div', 'main');
    main.append(el('span', 'habit-name', h.name));
    const dots = el('span', 'dots');
    const n = Math.max(h.need, st.count);
    for (let i = 0; i < Math.min(n, 7); i++) dots.append(el('i', i < st.count ? 'on' : ''));
    dots.title = `${st.count} من ${h.need} ${h.monthly ? 'هذا الشهر' : 'هذا الأسبوع'}`;
    main.append(dots);
    const desc = el('div', 'meta-sm', [dots.title, maskMoney(h.desc)].filter(Boolean).join(' · '));
    desc.hidden = true;
    main.append(desc);
    main.addEventListener('click', () => { desc.hidden = !desc.hidden; });
    li.append(main);
    const btn = el('button', 'pill sm xbtn' + (st.today ? ' done' : ''), st.today ? '✓' : 'تم');
    btn.type = 'button';
    btn.disabled = st.today;
    btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); habitMark(h, btn); });
    li.append(btn);
    ul.append(li);
  }
  body.append(ul);
}
// ---------- تبويب «مشاريعي» (المرحلة 5) ----------
// قائمة بطاقات: البراند الشخصي والبحث عن فرص (كل منهما يفتح لوحته)، ثم بطاقة لكل مشروع له بنود مفتوحة في لوحة اليوم
// (المفتوح والمتأخر؛ الضغط يعرض بنوده). المشروع المتوقف (status: paused في صفحته) لا بطاقة له، ومشروع البحث عن فرص
// ممثَّل ببطاقة الفرص. في وضع العرض تغيب بطاقة الفرص. panel.sub: '' (القائمة) | 'brand' | 'opps' | 'p:<المشروع>'.
function projectPaused(name) {
  const n = vault.byPath.get(`Projects/${name}.md`);
  return !!n && /^status:\s*paused\b/m.test(n.text.slice(0, 400));
}
function projectGroups() {
  const all = [...myTasks(), ...boardItems('مفتوح الآن — قادم'), ...boardItems('مفتوح الآن — بلا موعد (يحتاج قرارك)')];
  const map = new Map();
  for (const x of all) {
    let proj = '';
    try { proj = projectOf(x).split(' · ')[0]; } catch { proj = ''; }
    if (!proj || SECRET_RE.test(proj) || projectPaused(proj)) continue;
    if (!map.has(proj)) map.set(proj, []);
    map.get(proj).push(x);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items, late: items.filter((x) => itemLate(x)).length }))
    .sort((a, b) => (b.late - a.late) || (b.items.length - a.items.length));
}
function projectsCount(demo) { // عدد البطاقات التي فيها ما ينتظره (البراند، الفرص)؛ المتأخر في المشاريع محسوب في «اليوم»
  let n = 0;
  try { if (brandCount() > 0) n++; } catch { /* اختياري */ }
  try { if (!demo && oppsCount() > 0) n++; } catch { /* اختياري */ }
  return n;
}
function renderProjects(body, empty, demo) {
  if (demo && panel.sub === 'opps') panel.sub = '';
  const open = (sub) => { panel.sub = sub; renderTasks(); };
  if (panel.sub) {
    const back = uiEl('div', 'upd');
    const bb = uiEl('button', 'pill sm', '‹ مشاريعي');
    bb.type = 'button';
    bb.addEventListener('click', (ev) => { ev.preventDefault(); open(''); });
    const name = panel.sub === 'brand' ? 'البراند الشخصي' : panel.sub === 'opps' ? 'البحث عن فرص' : panel.sub.slice(2);
    back.append(uiEl('span', 'sub-title', name), bb);
    body.append(back);
    if (panel.sub === 'brand') { try { renderBrand(body, empty); } catch (e) { empty('تعذّر عرض أفكار البراند: ' + (e?.message || e)); } return; }
    if (panel.sub === 'opps') { try { renderOpps(body, empty); } catch (e) { empty('تعذّر عرض لوحة الفرص: ' + (e?.message || e)); } return; }
    const g = projectGroups().find((x) => x.name === name);
    if (!g) { empty('لا بنود مفتوحة لهذا المشروع الآن.'); return; }
    const items = demoFilter(g.items).sort((a, b) => (itemLate(b) ? 1 : 0) - (itemLate(a) ? 1 : 0));
    body.append(statTiles([[items.length, 'مفتوح'], [items.filter((x) => itemLate(x)).length, 'متأخر']].filter(([n], i) => i === 0 || n > 0)));
    body.append(panelList(items, { kind: 'week', noProj: true }));
    return;
  }
  const ul = document.createElement('ul');
  const card = (title, chips, sub) => {
    const li = uiEl('li', 'row card');
    const main = uiEl('div', 'main');
    main.append(uiEl('div', 't', title));
    const c = uiEl('div', 'chips');
    for (const [text, cls] of chips) c.append(uiEl('span', 'chip' + (cls ? ' ' + cls : ''), text));
    if (chips.length) main.append(c);
    li.append(main, uiEl('span', 'go-arrow', '‹'));
    li.addEventListener('click', () => open(sub));
    ul.append(li);
  };
  // البراند الشخصي
  try {
    const d = brandData();
    const b = (() => { try { return brandBoard(); } catch { return null; } })();
    const chips = [];
    if (d && d.ideas.length) chips.push([`أفكار تنتظرك ${d.ideas.length}`, 'warn']);
    if (b) {
      b.actions.forEach((s) => { if (s.items.length) chips.push([`${s.title} ${s.items.length}`, 'warn']); });
      if (b.week.length) chips.push(['نُشر: ' + b.week.map((w) => `${w.name} ${w.n}/${w.of}`).join(' · ')]);
    }
    if (d || b) card('البراند الشخصي', chips.length ? chips : [['لا شيء ينتظرك']], 'brand');
  } catch (e) { /* البطاقة اختيارية */ }
  // البحث عن فرص (سرّي: لا يظهر في وضع العرض)
  if (!demo) {
    try {
      const ob = oppsBoard();
      if (ob) {
        let drafts = 0, ads = 0;
        try { drafts = outreachDrafts().length; } catch { /* لا مسودات */ }
        try { const s = ob.sections.find(oppsIsApply); ads = s ? oppsApplyItems(s).length : 0; } catch { /* لا إعلانات */ }
        const chips = [];
        if (drafts) chips.push([`رسائل تنتظرك ${drafts}`, 'warn']);
        if (ads) chips.push([`إعلانات ${ads}`, 'warn']);
        card('البحث عن فرص', chips.length ? chips : [['لا شيء ينتظرك']], 'opps');
      }
    } catch (e) { /* البطاقة اختيارية */ }
  }
  for (const g of projectGroups()) {
    const items = demoFilter(g.items);
    if (!items.length) continue;
    const late = items.filter((x) => itemLate(x)).length;
    card(g.name, [[`مفتوح ${items.length}`], ...(late ? [[`متأخر ${late}`, 'warn']] : [])], 'p:' + g.name);
  }
  if (ul.children.length) body.append(ul); else empty('لا مشاريع فيها بنود مفتوحة.');
}
function renderTasks() {
  const box = document.getElementById('tasksPanel');
  if (!box) return;
  if (settings().tasksPanel === 'off' || lock.locked || !vault.byPath.size) { box.hidden = true; return; }
  const allItems = myTasks();
  panel.items = allItems; // للمكالمة: القائمة كاملة
  const demo = HIDE_SEARCH && !moneyShown; // demo هنا = إخفاء البحث عن فرص؛ إخفاء الأرقام يتبع moneyShown مباشرة
  const items = demoFilter(allItems);
  const UPCOMING_DAYS = 30; // «القادم» يعرض شهراً، والمربع الثاني يعدّ ما في الأسبوع منه
  const week = demoFilter(boardItems('مفتوح الآن — قادم').filter((x) => withinWeek(x, UPCOMING_DAYS)));
  const weekOnly = week.filter((x) => withinWeek(x, 7)).length;
  const props = demoFilter(boardItems('مقترحات للـ Open Loops (تنتظر قرارك)'));
  applyDemoChrome();
  // التبويبان القديمان («الفرص» و«البراند») صارا لوحتين داخل «مشاريعي»
  if (panel.tab === 'opps' || panel.tab === 'brand') { panel.sub = panel.tab; panel.tab = 'projects'; }
  if (panel.tab === 'week' || panel.tab === 'props') panel.tab = 'upcoming'; // دُمجا في «القادم»
  const tab = panel.tab || 'today';
  const body = document.getElementById('tasksBody');
  body.replaceChildren();
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  for (const [key, label, n] of [['today', 'اليوم', items.length], ['upcoming', 'القادم', week.length + props.length], ['projects', 'مشاريعي', projectsCount(demo)], ['goals', 'أهدافي', goalsPending()]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (key === tab ? ' on' : '');
    b.textContent = `${label} ${n}`;
    b.addEventListener('click', (ev) => { ev.preventDefault(); panel.tab = key; panel.sub = ''; store.set('tasksTab', key); renderTasks(); });
    tabs.append(b);
  }
  body.append(tabs);
  const empty = (msg) => { const d = document.createElement('div'); d.className = 'appr'; d.textContent = msg; body.append(d); };
  if (tab === 'today') {
    const groups = [['عليك', (x) => x.startsWith('عليك')], ['متابعة', (x) => x.startsWith('متابعة ')], ['عند غيرك', () => true]];
    const used = new Set();
    const parts = [];
    for (const [name, test] of groups) {
      const list = items.filter((x, i) => !used.has(i) && test(x));
      items.forEach((x, i) => { if (!used.has(i) && test(x)) used.add(i); });
      parts.push([name, list]);
    }
    if (items.length) {
      // المربع الصفري لا يُعرض (عدا «عليك»)
      body.append(statTiles([[parts[0][1].length, 'عليك'], [items.filter((x) => itemLate(x)).length, 'متأخر'], [parts[1][1].length, 'متابعة'], [parts[2][1].length, 'عند غيرك']].filter(([n], i) => i === 0 || n > 0)));
      try { renderTodayHabits(body); } catch (e) { /* السطر اختياري */ }
      for (const [name, list] of parts) {
        if (!list.length) continue;
        const title = name === 'متابعة' ? (list[0].match(/^متابعة ([^:]+):/)?.[0].replace(':', '') || 'متابعة') : name;
        taskGroup(body, title, list, { open: name === 'عليك' });
      }
    } else { try { renderTodayHabits(body); } catch (e) { /* السطر اختياري */ } empty('لا مهام موعدها اليوم.'); }
    const appr = boardSection('اعتمادات معلّقة').split('\n').filter((l) => l.startsWith('- ') && !/:\s*0\s*$/.test(l)).map((l) => l.slice(2).trim()).filter((l) => !demo || !/^إيميلات تواصل/.test(l));
    if (appr.length) { const c = uiEl('div', 'chips foot'); c.append(uiEl('span', 'chip', 'ينتظر اعتمادك: ' + appr.join(' · '))); body.append(c); }
  } else if (tab === 'upcoming') {
    let old = 0;
    for (const x of props) { try { const a = proposalAge(x); if (a != null && a >= PROPOSAL_OLD_DAYS) old++; } catch { /* اختياري */ } }
    const tomorrow = week.filter((x) => dueInfo(x.split(' ← ')[0])?.days === -1).length;
    body.append(statTiles([[week.length, 'هذا الشهر'], [weekOnly, 'هذا الأسبوع'], [tomorrow, 'غداً'], [props.length, 'مقترحات'], [old, 'قديمة']].filter(([n], i) => i === 0 || i === 3 || n > 0)));
    body.append(uiEl('div', 'grp', `هذا الشهر · ${week.length}`));
    if (week.length) body.append(panelList(week, { kind: 'week' })); else empty('لا شيء موعده خلال الثلاثين يوماً القادمة.');
    if (props.length) {
      const openP = old > 0; // مقترح قديم ينتظر قراراً: القسم يظهر مفتوحاً
      const h = uiEl('div', 'grp fold');
      const arrow = uiEl('span', 'arrow', openP ? ' ▴' : ' ▾');
      h.append(uiEl('span', '', `مقترحات تنتظر قرارك · ${props.length}`), arrow);
      if (old) h.append(uiEl('span', 'chip old', `قديم ${old}`));
      const ul = panelList(props, { kind: 'proposal' });
      ul.hidden = !openP;
      h.addEventListener('click', () => { ul.hidden = !ul.hidden; arrow.textContent = ul.hidden ? ' ▾' : ' ▴'; });
      body.append(h, ul);
    } else body.append(uiEl('div', 'grp', 'مقترحات تنتظر قرارك · 0'));
  } else if (tab === 'projects') {
    try { renderProjects(body, empty, demo); } catch (e) { empty('تعذّر عرض المشاريع: ' + (e?.message || e)); }
  } else if (tab === 'goals') {
    try { renderGoals(body, empty); } catch (e) { empty('تعذّر عرض الأهداف: ' + (e?.message || e)); }
  } else {
    if (props.length) {
      let old = 0;
      for (const x of props) { try { const a = proposalAge(x); if (a != null && a >= PROPOSAL_OLD_DAYS) old++; } catch { /* اختياري */ } }
      body.append(statTiles([[props.length, 'مقترحات'], [old, 'قديمة']].filter(([n], i) => i === 0 || n > 0)));
      body.append(panelList(props, { kind: 'proposal' }));
    } else empty('لا مقترحات تنتظر قرارك.');
  }
  const oppsN = demo ? 0 : oppsCount();
  document.getElementById('tasksTitle').textContent = ['لوحتي', `اليوم ${items.length}`, oppsN ? `الفرص ${oppsN}` : ''].filter(Boolean).join(' · ');
  box.hidden = false;
}
// «— متأخر منذ الأربعاء 21 أكتوبر» / «منذ أمس السبت» / «منذ الأحد 18» ← { due, days }
function dueInfo(x) {
  const m = x.match(/ — (متأخر(?: منذ (.+))?|اليوم|(.+))$/);
  if (!m) return null;
  if (m[1] === 'اليوم') return { due: 'اليوم', days: 0 };
  const when = (m[2] || m[3] || '').trim();
  if (!when) return { due: '', days: null };
  if (/^اليوم|^الليلة/.test(when)) return { due: when, days: 0 }; // «اليوم الساعة 5 م»: الرقم ساعة لا يوم
  if (/أمس/.test(when)) return { due: when.replace(/^أمس\s*/, 'أمس '), days: 1 };
  if (/^غداً|^غدا|^بكرة/.test(when)) return { due: when, days: -1 };
  // الساعة ليست يوماً: «الساعة 5 م»، «بعد 6 م»، «9:30 ص»
  const dayPart = when.replace(/(?:الساعة\s*)?\d{1,2}(?::\d{2})?\s*[صم](?=$|[\s،.)])/g, ' ');
  const d = dayPart.match(/(\d{1,2})(?:\s+(\S+))?/);
  if (!d) return { due: when, days: null };
  const { date } = riyadhNow();
  const [y, cm, cd] = date.split('-').map(Number);
  let mo = d[2] ? AR_MONTHS.findIndex((x) => norm(x) === norm(d[2])) : -1;
  let due;
  if (mo >= 0) due = Date.UTC(y, mo, +d[1]);
  else { due = Date.UTC(y, cm - 1, +d[1]); if (+d[1] > cd) due = Date.UTC(y, cm - 2, +d[1]); } // بلا شهر: آخر مرة مرّ فيها هذا اليوم
  const days = Math.round((Date.UTC(y, cm - 1, cd) - due) / 864e5);
  return { due: when, days };
}
function lateLabel(days) {
  if (days == null || days <= 0) return '';
  if (days === 1) return 'متأخر يوم';
  if (days === 2) return 'متأخر يومين';
  return days <= 10 ? `متأخر ${days} أيام` : `متأخر ${days} يوماً`;
}
// مشروع البند: سطره في Open Loops (مفتوح/مقترحات/مُغلق) بالمطابقة نفسها؛ وفي سطر الخطة يُضاف اسم الجزء («فرق · صرة»)
function projectOf(item) {
  const n = vault.byPath.get(OPEN_LOOPS);
  if (!n) return '';
  const lines = n.text.split('\n').filter((l) => l.startsWith('- [[') || /^- \d{4}-\d{2}-\d{2} · \[\[/.test(l)).map((l) => l.split(' — ')[0]);
  const r = rankLines(lines, item, lines);
  if (!r.length) return '';
  const projIn = (l) => (l.match(/\[\[([^\]|]+)/) || [])[1] || '';
  const proj = projIn(r[0].l);
  // تقارب في المطابقة مقبول فقط إن كان المرشحان من المشروع نفسه
  if (r[1] && r[1].s >= r[0].s * 0.83 && projIn(r[1].l) !== proj) return '';
  const line = r[0].l.replace(/^- /, '');
  const segs = lineSegments(line);
  const part = segs.length > 1 ? bestSegment(line, item) : null;
  const label = part && /^[^:]{2,25}:/.test(part) ? part.split(':')[0].trim() : '';
  return label && label !== proj ? `${proj} · ${label}` : proj;
}
function chatOn() { return settings().chat !== 'off' && !lock.locked; }
function askAbout(item, kind, li) {
  if (!call.session) { // خارج المكالمة: زرّان تحت البند — اتصال (نيكست يفتتح المكالمة بهذا البند) أو شات
    if (call.active) return; // المكالمة تتصل الآن
    const startOn = () => { call.askOnStart = { item, kind }; startCall(); };
    if (!li || !chatOn()) return startOn();
    const open = li.querySelector('.choice');
    document.querySelectorAll('.tasks .choice').forEach((c) => c.remove());
    if (open) return; // ضغطة ثانية على البند نفسه تغلق الزرّين
    const row = document.createElement('div');
    row.className = 'choice';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pill sm'; b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); row.remove(); fn(); });
      return b;
    };
    row.append(mk('📞 اتصال', startOn), mk('💬 شات', () => chatAbout(item, kind)));
    (li.querySelector('.main') || li).append(row);
    return;
  }
  const what = kind === 'idea' && brandTalk ? ideaAsk() : kind === 'proposal'
    ? `هذا مقترح ينتظر قراره: «${item}». قل له بجملة ما هو ومن أين ظهر، واسأله: يضيفه بموعد، أو متابعة يومية، أو يتجاهله — ونفّذ حسب رده بقاعدة «المرور على مقترحات».`
    : `«${item}». قل له ما تعرفه عنه بجملتين (ابحث في الـ Vault إن لزم: آخر ما حدث، ومن عنده الفعل التالي)، واسأله إن كان يريد فعل شيء فيه. لا تنفّذ شيئاً دون طلبه.`;
  call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه) الوليد ضغط على هذا البند في الشاشة: ${what}` });
  note('tool', `👆 سأل عن: ${clip(item, 60)}`);
}
// الشات عن بند: نفس طلب المكالمة، مكتوباً. يظهر للوليد سطر «👆 …» ويصل النموذج الطلب كاملاً.
function chatAbout(item, kind) {
  const what = kind === 'idea' && brandTalk ? ideaAsk() : kind === 'proposal'
    ? `هذا مقترح ينتظر قراره: «${item}». اكتب له بسطر ما هو ومن أين ظهر، واسأله: يضيفه بموعد، أو متابعة يومية، أو يتجاهله — ونفّذ حسب رده بقاعدة «المرور على مقترحات».`
    : `«${item}». اكتب له ما تعرفه عنه بسطرين (ابحث في الـ Vault إن لزم: آخر ما حدث، ومن عنده الفعل التالي)، واسأله إن كان يريد فعل شيء فيه. لا تنفّذ شيئاً دون طلبه.`;
  const keep = store.get('tasksOpen', 'off'); setTasksOpen(false); store.set('tasksOpen', keep); // تُطوى مؤقتاً ليظهر الرد، دون تغيير الحالة المحفوظة
  chatSend(`(تنبيه من النظام) الوليد ضغط على هذا البند في شاشة المهام واختار الشات: ${what}`, { display: (kind === 'idea' ? '👆 ناقش فكرة: ' : '👆 حدّثني عن: ') + item.split(' ← ')[0] });
}
let panelTimer = 0;
function markSaid(text) { // ✓ يتحدّث بعد كل جملة لنيكست، بتأخير بسيط حتى لا يعيد الرسم مع كل كلمة
  panel.said = (panel.said + ' ' + text).slice(-20000);
  clearTimeout(panelTimer);
  panelTimer = setTimeout(renderTasks, 800);
}

// فحص بعد السرد: بند لم تظهر أي كلمة من كلماته المميزة فيما قاله نيكست ← تذكير واحد (مفتاح «فحص اكتمال المهام»)
function checkTasksSaid(now, idle) {
  const c = call.check;
  if (!c || !idle || !call.session || now - c.at < 20000) return;
  const buf = norm(c.buf);
  const missing = c.items.filter((it, i) => c.terms[i].length && !c.terms[i].some((t) => buf.includes(t)));
  if (c.nudged || !missing.length) { call.check = null; return; }
  c.nudged = true;
  c.at = now;
  call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه حرفياً) شبكة أمان: من مهام اليوم ${missing.length} بنود لم تُذكر بالاسم بعد: ${missing.map((x) => '«' + clip(x, 70) + '»').join('، ')}. في أول فرصة طبيعية — دون مقاطعة موضوع يتكلم فيه — قلها له بشكل عابر وبشري (مثل «وبالمناسبة، فيه كمان …») أو اسأله إن كان يريد سماع الباقي. لا تعدّدها آلياً ولا تكرر ما قيل.` });
  note('tool', `⚠️ ${missing.length} بنود لم تُذكر — ذُكّر بها`);
}

// قبل أي إغلاق: هل البند مفتوح فعلاً في Open Loops؟ وماذا يقول واتساب عنه؟
function openLoopsLines() {
  const n = vault.byPath.get(OPEN_LOOPS);
  const t = n ? n.text : '';
  // كل قسم حتى القسم التالي: «مقترحات» بين «مفتوح» و«مُغلق» ليست بنوداً مفتوحة
  const section = (h) => { const i = t.indexOf(h); if (i === -1) return ''; const j = t.indexOf('\n## ', i + h.length); return t.slice(i, j === -1 ? undefined : j); };
  const pick = (s) => s.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- لا شيء'));
  return { open: pick(section('## مفتوح')), closed: pick(section('## مُغلق')) };
}
// وزن الكلمة بندرتها (IDF) بين كل بنود Open Loops: الأسماء والكلمات المميزة تحسم، والعامة («تصاميم»، «غير») لا.
const ITEM_STOP = new Set(['غير', 'شي', 'شيء', 'حاجه', 'موجود', 'اطلاقا', 'كل', 'بعد', 'قبل', 'اليوم', 'بكره', 'امس', 'خلاص', 'خلص', 'خلصت', 'تم', 'اقفل', 'اقفلها', 'مهمه', 'بند', 'بتاع', 'بتاعه', 'بتاعت', 'دي', 'ده', 'هذا', 'هذه']);
const CHECK_STOP = new Set([...ITEM_STOP, 'متاخر', 'منذ', 'اليوم', 'عليك', 'تابع', 'متابعه', 'مهام', 'لليوم', 'واتساب', 'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر', 'السبت', 'الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه', 'امس', 'غدا', 'بكره']);
function itemTerms(q) {
  const out = new Set();
  for (const t of terms(q).filter((x) => !ITEM_STOP.has(x))) {
    out.add(t);
    if (t.length > 4 && /^[لوب]/.test(t)) out.add(t.slice(1)); // لممورا ← ممورا، وسحر ← سحر
  }
  return [...out];
}
function rankLines(lines, query, all) {
  const ts = itemTerms(query), docs = (all || lines).map(norm), N = docs.length || 1;
  const idf = Object.fromEntries(ts.map((t) => {
    const df = docs.filter((d) => d.includes(t)).length;
    return [t, df === 0 || df / N > 0.3 ? 0 : Math.log(N / df)];
  }));
  return lines.map((l) => { const nl = norm(l); return { l, s: ts.reduce((k, t) => k + (nl.includes(t) ? idf[t] : 0), 0) }; })
    .filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
}
// سطر الخطة يضم عدة مقاطع مفصولة بـ«؛» — هذا يعيد المقطع الذي قصده الوليد، لا أول السطر
function lineSegments(line) {
  return taskOf('- ' + line.replace(/^- /, '')).split('؛').map((s) => s.trim()).filter((s) => s.length > 3);
}
// المقطع المقصود داخل سطر الخطة: بعدد الجذور المشتركة مع كلام الوليد (لا IDF — مع مقطعين فقط كان يصفّر كل الكلمات
// فيعود لأول مقطع خطأً). لا تخمين: إن لم يطابق مقطع، أو تعادل الأول والثاني، يعيد null فيُسأل الوليد أيها يقصد.
function bestSegment(line, query) {
  const segs = lineSegments(line);
  if (segs.length < 2) return segs[0] || taskOf(line).trim();
  const q = stems(query);
  const scored = segs.map((s) => ({ s, n: [...stems(s)].filter((t) => q.has(t)).length })).sort((a, b) => b.n - a.n);
  if (!scored[0].n || scored[0].n === scored[1].n) return null;
  return scored[0].s;
}
function verifyItem(item) {
  const { open, closed } = openLoopsLines();
  const all = [...open, ...closed];
  const o = rankLines(open, item, all), c = rankLines(closed, item, all);
  const bo = o[0]?.s || 0, bc = c[0]?.s || 0;
  if (bc > 0 && bc > bo * 1.2) return { state: 'closed', line: c[0].l };
  if (bo < 1.5) return { state: 'missing' }; // لا كلمة مميزة واحدة تطابق
  if (o.length > 1 && o[1].s >= bo * 0.85) return { state: 'ambiguous', candidates: o.slice(0, 3).map((x) => clip(bestSegment(x.l, item) || lineSegments(x.l).join('؛ '), 90)) }; // بلا السياق المشترك حتى يفرّق بينها
  const line = o[0].l.slice(2);
  const part = bestSegment(line, item);
  if (part === null) return { state: 'ambiguous', candidates: lineSegments(line).map((s) => clip(s, 90)) }; // سطر خطة ولم يتضح أي جزء
  // الدليل فقط مما قررت لوحة اليوم أنه «يبدو أنه أُنجز» (نيكست الكبير طابقه بالبند)، لا مطابقة كلمات عابرة
  const waLines = whatsappDone().split('\n').filter((l) => l.startsWith('- '));
  const wa = rankLines(waLines, part, all);
  return { state: 'open', line, part, evidence: wa.length && wa[0].s >= 3 ? wa[0].l.replace(/^- /, '') : '' };
}

function openLoopsForVoice() {
  const parts = [openLoopsText()];
  const mine = doneToday();
  if (mine.length) parts.push(`## قال الوليد إنه انتهى اليوم — لا تذكره كمهمة (إغلاقه في Open Loops جارٍ)\n${mine.map((x) => '- ' + x).join('\n')}`);
  const wa = whatsappDone();
  if (wa) parts.push(`## يبدو من واتساب أنه أُنجز اليوم — لا تذكره كمهمة، واسأله مرة: «يبدو إنه خلص، أقفله؟»\n${wa}`);
  return parts.join('\n\n');
}

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function riyadhNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const BIG_KIND = 'سؤال لنيكست الكبير';

async function addToInbox({ title, content, kind = 'ملاحظة', type = 'سؤال' }) {
  const { date, time } = riyadhNow();
  const safe = (title || 'ملاحظة صوتية').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  const path = `Inbox/${date} ${time.replace(':', '')} صوتي - ${safe}.md`;
  // طلبات نيكست الكبير يلتقطها سكربت الماك بحالة pending (انظر next_voice_sync.py).
  // type: فعل = أكّده الوليد بصوته (مرّ بالتأكيد الإلزامي)؛ غيره يُنفَّذ قراءةً فقط.
  const extra = kind === BIG_KIND ? `type: ${type === 'فعل' ? 'فعل' : 'سؤال'}\nstatus: pending\ncreated_utc: ${new Date().toISOString()}\n` : '';
  const body = `---\nsource: نيكست الصوتي\nkind: ${kind}\ncreated: ${date} ${time}\n${extra}---\n# ${safe}\n\n${content}\n`;
  if (settings().repo === 'local') {
    console.info('[local] add_to_inbox', path, body);
  } else {
    await ghWrite(() => gh(`contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `voice: ${safe}`, content: b64utf8(body) }),
    }));
  }
  indexNotes([...vault.notes, { path, title: path.split('/').pop().replace(/\.md$/, ''), aliases: [], type: 'inbox', text: body }]);
  return path;
}

// ---------- الأدوات المعروضة على Gemini ----------
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'search_vault',
      description: 'ابحث في العقل الثاني (الـ Vault) عن أشخاص أو مشاريع أو شركات أو قرارات أو أي موضوع. يعيد أفضل الملفات مع مقتطف. استخدمه قبل الإجابة عن أي شيء يخص عمل الوليد.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'كلمات البحث، يُفضّل الاسم أو الموضوع' } },
        required: ['query'],
      },
    },
    {
      name: 'read_note',
      description: 'اقرأ ملفاً كاملاً من الـ Vault بالمسار أو الاسم (مثل "رفد" أو "Projects/رفد.md").',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    {
      name: 'open_loops',
      description: 'البنود المفتوحة: الالتزامات والمواعيد والمستحقات غير المحصّلة لكل المشاريع. وحين يسأل عن شيء قديم أو انتهى («كنت طلبت…»، «سلّم ولا لأ؟») مرّر query بكلمات السؤال، فتعود معها أسطر «مُغلق» المطابقة (متى أُغلق ولماذا).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'اختياري: كلمات البحث في البنود المُغلقة (اسم الشخص، الموضوع، المشروع)' } },
      },
    },
    {
      name: 'my_tasks',
      // بلا parameters
      description: 'حين يسأل الوليد عن مهامه أو ما عليه اليوم («إيه مهامي؟»، «إيه عليّا النهارده؟»): تعيد بنود اليوم والمتأخر (وبنود المتابعة اليومية مفصولة). غطِّها كلها بكلامك الطبيعي كزميل يلخّص اليوم — لا تعداداً آلياً؛ التطبيق يتحقق بعد سردك أن شيئاً لم يسقط.',
    },
    {
      name: 'add_to_inbox',
      description: 'سجّل ملاحظة أو فكرة أو قراراً في Inbox/ ليُعالَج لاحقاً. ليس لمهام To Do: أي مهمة تُرسل بـ ask_big_next لتُضاف فعلاً. استدعها فوراً دون أن تسأل؛ التطبيق يعلّقها ويعطيك جملة التأكيد.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان قصير' },
          content: { type: 'string', description: 'المحتوى مستخلصاً بالفصحى، مع الأسماء والتواريخ والمبالغ كما قالها' },
          kind: { type: 'string', enum: ['ملاحظة', 'قرار', 'فكرة'] },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'ask_big_next',
      description: 'أرسل طلباً إلى نيكست الكبير (Claude على الماك) حين يحتاج ما لا تملكه: إضافة مهمة To Do، واتساب، الشيتات، Gmail، Trello، تقرير، أو تحليل عميق. سؤال عن شيء في الـ Vault (مهمة قديمة، من سلّم ماذا، قرار، تاريخ مشروع) ابحث عنه أولاً بـ search_vault أو open_loops مع query، ولا ترسله إلا إن لم تجده أو احتاج واتساب/الشيتات. للأسئلة استدعها مباشرة. للأفعال (مهمة، تعديل، رسالة) استدعها فوراً بنوع «فعل» دون أن تسأل؛ التطبيق يعلّقها ويعطيك جملة التأكيد الوحيدة.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان قصير للطلب' },
          request: { type: 'string', description: 'الطلب كاملاً وواضحاً بالفصحى، بالأسماء والتواريخ والسياق من المكالمة، ليفهمه دون أن يسمعها' },
          type: { type: 'string', enum: ['سؤال', 'فعل'], description: 'سؤال = يقرأ ويجيب فقط. فعل = يغيّر شيئاً (مهمة، إغلاق، تسجيل، اعتماد، تعديل)' },
        },
        required: ['title', 'request', 'type'],
      },
    },
    {
      name: 'mark_done',
      description: 'حين يقول الوليد إن بنداً من البنود المفتوحة انتهى («خلصت…»، «سحر سلّمت»)، أو يوافق على إغلاق ما يبدو من واتساب أنه أُنجز: استدعها فوراً دون أن تسأل؛ التطبيق يتحقق من البند ويعطيك جملة التأكيد. يتوقف ذكره فوراً، ويغلقه نيكست الكبير في Open Loops.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'البند كما هو في Open Loops، مختصراً بما يكفي لتمييزه' },
          evidence: { type: 'string', description: 'لماذا انتهى (كلامه، أو دليل واتساب)' },
        },
        required: ['item'],
      },
    },
    {
      name: 'confirm_action',
      // بلا parameters: الكود يحكم من كلام الوليد نفسه
      description: 'استدعها مباشرة بعد أن يردّ الوليد على سؤال التأكيد («…، صح؟»)، أياً كان رده (أيوه، لا، أو غير واضح). التطبيق يقرر من كلامه هو وينفّذ أو يلغي، ويقول لك الجملة الوحيدة التي تقولها بعدها.',
    },
    {
      name: 'idea_edit_note',
      description: 'فقط حين يناقش الوليد معك فكرة محتوى فتحها من تبويب «البراند» ويستقر على تعديل: استدعها بملاحظة التعديل النهائية. التطبيق يضعها في بطاقة الفكرة ليراجعها ويرسلها هو؛ لا شيء يُكتب في الشيت ولا يُرسل. لا تستدعها لغير ذلك.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'ملاحظة التعديل: جملة أو جملتان تقولان ما الذي يتغير في الفكرة بالضبط' },
        },
        required: ['note'],
      },
    },
    {
      name: 'answers_heard',
      // بلا parameters: Gemini يرفض كائناً بخصائص فارغة
      description: 'استدعها بعد أن تقرأ على الوليد ردود نيكست الكبير التي أُعلنت له في هذه المكالمة، أو إن قال صراحة إنه لا يريد سماعها أبداً. لا تستدعها إن قال «بعدين» أو لم يرد؛ تبقى لتُذكر في المكالمة التالية.',
    },
    {
      name: 'big_next_status',
      description: 'حالة طلبات نيكست الكبير الأخيرة وردوده (من آخر مزامنة للـ Vault).',
    },
  ],
}];

const MAX_NOTE = 9000;
// ملف أطول من الحد: أوله (الحالة والأشخاص) + آخره (أحدث السجل يُكتب في الآخر)، والقطع عند حدود الأسطر
function noteForVoice(text) {
  if (text.length <= MAX_NOTE) return { text, truncated: false };
  const HEAD = 3200, TAIL = MAX_NOTE - HEAD;
  const head = text.slice(0, HEAD).replace(/\n[^\n]*$/, '');
  const tail = text.slice(-TAIL).replace(/^[^\n]*\n/, '');
  const skipped = text.length - head.length - tail.length;
  return {
    text: `${head}\n\n[… حُذف من الوسط ${skipped} حرفاً — لأي تفصيل فيه استعمل search_vault بكلمات محددة …]\n\n${tail}`,
    truncated: true,
  };
}
// تأكيد إلزامي في الكود: أي فعل لا يُنفَّذ عند استدعاء الأداة، بل يُعلَّق حتى يقول الوليد «أيوه» بصوته
// (أو يكتبها). النموذج يسأل، والتطبيق نفسه ينفّذ أو يلغي حسب رده.
const GATED = (name, args) => name === 'mark_done' || name === 'add_to_inbox' || (name === 'ask_big_next' && args.type !== 'سؤال');
// سطر Open Loops ← جملة تُنطق: بلا [[ ]] ولا تفاصيل بعد «—» أو «؛»، وبحد 90 حرفاً
function spoken(line) {
  let s = (line || '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1');
  const parts = s.split(' · ');
  s = parts[parts.length - 1]; // يسقط سياق البند («فرق · وليد (مديره) · وليد خاص»)
  s = s.replace(/^خطة محدّثة\s*(\([^)]*\))?\s*:\s*/, 'من خطة وليد: ');
  s = s.split(/ — |؛/)[0].replace(/\s*\([^)]*\)/g, '').trim();
  return s.length > 90 ? s.slice(0, 90).replace(/\s+\S*$/, '') + '…' : s; // قصّ عند حدود الكلمات لا وسط كلمة
}
function clip(s, n) { return (s || '').length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : (s || ''); }
function summarize(name, args) {
  if (name === 'mark_done') return `هقفل: ${clip(args.part, 90) || spoken(args.item)}${args._wa ? ' (واتساب: ' + clip(args._wa, 90) + ')' : ' (مش ظاهر في واتساب إنه خلص، بس كلامك هو المرجع)'}`;
  if (name === 'add_to_inbox') return `هسجّل في الـ Inbox: ${args.title}`;
  return `هبعت لنيكست الكبير: ${args.request || args.title}`;
}
async function runTool(name, args = {}, confirmed = false, mode = 'voice') {
  if (!confirmed && name === 'mark_done') {
    const v = verifyItem(args.item || '');
    if (v.state === 'closed') return { status: 'مقفول بالفعل — لم يُرسل شيء', closed_line: v.line, instruction: 'قل له إنه مقفول بالفعل، ومتى (من السطر).' };
    if (v.state === 'missing') return { status: 'لا يوجد بند مفتوح بهذا الوصف — لم يُرسل شيء', instruction: 'اسأله أي بند يقصد، أو اقرأ open_loops لتجده.' };
    if (v.state === 'ambiguous') return { status: 'أكثر من بند مفتوح يطابق — لم يُرسل شيء', candidates: v.candidates, instruction: 'اسأله أيها يقصد، ثم استدعِ الأداة بوصفه الدقيق.' };
    args = { ...args, asked: args.item, item: v.line.slice(0, 160), part: v.part, evidence: args.evidence || (v.evidence ? 'حسب واتساب: ' + v.evidence : ''), _wa: v.evidence };
  }
  if (!confirmed && GATED(name, args) && mode === 'chat') {
    // الدردشة: الفعل يُعلَّق ويظهر تحته زرّا «تأكيد/إلغاء» — لا يُنفَّذ إلا بالضغط
    if (chat.pending) return { status: 'فعل آخر ما زال ينتظر زر التأكيد — هذا الطلب لم يُسجَّل', pending_now: summarize(chat.pending.name, chat.pending.args), instruction: 'قل له إن عليه أن يؤكد أو يلغي الفعل الأول بالزر، ثم يطلب هذا من جديد.' };
    chat.pending = { name, args };
    return { status: 'بانتظار ضغط الوليد زر «تأكيد» في التطبيق — لم يُنفَّذ', will_do: summarize(name, args), instruction: 'قل له بجملة واحدة ما سيحدث (من will_do) وأن يضغط «تأكيد» تحته. لا تطلب منه كتابة «أيوه»، ولا تقل إنه تم.' };
  }
  if (!confirmed && GATED(name, args)) {
    if (call.pending) {
      return {
        status: 'فعل آخر ما زال ينتظر تأكيد الوليد — هذا الطلب لم يُسجَّل',
        pending_now: summarize(call.pending.name, call.pending.args),
        instruction: 'أكمل تأكيد الفعل الأول (اسأله واستدعِ confirm_action)، وبعد أن يُحسم أعد استدعاء هذه الأداة للفعل التالي. لا تعتبر الفعل التالي مُرسلاً.',
      };
    }
    call.pending = { name, args, at: Date.now(), heard: '', nudged: false };
    note('tool', `⏸ ينتظر تأكيدك: ${summarize(name, args)}`);
    return {
      status: 'بانتظار تأكيد الوليد — لم يُنفَّذ',
      instruction: `اسأله سؤالاً واحداً قصيراً بصيغتك الطبيعية معناه: «${summarize(name, args)}، صح؟» ثم اسكت — لا تقرأه قراءة آلية، لكن لا تغيّر المعنى. بعد رده (أياً كان) استدعِ confirm_action، ولا تقل «تم» أو «أرسلت» قبل نتيجتها.`,
    };
  }
  switch (name) {
    case 'search_vault': {
      const r = searchVault(args.query || '');
      return r.length ? { results: r } : { results: [], note: 'لا نتائج. جرّب اسماً آخر أو تهجئة مختلفة.' };
    }
    case 'read_note': {
      const n = findNote(args.name || '');
      if (!n) return { error: 'الملف غير موجود', suggestions: searchVault(args.name || '', 3).map((x) => x.path) };
      return { path: n.path, ...noteForVoice(n.text) };
    }
    case 'open_loops': {
      const out = { text: openLoopsForVoice().slice(0, 16000) };
      if ((args.query || '').trim()) {
        const { open, closed } = openLoopsLines();
        const hits = rankLines(closed, args.query, [...open, ...closed]).slice(0, 6).map((x) => x.l.replace(/^- /, ''));
        out.closed_matches = hits.length ? hits : [];
        if (!hits.length) out.closed_note = 'لا بند مُغلق يطابق. جرّب search_vault بكلمات أخرى قبل نيكست الكبير.';
      }
      return out;
    }
    case 'my_tasks': {
      const items = myTasks();
      callEvent('راجعتما مهام اليوم');
      call.check = settings().taskCheck !== 'off' && items.length
        ? { items, terms: checkTerms(items), buf: '', at: Date.now(), nudged: false }
        : null;
      const approvals = boardSection('اعتمادات معلّقة').split('\n')
        .filter((l) => l.startsWith('- ') && !/:\s*0\s*$/.test(l))
        .map((l) => l.slice(2).trim());
      return {
        count: items.length,
        items: items.map((x) => { const p = projectOf(x), d = dueInfo(x), l = lateLabel(d?.days); return `${x}${l ? ` (${l})` : ''}${p ? ` [المشروع: ${p}]` : ''}`; }),
        upcoming: boardCount('مفتوح الآن — قادم'),
        undated: boardCount('مفتوح الآن — بلا موعد (يحتاج قرارك)'),
        approvals,
        instruction: items.length
          ? `افتح كزميل يلخّص اليوم، لا كتقرير: جملة أو جملتان فيهما الصورة العامة — المتأخر الذي عليه هو بالاسم أولاً، والباقي مجموعاً بصاحبه وعدده (مثل «وفيه كام حاجة متأخرة بتتابعها مع وليد، وطارق عنده اتنين النهارده»)، وإن كان في approvals شيء فجملة واحدة بما ينتظر اعتماده (مثل «وفيه إيميلات وأفكار مستنية اعتمادك»). ثم اعرض عليه: تمشوا عليها واحدة واحدة، أو يسأل عمّا يهمه. ممنوع التعداد الآلي («أولاً/ثانياً») وقراءة القوائم. إن طلب الكل أو المرور عليها، فغطِّها كلها بكلام طبيعي. لا تختم الحديث عن المهام وفيه بند لم يُذكر ولم يعرض عليه سماعه — التطبيق يذكّرك بما بقي.`
          : 'لا بنود موعدها اليوم. قل ذلك بجملة، واذكر كم بنداً قادماً وكم بلا موعد (من upcoming وundated)، وما ينتظر اعتماده إن وُجد (من approvals).',
      };
    }
    case 'mark_done': {
      addDoneToday(args.item);
      if (args.part) addDoneToday(args.part);
      const r = await addToInbox({ title: `إغلاق: ${args.part || args.item}`.slice(0, 60), content: `أغلق في _System/Open Loops.md البند: ${args.item}\n${args.part ? `الجزء المقصود تحديداً: «${args.part}»${args.asked ? ` (قال الوليد: «${args.asked}»)` : ''}\n` : ''}(انقله إلى «مُغلق» بتاريخ اليوم وسطر قصير بالسبب: ${args.evidence || 'قال الوليد إنه انتهى'}.)\nوإن كان البند سطر خطة أو متابعة يضم عدة أجزاء: أغلق الجزء المقصود وحده (احذفه من السطر واذكره في «مُغلق»)، وأبقِ باقي السطر مفتوحاً كما هو.`, kind: BIG_KIND, type: 'فعل' });
      return { ok: true, path: r, note: 'لن يُذكر بعد الآن، ونيكست الكبير يغلقه في Open Loops خلال دقائق.' };
    }
    case 'add_to_inbox':
      return { ok: true, path: await addToInbox(args) };
    case 'ask_big_next':
      if (args.type === 'سؤال') callEvent(`سأل نيكست الكبير: ${clip(args.title || args.request, 70)}`);
      return {
        ok: true,
        path: await addToInbox({ title: args.title, content: args.request, kind: BIG_KIND, type: args.type === 'سؤال' ? 'سؤال' : 'فعل' }), // غير «سؤال» لا يصل هنا إلا بعد التأكيد (GATED)
        note: 'أُرسل. إن كان الماك مفتوحاً يصل الرد على تيليجرام خلال دقائق، وإلا يُنفَّذ فور فتح الماك ويصل ملخص بما فُعل، ويستطيع الوليد إلغاءه من تيليجرام.',
      };
    case 'confirm_action':
      return confirmAction();
    case 'idea_edit_note': { // محلي فقط: يضع الملاحظة في بطاقة الفكرة؛ الإرسال بيد الوليد من التبويب
      const note = String(args.note || '').replace(/\s+/g, ' ').trim();
      if (!brandTalk) return { ok: false, error: 'لا فكرة قيد النقاش. قل له أن يفتح الفكرة من تبويب «البراند» ويضغط اتصال أو شات.' };
      if (!note) return { ok: false, error: 'الملاحظة فارغة.' };
      brandStaged.set(brandTalk.key, { act: 'edit', note });
      panel.tab = 'brand';
      try { renderTasks(); } catch { /* العرض اختياري */ }
      return { ok: true, note: `وُضعت الملاحظة في بطاقة الفكرة (صف ${brandTalk.row}) في تبويب «البراند». قل له بجملة واحدة أن يراجعها هناك ويضغط «أرسل»، ولم يُرسل شيء بعد.` };
    }
    case 'answers_heard': {
      const list = call.offered.splice(0);
      markAllHeard(list);
      if (list.length) callEvent(`سمع ردود نيكست الكبير على: ${list.map((x) => clip(x.title, 40)).join('، ')}`);
      return { ok: true, count: list.length };
    }
    case 'big_next_status': {
      const items = vault.notes
        .filter((n) => n.path.startsWith('Inbox/') && n.text.includes(`kind: ${BIG_KIND}`))
        .sort((a, b) => b.path.localeCompare(a.path))
        .slice(0, 5)
        .map((n) => ({
          path: n.path,
          status: (n.text.match(/^status: (.*)$/m) || [])[1] || 'غير معروف',
          answer: (n.text.split('## ردّ نيكست الكبير')[1] || '').trim().slice(0, 2500) || null,
        }));
      return items.length ? { requests: items, note: `من فهرس ${vault.built || '—'}` } : { requests: [], note: 'لا طلبات.' };
    }
    default:
      return { error: 'أداة غير معروفة' };
  }
}

// ردود نيكست الكبير على الأسئلة لا تُرسل على تيليجرام؛ تُقال في بداية المكالمة التالية (heard: no)
// ما أُعلن في هذه الجلسة لا يُعلن مرة ثانية (الفهرس قد لا يعرف بعد أنه سُمع)
const announced = new Set();
function unheardAnswers() {
  return vault.notes
    .filter((n) => n.path.startsWith('Inbox/') && n.text.includes(`kind: ${BIG_KIND}`) && /^heard: no$/m.test(n.text) && /^status: answered$/m.test(n.text))
    .filter((n) => !announced.has(n.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(-5)
    .map((n) => ({
      path: n.path,
      title: (n.text.match(/^# (.+)$/m) || [])[1] || n.title,
      answer: (n.text.split('## ردّ نيكست الكبير')[1] || '').split('## ما غيّرته')[0].trim().slice(0, 1500),
    }));
}

async function markHeard(path) {
  if (settings().repo === 'local') return console.info('[local] heard', path);
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return ghWrite(async () => {
  const file = await (await gh(`contents/${enc}`)).json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes).replace(/^heard: no$/m, 'heard: yes');
  await gh(`contents/${enc}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'voice: answer heard', content: b64utf8(text), sha: file.sha }),
  });
  });
}

function systemInstruction(opts = {}) {
  const parts = CORE_FILES.map((p) => {
    const n = vault.byPath.get(p);
    return n && { path: p, text: p === '_System/Today Board.md' ? boardText() : n.text };
  }).filter(Boolean)
    .map((n) => `===== ${n.path} =====\n${n.text}`);
  const entities = vault.notes
    .filter((n) => /^(People|Projects|Companies)\//.test(n.path))
    .map((n) => `- ${n.path}${n.aliases?.length ? ` (${n.aliases.join('، ')})` : ''}`)
    .join('\n');
  const { date, time } = riyadhNow();
  const weekday = new Intl.DateTimeFormat('ar', { timeZone: 'Asia/Riyadh', weekday: 'long' }).format(new Date());
  const [y, mo, d] = date.split('-').map(Number);
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const [hh, mm] = time.split(':').map(Number);
  const clock = `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${hh < 12 ? 'ص' : 'م'}`;
  return [
    'أنت نيكست في مكالمة صوتية حية مع الوليد. التعليمات أدناه من ملفات الـ Vault نفسها؛ ملف Voice Assistant يحكم شكل الكلام في هذه القناة.',
    `الآن: ${weekday} ${d} ${MONTHS[mo - 1]} ${y}، الساعة ${clock} بتوقيت الرياض (${date}). انطق التواريخ بصيغة بشرية: «أمس الجمعة الساعة 5 م»، «بكرة الأحد»، لا أرقام مثل 2026-10-17.`,
    ...parts,
    `===== الكيانات التي لها ملفات (للبحث) =====\n${entities}`,
    `===== اللغات (من إعدادات التطبيق) =====\nالوليد يتكلم فقط: ${settings().langs}. أي كلام يبدو بلغة غيرها هو إحدى هذه اللغات لم يُسمع جيداً (ضوضاء أو لهجة): افهمه على هذا الأساس أو اطلب الإعادة. لا تردّ أبداً بلغة خارج هذه القائمة.`,
    ...(() => {
      const u = unheardAnswers();
      return u.length ? [`===== ردود جديدة من نيكست الكبير لم يسمعها الوليد =====\n${u.map((x, i) => `${i + 1}) ${x.title}:\n${x.answer}`).join('\n\n')}`] : [];
    })(),
    opts.forChat ? '' : call.firstToday
      ? '===== أول مكالمة اليوم =====\nهذه أول مكالمة للوليد اليوم. بعد صورة اليوم (أو بعد ما يطلبه)، اسأله سؤالاً واحداً قصيراً إن كان يريد المرور على القرارات المعلّقة (البنود بلا موعد والمقترحات) — بلا سرد أرقام كثيرة.'
      : 'ليست أول مكالمة اليوم: لا تذكر البنود بلا موعد ولا المقترحات من نفسك؛ فقط إن سأل.',
    ...(() => {
      const mem = callMemory();
      return mem.length ? [`===== مكالماتك ودردشاتك السابقة اليوم مع الوليد (ما حدث فعلاً) =====\n${mem.map((c) => `- ${c.at}${c.via ? ' (' + c.via + ')' : ''}: ${c.events.join('؛ ')}`).join('\n')}\nاستعملها للاستمرارية كزميل يتذكر («زي ما قلنا الصبح…»): لا تعرض عليه ما قُفل أو انتهى، ولا تسرد هذا القسم عليه.`] : [];
    })(),
    ...(() => {
      if (opts.forChat) return []; // في الدردشة نفسها تصل الرسائل كمحادثة لا كتعليمات
      const msgs = chatToday().slice(-12);
      return msgs.length ? [`===== دردشتكما النصية اليوم (آخر الرسائل) =====\n${msgs.map((m) => `${m.role === 'user' ? 'الوليد' : 'نيكست'} (${m.at}): ${m.text}`).join('\n')}\nإن عاد إليها في المكالمة فأكمل من حيث توقفتما، ولا تعِد ما قيل.`] : [];
    })(),
    '===== الختام =====\nإن ودّعك أو قال ما معناه «خلاص كده»: اختم بجملة واحدة بما تم فعلاً في هذه المكالمة إن نُفّذ شيء («تمام، قفلنا ريفي وبعتنا سؤال لنيكست الكبير»)، ثم ودّعه. لا تذكر شيئاً لم يُنفَّذ.',
    `آخر تحديث للفهرس: ${vault.built || 'غير معروف'}.`,
  ].filter(Boolean).join('\n\n');
}

// ---------- الصوت ----------
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.t = 0; this.last = 0; this.buf = new Int16Array(640); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const L = ch.length;
    let t = this.t;
    while (t <= L - 1) {
      const i = Math.floor(t), f = t - i;
      const a = i < 0 ? this.last : ch[i];
      const b = i + 1 < L ? ch[i + 1] : ch[L - 1];
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(640); this.n = 0; }
      t += this.ratio;
    }
    this.t = t - L;
    this.last = ch[L - 1];
    return true;
  }
}
registerProcessor('capture', Capture);`;

const audio = { ctx: null, stream: null, node: null, src: null, out: null, inAn: null, outAn: null, playHead: 0, sources: new Set() };

// بوابة المايك: سماعة الجوال تُرجع صوت نيكست إلى المايك (صدى)، والضوضاء تُفرَّغ كلاماً وهمياً.
// ما دون العتبة يُرسل صمتاً (لا يُقطع البث حتى يعرف Gemini أن الكلام انتهى). أثناء كلام نيكست العتبة أعلى بكثير،
// فلا يمر إلا صوت الوليد الواضح فوقه (المقاطعة).
const GATE = { noise: 0.01, barge: 0.08, bargeChunks: 3, hangMs: 600, tailMs: 500, preChunks: 5 };
const gate = { loud: 0, openUntil: 0, pre: [] };

// ---------- تشخيص الصوت: أرقام فقط (مستويات وعدادات)، يبقى على الجهاز ولا يُرفع ----------
// الهدف: معرفة أين يضيع الكلام (البوابة؟ فلتر الصدى؟ Gemini؟) قبل أي تعديل على العتبات.
const diag = { cur: null };
function diagStart() {
  diag.cur = { start: new Date().toISOString(), chunks: 0, sent: 0, opens: 0, bargeOpens: 0, lostWhilePlaying: 0, mutedWhilePlaying: 0, echoDropped: 0, voiceSum: 0, voiceN: 0, noiseSum: 0, noiseN: 0, maxRms: 0, transcripts: 0, transChars: 0, unclearConfirms: 0, reconnects: 0 };
}
function diagEnd() {
  const c = diag.cur;
  if (!c) return;
  diag.cur = null;
  c.end = new Date().toISOString();
  c.avgVoice = c.voiceN ? +(c.voiceSum / c.voiceN).toFixed(4) : 0;
  c.avgNoise = c.noiseN ? +(c.noiseSum / c.noiseN).toFixed(4) : 0;
  c.maxRms = +c.maxRms.toFixed(4);
  delete c.voiceSum; delete c.voiceN; delete c.noiseSum; delete c.noiseN;
  try {
    const arr = JSON.parse(store.get('diag.calls') || '[]');
    arr.push(c);
    while (arr.length > 30) arr.shift();
    store.set('diag.calls', JSON.stringify(arr));
  } catch {}
}
function rms16(u8) {
  const s = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
  return s.length ? Math.sqrt(sum / s.length) / 32768 : 0;
}
// نيكست يتكلم الآن، أو أنهى كلامه منذ أقل من ms
function nextSpeaking(ms = GATE.tailMs) {
  return audio.sources.size > 0 || (!!audio.ctx && audio.ctx.currentTime < audio.playHead + ms / 1000);
}
// كل كلماته موجودة فيما قاله نيكست للتو (وهو يتكلم أو بعده بلحظة) ← صدى من السماعة لا كلام الوليد
function isEcho(text) {
  if (!nextSpeaking(1500)) return false;
  const split = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = split(text);
  if (!words.length) return true;
  const said = new Set(split(call.modelText)); // كلمات كاملة: «لا» ليست صدى لأن «الأحد» فيها «لا»
  // وبداية كلمة قالها (التفريغ يقطع الصدى أحياناً: «على تلي» من «على تيليجرام»)
  return words.every((w) => said.has(w) || (w.length >= 3 && [...said].some((x) => x.startsWith(w))));
}
function gateChunk(u8) {
  const now = Date.now(), playing = nextSpeaking();
  const r = rms16(u8);
  const d = diag.cur;
  if (d) {
    d.chunks++;
    if (r > d.maxRms) d.maxRms = r;
    if (r < GATE.noise) { d.noiseSum += r; d.noiseN++; } else { d.voiceSum += r; d.voiceN++; }
    if (playing && r >= GATE.noise && r < GATE.barge) d.lostWhilePlaying++; // صوت فوق عتبة الهدوء ضاع لأن نيكست يتكلم
  }
  if (playing && settings().barge === 'off') { gate.loud = 0; gate.pre = []; gate.openUntil = 0; if (d && r >= GATE.noise) d.mutedWhilePlaying++; return [new Uint8Array(u8.length)]; } // المقاطعة مُطفأة: المايك صامت وهو يتكلم
  gate.loud = r >= (playing ? GATE.barge : GATE.noise) ? gate.loud + 1 : 0;
  if (gate.loud >= (playing ? GATE.bargeChunks : 1)) {
    const fresh = now > gate.openUntil;
    if (d && fresh) { d.opens++; if (playing) d.bargeOpens++; }
    const out = fresh ? [...gate.pre, u8] : [u8]; // ما قبل بداية الكلام حتى لا يضيع أول الحرف
    gate.pre = [];
    gate.openUntil = now + GATE.hangMs;
    if (d) d.sent += out.length;
    return out;
  }
  if (now < gate.openUntil) { if (d) d.sent++; return [u8]; } // ذيل الجملة وما بين الكلمات
  if (playing && !gate.loud) gate.pre = []; // أثناء كلام نيكست لا يُحفظ إلا الصوت العالي (بداية مقاطعة)، لا الصدى
  else gate.pre.push(u8);
  if (gate.pre.length > GATE.preChunks) gate.pre.shift();
  return [new Uint8Array(u8.length)];
}

async function startAudio(onChunk) {
  audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  await audio.ctx.resume();
  audio.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
  await audio.ctx.audioWorklet.addModule(url);
  audio.src = audio.ctx.createMediaStreamSource(audio.stream);
  audio.node = new AudioWorkletNode(audio.ctx, 'capture');
  audio.node.port.onmessage = (e) => onChunk(new Uint8Array(e.data));
  audio.inAn = audio.ctx.createAnalyser();
  audio.inAn.fftSize = 512;
  audio.src.connect(audio.inAn);
  audio.src.connect(audio.node);
  // العقدة يجب أن تتصل بالمخرج لتعمل في بعض المتصفحات؛ نمررها بصوت صفر
  const mute = audio.ctx.createGain();
  mute.gain.value = 0;
  audio.node.connect(mute).connect(audio.ctx.destination);
  audio.out = audio.ctx.createGain();
  audio.outAn = audio.ctx.createAnalyser();
  audio.outAn.fftSize = 512;
  audio.out.connect(audio.outAn);
  audio.out.connect(audio.ctx.destination);
  audio.playHead = audio.ctx.currentTime;
}

function stopAudio() {
  stopPlayback();
  audio.stream?.getTracks().forEach((t) => t.stop());
  audio.ctx?.close();
  Object.assign(audio, { ctx: null, stream: null, node: null, src: null, out: null, inAn: null, outAn: null });
}

function playPcm24k(b64) {
  if (!audio.ctx) return;
  call.lastModel = Date.now();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const buf = audio.ctx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = audio.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(audio.out);
  const at = Math.max(audio.ctx.currentTime + 0.03, audio.playHead);
  src.start(at);
  audio.playHead = at + buf.duration;
  audio.sources.add(src);
  src.onended = () => audio.sources.delete(src);
}

function stopPlayback() {
  for (const s of audio.sources) { try { s.stop(); } catch {} }
  audio.sources.clear();
  if (audio.ctx) audio.playHead = audio.ctx.currentTime;
}

function level(an) {
  if (!an) return 0;
  const d = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(d);
  let sum = 0;
  for (const v of d) sum += (v - 128) ** 2;
  return Math.min(1, Math.sqrt(sum / d.length) / 40);
}

function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- المكالمة ----------
const call = {
  active: false, session: null, handle: null, muted: false, ending: false,
  started: 0, retries: 0, wakeLock: null, raf: 0, tick: 0, pending: null, check: null, events: [], askOnStart: null,
  lastUser: 0, lastModel: 0, modelText: '', firstToday: false, news: [], offered: [], pollTimer: 0, idleTimer: 0,
};

// أُعلن في هذه المكالمة ولم يُسمع بعد: لا يُعلن ثانيةً فيها، ويبقى heard: no حتى answers_heard
function offer(list) {
  for (const x of list) announced.add(x.path);
  call.offered.push(...list);
}
function markAllHeard(list) {
  for (const x of list) announced.add(x.path);
  Promise.allSettled(list.map((x) => markHeard(x.path)))
    .then((r) => r.forEach((x) => x.status === 'rejected' && console.warn('markHeard', x.reason)));
}

// ردود تصل أثناء المكالمة: فحص الفهرس كل دقيقتين، والإعلان في أول توقف للكلام
const NEWS_POLL_MS = 120000;
async function pollNews() {
  if (!call.active) return;
  try { await loadVault(); } catch { return; }
  const known = new Set(call.news.map((x) => x.path));
  call.news.push(...unheardAnswers().filter((x) => !known.has(x.path)));
  renderTasks(); // ما أُغلق أو جدّ في Open Loops أثناء المكالمة
}
const YES = /(^|[\s،,.!؟?])(أيوه|ايوه|أيوا|ايوا|أيوة|ايوة|آه|اه|أه|نعم|تمام|صح|صحيح|أكيد|اكيد|ماشي|أوكي|اوكي|يلا|بالظبط|بالضبط|ok|okay|yes|yeah|yep|sure)($|[\s،,.!؟?])/i;
const NO = /(^|[\s،,.!؟?])(لا|لأ|لاء|مش|غلط|استنى|استني|الغي|ألغي|بلاش|no|nope|cancel|wait)($|[\s،,.!؟?])/i;
// مسار التأكيد الواحد: الأداة الفعلية تُعلَّق (call.pending) ← نيكست يسأل مرة ← بعد ردّ الوليد يستدعي confirm_action
// ← الكود يحكم من كلام الوليد نفسه (لا من النموذج) وينفّذ أو يلغي، ويعطي نيكست جملة واحدة يقولها. لا تنبيهات نصية، فلا تكرار.
const PENDING_TTL = 120000;
const DONE_LINE = {
  mark_done: 'تمام، قفلتها.',
  add_to_inbox: 'سجّلتها.',
  ask_big_next: 'أرسلتها لنيكست الكبير، وهيبلغك على تيليجرام لما يخلّصها.',
};
async function confirmAction() {
  const pend = call.pending;
  if (!pend) return { status: 'لا يوجد فعل ينتظر التأكيد — لم يُنفَّذ شيء', instruction: 'لا تقل إنه تم. إن كان يريد فعلاً فاستدعِ أداته الآن.' };
  if (Date.now() - pend.at > PENDING_TTL) {
    call.pending = null;
    note('tool', '⌛ أُلغي (لم يصل تأكيد)');
    return { status: 'انتهت مهلة التأكيد — لم يُنفَّذ', instruction: 'قل له إنك لم تنفّذه، وإن ما زال يريده فاستدعِ أداته من جديد.' };
  }
  if (!pend.heard.trim()) await new Promise((r) => setTimeout(r, 900)); // تفريغ كلامه قد يتأخر لحظة عن استدعاء الأداة
  const said = pend.heard.trim();
  const no = NO.test(said), yes = YES.test(said);
  if (yes && !no) {
    call.pending = null;
    let result;
    try { result = await runTool(pend.name, pend.args, true); } catch (e) { result = { error: String(e.message || e) }; }
    if (result.error) {
      note('tool', `✗ ${result.error}`);
      return { status: 'فشل التنفيذ', error: result.error, instruction: 'قل له بجملة إنه فشل والسبب باختصار.' };
    }
    note('tool', `✓ نُفّذ: ${summarize(pend.name, pend.args)}`);
    // طلب إغلاق جماعي عبر نيكست الكبير: يُخفى ما فيه من القوائم مؤقتاً حتى تصل المزامنة
    if (pend.name === 'ask_big_next' && /(أغلق|إغلاق|اغلاق|اقفل|أقفل|قفل|مُغلق|مغلق|خلص|انتهى|سلّم)/.test(`${pend.args.title || ''} ${pend.args.request || ''}`)) {
      addPendingClose(`${pend.args.title || ''}\n${pend.args.request || ''}`);
    }
    if (pend.name === 'mark_done' || pend.name === 'ask_big_next') { boardCache = { key: '', text: '' }; setTimeout(renderTasks, 50); } // يختفي من القائمة فوراً
    callEvent(summarize(pend.name, pend.args).replace(/^هقفل:/, 'قُفل:').replace(/^هسجّل/, 'سُجّل').replace(/^هبعت/, 'أُرسل').replace(/\s*\((واتساب|مش ظاهر)[^)]*\)\s*$/, ''));
    return { status: 'نُفّذ', instruction: `قل جملة واحدة فقط: «${DONE_LINE[pend.name] || 'تم.'}» ولا تكرر ما سألته. وإن كان الوليد قد طلب أفعالاً أخرى لم تُرسل بعد، فاستدعِ أداة التالي منها الآن.` };
  }
  if (no) {
    call.pending = null;
    note('tool', '✗ أُلغي بطلبك');
    return { status: 'رفض الوليد — أُلغي ولم يُنفَّذ', instruction: 'قل «تمام، مش هعملها» بجملة قصيرة، وإن بدا أنه يريد شيئاً معدّلاً فاسأله عنه. وإن كان قد طلب أفعالاً أخرى لم تُرسل بعد، فاستدعِ أداة التالي منها.' };
  }
  pend.heard = '';
  pend.at = Date.now();
  if (diag.cur) diag.cur.unclearConfirms++;
  return { status: 'لم يتضح رده — لم يُنفَّذ، وما زال ينتظر', heard: said || '(لم يُسمع شيء)', instruction: 'اسأله مرة واحدة باختصار: «أيوه ولا لا؟»، ثم استدعِ confirm_action بعد رده.' };
}
function announceIfIdle() {
  const now = Date.now();
  const pend = call.pending;
  if (pend && now - pend.at > PENDING_TTL) { call.pending = null; note('tool', '⌛ أُلغي (لم يصل تأكيد)'); }
  else if (pend && pend.heard.trim() && !pend.nudged && now - call.lastUser > 6000 && now - call.lastModel > 3000 && call.session) {
    // ردّ الوليد ولم يستدعِ نيكست confirm_action: تذكير واحد (لا يُنفَّذ شيء دون استدعائها)
    pend.nudged = true;
    call.session.sendRealtimeInput({ text: '(تنبيه من النظام، لا تقرأه) الوليد ردّ على سؤال التأكيد. استدعِ confirm_action الآن ولا تقل شيئاً قبل نتيجتها.' });
  }
  const idle = audio.sources.size === 0 && now - call.lastUser > 4000 && now - call.lastModel > 2500;
  checkTasksSaid(now, idle);
  if (!call.news.length || !call.session || !idle) return;
  const list = call.news.splice(0);
  const body = list.map((x, i) => `${i + 1}) ${x.title}:\n${x.answer}`).join('\n\n');
  call.session.sendRealtimeInput({
    text: `(تنبيه من النظام، لا تقرأه حرفياً) وصل الآن ${list.length === 1 ? 'رد' : list.length + ' ردود'} من نيكست الكبير. قل للوليد بجملة قصيرة إنه وصل رد على: ${list.map((x) => x.title).join('، ')}، واسأله إن كان يريد سماعه. إن وافق فهذا هو الرد، قله بإيجاز ثم استدعِ answers_heard (وكذلك إن رفض سماعه أصلاً؛ لا إن قال «بعدين»):\n${body}`,
  });
  note('tool', '📬 وصل رد من نيكست الكبير');
  offer(list);
}
function startNewsWatch() {
  call.pollTimer = setInterval(pollNews, NEWS_POLL_MS);
  call.idleTimer = setInterval(announceIfIdle, 1000);
}
function stopNewsWatch() {
  clearInterval(call.pollTimer);
  clearInterval(call.idleTimer);
  call.news = [];
}

async function startCall() {
  const s = settings();
  if (lock.locked) { call.askOnStart = null; return; }
  if (!s.key || !s.repo || (s.repo !== 'local' && !s.token)) {
    call.askOnStart = null;
    $('settings').showModal();
    setStatus('أكمل الإعدادات أولاً', 'err');
    return;
  }
  call.active = true;
  call.ending = false;
  call.handle = null;
  call.retries = 0;
  call.modelText = '';
  call.check = null;
  call.events = [];
  panel.said = '';
  diagStart();
  ui.meter.hidden = false;
  ui.orb.disabled = true;
  setStatus('أحمّل العقل الثاني…', 'busy');
  try {
    const n = await loadVault();
    setStatus(`حمّلت ${n} ملفاً — أفتح المايك…`, 'busy');
    await startAudio((u8) => {
      if (!call.muted && call.session) {
        for (const c of gateChunk(u8)) {
          try { call.session.sendRealtimeInput({ audio: { data: u8ToB64(c), mimeType: 'audio/pcm;rate=16000' } }); } catch {}
        }
      }
    });
    // أول مكالمة اليوم (تُحسب قبل الاتصال لأن تعليمات الجلسة تُبنى فيه)
    call.firstToday = store.get('call.day') !== riyadhNow().date;
    await connect();
    call.started = Date.now();
    store.set('call.day', riyadhNow().date);
    const unheard = unheardAnswers();
    const unheardLine = unheard.length
      ? `عنده ${unheard.length === 1 ? 'رد جديد' : unheard.length + ' ردود جديدة'} من نيكست الكبير على: ${unheard.map((x) => x.title).join('، ')} — اذكرها بجملة واسأله إن كان يريد سماعها؛ بعد أن تقرأها عليه، أو إن رفض سماعها أصلاً، استدعِ answers_heard.`
      : '';
    if (call.askOnStart) {
      const { item, kind } = call.askOnStart;
      call.askOnStart = null;
      askAbout(item, kind);
      if (unheard.length) offer(unheard); // الردود الجديدة في تعليماته، يذكرها بعد البند
    } else if (call.firstToday && settings().opener !== 'off') {
      // أول مكالمة اليوم: نيكست يبادر كمساعد بشري بدل أن ينتظر «إيه مهامي؟» — رسالة واحدة فلا يتكرر الرد
      call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه) أول مكالمة للوليد اليوم: ابدأ أنت الكلام. استدعِ my_tasks، ثم حيّه تحية قصيرة تناسب الوقت وأعطه صورة اليوم بجملتين كزميل (المتأخر عليه هو بالاسم، والباقي مجموعاً بصاحبه، وجملة بما ينتظر اعتماده إن وُجد)، ثم اسأله من أين يبدأ. ${unheardLine} إن بدأ هو بالكلام قبلك فأجبه أولاً.` });
      if (unheard.length) offer(unheard);
    } else if (unheard.length) {
      call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه) ابدأ بإخبار الوليد باختصار أن ${unheardLine}` });
      offer(unheard);
    }
    startNewsWatch();
    renderTasks();
    acquireWakeLock();
    ui.mute.hidden = ui.end.hidden = ui.composer.hidden = false;
    showComposer();
    ui.orb.classList.remove('idle');
    ui.orb.textContent = 'إنهاء';
    ui.orb.setAttribute('aria-label', 'إنهاء المكالمة');
    animate();
  } catch (e) {
    console.error(e);
    call.askOnStart = null;
    note('sys', 'تعذّر البدء: ' + (e.message || e));
    await endCall(true);
  } finally {
    ui.orb.disabled = false;
  }
}

async function connect() {
  const s = settings();
  const ai = new GoogleGenAI({ apiKey: s.key });
  // الرسائل وإغلاق الاتصال قد تصل قبل أن تُرجع connect() الجلسة، لذلك تشير الـ callbacks إلى ref لا إلى المتغير
  // وإن أُغلق قبل ذلك فقد لا تنتهي connect() أبداً، فنسابقها بالإغلاق المبكر وبمهلة
  const ref = { s: null, closed: null, fail: null, abandoned: false };
  const early = new Promise((_, reject) => { ref.fail = reject; });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة الاتصال بـ Gemini (20 ث) — تحقق من الإنترنت.')), 20000));
  const pending = ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstruction(),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: TOOLS,
      contextWindowCompression: { slidingWindow: {} },
      // بداية الكلام بحساسية منخفضة: الضوضاء القصيرة لا تُحسب كلاماً
      realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', prefixPaddingMs: 200 } },
      sessionResumption: call.handle ? { handle: call.handle } : {},
    },
    callbacks: {
      onopen: () => setStatus('متصل — تكلّم', 'live'),
      onmessage: (m) => onMessage(m, ref),
      onerror: (e) => { console.error('live error', e); note('sys', 'خطأ: ' + (e.message || 'غير معروف')); },
      onclose: (e) => onClose(e, ref),
    },
  });
  let session;
  try {
    session = await Promise.race([pending, early, timeout]);
  } catch (e) {
    ref.abandoned = true;
    pending.then((late) => { try { late.close(); } catch {} }, () => {});
    throw e;
  }
  if (ref.closed) throw new Error(closeReason(ref.closed));
  ref.s = session;
  const old = call.session;
  call.session = session;
  if (old && old !== session) { try { old.close(); } catch {} }
  return session;
}

async function onMessage(m, ref) {
  if (ref.abandoned || (ref.s && ref.s !== call.session)) return;
  const session = ref.s;
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
    call.handle = m.sessionResumptionUpdate.newHandle;
  }
  if (m.goAway) {
    // الاتصال ينتهي قريباً (نحو 10 دقائق لكل اتصال) — نكمل بنفس الجلسة
    reconnect('goAway');
  }
  if (m.toolCall?.functionCalls?.length) {
    const responses = [];
    for (const fc of m.toolCall.functionCalls) {
      note('tool', toolLabel(fc.name, fc.args));
      let response;
      try { response = await runTool(fc.name, fc.args); } catch (e) { response = { error: String(e.message || e) }; }
      if (fc.name === 'add_to_inbox' && response.ok) note('tool', '✓ سُجّل في ' + response.path);
      if (fc.name === 'ask_big_next' && response.ok) note('tool', '✓ أُرسل — الرد على تيليجرام');
      responses.push({ id: fc.id, name: fc.name, response, scheduling: FunctionResponseScheduling.INTERRUPT });
    }
    if (session && session === call.session) session.sendToolResponse({ functionResponses: responses });
  }
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.interrupted) stopPlayback();
  if (sc.inputTranscription?.text) {
    call.lastUser = Date.now();
    if (diag.cur) { diag.cur.transcripts++; diag.cur.transChars += sc.inputTranscription.text.length; }
    // يُحتسب فقط كلامه بعد أن بدأ نيكست يسأله (لا بقايا تفريغ جملته الأولى)
    // يُحسب كلامه بعد أن بدأ نيكست يسأله، إلا ما هو صدى كلام نيكست نفسه («…صح؟») — بالكلمات لا بالتوقيت،
    // لأن نيكست يبدأ الرد فور سكوته فيصل تفريغ «أيوه» وهو يتكلم
    if (call.pending && call.lastModel > call.pending.at) {
      if (isEcho(sc.inputTranscription.text)) { if (diag.cur) diag.cur.echoDropped++; }
      else call.pending.heard += ' ' + sc.inputTranscription.text;
    }
    say('user', sc.inputTranscription.text);
  }
  for (const p of sc.modelTurn?.parts || []) {
    if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) playPcm24k(p.inlineData.data);
  }
  if (sc.outputTranscription?.text) {
    call.modelText = (call.modelText + ' ' + sc.outputTranscription.text).slice(-600);
    if (call.check) call.check.buf = (call.check.buf + ' ' + sc.outputTranscription.text).slice(-8000);
    markSaid(sc.outputTranscription.text);
    say('next', sc.outputTranscription.text);
  }
  if (sc.turnComplete) bubble = { role: null, el: null };
}

function toolLabel(name, args = {}) {
  switch (name) {
    case 'search_vault': return `🔎 يبحث: ${args.query || ''}`;
    case 'read_note': return `📄 يقرأ: ${args.name || ''}`;
    case 'open_loops': return '📋 يقرأ البنود المفتوحة';
    case 'my_tasks': return '🗒️ مهام اليوم';
    case 'mark_done': return `✔️ انتهى: ${args.item || ''}`;
    case 'add_to_inbox': return `✍️ يسجّل: ${args.title || ''}`;
    case 'ask_big_next': return `📨 إلى نيكست الكبير: ${args.title || ''}`;
    case 'big_next_status': return '📬 يراجع ردود نيكست الكبير';
    case 'answers_heard': return '👂 سمع ردود نيكست الكبير';
    case 'idea_edit_note': return `✏️ ملاحظة تعديل: ${args.note || ''}`;
    case 'confirm_action': return '🗣️ يتحقق من ردك';
    default: return name;
  }
}

let reconnecting = false;
async function reconnect(reason) {
  if (reconnecting || !call.active || call.ending) return;
  if (diag.cur && reason !== 'goAway') diag.cur.reconnects++; // goAway تجديد دوري طبيعي
  reconnecting = true;
  setStatus('أجدد الاتصال…', 'busy');
  try {
    await connect();
    call.retries = 0;
  } catch (e) {
    console.error('reconnect failed', reason, e);
    if (++call.retries <= 3) {
      reconnecting = false;
      setTimeout(() => reconnect('retry'), 1500 * call.retries);
      return;
    }
    note('sys', 'انقطع الاتصال ولم أستطع العودة.');
    endCall(true);
  }
  reconnecting = false;
}

function closeReason(e) {
  const r = e?.reason || '';
  if (/API key not valid/i.test(r)) return 'مفتاح Gemini غير صالح — راجعه في الإعدادات.';
  if (/billing|quota|exceeded|RESOURCE_EXHAUSTED/i.test(r)) return 'رفضت Google الطلب بسبب الفوترة أو الحصة: ' + r;
  if (/not found|not supported/i.test(r)) return 'النموذج غير متاح لهذا المفتاح: ' + r;
  return `أُغلق الاتصال (${e?.code ?? '؟'})${r ? ': ' + r : ' دون سبب معلن'}`;
}

function onClose(e, ref) {
  console.warn('closed', e?.code, e?.reason);
  if (!ref.s) { // أُغلق قبل اكتمال الإعداد — connect() ترمي الخطأ
    ref.closed = e || {};
    if (!ref.abandoned) ref.fail(new Error(closeReason(ref.closed)));
    return;
  }
  if (ref.s !== call.session) return; // جلسة قديمة أغلقناها بأنفسنا
  if (!call.active || call.ending) return;
  note('sys', closeReason(e));
  if (call.handle) reconnect('close');
  else endCall(true);
}

async function endCall(silent = false) {
  call.ending = true;
  diagEnd();
  if (call.events?.length) note('sys', `🧾 في هذه المكالمة: ${call.events.join('؛ ')}`);
  saveCallMemory();
  call.events = [];
  ui.meter.hidden = true;
  clearTimeout(panelTimer);
  panel.said = '';
  call.check = null;
  stopNewsWatch(); // ما لم يُعلن بعد يبقى heard: no ويُقال في المكالمة التالية
  call.pending = null; // فعل لم يُؤكَّد لا يُنفَّذ
  Object.assign(gate, { loud: 0, openUntil: 0, pre: [] });
  for (const x of call.offered) announced.delete(x.path); // ما أُعلن ولم يُقرأ يبقى heard: no ويُذكر في المكالمة التالية
  call.offered = [];
  const mins = call.started ? (Date.now() - call.started) / 60000 : 0;
  if (mins > 0) addUsage(mins);
  try { call.session?.close(); } catch {}
  call.session = null;
  call.active = false;
  call.started = 0;
  stopAudio();
  releaseWakeLock();
  cancelAnimationFrame(call.raf);
  ui.orb.style.setProperty('--lvl', 0);
  ui.orb.className = 'orb idle';
  ui.orb.textContent = 'اتصل';
  ui.orb.setAttribute('aria-label', 'ابدأ المكالمة');
  ui.mute.hidden = ui.end.hidden = true;
  setTimeout(showComposer, 0);
  ui.mute.classList.remove('on');
  ui.mute.textContent = 'كتم المايك';
  call.muted = false;
  setTimeout(() => { renderTasks(); refreshIdle(true); applyUpdateIfIdle(); }, 0);
  if (!silent) setStatus('انتهت المكالمة');
  else if (!ui.status.textContent.startsWith('أكمل')) setStatus('متوقف', 'err');
  renderUsage();
}

function animate() {
  const loop = () => {
    if (!call.active) return;
    const speaking = audio.sources.size > 0;
    const lvl = speaking ? level(audio.outAn) : call.muted ? 0 : level(audio.inAn);
    ui.orb.style.setProperty('--lvl', lvl.toFixed(3));
    ui.orb.classList.toggle('speaking', speaking);
    ui.meterFill.style.width = Math.min(100, (call.muted ? 0 : level(audio.inAn)) * 100).toFixed(1) + '%';
    ui.meter.classList.toggle('playing', speaking);
    if (++call.tick % 15 === 0 && call.started) {
      const sec = Math.floor((Date.now() - call.started) / 1000);
      ui.timer.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }
    call.raf = requestAnimationFrame(loop);
  };
  call.raf = requestAnimationFrame(loop);
}

// ---------- قفل الشاشة ----------
async function acquireWakeLock() {
  try { call.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { call.wakeLock?.release(); } catch {}
  call.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && call.active) acquireWakeLock();
});

// ---------- الاستهلاك ----------
function monthKey() { return 'usage.' + riyadhNow().date.slice(0, 7); }
function addUsage(mins) {
  store.set(monthKey(), String((parseFloat(store.get(monthKey(), '0')) || 0) + mins));
}
function renderUsage() {
  const m = parseFloat(store.get(monthKey(), '0')) || 0;
  // تقدير أعلى: كل دقيقة مكالمة = دقيقة إدخال + دقيقة إخراج
  const cost = m * (COST_IN_PER_MIN + COST_OUT_PER_MIN);
  ui.cost.textContent = `هذا الشهر: ${Math.round(m)} د ≈ ${cost.toFixed(2)}$ (حد أعلى)`;
  applyDemoChrome();
}

// ---------- الأحداث ----------
ui.orb.addEventListener('click', () => (call.active ? endCall() : startCall()));
ui.end.addEventListener('click', () => endCall());
ui.mute.addEventListener('click', () => {
  call.muted = !call.muted;
  ui.mute.classList.toggle('on', call.muted);
  ui.mute.textContent = call.muted ? 'المايك مكتوم' : 'كتم المايك';
  if (call.muted) try { call.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
});
ui.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = ui.text.value.trim();
  if (!t) return;
  if (!call.session) { if (!call.active && settings().chat !== 'off') { ui.text.value = ''; chatSend(t); } return; }
  note('user', t);
  call.lastUser = Date.now();
  if (call.pending) call.pending.heard += ' ' + t;
  call.session.sendRealtimeInput({ text: t });
  ui.text.value = '';
});

// ---------- الدردشة دون اتصال ----------
// نموذج Gemini نصي بالأدوات والتعليمات نفسها؛ الأفعال بزرّي تأكيد/إلغاء؛ محادثة اليوم على الجهاز وتصل للمكالمة التالية.
const chat = { pending: null, busy: false, sid: Date.now().toString(36) };
const CHAT_PREFIX = `===== قناة هذه الجلسة: دردشة نصية في التطبيق (لا مكالمة) =====
- تجاهل قواعد الكلام المسموع والتأكيد الصوتي في Voice Assistant: لا confirm_action ولا «صح؟». أي فعل (إغلاق، تسجيل، طلب لنيكست الكبير) استدعِ أداته مباشرة، فيُعلَّق ويظهر للوليد زرّا «تأكيد/إلغاء».
- ردود مكتوبة قصيرة ومباشرة: سطر إلى ثلاثة، ونقاط قصيرة إن لزم. بلهجته كما في المكالمة.
- للأسئلة السريعة: ابحث في الـ Vault بأدواتك وأجب مباشرة، واذكر المصدر باختصار.
- لا تبادر بصورة اليوم ولا بالقرارات المعلّقة إلا إن سأل.`;
function clockNow() {
  const [hh, mm] = riyadhNow().time.split(':').map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`;
}
function chatToday() {
  try { const d = JSON.parse(store.get('chat.today') || '{}'); return d.date === riyadhNow().date ? d.msgs : []; } catch { return []; }
}
function chatPush(role, text) {
  const msgs = [...chatToday(), { role, text, at: clockNow() }].slice(-40);
  store.set('chat.today', JSON.stringify({ date: riyadhNow().date, msgs }));
}
const modelVer = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
// أحدث نموذج Flash نصي متاح لمفتاحه (لا تخمين لاسم)، ويُحفظ؛ يُعاد الاختيار إن فشل
async function chatModel(ai) {
  const cached = store.get('chat.model');
  if (cached) return cached;
  const names = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) {
      const n = (m.name || '').replace(/^models\//, '');
      const acts = m.supportedActions || [];
      if (/^gemini-.*flash/.test(n) && !/(live|tts|image|audio|embed|native)/.test(n) && (!acts.length || acts.includes('generateContent'))) names.push(n);
    }
  } catch (e) { console.warn('models.list', e); }
  const stable = names.filter((n) => !/(preview|exp|lite)/.test(n));
  const pool = stable.length ? stable : names.filter((n) => !/lite/.test(n));
  pool.sort((a, b) => (modelVer(b) - modelVer(a)) || (a.length - b.length));
  const best = pool[0] || 'gemini-2.5-flash';
  store.set('chat.model', best);
  return best;
}
function closeLike(args) {
  return /(أغلق|إغلاق|اغلاق|اقفل|أقفل|قفل|مُغلق|مغلق|خلص|انتهى|سلّم)/.test(`${args.title || ''} ${args.request || ''}`);
}
async function chatSend(text, opts = {}) {
  const shown = opts.display || text; // ما يظهر للوليد ويُحفظ في محادثة اليوم؛ النموذج يصله text
  const s = settings();
  if (lock.locked) return;
  if (!s.key) { $('settings').showModal(); setStatus('أكمل الإعدادات أولاً', 'err'); return; }
  if (chat.busy) return;
  chat.busy = true;
  const history = chatToday().slice(-20).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  note('user', shown);
  chatPush('user', shown);
  setStatus('نيكست يكتب…', 'busy');
  try {
    if (!vault.byPath.size) await loadVault();
    const ai = new GoogleGenAI({ apiKey: s.key });
    const tools = [{ functionDeclarations: TOOLS[0].functionDeclarations.filter((f) => !['confirm_action', 'answers_heard'].includes(f.name)) }];
    const si = CHAT_PREFIX + '\n\n' + systemInstruction({ forChat: true });
    const contents = [...history, { role: 'user', parts: [{ text }] }];
    let reply = '', model = await chatModel(ai);
    const gen = () => ai.models.generateContent({ model, contents, config: { systemInstruction: si, tools } });
    for (let round = 0; round < 6; round++) {
      let res;
      try { res = await gen(); }
      catch (e) {
        // النموذج المحفوظ لم يعد متاحاً: يُعاد الاختيار مرة واحدة
        if (round === 0 && /not found|not supported|404/i.test(String(e.message || e))) { store.set('chat.model', ''); model = await chatModel(ai); res = await gen(); }
        else throw e;
      }
      const fcs = res.functionCalls || [];
      if (!fcs.length) { reply = res.text || ''; break; }
      contents.push(res.candidates[0].content);
      const parts = [];
      for (const fc of fcs) {
        note('tool', toolLabel(fc.name, fc.args || {}));
        let r;
        try { r = await runTool(fc.name, fc.args || {}, false, 'chat'); } catch (e) { r = { error: String(e.message || e) }; }
        parts.push({ functionResponse: { name: fc.name, response: r } });
      }
      contents.push({ role: 'user', parts });
    }
    reply = reply.trim() || 'ما قدرتش أوصل لإجابة، جرّب تصيغها تاني.';
    note('next', reply);
    chatPush('next', reply);
    if (chat.pending) renderChatConfirm();
    setStatus('جاهز');
  } catch (e) {
    console.error(e);
    note('sys', 'تعذّر الرد: ' + (e.message || e));
    setStatus('تعذّر الرد', 'err');
  } finally {
    chat.busy = false;
  }
}
function renderChatConfirm() {
  const p = chat.pending;
  if (!p) return;
  const box = document.createElement('div');
  box.className = 'msg tool confirm';
  const label = document.createElement('div');
  label.textContent = '⏸ ' + summarize(p.name, p.args);
  const row = document.createElement('div');
  row.className = 'row';
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'pill primary'; ok.textContent = 'تأكيد';
  const no = document.createElement('button'); no.type = 'button'; no.className = 'pill'; no.textContent = 'إلغاء';
  row.append(ok, no);
  box.append(label, row);
  ui.log.appendChild(box);
  bubble = { role: null, el: null };
  ui.log.scrollTop = ui.log.scrollHeight;
  const finish = (txt) => { row.remove(); label.textContent = txt; };
  ok.addEventListener('click', async () => {
    if (chat.pending !== p) return finish('انتهت صلاحية هذا الطلب');
    chat.pending = null;
    ok.disabled = no.disabled = true;
    let r;
    try { r = await runTool(p.name, p.args, true, 'chat'); } catch (e) { r = { error: String(e.message || e) }; }
    if (r.error) { finish('✗ فشل: ' + r.error); return; }
    finish('✓ نُفّذ: ' + summarize(p.name, p.args));
    memoryEvent(summarize(p.name, p.args).replace(/^هقفل:/, 'قُفل:').replace(/^هسجّل/, 'سُجّل').replace(/^هبعت/, 'أُرسل').replace(/\s*\((واتساب|مش ظاهر)[^)]*\)\s*$/, ''));
    if (p.name === 'ask_big_next' && closeLike(p.args)) addPendingClose(`${p.args.title || ''}\n${p.args.request || ''}`);
    boardCache = { key: '', text: '' };
    renderTasks();
    const line = DONE_LINE[p.name] || 'تم.';
    note('next', line);
    chatPush('next', line);
  });
  no.addEventListener('click', () => {
    if (chat.pending === p) chat.pending = null;
    finish('✗ أُلغي');
    chatPush('next', 'تمام، ألغيتها.');
  });
}
function showComposer() {
  ui.composer.hidden = !(call.active || (settings().chat !== 'off' && !lock.locked));
  ui.text.placeholder = call.active ? 'أو اكتب هنا…' : 'اسأل نيكست كتابةً…';
}
// محادثة اليوم تظهر عند فتح التطبيق (آخر 12 رسالة)
for (const m of chatToday().slice(-12)) note(m.role === 'user' ? 'user' : 'next', m.text);

// الإعدادات
const dlg = $('settings');
const sel = $('sVoice');
for (const [v, label] of VOICES) sel.add(new Option(label, v));
function fillSettings() {
  const s = settings();
  $('sKey').value = s.key; $('sToken').value = s.token; $('sRepo').value = store.get('repo'); sel.value = s.voice;
  renderLangs();
  showStorage();
  showLock();
}
function showLock() {
  const mode = store.get('lock.mode');
  $('lockToggle').textContent = lockEnabled() ? 'إيقاف قفل Face ID' : 'تفعيل قفل Face ID';
  $('lockStatus').textContent = !lockEnabled() ? 'غير مفعّل — المفتاح والرمز محفوظان على الجهاز دون تشفير.'
    : mode === 'prf' ? '✓ مفعّل: المفتاح والرمز مشفّران، ولا يُفتحان إلا بـ Face ID.'
    : '✓ مفعّل كقفل للواجهة فقط (هذا الجهاز لا يدعم التشفير بـ Face ID).';
}
// اللغات: أزرار تُفعَّل وتُعطَّل، ولغة أخرى تُضاف من الخانة. تُحفظ نصاً مفصولاً بـ «، ».
function renderLangs() {
  const chosen = splitLangs(settings().langs);
  const all = [...LANG_OPTIONS, ...chosen.filter((l) => !LANG_OPTIONS.includes(l))];
  const box = $('sLangs');
  box.replaceChildren(...all.map((lang) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = lang;
    b.setAttribute('aria-pressed', String(chosen.includes(lang)));
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      if (!on && selectedLangs().length === 1) return; // لغة واحدة على الأقل
      b.setAttribute('aria-pressed', String(on));
      store.set('langs', selectedLangs().join('، '));
    });
    return b;
  }));
}
function selectedLangs() {
  return [...$('sLangs').querySelectorAll('.chip[aria-pressed="true"]')].map((b) => b.textContent);
}
function addLang() {
  const v = $('sLangNew').value.trim();
  if (!v) return;
  store.set('langs', [...new Set([...selectedLangs(), ...splitLangs(v)])].join('، '));
  $('sLangNew').value = '';
  renderLangs();
}
$('sLangAdd').addEventListener('click', addLang);
$('sLangNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLang(); } });
function showStorage() {
  const out = $('checkResult');
  const where = [storage.ls && 'localStorage', storage.idb && 'IndexedDB', storage.cache && 'Cache'].filter(Boolean);
  if (where.length) {
    out.style.color = 'var(--muted)';
    out.textContent = `الحفظ: ✓ على هذا الجهاز (${where.join(' + ')})${storage.persisted ? ' · دائم' : ''}`;
  } else {
    out.style.color = 'var(--warn)';
    out.textContent = '⚠️ المتصفح يمنع الحفظ (تصفح خاص، أو «حظر كل ملفات تعريف الارتباط» في إعدادات Safari) — ستُطلب الإعدادات عند كل فتح.';
  }
}
function saveSettings() {
  store.set('key', $('sKey').value.trim());
  store.set('token', $('sToken').value.trim());
  store.set('repo', $('sRepo').value.trim());
  store.set('voice', sel.value);
  store.set('langs', selectedLangs().join('، '));
  if (store.get('lock.mode') === 'prf') sealSecrets();
}
$('lockToggle').addEventListener('click', async () => {
  const out = $('lockStatus');
  try {
    if (lockEnabled()) {
      if (!confirm('إيقاف قفل Face ID؟ سيُحفظ المفتاح والرمز دون تشفير.')) return;
      await disableLock();
    } else {
      saveSettings();
      out.textContent = 'أنتظر Face ID…';
      await enableLock();
    }
  } catch (e) {
    out.textContent = '✗ ' + (e.name === 'NotAllowedError' ? 'أُلغي أو انتهت المهلة.' : e.message);
    return;
  }
  showLock();
});
function showBarge() {
  const on = settings().barge !== 'off';
  $('bargeToggle').textContent = on ? 'مفعّلة — تقاطعه بصوت عالٍ' : 'مُطفأة — المايك مغلق وهو يتكلم';
  $('bargeToggle').classList.toggle('on', !on);
}
$('bargeToggle').addEventListener('click', () => { store.set('barge', settings().barge === 'off' ? 'on' : 'off'); showBarge(); });
function showTaskCheck() {
  const on = settings().taskCheck !== 'off';
  $('taskCheckToggle').textContent = on ? 'مفعّل — يذكّره بما أسقطه من السرد' : 'مُطفأ';
  $('taskCheckToggle').classList.toggle('on', !on);
}
$('taskCheckToggle').addEventListener('click', () => { store.set('taskCheck', settings().taskCheck === 'off' ? 'on' : 'off'); showTaskCheck(); });
function showBoardFix() {
  const on = settings().boardFix !== 'off';
  $('boardFixToggle').textContent = on ? 'مفعّل — يخفي المُغلق ويضيف الجديد' : 'مُطفأ — اللوحة كما كتبها الماك';
  $('boardFixToggle').classList.toggle('on', !on);
}
$('boardFixToggle').addEventListener('click', () => { store.set('boardFix', settings().boardFix === 'off' ? 'on' : 'off'); boardCache = { key: '', text: '' }; showBoardFix(); });
$('diagExport').addEventListener('click', async () => {
  const data = JSON.stringify({ gate: GATE, version: document.querySelector('script[src^="app.js"]')?.src.split('v=')[1] || '', calls: JSON.parse(store.get('diag.calls') || '[]') });
  try { await navigator.clipboard.writeText(data); $('diagInfo').textContent = `✓ نُسخ (${JSON.parse(store.get('diag.calls') || '[]').length} مكالمة) — ألصقه لنيكست في محادثة Claude.`; }
  catch { $('diagInfo').textContent = 'تعذّر النسخ: ' + data.slice(0, 160); }
});
function showOpener() {
  const on = settings().opener !== 'off';
  $('openerToggle').textContent = on ? 'مفعّل — يحيّيك بصورة اليوم' : 'مُطفأ — ينتظرك تبدأ';
  $('openerToggle').classList.toggle('on', !on);
}
$('openerToggle').addEventListener('click', () => { store.set('opener', settings().opener === 'off' ? 'on' : 'off'); showOpener(); });
function showTasksPanel() {
  const on = settings().tasksPanel !== 'off';
  $('tasksToggle').textContent = on ? 'مفعّل — تظهر أثناء المكالمة' : 'مُطفأ';
  $('tasksToggle').classList.toggle('on', !on);
}
$('tasksToggle').addEventListener('click', () => { store.set('tasksPanel', settings().tasksPanel === 'off' ? 'on' : 'off'); showTasksPanel(); renderTasks(); refreshIdle(true); });
// فتح القائمة وطيّها يُحفظ (في السيارة تبقى مطوية)
// طيّ القائمة وفتحها بزر صريح (details/summary لا يُطوى بثبات في Safari على iPhone)، والحالة تُحفظ
function setTasksOpen(open) {
  $('tasksPanel').classList.toggle('open', open);
  $('tasksHead').setAttribute('aria-expanded', String(open));
  $('tasksHint').textContent = open ? 'اضغط للطي' : 'اضغط للفتح';
  store.set('tasksOpen', open ? 'on' : 'off');
}
setTasksOpen(store.get('tasksOpen', 'off') === 'on');
$('tasksHead').addEventListener('click', () => setTasksOpen(!$('tasksPanel').classList.contains('open')));
$('eyeBtn').addEventListener('click', () => { moneyShown = !moneyShown; applyDemoChrome(); renderTasks(); });
function showChatToggle() {
  const on = settings().chat !== 'off';
  $('chatToggle').textContent = on ? 'مفعّلة — اكتب له دون اتصال' : 'مُطفأة — الكتابة أثناء المكالمة فقط';
  $('chatToggle').classList.toggle('on', !on);
}
$('chatToggle').addEventListener('click', () => { store.set('chat', settings().chat === 'off' ? 'on' : 'off'); showChatToggle(); showComposer(); });
$('settingsBtn').addEventListener('click', () => { fillSettings(); showBarge(); showTaskCheck(); showBoardFix(); showOpener(); showTasksPanel(); showChatToggle(); $('appVersion').textContent = 'إصدار التطبيق: ' + APP_VERSION; dlg.showModal(); });
// الحفظ عند الضغط وعند أي تعديل — لا نعتمد على حدث close للنافذة لأنه لا يصل في بعض المتصفحات
$('saveBtn').addEventListener('click', () => { saveSettings(); setStatus('حُفظت الإعدادات'); });
for (const id of ['sKey', 'sToken', 'sRepo', 'sVoice']) $(id).addEventListener('change', saveSettings);
$('testBtn').addEventListener('click', async () => {
  saveSettings();
  const out = $('checkResult');
  out.style.color = 'var(--muted)';
  out.textContent = 'أختبر…';
  try {
    const n = await loadVault();
    out.style.color = 'var(--ok)';
    out.textContent = `✓ الـ Vault متصل: ${n} ملفاً (آخر فهرسة ${vault.built || '—'})`;
  } catch (e) {
    out.style.color = 'var(--err)';
    out.textContent = '✗ ' + e.message;
  }
});

// القفل: عند الفتح، وبعد 5 دقائق في الخلفية (لا يقفل أثناء مكالمة)
$('unlockBtn').addEventListener('click', async () => {
  try { await unlock(); if (!settings().key) setStatus('ابدأ من الإعدادات ⚙︎'); }
  catch (e) { $('lockError').textContent = e.name === 'NotAllowedError' ? 'لم يكتمل التحقق، حاول مرة أخرى.' : e.message; }
});
$('lockReset').addEventListener('click', async () => {
  if (!confirm('مسح المفتاح والرمز المشفّرين وإيقاف القفل؟ ستدخلهما من جديد في الإعدادات.')) return;
  memory.delete('key'); memory.delete('token');
  await disableLock();
  lock.locked = false;
  $('lockScreen').hidden = true;
  fillSettings(); dlg.showModal();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { lock.hiddenAt = Date.now(); return; }
  if (lockEnabled() && !call.active && lock.hiddenAt && Date.now() - lock.hiddenAt > LOCK_AFTER_MS) lockNow();
});
if (lockEnabled()) lockNow();

renderUsage();
if (!settings().key) setStatus('ابدأ من الإعدادات ⚙︎');

// ---------- المهام خارج المكالمة ----------
// تُجلب نسخة الـ Vault حين يكون التطبيق مفتوحاً وغير مقفل، فتظهر البطاقات دون اتصال.
let idleLoadAt = 0;
async function refreshIdle(force = false) {
  const s = settings();
  if (call.active || lock.locked || s.tasksPanel === 'off' || !s.repo || (s.repo !== 'local' && !s.token)) return;
  if (!force && Date.now() - idleLoadAt < 60000) return;
  idleLoadAt = Date.now();
  try { await loadVault(); boardCache = { key: '', text: '' }; renderTasks(); } catch (e) { console.warn('idle load', e); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshIdle(); checkUpdate(); } });

// ---------- التحديث التلقائي ----------
// التطبيق المثبّت على الشاشة الرئيسية قد يبقى على نسخة قديمة أياماً: يقارن رقم الإصدار المنشور بالحالي،
// ويعيد التحميل فقط وهو خامل (لا مكالمة، ولا رد يُكتب، ولا فعل ينتظر زر التأكيد).
const APP_VERSION = (document.querySelector('script[src*="app.js?v="]')?.getAttribute('src') || '').split('v=')[1] || '';
let updateReady = false, lastUpdateCheck = 0;
async function checkUpdate() {
  if (!APP_VERSION || Date.now() - lastUpdateCheck < 5 * 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const html = await (await fetch('index.html?u=' + Date.now(), { cache: 'no-store' })).text();
    const v = (html.match(/app\.js\?v=([\w.-]+)/) || [])[1];
    if (v && v !== APP_VERSION) { updateReady = true; applyUpdateIfIdle(); }
  } catch {}
}
function applyUpdateIfIdle() {
  if (!updateReady || call.active || chat.busy || chat.pending) return;
  setStatus('أحدّث التطبيق لآخر نسخة…', 'busy');
  setTimeout(() => location.reload(), 400);
}
setInterval(checkUpdate, 30 * 60000);
setTimeout(checkUpdate, 3000);
refreshIdle(true);
showComposer();

// للتجربة من الـ console فقط
window.__nv = { verifyItem, boardSection, confirmAction, openLoopsForVoice, doneToday, addDoneToday, lock, lockNow, sealSecrets, openSecrets, aesFromPrf, persistAll, memory, searchVault, findNote, openLoopsText, loadVault, systemInstruction, runTool, connect, storage, idbGet, cacheGet, call, audio, pollNews, announceIfIdle, unheardAnswers, myTasks, checkTerms, checkTasksSaid, boardText, diag, renderTasks, panel, indexNotes, vault, chat, chatSend, chatToday, callMemory, renderChatConfirm, systemInstruction, dueInfo, lateLabel, projectOf, checkUpdate, applyUpdateIfIdle };
