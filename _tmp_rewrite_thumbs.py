# -*- coding: utf-8 -*-
import json
import re
from pathlib import Path
from urllib.parse import urlparse

STYLES = Path(__file__).resolve().parent / "styles"
SAMPLES = STYLES / "samples"
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(name: str) -> str:
    s = (name or "unnamed").strip().replace(" ", "_")
    s = INVALID.sub("", s)
    s = re.sub(r"_+", "_", s).strip("._")
    return s or "unnamed"


def ext_from_url(url: str) -> str:
    suf = Path(urlparse(url).path).suffix.lower()
    return suf if suf in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"} else ".png"


def main() -> None:
    samples_count = sum(
        1 for p in SAMPLES.iterdir() if p.is_file() and ".part" not in p.name
    )
    print(f"samples_on_disk={samples_count}", flush=True)
    rewritten = mapped = left = 0
    for jp in sorted(STYLES.glob("*.json")):
        data = json.loads(jp.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        changed = False
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            thumb = item.get("thumbnail")
            if not isinstance(thumb, str) or not thumb.strip().lower().startswith("http"):
                continue
            url = thumb.strip()
            base = safe_name(str(item.get("name", f"item_{i}")))
            ext = ext_from_url(url)
            dest = SAMPLES / (base + ext)
            if not (dest.exists() and dest.stat().st_size > 0):
                # ASCII-folded fallback used by downloader on UnicodeEncodeError
                import unicodedata

                ascii_base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode("ascii")
                ascii_base = safe_name(ascii_base) or "unnamed"
                alt = SAMPLES / (ascii_base + ext)
                if alt.exists() and alt.stat().st_size > 0:
                    dest = alt
            if dest.exists() and dest.stat().st_size > 0:
                rel = f"samples/{dest.name}"
                if item.get("thumbnail") != rel:
                    item["thumbnail"] = rel
                    changed = True
                mapped += 1
            else:
                left += 1
        if changed:
            jp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            rewritten += 1
            print(f"updated {jp.name}", flush=True)
    print(f"mapped={mapped}", flush=True)
    print(f"left_http={left}", flush=True)
    print(f"json_rewritten={rewritten}", flush=True)
    lazy = json.loads((STYLES / "lazy_功能.json").read_text(encoding="utf-8"))
    q = SAMPLES / "quad_view.png"
    print(
        f"lazy_ok={lazy[0]['name']} thumb={lazy[0]['thumbnail']} quad_exists={q.exists()}",
        flush=True,
    )


if __name__ == "__main__":
    main()
