// Conversions API de Meta (lado servidor).
// Recibe los eventos que manda la landing (/retiro/) y los reenvía a Meta con
// el mismo event_id que usó el Píxel, para que Meta los deduplique.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   META_PIXEL_ID          ID del Píxel / Dataset de Meta (opcional, por defecto 1110322908295162)
//   META_CAPI_TOKEN        Token de acceso de la API de Conversiones (obligatoria, secreta)
//   META_TEST_EVENT_CODE   Código de prueba del Administrador de eventos (opcional, solo para testear)
//   META_API_VERSION       Versión de la Graph API (opcional, por defecto v21.0)

const crypto = require("crypto");

const ALLOWED_EVENTS = new Set(["PageView", "ViewContent", "Lead", "Contact"]);
const ALLOWED_HOSTS = new Set(["tuasesordigital.com.ar", "www.tuasesordigital.com.ar", "tuasesordigital.vercel.app"]);

const sha256 = (v) => crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");
const str = (v, max = 500) => (typeof v === "string" && v.length && v.length <= max ? v : undefined);

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || undefined;
}

function cleanCustomData(cd) {
  if (!cd || typeof cd !== "object") return undefined;
  const out = {};
  for (const k of ["content_name", "content_category", "cta", "lead_type"]) {
    const v = str(cd[k], 200);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const pixelId = process.env.META_PIXEL_ID || "1110322908295162";
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return res.status(204).end(); // sin configurar: no hace nada

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "invalid_json" }); }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "invalid_body" });

  const eventName = str(body.event_name, 50);
  const eventId = str(body.event_id, 100);
  const sourceUrl = str(body.event_source_url, 2000);
  if (!eventName || !ALLOWED_EVENTS.has(eventName) || !eventId || !sourceUrl) {
    return res.status(400).json({ error: "invalid_event" });
  }
  let host;
  try { host = new URL(sourceUrl).hostname; } catch (e) { return res.status(400).json({ error: "invalid_url" }); }
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: "forbidden_host" });

  const userData = {
    client_ip_address: clientIp(req),
    client_user_agent: req.headers["user-agent"],
  };
  const fbp = str(body.fbp, 200);
  const fbc = str(body.fbc, 500);
  const externalId = str(body.external_id, 100);
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (externalId) userData.external_id = [sha256(externalId)];

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: sourceUrl,
    action_source: "website",
    user_data: userData,
  };
  const customData = cleanCustomData(body.custom_data);
  if (customData) event.custom_data = customData;

  const payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const version = process.env.META_API_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Meta CAPI error", r.status, JSON.stringify(data && data.error ? data.error : data));
      return res.status(502).json({ error: "meta_error" });
    }
    return res.status(200).json({ ok: true, events_received: data.events_received });
  } catch (e) {
    console.error("Meta CAPI fetch failed", e && e.message);
    return res.status(502).json({ error: "meta_unreachable" });
  }
};
