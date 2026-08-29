"use client";

import { useRouter } from "next/navigation";
import type { OrderSize } from "@/lib/orders/size";

export function DatePicker({
  id,
  date,
  size,
}: {
  id: string;
  date: string;
  size: OrderSize | null;
}) {
  const router = useRouter();

  return (
    <input
      type="date"
      defaultValue={date}
      onChange={(e) => {
        if (!e.target.value) return;
        // Keep the S/M tab across a date change — the cook picked it once.
        const tab = size ? `&size=${size}` : "";
        router.push(`/dapur/${id}?date=${e.target.value}${tab}`);
      }}
      className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400"
    />
  );
}
