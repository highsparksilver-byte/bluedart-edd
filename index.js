import express from "express";
import axios from "axios";

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
const SR_EMAIL = process.env.SHIPROCKET_EMAIL;
const SR_PASSWORD = process.env.SHIPROCKET_PASSWORD;

if (!SR_EMAIL || !SR_PASSWORD) {
  console.error("❌ Shiprocket credentials missing");
}

/* ===============================
   🔐 SHIPROCKET JWT CACHE
================================ */
let srJwt = null;
let srJwtAt = 0;

async function getShiprocketJwt(force = false) {
  if (!force && srJwt && Date.now() - srJwtAt < 6 * 60 * 60 * 1000) {
    return srJwt;
  }

  console.log("🔐 Logging in to Shiprocket…");

  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      email: SR_EMAIL,
      password: SR_PASSWORD
    },
    { timeout: 10000 }
  );

  srJwt = res.data.token;
  srJwtAt = Date.now();

  console.log("✅ Shiprocket JWT received");
  return srJwt;
}

/* ===============================
   🧪 TEST ROUTES
================================ */

/**
 * 1️⃣ AUTH TEST
 */
app.get("/test/shiprocket/auth", async (req, res) => {
  try {
    const token = await getShiprocketJwt(true);
    res.json({ ok: true, token_present: !!token });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ ok: false, error: "Auth failed" });
  }
});

/**
 * 2️⃣ TRACKING TEST
 */
app.get("/test/shiprocket/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  try {
    const token = await getShiprocketJwt();

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );

    res.json(r.data);
  } catch (e) {
    console.error("❌ Shiprocket track error:", e.response?.data || e.message);
    res.status(500).json({
      error: "Shiprocket tracking failed",
      details: e.response?.data || null
    });
  }
});

/**
 * 3️⃣ EDD TEST
 */
app.get("/test/shiprocket/edd", async (req, res) => {
  const { pincode } = req.query;
  if (!/^[0-9]{6}$/.test(pincode)) {
    return res.status(400).json({ error: "Invalid pincode" });
  }

  try {
    const token = await getShiprocketJwt();

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/`,
      {
        params: {
          pickup_postcode: "411022",
          delivery_postcode: pincode,
          cod: 1,
          weight: 0.5
        },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );

    res.json(r.data);
  } catch (e) {
    console.error("❌ Shiprocket EDD error:", e.response?.data || e.message);
    res.status(500).json({
      error: "Shiprocket EDD failed",
      details: e.response?.data || null
    });
  }
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Shiprocket test server running on", PORT);
});