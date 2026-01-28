import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();

/* =================================================
   🔧 BASIC CONFIG
================================================= */
const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  APP_URL,
} = process.env;

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !APP_URL) {
  console.error("❌ Missing Shopify environment variables");
}

/* =================================================
   ❤️ HEALTH CHECK
================================================= */
app.get("/", (req, res) => {
  res.send("Ops Logistics Sync is running ✅");
});

/* =================================================
   🚀 PHASE 6.2 — SHOPIFY AUTH START
================================================= */
app.get("/auth/shopify", (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  const state = crypto.randomBytes(16).toString("hex");

  const redirectUri = `${APP_URL}/auth/shopify/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  console.log("➡️ Redirecting to Shopify install URL");
  console.log(installUrl);

  res.redirect(installUrl);
});

/* =================================================
   🔐 PHASE 6.2 — SHOPIFY CALLBACK
================================================= */
app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;

    if (!shop || !code || !hmac) {
      return res.status(400).send("Missing OAuth parameters");
    }

    /* -------- HMAC VALIDATION -------- */
    const query = { ...req.query };
    delete query.hmac;
    delete query.signature;

    const message = new URLSearchParams(query).toString();

    const generatedHmac = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHmac !== hmac) {
      console.error("❌ HMAC validation failed");
      return res.status(401).send("HMAC validation failed");
    }

    /* -------- TOKEN EXCHANGE -------- */
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }
    );

    const { access_token } = tokenResponse.data;

    console.log("✅ Shopify access token received");
    console.log("🏬 Shop:", shop);
    console.log("🔑 Token:", access_token);

    /*
      NEXT STEP (PHASE 6.3):
      Save this token to Neon DB
      table: shopify_tokens
    */

    res.send(`
      <h2>✅ App Installed Successfully</h2>
      <p><strong>Shop:</strong> ${shop}</p>
      <p>You can now close this window.</p>
    `);
  } catch (err) {
    console.error("❌ OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
app.listen(PORT, () => {
  console.log(`🚀 Ops Logistics Sync running on port ${PORT}`);
});
