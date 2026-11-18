#!/usr/bin/env python3
"""TL;DR Rater: collect headlines from every feed and write docs/headlines.json.

Standard library only (nothing to install) and no AI calls.

Steps: read feeds -> clean headlines -> rule filter (junk and video removed) ->
drop anything older than two days -> show repeated stories once -> pick a
balanced sample across sections -> write the file the app reads.
"""
import gzip
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

MAX_AGE_HOURS = 48       # headlines older than this are dropped
PER_FEED_CAP = 40        # newest N per feed, so one busy feed cannot flood a section
PER_SECTION = 60         # headlines per section in the output file
DESC_MAX = 240           # characters of description shown on a card
NEAR_DUP = 0.7           # word overlap above which two headlines count as the same story
TIMEOUT = 15

SECTION_ORDER = ["India", "World", "Bengaluru", "Hyderabad", "Business", "Sports", "Movies", "Tech/Science"]
# When the same article arrives through two sections, the more specific one wins.
SECTION_PRIORITY = ["Bengaluru", "Hyderabad", "Movies", "Sports", "Tech/Science", "Business", "India", "World"]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------
def now_utc():
    return datetime.now(timezone.utc)


def normalize_url(url):
    """Same rule as the reader app, so both apps give one article the same id."""
    p = urlsplit(url.strip())
    path = p.path.rstrip("/") or "/"
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), path, "", ""))


def make_id(url):
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:12]


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def clean_text(raw):
    """Feed text is often HTML, sometimes escaped twice. Return plain text."""
    if not raw:
        return ""
    text = html.unescape(html.unescape(raw))
    text = _TAG.sub(" ", text)
    return _WS.sub(" ", html.unescape(text)).strip()


def parse_date(text):
    if not text:
        return None
    text = text.strip()
    try:
        dt = parsedate_to_datetime(text)
    except Exception:
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except Exception:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def shorten(text, limit):
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:- ")
    return cut + "\u2026"


# ----------------------------------------------------------------------------
# Reading one feed (RSS 2.0, RSS 1.0 and Atom)
# ----------------------------------------------------------------------------
def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def parse_feed(body):
    """Return a list of raw entries: title, link, desc, date, source."""
    root = ET.fromstring(body)
    entries = []
    for node in root.iter():
        if _local(node.tag) not in ("item", "entry"):
            continue
        e = {"title": "", "link": "", "desc": "", "content": "", "date": None, "source": ""}
        for ch in node:
            if "mrss" in ch.tag or "itunes" in ch.tag:      # media:title etc. are not the headline
                continue
            name = _local(ch.tag)
            text = (ch.text or "").strip()
            if name == "title" and not e["title"]:
                e["title"] = text
            elif name == "link" and not e["link"]:
                href = ch.attrib.get("href")
                if href:
                    if ch.attrib.get("rel", "alternate") == "alternate":
                        e["link"] = href.strip()
                elif text:
                    e["link"] = text
            elif name in ("description", "summary") and not e["desc"]:
                e["desc"] = text
            elif name == "content" and not e["content"]:
                e["content"] = text
            elif name in ("pubdate", "published", "updated", "date") and e["date"] is None:
                e["date"] = parse_date(text)
            elif name == "source" and not e["source"]:
                e["source"] = text
        if e["title"] and e["link"]:
            entries.append(e)
    return entries


def fetch_feed(src):
    """Download and parse one feed. Returns (entries, error_text)."""
    try:
        req = urllib.request.Request(src["url"], headers=HEADERS)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        entries = parse_feed(body)
        return entries, ("" if entries else "parsed, but 0 items")
    except urllib.error.HTTPError as e:
        return [], f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return [], f"network: {str(e.reason)[:60]}"
    except ET.ParseError:
        return [], "not a feed (got a web page?)"
    except Exception as e:                       # one bad feed must never stop the run
        return [], f"{type(e).__name__}: {str(e)[:60]}"


def collect(sources, workers=12):
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(fetch_feed, sources))
    return {src["feed"]: res for src, res in zip(sources, results)}


# ----------------------------------------------------------------------------
# Rule filter: things that are never a news story. Video is dropped too.
# ----------------------------------------------------------------------------
def _r(pattern):
    return re.compile(pattern, re.IGNORECASE)


