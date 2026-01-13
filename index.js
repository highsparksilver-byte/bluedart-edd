const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 Render environment variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENSE_KEY = process.env.LICENSE_KEY;

console.log("Server starting...");

// Health check
app.get("/", (req, res) => {
  res.send("Server alive");
});

// Token cache
let cachedToken = null;
let tokenExpiry = null;

// 🔐 AUTH — EXACTLY as per generateJWT_0.yaml
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        Accept: "application/json"
      }
    }
  );

  cachedToken = response.data.JWTToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  return cachedToken;
}

// 🚚 EDD API (Transit Time)
app.post("/edd", async (req, res) => {
  try {
    console.log("EDD request received");

    const toPincode =
      req.body.pincode || req.query.pincode || "411022";

    const token = await getToken();

    // YYYYMMDD
    const today = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit-time/v1/GetDomesticTransitTimeForPinCodeandProduct",
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
          LicenseKey: LICENSE_KEY,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      }
    );

    const edd =
      response.data?.DomesticTranistTimeReference?.ExpectedDateDelivery;

    res.json({ edd });
  } catch (e) {
    console.error("EDD ERROR:", e.response?.data || e.message);
    res.status(500).json({
      error: "EDD unavailable",
      details: e.response?.data || e.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
