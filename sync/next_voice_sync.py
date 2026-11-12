#!/usr/bin/env python3
"""مزامنة الـ Vault مع GitHub لنيكست الصوتي.

1. يبني فهرساً للبحث في .next-voice/index.json (يقرؤه تطبيق الجوال).
2. إن كان الـ Vault مستودع git له remote: commit ثم pull --rebase ثم push.
3. «نيكست الكبير»: طلبات صوتية في Inbox/ بنوع BIG_KIND وحالة pending — تُنفَّذ كلها بـ Claude على الماك
   مهما تأخر فتحه، ويُكتب الرد وما تغيّر في ملف الطلب.
   - حديثة (≤ STALE_MIN): يُرسل ردها على تيليجرام فور انتهائها.
   - متأخرة (الماك كان مغلقاً): رسالة واحدة تجمعها بعد تنفيذها كلها.
   الإلغاء: يقول الوليد لنيكست تيليجرام «الغِ <رقم>»، وأرقام آخر رسالة في .next-voice/last_batch.json.

الاستخدام:
  python3 next_voice_sync.py                 # فهرس + مزامنة + الطلبات
  python3 next_voice_sync.py --index-only    # فهرس فقط
  python3 next_voice_sync.py --index-only --out <ملف>
  python3 next_voice_sync.py --test-alert    # تجربة تنبيه الأعطال (إشعار الماك + إيميل)
  python3 next_voice_sync.py --opps-board    # تحديث لوحة الفرص الآن (تجربة)
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

VAULT = Path.home() / "Documents" / "My Vault"
BIG_KIND = "سؤال لنيكست الكبير"
STALE_MIN = 60
CLAUDE_TIMEOUT = 15 * 60
STUCK_MIN = 20          # طلب «working» أطول من هذا يُعاد (انقطع التشغيل أثناء تنفيذه)
MAX_ATTEMPTS = 2        # بعدها يُعلَّم failed ويُبلَّغ
SYNC_ALERT_AFTER = 3    # فشل مزامنة متتالٍ قبل تنبيه تيليجرام
ALERT_AFTER = 2         # فشل متتالٍ لأي جزء قبل تنبيه الماك والإيميل
STATE = Path.home() / ".local" / "share" / "next-voice" / "state.json"
APPROVALS_REL = Path("_System") / "Pending Approvals.md"
APPROVALS_EVERY_MIN = 120          # نسخة «ما ينتظر اعتمادك» كل ساعتين
APPROVALS_RETRY_MIN = 30           # بعد فشل
APPROVALS_HOURS = range(8, 23)     # من 8 ص حتى 11 م بتوقيت الرياض
JOBS_SHEET = "15Jihl4OMeHZNz8HqaZy50teiKXFLaVZyqu098bGHDvU"
OPPS_REL = Path("_System") / "Opportunities Board.md"
OPPS_SLOTS = ((7, 30), (19, 50), (22, 30))  # لوحة الفرص: بعد الالتقاط 6:56، قبل التواصل 8:50 م، وبعده
OPPS_RETRY_MIN = 30                # بعد فشل، داخل الموعد نفسه
OPPS_MAX_TRIES = 2                 # محاولتان لكل موعد على الأكثر (حصة Claude)
OPPS_WEEK1 = date(2026, 10, 3)     # بداية الأسبوع 1 من 13
TODAY_REL = Path("_System") / "Today Board.md"
WA_EVERY_MIN = 120                 # لوحة اليوم كل ساعتين نهاراً (APPROVALS_HOURS)
WAKE_GAP_MIN = 60                  # فجوة أطول من هذا بين تشغيلين = الماك كان نائماً ← لوحة فورية
TG_DIR = Path.home() / ".claude" / "channels" / "telegram"
LAST_BATCH = Path(".next-voice") / "last_batch.json"
CHANGES_MARK = "---التغييرات---"
WHATSAPP = Path.home() / "Library" / "Group Containers" / "group.net.whatsapp.WhatsApp.shared"
INDEX_REL = Path(".next-voice") / "index.json"
EXCLUDE_PREFIXES = (
    "Daily/",
    "_System/Archive/",
    "Inbox/_processed/",
    "Inbox/_to_delete/",
    ".obsidian/",
    ".next-voice/",
    ".git/",
    ".trash/",
)


def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    meta = {}
    for line in text[3:end].splitlines():
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta, text[end + 4 :].lstrip("\n")


def parse_list(value):
    value = (value or "").strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [v.strip().strip("\"'") for v in value.split(",") if v.strip().strip("\"'")]


def build_index(vault):
    notes = []
    for path in sorted(vault.rglob("*.md")):
        rel = path.relative_to(vault).as_posix()
        if rel.startswith(EXCLUDE_PREFIXES):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        meta, _ = parse_frontmatter(text)
        notes.append(
            {
                "path": rel,
                "title": path.stem,
                "aliases": parse_list(meta.get("aliases")),
                "type": meta.get("type", ""),
                "text": text,
            }
        )
    return {
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": notes,
    }


def write_index(out):
    out.parent.mkdir(parents=True, exist_ok=True)
    index = build_index(VAULT)
    new = json.dumps(index, ensure_ascii=False)
    # لا تعِد الكتابة إن لم يتغير شيء سوى وقت البناء (حتى لا يتولد commit كل مرة)
    if out.exists():
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
            if old.get("notes") == index["notes"]:
                return len(index["notes"]), False
        except ValueError:
            pass
    out.write_text(new, encoding="utf-8")
    return len(index["notes"]), True


def git(*args):
    return subprocess.run(
        ["git", "-C", str(VAULT), *args], capture_output=True, text=True
    )


def abort_stuck_rebase():
    """تعارض سابق قد يترك rebase معلّقاً فتتوقف كل مزامنة بعده؛ نلغيه."""
    if (VAULT / ".git" / "rebase-merge").exists() or (VAULT / ".git" / "rebase-apply").exists():
        git("rebase", "--abort")
        print("أُلغي rebase معلّق من دورة سابقة.")


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def track_sync(ok, error=""):
    """تنبيه واحد على تيليجرام بعد SYNC_ALERT_AFTER فشلاً متتالياً، ورسالة عند العودة."""
    state = load_state()
    if ok:
        if state.get("alerted"):
            try:
                tg_send("✅ عادت مزامنة نيكست الصوتي مع GitHub للعمل.")
            except Exception:  # noqa: BLE001
                return  # نحاول الإبلاغ في الدورة التالية
        state.update(failures=0, alerted=False)
        save_state(state)
        incident("sync", True, "مزامنة الـ Vault مع GitHub")
        return
    incident("sync", False, "مزامنة الـ Vault مع GitHub", error, after=SYNC_ALERT_AFTER)
    state = load_state()
    state["failures"] = state.get("failures", 0) + 1
    if state["failures"] >= SYNC_ALERT_AFTER and not state.get("alerted"):
        try:
            tg_send(f"⚠️ مزامنة نيكست الصوتي مع GitHub متوقفة منذ {state['failures'] * 2} دقائق تقريباً، "
                    f"فلا يصل نيكست الصوتي جديد الـ Vault ولا تُنفَّذ طلباته.\nالسبب: {error[:300]}")
            state["alerted"] = True
        except Exception:  # noqa: BLE001
            pass
    save_state(state)


TG_DOWN_ALERT_MIN = 10


def telegram_next_running():
    """جلسة نيكست تيليجرام حيّة؟ (خادم القناة يكتب رقمه في bot.pid)"""
    try:
        pid = int((TG_DIR / "bot.pid").read_text().strip())
    except (OSError, ValueError):
        return False
    proc = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    return "server.ts" in proc.stdout


def watch_telegram_next():
    """تنبيه واحد إن توقف نيكست تيليجرام أكثر من TG_DOWN_ALERT_MIN دقائق، ورسالة عند عودته."""
    state = load_state()
    now = datetime.now(timezone.utc)
    if telegram_next_running():
        if state.get("tg_alerted"):
            try:
                tg_send("✅ عاد نيكست تيليجرام للعمل.")
            except Exception:  # noqa: BLE001
                return
        state.update(tg_down_since=None, tg_alerted=False)
        save_state(state)
        incident("telegram", True, "نيكست تيليجرام")
        return
    incident("telegram", False, "نيكست تيليجرام", "جلسة البوت لا تعمل على الماك. شغّل «تشغيل نيكست تيليجرام» من _System ← Telegram Assistant.", after=5)
    state = load_state()
    since = state.get("tg_down_since") or now.isoformat()
    state["tg_down_since"] = since
    down_min = (now - datetime.fromisoformat(since)).total_seconds() / 60
    if down_min >= TG_DOWN_ALERT_MIN and not state.get("tg_alerted"):
        try:
            tg_send("⚠️ نيكست تيليجرام متوقف، فلن يرد على رسائلك هنا.\nافتح على الماك «تشغيل نيكست تيليجرام» (في الـ Vault: _System ← Telegram Assistant).")
            state["tg_alerted"] = True
        except Exception:  # noqa: BLE001
            pass
    save_state(state)


def sync():
    if not (VAULT / ".git").exists() or not git("remote").stdout.strip():
        print("الـ Vault ليس مستودع git له remote بعد — تخطيت المزامنة.")
        return 0
    abort_stuck_rebase()
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode != 0:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        git("commit", "-q", "-m", f"vault sync {stamp}")
    pull = git("pull", "-q", "--rebase", "--autostash")
    if pull.returncode != 0:
        abort_stuck_rebase()
        print("فشل pull:", pull.stderr.strip())
        track_sync(False, pull.stderr.strip())
        return 1
    push = git("push", "-q")
    if push.returncode != 0:
        print("فشل push:", push.stderr.strip())
        track_sync(False, push.stderr.strip())
        return 1
    print("تمت المزامنة.")
    track_sync(True)
    return 0


# ---------- نيكست الكبير ----------

WEEKDAYS = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
RIYADH = timezone(timedelta(hours=3))


def human_day(d, today):
    """«اليوم» / «أمس الجمعة» / «الثلاثاء الماضي» / «الثلاثاء 14 أكتوبر»."""
    name = WEEKDAYS[d.weekday()]
    diff = (today - d).days
    if diff == 0:
        return "اليوم"
    if diff == 1:
        return f"أمس {name}"
    if diff == 2:
        return f"أول أمس {name}"
    if diff == -1:
        return f"بكرة {name}"
    if diff == -2:
        return f"بعد بكرة {name}"
    if 3 <= diff <= 6:
        return f"{name} الماضي"
    if -6 <= diff <= -3:
        return f"{name} الجاي"
    year = f" {d.year}" if d.year != today.year else ""
    return f"{name} {d.day} {MONTHS[d.month - 1]}{year}"


def human_time(dt):
    h12 = dt.hour % 12 or 12
    mins = f":{dt.minute:02d}" if dt.minute else ""
    return f"الساعة {h12}{mins} {'ص' if dt.hour < 12 else 'م'}"


def human_when(created):
    """«2026-10-16 17:00» (توقيت الرياض) ← «أمس الجمعة الساعة 5 م»."""
    try:
        dt = datetime.strptime(created.strip(), "%Y-%m-%d %H:%M")
    except (AttributeError, ValueError):
        return "في وقت غير معروف"
    today = datetime.now(RIYADH).date()
    return f"{human_day(dt.date(), today)} {human_time(dt)}"


def human_now():
    now = datetime.now(RIYADH)
    return f"{human_day(now.date(), now.date())} {WEEKDAYS[now.weekday()]} {now.day} {MONTHS[now.month - 1]} {now.year}، {human_time(now)}"



def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


MAC_NOTIFY = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Basso"\nend run'
ALERT_KEYCHAIN = "next-voice-alert"   # Keychain: الحساب = إيميل Gmail، وكلمة السر = App Password (لا تُكتب في أي ملف)


def email_self(subject, body):
    """إيميل من Gmail الوليد إلى نفسه عبر SMTP. البيانات من Keychain، وكلمة السر تمر لـ curl عبر stdin فلا تظهر في قائمة العمليات."""
    info = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", ALERT_KEYCHAIN],
                          capture_output=True, text=True)
    m = re.search(r'"acct"<blob>="([^"]+)"', info.stdout)
    pw = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", ALERT_KEYCHAIN, "-w"],
                        capture_output=True, text=True).stdout.strip()
    if not m or not pw:
        raise RuntimeError("إيميل التنبيه غير مضبوط في Keychain (" + ALERT_KEYCHAIN + ")")
    addr = m.group(1)
    from email.header import Header
    from email.mime.text import MIMEText
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = str(Header(subject, "utf-8"))
    msg["From"] = msg["To"] = addr
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".eml", delete=False, encoding="utf-8") as f:
        f.write(msg.as_string())
        eml = f.name
    try:
        cfg = 'user = "%s:%s"\n' % (addr, pw)
        proc = subprocess.run(
            ["/usr/bin/curl", "-sS", "--max-time", "60", "--ssl-reqd", "--url", "smtps://smtp.gmail.com:465",
             "--mail-from", addr, "--mail-rcpt", addr, "--upload-file", eml, "-K", "-"],
            input=cfg, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip()[:200])
    finally:
        os.unlink(eml)


def notify(title, body):
    """تنبيه أعطال نيكست: إشعار على الماك + إيميل للوليد من Gmail إلى نفسه. لا يرفع خطأ أبداً."""
    try:
        proc = subprocess.run(["/usr/bin/osascript", "-e", MAC_NOTIFY, title, body[:220]],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            log("تعذّر إشعار الماك:", proc.stderr.strip()[:200])
    except Exception as e:  # noqa: BLE001
        log("تعذّر إشعار الماك:", e)
    try:
        email_self(title, body)
    except Exception as e:  # noqa: BLE001
        log("تعذّر الإيميل:", e)


def fix_hint(error):
    e = error.lower()
    if "authenticate" in e or "oauth" in e or "login" in e:
        return "الحل: افتح Terminal واكتب ~/.local/bin/claude ثم /login ثم /exit."
    if "limit" in e or "quota" in e or "rate" in e:
        return "يبدو أنك بلغت حد استخدام Claude؛ يعود وحده بعد انتهاء المدة."
    return ""


def incident(key, ok, label, error="", after=ALERT_AFTER, quiet_if=None):
    """تنبيه واحد بعد `after` فشلاً متتالياً لجزء من نيكست، وتنبيه عند عودته. quiet_if: مفتاح عطل آخر إن كان مُبلَّغاً لا يُكرَّر التنبيه."""
    state = load_state()
    inc = state.setdefault("incidents", {})
    cur = inc.get(key) or {"n": 0, "alerted": False}
    if ok:
        if cur.get("alerted") is True:  # «muted» = لم يُرسل عنه تنبيه، فلا رسالة عودة
            notify(f"✅ نيكست: عاد {label} للعمل", f"{label} يعمل من جديد.")
        inc[key] = {"n": 0, "alerted": False}
    else:
        cur["n"] = cur.get("n", 0) + 1
        muted = bool(quiet_if) and inc.get(quiet_if, {}).get("alerted") is True
        if cur["n"] >= after and not cur.get("alerted"):
            if muted:
                cur["alerted"] = "muted"
            else:
                notify(f"⚠️ نيكست: {label} متوقف",
                       f"{label} فشل {cur['n']} مرات متتالية.\nالسبب: {error[:300]}\n{fix_hint(error)}".strip())
                cur["alerted"] = True
        inc[key] = cur
    state["incidents"] = inc
    save_state(state)


def tg_send(text):
    """يرسل إلى محادثة الوليد عبر بوت نيكست تيليجرام. الرمز يُقرأ من مكانه ولا يُطبع."""
    token = None
    for line in (TG_DIR / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            token = line.split("=", 1)[1].strip().strip("\"'")
    chat_id = json.loads((TG_DIR / "access.json").read_text(encoding="utf-8"))["allowFrom"][0]
    if not token:
        raise RuntimeError("رمز البوت غير موجود")
    chunks = [text[i : i + 3500] for i in range(0, len(text), 3500)] or [""]
    for chunk in chunks:
        # curl النظام يستخدم شهادات macOS (Python من python.org قد لا يجدها). الرابط عبر stdin حتى لا يظهر الرمز في قائمة العمليات.
        config = f'url = "https://api.telegram.org/bot{token}/sendMessage"\n'
        proc = subprocess.run(
            ["/usr/bin/curl", "-sS", "--fail", "--max-time", "30", "-K", "-",
             "-H", "Content-Type: application/json",
             "--data-binary", json.dumps({"chat_id": chat_id, "text": chunk})],
            input=config, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"تيليجرام: {proc.stderr.strip()[:200]}")


def set_fields(path, **fields):
    text = path.read_text(encoding="utf-8")
    end = text.find("\n---", 3)
    head, body = text[: end], text[end:]
    for k, v in fields.items():
        if re.search(rf"^{k}:.*$", head, re.M):
            head = re.sub(rf"^{k}:.*$", f"{k}: {v}", head, flags=re.M)
        else:
            head += f"\n{k}: {v}"
    path.write_text(head + body, encoding="utf-8")


def big_requests(status):
    out = []
    for path in sorted((VAULT / "Inbox").glob("*.md")):
        meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        if meta.get("kind") == BIG_KIND and meta.get("status") == status:
            out.append((path, meta, body))
    return out


def age_minutes(meta):
    try:
        created = datetime.fromisoformat(meta["created_utc"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return 0
    return (datetime.now(timezone.utc) - created).total_seconds() / 60


def claude_print(prompt):
    """تشغيل Claude على الماك دون واجهة (الوضع التلقائي للصلاحيات) وإرجاع نص الرد."""
    env = dict(os.environ, PATH=f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin")
    proc = subprocess.run(
        ["claude", "-p", prompt, "--permission-mode", "auto", "--output-format", "json",
         "--add-dir", str(WHATSAPP)],
        cwd=VAULT, env=env, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT,
    )
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError((proc.stderr or proc.stdout or "لا مخرجات")[-400:])
    if data.get("is_error") or not data.get("result"):
        raise RuntimeError(str(data.get("result") or data.get("subtype") or "خطأ غير معروف")[:400])
    return data["result"].strip()


QUESTION_ONLY = """- **هذا الطلب «سؤال»: لم يؤكده الوليد كفعل في المكالمة، فهو قراءة وإجابة فقط.** لا تغيّر أي شيء: لا ملف في الـ Vault، ولا Open Loops، ولا To Do، ولا شيت، ولا رسالة، ولا إيميل. إن كان فيه ما يحتاج تغييراً (إغلاق، إضافة، اعتماد، تعديل، إرسال) فلا تنفّذه، واذكره في آخر ردك تحت «يحتاج تأكيدك:» بجملة واضحة. ما يلي عن المسموح دون تأكيد ينطبق على طلبات «فعل» فقط، لا على هذا الطلب."""


def run_claude(rel, body, requested_at, kind="سؤال"):
    prompt = f"""أنت نيكست الكبير. وصلك طلب صوتي من الوليد عبر نيكست الصوتي، محفوظ في `{rel}` (نوعه: {kind}):