TITLE_RULES = [
    ("quiz", _r(r"\bquiz\b")),
    ("puzzle", _r(r"\b(crossword|sudoku)\b|\b(wordle|strands|connections|spelling bee)\b.*\b(hints?|answers?|clues?|solutions?)\b")),
    ("cartoon", _r(r"\bcartoon\b")),
    ("gallery", _r(r"\b(in pictures|photo gallery)\b|^(photos?|pics|in pics|in photos)\s*[:|\-]")),
    ("video", _r(r"^(watch|video)\s*[:|\-]|[|\-:]\s*(watch|video)\s*$|\bwatch video\b")),
    ("podcast", _r(r"\bpodcast\b")),
    ("live", _r(r"\b(live updates?|live blog|as it happened|live streaming|live telecast)\b|\blive (cricket |football )?(scores?|scorecard|commentary)\b"
                r"|\bfull scorecard\b|^live\s*[:|\-]|[|(\-:]\s*live\s*\)?\s*$")),
    ("digest", _r(r"\b(morning digest|evening wrap|daily briefing|news in numbers|top news of the day|newsletter)\b")),
    ("letters", _r(r"\bletters to the editor\b")),
    ("horoscope", _r(r"\b(horoscope|panchang|numerology)\b")),
    ("opinion", _r(r"^(opinion|editorial|op-ed|column)\s*[:|\-]")),
    ("listing", _r(r"\b(gold|silver|petrol|diesel) (rates?|prices?) today\b|\blottery (results?|sambad)\b|\bstocks? to (buy|watch)\b|\btarget (price )?of rs\b"
                   r"|\bshowtimes\b|\bairport (departures|arrivals)\b")),
    ("promo", _r(r"\b(promo codes?|discount codes?|coupon codes?|deals? of the day)\b")),
]
URL_RULES = [
    ("video", _r(r"/(videos?|watch)/")),
    ("gallery", _r(r"/(photos?|gallery|galleries|in-pictures|picture-gallery|web-?stories)/")),
    ("podcast", _r(r"/podcasts?/")),
    ("quiz", _r(r"/quiz")),
    ("puzzle", _r(r"/(crossword|puzzles?)/")),
    ("cartoon", _r(r"/cartoon")),
    ("live", _r(r"live-?(updates?|blog)|/live/")),
    ("horoscope", _r(r"/(horoscope|astrology)")),
    ("opinion", _r(r"/(opinions?|editorials?|op-ed|columns?|comment|commentisfree|blogs?)/")),
]


def filter_reason(title, url, is_gnews):
    for reason, rx in TITLE_RULES:
        if rx.search(title):
            return reason
    if not is_gnews:                    # Google News links point to Google, so only the title can be judged
        for reason, rx in URL_RULES:
            if rx.search(url):
                return reason
    return None


# ----------------------------------------------------------------------------
# Repeats
# ----------------------------------------------------------------------------
_STOP = set("the a an and or of to in on for with at by from as is are was were be been has have had will would "
            "its his her their this that after over into amid says said new not but you your".split())


_PUB_ALIAS = {"cricinfo": "espncricinfo", "livemint": "mint", "hindu businessline": "businessline",
              "bbc sport": "bbc", "ndtv sports": "ndtv", "ndtv profit": "ndtv"}


def pub_key(name):
    k = re.sub(r"^the\s+", "", name.lower().strip())
    k = re.sub(r"\.(com|in|co\.uk|org|net)$", "", k)
    k = re.sub(r"\s+(news|online)$", "", k)
    return _PUB_ALIAS.get(k, k)


def title_key(title):
    return re.sub(r"[^a-z0-9 ]+", "", title.lower()).strip()


def title_words(title):
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 2 and w not in _STOP}


def _better(a, b):
    """Which of two copies of a story to show: one with a description, then a publisher feed, then the newer."""
    ka = (bool(a["desc"]), a["src"] == "publisher", -SECTION_PRIORITY.index(a["section"]), a["published_at"])
    kb = (bool(b["desc"]), b["src"] == "publisher", -SECTION_PRIORITY.index(b["section"]), b["published_at"])
    return a if ka >= kb else b


def _merge(a, b):
    keep = _better(a, b)
    other = b if keep is a else a
    keep["_pubs"] = {**other["_pubs"], **keep["_pubs"]}
    if SECTION_PRIORITY.index(other["section"]) < SECTION_PRIORITY.index(keep["section"]):
        keep["section"] = other["section"]
    return keep


def dedupe(items):
    """1) same article id, 2) same headline text, 3) near-identical headline within a section."""
    merged = 0
    for key_fn in (lambda it: it["id"], lambda it: title_key(it["title"])):
        seen = {}
        for it in items:
            k = key_fn(it)
            if k in seen:
                seen[k] = _merge(seen[k], it)
                merged += 1
            else:
                seen[k] = it
        items = list(seen.values())

    out = []
    by_section = {}
    for it in items:
        by_section.setdefault(it["section"], []).append(it)
    for section_items in by_section.values():
        kept = []
        for it in section_items:
            words = title_words(it["title"])
            match = None
            if len(words) >= 4:
                for i, (other, other_words) in enumerate(kept):
                    if len(other_words) >= 4 and len(words & other_words) / len(words | other_words) >= NEAR_DUP:
                        match = i
                        break
            if match is None:
                kept.append((it, words))
            else:
                winner = _merge(kept[match][0], it)
                kept[match] = (winner, title_words(winner["title"]))
                merged += 1
        out.extend(it for it, _ in kept)
    return out, merged


