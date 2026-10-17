// dotpy-blog auth relay
//
// GitHub's device-flow endpoints (github.com/login/*) send no CORS headers, so a
// browser cannot talk to them directly. This Worker forwards the two calls and
// adds the CORS headers. It holds no secrets: the OAuth client_id is public.
//
//   POST /device/code     -> https://github.com/login/device/code
//   POST /access_token    -> https://github.com/login/oauth/access_token
//
// Deploy with: cd worker && npx wrangler deploy

const UPSTREAM = "https://github.com/login";

const ALLOWED_ORIGINS = [
  "https://dotpy.blog",
  "https://www.dotpy.blog",
  "http://localhost:8080",
  "http://localhost:8788",
];

const ROUTES = {
  "/device/code": `${UPSTREAM}/device/code`,
  "/device_code": `${UPSTREAM}/device/code`,
  "/access_token": `${UPSTREAM}/oauth/access_token`,
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, origin);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const target = ROUTES[path];
    if (!target) return json({ error: "not_found", path }, 404, origin);

    const body = await request.text();

    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "dotpy-blog-writer",
      },
      body,
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
