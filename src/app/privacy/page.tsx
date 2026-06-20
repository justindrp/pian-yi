export const metadata = {
  title: "Privacy Policy — Pian Yi Catering",
};

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-gray-800 font-sans">
      <h1 className="text-2xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: June 2026</p>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">1. Who we are</h2>
        <p className="text-sm leading-relaxed">
          Pian Yi Catering is a daily meal catering service operating in the
          BSD City, Gading Serpong, Alam Sutera, and Karawaci areas of
          Tangerang Selatan, Indonesia. We can be reached at{" "}
          <a href="mailto:drpramadyo@gmail.com" className="underline">
            drpramadyo@gmail.com
          </a>
          .
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">2. What data we collect</h2>
        <p className="text-sm leading-relaxed mb-2">
          When you contact us via WhatsApp, we collect:
        </p>
        <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
          <li>Your WhatsApp phone number</li>
          <li>Your name (if you provide it)</li>
          <li>Your delivery address and area</li>
          <li>Your order details (meal preferences, portions, schedule)</li>
          <li>Your conversation history with our chatbot</li>
          <li>Payment confirmation information</li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">3. How we use your data</h2>
        <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
          <li>To process and fulfill your catering orders</li>
          <li>To send you order confirmations, reminders, and delivery updates via WhatsApp</li>
          <li>To manage your subscription and remaining meal quota</li>
          <li>To improve our service</li>
        </ul>
        <p className="text-sm leading-relaxed mt-2">
          We do not sell or share your personal data with third parties, except
          for our delivery partners who need your address to complete your order.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">4. WhatsApp messaging</h2>
        <p className="text-sm leading-relaxed">
          Our service uses the WhatsApp Business API to communicate with you.
          By messaging us on WhatsApp, you consent to receiving order-related
          messages from our business number. You can stop receiving messages at
          any time by asking us to delete your account.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">5. Data storage</h2>
        <p className="text-sm leading-relaxed">
          Your data is stored securely in a cloud database hosted in Singapore.
          We retain your data for as long as you are an active customer. If you
          request deletion, we will remove your personal data within 7 business
          days.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">6. Your rights</h2>
        <p className="text-sm leading-relaxed">
          You have the right to access, correct, or delete your personal data
          at any time. To make a request, contact us at{" "}
          <a href="mailto:drpramadyo@gmail.com" className="underline">
            drpramadyo@gmail.com
          </a>{" "}
          or message us directly on WhatsApp.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">7. Changes to this policy</h2>
        <p className="text-sm leading-relaxed">
          We may update this policy from time to time. The latest version will
          always be available at this URL.
        </p>
      </section>
    </main>
  );
}
