#!/usr/bin/env python3
"""مزامنة الـ Vault مع GitHub لنيكست الصوتي.

1. يبني فهرساً للبحث في .next-voice/index.json (يقرؤه تطبيق الجوال).
2. إن كان الـ Vault مستودع git له remote: commit ثم pull --rebase ثم push.
3. «نيكست الكبير»: طلبات صوتية في Inbox/ بنوع BIG_KIND وحالة pending
   - حديثة (≤ STALE_MIN): يشغّل Claude على الماك، يكتب الرد في الملف، ويرسله على تيليجرام.
   - قديمة (الماك كان مغلقاً): يسأل الوليد على تيليجرام أولاً، وينفّذها نيكست تيليجرام إن وافق.

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
from datetime import datetime, timezone
from pathlib import Path

VAULT = Path.home() / "Documents" / "My Vault"
BIG_KIND = "سؤال لنيكست الكبير"
STALE_MIN = 60
CLAUDE_TIMEOUT = 15 * 60
TG_DIR = Path.home() / ".claude" / "channels" / "telegram"
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


def sync():
    if not (VAULT / ".git").exists() or not git("remote").stdout.strip():
        print("الـ Vault ليس مستودع git له remote بعد — تخطيت المزامنة.")
        return 0
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode != 0:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        git("commit", "-q", "-m", f"vault sync {stamp}")
    pull = git("pull", "-q", "--rebase", "--autostash")
    if pull.returncode != 0:
        git("rebase", "--abort")
        print("فشل pull:", pull.stderr.strip())
        return 1
    push = git("push", "-q")
    if push.returncode != 0:
        print("فشل push:", push.stderr.strip())
        return 1
    print("تمت المزامنة.")
    return 0


# ---------- نيكست الكبير ----------

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


def run_claude(rel, body):
    prompt = f"""أنت نيكست الكبير. وصلك طلب صوتي من الوليد عبر نيكست الصوتي، محفوظ في `{rel}`:

{body.strip()}

- اقرأ CLAUDE.md و`_System/soul.md` و`_System/user.md`. لمصادر واتساب والشيتات اتبع قسم «المصادر» في `_System/Telegram Assistant/CLAUDE.md`.
- نفّذ الطلب. مسموح دون تأكيد: القراءة والتحليل، وإضافة مهام Microsoft To Do عبر Zapier، وإضافة بنود في `_System/Open Loops.md`، وتعديل ملفات الـ Vault بقواعدها.
- ممنوع دون تأكيد: إرسال أي رسالة أو إيميل، وتعديل أي شيت، وأي تغيير خارجي آخر. اذكره في آخر ردك تحت «يحتاج تأكيدك:» ولا تنفّذه.
- لا تعدّل ملف الطلب نفسه؛ السكربت يكتب فيه ردك.
- ردك النهائي هو رسالة تيليجرام كما ستصل: فصحى، مختصرة، نقاط، أقل من 3000 حرف، بلا عناوين Markdown ولا جداول. ابدأه بـ «🎙️ ردّ على طلبك الصوتي:»."""
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


def publish(message):
    write_index(VAULT / INDEX_REL)
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode != 0:
        git("commit", "-q", "-m", message)
    git("pull", "-q", "--rebase", "--autostash")
    git("push", "-q")


def process_big_requests():
    # الطلبات القديمة: الماك كان مغلقاً — نسأل أولاً، وينفّذها نيكست تيليجرام إن وافق
    for path, meta, body in big_requests("pending"):
        if age_minutes(meta) <= STALE_MIN:
            continue
        tg_send(
            f"🎙️ طلبتَ في مكالمة نيكست الصوتي ({meta.get('created', '؟')}):\n\n{body.strip()[:1500]}\n\n"
            f"لم يُنفَّذ لأن الماك كان مغلقاً. هل ما زلت تريده؟ ردّ «نعم» أو «لا».\n(الملف: {path.name})"
        )
        set_fields(path, status="awaiting_confirmation")
        log("سُئل عن طلب قديم:", path.name)
    publish("voice: stale requests")

    # طلب حديث واحد في كل دورة
    fresh = [r for r in big_requests("pending") if age_minutes(r[1]) <= STALE_MIN]
    if not fresh:
        return
    path, meta, body = fresh[0]
    rel = path.relative_to(VAULT).as_posix()
    set_fields(path, status="working")
    publish("voice: working on request")
    log("ينفّذ:", path.name)
    try:
        answer = run_claude(rel, body)
    except Exception as e:  # noqa: BLE001 — أي فشل يُبلَّغ للوليد ولا يوقف المزامنة
        set_fields(path, status="failed")
        with path.open("a", encoding="utf-8") as f:
            f.write(f"\n## فشل التنفيذ\n{e}\n")
        publish("voice: request failed")
        tg_send(f"⚠️ لم أستطع تنفيذ طلبك الصوتي ({path.name}): {str(e)[:300]}")
        log("فشل:", e)
        return
    set_fields(path, status="answered", answered=datetime.now().strftime("%Y-%m-%d %H:%M"))
    with path.open("a", encoding="utf-8") as f:
        f.write(f"\n## ردّ نيكست الكبير\n{answer}\n")
    publish("voice: request answered")
    tg_send(answer)
    log("أُرسل الرد:", path.name)


def main():
    args = sys.argv[1:]
    out = VAULT / INDEX_REL
    if "--out" in args:
        out = Path(args[args.index("--out") + 1])
    count, changed = write_index(out)
    print(f"الفهرس: {count} ملاحظة{' (محدّث)' if changed else ''} → {out}")
    if "--index-only" in args:
        return 0
    status = sync()
    if status == 0:
        try:
            process_big_requests()
        except Exception as e:  # noqa: BLE001
            log("خطأ في طلبات نيكست الكبير:", e)
    return status


if __name__ == "__main__":
    sys.exit(main())