{body.strip()}

- **وقت الطلب: {requested_at} بتوقيت الرياض ({human_when(requested_at)})، والآن: {human_now()}.** قد يكون التنفيذ متأخراً لأن الماك كان مغلقاً: احسب أي تاريخ نسبي (اليوم، بكرة، الأسبوع الجاي) من وقت الطلب لا من الآن، واقرأ البيانات بحالتها الآن.
- اقرأ CLAUDE.md و`_System/soul.md` و`_System/user.md`. لمصادر واتساب والشيتات اتبع قسم «المصادر» في `_System/Telegram Assistant/CLAUDE.md`.
{QUESTION_ONLY if kind != "فعل" else ""}
- نفّذ طلب «فعل» مباشرة دون سؤال؛ الوليد أكّده بصوته في المكالمة (قاعدة «تأكيد الفهم» في soul.md لا تنطبق هنا). مسموح دون تأكيد في طلب «فعل»: القراءة والتحليل، وإضافة مهام Microsoft To Do عبر Zapier، وإضافة بنود في `_System/Open Loops.md`، وتعديل ملفات الـ Vault بقواعدها.
- مهام Microsoft To Do تُضاف إلى القائمة الافتراضية «Tasks» دائماً، إلا إن ذكر الوليد في طلبه قائمة بالاسم. اذكر اسم القائمة في ردك.
- استثناء أول في الشيتات (أفكار المحتوى)، في شيت My Social Media Calendar (1L--CVxVw1GzTHjMQypOhK80-v0NrKYwoVJOw2xhKses)، تبويب «نظام إدارة البراندينج»:
  - طلب «فعل» لاعتماد فكرة محتوى بالصوت: غيّر «حالة النشر» (H) لذلك الصف من `فكرة جديدة - بانتظار الموافقة` إلى `معتمدة` فقط (تحقق أن الصف بهذه الحالة فعلاً).
  - طلب «فعل» عنوانه يبدأ بـ «أفكار المحتوى» (النقطتان تُحذفان من اسم الملف) (من تبويب «البراند»، أكّده الوليد بالضغط): نفّذ نص الطلب كما هو. لكل سطر قرار فيه اقرأ الصف المذكور، ولا تكتب فيه إلا إن تحقق الشرطان معاً: H = `فكرة جديدة - بانتظار الموافقة` حرفياً، ونص B يبدأ بالنص المكتوب بعد «أولها:» حرفياً. اعتمد ← H = `معتمدة`. ارفض ← H = `مرفوضة`. عدّل ← أعد كتابة B حسب الملاحظة واترك H كما هي، وأضف في آخر M «عُدّلت الفكرة <التاريخ> بطلب الوليد: <الملاحظة>» دون مسح الموجود. إن اختل أحد الشرطين فلا تكتب في ذلك الصف ولا تبحث عن الفكرة في صف آخر. ردك: سطر لكل صف (تم، أو لم يتم ولماذا).
  - ممنوع في الحالتين: أي عمود غير B وH وM، أي صف غير المذكور، أي حالة غير `معتمدة` و`مرفوضة`، و`معتمد للنشر` أبداً. لا تعتمد مسودة أو تصميماً أو إيميلاً؛ هذه تُعتمد في جلساتها.
