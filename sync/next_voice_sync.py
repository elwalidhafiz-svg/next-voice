#!/usr/bin/env python3
"""مزامنة الـ Vault مع GitHub لنيكست الصوتي.

1. يبني فهرساً للبحث في .next-voice/index.json (يقرؤه تطبيق الجوال).
2. إن كان الـ Vault مستودع git له remote: commit ثم pull --rebase ثم push.

الاستخدام:
  python3 next_voice_sync.py                 # فهرس + مزامنة
  python3 next_voice_sync.py --index-only    # فهرس فقط
  python3 next_voice_sync.py --index-only --out <ملف>
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

VAULT = Path.home() / "Documents" / "My Vault"
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


def main():
    args = sys.argv[1:]
    out = VAULT / INDEX_REL
    if "--out" in args:
        out = Path(args[args.index("--out") + 1])
    count, changed = write_index(out)
    print(f"الفهرس: {count} ملاحظة{' (محدّث)' if changed else ''} → {out}")
    if "--index-only" in args:
        return 0
    return sync()


if __name__ == "__main__":
    sys.exit(main())
