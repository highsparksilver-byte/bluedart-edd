import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 ✅ PRODUCTION MODE
 ClientID-only JWT generation (CONFIRMED WORKING)
================================================
*/

// 🔑 ClientID only
const CLIENT_ID = "e8t8RyuHO1rNqZ6GCBsjRoqeokRoCefb";

// 🔑 Account credentials (same app)
const LOGIN_ID = "PNQ90609";
const LICENCE_KEY = "oupkkkosmeqmuqqfsph8korrp8krmouj";

// Cache JWT (refresh every 1 hour)
let cachedJwt = null;
let jwtFetchedAt = 0;

// Generate JWT using ONLY ClientID
async function getJwt() {
  if (cachedJwt && Date.now() - jwtFetchedAt < 60 * 60 * 1000) {
    return cachedJwt;
  }

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID
      }
    }
  );

  if (!res.data?.JWTToken) {
    throw new Error("JWT not returned by Blue Dart");
  }

  cachedJwt = res.data.JWTToken;
  jwtFetchedAt = Date.now();
  return cachedJwt;
}

// Legacy date format required by Transit API
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

/*
================================================
 EDD ENDPOINT
================================================
*/
app.post("/edd", async (req, res) => {
  try {
    const destinationPincode = req.body.pincode || "400099";
    const jwt = await getJwt();

    const bdRes = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: destinationPincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: jwt,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    res.json({
      edd: result?.ExpectedDateDelivery
    });

  } catch (error) {
    res.status(500).json({
      error: "EDD unavailable",
      details: error.response?.data || error.message
    });
  }
});

/*
================================================
 Health check
================================================
*/
app.get("/", (_, res) => {
  res.send("Blue Dart EDD server running (ClientID-only JWT)");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
