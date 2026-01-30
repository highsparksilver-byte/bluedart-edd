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

console.log("🚀 Ops Logistics running");

/* ===============================
   🔑 ENV
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   🔐 TOKEN CACHE
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
   🕒 TIME HELPERS
================================ */
function nowIST() {
  const n = new Date();
  return new Date(n.getTime() + (330 + n.getTimezoneOffset()) * 60000);
}

/* ===============================
   🚚 TRACKING FETCHERS
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

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
      scans: s.Scans?.ScanDetail || []
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: td.current_status || "",
      scans: td.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🧠 OPS LOGIC (SAFE)
================================ */
function detectOpsFlag(status, createdAt) {
  if (!status) return null;

  const s = status.toUpperCase();
  const hours = (Date.now() - new Date(createdAt).getTime()) / 36e5;

  if (s.includes("DELIVERED")) return null;
  if (s.includes("NDR") || s.includes("FAILED")) return "NDR_ATTENTION";
  if (hours > 96) return "SLA_BREACH";

  return null;
}

function computeNextCheck(status) {
  const now = nowIST();
  const s = (status || "").toUpperCase();

  if (s.includes("DELIVERED")) return new Date("9999-01-01");

  if (s.includes("OUT FOR")) {
    now.setHours(now.getHours() + 1);
    return now;
  }

  if (s.includes("NDR") || s.includes("FAILED")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d;
  }

  now.setHours(now.getHours() + 24);
  return now;
}

/* ===============================
   💾 UPSERT TRACKING
================================ */
async function persistTracking(awb, data) {
  const status = data.status || "";
  const opsFlag = detectOpsFlag(status, new Date());
  const deliveredAt = status.toUpperCase().includes("DELIVERED") ? nowIST() : null;
  const nextCheck = computeNextCheck(status);

  await pool.query(
    `
    INSERT INTO shipments (
      awb, tracking_source, actual_courier,
      last_known_status, delivered_at,
      next_check_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (awb)
    DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      actual_courier = EXCLUDED.actual_courier,
      last_known_status = EXCLUDED.last_known_status,
      delivered_at = COALESCE(shipments.delivered_at, EXCLUDED.delivered_at),
      next_check_at = EXCLUDED.next_check_at,
      updated_at = NOW()
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      status,
      deliveredAt,
      nextCheck
    ]
  );
}

/* ===============================
   📡 TRACK API
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) return res.status(404).json({ error: "Tracking not found" });

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   🧑‍💼 OPS DASHBOARD (9.4)
================================ */
app.get("/ops/dashboard", async (_, res) => {
  const [attention, ndr, ofd] = await Promise.all([
    pool.query("SELECT * FROM ops_attention LIMIT 100"),
    pool.query("SELECT * FROM ops_ndr LIMIT 100"),
    pool.query("SELECT * FROM ops_ofd LIMIT 100")
  ]);

  res.json({
    attention: attention.rows,
    ndr: ndr.rows,
    out_for_delivery: ofd.rows
  });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));