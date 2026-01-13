const express = require("express");
const axios = require("axios");

const app = express();

// ✅ Allow JSON + form data (important later for Shopify)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 Secrets come ONLY from Render environment variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENSE_KEY = process.env.LICENSE_KEY;

// 🧪 Startup log (confirms server boot)
console.log("Server starting...");

// Simple health check
app.get("/", (req, res) => {
  res.send("Server alive");
});

// Cache token
let cachedToken = null;
let tokenExpiry = null;

// 🔐 Get Blue Dart JWT token
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await axios.post(
    "https://apigateway-sandbox.bluedart.com/in/transportation/auth/v1/login",
    {
      clientId: CLIENT_ID
    },
    {
      headers: {
        clientSecret: CLIENT_SECRET
      }
    }
  );

  cachedToken = response.data.jwtToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  return cachedToken;
}

// 🚚 EDD endpoint
app.post("/edd", async (req, res) => {
  try {
    console.log("EDD request received");

    const toPincode =
      req.body.pincode || req.query.pincode || "411022";

    const token = await getToken();

    // Format date as YYYYMMDD
    const today = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    const response = await axios.post(
      "https://apigateway-sandbox.bluedart.com/in/transportation/transit-time/v1/getDomesticTransitTimeForPinCodeandProduct",
      {
        ppinCode: "411022",
        pPinCodeTo: toPincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: today,
        pPickupTime: "1400"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          LoginID: LOGIN_ID,
          LicenseKey: LICENSE_KEY
        }
      }
    );

    const edd =
      response.data?.DomesticTranistTimeReference?.ExpectedDateDelivery;

    res.json({ edd });
  } catch (e) {
    console.error(
      "EDD ERROR:",
      e.response?.data || e.message
    );

    res.status(500).json({
      error: "EDD unavailable",
      details: e.response?.data || e.message
    });
  }
});

// ✅ IMPORTANT: Use Render's PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
