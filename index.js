import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

const app = express();
app.use(express.json());

/* ===============================
   DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* ===============================
   ENV
================================ */
const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_TRACK_KEY = clean(process.env.BD_LICENCE_KEY_TRACK);
const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   JWT CACHE
================================ */
let srJwt = null, srJwtAt = 0;

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 8 * 60 * 60 * 1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   STATUS → NEXT CHECK
================================ */
function nextCheckFromStatus(status) {
  const now = Date.now();
  const s = (status || "").toUpperCase();

  if (s.includes("DELIVERED"))
    return new Date("9999-01-01");

  if (s.includes("OUT FOR"))
    return new Date(now + 2 * 60 * 60 * 1000);

  return new Date(now + 6 * 60 * 60 * 1000);
}

/* ===============================
   TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt` +
      `&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${BD_TRACK_KEY}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s?.Status) return null;

    return {
      source: "bluedart",
      courier: "Blue Dart",
      status: s.Status,
      delivered: s.StatusType === "DL"
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const t = r.data?.tracking_data;
    if (!t?.current_status) return null;

    return {
      source: "shiprocket",
      courier: t.courier_name || null,
      status: t.current_status,
      delivered: t.current_status.toUpperCase() === "DELIVERED"
    };
  } catch {
    return null;
  }
}

/* ===============================
   🔁 CRON WORKER (STEP 7)
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM shipments
    WHERE delivery_confirmed = false
      AND (next_check_at IS NULL OR next_check_at <= NOW())
    ORDER BY next_check_at NULLS FIRST
    LIMIT 30
  `);

  let processed = 0;

  for (const sh of rows) {
    let result = null;

    if (sh.tracking_source === "shiprocket") {
      result = await trackShiprocket(sh.awb);
      if (!result) result = await trackBluedart(sh.awb);
    } else {
      result = await trackBluedart(sh.awb);
      if (!result) result = await trackShiprocket(sh.awb);
    }

    if (!result) continue;

    await pool.query(
      `
      UPDATE shipments SET
        tracking_source = $1,
        actual_courier = COALESCE($2, actual_courier),
        last_known_status = $3,
        delivered_at = CASE WHEN $4 THEN NOW() ELSE delivered_at END,
        delivery_confirmed = CASE WHEN $4 THEN true ELSE delivery_confirmed END,
        next_check_at = $5,
        updated_at = NOW()
      WHERE awb = $6
      `,
      [
        result.source,
        result.courier,
        result.status,
        result.delivered,
        nextCheckFromStatus(result.status),
        sh.awb
      ]
    );

    processed++;
  }

  res.json({ ok: true, processed });
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);