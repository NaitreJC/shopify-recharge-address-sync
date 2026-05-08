const crypto = require("crypto");
const { Resend } = require("resend");

const SHOPIFY_SHOP_DOMAIN = "alpherco.myshopify.com";
const RECHARGE_API_VERSION = "2021-11";
const FAILURE_EMAIL_TO = "care@naitre.com";
const FAILURE_EMAIL_FROM = "Recharge Sync <onboarding@resend.dev>";

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

async function rechargeRequest(path, options = {}) {
  const rechargeToken = getEnv("RECHARGE_API_TOKEN");

  const response = await fetch(`https://api.rechargeapps.com${path}`, {
    ...options,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Recharge-Access-Token": rechargeToken,
      "x-recharge-version": RECHARGE_API_VERSION,
      ...(options.headers || {})
    }
  });

  const responseText = await response.text();

  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = { raw: responseText };
  }

  if (!response.ok) {
    const error = new Error(`Recharge API error ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function findRechargeCustomerByEmail(email) {
  const encodedEmail = encodeURIComponent(email);
  const data = await rechargeRequest(`/customers?email=${encodedEmail}`, {
    method: "GET"
  });

  const customers = data.customers || [];

  if (customers.length === 0) {
    return null;
  }

  return customers[0];
}

async function findFirstRechargeAddress(customerId) {
  const data = await rechargeRequest(`/addresses?customer_id=${customerId}`, {
    method: "GET"
  });

  const addresses = data.addresses || [];

  if (addresses.length === 0) {
    return null;
  }

  const activeAddress =
    addresses.find((address) => String(address.status || "").toUpperCase() === "ACTIVE") ||
    addresses[0];

  return activeAddress;
}

async function updateRechargeAddress(addressId, shopifyAddress) {
  const payload = {
    address1: shopifyAddress.address1,
    address2: shopifyAddress.address2,
    city: shopifyAddress.city,
    province: shopifyAddress.province,
    zip: shopifyAddress.zip,
    country_code: shopifyAddress.country_code,
    first_name: shopifyAddress.first_name,
    last_name: shopifyAddress.last_name,
    company: shopifyAddress.company,
    phone: shopifyAddress.phone
  };

  return rechargeRequest(`/addresses/${addressId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

async function sendFailureEmail(subject, details) {
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    console.error("RESEND_API_KEY not set. Failure email not sent.", details);
    return;
  }

  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: FAILURE_EMAIL_FROM,
    to: FAILURE_EMAIL_TO,
    subject,
    text: details
  });
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

    const rechargeCustomer = await findRechargeCustomerByEmail(customer.email);

    if (!rechargeCustomer) {
      res.status(200).json({ ok: true, skipped: "No matching Recharge customer found" });
      return;
    }

    const rechargeAddress = await findFirstRechargeAddress(rechargeCustomer.id);

    if (!rechargeAddress) {
      res.status(200).json({ ok: true, skipped: "No Recharge address found" });
      return;
    }

    await updateRechargeAddress(rechargeAddress.id, shopifyAddress);

    console.log("Recharge address synced", {
      shopifyCustomerId: customer.id,
      email: customer.email,
      rechargeCustomerId: rechargeCustomer.id,
      rechargeAddressId: rechargeAddress.id,
      webhookId
    });

    res.status(200).json({
      ok: true,
      synced: true,
      rechargeCustomerId: rechargeCustomer.id,
      rechargeAddressId: rechargeAddress.id
    });
  } catch (error) {
    const details = [
      "Shopify to Recharge address sync failed.",
      "",
      `Shopify shop: ${shopDomain}`,
      `Webhook topic: ${topic}`,
      `Webhook ID: ${webhookId || "Not supplied"}`,
      `Shopify customer ID: ${customer && customer.id ? customer.id : "Unknown"}`,
      `Customer email: ${customer && customer.email ? customer.email : "Unknown"}`,
      "",
      `Error: ${error.message}`,
      "",
      "Recharge response:",
      JSON.stringify(error.data || {}, null, 2)
    ].join("\n");

    console.error(details);

    await sendFailureEmail("Recharge address sync failed", details);

    res.status(200).json({
      ok: true,
      synced: false,
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
