const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");

const KEYCRM_API_KEY = defineString("KEYCRM_API_KEY");
const KEYCRM_BASE_URL = "https://openapi.keycrm.app/v1";
const PREFIX = "/api/keycrm";

// Only read-only catalog endpoints are exposed through the proxy. Anything
// else (including the PUT endpoints that edit prices/stock) is rejected —
// this route exists to hide the API key from the client, not to forward
// arbitrary KeyCRM requests.
const ALLOWED_PATHS = [
  /^\/products$/,
  /^\/products\/categories$/,
  /^\/products\/[\w-]+$/,
  /^\/offers$/,
  /^\/offers\/stocks$/,
];

function appendQuery(searchParams, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v) => appendQuery(searchParams, key, v));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      appendQuery(searchParams, `${key}[${k}]`, v);
    }
  } else {
    searchParams.append(key, String(value));
  }
}

exports.keycrmProxy = onRequest(
  { cors: true, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let path = req.path || "/";
    if (path.startsWith(PREFIX)) {
      path = path.slice(PREFIX.length) || "/";
    }

    if (!ALLOWED_PATHS.some((re) => re.test(path))) {
      res.status(404).json({ error: "Unknown or disallowed endpoint" });
      return;
    }

    const url = new URL(KEYCRM_BASE_URL + path);
    for (const [key, value] of Object.entries(req.query)) {
      appendQuery(url.searchParams, key, value);
    }

    try {
      const keycrmRes = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KEYCRM_API_KEY.value()}`,
          Accept: "application/json",
        },
      });

      const body = await keycrmRes.text();
      res.status(keycrmRes.status);
      res.set(
        "Content-Type",
        keycrmRes.headers.get("content-type") || "application/json"
      );
      res.send(body);
    } catch (err) {
      console.error("KeyCRM proxy error", err);
      res.status(502).json({ error: "Failed to reach KeyCRM" });
    }
  }
);
