import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

const { Pool } = pg;

/* =================================================
   🗄️ DATABASE
================================================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =================================================
   🚀 APP INIT
================================================= */
const app = express();
app.use(express.json());

/* =================================================
   🌍 CORS
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* =================================================
   🔑 ENV
================================================= */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* =================================================
   📅 CONSTANTS
================================================= */
const HOLIDAYS = [
  "2026-01-26",
  "2026-03-03",
  "2026-08-15",
  "2026-10-02",
  "2026-11-01",
];

/* =================================================
   🔑 JWT CACHE
================================================= */
let bdJwt = null;
let bdJwtAt = 0;
let srJwt = null;
let srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;

  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    }
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

/* =================================================
   🇮🇳 DATE HELPERS
================================================= */
function getIndiaDate() {
  const n = new Date();
  return new Date(n.getTime() + (330 + n.getTimezoneOffset()) * 60000);
}

function isNonWorkingDay(d) {
  return d.getDay() === 0 || HOLIDAYS.includes(d.toISOString().slice(0, 10));
}

function calculatePickupDate() {
  let d = getIndiaDate();
  if (d.getHours() > 11 || (d.getHours() === 11 && d.getMinutes() >= 45)) {
    d.setDate(d.getDate() + 1);
  }
  while (isNonWorkingDay(d)) d.setDate(d.getDate() + 1);
  return `/Date(${d.getTime()})/`;
}

/* =================================================
   🧠 EDD CACHE (DAILY)
================================================= */
const eddCache = new Map();

function eddKey(pincode) {
  return `${pincode}-${getIndiaDate().toISOString().slice(0, 10)}`;
}

/* =================================================
   📦 EDD ROUTE
================================================= */
app.post("/edd", async (req, res) => {
  const pincode = String(req.body.pincode || "").trim();
  if (!/^[1-9][0-9]{5}$/.test(pincode))
    return res.status(400).json({ error: "Invalid pincode" });

  const key = eddKey(pincode);
  if (eddCache.has(key)) return res.json({ ...eddCache.get(key), cached: true });

  let edd = null;

  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: calculatePickupDate(),
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID },
      },
      { headers: { JWTToken: jwt } }
    );
    edd =
      r.data?.GetDomesticTransitTimeForPinCodeandProductResult
        ?.ExpectedDateDelivery || null;
  } catch {}

  if (!edd) {
    try {
      const token = await getShiprocketJwt();
      const sr = await axios.get(
        `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pincode}&cod=1&weight=0.5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      edd = sr.data?.data?.available_courier_companies?.[0]?.etd || null;
    } catch {}
  }

  const response = { edd: edd || null };
  if (edd) eddCache.set(key, response);
  res.json(response);
});

/* =================================================
   📦 TRACKING (BD + SHIPROCKET)
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt` +
      `&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await xml2js.parseStringPromise(r.data, {
      explicitArray: false,
    });

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      status: s.Status,
      statusType: s.StatusType,
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
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return {
      status: r.data.tracking_data.current_status,
      statusType: r.data.tracking_data.current_status_code,
    };
  } catch {
    return null;
  }
}

/* =================================================
   ⏱️ CRON SYNC
================================================= */
app.post("/_cron/sync", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT id, awb, courier
    FROM shipments
    WHERE delivery_confirmed = false
      AND next_check_at <= NOW()
    LIMIT 25
  `);

  let processed = 0;

  for (const r of rows) {
    const data =
      r.courier === "bluedart"
        ? await trackBluedart(r.awb)
        : await trackShiprocket(r.awb);

    if (!data) continue;

    const delivered = data.statusType === "DL";
    const next =
      delivered ? "9999-01-01" : new Date(Date.now() + 12 * 60 * 60 * 1000);

    await pool.query(
      `
      UPDATE shipments
      SET last_known_status=$1,
          delivery_confirmed=$2,
          last_checked_at=NOW(),
          next_check_at=$3
      WHERE id=$4
    `,
      [data.status, delivered, next, r.id]
    );

    processed++;
  }

  res.json({ ok: true, processed });
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);