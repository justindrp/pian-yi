export const metadata = {
  title: "Terms of Service — Pian Yi Catering",
};

export default function TermsPage() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-gray-800 font-sans">
      <h1 className="text-2xl font-bold mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: August 2026</p>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">1. Who we are</h2>
        <p className="text-sm leading-relaxed">
          Pian Yi Catering (NIB 2307250135661) is a daily meal catering service
          registered at Jl. Palm Kuning IV Blok BE/06 Sekt.1-3, RT 002/RW 007,
          Kel. Rawabuntu, Kec. Serpong, Kota Tangerang Selatan, Provinsi Banten
          15318, Indonesia. These terms govern your use of our ordering service.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">2. Ordering</h2>
        <p className="text-sm leading-relaxed">
          Orders are placed through our WhatsApp business number. You choose a
          package size in portions; the price per portion depends on the package
          size and is confirmed to you before payment. An order is only
          confirmed once payment has been received and verified by us.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">3. Delivery</h2>
        <p className="text-sm leading-relaxed">
          We deliver Monday to Saturday. We do not deliver on Sundays or on
          Indonesian national public holidays. Delivery is limited to our
          current service areas, which are listed on our home page and may
          change over time.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">4. Order deadline</h2>
        <p className="text-sm leading-relaxed">
          New orders, schedule changes, address changes, and skips for a given
          delivery day must reach us by 16:00 WIB on the day before. Requests
          made after that time will be applied to the next available delivery
          day.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">5. Payment</h2>
        <p className="text-sm leading-relaxed">
          Payment is made by bank transfer in Indonesian Rupiah, in advance, for
          the full package. Bank details are sent to you when you place an
          order. An unpaid order may be cancelled automatically after the period
          stated in your order confirmation.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">
          6. Cancellation and refunds
        </h2>
        <p className="text-sm leading-relaxed">
          You may pause or cancel your remaining meals at any time by messaging
          us, subject to the deadline in section 4. Meals already delivered are
          not refundable. Where we are unable to deliver a meal you have paid
          for, we will either reschedule it or refund it at the price per
          portion recorded on your order.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">7. Food and allergies</h2>
        <p className="text-sm leading-relaxed">
          Menus vary daily and are set by us. We can accommodate a limited set
          of substitutions, which we will confirm to you when you order. We
          cannot guarantee that any meal is free from a specific ingredient or
          allergen, because all food is prepared in a shared kitchen. If you
          have a food allergy, please do not rely on our meals being free of the
          relevant ingredient.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">8. WhatsApp messaging</h2>
        <p className="text-sm leading-relaxed">
          Ordering is handled through an automated assistant on WhatsApp, with
          human staff available. By messaging our business number you agree to
          receive order-related messages from us. You can ask us to stop at any
          time.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">9. Liability</h2>
        <p className="text-sm leading-relaxed">
          Our liability for any order is limited to the amount you paid for that
          order. We are not liable for delays caused by events outside our
          reasonable control, including traffic, weather, and third-party
          courier failures.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="text-base font-semibold mb-2">
          10. Changes and contact
        </h2>
        <p className="text-sm leading-relaxed">
          We may update these terms from time to time; the latest version is
          always at this URL. Questions go to{" "}
          <a href="mailto:drpramadyo@gmail.com" className="underline">
            drpramadyo@gmail.com
          </a>{" "}
          or our WhatsApp number. These terms are governed by the laws of the
          Republic of Indonesia.
        </p>
      </section>

      <p className="text-sm">
        <a href="/" className="underline">
          Back to home
        </a>
      </p>
    </main>
  );
}
