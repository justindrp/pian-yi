export const metadata = {
  title: "Data Deletion — Pian Yi Catering",
};

export default function DataDeletionPage() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-gray-800 font-sans">
      <h1 className="text-2xl font-bold mb-2">Data Deletion Request</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: August 2026</p>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">How to request deletion</h2>
        <p className="text-sm leading-relaxed mb-2">
          You can ask us to delete the personal data we hold about you at any
          time, in either of two ways:
        </p>
        <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
          <li>
            Message <strong>&quot;hapus data saya&quot;</strong> to our WhatsApp
            business number, +62 851-1121-4390, from the number you ordered with.
          </li>
          <li>
            Email{" "}
            <a href="mailto:drpramadyo@gmail.com" className="underline">
              drpramadyo@gmail.com
            </a>{" "}
            with the phone number you ordered with, so we can find your records.
          </li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">What we delete</h2>
        <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
          <li>Your name, phone number, and delivery address</li>
          <li>Your conversation history with our WhatsApp assistant</li>
          <li>Your order and delivery schedule records</li>
          <li>Any photos you sent us, including payment confirmations</li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">What we keep</h2>
        <p className="text-sm leading-relaxed">
          We keep financial transaction records where Indonesian tax and
          accounting law requires it. These are retained for the legally
          required period and are not used to contact you.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">How long it takes</h2>
        <p className="text-sm leading-relaxed">
          We confirm receipt of your request within 2 business days and complete
          the deletion within 7 business days. If you have an active paid
          subscription with meals remaining, we will tell you before deleting,
          because deletion ends the subscription.
        </p>
      </section>

      <p className="text-sm">
        <a href="/privacy" className="underline">
          Privacy Policy
        </a>{" "}
        ·{" "}
        <a href="/" className="underline">
          Back to home
        </a>
      </p>
    </main>
  );
}
