const ROUTE_BY_AREA: Record<string, number> = {
  "Alam Sutera": 1,
  "BSD Lama": 1,
  "Gading Serpong": 2,
  "BSD Baru": 2,
  Karawaci: 2,
};

export function getDeliveryRoute(area: string | null | undefined): number | null {
  if (!area) return null;
  return ROUTE_BY_AREA[area] ?? null;
}

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `****${phone.slice(-4)}`;
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}
