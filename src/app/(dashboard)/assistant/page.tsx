import { AssistantClient } from "@/components/dashboard/assistant-client";

export default function AssistantPage() {
  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto px-4">
      <div className="py-4 border-b">
        <h1 className="text-xl font-semibold">Assistant</h1>
        <p className="text-sm text-gray-500 mt-0.5">Ask questions about customers, orders, deliveries, and financials.</p>
      </div>
      <AssistantClient fullPage />
    </div>
  );
}
