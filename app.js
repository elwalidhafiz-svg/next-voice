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
const CORE_FILES = ['_System/Voice Assistant.md', '_System/identity.md', '_System/soul.md', '_System/user.md'];
const OPEN_LOOPS = '_System/Open Loops.md';

// ---------- تخزين محلي آمن ----------
// إن مُنع localStorage (تصفح خاص مثلاً) تبقى الإعدادات في الذاكرة حتى إغلاق الصفحة
const memory = new Map();
const store = {
  get(k, d = '') {
    try { const v = localStorage.getItem('nv.' + k); if (v !== null) return v; } catch {}
    return memory.get(k) ?? d;
  },
  set(k, v) { memory.set(k, v); try { localStorage.setItem('nv.' + k, v); } catch {} },
};
// #local للتجربة على الماك فقط
const devRepo = location.hash === '#local' && ['localhost', '127.0.0.1'].includes(location.hostname) ? 'local' : '';
const settings = () => ({
  key: store.get('key'),
  token: store.get('token'),
  repo: devRepo || store.get('repo').trim(),
  voice: store.get('voice', 'Orus'),
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

async function addToInbox({ title, content, kind = 'ملاحظة' }) {
  const { date, time } = riyadhNow();
  const safe = (title || 'ملاحظة صوتية').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  const path = `Inbox/${date} ${time.replace(':', '')} صوتي - ${safe}.md`;
  const body = `---\nsource: نيكست الصوتي\nkind: ${kind}\ncreated: ${date} ${time}\n---\n# ${safe}\n\n${content}\n`;
  if (settings().repo === 'local') {
    console.info('[local] add_to_inbox', path, body);
  } else {
    await gh(`contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `voice: ${safe}`, content: b64utf8(body) }),
    });
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
      description: 'البنود المفتوحة: الالتزامات والمواعيد والمستحقات غير المحصّلة لكل المشاريع.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'add_to_inbox',
      description: 'سجّل شيئاً في Inbox/ ليُعالَج لاحقاً (ملاحظة، مهمة، قرار، فكرة، أو سؤال يحتاج نيكست الكبير). هذه الطريقة الوحيدة للكتابة في الـ Vault.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان قصير' },
          content: { type: 'string', description: 'المحتوى مستخلصاً بالفصحى، مع الأسماء والتواريخ والمبالغ كما قالها' },
          kind: { type: 'string', enum: ['ملاحظة', 'مهمة', 'قرار', 'فكرة', 'سؤال لنيكست الكبير'] },
        },
        required: ['title', 'content'],
      },
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
      return { text: openLoopsText().slice(0, 14000) };
    case 'add_to_inbox':
      return { ok: true, path: await addToInbox(args) };
    default:
      return { error: 'أداة غير معروفة' };
  }
}

function systemInstruction() {
  const parts = CORE_FILES.map((p) => vault.byPath.get(p)).filter(Boolean)
    .map((n) => `===== ${n.path} =====\n${n.text}`);
  const entities = vault.notes
    .filter((n) => /^(People|Projects|Companies)\//.test(n.path))
    .map((n) => `- ${n.path}${n.aliases?.length ? ` (${n.aliases.join('، ')})` : ''}`)
    .join('\n');
  const { date, time } = riyadhNow();
  return [
    'أنت نيكست في مكالمة صوتية حية مع الوليد. التعليمات أدناه من ملفات الـ Vault نفسها؛ ملف Voice Assistant يحكم شكل الكلام في هذه القناة.',
    `الآن: ${date} الساعة ${time} بتوقيت الرياض.`,
    ...parts,
    `===== الكيانات التي لها ملفات (للبحث) =====\n${entities}`,
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
};

async function startCall() {
  const s = settings();
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
  const session = await ai.live.connect({
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
      onmessage: (m) => onMessage(m, session),
      onerror: (e) => { console.error('live error', e); note('sys', 'خطأ: ' + (e.message || 'غير معروف')); },
      onclose: (e) => onClose(e, session),
    },
  });
  const old = call.session;
  call.session = session;
  if (old && old !== session) { try { old.close(); } catch {} }
  return session;
}

async function onMessage(m, session) {
  if (session !== call.session) return;
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
      responses.push({ id: fc.id, name: fc.name, response, scheduling: FunctionResponseScheduling.INTERRUPT });
    }
    if (session === call.session) session.sendToolResponse({ functionResponses: responses });
  }
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.interrupted) stopPlayback();
  if (sc.inputTranscription?.text) say('user', sc.inputTranscription.text);
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
    case 'add_to_inbox': return `✍️ يسجّل: ${args.title || ''}`;
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

function onClose(e, session) {
  if (session !== call.session) return; // جلسة قديمة أغلقناها بأنفسنا
  if (!call.active || call.ending) return;
  console.warn('closed', e?.code, e?.reason);
  if (e?.reason) note('sys', 'أُغلق الاتصال: ' + e.reason);
  if (call.handle) reconnect('close');
  else endCall(true);
}

async function endCall(silent = false) {
  call.ending = true;
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
  $('checkResult').textContent = '';
}
function saveSettings() {
  store.set('key', $('sKey').value.trim());
  store.set('token', $('sToken').value.trim());
  store.set('repo', $('sRepo').value.trim());
  store.set('voice', sel.value);
}
$('settingsBtn').addEventListener('click', () => { fillSettings(); dlg.showModal(); });
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'save') { saveSettings(); setStatus('حُفظت الإعدادات'); }
});
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

renderUsage();
if (!settings().key) setStatus('ابدأ من الإعدادات ⚙︎');

// للتجربة من الـ console فقط
window.__nv = { searchVault, findNote, openLoopsText, loadVault, systemInstruction, runTool };
