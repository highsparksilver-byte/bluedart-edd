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

/* ===============================
   ENV
================================ */
const clean = v => v?.replace(/\s+/g, " ").trim();
const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_TRACK_KEY = clean(process.env.BD_LICENCE_KEY_TRACK);
const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   SHIPROCKET AUTH
================================ */
let srToken = null, srAt = 0;
async function getShiprocketToken() {
  if (srToken && Date.now() - srAt < 7 * 24 * 3600 * 1000) return srToken;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srToken = r.data.token;
  srAt = Date.now();
  return srToken;
}

/* ===============================
   TRACKING FETCHERS
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
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
      actual_courier: "Blue Dart",
      status: s.Status,
      delivered: s.Status.toUpperCase().includes("DELIVERED"),
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
    const token = await getShiprocketToken();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const t = r.data?.tracking_data;
    if (!t) return null;

    const delivered =
      t.current_status?.toUpperCase().includes("DELIVERED");

    return {
      source: "shiprocket",
      actual_courier: t.courier_name || null,
      status: t.current_status || "",
      delivered,
      scans: t.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   PERSIST (UPDATE ONLY)
================================ */
async function persistTracking(awb, data) {
  if (!data) return;

  const deliveredAt = data.delivered ? new Date() : null;
  const nextCheck =
    data.delivered ? "9999-01-01" : new Date(Date.now() + 6 * 3600 * 1000);

  const q = `
    UPDATE shipments
    SET
      tracking_source = $2,
      actual_courier = $3,
      last_known_status = $4,
      delivered_at = COALESCE(delivered_at, $5),
      next_check_at = $6,
      updated_at = NOW()
    WHERE awb = $1
  `;

  const r = await pool.query(q, [
    awb,
    data.source,
    data.actual_courier,
    data.status,
    deliveredAt,
    nextCheck
  ]);

  // IMPORTANT: if row doesn't exist → do NOTHING
  if (r.rowCount === 0) {
    console.log(`ℹ️ AWB ${awb} not in DB, skipped persist`);
  }
}

/* ===============================
   TRACK ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) {
    return res.status(404).json({ error: "Tracking details not found" });
  }

  await persistTracking(awb, data);

  res.json({
    source: data.source,
    actual_courier: data.actual_courier,
    status: data.status,
    scans: data.scans
  });
});

/* ===============================
   OPS DASHBOARD (SAFE)
================================ */
app.get("/ops/dashboard", async (_, res) => {
  const safe = async q => {
    try {
      return (await pool.query(q)).rows;
    } catch {
      return [];
    }
  };

  res.json({
    attention: await safe("SELECT * FROM ops_attention LIMIT 100"),
    ndr: await safe("SELECT * FROM ops_ndr LIMIT 100"),
    out_for_delivery: await safe("SELECT * FROM ops_ofd LIMIT 100")
  });
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));