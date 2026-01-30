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
const clean = v => v?.replace(/\s+/g, " ").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

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
  if (bdJwt && Date.now() - bdJwtAt < 23 * 3600000) return bdJwt;
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
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 3600000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   📦 STATUS NORMALIZATION
================================ */
function normalizeShiprocketStatus(track) {
  const label = (track?.["sr-status-label"] || track?.activity || "").toUpperCase();
  if (label.includes("DELIVERED")) return "DELIVERED";
  if (label.includes("OUT FOR")) return "OUT FOR DELIVERY";
  if (label.includes("RTO")) return "RTO INITIATED";
  return "IN TRANSIT";
}

/* ===============================
   🚚 TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;
    const r = await axios.get(url, { responseType: "text", timeout: 8000 });

    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) => e ? rej(e) : res(o))
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status,
      normalized: s.StatusType === "DL" ? "DELIVERED" : "IN TRANSIT",
      delivered: s.StatusType === "DL",
      scans: s.Scans?.ScanDetail
        ? (Array.isArray(s.Scans.ScanDetail) ? s.Scans.ScanDetail : [s.Scans.ScanDetail])
        : []
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const t = r.data?.tracking_data;
    const scans = t?.shipment_track_activities || [];
    if (!scans.length) return null;

    const latest = scans[0];

    return {
      source: "shiprocket",
      actual_courier: t?.shipment_track?.[0]?.courier_name || null,
      normalized: normalizeShiprocketStatus(latest),
      delivered: normalizeShiprocketStatus(latest) === "DELIVERED",
      scans
    };
  } catch {
    return null;
  }
}

/* ===============================
   🧠 UPSERT + PERSIST
================================ */
async function persistTracking(awb, data) {
  const now = new Date();
  const deliveredAt = data.delivered ? now : null;
  const nextCheck = data.delivered ? "9999-01-01" : new Date(now.getTime() + 6 * 3600000);

  await pool.query(
    `
    INSERT INTO shipments (awb, tracking_source, actual_courier, last_known_status, delivered_at, next_check_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (awb) DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      actual_courier = COALESCE(EXCLUDED.actual_courier, shipments.actual_courier),
      last_known_status = EXCLUDED.last_known_status,
      delivered_at = COALESCE(shipments.delivered_at, EXCLUDED.delivered_at),
      next_check_at = CASE
        WHEN shipments.delivered_at IS NOT NULL THEN shipments.next_check_at
        ELSE EXCLUDED.next_check_at
      END,
      updated_at = now()
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      data.normalized,
      deliveredAt,
      nextCheck
    ]
  );
}

/* ===============================
   🚚 TRACK ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) return res.status(404).json({ error: "Tracking details not found" });

  await persistTracking(awb, data);

  res.json({
    source: data.source,
    courier: data.actual_courier,
    statusType: data.normalized,
    scans: data.scans
  });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));