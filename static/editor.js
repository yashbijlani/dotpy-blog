(() => {
  const CFG = window.DOTPY_CONFIG || {};
  const REPO = CFG.repo || {};
  const OAUTH = CFG.oauth || {};
  const API = "https://api.github.com";

  const K = {
    draft: "dotpy-blog:draft",
    meta: "dotpy-blog:meta",
    token: "dotpy-blog:token",
    user: "dotpy-blog:user",
  };

  const $ = (id) => document.getElementById(id);
  const editor = $("editor");
  const state = $("state");
  const words = $("words");
  const who = $("who");
  const note = $("note");
  const device = $("device");
  const deviceCode = $("device-code");
  const deviceState = $("device-state");
  const fTitle = $("f-title");
  const fSlug = $("f-slug");
  const fDate = $("f-date");
  const fBlurb = $("f-blurb");
  const fDraft = $("f-draft");
  const btnPublish = $("publish");
  const btnSignin = $("signin");
  const btnSignout = $("signout");

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    },
  };

  const SEED = [
    "<h1>Why a blog in 2026?</h1>",
    "<p>This whole blog can be generated with a prompt under a second but yet I feel like its more important than ever to write about things using a human brain now &amp; share it with the world so I'm starting a blog.</p>",
    "<h2>First post</h2>",
    "<p>A lot of software engineering is almost dead and its fine. They were writing the same code over and over again anyways.</p>",
    "<p>A lot of jobs like HRs, accountants, lawyers, etc will be gone too, but why are people so attached to them? Those jobs have only been here for a couple years &amp; it's not like anyone's life purpose is to balance the books.</p>",
    "<p>What's next? Nobody has a clue, only guesses.</p>",
  ].join("\n");

  let manifest = [];
  let slugTouched = false;
  let dateTouched = false;

  // ---------------------------------------------------------------- markdown

  const inline = (node) => {
    let out = "";
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const t = inline(n);
        const tag = n.tagName.toLowerCase();
        if (tag === "strong" || tag === "b") out += `**${t}**`;
        else if (tag === "em" || tag === "i") out += `*${t}*`;
        else if (tag === "code") out += `\`${t}\``;
        else if (tag === "a") out += `[${t}](${n.getAttribute("href") || ""})`;
        else if (tag === "br") out += "\n";
        else out += t;
      }
    });
    return out;
  };

  const block = (node) => {
    const tag = node.tagName.toLowerCase();
    const text = inline(node).trim();
    if (!text) return "";
    if (/^h[1-6]$/.test(tag)) return "#".repeat(+tag[1]) + " " + text + "\n\n";
    if (tag === "blockquote")
      return text.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    if (tag === "ul")
      return [...node.children].map((li) => "- " + inline(li).trim()).join("\n") + "\n\n";
    if (tag === "ol")
      return [...node.children]
        .map((li, i) => `${i + 1}. ` + inline(li).trim())
        .join("\n") + "\n\n";
    if (tag === "pre") return "```\n" + node.innerText.replace(/\n$/, "") + "\n```\n\n";
    if (tag === "hr") return "---\n\n";
    return text + "\n\n";
  };

  const toMarkdown = (skipTitle) => {
    let md = "";
    Array.from(editor.childNodes).forEach((n, i) => {
      if (n.nodeType === Node.TEXT_NODE) {
        md += n.textContent.trim() + "\n\n";
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (skipTitle && i === 0 && n.tagName.toLowerCase() === "h1") return;
      md += block(n);
    });
    return md.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  };

  // ---------------------------------------------------------------- meta

  const slugify = (s) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const docTitle = () => {
    const h1 = editor.querySelector("h1");
    return h1 ? h1.textContent.trim() : "";
  };

  const autoSlug = () => {
    if (slugTouched && fSlug.value.trim()) return;
    fSlug.value = slugify(fTitle.value || docTitle());
  };

  const touchSlug = () => {
    slugTouched = fSlug.value.trim().length > 0;
    if (!slugTouched) autoSlug();
  };

  const readMeta = () => ({
    title: (fTitle.value || docTitle() || "Untitled").trim(),
    slug: slugify(fSlug.value || docTitle() || "untitled"),
    date: fDate.value || new Date().toISOString().slice(0, 10),
    blurb: fBlurb.value.trim(),
    draft: fDraft.checked,
  });

  const mateMeta = () => {
    const m = readMeta();
    const hit = manifest.find((p) => p.slug === m.slug);
    if (hit) {
      if (!dateTouched) fDate.value = hit.date;
      note.textContent = `overwrites posts/${hit.source}`;
      note.classList.remove("error");
      return;
    }
    if (!dateTouched && fDate.dataset.today) fDate.value = fDate.dataset.today;
    note.textContent = m.draft ? "draft — will not be built" : "";
    note.classList.remove("error");
  };

  // ---------------------------------------------------------------- status

  const setState = (text, busy) => {
    state.textContent = text;
    state.classList.toggle("dirty", !!busy);
  };

  const say = (text, isError) => {
    note.textContent = text || "";
    note.classList.toggle("error", !!isError);
  };

  const countWords = () => {
    const text = editor.innerText.replace(/\s+/g, " ").trim();
    return text ? text.split(" ").length : 0;
  };

  const paint = () => {
    words.textContent = `${countWords()} Words`;
  };

  // ---------------------------------------------------------------- saving

  let timer = null;

  const saveLocal = () => {
    store.set(K.draft, editor.innerHTML);
    store.set(
      K.meta,
      JSON.stringify({
        title: fTitle.value,
        slug: fSlug.value,
        date: fDate.value,
        blurb: fBlurb.value,
        draft: fDraft.checked,
        slugTouched,
      })
    );
    setState(`Saved ${readMeta().slug || "draft"}.md`);
  };

  const schedule = () => {
    setState("Saving…", true);
    clearTimeout(timer);
    timer = setTimeout(saveLocal, 450);
  };

  // ---------------------------------------------------------------- auth

  let token = store.get(K.token) || "";
  let polling = false;

  const form = (obj) => new URLSearchParams(obj).toString();

  const signedIn = (login) => {
    who.textContent = login ? `· ${login}` : "";
    btnSignin.hidden = !!login;
    btnSignout.hidden = !login;
    if (login) setState(`Signed in as ${login}`);
  };

  const api = async (method, path, body) => {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { message: text };
    }
    return { ok: res.ok, status: res.status, data };
  };

  const relay = async (path, payload) => {
    if (!OAUTH.worker_url || !OAUTH.client_id) {
      throw new Error("set oauth.client_id and oauth.worker_url in site.json");
    }
    const res = await fetch(OAUTH.worker_url.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form(payload),
    });
    return res.json();
  };

  const signOut = () => {
    token = "";
    polling = false;
    store.del(K.token);
    store.del(K.user);
    device.hidden = true;
    signedIn("");
    say("");
    setState("Signed out");
  };

  const signIn = async (thenPublish) => {
    if (token) {
      if (thenPublish) publish();
      return;
    }
    device.hidden = false;
    deviceCode.textContent = "————";
    deviceState.textContent = "requesting a code…";
    setState("Signing in…", true);

    let start;
    try {
      start = await relay("/device/code", {
        client_id: OAUTH.client_id,
        scope: "public_repo",
      });
    } catch (err) {
      deviceState.textContent = err.message;
      setState("Sign-in failed");
      return;
    }
    if (!start.device_code) {
      deviceState.textContent = start.error_description || start.error || "no device code";
      setState("Sign-in failed");
      return;
    }

    deviceCode.textContent = start.user_code;
    deviceState.textContent = "waiting for github…";
    setState(`Code ${start.user_code}`, true);

    const deadline = Date.now() + (start.expires_in || 900) * 1000;
    let wait = (start.interval || 5) * 1000;
    polling = true;

    while (polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      if (!polling) return;
      let poll;
      try {
        poll = await relay("/access_token", {
          client_id: OAUTH.client_id,
          device_code: start.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      } catch (err) {
        deviceState.textContent = err.message;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (poll.access_token) {
        token = poll.access_token;
        store.set(K.token, token);
        const me = await api("GET", "/user");
        const login = me.data?.login || "you";
        store.set(K.user, login);
        polling = false;
        device.hidden = true;
        signedIn(login);
        if (thenPublish) publish();
        return;
      }
      if (poll.error === "slow_down") wait += 5000;
      if (poll.error === "authorization_pending") continue;
      if (poll.error) {
        deviceState.textContent = poll.error_description || poll.error;
        polling = false;
        setState("Sign-in failed");
        return;
      }
    }
    if (polling) {
      deviceState.textContent = "code expired — try again";
      polling = false;
      setState("Sign-in expired");
    }
  };

  // ---------------------------------------------------------------- publish

  const toBase64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + size));
    }
    return btoa(bin);
  };

  const buildFile = (m) => {
    const fm = ["---", `title: ${m.title}`, `date: ${m.date}`];
    if (m.blurb) fm.push(`blurb: ${m.blurb}`);
    if (m.draft) fm.push("draft: true");
    fm.push("---", "");
    return fm.join("\n") + "\n" + toMarkdown(true) + "\n";
  };

  const publish = async () => {
    if (!token) return signIn(true);
    if (!REPO.owner || !REPO.name) return say("set repo.owner and repo.name in site.json", true);

    const m = readMeta();
    if (!m.title || m.title === "Untitled") return say("give the post a title first", true);

    const hit = manifest.find((p) => p.slug === m.slug);
    const path = `posts/${hit ? hit.source : `${m.date}-${m.slug}.md`}`;
    const branch = REPO.branch || "main";
    const url = `/repos/${REPO.owner}/${REPO.name}/contents/${path}`;

    btnPublish.disabled = true;
    setState("Publishing…", true);
    say("");

    const content = toBase64(buildFile(m));
    const message = `${hit ? "update" : "post"}: ${m.title}`;

    const put = (sha) =>
      api("PUT", url, {
        message,
        content,
        branch,
        ...(sha ? { sha } : {}),
      });

    let sha;
    if (hit) {
      const existing = await api("GET", `${url}?ref=${branch}`);
      sha = existing.data?.sha;
    }

    let res = await put(sha);

    if (res.status === 422 || res.status === 409) {
      const existing = await api("GET", `${url}?ref=${branch}`);
      if (existing.ok && existing.data?.sha) res = await put(existing.data.sha);
    }

    if (!res.ok) {
      btnPublish.disabled = false;
      setState("Publish failed");
      say(res.data?.message || `github said ${res.status}`, true);
      return;
    }

    btnPublish.disabled = false;
    setState("Committed — building (~1 min)", true);
    const live = `${(CFG.site_url || "").replace(/\/$/, "")}/${m.slug}/`;
    say("");
    note.classList.remove("error");
    note.innerHTML = `committed ${path} — <a href="${live}" target="_blank" rel="noopener">${live}</a>`;

    if (!hit) manifest.push({ slug: m.slug, source: path.split("/").pop(), date: m.date, title: m.title });
  };

  // ---------------------------------------------------------------- wiring

  editor.addEventListener("input", () => {
    const t = docTitle();
    if (t) fTitle.value = t;
    autoSlug();
    mateMeta();
    paint();
    schedule();
  });

  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  fTitle.addEventListener("input", () => {
    let h1 = editor.querySelector("h1");
    if (!h1) {
      h1 = document.createElement("h1");
      editor.insertBefore(h1, editor.firstChild);
    }
    h1.textContent = fTitle.value;
    autoSlug();
    mateMeta();
    schedule();
  });

  fSlug.addEventListener("input", () => {
    touchSlug();
    mateMeta();
    schedule();
  });

  [fDate, fBlurb, fDraft].forEach((el) =>
    el.addEventListener("input", () => {
      if (el === fDate) dateTouched = true;
      mateMeta();
      schedule();
    })
  );

  btnPublish.addEventListener("click", publish);
  btnSignin.addEventListener("click", () => signIn(false));
  btnSignout.addEventListener("click", signOut);

  $("new").addEventListener("click", () => {
    editor.innerHTML = "";
    fTitle.value = "";
    fSlug.value = "";
    fBlurb.value = "";
    fDraft.checked = false;
    slugTouched = false;
    editor.focus();
    mateMeta();
    paint();
    schedule();
  });

  $("wipe").addEventListener("click", () => {
    if (!confirm("wipe the local draft?")) return;
    editor.innerHTML = "";
    [K.draft, K.meta].forEach(store.del);
    fTitle.value = "";
    fSlug.value = "";
    fBlurb.value = "";
    fDraft.checked = false;
    slugTouched = false;
    editor.focus();
    mateMeta();
    paint();
    setState("Saved draft.md");
  });

  $("copy").addEventListener("click", async () => {
    const btn = $("copy");
    try {
      await navigator.clipboard.writeText(buildFile(readMeta()));
      btn.textContent = "copied";
    } catch (e) {
      btn.textContent = "failed";
    }
    setTimeout(() => (btn.textContent = "copy .md"), 1200);
  });

  $("download").addEventListener("click", () => {
    const m = readMeta();
    const blob = new Blob([buildFile(m)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${m.date}-${m.slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  window.addEventListener("beforeunload", () => {
    clearTimeout(timer);
    saveLocal();
  });

  // ---------------------------------------------------------------- boot

  const boot = async () => {
    fDate.dataset.today = new Date().toISOString().slice(0, 10);
    fDate.value = fDate.dataset.today;

    try {
      const meta = JSON.parse(store.get(K.meta) || "{}");
      if (meta.date) {
        fDate.value = meta.date;
        if (meta.date !== fDate.dataset.today) dateTouched = true;
      }
      if (meta.title) fTitle.value = meta.title;
      if (meta.slug) fSlug.value = meta.slug;
      if (meta.blurb) fBlurb.value = meta.blurb;
      fDraft.checked = !!meta.draft;
      slugTouched = !!meta.slugTouched;
    } catch (e) {}

    editor.innerHTML = store.get(K.draft) || SEED;
    if (!fTitle.value) fTitle.value = docTitle();
    autoSlug();
    paint();
    setState(`Saved ${readMeta().slug || "draft"}.md`);
    mateMeta();

    const login = store.get(K.user);
    if (token && login) {
      signedIn(login);
      api("GET", "/user").then((r) => {
        if (r.ok) signedIn(r.data.login);
        else signOut();
      });
    } else {
      signedIn("");
    }

    try {
      const base = document.querySelector('link[rel="canonical"]')?.href || location.href;
      const res = await fetch(new URL("posts.json", base).href);
      if (res.ok) manifest = await res.json();
      mateMeta();
    } catch (e) {}

    editor.focus();
  };

  boot();
})();
