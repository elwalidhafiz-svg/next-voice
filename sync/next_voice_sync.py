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
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

VAULT = Path.home() / "Documents" / "My Vault"
BIG_KIND = "سؤال لنيكست الكبير"
STALE_MIN = 60
CLAUDE_TIMEOUT = 15 * 60
STUCK_MIN = 20          # طلب «working» أطول من هذا يُعاد (انقطع التشغيل أثناء تنفيذه)
MAX_ATTEMPTS = 2        # بعدها يُعلَّم failed ويُبلَّغ
SYNC_ALERT_AFTER = 3    # فشل مزامنة متتالٍ قبل تنبيه تيليجرام
STATE = Path.home() / ".local" / "share" / "next-voice" / "state.json"
APPROVALS_REL = Path("_System") / "Pending Approvals.md"
APPROVALS_EVERY_MIN = 120          # نسخة «ما ينتظر اعتمادك» كل ساعتين
APPROVALS_RETRY_MIN = 30           # بعد فشل
APPROVALS_HOURS = range(8, 23)     # من 8 ص حتى 11 م بتوقيت الرياض
JOBS_SHEET = "15Jihl4OMeHZNz8HqaZy50teiKXFLaVZyqu098bGHDvU"
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
        return
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
        return
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
- استثناء وحيد في الشيتات: إن كان الطلب اعتماد فكرة محتوى، فغيّر «حالة النشر» لذلك الصف في تبويب «نظام إدارة البراندينج» من `فكرة جديدة - بانتظار الموافقة` إلى `معتمدة` فقط (تحقق أن الصف بهذه الحالة فعلاً). لا تغيّر أي حالة أخرى أبداً، ولا تضع `معتمد للنشر`، ولا تعتمد مسودة أو تصميماً أو إيميلاً؛ هذه تُعتمد في جلساتها.
- **إيميلات التواصل** (مسودات في `_System/Outreach Drafts/`، والشكل والحالات في `_شكل الملف.md` هناك):
  - «اعتمد إيميل …»: حدّد الملف بالاسم أو الشركة (إن لم يتضح أو وُجد أكثر من ملف فلا تعتمد، واذكر ذلك في ردك). تحقق أن حالته `بانتظار الموافقة`، ثم اكتب `status: معتمد بالصوت` و`approved_at: <التاريخ والوقت>`. لا ترسل شيئاً ولا تغيّر الشيت؛ مهمة التواصل ترسله في تشغيلها التالي.
  - «عدّل إيميل …: <التعديل>»: عدّل النص في الملف نفسه بقواعد الكتابة في `Projects/نظام البحث عن فرص جديدة.md` (أسلوبه، ≤ 150 كلمة، بلا شرطة طويلة، التوقيع كما هو)، وأضف سطراً مؤرخاً في «## التعديلات». الحالة تبقى `بانتظار الموافقة`. ضع النص الجديد كاملاً في ردك ليُقرأ عليه.
  - «ألغِ إيميل …»: `status: مُلغى`.
- ممنوع دون تأكيد: إرسال أي رسالة أو إيميل، وتعديل أي شيت، وأي تغيير خارجي آخر. اذكره في آخر ردك تحت «يحتاج تأكيدك:» ولا تنفّذه.
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
    try:
        item["answer"], item["changes"] = run_claude(rel, body, item["requested"], meta.get("type") or "سؤال")
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