- استثناء ثانٍ في الشيتات: طلب «فعل» عنوانه «تسجيل تقديم OPP-…» (من زر «قدّمت» في لوحة الفرص، أكّده الوليد بضغطتين): في شيت البحث عن فرص جديدة {JOBS_SHEET}، تبويب «الفرص»، ابحث عن المعرّف في العمود A، واكتب في خلية العمود U («تقديم مباشر») لذلك الصف فقط النص المذكور في الطلب («قدّمت بنفسي <التاريخ>») دون سؤال. خلية واحدة فقط: لا تغيّر أي عمود آخر، ولا K ولا S. إن لم تجد المعرّف، أو وجدته أكثر من مرة، أو كانت U غير فارغة، فلا تكتب شيئاً واذكر ذلك في ردك. اللوحة تتحدث في أقرب موعد لها.
- استثناء ثالث في الشيتات: طلب «فعل» عنوانه يبدأ بـ «رابط لا يعمل OPP-…» (من زر «الرابط لا يعمل» في لوحة الفرص، أكّده الوليد بضغطتين): في شيت البحث عن فرص جديدة {JOBS_SHEET}، تبويب «الفرص»، صف المعرّف المذكور فقط (ابحث عنه في العمود A). ابحث عن صفحة الوظيفة نفسها (المسمى + الشركة + الرياض) وافتحها للتأكد أنها تعمل وفيها زر التقديم. إن وجدت رابطاً يعمل: اكتبه في E، وأضف في آخر T «صُحّح الرابط <التاريخ>: <من أين>» دون مسح ما فيه. إن لم تجد، أو الإعلان مغلق: اكتب في M «متخطّى»، وأضف في آخر T «رابط لا يعمل <التاريخ>: <السبب>» دون مسح ما فيه. ثلاث خلايا على الأكثر (E أو M، وT) في ذلك الصف وحده: لا K ولا S ولا U ولا أي صف آخر، ولا تخمّن رابطاً. إن لم تجد المعرّف، أو وجدته أكثر من مرة، فلا تكتب شيئاً واذكر ذلك في ردك.
- **إيميلات التواصل** (مسودات في `_System/Outreach Drafts/`، والشكل والحالات في `_شكل الملف.md` هناك):
  - «اعتمد إيميل …»: حدّد الملف بالاسم أو الشركة (إن لم يتضح أو وُجد أكثر من ملف فلا تعتمد، واذكر ذلك في ردك). تحقق أن حالته `بانتظار الموافقة`، ثم اكتب `status: معتمد بالصوت` و`approved_at: <التاريخ والوقت>`. لا ترسل شيئاً ولا تغيّر الشيت؛ مهمة التواصل ترسله في تشغيلها التالي.
  - «عدّل إيميل …: <التعديل>»: عدّل النص في الملف نفسه بقواعد الكتابة في `Projects/نظام البحث عن فرص جديدة.md` (أسلوبه، ≤ 150 كلمة، بلا شرطة طويلة، التوقيع كما هو)، وأضف سطراً مؤرخاً في «## التعديلات». الحالة تبقى `بانتظار الموافقة`. ضع النص الجديد كاملاً في ردك ليُقرأ عليه.
  - «ألغِ إيميل …»: `status: مُلغى`.
- ممنوع دون تأكيد: إرسال أي رسالة أو إيميل، وتعديل أي شيت (عدا الاستثناءات الثلاثة أعلاه في طلب «فعل»)، وأي تغيير خارجي آخر. اذكره في آخر ردك تحت «يحتاج تأكيدك:» ولا تنفّذه.
- لا تعدّل ملف الطلب نفسه؛ السكربت يكتب فيه ردك.
- ردك النهائي جزءان:
  1. الرد كما سيصل إليه، ويقول ما فعلتَه بجملة بشرية («✅ أضفتُ مهمة «…» إلى قائمة Tasks»): ممنوع فيه المعرّفات والإيميلات والحسابات وأسماء الملفات والمسارات. **بالعربية الفصحى دائماً** (المصطلحات التقنية فقط بالإنجليزية)، مختصرة، نقاط، أقل من 2500 حرف، بلا عناوين Markdown ولا جداول، وبلا تمهيد مثل «رسالة تيليجرام:»، وكل تاريخ أو وقت فيها بصيغة بشرية كما في soul.md («أمس الجمعة الساعة 5 م»، «بكرة الأحد»)، لا 2026-10-17 ولا 15:10.
  2. سطر فيه `{CHANGES_MARK}` وحده، ثم كل تغيير أجريته سطراً بتفاصيل تكفي لإلغائه لاحقاً (هنا فقط تُكتب المعرّفات والحسابات؛ هذا الجزء لا يراه الوليد) (الملف والنص المضاف، أو قائمة To Do وعنوان المهمة). إن لم تغيّر شيئاً فاكتب: لا شيء."""
    text = claude_print(prompt)
    answer, _, changes = text.partition(CHANGES_MARK)
    return answer.strip(), (changes.strip() or "لا شيء")


def publish(message):
    write_index(VAULT / INDEX_REL)
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode != 0:
        git("commit", "-q", "-m", message)
    if git("pull", "-q", "--rebase", "--autostash").returncode != 0:
        abort_stuck_rebase()  # sync() في الدورة التالية يعيد المحاولة ويبلّغ إن تكرر الفشل
        return
    git("push", "-q")


def no_changes(changes):
    return changes.strip().rstrip(".") in ("لا شيء", "")


def needs_confirmation(answer):
    """هل في الرد بند «يحتاج تأكيدك:» غير فارغ؟"""
    _, found, rest = answer.partition("يحتاج تأكيدك:")
    return bool(found) and not rest.strip().startswith(("لا شيء", "لا يوجد"))


def is_action(item):
    """تيليجرام فقط لما فيه فعل: تغيير نُفّذ، أو تغيير ينتظر تأكيده، أو فشل. الأسئلة تُسمع في المكالمة التالية."""
    if "error" in item:
        return True
    return not no_changes(item.get("changes", "")) or needs_confirmation(item.get("answer", ""))


def save_batch(items):
    """أرقام آخر رسالة ← ملفاتها، ليفهم نيكست تيليجرام «الغِ <رقم>»."""
    out = VAULT / LAST_BATCH
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "sent": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "items": [{"n": i + 1, "file": it["rel"], "title": it["title"]} for i, it in enumerate(items)],
    }, ensure_ascii=False, indent=1), encoding="utf-8")


def execute(path, meta, body):
    rel = path.relative_to(VAULT).as_posix()
    title = (re.search(r"^# (.+)$", body, re.M) or [None, path.stem])[1]
    item = {"rel": rel, "title": title, "requested": meta.get("created", "؟"), "age": age_minutes(meta)}
    attempts = int(meta.get("attempts") or 0) + 1
    set_fields(path, status="working", working_since=datetime.now(timezone.utc).isoformat(timespec="seconds"), attempts=attempts)
    publish("voice: working on request")
    log("ينفّذ:", path.name)
    wall0, mono0 = time.time(), time.monotonic()
    try:
        item["answer"], item["changes"] = run_claude(rel, body, item["requested"], meta.get("type") or "سؤال")
    except subprocess.TimeoutExpired as e:
        # الوقت الفعلي (الساعة) يجري والماك نائم، والمهلة تُحسب به؛ أما monotonic فيتوقف أثناء النوم.
        # فرق كبير بينهما = نام الماك أثناء التنفيذ (غطاء مغلق)، فالطلب يُعاد لا يُعلَن فشله.
        slept = (time.time() - wall0) - (time.monotonic() - mono0) > 120
        if slept and attempts < MAX_ATTEMPTS:
            set_fields(path, status="pending")
            log("نام الماك أثناء التنفيذ — يُعاد الطلب:", path.name)
            publish("voice: retry after sleep")
            return item
        set_fields(path, status="failed", notified="no")
        with path.open("a", encoding="utf-8") as f:
            f.write(f"\n## فشل التنفيذ\nتجاوز {CLAUDE_TIMEOUT // 60} دقيقة دون رد.\n")
        item["error"] = f"تجاوز {CLAUDE_TIMEOUT // 60} دقيقة دون رد"
        log("فشل (مهلة):", path.name)
    except Exception as e:  # noqa: BLE001 — أي فشل يُبلَّغ للوليد ولا يوقف المزامنة
        set_fields(path, status="failed", notified="no")
        with path.open("a", encoding="utf-8") as f:
            f.write(f"\n## فشل التنفيذ\n{e}\n")
        item["error"] = str(e)[:300]
        log("فشل:", e)
    else:
        # العلامة تُكتب مع الرد نفسه: إن انقطع التشغيل قبل الإرسال (نوم الماك مثلاً) يُعاد في الدورة التالية
        flag = {"notified": "no"} if is_action(item) else {"heard": "no"}
        set_fields(path, status="answered", answered=datetime.now().strftime("%Y-%m-%d %H:%M"), **flag)
        with path.open("a", encoding="utf-8") as f:
            f.write(f"\n## ردّ نيكست الكبير\n{item['answer']}\n\n## ما غيّرته\n{item['changes']}\n")
    publish("voice: request done")
    return item


def delay_text(minutes):
    h = int(minutes // 60)
    if h >= 48:
        d = h // 24
        return "بعد يومين" if d == 2 else f"بعد {d} أيام" if d <= 10 else f"بعد {d} يوماً"
    if h >= 24:
        return "بعد يوم"
    if h >= 3:
        return f"بعد {h} ساعات" if h <= 10 else f"بعد {h} ساعة"
    if h >= 1:
        return "بعد ساعة" if h == 1 else "بعد ساعتين"
    return "فوراً"


def render(item, n=None):
    head = f"{n}) " if n else ""
    if "error" in item:
        return f"{head}⚠️ {item['title']} — لم يُنفَّذ: {item['error']}"
    # تفاصيل «ما غيّرته» (معرّفات، حسابات) تبقى في ملف الطلب للإلغاء فقط، ولا تُعرض على الوليد
    return f"{head}🎙️ {item['title']} (طلبتَه {human_when(item['requested'])}، نُفّذ {delay_text(item['age'])})\n{item['answer'][:1800 if n else 2500]}"


def item_from_file(path, meta, body):
    """يعيد بناء بند الإشعار من ملف الطلب (للإرسال بعد انقطاع)."""
    def section(name):
        _, found, rest = body.partition(f"## {name}\n")
        return rest.split("\n## ", 1)[0].strip() if found else ""
    item = {
        "rel": path.relative_to(VAULT).as_posix(),
        "title": (re.search(r"^# (.+)$", body, re.M) or [None, path.stem])[1],
        "requested": meta.get("created", "؟"),
        "age": age_minutes(meta),
    }
    if meta.get("status") == "failed":
        item["error"] = section("فشل التنفيذ")[:300] or "خطأ غير معروف"
    else:
        item["answer"], item["changes"] = section("ردّ نيكست الكبير"), section("ما غيّرته") or "لا شيء"
    return item


def notify_pending():
    """يرسل كل فعل لم يُبلَّغ عنه بعد (notified: no) في رسالة واحدة، ويعلّمه بعد نجاح الإرسال فقط."""
    todo = []
    for path in sorted((VAULT / "Inbox").glob("*.md")):
        meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        if meta.get("kind") == BIG_KIND and meta.get("notified") == "no":
            todo.append((path, item_from_file(path, meta, body)))
    if not todo:
        return
    items = [it for _, it in todo]
    save_batch(items)
    if len(items) == 1 and items[0]["age"] <= STALE_MIN:
        it = items[0]
        undo = "" if "error" in it or no_changes(it.get("changes", "")) else "\n\nللإلغاء: «الغِها»."
        text = render(it) + undo
    else:
        late = any(it["age"] > STALE_MIN for it in items)
        head = "🎙️ فتحتَ الماك، فنفّذتُ ما طلبته صوتياً" if late else "🎙️ نفّذتُ ما طلبته صوتياً"
        text = "\n\n".join([f"{head} ({len(items)}):", *[render(it, i + 1) for i, it in enumerate(items)],
                              "لإلغاء أيٍّ منها قل: «الغِ <رقمه>»."])
    tg_send(text)  # إن فشل يبقى notified: no ويُعاد في الدورة التالية
    for path, _ in todo:
        set_fields(path, notified="yes")
    publish("voice: notified")
    log("أُبلغ على تيليجرام:", len(items))


def snapshot_approvals(force=False, manual=False):
    """كل ساعتين نهاراً: نيكست الكبير يقرأ الشيتين ويكتب ما ينتظر اعتماد الوليد في _System/Pending Approvals.md.
    manual=True (زر ↻ في تبويب «البراند»): لا يمس approvals_attempt ولا approvals_failed، فلا يغيّر المواعيد المجدولة.
    يعيد True عند النجاح، ونص الخطأ عند الفشل، وNone إن لم يحن الموعد."""
    now = datetime.now(RIYADH)
    state = load_state()
    if now.hour not in APPROVALS_HOURS and not (force or manual):
        return None
    last = state.get("approvals_attempt")
    wait = APPROVALS_RETRY_MIN if state.get("approvals_failed") else APPROVALS_EVERY_MIN
    if last and not (force or manual) and (now - datetime.fromisoformat(last)).total_seconds() < wait * 60:
        return None
    if not manual:
        state["approvals_attempt"] = now.isoformat()
        save_state(state)
    week_sat = now.date() - timedelta(days=(now.weekday() + 2) % 7)  # السبت الذي يبدأ به الأسبوع (الرياض)
    week_fri = week_sat + timedelta(days=6)
    prompt = f"""اقرأ شيتين بأداة Google Sheets (قراءة فقط، لا تكتب في أي شيت ولا ملف):
