# dotpy-blog

A green-on-black, monospace blog. Terminal flavoured, no framework, no runtime
dependencies — Python's standard library, some CSS, and a 60-line Cloudflare
Worker for GitHub sign-in.

```
posts/          one markdown file per post (front matter + body)
theme/          html templates ({{placeholder}} substitution)
static/         style.css, editor.js, copied verbatim into dist/
editor.html     the writing page (built to dist/write.html)
worker/         Cloudflare Worker: CORS relay for GitHub's device flow
site.json       site URL, repo coordinates, OAuth client id
build.py        the generator
dist/           output (wiped and rebuilt every run)
```

## Build

```sh
python3 build.py            # writes dist/
python3 build.py --serve    # writes dist/ then serves it on :8788
python3 build.py --all      # include future-dated posts
```

Output includes the post pages, `feed.xml`, `sitemap.xml`, `robots.txt`,
`404.html`, `posts.json` (the manifest the editor reads), and
`static/config.js` (runtime config injected from `site.json`).

## Writing a post

A file in `posts/` named `YYYY-MM-DD-some-slug.md` becomes `/some-slug/`:

```markdown
---
title: Why a blog in 2026?
date: 2026-01-04
blurb: Optional one-line teaser for the index and feed.
---

Body text. Supports **bold**, *italic*, `code`, [links](/write.html),
lists, > quotes, --- rules and fenced code blocks.
```

Add `draft: true` to keep it out of the build. Posts dated in the future are
treated as scheduled and skipped unless you pass `--all`.

## Publishing from the browser

`/write.html` is a `contenteditable` page that looks like the blog itself. It
autosaves to `localStorage` and has a front-matter bar (title, slug, date,
blurb, draft). **Publish** commits `posts/<date>-<slug>.md` straight to GitHub
via the Contents API; Cloudflare Pages then rebuilds the site.

- The slug is derived from the title unless you edit it.
- If the slug matches an existing post, the date and filename are adopted from
  it and publishing updates that file (using its blob `sha`).
- The status bar walks through `Saving… → Signed in → Publishing… → Committed —
  building (~1 min)`, then links to the new URL.
- `copy .md` / `download` still produce a complete file with front matter.

Sign-in uses GitHub's **device flow**: a code is shown, you enter it at
`github.com/login/device`. The token is kept in `localStorage` on this page
only. Sign out clears it.

## One-time setup

### 0. Repository

```sh
git init
git add .
git commit -m "dotpy-blog"
gh repo create dotpy-blog --public --source=. --push
```

`dist/` is gitignored — only `posts/`, the templates and the generator are
committed.

### 1. Domain

Register `dotpy.blog` (Namecheap, Porkbun, Cloudflare). Add the domain to
Cloudflare (free plan) and point its nameservers at the two Cloudflare gives
you. Wait until the zone shows **Active**.

### 2. GitHub OAuth App

Go to <https://github.com/settings/developers> → **New OAuth App**:

| field | value |
|---|---|
| Application name | `dotpy-blog writer` |
| Homepage URL | `https://dotpy.blog` |
| Authorization callback URL | `https://dotpy.blog/write.html` (unused, but required) |

Then, on the app page:

- tick **Enable Device Flow**
- leave **Expire user authorization tokens** unchecked (if enabled, tokens die
  after 8h and refreshing them needs the client secret, which a browser app
  must not hold)
- copy the **Client ID** into `site.json` → `oauth.client_id`

Scope requested at sign-in is `public_repo`. If you ever make the repo private,
change it to `repo` in `static/editor.js`.

### 3. Deploy the auth Worker

GitHub's `github.com/login/*` endpoints send no CORS headers, so the browser
can't call them directly. The Worker forwards the two calls and adds CORS. It
holds no secrets — the client id is public.

```sh
cd worker
npm install -g wrangler     # or use: npx wrangler
wrangler login
wrangler deploy
```

`wrangler.toml` binds it to `auth.dotpy.blog` as a custom domain, which creates
the DNS record automatically once the zone is active. Confirm the URL matches
`oauth.worker_url` in `site.json`.

Allowed origins live in `worker/auth.js` (`dotpy.blog`, `www`, and
`localhost:8080` / `localhost:8788` for local testing).

### 4. Cloudflare Pages

- **Create a project → Connect to Git** → pick this repo
- Framework preset: **None**
- Build command: `python3 build.py`
- Build output directory: `dist`
- Environment variable: `PYTHON_VERSION = 3.12`
- After the first deploy, **Custom domains** → add `dotpy.blog` and
  `www.dotpy.blog`

Every push to `main` — including the commits made by the publish button —
triggers a rebuild.

### 5. Local publishing test

```sh
python3 build.py --serve          # http://localhost:8788/write.html
```

The Worker allows `http://localhost:8788`, so sign-in and publishing work from
your machine against the real repo.

## Security notes

- The OAuth token lives in `localStorage` on `/write.html`. Don't add
  third-party scripts to that page.
- The token only has `public_repo` scope and can be revoked at
  <https://github.com/settings/applications>.
- `site.json` contains only public values; it is safe to commit.

## Troubleshooting

| symptom | cause |
|---|---|
| `set oauth.client_id and oauth.worker_url in site.json` | step 2/3 not finished, or you didn't rebuild after editing `site.json` |
| sign-in hangs on `waiting for github…` | device flow not enabled on the OAuth App, or wrong `worker_url` |
| `Publish failed — Not Found` | wrong `repo.owner` / `repo.name`, or the token lacks write access |
| CORS error on `auth.dotpy.blog` | your origin isn't in `ALLOWED_ORIGINS` in `worker/auth.js` |
| post commits but the site doesn't change | Cloudflare Pages build failed — check the deployment log; it's usually `PYTHON_VERSION` |
