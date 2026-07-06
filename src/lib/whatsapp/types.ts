export interface WhatsAppMessage {
  messageId: string;
  from: string;
  type: string;
  text?: string;
  imageId?: string;
  imageCaption?: string;
  locationName?: string;
  locationAddress?: string;
  locationLat?: number;
  locationLng?: number;
  timestamp: string;
  contactName?: string;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: Array<{
          id: string;
          from: string;
          type: string;
          timestamp: string;
          text?: { body: string };
          image?: { id: string; caption?: string; mime_type?: string };
          location?: {
            latitude: number;
            longitude: number;
            name?: string;
            address?: string;
          };
        }>;
        statuses?: unknown[];
      };
      field: string;
    }>;
  }>;
}

export interface WhatsAppStatusUpdate {
  messageId: string;
  status: string;
  timestamp?: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseMessage(
  payload: WhatsAppWebhookPayload,
): WhatsAppMessage | null {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return null;
  return {
    messageId: message.id,
    from: message.from.startsWith("+") ? message.from : `+${message.from}`,
    type: message.type,
    text: message.text?.body,
    imageId: message.image?.id,
    imageCaption: message.image?.caption,
    locationName: message.location?.name,
    locationAddress: message.location?.address,
    locationLat: message.location?.latitude,
    locationLng: message.location?.longitude,
    timestamp: message.timestamp,
    contactName: value?.contacts?.[0]?.profile?.name,
  };
}

export function getPhoneNumberId(payload: WhatsAppWebhookPayload): string {
  return (
    payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? ""
  );
}

export function parseStatusUpdates(
  payload: WhatsAppWebhookPayload,
): WhatsAppStatusUpdate[] {
  const statuses = payload.entry?.[0]?.changes?.[0]?.value?.statuses;
  if (!Array.isArray(statuses)) return [];

  return statuses.flatMap((status): WhatsAppStatusUpdate[] => {
    if (!isObject(status)) return [];
    const messageId = status.id;
    const state = status.status;
    if (typeof messageId !== "string" || typeof state !== "string") return [];

    const rawErrors = status.errors;
    const errors = Array.isArray(rawErrors)
      ? rawErrors.flatMap((e): Array<{ code: number; title: string; message?: string }> => {
          if (!isObject(e)) return [];
          return [{ code: Number(e.code), title: String(e.title), message: typeof e.message === "string" ? e.message : undefined }];
        })
      : undefined;

    return [
      {
        messageId,
        status: state,
        timestamp:
          typeof status.timestamp === "string" ? status.timestamp : undefined,
        errors: errors?.length ? errors : undefined,
      },
    ];
  });
}