1. شيت المحتوى «My Social Media Calendar»، تبويب «نظام إدارة البراندينج» (ابحث عنه في Drive بالاسم إن لزم). من عمود «حالة النشر» خذ الصفوف بهذه الحالات حرفياً: `فكرة جديدة - بانتظار الموافقة`، `مسودة جاهزة - بانتظار المراجعة`، `التصميم جاهز - بانتظار المراجعة`، وصفوف `النص معتمد` التي منصتها «انستجرام» (كاروسيلات يصمّمها الوليد بنفسه في Claude Design).
2. شيت البحث عن فرص جديدة {JOBS_SHEET}: تبويب «جهات الاتصال» (عمود L حالة التواصل = `بانتظار الموافقة`) وتبويب «الفرص» (عمود M الحالة = `بانتظار الموافقة`). لا تكرر الشخص نفسه.

أخرج Markdown فقط، بلا مقدمة ولا خاتمة، بهذا الشكل حرفياً (القسم الفارغ يكتب تحته «- لا شيء»):
## أفكار محتوى جديدة (<العدد>) — تُعتمد بالصوت
- صف <رقم الصف في الشيت>: <الفكرة بجملة قصيرة> — <السلسلة> · <المنصة> | <نص الفكرة في العمود B كاملاً كما هو حرفياً>
## مسودات تنتظر مراجعتك (<العدد>) — تُعتمد في جلسة «مرحلة الكتابة»
- <الفكرة بجملة قصيرة> — <المنصة>
## تصاميم تنتظر مراجعتك (<العدد>) — تُعتمد من الشيت بعد رؤيتها
- <الفكرة بجملة قصيرة> — <المنصة>
## كاروسيلات تنتظر تصميمك (<العدد>) — تصمّمها في Claude Design من برومبت المحتوى
- <الفكرة بجملة قصيرة> — <السلسلة>
## إيميلات تواصل تنتظر موافقتك (<العدد>) — تُعتمد في جلسة «مهمة التواصل»
- <الاسم> — <المنصب> — <الشركة> — <أولى أو متابعة> — <«نصه جاهز للمراجعة بالصوت» إن وُجد له ملف في `_System/Outreach Drafts/` بحالة `بانتظار الموافقة`، وإلا «نصه في جلسة مهمة التواصل فقط»>

في سطر الفكرة: الجزء بعد « | » **منسوخ حرفاً بحرف** من خلية العمود B (نص الفكرة) لذلك الصف: النص كاملاً من أوله إلى آخره، بلا اختصار ولا إعادة صياغة ولا تصحيح ولا ترجمة ولا حذف للعلامات أو الإيموجي. الاستبدالان الوحيدان: أي « | » أو «|» داخل النص المنسوخ يصير « - »، وأي سطر جديد يصير مسافة، فيبقى سطر الفكرة سطراً واحداً. لا تضع « | » في أي مكان آخر من السطر.

بالعربية، بلا روابط ولا إيميلات ولا معرّفات غير رقم الصف (عدا ما يرد حرفياً في الجزء المنسوخ بعد « | »).

ثم بعد آخر قسم أعلاه اكتب سطراً وحده نصه حرفياً:
===BRAND BOARD===
وتحته «لوحة البراند» من تبويب «نظام إدارة البراندينج» نفسه (اقرأ لها أيضاً صفوف الحالات المذكورة في تعريف كل قسم، وعمود «التصميم» F و«تاريخ النشر المخطط» G و«ملاحظات ونتائج» M)، بهذه الأقسام الخمسة بهذا الترتيب والشكل حرفياً (القسم الفارغ يكتب تحته «- لا شيء»، والحقل الفارغ «-»، والفاصل بين الحقول « | »):
## راجع المسودات
- صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <ملاحظة قصيرة> | <رابط الجلسة> | <رابط التصميم أو المعاينة>
## راجع التصاميم
- صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <ملاحظة قصيرة> | <رابط الجلسة> | <رابط التصميم أو المعاينة>
## ينتظر منك
- صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <ملاحظة قصيرة> | <رابط الجلسة> | <رابط التصميم أو المعاينة>
## مجدول
- صف <ن> | <المنصة> | <الفكرة بجملة قصيرة> | <الموعد بصيغة بشرية>
## نُشر هذا الأسبوع
- لينكدان: <ن> من 3
- انستجرام: <ن> من 2