def snapshot_approvals(force=False):
    """كل ساعتين نهاراً: نيكست الكبير يقرأ الشيتين ويكتب ما ينتظر اعتماد الوليد في _System/Pending Approvals.md."""
    now = datetime.now(RIYADH)
    state = load_state()
    if now.hour not in APPROVALS_HOURS and not force:
        return
    last = state.get("approvals_attempt")
    wait = APPROVALS_RETRY_MIN if state.get("approvals_failed") else APPROVALS_EVERY_MIN
    if last and not force and (now - datetime.fromisoformat(last)).total_seconds() < wait * 60:
        return
    state["approvals_attempt"] = now.isoformat()
    save_state(state)
    prompt = f"""اقرأ شيتين بأداة Google Sheets (قراءة فقط، لا تكتب في أي شيت ولا ملف):
1. شيت المحتوى «My Social Media Calendar»، تبويب «نظام إدارة البراندينج» (ابحث عنه في Drive بالاسم إن لزم). من عمود «حالة النشر» خذ الصفوف بهذه الحالات حرفياً: `فكرة جديدة - بانتظار الموافقة`، `مسودة جاهزة - بانتظار المراجعة`، `التصميم جاهز - بانتظار المراجعة`، وصفوف `النص معتمد` التي منصتها «انستجرام» (كاروسيلات يصمّمها الوليد بنفسه في Claude Design).
2. شيت البحث عن فرص جديدة {JOBS_SHEET}: تبويب «جهات الاتصال» (عمود L حالة التواصل = `بانتظار الموافقة`) وتبويب «الفرص» (عمود M الحالة = `بانتظار الموافقة`). لا تكرر الشخص نفسه.

أخرج Markdown فقط، بلا مقدمة ولا خاتمة، بهذا الشكل حرفياً (القسم الفارغ يكتب تحته «- لا شيء»):
## أفكار محتوى جديدة (<العدد>) — تُعتمد بالصوت
- صف <رقم الصف في الشيت>: <الفكرة بجملة قصيرة> — <السلسلة> · <المنصة>
## مسودات تنتظر مراجعتك (<العدد>) — تُعتمد في جلسة «مرحلة الكتابة»
- <الفكرة بجملة قصيرة> — <المنصة>
## تصاميم تنتظر مراجعتك (<العدد>) — تُعتمد من الشيت بعد رؤيتها
- <الفكرة بجملة قصيرة> — <المنصة>
## كاروسيلات تنتظر تصميمك (<العدد>) — تصمّمها في Claude Design من برومبت المحتوى
- <الفكرة بجملة قصيرة> — <السلسلة>
## إيميلات تواصل تنتظر موافقتك (<العدد>) — تُعتمد في جلسة «مهمة التواصل»
- <الاسم> — <المنصب> — <الشركة> — <أولى أو متابعة> — <«نصه جاهز للمراجعة بالصوت» إن وُجد له ملف في `_System/Outreach Drafts/` بحالة `بانتظار الموافقة`، وإلا «نصه في جلسة مهمة التواصل فقط»>

بالعربية، بلا روابط ولا إيميلات ولا معرّفات غير رقم الصف."""
    try:
        body = claude_print(prompt)
        if "## أفكار محتوى جديدة" not in body:
            raise RuntimeError("شكل غير متوقع: " + body[:200])
    except Exception as e:  # noqa: BLE001 — يُعاد بعد APPROVALS_RETRY_MIN
        state = load_state(); state["approvals_failed"] = True; save_state(state)
        log("فشل تحديث «ما ينتظر اعتمادك»:", e)
        return
    head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
            f"# ما ينتظر اعتمادي\n\nملف تلقائي يكتبه سكربت نيكست الصوتي كل ساعتين نهاراً من شيت المحتوى وشيت البحث عن فرص جديدة. لا تعدّله يدوياً.\n"
            f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}.\n\n")
    (VAULT / APPROVALS_REL).write_text(head + body.strip() + "\n", encoding="utf-8")
    state = load_state(); state["approvals_failed"] = False; save_state(state)
    publish("voice: pending approvals snapshot")
    log("حُدّث «ما ينتظر اعتمادك».")


