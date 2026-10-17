#!/usr/bin/env python3
"""dotpy-blog: a zero-dependency static generator for a terminal-flavoured blog.

    python3 build.py            # build into dist/
    python3 build.py --serve    # build, then serve dist/ on :8788
    python3 build.py --all      # include future-dated (scheduled) posts
"""

from __future__ import annotations

import argparse
import html
import http.server
import json
import os
import re
import shutil
import socketserver
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from email.utils import format_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POSTS = ROOT / "posts"
THEME = ROOT / "theme"
STATIC = ROOT / "static"
WORKER = ROOT / "worker"
DIST = ROOT / "dist"

DEFAULT_SITE = {
    "site_url": "https://dotpy.blog",
    "title": "DOTPY BLOG",
    "tagline": "Notes written by a human, typed by hand, rendered by a script.",
    "author": "",
    "repo": {"owner": "", "name": "", "branch": "main"},
    "oauth": {"client_id": "", "worker_url": ""},
}

NOT_FOUND_BODY = """<a class="brand" href="/">DOTPY BLOG</a>
<div class="rule"></div>

<article class="doc">
<h1 class="post-title">404</h1>
<p>There is nothing at this address.</p>
<p><a href="/">go back to the index</a></p>
</article>
"""


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

def load_site() -> dict:
    site = json.loads(json.dumps(DEFAULT_SITE))
    cfg = ROOT / "site.json"
    if cfg.exists():
        try:
            loaded = json.loads(cfg.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"site.json is not valid JSON: {exc}") from exc
        for key, value in loaded.items():
            if isinstance(value, dict) and isinstance(site.get(key), dict):
                site[key].update(value)
            else:
                site[key] = value
    site["site_url"] = str(site["site_url"]).rstrip("/")
    return site


# --------------------------------------------------------------------------- #
# inline markdown
# --------------------------------------------------------------------------- #

def _inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    out = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        r'<a href="\2" rel="noopener">\1</a>',
        out,
    )
    return out


def render_markdown(src: str) -> str:
    lines = src.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    para: list[str] = []
    i = 0

    def flush() -> None:
        if para:
            out.append("<p>" + " ".join(para) + "</p>")
            para.clear()

    while i < len(lines):
        line = lines[i]

        if line.startswith("```"):
            flush()
            lang = line[3:].strip()
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            cls = f' class="language-{html.escape(lang)}"' if lang else ""
            out.append(
                f"<pre><code{cls}>" + html.escape("\n".join(buf)) + "</code></pre>"
            )
            continue

        stripped = line.strip()

        if not stripped:
            flush()
            i += 1
            continue

        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            flush()
            out.append("<hr>")
            i += 1
            continue

        m = re.match(r"(#{1,6})\s+(.*)", stripped)
        if m:
            flush()
            level = min(len(m.group(1)), 4)
            out.append(f"<h{level}>{_inline(m.group(2).strip())}</h{level}>")
            i += 1
            continue

        if stripped.startswith(">"):
            flush()
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + _inline(" ".join(buf)) + "</blockquote>")
            continue

        if re.match(r"[-*+]\s+", stripped):
            flush()
            items = []
            while i < len(lines) and re.match(r"[-*+]\s+", lines[i].strip()):
                items.append(_inline(lines[i].strip()[2:].strip()))
                i += 1
            out.append("<ul>" + "".join(f"<li>{x}</li>" for x in items) + "</ul>")
            continue

        if re.match(r"\d+[.)]\s+", stripped):
            flush()
            items = []
            while i < len(lines) and re.match(r"\d+[.)]\s+", lines[i].strip()):
                items.append(_inline(re.sub(r"^\d+[.)]\s+", "", lines[i].strip())))
                i += 1
            out.append("<ol>" + "".join(f"<li>{x}</li>" for x in items) + "</ol>")
            continue

        para.append(_inline(stripped))
        i += 1

    flush()
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# front matter + posts
# --------------------------------------------------------------------------- #

def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    meta: dict[str, str] = {}
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for raw in parts[1].strip().splitlines():
                if ":" in raw:
                    k, v = raw.split(":", 1)
                    meta[k.strip().lower()] = v.strip().strip('"').strip("'")
            return meta, parts[2].lstrip("\n")
    return meta, text