تعريف الأقسام (مطابق لتقرير المساء):
- راجع المسودات: صفوف `مسودة جاهزة - بانتظار المراجعة`، ومنها كاروسيلات في ملاحظاتها «كاروسيل اتصمم — بانتظار موافقتك».
- راجع التصاميم: صفوف `النص معتمد` منصتها «لينكدان» وفي ملاحظاتها «تصميم اتعمل — بانتظار موافقتك»، وصفوف `التصميم جاهز - بانتظار المراجعة`.
- ينتظر منك: صفوف `النص معتمد` منصتها «انستجرام» وفي ملاحظاتها «بانتظار رابط Drive منك»، وصفوف `معتمد للنشر` التي ليس في ملاحظاتها «Buffer Update ID».
- مجدول: صفوف `معتمد للنشر` تاريخ نشرها المخطط (G) بعد الآن ({now.strftime('%Y-%m-%d %H:%M')} بتوقيت الرياض). الموعد بصيغة بشرية («بكرة الأحد الساعة 11 ص»).
- نُشر هذا الأسبوع: لكل منصة، عدد الصفوف التي تاريخها في G من السبت {week_sat.isoformat()} إلى الجمعة {week_fri.isoformat()} (بتوقيت الرياض) وهي إما `تم النشر`، أو `معتمد للنشر` في ملاحظاتها «Buffer Update ID» وموعدها في G قبل الآن (نشرها Buffer ولم تتحدث حالتها). لا تعدّ الصف مرتين.
- رابط الجلسة: الرابط بعد «رابط جلسة الاعتماد:» في الملاحظات منسوخاً حرفياً. رابط التصميم أو المعاينة: أول رابط https في عمود «التصميم» (F)، وإلا في الملاحظات، منسوخاً حرفياً حتى أول مسافة. إن لم يوجد رابط فاكتب «-». لا تركّب رابطاً ولا تخمّنه. الروابط مسموحة في هذا الجزء فقط.
- لا « | » ولا سطر جديد داخل أي حقل (استبدل أي « | » بـ « - »). الملاحظة القصيرة بالعربية في بضع كلمات، أو «-»."""
    try:
        raw = claude_print(prompt)
        body, brand = split_brand_board(raw)
        if "## أفكار محتوى جديدة" not in body:
            raise RuntimeError("شكل غير متوقع: " + body[:200])
        bad = [l for l in approvals_ideas(body) if not l.partition(" | ")[2].strip()]
        if bad:
            raise RuntimeError("سطر فكرة بلا « | <أول النص>»: " + bad[0][:150])
    except Exception as e:  # noqa: BLE001 — يُعاد بعد APPROVALS_RETRY_MIN
        if not manual:
            state = load_state(); state["approvals_failed"] = True; save_state(state)
            incident("approvals", False, "تحديث «ما ينتظر اعتمادي»", str(e), quiet_if="board")
        log("فشل تحديث «ما ينتظر اعتمادك»:", e)
        return str(e)[:300] or "خطأ غير معروف"
    head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
            f"# ما ينتظر اعتمادي\n\nملف تلقائي يكتبه سكربت نيكست الصوتي كل ساعتين نهاراً من شيت المحتوى وشيت البحث عن فرص جديدة. لا تعدّله يدوياً.\n"
            f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}.\n\n")
    (VAULT / APPROVALS_REL).write_text(head + body.strip() + "\n", encoding="utf-8")
    state = load_state(); state["approvals_success"] = now.isoformat()
    if not manual:
        state["approvals_failed"] = False
    save_state(state)
    incident("approvals", True, "تحديث «ما ينتظر اعتمادي»")
    try:  # معزول: فشل لوحة البراند لا يُفشل «ما ينتظر اعتمادي» ولا يفتح بلاغ «approvals»
        write_brand_board(brand, now)
    except Exception as e:  # noqa: BLE001
        log("لم تُكتب لوحة البراند:", e)
    publish("voice: pending approvals snapshot")
    log("حُدّث «ما ينتظر اعتمادك».")
    return True


BRAND_REL = Path("_System") / "Brand Board.md"
BRAND_SEP = re.compile(r"^\s*===\s*BRAND BOARD\s*===\s*$", re.M)
BRAND_SECTIONS = ("## راجع المسودات", "## راجع التصاميم", "## ينتظر منك", "## مجدول", "## نُشر هذا الأسبوع")


def split_brand_board(raw):
    """يقسم ناتج snapshot_approvals: (ما ينتظر اعتمادي، لوحة البراند أو None). لا يتسرب شيء من اللوحة إلى الجزء الأول:
    إن غاب الفاصل يُقطع الجزء الأول عند أول عنوان من عناوين اللوحة."""
    m = BRAND_SEP.search(raw)
    if m:
        first, brand = raw[:m.start()], raw[m.end():]
    else:
        first, brand = raw, None
    lines = first.split("\n")
    cut = next((i for i, l in enumerate(lines) if l.strip() in BRAND_SECTIONS), len(lines))
    return "\n".join(lines[:cut]).strip(), brand


def write_brand_board(brand, now):
    if brand is None:
        raise RuntimeError("لا يوجد فاصل ===BRAND BOARD=== في الناتج")
    heads = [l.strip() for l in brand.splitlines() if l.startswith("## ")]
    missing = [h for h in BRAND_SECTIONS if h not in heads]
    if missing:
        raise RuntimeError("عناوين ناقصة: " + "، ".join(missing))
    head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
            f"# لوحة البراند\n\nملف تلقائي من شيت المحتوى، يكتبه سكربت نيكست الصوتي مع «ما ينتظر اعتمادي» ويعرضه تبويب «البراند». لا تعدّله يدوياً.\n"
            f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}.\n\n")
    (VAULT / BRAND_REL).write_text(head + brand.strip() + "\n", encoding="utf-8")
    log("حُدّثت لوحة البراند.")


def approvals_ideas(body):
    """أسطر «- صف …» في قسم «## أفكار محتوى جديدة» فقط."""
    out, inside = [], False
    for l in body.splitlines():
        if l.startswith("## "):
            inside = l.startswith("## أفكار محتوى جديدة")
        elif inside and l.startswith("- صف "):
            out.append(l)
    return out


def opps_slot(now):
    """آخر موعد للوحة الفرص حلّ قبل `now` (اليوم أو أمس)، كمفتاح نصي."""
    for day in (now.date(), now.date() - timedelta(days=1)):
        for h, m in reversed(OPPS_SLOTS):
            t = datetime(day.year, day.month, day.day, h, m, tzinfo=RIYADH)
            if t <= now:
                return t.strftime("%Y-%m-%d %H:%M")
    return None


OPPS_LINE = re.compile(r"^-\s*(OPP-\d+)\s*\|(.+)\|\s*(\d+(?:\.\d+)?)\s*\|\s*(https?://\S+)\s*$")


def normalize_opps_line(line):
    """سطر إعلان بالشكل «- OPP-123 | الشركة | المسمى | الدرجة | رابط»، أو None.
    يكفي أن يبدأ بمعرّف OPP وينتهي برابط قبله رقم؛ إن احتوى الاسم أو المسمى على | فما بينها يُدمج:
    الجزء الأخير هو المسمى، وما قبله يُدمج في الشركة بـ « - »."""
    m = OPPS_LINE.match(line.strip())
    if not m:
        return None
    oid, middle, score, url = m.groups()
    parts = [x.strip() for x in middle.split("|") if x.strip()]
    if len(parts) < 2:
        return None
    return f"- {oid} | {' - '.join(parts[:-1])} | {parts[-1]} | {score} | {url}"


def clean_opps_body(body):
    """يتحقق من الأقسام الإلزامية، ويُسقط أي سطر في «قدّم على الإعلانات» لا يطابق الشكل الحرفي الذي يقرؤه التطبيق."""
    body = body.strip()
    if "## عليك الآن" not in body or "## قدّم على الإعلانات" not in body:
        raise RuntimeError("شكل غير متوقع: " + body[:200])
    body = body[body.index("## عليك الآن"):]
    out, in_apply, kept, dropped = [], False, 0, []
    for line in body.splitlines():
        if line.startswith("## "):
            if in_apply and kept == 0:
                out.append("- لا شيء")
            in_apply, kept = line[3:].strip().startswith("قدّم"), 0
            out.append(line)
            continue
        if in_apply and line.startswith("- "):
            fixed = normalize_opps_line(line)
            if fixed:
                out.append(fixed); kept += 1
            elif line.strip() != "- لا شيء":
                dropped.append(line.strip()[:200])
            continue
        out.append(line)
    if in_apply and kept == 0:
        out.append("- لا شيء")
    if dropped:
        log(f"لوحة الفرص: أُسقط {len(dropped)} سطر إعلان بشكل غير صالح:", *dropped)
    return "\n".join(out).strip()