def today_board(force=False):
    """«لوحة اليوم»: صورة واحدة ليوم الوليد يجهّزها نيكست الكبير من Open Loops وواتساب وما ينتظر اعتماده،
    فيقرؤها نيكست الصوتي دون أن يوفّق بين مصادر. لا تلمس Open Loops (تقرير المساء يفعل) ولا تغلق شيئاً."""
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
    prev_body = prev_file.read_text(encoding="utf-8").split("\n\n", 3)[-1] if prev_file.exists() and prev_ok else ""
    incremental = (f"""
- **تحديث تدريجي لواتساب:** اللوحة السابقة (حتى {human_when(prev_ok)}) أدناه. في واتساب اقرأ وفرّغ فقط الرسائل والفويسات الأحدث منها، وخذ ما قبلها من اللوحة السابقة (واحذف ما تجاوز 24 ساعة). بنود «ينتظر ردك في واتساب» السابقة تبقى إلا إن ردّ عليها الوليد برسالة جديدة. أما Open Loops والاعتمادات فاقرأها من جديد كاملة.
<اللوحة السابقة>
{prev_body}
</اللوحة السابقة>""" if prev_body else "")
    prompt = f"""مهمة قراءة فقط: لا تعدّل أي ملف في الـ Vault ولا تكتب في أي مكان، عدا مجلد مؤقت تنشئه بـ mktemp لنسخة قاعدة واتساب وتفريغ الفويسات، **واحذفه في النهاية**. الآن: {human_now()} بتوقيت الرياض.
اقرأ:
1. `_System/Open Loops.md` كاملاً (قسما «مفتوح» و«مُغلق»).
2. `_System/Pending Approvals.md` (ما ينتظر اعتماده من شيت المحتوى وشيت الفرص).
3. واتساب: رسائل آخر 24 ساعة في محادثات النطاق فقط — النطاق والأسماء في `_System/Assistant People.md`، وطريقة القراءة (نسخ القاعدة، التوقيت، المرسل، تفريغ الفويسات المنزّلة) في قسم «المصادر» في `_System/Telegram Assistant/CLAUDE.md`.
4. طلبات نيكست الصوتي اليوم في `Inbox/` (ملفات `source: نيكست الصوتي`) لتعرف ما طلب الوليد إغلاقه أو إضافته اليوم.

ثم أخرج «لوحة اليوم»: Markdown فقط بلا مقدمة، 5000 حرف كحد أقصى، بالفصحى وبروح `_System/Report Format.md` (قصير، الاسم وحده، تواريخ بشرية، بلا تفاصيل تقنية ولا أرقام مستندات ولا كلمات مرور). كل بند يُذكر في قسم واحد فقط. بهذا الشكل حرفياً، والقسم الفارغ تحته «- لا شيء»:
## يحتاجك الآن
- <فعل مطلوب منه هو>: <ماذا> — <الموعد أو التأخير>
(من بنود Open Loops المفتوحة التي تحتاج فعله، ومن الاعتمادات بسطر لكل نوع، الأهم أولاً، 7 كحد أقصى)
## ينتظر ردك في واتساب
- <الاسم>: <ماذا يريد> — <متى>
## يبدو أنه أُنجز اليوم (ينتظر تأكيدك قبل الإغلاق)
- <نص البند كما هو في Open Loops، مختصراً> ← <الدليل من الرسائل> — <متى>
(فقط بنود «مفتوح» التي تدل رسائل اليوم بوضوح على أنها سُلّمت أو حُسمت أو دُفعت. عند الشك لا تذكره)
## أُنجز ومُغلق
- <البند> — <متى أُغلق>
(ما في «مُغلق» بتاريخ اليوم أو أمس)
## عند الفريق
- <الاسم>: <ماذا> — <الموعد>
(بنود «مفتوح» على غيره: المتأخر وما موعده اليوم أو بكرة فقط، ثم سطر «و<ن> بنود أخرى في موعدها»)
## الجديد في واتساب
### <المحادثة>
- <من>: <ماذا باختصار> — <متى>
(المحادثة التي لا جديد فيها لا تظهر)
- فويس لم يُنزَّل على الماك: «فويس لم يُنزَّل». ما لم يتضح: «غير واضح». لا اختلاق.
- ردك هو اللوحة وحدها: لا تكتب بعدها أي ملاحظة عن عملك أو الملفات أو المجلدات.{incremental}"""
    try:
        body = claude_print(prompt)
        if "## يحتاجك الآن" not in body or "## يبدو أنه أُنجز اليوم" not in body:
            raise RuntimeError("شكل غير متوقع: " + body[:200])
        body = body[body.index("## يحتاجك الآن"):].split("\n---", 1)[0]
    except Exception as e:  # noqa: BLE001 — يُعاد بعد APPROVALS_RETRY_MIN
        state = load_state(); state["wa_failed"] = True; save_state(state)
        log("فشل لوحة اليوم:", e)
        return
    head = (f"---\ntype: system\nupdated: {now.strftime('%Y-%m-%d %H:%M')}\n---\n"
            f"# لوحة اليوم\n\nملف تلقائي يجهّزه نيكست الكبير عند استيقاظ الماك وكل ساعتين نهاراً من [[Open Loops]] وواتساب و[[Pending Approvals]]، لنيكست الصوتي. لا تعدّله يدوياً؛ Open Loops يحدّثه تقرير المساء وما يؤكده الوليد.\n"
            f"آخر تحديث: {human_day(now.date(), now.date())} {human_time(now)}.\n\n")
    (VAULT / TODAY_REL).write_text(head + body.strip() + "\n", encoding="utf-8")
    state = load_state(); state.update(wa_failed=False, wa_ok_at=now.strftime("%Y-%m-%d %H:%M")); save_state(state)
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


def process_big_requests():
    recover_stuck()
    acted = False
    for path, meta, body in big_requests("pending"):
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
    out = VAULT / INDEX_REL
    if "--out" in args:
        out = Path(args[args.index("--out") + 1])
    count, changed = write_index(out)
    print(f"الفهرس: {count} ملاحظة{' (محدّث)' if changed else ''} → {out}")
    if "--index-only" in args:
        return 0
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
        except Exception as e:  # noqa: BLE001
            log("خطأ في طلبات نيكست الكبير:", e)
        try:
            snapshot_approvals(force=woke)
        except Exception as e:  # noqa: BLE001
            log("خطأ في «ما ينتظر اعتمادك»:", e)
        try:
            today_board(force=woke)
        except Exception as e:  # noqa: BLE001
            log("خطأ في لوحة اليوم:", e)
    return status


if __name__ == "__main__":
    sys.exit(main())
