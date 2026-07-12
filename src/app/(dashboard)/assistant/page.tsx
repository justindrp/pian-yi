import { AssistantClient } from "@/components/dashboard/assistant-client";
import { PendingBotResponses } from "@/components/dashboard/pending-bot-responses";

export default function AssistantPage() {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold text-[#1C1917]">Assistant</h1>
        <p className="text-sm text-[#78716C] mt-0.5">Tanya tentang pelanggan, pesanan, pengiriman, dan keuangan.</p>
      </div>
      <PendingBotResponses />
      <AssistantClient fullPage />
    </div>
  );
}