def opps_board(force=False):
    """لوحة الفرص (_System/Opportunities Board.md) ثلاث مرات يومياً من شيت البحث عن فرص جديدة. قراءة فقط من الشيت.
    تُشغَّل عند أول دورة بعد كل موعد في OPPS_SLOTS إن لم تُشغَّل له، أو يدوياً (force: --opps-board أو زر «حدّث اللوحة»).
    التشغيل اليدوي لا يمس مفاتيح المواعيد (opps_last_slot، opps_tries، opps_attempt)، فلا يُلغي تحديثاً مجدولاً.
    تعيد True عند النجاح، ونص السبب عند الفشل، وNone إن لم يحن موعد. فشلها لا يمس غيرها."""
    try:
        now = datetime.now(RIYADH)
        state = load_state()
        slot = opps_slot(now)
        if not force:
            if not slot or state.get("opps_last_slot") == slot:
                return None
            tries = state.get("opps_tries", {})
            if tries.get("slot") == slot:
                if tries.get("n", 0) >= OPPS_MAX_TRIES:
                    return None
                last = state.get("opps_attempt")
                if last and (now - datetime.fromisoformat(last)).total_seconds() < OPPS_RETRY_MIN * 60:
                    return None
            else:
                tries = {"slot": slot, "n": 0}
            tries["n"] = tries.get("n", 0) + 1
            state["opps_tries"] = tries
            state["opps_attempt"] = now.isoformat()
            save_state(state)

        today = now.date()
        week = min(max((today - OPPS_WEEK1).days // 7 + 1, 1), 13)
        since = (today - timedelta(days=30)).isoformat()
        prompt = f"""اقرأ شيت البحث عن فرص جديدة {JOBS_SHEET} بأداة Google Sheets. **قراءة فقط: لا تكتب في أي شيت ولا ملف.**
اليوم {today.isoformat()} بتوقيت الرياض. «آخر 30 يوماً» = من {since} حتى اليوم.

احسب ما يلي من البيانات كما هي، ولا تخمّن شيئاً لا يظهر في الشيت (حالة المهام المجدولة نفسها لا تُعرف من الشيت؛ لا تكتب عنها):

1. **عليك الآن:**
   - سطر واحد: عدد «بانتظار الموافقة» في تبويب «جهات الاتصال» (عمود L) وفي تبويب «الفرص» (عمود M)، مثل: «- 15 رسالة تنتظر اعتمادك (14 جهة اتصال، 1 فرصة)». إن كان صفراً فلا تكتب السطر.
   - سطر واحد: عدد الإعلانات المفتوحة التي لم تُسجَّل عليها تقديماً (عدد صفوف القسم 2 قبل قصّها إلى 10). إن كان صفراً فلا تكتب السطر.
   - سطر لكل جهة في «جهات الاتصال» حالتها (L) «ردّ» تنتظر جواباً: «- ردّ <الاسم> من <الشركة> — يحتاج جوابك».
   - إن لم يبقَ شيء فاكتب «- لا شيء».
2. **قدّم على الإعلانات:** صفوف تبويب «الفرص» التي تحقق كل الشروط: F = «إعلان وظيفة»، وM إحدى: مُقيَّم، مُخصَّص، بانتظار الموافقة، أُرسل، متابعة؛ وK (الدرجة) ≥ قيمة الخلية 'الإعدادات'!B4؛ وE رابط يبدأ بـ http؛ وU («تقديم مباشر») فارغ؛ وB (التاريخ) من {since} فما بعد. رتّبها بالدرجة تنازلياً وخذ أول 10. كل سطر بهذا الشكل حرفياً (الفاصل مسافة ثم | ثم مسافة، والدرجة رقم فقط، والرابط كما في E كاملاً). إن احتوى اسم الشركة أو المسمى على | فاستبدله بـ -:
   - OPP-123 | الشركة | المسمى | الدرجة | https://رابط-الإعلان
3. **ما يحدث:**
   - عدد الفرص المسجّلة اليوم (B = {today.isoformat()}) موزّعة على قنواتها.
   - عدد الرسائل المرسلة اليوم (عمود M في «جهات الاتصال» = {today.isoformat()}).
   - عدد الشركات التي «توظف الآن»: في تبويب «الشركات» عمود G سطر «توظف الآن (<تاريخ>)» تاريخه من {since} فما بعد، وكم منها بلا جهة فردية في «جهات الاتصال» لها إيميل صالح.
   - آخر تاريخ إضافة في «جهات الاتصال» (أحدث قيمة في J).
4. **النتائج:**
   - لكل فئة في «جهات الاتصال» (عمود E)، مع فصل «إيميل التوظيف العام» و«إيميل الشركة العام» حسب عمود D: «- <الفئة>: أُرسل <ن> · ردّ <ن> · مقابلة <ن>».
   - «- تقديم مباشر: <عدد صفوف «الفرص» التي U فيها غير فارغ>»
   - «- الأسبوع {week} من 13»

أخرج Markdown فقط، بلا مقدمة ولا خاتمة ولا أسوار كود، بهذه العناوين حرفياً وبهذا الترتيب، وكل سطر تحتها يبدأ بـ «- » (القسم الفارغ يكتب تحته «- لا شيء»):
## عليك الآن
## قدّم على الإعلانات
## ما يحدث
## النتائج

بالعربية (أسماء الشركات والمسميات كما في الشيت)، بلا إيميلات ولا أرقام هواتف. الروابط فقط في قسم «قدّم على الإعلانات». التواريخ بصيغة بشرية («اليوم»، «أمس الثلاثاء»، «السبت 7 نوفمبر»)."""
        body = clean_opps_body(claude_print(prompt))
    except Exception as e:  # noqa: BLE001 — يُعاد بعد OPPS_RETRY_MIN داخل الموعد نفسه
        try:
            state = load_state(); state["opps_failed"] = True; save_state(state)
            log("فشل تحديث لوحة الفرص:", e)
            incident("opps", False, "تحديث «لوحة الفرص»", str(e), quiet_if="approvals")
        except Exception as e2:  # noqa: BLE001
            log("خطأ في تسجيل فشل لوحة الفرص:", e2)
        return str(e)[:300] or "خطأ غير معروف"
    try:
        head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
                f"# لوحة الفرص\n\nملف تلقائي من شيت البحث عن فرص جديدة، يكتبه سكربت نيكست الصوتي ثلاث مرات يومياً ويعرضه تبويب «الفرص». لا تعدّله يدوياً.\n"
                f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}.\n\n")
        (VAULT / OPPS_REL).write_text(head + body + "\n", encoding="utf-8")
        state = load_state()
        state["opps_failed"] = False
        state["opps_success"] = now.isoformat()
        if slot and not force:
            state["opps_last_slot"] = slot
        save_state(state)
        incident("opps", True, "تحديث «لوحة الفرص»")
        publish("voice: opportunities board")
        log("حُدّثت لوحة الفرص.")
        return True
    except Exception as e:  # noqa: BLE001
        log("خطأ في كتابة لوحة الفرص:", e)
        return f"تعذّرت كتابة الملف: {str(e)[:250]}"


def open_loop_items():
    """بنود قسم «مفتوح» في Open Loops (أسطر تبدأ بـ «- »)."""
    try:
        text = (VAULT / "_System" / "Open Loops.md").read_text(encoding="utf-8")
    except OSError:
        return []
    section = text.split("\n## مفتوح", 1)[-1].split("\n## ", 1)[0]
    return [l for l in section.splitlines() if l.startswith("- ")]


def board_open_count(body):
    """عدد البنود في أقسام «مفتوح الآن» و«يبدو أنه أُنجز اليوم» (بلا «- لا شيء»)."""
    n = 0
    for part in body.split("\n## ")[0:]:
        head = part.lstrip("# ").split("\n", 1)[0]
        if head.startswith("مفتوح الآن") or head.startswith("يبدو أنه أُنجز اليوم"):
            n += sum(1 for l in part.splitlines()
                     if l.startswith("- ") and not l.startswith(("- لا شيء", "- تابع مهام", "- متابعة يومية")))
    return n


def today_board(force=False):
    """«لوحة اليوم»: Open Loops كاملة (كل بند مفتوح)، وفوقها ما تغيّر في واتساب (ملاحظة على البند، وما يبدو أنه أُنجز،
    ومقترحات للـ Open Loops)، والاعتمادات — فيقرؤها نيكست الصوتي دون أن يوفّق بين مصادر. لا تلمس Open Loops (تقرير المساء يفعل) ولا تغلق شيئاً."""
    now = datetime.now(RIYADH)
    state = load_state()
    last = state.get("wa_attempt")
    wait = APPROVALS_RETRY_MIN if state.get("wa_failed") else WA_EVERY_MIN
    if not force:
        if now.hour not in APPROVALS_HOURS:
            return
        if last and (now - datetime.fromisoformat(last)).total_seconds() < wait * 60:
            return
    prev_ok = state.get("wa_ok_at")  # آخر لوحة ناجحة: رسائل واتساب قبلها لا يُعاد تفريغها
    if prev_ok and state.get("wa_full_day") != now.strftime("%Y-%m-%d") and now.hour >= 8:
        prev_ok = None  # أول لوحة بعد 8 ص كل يوم تُبنى كاملة من الصفر، فلا تتراكم أخطاء الدمج
        state["wa_full_day"] = now.strftime("%Y-%m-%d")
    state["wa_attempt"] = now.isoformat()
    save_state(state)
    prev_file = VAULT / TODAY_REL
    # جسم اللوحة السابقة كاملاً: من أول قسم «## » (التقسيم على الأسطر الفارغة كان يأخذ آخر قسم فقط)
    prev_text = prev_file.read_text(encoding="utf-8") if prev_file.exists() and prev_ok else ""
    prev_body = prev_text[prev_text.index("\n## ") + 1:] if "\n## " in prev_text else ""
    incremental = (f"""
- **تحديث تدريجي لواتساب:** اللوحة السابقة (حتى {human_when(prev_ok)}) أدناه. في واتساب اقرأ وفرّغ فقط الرسائل والفويسات الأحدث منها، وخذ ما قبلها من اللوحة السابقة (واحذف ما تجاوز 24 ساعة). اللوحة السابقة **مصدر لما قالته رسائل واتساب الأقدم فقط**، لا لتصنيف البنود: أعد بناء كل الأقسام بالقواعد أدناه من Open Loops الحالية. بنود «ينتظر ردك في واتساب» السابقة تبقى إلا إن ردّ عليها الوليد برسالة جديدة. أما Open Loops والاعتمادات فاقرأها من جديد كاملة.
<اللوحة السابقة>
{prev_body}
</اللوحة السابقة>""" if prev_body else "")
    items = open_loop_items()
    open_count, daily_count = len(items), sum("متابعة: يومية" in l for l in items)
    prompt = f"""مهمة قراءة فقط: لا تعدّل أي ملف في الـ Vault ولا تكتب في أي مكان، عدا مجلد مؤقت تنشئه بـ mktemp لنسخة قاعدة واتساب وتفريغ الفويسات، **واحذفه في النهاية**. الآن: {human_now()} بتوقيت الرياض.
اقرأ:
1. `_System/Open Loops.md` كاملاً (أقسام «مفتوح» و«مقترحات» و«مُغلق»، والقواعد في رأسه).
2. `_System/Pending Approvals.md` (ما ينتظر اعتماده من شيت المحتوى وشيت الفرص).
3. واتساب: رسائل آخر 24 ساعة في محادثات النطاق فقط — النطاق والأسماء في `_System/Assistant People.md`، وطريقة القراءة (نسخ القاعدة، التوقيت، المرسل، تفريغ الفويسات المنزّلة) في قسم «المصادر» في `_System/Telegram Assistant/CLAUDE.md`.
4. طلبات نيكست الصوتي اليوم في `Inbox/` (ملفات `source: نيكست الصوتي`) لتعرف ما طلب الوليد إغلاقه أو إضافته اليوم.

ثم أخرج «لوحة اليوم»: Markdown فقط بلا مقدمة، 7000 حرف كحد أقصى، بالفصحى وبروح `_System/Report Format.md` (سطر قصير لكل بند، الاسم وحده، تواريخ بشرية، بلا تفاصيل تقنية ولا أرقام مستندات ولا كلمات مرور).
**الأساس قسم «مفتوح» في Open Loops كاملاً، وواتساب طبقة فوقه.** فيه الآن {open_count} بنداً، منها {daily_count} عليها `متابعة: يومية`. كل بند عادي (بلا `متابعة: يومية`) يظهر مرة واحدة بالضبط في أحد أقسام «مفتوح الآن» الثلاثة أو في «يبدو أنه أُنجز اليوم». لا اختصار ولا «و<ن> بنود أخرى» ولا حد أقصى. بنود `متابعة: يومية` تُجمَّع باسم صاحبها كما يلي. بهذا الشكل حرفياً، والقسم الفارغ تحته «- لا شيء»:
## مفتوح الآن — موعده اليوم
- <«عليك» أو اسم صاحب الفعل>: <ماذا> — <«اليوم» أو «متأخر منذ …»>
- تابع مهام <الشخص> لليوم: <بنوده التي موعدها اليوم باختصار>؛ والمتأخر: <بنوده المتأخرة باختصار، إن وُجدت>
(فقط ما اتُّفق صراحة على أن موعده اليوم، وكل متأخر عن موعده من الأيام السابقة. المتأخر أولاً، وما عليه هو قبل ما عند غيره. سطر «تابع مهام» واحد لكل شخص له بنود متابعة يومية موعدها اليوم أو متأخرة)
## مفتوح الآن — قادم
- <«عليك» أو اسم صاحب الفعل>: <ماذا> — <الموعد>
- متابعة يومية — <الشخص>: <عدد بنوده القادمة>، أقربها <ماذا> <متى>، وآخرها <متى>
(البنود العادية بموعد بعد اليوم، الأقرب أولاً؛ وسطر واحد لكل شخص له بنود متابعة يومية قادمة)
## مفتوح الآن — بلا موعد (يحتاج قرارك)
- <«عليك» أو اسم صاحب الفعل>: <ماذا> — مفتوح منذ <متى>
(كل بند بلا موعد، الأقدم أولاً. هذه قرارات معلّقة: يسأله نيكست متى تُسلَّم)
## يبدو أنه أُنجز اليوم (ينتظر تأكيدك قبل الإغلاق)
- <نص البند كما هو في Open Loops، مختصراً> ← <الدليل من الرسائل> — <متى>
(بنود «مفتوح» التي تدل رسائل آخر 24 ساعة بوضوح على أنها سُلّمت أو حُسمت أو دُفعت **كلها**. إن أُنجز جزء وبقي جزء فالبند يبقى في قسمه من «مفتوح الآن» بالجزء الباقي، مع « · واتساب: ✅ <ما أُنجز منه>»، ولا يُنقل جزؤه الباقي إلى «مقترحات». عند الشك يبقى في «مفتوح الآن» مع ملاحظة واتساب)
## مقترحات للـ Open Loops (تنتظر قرارك)
- <على من>: <الالتزام> — <الموعد إن ذُكر> ← <المصدر باختصار> <«(جديد)» إن لم يكن في قسم «مقترحات» في Open Loops>
(ما في قسم «مقترحات» في Open Loops، ثم كل وعد أو طلب أو اتفاق جديد في رسائل آخر 24 ساعة له صاحب وشيء محدد وغير موجود في «مفتوح» أو «مقترحات» أو «مُغلق». بما فيها ما طُلب منه هو. ما له موعد صريح متفق عليه يُكتب هنا أيضاً بـ «(موعد صريح — يُسجَّل في المساء)»، لأن اللوحة لا تكتب في Open Loops. سطر قصير لكلٍّ، الأهم أولاً)
## ينتظر ردك في واتساب
- <الاسم>: <ماذا يريد> — <متى>
## اعتمادات معلّقة
- <النوع>: <العدد> (سطر لكل نوع من Pending Approvals؛ مثل «أفكار محتوى: 6»)
## أُنجز ومُغلق
- <البند> — <متى أُغلق>
(ما في «مُغلق» بتاريخ اليوم أو أمس)
## الجديد في واتساب
### <المحادثة>
- <من>: <ماذا باختصار> — <متى>
(المحادثة التي لا جديد فيها لا تظهر، وما ذُكر في الأقسام السابقة لا يُكرر هنا)
- ملاحظة واتساب في آخر سطر البند في أقسام «مفتوح الآن» تُضاف فقط إن كان في رسائل آخر 24 ساعة جديد عنه، بصيغة « · واتساب: ⏳ <وعد بموعد جديد>» أو « · واتساب: ✅ <جزء أُنجز>» أو « · واتساب: ⚠️ <تأخر أو مشكلة>» أو « · واتساب: 💬 <جديد آخر>». وإلا فلا شيء.
- فويس لم يُنزَّل على الماك: «فويس لم يُنزَّل». ما لم يتضح: «غير واضح». لا اختلاق.
- ردك هو اللوحة وحدها: لا تكتب بعدها أي ملاحظة عن عملك أو الملفات أو المجلدات.{incremental}"""
    try:
        body = claude_print(prompt)
        if "## مفتوح الآن — موعده اليوم" not in body or "## مقترحات للـ Open Loops" not in body:
            raise RuntimeError("شكل غير متوقع: " + body[:200])
        body = body[body.index("## مفتوح الآن — موعده اليوم"):].split("\n---", 1)[0]
        shown = board_open_count(body)
        items = open_loop_items()  # قد يُغلق بند أثناء التوليد (طلب صوتي)
        open_count, daily_count = len(items), sum("متابعة: يومية" in l for l in items)
        regular = open_count - daily_count
        if shown < regular:
            log(f"تنبيه: اللوحة تذكر {shown} من {regular} بنداً عادياً مفتوحاً.")
    except Exception as e:  # noqa: BLE001 — يُعاد بعد APPROVALS_RETRY_MIN
        state = load_state(); state["wa_failed"] = True; save_state(state)
        log("فشل لوحة اليوم:", e)
        incident("board", False, "تحديث «لوحة اليوم»", str(e), quiet_if="approvals")
        return
    head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
            f"# لوحة اليوم\n\nملف تلقائي يجهّزه نيكست الكبير عند استيقاظ الماك وكل ساعتين نهاراً: [[Open Loops]] كاملة، وفوقها ما تغيّر في واتساب، و[[Pending Approvals]]، لنيكست الصوتي. لا تعدّله يدوياً؛ Open Loops يحدّثه تقرير المساء وما يؤكده الوليد.\n"
            f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}. "
            f"في Open Loops {open_count} بنداً مفتوحاً، منها {daily_count} متابعة يومية مجمّعة باسم صاحبها؛ والبنود العادية في اللوحة {shown} من {regular}.\n\n")
    (VAULT / TODAY_REL).write_text(head + body.strip() + "\n", encoding="utf-8")
    state = load_state(); state.update(wa_failed=False, wa_ok_at=now.strftime("%Y-%m-%d %H:%M")); save_state(state)
    incident("board", True, "تحديث «لوحة اليوم»")
    publish("voice: today board")
    log("حُدّثت لوحة اليوم.")


