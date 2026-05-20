import axios from "axios";

const BASE_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
});

export async function sendTextMessage(to: string, text: string): Promise<void> {
  await axios.post(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: headers() },
  );
}

export async function sendTypingIndicator(to: string): Promise<void> {
  await axios
    .post(
      `${BASE_URL}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: to,
      },
      { headers: headers() },
    )
    .catch(() => {
      // typing indicators are best-effort
    });
}
