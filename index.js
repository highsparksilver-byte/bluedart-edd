import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();
app.use(express.json());

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

const {
  DATABASE_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_ID,
  BD_LICENCE_KEY_TRACK,
  BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD
} = process.env;

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🕒 DATE HELPERS
================================ */
function nowIST() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

function getNextWorkingDate() {
  const d = nowIST();
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `/Date(${d.getTime()})/`;
}

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7 * 24 * 60 * 60 * 1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   🚦 STATUS HELPERS (UI SAFE)
================================ */
function getStatusType(s = "") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("RTO") || s.includes("RETURN")) return "RT";
  if (s.includes("UNDELIVERED") || s.includes("FAILURE")) return "NDR";
  if (s.includes("OUT FOR")) return "OF";
  if (s.includes("PICK")) return "PU";
  return "UD";
}

function normalizeStatus(v = "") {
  const s = v.toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RTO")) return "RTO / RETURNED";
  if (s.includes("OUT FOR")) return "OUT FOR DELIVERY";
  return "IN TRANSIT";
}

/* ===============================
   🚚 TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}` +
      `&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });

    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    const statusText =
      s.Status ||
      s.StatusDescription ||
      s.Scans?.ScanDetail?.Scan ||
      "";

    if (!statusText) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: normalizeStatus(statusText),
      statusType: getStatusType(statusText),
      delivered: getStatusType(statusText) === "DL",
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail || null]
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: normalizeStatus(td.current_status),
      statusType: getStatusType(td.current_status),
      delivered: getStatusType(td.current_status) === "DL",
      raw: td.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🔒 SOURCE-LOCKED ROUTER
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  const { rows } = await pool.query(
    `SELECT tracking_source FROM shipments WHERE awb = $1 LIMIT 1`,
    [awb]
  );

  const source = rows[0]?.tracking_source || null;

  let data = null;

  if (source === "bluedart") {
    data = await trackBluedart(awb);
  } else if (source === "shiprocket") {
    data = await trackShiprocket(awb);
  } else {
    data = await trackBluedart(awb);
    if (!data) data = await trackShiprocket(awb);
  }

  if (!data) return res.status(404).json({ error: "not_found" });
  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Ops Logistics running on", PORT));