def recover_stuck():
    """طلب بقي «working» لأن التشغيل انقطع أثناء تنفيذه (غطاء الماك أُغلق مثلاً): يعود pending، أو failed بعد MAX_ATTEMPTS."""
    changed = False
    for path, meta, body in big_requests("working"):
        since = meta.get("working_since")
        try:
            started = datetime.fromisoformat(since)
        except (TypeError, ValueError):
            started = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        if (datetime.now(timezone.utc) - started).total_seconds() < STUCK_MIN * 60:
            continue
        if int(meta.get("attempts") or 1) >= MAX_ATTEMPTS:
            set_fields(path, status="failed", notified="no")
            with path.open("a", encoding="utf-8") as f:
                f.write(f"\n## فشل التنفيذ\nانقطع التنفيذ {MAX_ATTEMPTS} مرات (الماك أُغلق أو نام أثناء العمل).\n")
            log("فشل بعد انقطاعات متكررة:", path.name)
        else:
            set_fields(path, status="pending")
            log("أُعيد طلب عالق:", path.name)
        changed = True
    if changed:
        publish("voice: recovered stuck requests")


ARCHIVE_AFTER_H = 24
DONE_STATUSES = ("answered", "failed", "cancelled", "done")


def archive_done_requests():
    """طلب نيكست الكبير المكتمل (رُدّ عليه، وأُبلغ أو سُمع) يُنقل إلى Inbox/_processed/ بعد ARCHIVE_AFTER_H ساعة.
    ملاحظات الوليد وأفكاره (غير BIG_KIND) تبقى لأمر «عالج الـ Inbox»."""
    out = VAULT / "Inbox" / "_processed"
    moved = 0
    for path in sorted((VAULT / "Inbox").glob("*.md")):
        meta, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
        if meta.get("kind") != BIG_KIND or meta.get("status") not in DONE_STATUSES:
            continue
        if meta.get("notified") == "no" or meta.get("heard") == "no":
            continue
        try:
            done = datetime.strptime(meta.get("answered", ""), "%Y-%m-%d %H:%M").replace(tzinfo=RIYADH)
        except ValueError:
            done = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        if (datetime.now(timezone.utc) - done).total_seconds() < ARCHIVE_AFTER_H * 3600:
            continue
        out.mkdir(exist_ok=True)
        dest = out / path.name
        if dest.exists():
            dest = out / f"{path.stem} ({datetime.now().strftime('%H%M%S')}){path.suffix}"
        path.rename(dest)
        moved += 1
    if moved:
        publish("voice: archive done requests")
        log("نُقل إلى Inbox/_processed:", moved)


OPPS_REFRESH_TITLE = "تحديث لوحة الفرص الآن"  # الثابت نفسه في app.js (زر «حدّث اللوحة»)
OPPS_REFRESH_MIN_GAP = 10                      # دقائق: أقرب من هذا لآخر تحديث ناجح = لا تشغيل لـ Claude
OPPS_FRESH_REPLY = "اللوحة محدّثة قبل دقائق"


def finish_refresh(path, reply, failed=False):
    """يغلق طلب «تحديث لوحة الفرص الآن» بسطر واحد. لا إشعار تيليجرام إلا عند الفشل (notified: no)."""
    fields = {"status": "failed", "notified": "no"} if failed else {"status": "done"}
    set_fields(path, answered=datetime.now().strftime("%Y-%m-%d %H:%M"), **fields)
    with path.open("a", encoding="utf-8") as f:
        f.write(f"\n## {'فشل التنفيذ' if failed else 'ردّ نيكست الكبير'}\n{reply}\n")


def run_opps_refreshes(requests):
    """طلبات زر «حدّث اللوحة»: لا تمرّ بـ claude -p كطلب عادي؛ تشغّل opps_board(force=True) مرة واحدة على الأكثر.
    الحماية: آخر تحديث ناجح قبل أقل من OPPS_REFRESH_MIN_GAP دقيقة = لا تشغيل. الطلبات الزائدة تُغلق بالرد نفسه."""
    if not requests:
        return
    last = load_state().get("opps_success")
    fresh = bool(last) and (datetime.now(RIYADH) - datetime.fromisoformat(last)).total_seconds() < OPPS_REFRESH_MIN_GAP * 60
    first, rest = requests[0], requests[1:]
    dup_reply = OPPS_FRESH_REPLY
    if fresh:
        rest = requests
        log("لوحة الفرص محدّثة قبل دقائق — لا تشغيل:", len(rest))
    else:
        path = first[0]
        set_fields(path, status="working", working_since=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   attempts=int(first[1].get("attempts") or 0) + 1)
        publish("voice: refreshing opportunities board")
        log("تحديث يدوي للوحة الفرص:", path.name)
        try:
            result = opps_board(force=True)
        except Exception as e:  # noqa: BLE001 — opps_board معزولة أصلاً؛ احتياط
            result = str(e)[:300]
        if result is True:
            finish_refresh(path, f"حُدّثت لوحة الفرص {human_time(datetime.now(RIYADH))}")
        else:
            reason = f"لم تُحدَّث لوحة الفرص: {result or 'خطأ غير معروف'}"
            finish_refresh(path, reason, failed=True)
            dup_reply = reason + " (طلب مكرر؛ أُبلغت بالفشل مرة واحدة)"
    for path, _, _ in rest:
        finish_refresh(path, dup_reply)
    publish("voice: opportunities board refresh done")


