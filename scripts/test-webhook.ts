#!/usr/bin/env tsx
/**
 * Simulate an incoming WhatsApp message against the local dev server.
 *
 * Usage:
 *   pnpm test:webhook "Halo mau pesan"
 *   pnpm test:webhook "Halo mau pesan" +628123456789
 *
 * Requires .env.local with WHATSAPP_APP_SECRET set.
 * Start the dev server first: pnpm dev
 */
import crypto from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
if (!APP_SECRET) {
  console.error("WHATSAPP_APP_SECRET not set in .env.local");
  process.exit(1);
}

const BASE_URL = process.env.TEST_WEBHOOK_URL ?? "http://localhost:3000";
const messageText = process.argv[2] ?? "Halo";
const fromPhone = process.argv[3] ?? (process.env.TEST_PHONE ?? "628111222333");
const messageId = `test_${Date.now()}`;
const timestamp = String(Math.floor(Date.now() / 1000));

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "test_entry_id",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "6281234567890",
              phone_number_id: "test_phone_number_id",
            },
            messages: [
              {
                id: messageId,
                from: fromPhone,
                timestamp,
                type: "text",
                text: { body: messageText },
              },
            ],
            contacts: [
              { profile: { name: "Test Customer" }, wa_id: fromPhone },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const sig = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;

console.log(`Sending: "${messageText}"`);
console.log(`From:    ${fromPhone}`);
console.log(`MsgID:   ${messageId}`);
console.log(`URL:     ${BASE_URL}/api/webhook/whatsapp`);
console.log("---");

const res = await fetch(`${BASE_URL}/api/webhook/whatsapp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-hub-signature-256": sig,
  },
  body,
});

console.log(`Status: ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(`Body:   ${text}`);
console.log("\nBot processes the message async — watch dev server logs for output.");
console.log("The bot reply goes via WhatsApp API (use ngrok + real number to see replies).");
