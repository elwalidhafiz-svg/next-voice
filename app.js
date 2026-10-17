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
// Pending Approvals وWhatsApp Today: نسختان تلقائيتان من سكربت الماك (اعتمادات الشيتين، وملخص واتساب آخر 24 ساعة)
const CORE_FILES = ['_System/Voice Assistant.md', '_System/identity.md', '_System/soul.md', '_System/user.md', '_System/Pending Approvals.md', '_System/WhatsApp Today.md'];
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
});

// ---------- واجهة ----------
const $ = (id) => document.getElementById(id);
const ui = {
  orb: $('orb'), dot: $('dot'), status: $('statusText'), log: $('log'),
  timer: $('timer'), cost: $('cost'), mute: $('muteBtn'), end: $('endBtn'),
  composer: $('composer'), text: $('textInput'),
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

function snippet(n, ts) {
  let pos = -1;
  for (const t of ts) { pos = n._text.indexOf(t); if (pos !== -1) break; }
  if (pos === -1) pos = 0;
  // _text يطابق text حرفاً بحرف تقريباً (التشكيل قد يزيح قليلاً، وهذا مقبول للمقتطف)
  const start = Math.max(0, pos - 120);
  return n.text.slice(start, start + 320).replace(/\s+/g, ' ').trim();
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
function whatsappDone() {
  const n = vault.byPath.get('_System/WhatsApp Today.md');
  const sec = n ? (n.text.split('## يبدو أنه أُنجز اليوم')[1] || '').split('\n## ')[0].trim() : '';
  return sec && !/^- لا شيء/.test(sec) ? sec : '';
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

async function addToInbox({ title, content, kind = 'ملاحظة' }) {
  const { date, time } = riyadhNow();
  const safe = (title || 'ملاحظة صوتية').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  const path = `Inbox/${date} ${time.replace(':', '')} صوتي - ${safe}.md`;
  // طلبات نيكست الكبير يلتقطها سكربت الماك بحالة pending (انظر next_voice_sync.py)
  const extra = kind === BIG_KIND ? `status: pending\ncreated_utc: ${new Date().toISOString()}\n` : '';
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
      // بلا parameters: Gemini يرفض كائناً بخصائص فارغة
      description: 'البنود المفتوحة: الالتزامات والمواعيد والمستحقات غير المحصّلة لكل المشاريع.',
    },
    {
      name: 'add_to_inbox',
      description: 'سجّل ملاحظة أو فكرة أو قراراً في Inbox/ ليُعالَج لاحقاً. ليس لمهام To Do: أي مهمة تُرسل بـ ask_big_next لتُضاف فعلاً. أعد ما ستسجّله بجملة وانتظر موافقة الوليد قبل الاستدعاء.',
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
      description: 'أرسل طلباً إلى نيكست الكبير (Claude على الماك) حين يحتاج ما لا تملكه: إضافة مهمة To Do، واتساب، الشيتات، Gmail، Trello، تقرير، أو تحليل عميق. للأسئلة استدعها مباشرة. للأفعال (مهمة، تعديل، رسالة) أكّد فهمك مع الوليد بجملة واحدة وانتظر موافقته قبل الاستدعاء، لأن نيكست الكبير سينفّذ دون سؤال.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان قصير للطلب' },
          request: { type: 'string', description: 'الطلب كاملاً وواضحاً بالفصحى، بالأسماء والتواريخ والسياق من المكالمة، ليفهمه دون أن يسمعها' },
        },
        required: ['title', 'request'],
      },
    },
    {
      name: 'mark_done',
      description: 'حين يقول الوليد إن بنداً من البنود المفتوحة انتهى («خلصت…»، «سحر سلّمت»)، أو يوافق على إغلاق ما يبدو من واتساب أنه أُنجز: أكّد البند بجملة، ثم استدعها. يتوقف ذكره فوراً، ويغلقه نيكست الكبير في Open Loops.',
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
      name: 'big_next_status',
      description: 'حالة طلبات نيكست الكبير الأخيرة وردوده (من آخر مزامنة للـ Vault).',
    },
  ],
}];