# ----------------------------------------------------------------------------
# The pipeline (no network in here, so it can be tested with saved data)
# ----------------------------------------------------------------------------
def process(sources, raw_by_feed, now=None):
    now = now or now_utc()
    report = {"feeds": [], "dropped": {}, "dropped_sample": [], "too_old": 0}
    items = []

    for src in sources:
        entries, error = raw_by_feed.get(src["feed"], ([], "not fetched"))
        is_gnews = src["kind"] == "gnews"
        kept = []
        for e in entries:
            title = clean_text(e["title"])
            publisher = src["publisher"]
            if is_gnews:
                source_name = clean_text(e["source"])
                if source_name and title.endswith(" - " + source_name):
                    title = title[: -len(" - " + source_name)].strip()
                elif " - " in title and len(title.rsplit(" - ", 1)[1]) <= 40:
                    title, source_name = [s.strip() for s in title.rsplit(" - ", 1)]
                publisher = source_name or "Google News"
            if len(title) < 15:
                continue

            reason = filter_reason(title, e["link"], is_gnews)
            if reason:
                report["dropped"][reason] = report["dropped"].get(reason, 0) + 1
                if len(report["dropped_sample"]) < 80:
                    report["dropped_sample"].append({"reason": reason, "feed": src["feed"], "title": title[:110]})
                continue

            dt = e["date"] or now
            if dt > now:
                dt = now
            age_h = (now - dt).total_seconds() / 3600
            if age_h > MAX_AGE_HOURS:
                report["too_old"] += 1
                continue

            desc = "" if is_gnews else clean_text(e["desc"] or e["content"])
            if desc and (len(desc) < 40 or title_key(desc).startswith(title_key(title)[:60])):
                desc = ""                              # too short, or just the headline again
            kept.append({
                "id": make_id(e["link"]),
                "title": title,
                "desc": shorten(desc, DESC_MAX),
                "section": src["section"],
                "publisher": publisher,
                "feed": src["feed"],
                "src": src["kind"],
                "url": e["link"],
                "published_at": dt.isoformat(timespec="seconds"),
                "pub_key": pub_key(publisher),
                "_pubs": {pub_key(publisher): publisher},
            })
        kept.sort(key=lambda it: it["published_at"], reverse=True)
        kept = kept[:PER_FEED_CAP]
        items.extend(kept)
        report["feeds"].append({"feed": src["feed"], "section": src["section"], "ok": not error,
                                "raw": len(entries), "kept": len(kept), "error": error})

    after_filter = len(items)
    items, merged = dedupe(items)

    # Balanced sample: within a section take turns between feeds, newest first.
    chosen = {}
    available = {}
    for section in SECTION_ORDER:
        pool = [it for it in items if it["section"] == section]
        available[section] = len(pool)
        by_feed = {}
        for it in sorted(pool, key=lambda it: it["published_at"], reverse=True):
            by_feed.setdefault(it["feed"], []).append(it)
        queues = list(by_feed.values())
        picked = []
        while queues and len(picked) < PER_SECTION:
            for q in list(queues):
                if len(picked) >= PER_SECTION:
                    break
                picked.append(q.pop(0))
                if not q:
                    queues.remove(q)
        chosen[section] = picked

    # File order: take turns between sections so the app shows a mix.
    ordered = []
    queues = [list(chosen[s]) for s in SECTION_ORDER]
    while any(queues):
        for q in queues:
            if q:
                ordered.append(q.pop(0))

    for it in ordered:
        pubs = it.pop("_pubs")
        it["sources"] = len(pubs)
        it["also"] = sorted(name for key, name in pubs.items() if key != it["pub_key"])[:4]

    feeds_ok = sum(1 for f in report["feeds"] if f["ok"])
    output = {
        "generated_at": now.isoformat(timespec="seconds"),
        "count": len(ordered),
        "sections": {s: len(chosen[s]) for s in SECTION_ORDER},
        "feeds_ok": feeds_ok,
        "feeds_total": len(sources),
        "items": ordered,
    }
    report.update({
        "generated_at": output["generated_at"], "feeds_ok": feeds_ok, "feeds_total": len(sources),
        "after_filter": after_filter, "repeats_merged": merged, "available": available, "written": output["sections"],
    })
    return output, report


def main():
    t0 = time.time()
    here = Path(__file__).resolve().parent
    sources_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "sources.json"
    sources = json.loads(sources_path.read_text())
    raw = collect(sources)
    output, report = process(sources, raw)
    report["seconds"] = round(time.time() - t0, 1)

    print(f"feeds working: {report['feeds_ok']}/{report['feeds_total']}")
    for f in report["feeds"]:
        if not f["ok"]:
            print(f"  FAILED  {f['feed']}: {f['error']}")
    print(f"after filter: {report['after_filter']} | dropped by rule: {report['dropped']} | too old: {report['too_old']}"
          f" | repeats merged: {report['repeats_merged']}")
    print("available per section:", report["available"])
    print("written per section:  ", report["written"], "| total", output["count"])

    if output["count"] == 0:
        print("No headlines at all; leaving the existing file untouched.")
        sys.exit(1)

    docs = here / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "headlines.json").write_text(json.dumps(output, ensure_ascii=False, indent=1))
    (docs / "last_run.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"wrote docs/headlines.json in {report['seconds']}s")


if __name__ == "__main__":
    main()
