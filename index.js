import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 Environment variables (Render)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Sanity check
if (!CLIENT_ID || !CLIENT_SECRET || !LOGIN_ID || !LICENCE_KEY) {
  console.error("❌ Missing environment variables");
} else {
  console.log("✅ Environment variables loaded");
}

// 🔑 Generate JWT token (NO caching for now – avoids gateway edge cases)
async function getToken() {
  console.log("🔐 Generating JWT token");

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

  if (!response.data?.JWTToken) {
    throw new Error("JWTToken missing in auth response");
  }

  return response.data.JWTToken;
}

// 📦 EDD endpoint
app.post("/edd", async (req, res) => {
  try {
    const { pincode } = req.body;

    if (!pincode) {
      return res.status(400).json({ error: "Pincode required" });
    }

    const token = await getToken();

    const today = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    console.log("🚚 Calling Blue Dart Transit Time API");

    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit-time/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: today,
        pPickupTime: "1600",
        profile: {
          Api_type: "T",
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          // ✅ BOTH headers — this is the key
          JWTToken: token,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      response.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    console.log("✅ Blue Dart response:", result);

    res.json({
      edd: result?.ExpectedDateDelivery
    });
  } catch (error) {
    console.error("❌ EDD ERROR:", {
      status: error.response?.status,
      data: error.response?.data
    });

    res.status(500).json({
      error: "EDD unavailable",
      details: error.response?.data || error.message
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Blue Dart EDD server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