const MAX_NOTE = 9000;
async function runTool(name, args = {}) {
  switch (name) {
    case 'search_vault': {
      const r = searchVault(args.query || '');
      return r.length ? { results: r } : { results: [], note: 'لا نتائج. جرّب اسماً آخر أو تهجئة مختلفة.' };
    }
    case 'read_note': {
      const n = findNote(args.name || '');
      if (!n) return { error: 'الملف غير موجود', suggestions: searchVault(args.name || '', 3).map((x) => x.path) };
      return { path: n.path, text: n.text.slice(0, MAX_NOTE), truncated: n.text.length > MAX_NOTE };
    }
    case 'open_loops':
      return { text: openLoopsForVoice().slice(0, 16000) };
    case 'mark_done': {
      addDoneToday(args.item);
      const r = await addToInbox({ title: `إغلاق: ${args.item}`.slice(0, 60), content: `أغلق في _System/Open Loops.md البند: ${args.item}\n(انقله إلى «مُغلق» بتاريخ اليوم وسطر قصير بالسبب: ${args.evidence || 'قال الوليد إنه انتهى'}.)`, kind: BIG_KIND });
      return { ok: true, path: r, note: 'لن يُذكر بعد الآن، ونيكست الكبير يغلقه في Open Loops خلال دقائق.' };
    }
    case 'add_to_inbox':
      return { ok: true, path: await addToInbox(args) };
    case 'ask_big_next':
      return {
        ok: true,
        path: await addToInbox({ title: args.title, content: args.request, kind: BIG_KIND }),
        note: 'أُرسل. إن كان الماك مفتوحاً يصل الرد على تيليجرام خلال دقائق، وإلا يُنفَّذ فور فتح الماك ويصل ملخص بما فُعل، ويستطيع الوليد إلغاءه من تيليجرام.',
      };
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

function systemInstruction() {
  const parts = CORE_FILES.map((p) => vault.byPath.get(p)).filter(Boolean)
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
    `آخر تحديث للفهرس: ${vault.built || 'غير معروف'}.`,
  ].join('\n\n');
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
  started: 0, retries: 0, wakeLock: null, raf: 0, tick: 0,
  lastUser: 0, lastModel: 0, news: [], pollTimer: 0, idleTimer: 0,
};

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
}
function announceIfIdle() {
  const now = Date.now();
  const idle = audio.sources.size === 0 && now - call.lastUser > 4000 && now - call.lastModel > 2500;
  if (!call.news.length || !call.session || !idle) return;
  const list = call.news.splice(0);
  const body = list.map((x, i) => `${i + 1}) ${x.title}:\n${x.answer}`).join('\n\n');
  call.session.sendRealtimeInput({
    text: `(تنبيه من النظام، لا تقرأه حرفياً) وصل الآن ${list.length === 1 ? 'رد' : list.length + ' ردود'} من نيكست الكبير. قل للوليد بجملة قصيرة إنه وصل رد على: ${list.map((x) => x.title).join('، ')}، واسأله إن كان يريد سماعه. إن وافق فهذا هو الرد، قله بإيجاز:\n${body}`,
  });
  note('tool', '📬 وصل رد من نيكست الكبير');
  markAllHeard(list);
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
  if (lock.locked) return;
  if (!s.key || !s.repo || (s.repo !== 'local' && !s.token)) {
    $('settings').showModal();
    setStatus('أكمل الإعدادات أولاً', 'err');
    return;
  }
  call.active = true;
  call.ending = false;
  call.handle = null;
  call.retries = 0;
  ui.orb.disabled = true;
  setStatus('أحمّل العقل الثاني…', 'busy');
  try {
    const n = await loadVault();
    setStatus(`حمّلت ${n} ملفاً — أفتح المايك…`, 'busy');
    await startAudio((u8) => {
      if (!call.muted && call.session) {
        try { call.session.sendRealtimeInput({ audio: { data: u8ToB64(u8), mimeType: 'audio/pcm;rate=16000' } }); } catch {}
      }
    });
    await connect();
    call.started = Date.now();
    const unheard = unheardAnswers();
    if (unheard.length) {
      call.session.sendRealtimeInput({ text: `(تنبيه من النظام، لا تقرأه) ابدأ بإخبار الوليد باختصار أن عنده ${unheard.length === 1 ? 'رداً جديداً' : unheard.length + ' ردود جديدة'} من نيكست الكبير على: ${unheard.map((x) => x.title).join('، ')}، واسأله إن كان يريد سماعها.` });
      markAllHeard(unheard);
    }
    startNewsWatch();
    acquireWakeLock();
    ui.mute.hidden = ui.end.hidden = ui.composer.hidden = false;
    ui.orb.classList.remove('idle');
    ui.orb.textContent = 'إنهاء';
    ui.orb.setAttribute('aria-label', 'إنهاء المكالمة');
    animate();
  } catch (e) {
    console.error(e);
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
  if (sc.inputTranscription?.text) { call.lastUser = Date.now(); say('user', sc.inputTranscription.text); }
  for (const p of sc.modelTurn?.parts || []) {
    if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) playPcm24k(p.inlineData.data);
  }
  if (sc.outputTranscription?.text) say('next', sc.outputTranscription.text);
  if (sc.turnComplete) bubble = { role: null, el: null };
}

function toolLabel(name, args = {}) {
  switch (name) {
    case 'search_vault': return `🔎 يبحث: ${args.query || ''}`;
    case 'read_note': return `📄 يقرأ: ${args.name || ''}`;
    case 'open_loops': return '📋 يقرأ البنود المفتوحة';
    case 'mark_done': return `✔️ انتهى: ${args.item || ''}`;
    case 'add_to_inbox': return `✍️ يسجّل: ${args.title || ''}`;
    case 'ask_big_next': return `📨 إلى نيكست الكبير: ${args.title || ''}`;
    case 'big_next_status': return '📬 يراجع ردود نيكست الكبير';
    default: return name;
  }
}

let reconnecting = false;
async function reconnect(reason) {
  if (reconnecting || !call.active || call.ending) return;
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
  stopNewsWatch(); // ما لم يُعلن بعد يبقى heard: no ويُقال في المكالمة التالية
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
  ui.mute.hidden = ui.end.hidden = ui.composer.hidden = true;
  ui.mute.classList.remove('on');
  ui.mute.textContent = 'كتم المايك';
  call.muted = false;
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
  if (!t || !call.session) return;
  note('user', t);
  call.lastUser = Date.now();
  call.session.sendRealtimeInput({ text: t });
  ui.text.value = '';
});

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
$('settingsBtn').addEventListener('click', () => { fillSettings(); dlg.showModal(); });
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

// للتجربة من الـ console فقط
window.__nv = { openLoopsForVoice, doneToday, addDoneToday, lock, lockNow, sealSecrets, openSecrets, aesFromPrf, persistAll, memory, searchVault, findNote, openLoopsText, loadVault, systemInstruction, runTool, connect, storage, idbGet, cacheGet, call, audio, pollNews, announceIfIdle, unheardAnswers };
