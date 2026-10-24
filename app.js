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
    for (const seg of splitTop(m[2], ['؛'])) {
      const late = /^و?المتأخر\s*:/.test(seg);
      const body = seg.replace(/^و?المتأخر\s*:\s*/, '');
      // اللوحة قد تفصل أيام الخطة بـ« · » وتسبق كل يوم بـ«من الأحد 18:» — كلاهما ليس من المهمة
      for (const sub of splitTop(body, [' · ', '، و', '، '])) {
        const task = sub.replace(/^و/, '').replace(/^من\s+\S+\s+\d{1,2}\s*:\s*/, '').trim();
        if (!task || /^لا شيء/.test(task)) continue;
        items.push(`متابعة ${m[1]}: ${task}${late ? ' — متأخر' : ''}`);
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
function withinWeek(line) {
  const m = line.match(/(\d{1,2})\s+(يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/);
  if (!m) return true;
  const mo = AR_MONTHS.findIndex((x) => norm(x) === norm(m[2]));
  const { date } = riyadhNow();
  const [y, cm, cd] = date.split('-').map(Number);
  let due = Date.UTC(y, mo, +m[1]);
  const today = Date.UTC(y, cm - 1, cd);
  if (due < today - 180 * 864e5) due = Date.UTC(y + 1, mo, +m[1]); // ديسمبر ← يناير
  return (due - today) / 864e5 <= 7;
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
const panel = { said: '', terms: [], items: [], tab: '' };
function panelList(items, opts = {}) {
  const said = norm(panel.said);
  const terms = checkTerms(items);
  const ul = document.createElement('ul');
  items.forEach((x, i) => {
    const li = document.createElement('li');
    const late = / — متأخر/.test(x);
    const text = x.replace(/^عليك:\s*/, '').replace(/^متابعة يومية — ([^:]+):\s*(بند واحد، هو |\S+ بنود؛ )?/, 'متابعة $1: ').replace(/^متابعة (?!يومية)[^:]+:\s*/, opts.kind ? '$&' : '').replace(/ — (متأخر.*|اليوم)$/, '').split(' ← ')[0];
    li.append(document.createTextNode(text));
    if (late) { const s = document.createElement('span'); s.className = 'late'; s.textContent = 'متأخر'; li.append(s); }
    // ✓ عرضيّ متشدد: أندر كلمة في البند + كلمتان (كلمات مثل «صرة» و«خطة» تتكرر في بنود كثيرة)
    const ts = terms[i] || [];
    const hit = ts.filter((t) => said.includes(t)).length;
    if (ts.length && said.includes(ts[0]) && hit >= Math.min(2, ts.length)) li.classList.add('said');
    li.addEventListener('click', () => askAbout(x, opts.kind));
    ul.append(li);
  });
  return ul;
}
function renderTasks() {
  const box = document.getElementById('tasksPanel');
  if (!box) return;
  if (settings().tasksPanel === 'off' || lock.locked || !vault.byPath.size) { box.hidden = true; return; }
  const items = myTasks();
  const week = boardItems('مفتوح الآن — قادم').filter(withinWeek);
  const props = boardItems('مقترحات للـ Open Loops (تنتظر قرارك)');
  panel.items = items;
  const tab = panel.tab || 'today';
  const body = document.getElementById('tasksBody');
  body.replaceChildren();
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  for (const [key, label, n] of [['today', 'اليوم', items.length], ['week', 'الأسبوع', week.length], ['props', 'مقترحات', props.length]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (key === tab ? ' on' : '');
    b.textContent = `${label} ${n}`;
    b.addEventListener('click', (ev) => { ev.preventDefault(); panel.tab = key; store.set('tasksTab', key); renderTasks(); });
    tabs.append(b);
  }
  body.append(tabs);
  const empty = (msg) => { const d = document.createElement('div'); d.className = 'appr'; d.textContent = msg; body.append(d); };
  if (tab === 'today') {
    const groups = [['عليك', (x) => x.startsWith('عليك')], ['متابعة', (x) => x.startsWith('متابعة ')], ['عند غيرك', () => true]];
    const used = new Set();
    for (const [name, test] of groups) {
      const list = items.filter((x, i) => !used.has(i) && test(x));
      items.forEach((x, i) => { if (!used.has(i) && test(x)) used.add(i); });
      if (!list.length) continue;
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = name === 'متابعة' ? (list[0].match(/^متابعة ([^:]+):/)?.[0].replace(':', '') || 'متابعة') : name;
      body.append(h, panelList(list));
    }
    if (!items.length) empty('لا مهام موعدها اليوم.');
    const appr = boardSection('اعتمادات معلّقة').split('\n').filter((l) => l.startsWith('- ') && !/:\s*0\s*$/.test(l)).map((l) => l.slice(2).trim());
    if (appr.length) empty('ينتظر اعتمادك: ' + appr.join(' · '));
  } else if (tab === 'week') {
    if (week.length) body.append(panelList(week, { kind: 'week' })); else empty('لا شيء موعده خلال الأيام السبعة القادمة.');
  } else {
    if (props.length) body.append(panelList(props, { kind: 'proposal' })); else empty('لا مقترحات تنتظر قرارك.');
  }
  document.getElementById('tasksTitle').textContent = items.length ? `مهام اليوم (${items.length})` : 'لا مهام موعدها اليوم';
  const tip = call.active ? 'اضغط بنداً ليحدّثك عنه' : 'اضغط بنداً يتصل نيكست ويحدّثك عنه';
  if (body.firstChild && !body.querySelector('.tip')) { const d = document.createElement('div'); d.className = 'appr tip'; d.textContent = tip; body.insertBefore(d, body.children[1] || null); }
  box.hidden = false;
}
function askAbout(item, kind) {
  if (!call.session) { // خارج المكالمة: الضغط يبدأ المكالمة، ونيكست يفتتح بهذا البند
    if (call.active) return; // المكالمة تتصل الآن
    call.askOnStart = { item, kind };
    startCall();
    return;
  }
  const what = kind === 'proposal'
    ? `هذا مقترح ينتظر قراره: «${item}». قل له بجملة ما هو ومن أين ظهر، واسأله: يضيفه بموعد، أو متابعة يومية، أو يتجاهله — ونفّذ حسب رده بقاعدة «المرور على مقترحات».`
    : `«${item}». قل له ما تعرفه عنه بجملتين (ابحث في الـ Vault إن لزم: آخر ما حدث، ومن عنده الفعل التالي)، واسأله إن كان يريد فعل شيء فيه. لا تنفّذ شيئاً دون طلبه.`;
  call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه) الوليد ضغط على هذا البند في الشاشة: ${what}` });
  note('tool', `👆 سأل عن: ${clip(item, 60)}`);
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
        items,
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
  setTimeout(() => { renderTasks(); refreshIdle(true); }, 0);
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
async function chatSend(text) {
  const s = settings();
  if (lock.locked) return;
  if (!s.key) { $('settings').showModal(); setStatus('أكمل الإعدادات أولاً', 'err'); return; }
  if (chat.busy) return;
  chat.busy = true;
  const history = chatToday().slice(-20).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  note('user', text);
  chatPush('user', text);
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
function showChatToggle() {
  const on = settings().chat !== 'off';
  $('chatToggle').textContent = on ? 'مفعّلة — اكتب له دون اتصال' : 'مُطفأة — الكتابة أثناء المكالمة فقط';
  $('chatToggle').classList.toggle('on', !on);
}
$('chatToggle').addEventListener('click', () => { store.set('chat', settings().chat === 'off' ? 'on' : 'off'); showChatToggle(); showComposer(); });
$('settingsBtn').addEventListener('click', () => { fillSettings(); showBarge(); showTaskCheck(); showBoardFix(); showOpener(); showTasksPanel(); showChatToggle(); dlg.showModal(); });
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIdle(); });
refreshIdle(true);
showComposer();

// للتجربة من الـ console فقط
window.__nv = { verifyItem, boardSection, confirmAction, openLoopsForVoice, doneToday, addDoneToday, lock, lockNow, sealSecrets, openSecrets, aesFromPrf, persistAll, memory, searchVault, findNote, openLoopsText, loadVault, systemInstruction, runTool, connect, storage, idbGet, cacheGet, call, audio, pollNews, announceIfIdle, unheardAnswers, myTasks, checkTerms, checkTasksSaid, boardText, diag, renderTasks, panel, indexNotes, vault, chat, chatSend, chatToday, callMemory, renderChatConfirm, systemInstruction };
