export interface WhatsAppMessage {
  messageId: string;
  from: string;
  type: string;
  text?: string;
  imageId?: string;
  imageCaption?: string;
  locationName?: string;
  locationAddress?: string;
  timestamp: string;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        messages?: Array<{
          id: string;
          from: string;
          type: string;
          timestamp: string;
          text?: { body: string };
          image?: { id: string; caption?: string; mime_type?: string };
          location?: { latitude: number; longitude: number; name?: string; address?: string };
        }>;
        statuses?: unknown[];
      };
      field: string;
    }>;
  }>;
}

export function parseMessage(
  payload: WhatsAppWebhookPayload,
): WhatsAppMessage | null {
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return null;
  return {
    messageId: message.id,
    from: message.from,
    type: message.type,
    text: message.text?.body,
    imageId: message.image?.id,
    imageCaption: message.image?.caption,
    locationName: message.location?.name,
    locationAddress: message.location?.address,
    timestamp: message.timestamp,
  };
}

export function getPhoneNumberId(payload: WhatsAppWebhookPayload): string {
  return (
    payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? ""
  );
}
