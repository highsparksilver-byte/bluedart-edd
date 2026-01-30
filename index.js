import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* =========================================================
   🚀 APP + DB
========================================================= */
const app = express();
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================================================
   🌍 CORS
========================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================================================
   🔑 ENV
========================================================= */
const LOGIN_ID = process.env.LOGIN_ID;
const BD_LICENCE_KEY_TRACK = process.env.BD_LICENCE_KEY_TRACK;
const SR_EMAIL = process.env.SHIPROCKET_EMAIL;
const SR_PASSWORD = process.env.SHIPROCKET_PASSWORD;

console.log("🚀 Ops Logistics running");

/* =========================================================
   🔐 SHIPROCKET TOKEN CACHE
========================================================= */
let srToken = null;
let srTokenAt = 0;

async function getShiprocketToken() {
  if (srToken && Date.now() - srTokenAt < 7 * 24 * 60 * 60 * 1000) {
    return srToken;
  }
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srToken = r.data.token;
  srTokenAt = Date.now();
  return srToken;
}

/* =========================================================
   🕒 TIME HELPERS (IST SAFE)
========================================================= */
function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function tomorrow8AM() {
  const d = istNow();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return new Date(d.getTime() - 5.5 * 60 * 60 * 1000);
}

function computeNextCheck(status = "") {
  const s = status.toUpperCase();
  const now = Date.now();

  if (s.includes("DELIVERED")) {
    return new Date("9999-01-01");
  }

  if (s.includes("OUT FOR DELIVERY")) {
    return new Date(now + 1 * 60 * 60 * 1000);
  }

  if (
    s.includes("NDR") ||
    s.includes("FAILED") ||
    s.includes("ATTEMPT") ||
    s.includes("NOT DELIVERED")
  ) {
    return tomorrow8AM();
  }

  if (
    s.includes("TRANSIT") ||
    s.includes("SHIP") ||
    s.includes("PICK")
  ) {
    return new Date(now + 6 * 60 * 60 * 1000);
  }

  return new Date(now + 24 * 60 * 60 * 1000);
}

/* =========================================================
   🚚 TRACKERS
========================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${BD_LICENCE_KEY_TRACK}` +
      `&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text" });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status,
      scans: s.Scans?.ScanDetail || []
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
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const td = r.data.tracking_data;
    return {
      source: "shiprocket",
      actual_courier: td?.shipment_track?.[0]?.courier_name || null,
      status: td?.shipment_track?.[0]?.current_status || "",
      scans: td?.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* =========================================================
   💾 UPSERT TRACKING (SAFE)
========================================================= */
async function persistTracking(awb, payload) {
  const statusText = payload.status || "";
  const delivered =
    statusText.toUpperCase().includes("DELIVERED") ? istNow() : null;

  await pool.query(
    `
    INSERT INTO shipments (
      awb,
      tracking_source,
      actual_courier,
      last_known_status,
      delivered_at,
      last_checked_at,
      next_check_at
    )
    VALUES ($1,$2,$3,$4,$5,NOW(),$6)
    ON CONFLICT (awb)
    DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      actual_courier = COALESCE(EXCLUDED.actual_courier, shipments.actual_courier),
      last_known_status = EXCLUDED.last_known_status,
      delivered_at = COALESCE(shipments.delivered_at, EXCLUDED.delivered_at),
      last_checked_at = NOW(),
      next_check_at = EXCLUDED.next_check_at
    `,
    [
      awb,
      payload.source,
      payload.actual_courier,
      statusText,
      delivered,
      computeNextCheck(statusText)
    ]
  );
}

/* =========================================================
   🌐 TRACK ENDPOINT
========================================================= */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let result = await trackBluedart(awb);
  if (!result) result = await trackShiprocket(awb);
  if (!result) return res.status(404).json({ error: "Tracking not found" });

  await persistTracking(awb, result);

  res.json(result);
});

/* =========================================================
   ⏱️ CRON TRIGGER
========================================================= */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(
    `SELECT awb FROM shipments WHERE next_check_at <= NOW() LIMIT 30`
  );

  for (const r of rows) {
    let data = await trackBluedart(r.awb);
    if (!data) data = await trackShiprocket(r.awb);
    if (data) await persistTracking(r.awb, data);
  }

  res.json({ ok: true, processed: rows.length });
});

/* =========================================================
   ❤️ HEALTH
========================================================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));