def slug_for(path: Path) -> str:
    name = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", path.stem)
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def human_date(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%d %b %Y").upper()
    except ValueError:
        return value.upper()


def iso_date(value: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return value
    except ValueError:
        return date.today().isoformat()


def rfc822(value: str) -> str:
    try:
        dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        dt = datetime.now(timezone.utc)
    return format_datetime(dt)


def word_count(text: str) -> int:
    return len(re.findall(r"\S+", text))


def plain(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"[#>*_`\[\]()!-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class Post:
    def __init__(self, path: Path):
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_front_matter(raw)
        self.slug = slug_for(path)
        self.source = path.name
        self.title = meta.get("title") or self.slug.replace("-", " ").title()
        self.date = iso_date(meta.get("date", date.today().isoformat()))
        self.blurb = meta.get("blurb", "")
        self.draft = meta.get("draft", "false").lower() in {"true", "yes", "1"}
        self.body_md = body
        self.html = render_markdown(body)
        self.words = word_count(plain(body))
        self.description = self.blurb or plain(body)[:155]

    @property
    def path(self) -> str:
        return f"/{self.slug}/"

    def url(self, site_url: str) -> str:
        return f"{site_url}{self.path}"


def collect_posts(include_future: bool) -> tuple[list[Post], list[Post]]:
    today = date.today().isoformat()
    all_posts = [
        Post(p) for p in sorted(POSTS.glob("*.md")) if p.name.lower() != "readme.md"
    ]
    published = [p for p in all_posts if not p.draft]
    skipped = [p for p in published if p.date > today]
    if not include_future:
        published = [p for p in published if p.date <= today]
    published.sort(key=lambda p: p.date, reverse=True)
    return published, skipped


# --------------------------------------------------------------------------- #
# build helpers
# --------------------------------------------------------------------------- #

def render(template: str, ctx: dict[str, str]) -> str:
    def sub(m: re.Match[str]) -> str:
        return str(ctx.get(m.group(1), ""))

    return re.sub(r"\{\{(\w+)\}\}", sub, template)


def write_feed(path: Path, site: dict, posts: list[Post]) -> None:
    ET.register_namespace("atom", "http://www.w3.org/2005/Atom")
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = site["title"]
    ET.SubElement(channel, "link").text = site["site_url"] + "/"
    ET.SubElement(channel, "description").text = site["tagline"]
    ET.SubElement(channel, "language").text = "en"
    if site["author"]:
        ET.SubElement(channel, "managingEditor").text = site["author"]
    ET.SubElement(
        channel,
        "{http://www.w3.org/2005/Atom}link",
        {
            "href": f"{site['site_url']}/feed.xml",
            "rel": "self",
            "type": "application/rss+xml",
        },
    )
    for post in posts:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = post.title
        ET.SubElement(item, "link").text = post.url(site["site_url"])
        ET.SubElement(item, "guid", {"isPermaLink": "true"}).text = post.url(
            site["site_url"]
        )
        ET.SubElement(item, "pubDate").text = rfc822(post.date)
        ET.SubElement(item, "description").text = post.description

    ET.indent(rss, space="  ")
    body = ET.tostring(rss, encoding="unicode", xml_declaration=False)
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n", encoding="utf-8"
    )


def write_sitemap(path: Path, site: dict, posts: list[Post]) -> None:
    urlset = ET.Element(
        "urlset", {"xmlns": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    )
    for loc, lastmod in [(site["site_url"] + "/", None)] + [
        (p.url(site["site_url"]), p.date) for p in posts
    ]:
        node = ET.SubElement(urlset, "url")
        ET.SubElement(node, "loc").text = loc
        if lastmod:
            ET.SubElement(node, "lastmod").text = lastmod
    ET.indent(urlset, space="  ")
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + ET.tostring(urlset, encoding="unicode")
        + "\n",
        encoding="utf-8",
    )


def write_posts_json(path: Path, site: dict, posts: list[Post]) -> None:
    payload = [
        {
            "slug": p.slug,
            "title": p.title,
            "date": p.date,
            "blurb": p.blurb,
            "words": p.words,
            "source": p.source,
            "url": p.url(site["site_url"]),
        }
        for p in posts
    ]
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_runtime_config(path: Path, site: dict) -> None:
    payload = {
        "site_url": site["site_url"],
        "title": site["title"],
        "repo": site["repo"],
        "oauth": site["oauth"],
    }
    path.write_text(
        "window.DOTPY_CONFIG = " + json.dumps(payload, indent=2) + ";\n",
        encoding="utf-8",
    )


# --------------------------------------------------------------------------- #
# build
# --------------------------------------------------------------------------- #

def build(include_future: bool = False) -> tuple[list[Post], list[Post]]:
    site = load_site()
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "static").mkdir(parents=True)
    for asset in STATIC.iterdir():
        if asset.is_file():
            shutil.copy2(asset, DIST / "static" / asset.name)

    base = (THEME / "base.html").read_text(encoding="utf-8")
    index_t = (THEME / "index.html").read_text(encoding="utf-8")
    post_t = (THEME / "post.html").read_text(encoding="utf-8")
    editor_src = ROOT / "editor.html"

    posts, skipped = collect_posts(include_future)

    write_runtime_config(DIST / "static" / "config.js", site)
    write_posts_json(DIST / "posts.json", site, posts)
    write_feed(DIST / "feed.xml", site, posts)
    write_sitemap(DIST / "sitemap.xml", site, posts)
    (DIST / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {site['site_url']}/sitemap.xml\n",
        encoding="utf-8",
    )
    (DIST / ".nojekyll").write_text("", encoding="utf-8")

    items = []
    for p in posts:
        items.append(
            "<li>\n"
            f'  <div class="meta">{human_date(p.date)}</div>\n'
            f'  <a class="headline" href="{p.slug}/">{html.escape(p.title)}</a>\n'
            + (f'  <div class="blurb">{_inline(p.blurb)}</div>\n' if p.blurb else "")
            + "</li>"
        )

    index_body = render(
        index_t,
        {
            "root": "",
            "tagline": _inline(site["tagline"]),
            "posts": "\n".join(items) or '<li class="blurb">no posts yet.</li>',
            "count": str(len(posts)),
            "built": date.today().isoformat(),
        },
    )
    index_html = render(
        base,
        {
            "title": site["title"],
            "description": html.escape(site["tagline"]),
            "root": "",
            "canonical": site["site_url"] + "/",
            "content": index_body,
            "state": "Saved dotpy.md",
            "words": f"{sum(p.words for p in posts)} Words",
        },
    )
    (DIST / "index.html").write_text(index_html, encoding="utf-8")

    for p in posts:
        body = render(
            post_t,
            {
                "root": "../",
                "post_title": html.escape(p.title.upper()),
                "body": p.html,
                "date_human": human_date(p.date),
            },
        )
        page = render(
            base,
            {
                "title": f"{p.title} — {site['title']}",
                "description": html.escape(p.description),
                "root": "../",
                "canonical": p.url(site["site_url"]),
                "content": body,
                "state": f"Saved {p.source}",
                "words": f"{p.words} Words",
            },
        )
        target = DIST / p.slug
        target.mkdir(parents=True, exist_ok=True)
        (target / "index.html").write_text(page, encoding="utf-8")

    notfound = render(
        base,
        {
            "title": f"404 — {site['title']}",
            "description": "Not found.",
            "root": "/",
            "canonical": site["site_url"] + "/404.html",
            "content": NOT_FOUND_BODY,
            "state": "Saved dotpy.md",
            "words": "0 Words",
        },
    )
    (DIST / "404.html").write_text(notfound, encoding="utf-8")

    if editor_src.exists():
        editor = editor_src.read_text(encoding="utf-8")
        (DIST / "write.html").write_text(
            render(editor, {"root": "", "tagline": site["tagline"]}), encoding="utf-8"
        )

    return posts, skipped


def serve(port: int) -> None:
    os.chdir(DIST)
    handler = http.server.SimpleHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), handler) as httpd:
        print(f"serving dist/ at http://localhost:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="build the dotpy blog")
    ap.add_argument("--serve", action="store_true", help="serve dist/ afterwards")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument(
        "--all",
        action="store_true",
        help="include future-dated posts (normally treated as scheduled)",
    )
    args = ap.parse_args()

    built, skipped = build(include_future=args.all)
    print(f"built {len(built)} post(s) into {DIST}/")
    for p in built:
        print(f"  · {p.slug:<28} {p.words:>5} words  {p.date}")
    for p in skipped:
        print(f"  · scheduled (skipped): {p.slug}  {p.date}")
    if args.serve:
        serve(args.port)
