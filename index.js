import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* =====================================================
   🚀 APP + DB
===================================================== */
const app = express();
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =====================================================
   🌍 CORS
===================================================== */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

/* =====================================================
   🔑 ENV
===================================================== */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const BD_LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const BD_LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* =====================================================
   🔐 JWT CACHE
===================================================== */
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

/* =====================================================
   📦 LIVE TRACKING HELPERS
===================================================== */
function mapShiprocketStatus(s = "") {
  s = s.toUpperCase();
  if (s === "DELIVERED") return "DL";
  if (s.includes("OUT")) return "OF";
  if (s.includes("PICK")) return "PU";
  if (s.includes("RTO")) return "RT";
  if (s.includes("CANCEL")) return "CN";
  return "IT";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt` +
      `&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}` +
      `&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) => e ? rej(e) : res(o))
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.Status) return null;

    return {
      courier: "Blue Dart",
      status: s.Status,
      statusType: s.StatusType,
      scans: s.Scans?.ScanDetail
        ? Array.isArray(s.Scans.ScanDetail)
          ? s.Scans.ScanDetail
          : [s.Scans.ScanDetail]
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
    if (!t || !t.current_status) return null;

    return {
      courier: t.courier_name || "Shiprocket",
      status: t.current_status,
      statusType: mapShiprocketStatus(t.current_status),
      scans: t.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* =====================================================
   🚚 TRACK ROUTE (FINAL LOGIC)
===================================================== */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  try {
    const { rows } = await pool.query(
      "SELECT tracking_source FROM shipments WHERE awb = $1",
      [awb]
    );

    let data = null;

    if (rows.length > 0) {
      const src = rows[0].tracking_source;

      // 🔥 CRITICAL FIX
      // If Shiprocket booked → ALWAYS Shiprocket first
      if (src === "shiprocket") {
        data = await trackShiprocket(awb);
        if (!data) data = await trackBluedart(awb);
      } else {
        data = await trackBluedart(awb);
        if (!data) data = await trackShiprocket(awb);
      }
    } else {
      // Not in DB → safest fallback
      data = await trackBluedart(awb);
      if (!data) data = await trackShiprocket(awb);
    }

    if (!data) {
      return res.status(404).json({ error: "Tracking details not found" });
    }

    res.json(data);

  } catch (e) {
    console.error("Tracking error:", e.message);
    res.status(500).json({ error: "Tracking failed" });
  }
});

/* =====================================================
   ❤️ HEALTH
===================================================== */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));