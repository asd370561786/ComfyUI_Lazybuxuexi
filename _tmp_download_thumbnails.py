# -*- coding: utf-8 -*-
"""Temporary script: download HTTP thumbnails from styles/*.json into styles/samples/."""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

STYLES_DIR = Path(__file__).resolve().parent / "styles"
SAMPLES_DIR = STYLES_DIR / "samples"
TIMEOUT = 8
MAX_WORKERS = 6
RETRIES = 2
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(name: str) -> str:
    s = (name or "unnamed").strip().replace(" ", "_")
    # Keep unicode letters (e.g. Chinese / accented) but strip Windows-illegal chars.
    s = INVALID_CHARS.sub("", s)
    s = re.sub(r"_+", "_", s).strip("._")
    return s or "unnamed"


def ascii_fallback_name(name: str) -> str:
    """ASCII-only variant for stubborn filesystem/codec edge cases."""
    s = unicodedata.normalize("NFKD", name or "unnamed")
    s = s.encode("ascii", "ignore").decode("ascii")
    return safe_name(s) or "unnamed"


def is_http_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    v = value.strip().lower()
    return v.startswith("http://") or v.startswith("https://")


def ext_from_url(url: str) -> str:
    path = urlparse(url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}:
        return suffix
    return ".png"


def download_one(url: str, dest: Path) -> tuple[str, bool, str]:
    if dest.exists() and dest.stat().st_size > 0:
        return url, True, f"skip existing {dest.name}"

    # Prefer original dest; on UnicodeEncodeError fall back to ASCII filename.
    candidates = [dest]
    ascii_dest = dest.with_name(ascii_fallback_name(dest.stem) + dest.suffix)
    if ascii_dest != dest:
        candidates.append(ascii_dest)

    last_err = "unknown"
    for dest_try in candidates:
        if dest_try.exists() and dest_try.stat().st_size > 0:
            return url, True, f"skip existing {dest_try.name}"
        for attempt in range(1, RETRIES + 2):
            tmp = dest_try.with_suffix(dest_try.suffix + f".part{attempt}")
            try:
                req = Request(url, headers={"User-Agent": UA, "Accept": "image/*,*/*"})
                with urlopen(req, timeout=TIMEOUT) as resp:
                    data = resp.read()
                if not data:
                    last_err = "empty body"
                    time.sleep(0.2 * attempt)
                    continue
                SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
                tmp.write_bytes(data)
                tmp.replace(dest_try)
                return url, True, f"saved {dest_try.name} ({len(data)} bytes)"
            except UnicodeEncodeError as e:
                last_err = f"UnicodeEncodeError: {e}"
                try:
                    if tmp.exists():
                        tmp.unlink()
                except OSError:
                    pass
                break  # try ASCII fallback dest
            except Exception as e:
                last_err = f"{type(e).__name__}: {e}"
                try:
                    if tmp.exists():
                        tmp.unlink()
                except OSError:
                    pass
                time.sleep(0.3 * attempt)
    return url, False, last_err


def load_entries() -> list[tuple[Path, list]]:
    out: list[tuple[Path, list]] = []
    for jp in sorted(STYLES_DIR.glob("*.json")):
        try:
            data = json.loads(jp.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[WARN] cannot read {jp.name}: {e}", flush=True)
            continue
        if isinstance(data, list):
            out.append((jp, data))
    return out


def main() -> int:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    entries = load_entries()

    # Collect HTTP jobs: (json_path, index, url, dest)
    jobs: list[tuple[Path, int, str, Path]] = []
    for jp, data in entries:
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            thumb = item.get("thumbnail")
            if not is_http_url(thumb):
                continue
            url = str(thumb).strip()
            fname = safe_name(str(item.get("name", f"item_{i}"))) + ext_from_url(url)
            jobs.append((jp, i, url, SAMPLES_DIR / fname))

    print(f"Found {len(jobs)} HTTP thumbnail entries", flush=True)

    # Unique downloads by dest
    url_by_dest: dict[Path, str] = {}
    for _jp, _i, url, dest in jobs:
        url_by_dest.setdefault(dest, url)

    already = sum(1 for d in url_by_dest if d.exists() and d.stat().st_size > 0)
    todo = {d: u for d, u in url_by_dest.items() if not (d.exists() and d.stat().st_size > 0)}
    print(f"unique_dests={len(url_by_dest)} already={already} todo={len(todo)}", flush=True)

    download_ok = 0
    download_fail = 0
    fail_urls: set[str] = set()
    ok_dests: set[Path] = {d for d in url_by_dest if d.exists() and d.stat().st_size > 0}

    if todo:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            futs = {ex.submit(download_one, url, dest): (url, dest) for dest, url in todo.items()}
            done_n = 0
            total = len(futs)
            for fut in as_completed(futs):
                url, dest = futs[fut]
                _u, success, msg = fut.result()
                done_n += 1
                if success:
                    download_ok += 1
                    ok_dests.add(dest)
                    if "skip existing" not in msg:
                        print(f"[OK {done_n}/{total}] {dest.name}", flush=True)
                else:
                    download_fail += 1
                    fail_urls.add(url)
                    print(f"[FAIL {done_n}/{total}] {dest.name}: {msg}", flush=True)

    # Rewrite JSON thumbnails for any successful local files
    rewritten = 0
    mapped = 0
    left_http = 0
    for jp, data in entries:
        changed = False
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            thumb = item.get("thumbnail")
            if not is_http_url(thumb):
                continue
            url = str(thumb).strip()
            fname = safe_name(str(item.get("name", f"item_{i}"))) + ext_from_url(url)
            dest = SAMPLES_DIR / fname
            if dest.exists() and dest.stat().st_size > 0:
                rel = f"samples/{dest.name}"
                if item.get("thumbnail") != rel:
                    item["thumbnail"] = rel
                    changed = True
                mapped += 1
            else:
                left_http += 1
        if changed:
            jp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            rewritten += 1
            print(f"[OK] updated {jp.name}", flush=True)

    print("--- SUMMARY ---", flush=True)
    print(f"http_entries={len(jobs)}", flush=True)
    print(f"unique_dests={len(url_by_dest)}", flush=True)
    print(f"already_before={already}", flush=True)
    print(f"download_ok={download_ok}", flush=True)
    print(f"download_fail={download_fail}", flush=True)
    print(f"mapped_to_local={mapped}", flush=True)
    print(f"left_http={left_http}", flush=True)
    print(f"json_files_rewritten={rewritten}", flush=True)
    print(f"samples_on_disk={sum(1 for p in SAMPLES_DIR.iterdir() if p.is_file() and not p.name.endswith('.part'))}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