APPROVALS_REFRESH_TITLE = "تحديث ما ينتظر اعتمادي الآن"  # الثابت نفسه في app.js (زر ↻ في تبويب «البراند»)
APPROVALS_REFRESH_MIN_GAP = 10                             # دقائق منذ آخر تحديث ناجح
APPROVALS_FRESH_REPLY = "القائمة محدّثة قبل دقائق"


def is_approvals_refresh(path):
    return path.name.split(" صوتي - ", 1)[-1].startswith(APPROVALS_REFRESH_TITLE)


def run_approvals_refreshes(requests):
    """طلبات زر ↻ في «البراند»: لا تمرّ بـ claude -p كطلب عادي؛ snapshot_approvals(manual=True) مرة واحدة على الأكثر،
    على نمط run_opps_refreshes. لا يمس approvals_attempt، فلا يغيّر المواعيد المجدولة."""
    if not requests:
        return
    last = load_state().get("approvals_success")
    fresh = bool(last) and (datetime.now(RIYADH) - datetime.fromisoformat(last)).total_seconds() < APPROVALS_REFRESH_MIN_GAP * 60
    first, rest = requests[0], requests[1:]
    dup_reply = APPROVALS_FRESH_REPLY
    if fresh:
        rest = requests
        log("«ما ينتظر اعتمادي» محدّثة قبل دقائق — لا تشغيل:", len(rest))
    else:
        path = first[0]
        set_fields(path, status="working", working_since=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   attempts=int(first[1].get("attempts") or 0) + 1)
        publish("voice: refreshing pending approvals")
        log("تحديث يدوي لـ «ما ينتظر اعتمادي»:", path.name)
        try:
            result = snapshot_approvals(manual=True)
        except Exception as e:  # noqa: BLE001
            result = str(e)[:300]
        if result is True:
            finish_refresh(path, f"حُدّثت قائمة الاعتمادات {human_time(datetime.now(RIYADH))}")
        else:
            reason = f"لم تُحدَّث قائمة الاعتمادات: {result or 'خطأ غير معروف'}"
            finish_refresh(path, reason, failed=True)
            dup_reply = reason + " (طلب مكرر؛ أُبلغت بالفشل مرة واحدة)"
    for path, _, _ in rest:
        finish_refresh(path, dup_reply)
    publish("voice: pending approvals refresh done")


HABITS_REL = Path("Strategy") / "سجل العادات.md"  # الملف نفسه في app.js (تبويب «أهدافي»)
HABIT_FILE_RE = re.compile(r"عادة:?\s+.+\s+تم\s+\d{4}-\d{2}-\d{2}")  # في اسم الملف تصير «:» مسافة
HABIT_TITLE_RE = re.compile(r"^#\s*عادة:?\s+(.+?)\s+تم\s+(\d{4}-\d{2}-\d{2})\s*$", re.M)
HABIT_MAX_AGE = 7  # أيام


def is_habit_request(path):
    return bool(HABIT_FILE_RE.search(path.name))


def log_habit(body):
    """يضيف «- التاريخ | الاسم | تم» في آخر قسم «## السجل». يعيد (نجح، سطر الرد)."""
    m = HABIT_TITLE_RE.search(body)
    if not m:
        return False, "لم يُسجَّل: عنوان الطلب ليس بصيغة «عادة: <الاسم> تم <YYYY-MM-DD>»"
    name, day = m.group(1).strip(), m.group(2)
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return False, f"لم يُسجَّل: التاريخ {day} غير صحيح"
    today = datetime.now(RIYADH).date()
    if d > today:
        return False, f"لم يُسجَّل: التاريخ {day} في المستقبل"
    if (today - d).days > HABIT_MAX_AGE:
        return False, f"لم يُسجَّل: التاريخ {day} أقدم من {HABIT_MAX_AGE} أيام"
    path = VAULT / HABITS_REL
    if not path.exists():
        return False, f"لم يُسجَّل: الملف {HABITS_REL} غير موجود"
    lines = path.read_text(encoding="utf-8").split("\n")
    heads = [i for i, l in enumerate(lines) if l.startswith("## ")]
    def section(title):
        idx = [i for i in heads if lines[i].strip() == title]
        if not idx:
            return None
        start = idx[-1]
        end = next((i for i in heads if i > start), len(lines))
        return start, end
    defs, logsec = section("## العادات"), section("## السجل")
    if logsec is None:
        return False, f"لم يُسجَّل: لا يوجد قسم «## السجل» في {HABITS_REL}"
    names = set()
    if defs:
        names = {l[2:].split(" | ")[0].strip() for l in lines[defs[0] + 1:defs[1]] if l.startswith("- ")}
    if name not in names:
        return False, f"لم يُسجَّل: «{name}» ليست عادة معرّفة في قسم «## العادات»"
    entry = f"- {day} | {name} | تم"
    start, end = logsec
    if any(l.strip() == entry for l in lines[start + 1:end]):
        return True, f"عادة «{name}» مسجّلة يوم {day} من قبل"
    at = end
    while at > start + 1 and not lines[at - 1].strip():
        at -= 1  # بعد آخر سطر غير فارغ في القسم
    lines.insert(at, entry)
    path.write_text("\n".join(lines), encoding="utf-8")
    return True, f"سُجّلت عادة «{name}» يوم {day}"


def run_habit_requests(requests):
    """طلبات زر «تم» في «أهدافي»: لا تمرّ بـ claude -p. تيليجرام عند الفشل فقط."""
    if not requests:
        return
    for path, _, body in requests:
        try:
            ok, reply = log_habit(body)
        except Exception as e:  # noqa: BLE001
            ok, reply = False, f"لم يُسجَّل: {str(e)[:200]}"
        finish_refresh(path, reply, failed=not ok)
        log("عادة:", reply)
    publish("voice: habit logged")


def process_big_requests():
    recover_stuck()
    acted = False
    pending = big_requests("pending")
    refresh = [r for r in pending if OPPS_REFRESH_TITLE in r[0].name]
    habits = [r for r in pending if is_habit_request(r[0])]
    approvals = [r for r in pending if is_approvals_refresh(r[0])]
    try:
        run_opps_refreshes(refresh)  # ليست «فعلاً» يستدعي snapshot_approvals
    except Exception as e:  # noqa: BLE001
        log("خطأ في طلبات تحديث لوحة الفرص:", e)
    try:
        run_habit_requests(habits)  # وليست هذه «فعلاً» أيضاً
    except Exception as e:  # noqa: BLE001
        log("خطأ في طلبات العادات:", e)
    try:
        run_approvals_refreshes(approvals)  # ولا هذه
    except Exception as e:  # noqa: BLE001
        log("خطأ في طلبات تحديث «ما ينتظر اعتمادي»:", e)
    for path, meta, body in pending:
        if OPPS_REFRESH_TITLE in path.name or is_habit_request(path) or is_approvals_refresh(path):
            continue
        item = execute(path, meta, body)
        acted = acted or is_action(item)
        log("فعل — سيُبلَّغ:" if is_action(item) else "سؤال — يُسمع في المكالمة التالية:", path.name)
    notify_pending()
    if acted:  # قد يكون اعتمد فكرة: حدّث النسخة فوراً
        snapshot_approvals(force=True)


LOG = Path.home() / "Library" / "Logs" / "next-voice-sync.log"


def rotate_log(max_bytes=2_000_000, keep_lines=3000):
    """السجل يكبر نحو 40KB يومياً؛ إن تجاوز 2MB يُبقى آخر 3000 سطر."""
    try:
        if LOG.stat().st_size > max_bytes:
            lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-keep_lines:]
            LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def main():
    rotate_log()
    args = sys.argv[1:]
    if "--test-alert" in args:
        notify("🔔 نيكست: تجربة التنبيه", "إن وصلك هذا الإشعار وهذا الإيميل فتنبيهات أعطال نيكست تعمل.")
        return 0
    out = VAULT / INDEX_REL
    if "--out" in args:
        out = Path(args[args.index("--out") + 1])
    count, changed = write_index(out)
    print(f"الفهرس: {count} ملاحظة{' (محدّث)' if changed else ''} → {out}")
    if "--index-only" in args:
        return 0
    if "--opps-board" in args:  # تجربة: مزامنة ثم لوحة الفرص فقط
        status = sync()
        if status == 0:
            opps_board(force=True)
        return status
    # استيقاظ الماك: فجوة طويلة منذ آخر تشغيل (launchd لا يعمل والماك نائم)
    state = load_state()
    prev = state.get("last_run")
    woke = bool(prev) and (datetime.now(timezone.utc) - datetime.fromisoformat(prev)).total_seconds() > WAKE_GAP_MIN * 60
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    if woke:
        log("الماك استيقظ بعد نوم — لوحة اليوم فوراً.")
    status = sync()
    try:
        watch_telegram_next()
    except Exception as e:  # noqa: BLE001
        log("خطأ في مراقبة نيكست تيليجرام:", e)
    if status == 0:
        try:
            process_big_requests()
            incident("big", True, "تنفيذ طلبات نيكست الكبير")
        except Exception as e:  # noqa: BLE001
            log("خطأ في طلبات نيكست الكبير:", e)
            incident("big", False, "تنفيذ طلبات نيكست الكبير", str(e))
        try:
            archive_done_requests()
        except Exception as e:  # noqa: BLE001
            log("خطأ في نقل الطلبات المكتملة:", e)
        try:
            snapshot_approvals(force=woke)
        except Exception as e:  # noqa: BLE001
            log("خطأ في «ما ينتظر اعتمادك»:", e)
        opps_board()  # معزولة داخلياً: فشلها لا يمس ما قبلها ولا ما بعدها
        try:
            today_board(force=woke)
        except Exception as e:  # noqa: BLE001
            log("خطأ في لوحة اليوم:", e)
    return status


if __name__ == "__main__":
    sys.exit(main())
