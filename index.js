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

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

/* ===============================
   🔑 ENV
================================ */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   📅 CONSTANTS
================================ */
const HOLIDAYS = [
  "2026-01-26", "2026-03-03", "2026-08-15",
  "2026-10-02", "2026-11-01"
];

const METROS = [
  "MUMBAI","DELHI","NEW DELHI","NOIDA","GURGAON","GURUGRAM",
  "BANGALORE","BENGALURU","PUNE","CHENNAI","HYDERABAD",
  "KOLKATA","AHMEDABAD"
];

/* ===============================
   🔐 JWT CACHE
================================ */
let bdJwt=null, bdJwtAt=0;
let srJwt=null, srJwtAt=0;

async function getBluedartJwt() {
  if (bdJwt && Date.now()-bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers:{ Accept:"application/json", ClientID:CLIENT_ID, clientSecret:CLIENT_SECRET } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now()-srJwtAt < 8*24*60*60*1000) return srJwt;
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

function isHoliday(d) {
  return d.getUTCDay() === 0 || HOLIDAYS.includes(d.toISOString().slice(0,10));
}

function getNextWorkingDate() {
  let d = getISTNow();
  while (isHoliday(d)) d.setDate(d.getDate()+1);
  return d;
}

function parseBlueDartDate(str) {
  if (!str) return null;
  const [dd, mon, yyyy] = str.split("-");
  const m = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  if (m[mon] === undefined) return null;
  return new Date(Date.UTC(+yyyy, m[mon], +dd));
}

/* ===============================
   🎯 EDD INTELLIGENCE
================================ */
function confidenceBand(minDate) {
  const start = minDate;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const fmt = d => d.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  return `${fmt(start)}–${fmt(end)}`;
}

function getBadge(minDate, city) {
  const diff = Math.ceil((minDate - getISTNow()) / 86400000);
  const isMetro = METROS.some(m => city?.toUpperCase().includes(m));
  if (isMetro && diff <= 2) return "METRO_EXPRESS";
  if (diff <= 3) return "EXPRESS";
  return "STANDARD";
}

/* ===============================
   📦 EDD CORE
================================ */
async function getCity(pin) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pin}`,{timeout:3000});
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch { return null; }
}

async function getBluedartEDD(pin) {
  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom:"411022",
        pPinCodeTo:pin,
        pProductCode:"A",
        pSubProductCode:"P",
        pPudate:`/Date(${getNextWorkingDate().getTime()})/`,
        pPickupTime:"16:00",
        profile:{Api_type:"S",LicenceKey:LICENCE_KEY_EDD,LoginID:LOGIN_ID}
      },
      { headers:{JWTToken:jwt} }
    );
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch { return null; }
}

async function getShiprocketEDD(pin) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pin}&cod=1&weight=0.5`,
      { headers:{Authorization:`Bearer ${t}`} }
    );
    return r.data?.data?.available_courier_companies?.[0]?.etd || null;
  } catch { return null; }
}

app.post("/edd", async (req,res)=>{
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) return res.json({edd_display:null});

  const city = await getCity(pincode);
  let raw = await getBluedartEDD(pincode);
  let minDate = parseBlueDartDate(raw);

  if (!minDate) {
    const sr = await getShiprocketEDD(pincode);
    if (sr) minDate = new Date(sr);
  }

  if (!minDate) return res.json({edd_display:null});

  res.json({
    edd_display: confidenceBand(minDate),
    city,
    badge: getBadge(minDate, city)
  });
});

/* ===============================
   🚚 TRACKING (UNCHANGED)
================================ */
function normalizeStatus(raw) {
  if (!raw) return "IN TRANSIT";
  if (raw.toUpperCase().includes("DELIVERED")) return "DELIVERED";
  return "IN TRANSIT";
}

async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;
    const r = await axios.get(url,{responseType:"text",timeout:8000});
    const p = await new Promise((res,rej)=>xml2js.parseString(r.data,{explicitArray:false},(e,o)=>e?rej(e):res(o)));
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;
    return {
      source:"bluedart",
      actual_courier:"Blue Dart",
      status: normalizeStatus(s.Status),
      delivered: normalizeStatus(s.Status)==="DELIVERED",
      raw: Array.isArray(s.Scans?.ScanDetail)?s.Scans.ScanDetail:[s.Scans?.ScanDetail]
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers:{Authorization:`Bearer ${t}`}, timeout:8000 }
    );
    const td = r.data.tracking_data;
    if (!td) return null;
    return {
      source:"shiprocket",
      actual_courier: td.courier_name || null,
      status: normalizeStatus(td.current_status),
      delivered: normalizeStatus(td.current_status)==="DELIVERED",
      raw: td.shipment_track || []
    };
  } catch { return null; }
}

app.get("/track", async (req,res)=>{
  const { awb } = req.query;
  if (!awb) return res.status(400).json({error:"AWB required"});

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({error:"not_found"});

  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health",(_,res)=>res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log("🚀 Server on",PORT));