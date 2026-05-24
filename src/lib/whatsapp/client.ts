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

export async function sendImageMessage(
  to: string,
  imageUrl: string,
  caption: string,
): Promise<void> {
  await axios.post(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    },
    { headers: headers() },
  );
}

export async function downloadMedia(mediaId: string): Promise<Buffer> {
  const token = process.env.WHATSAPP_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION;
  // First get the media URL
  const metaRes = await axios.get(
    `https://graph.facebook.com/${version}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const mediaUrl = (metaRes.data as { url: string }).url;
  // Then download the binary
  const dlRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(dlRes.data as ArrayBuffer);
}

export async function sendTypingIndicator(to: string, messageId: string): Promise<void> {
  // Mark the incoming message as read (shows blue double-ticks to customer)
  await axios
    .post(
      `${BASE_URL}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: headers() },
    )
    .catch(() => {});

  // Show typing bubble ("...")
  await axios
    .post(
      `${BASE_URL}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "typing",
      },
      { headers: headers() },
    )
    .catch(() => {});
}
