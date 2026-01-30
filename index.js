import express from "express";
import axios from "axios";
import xml2js from "xml2js";

const app = express();
app.use(express.json());

/* =================================================
   🌍 CORS (SHOPIFY SAFE)
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
  "2026-11-01"
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
  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { Accept: "application/json", ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
  );
  bdJwt = res.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;
  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = res.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* =================================================
   🕒 DATE HELPERS
================================================= */
function getIndiaDate() {
  const now = new Date();
  return new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
}

function isNonWorkingDay(d) {
  const day = d.getDay();
  const ymd = d.toISOString().slice(0, 10);
  return day === 0 || HOLIDAYS.includes(ymd);
}

function calculatePickupDate() {
  const now = getIndiaDate();
  let d = new Date(now);
  if (now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 45)) {
    d.setDate(d.getDate() + 1);
  }
  while (isNonWorkingDay(d)) d.setDate(d.getDate() + 1);
  return `/Date(${d.getTime()})/`;
}

function parseBlueDartDate(s) {
  if (!s) return null;
  const map = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const [dd,mmm,yy] = s.split("-");
  if (!map[mmm.toLowerCase()]) return null;
  return new Date(Date.UTC(2000 + Number(yy), map[mmm.toLowerCase()], Number(dd)));
}

/* =================================================
   🏙️ CITY LOOKUP
================================================= */
async function getCity(pin) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pin}`);
    if (r.data?.[0]?.Status === "Success") {
      return r.data[0].PostOffice[0].District;
    }
  } catch {}
  return null;
}

/* =================================================
   ⚡ BADGE
================================================= */
function getBadge(eddStr, city) {
  if (!eddStr) return "STANDARD";
  const min = parseBlueDartDate(eddStr);
  if (!min) return "STANDARD";

  const istMin = new Date(min.getTime() + 19800000);
  const diff = Math.round((istMin - getIndiaDate()) / 86400000);
  const metros = ["MUMBAI","DELHI","BENGALURU","PUNE","CHENNAI","HYDERABAD","KOLKATA"];
  if (metros.some(m => (city||"").toUpperCase().includes(m)) && diff <= 2) return "METRO_EXPRESS";
  if (diff <= 3) return "EXPRESS";
  return "STANDARD";
}

/* =================================================
   📦 EDD PROVIDERS
================================================= */
async function getBluedartEdd(pin) {
  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pin,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: calculatePickupDate(),
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID }
      },
      { headers: { JWTToken: jwt } }
    );
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch { return null; }
}

async function getShiprocketEdd(pin) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pin}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = r.data?.data?.available_courier_companies || [];
    let best = null;
    for (const c of list) if (c.etd && (!best || c.etd < best)) best = c.etd;
    return best ? best.split("-").reverse().join("-") : null;
  } catch { return null; }
}

/* =================================================
   🧠 CACHE (DAILY)
================================================= */
const eddCache = new Map();
setInterval(() => eddCache.clear(), 86400000);

/* =================================================
   🚚 EDD ROUTE
================================================= */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ error: "Invalid pincode" });

  if (eddCache.has(pincode)) return res.json(eddCache.get(pincode));

  const city = await getCity(pincode);
  let edd = await getBluedartEdd(pincode);
  if (!edd) edd = await getShiprocketEdd(pincode);

  const response = {
    serviceable: true,
    edd,
    edd_display: edd ? edd : null,
    badge: getBadge(edd, city),
    city,
    message: edd ? null : "Estimated delivery will be shared after order confirmation"
  };

  eddCache.set(pincode, response);
  res.json(response);
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on", PORT));