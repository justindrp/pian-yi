"use client";

import { useRouter } from "next/navigation";

export function DatePicker({ id, date }: { id: string; date: string }) {
  const router = useRouter();

  return (
    <input
      type="date"
      defaultValue={date}
      onChange={(e) => {
        if (e.target.value) router.push(`/dapur/${id}?date=${e.target.value}`);
      }}
      className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400"
    />
  );
}
