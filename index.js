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
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   🔐 JWT CACHE
================================ */
let bdJwt = null, bdJwtAt = 0;
let srJwt = null, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { Accept: "application/json", ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
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
   🕒 DATE HELPERS
================================ */
function getISTNow() {
  const n = new Date();
  return new Date(n.getTime() + (330 + n.getTimezoneOffset()) * 60000);
}

function isDelivered(status = "") {
  return status.toUpperCase().includes("DELIVERED");
}

/* ===============================
   🚚 BLUEDART TRACKING
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt` +
      `&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml` +
      `&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });

    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) => e ? rej(e) : res(o))
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status || "",
      scans: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : s.Scans?.ScanDetail ? [s.Scans.ScanDetail] : []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🚚 SHIPROCKET TRACKING (FIXED)
================================ */
async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    const primary = td.shipment_track?.[0] || {};

    return {
      source: "shiprocket",
      actual_courier: primary.courier_name || null,
      status: primary.current_status || "",
      scans: td.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 DB UPSERT (SAFE)
================================ */
async function persistTracking(awb, payload) {
  const delivered = isDelivered(payload.status);

  await pool.query(
    `
    INSERT INTO shipments (
      shopify_order_id,
      shopify_order_name,
      fulfillment_id,
      awb,
      courier,
      customer_mobile,
      tracking_source,
      actual_courier,
      last_known_status,
      delivered_at,
      next_check_at
    )
    VALUES (
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      $1,
      $2,
      '',
      $3,
      $4,
      $5,
      $6,
      $7
    )
    ON CONFLICT (awb)
    DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      actual_courier = EXCLUDED.actual_courier,
      last_known_status = EXCLUDED.last_known_status,
      delivered_at = EXCLUDED.delivered_at,
      next_check_at = EXCLUDED.next_check_at,
      updated_at = NOW()
    `,
    [
      awb,
      payload.actual_courier || "",
      payload.source,
      payload.actual_courier,
      payload.status || "",
      delivered ? new Date() : null,
      delivered ? "9999-01-01" : new Date(Date.now() + 6 * 60 * 60 * 1000)
    ]
  );
}

/* ===============================
   🌐 TRACK ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "Tracking details not found" });

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));