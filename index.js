import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* ===============================
   🚀 APP + DB
================================ */
const app = express();
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🌍 CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   🔑 ENV
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);
const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   🔐 SHIPROCKET JWT
================================ */
let srJwt = null;
let srJwtAt = 0;

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   🚚 TRACKERS
================================ */
function mapShiprocketStatus(s = "") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("OUT FOR")) return "OF";
  if (s.includes("PICK")) return "PU";
  if (s.includes("RTO")) return "RT";
  return "UD";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery` +
      `&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      courier: "Blue Dart",
      status: s.Status,
      statusType: s.StatusType,
      scans: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : s.Scans?.ScanDetail
        ? [s.Scans.ScanDetail]
        : []
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
    if (!t) return null;

    return {
      source: "shiprocket",
      courier: t.courier_name || null,
      status: t.current_status,
      statusType: mapShiprocketStatus(t.current_status),
      scans: t.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🚚 TRACK ROUTE (UPSERT)
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "Tracking details not found" });

  const delivered = data.statusType === "DL";

  try {
    await pool.query(
      `
      INSERT INTO shipments (
        awb,
        courier,
        tracking_source,
        actual_courier,
        shopify_order_id,
        shopify_order_name,
        fulfillment_id,
        customer_mobile,
        last_known_status,
        delivery_confirmed,
        delivered_at,
        last_checked_at
      )
      VALUES (
        $1, $2, $3, $4,
        'external', 'external', 'external',
        'unknown',
        $5, $6, CASE WHEN $6 THEN NOW() ELSE NULL END, NOW()
      )
      ON CONFLICT (awb)
      DO UPDATE SET
        actual_courier = EXCLUDED.actual_courier,
        last_known_status = EXCLUDED.last_known_status,
        last_checked_at = NOW(),
        delivery_confirmed = CASE WHEN EXCLUDED.delivery_confirmed THEN true ELSE shipments.delivery_confirmed END,
        delivered_at = CASE WHEN EXCLUDED.delivery_confirmed THEN NOW() ELSE shipments.delivered_at END,
        updated_at = NOW()
      `,
      [
        awb,
        data.source,
        data.source,
        data.courier,
        data.status,
        delivered
      ]
    );
  } catch (e) {
    console.error("UPSERT failed:", e.message);
  }

  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));