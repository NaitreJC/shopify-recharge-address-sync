const crypto = require("crypto");

const SHOPIFY_SHOP_DOMAIN = "alpherco.myshopify.com";
const KLAVIYO_API_REVISION = "2025-01-15";

function getEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeader, webhookSecret) {
  if (!hmacHeader) return false;

  const generatedHmac = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("base64");

  const generatedBuffer = Buffer.from(generatedHmac, "utf8");
  const receivedBuffer = Buffer.from(hmacHeader, "utf8");

  if (generatedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuffer, receivedBuffer);
}

function normaliseShopifyAddress(customer) {
  const address = customer.default_address;

  if (!address) {
    return null;
  }

  return {
    first_name: address.first_name || customer.first_name || "",
    last_name: address.last_name || customer.last_name || "",
    company: address.company || "",
    address1: address.address1 || "",
    address2: address.address2 || "",
    city: address.city || "",
    province: address.province || "",
    zip: address.zip || "",
    country_code: address.country_code || "",
    phone: address.phone || customer.phone || ""
  };
}

function hasUsableAddress(address) {
  return Boolean(
    address &&
      address.address1 &&
      address.city &&
      address.zip &&
      address.country_code
  );
}

async function sendKlaviyoEvent(customer, shopifyAddress) {
  const klaviyoPrivateApiKey = getEnv("KLAVIYO_PRIVATE_API_KEY");

  const payload = {
    data: {
      type: "event",
      attributes: {
        properties: {
          shopify_customer_id: String(customer.id),
          shopify_address_id: customer.default_address
            ? String(customer.default_address.id || "")
            : "",
          address1: shopifyAddress.address1,
          address2: shopifyAddress.address2,
          city: shopifyAddress.city,
          province: shopifyAddress.province,
          zip: shopifyAddress.zip,
          country_code: shopifyAddress.country_code
        },
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: "Shopify Address Updated"
            }
          }
        },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: customer.email,
              first_name: customer.first_name || shopifyAddress.first_name || "",
              last_name: customer.last_name || shopifyAddress.last_name || "",
              properties: {
                shopify_customer_id: String(customer.id),
                last_shopify_address_update_source: "Shopify webhook"
              }
            }
          }
        }
      }
    }
  };

  const response = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${klaviyoPrivateApiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      revision: KLAVIYO_API_REVISION
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(`Klaviyo API error ${response.status}`);
    error.data = responseText;
    throw error;
  }

  return responseText;
}

async function handleWebhook(req, res) {
  const shopifyWebhookSecret = getEnv("SHOPIFY_WEBHOOK_SECRET");
  const rawBody = await readRawBody(req);

  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shopDomain = req.headers["x-shopify-shop-domain"];
  const topic = req.headers["x-shopify-topic"];
  const webhookId = req.headers["x-shopify-webhook-id"];

  if (shopDomain !== SHOPIFY_SHOP_DOMAIN) {
    res.status(401).json({ ok: false, error: "Invalid Shopify shop domain" });
    return;
  }

  const isValid = verifyShopifyHmac(rawBody, hmacHeader, shopifyWebhookSecret);

  if (!isValid) {
    res.status(401).json({ ok: false, error: "Invalid Shopify HMAC" });
    return;
  }

  let customer;

  try {
    customer = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ ok: false, error: "Invalid JSON payload" });
    return;
  }

  try {
    if (topic !== "customers/update") {
      res.status(200).json({ ok: true, skipped: "Unsupported topic" });
      return;
    }

    if (!customer.email) {
      res.status(200).json({ ok: true, skipped: "Customer has no email" });
      return;
    }

    const shopifyAddress = normaliseShopifyAddress(customer);

    if (!hasUsableAddress(shopifyAddress)) {
      res.status(200).json({ ok: true, skipped: "Customer has no usable default address" });
      return;
    }

    await sendKlaviyoEvent(customer, shopifyAddress);

    console.log("Klaviyo event sent", {
      event: "Shopify Address Updated",
      shopifyCustomerId: customer.id,
      email: customer.email,
      webhookId
    });

    res.status(200).json({
      ok: true,
      sentToKlaviyo: true
    });
  } catch (error) {
    console.error("Shopify address update Klaviyo event failed", {
      message: error.message,
      data: error.data || null,
      customerEmail: customer && customer.email ? customer.email : null,
      webhookId
    });

    res.status(200).json({
      ok: true,
      sentToKlaviyo: false,
      errorLogged: true
    });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  await handleWebhook(req, res);
};
