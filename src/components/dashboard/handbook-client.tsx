"use client";

import Link from "next/link";
import { useState } from "react";

type Tier = { portions: number; price_per_portion: number };

type Facts = {
  areas: string[];
  deadlineHour: number;
  tiers: Tier[];
  nicknames: string[];
  /** One "Nickname: Senin–Sabtu" per active kitchen. */
  schedules: string[];
};

type Lang = "id" | "en";

type Block =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "rule"; text: string }
  | { kind: "ladder" };

type Section = { title: string; blocks: Block[] };

const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

const p = (text: string): Block => ({ kind: "p", text });
const list = (items: string[]): Block => ({ kind: "list", items });
const rule = (text: string): Block => ({ kind: "rule", text });

function contentId(f: Facts): Section[] {
  const areas = f.areas.join(", ");
  const kitchens = f.nicknames.join(", ");
  return [
    {
      title: "Bisnis ini",
      blocks: [
        p(
          "Pian Yi Catering menjual paket makan harian di Tangerang Selatan. Pelanggan membayar di muka untuk sejumlah porsi, lalu menarik porsi itu hari demi hari. Satu paket bisa habis dalam seminggu atau berbulan-bulan.",
        ),
        p(
          "Masakannya bukan kami yang bikin. Ada beberapa dapur partner yang memasak dan mengantar; kami yang menerima pesanan, menagih, menjadwalkan, dan menjawab pelanggan.",
        ),
        p(
          "Dua jenis pengguna: pelanggan yang hanya lewat WhatsApp, dan admin yang memakai dashboard ini.",
        ),
      ],
    },
    {
      title: "Pelanggan bicara dengan bot, bukan dengan kita",
      blocks: [
        p(
          "Setiap pesan WhatsApp masuk dijawab chatbot AI dalam Bahasa Indonesia. Bot yang menjelaskan menu, menghitung harga, mencatat pesanan, dan mengirim instruksi transfer.",
        ),
        p(
          "Tugas admin bukan mengetik balasan sehari-hari, tapi mengawasi: cek Inbox, pastikan bot tidak salah paham, dan tangani yang bot tidak bisa (pembayaran, komplain, perubahan jadwal rumit).",
        ),
        rule(
          "Verifikasi pembayaran selalu manual. Bukti transfer masuk ke halaman Payments dan manusia yang memutuskan lunas atau tidak.",
        ),
      ],
    },
    {
      title: "Peranmu: admin, bukan owner",
      blocks: [
        p(
          "Ada dua peran. Owner (Justin, Annie, Friska) bisa semuanya. Admin bisa semuanya kecuali dua hal: halaman Accounting, dan mengetik langsung ke pelanggan.",
        ),
        p(
          "Batasan itu dijaga server, bukan cuma disembunyikan di tampilan. Menekan tombol yang tidak seharusnya akan ditolak, bukan diam-diam jalan.",
        ),
        list([
          "Bisa: Inbox, Customers, Orders, Deliveries, Payments, Broadcasts, Assistant, Activity, Settings.",
          "Tidak bisa: Accounting (COGS, margin, jurnal).",
          "Tidak bisa: ambil alih chat lalu mengetik sendiri ke pelanggan.",
        ]),
      ],
    },
    {
      title: "Kalau bot salah jawab",
      blocks: [
        p(
          "Jangan cari tombol Take over di Inbox — untuk peran admin tombol itu tidak ada lagi. Kirim koreksinya lewat Assistant.",
        ),
        p(
          "Buka Assistant, sebutkan pelanggannya dan apa yang mau dikirim. Assistant menampilkan kartu konfirmasi dulu; kamu yang menyetujui, baru pesannya terkirim, tercatat di Inbox, dan tercatat siapa yang mengirim.",
        ),
        p(
          "Alasannya bukan soal kepercayaan. Mengambil alih chat membuat bot bisu untuk pelanggan itu, dan semua yang biasanya bot kerjakan sendiri — terutama menulis jadwal pengiriman satu paket — jadi tugas manusia yang harus diingat. Satu pelanggan pernah kehilangan tiga dari lima hari paketnya karena itu.",
        ),
        rule(
          "Bot salah = kirim koreksi lewat Assistant. Kalau butuh percakapan panjang atau pelanggan marah, minta owner yang ambil alih.",
        ),
      ],
    },
    {
      title: "Perjalanan satu pesanan",
      blocks: [
        p(
          "Status pesanan berjalan berurutan, dan status itulah sumber kebenarannya — bukan ingatan atau catatan di chat.",
        ),
        list([
          "pending_payment — pesanan dicatat, belum bayar.",
          "payment_proof_received — bukti transfer masuk, menunggu diperiksa.",
          "active — sudah lunas, porsi bisa ditarik.",
          "paused — pelanggan minta jeda sementara.",
          "completed — semua porsi sudah diantar.",
          "Ditambah beberapa status pembatalan.",
        ]),
        rule(
          "Satu pembelian = satu pesanan. Kalau pelanggan menambah porsi sebelum bayar, pesanan yang lama diubah, bukan dibuat pesanan kedua.",
        ),
      ],
    },
    {
      title: "Harga",
      blocks: [
        p(
          "Harga per porsi turun mengikuti jumlah porsi yang dibeli. Ini daftar yang dipakai sistem hari ini:",
        ),
        { kind: "ladder" },
        p(
          "Total yang tidak persis ada di daftar tapi habis dibagi 5 atau 6 tetap boleh dijual, memakai tarif ukuran terdaftar terbesar di bawahnya. Jangan pernah menjumlahkan beberapa paket kecil — pelanggan jadi bayar lebih mahal untuk pesanan yang lebih besar.",
        ),
        p(
          "Pelanggan korporat bisa punya harga kontrak sendiri yang mengabaikan daftar ini. Pesanan yang sudah dibuat mengunci harganya di harga saat itu.",
        ),
      ],
    },
    {
      title: "Pengiriman dan batas waktu",
      blocks: [
        p(
          `Hari kerja per dapur: ${f.schedules.join("; ") || "(belum ada dapur aktif)"}. Libur nasional tutup. Batas pemesanan pukul ${String(f.deadlineHour).padStart(2, "0")}.00 WIB sehari sebelumnya — batas yang sama berlaku untuk perubahan dan permintaan skip, bukan cuma pesanan baru.`,
        ),
        rule(
          "Hari kerja itu milik dapur, bukan milik perusahaan. Ada dapur yang masak hari Minggu dan ada yang libur Sabtu, jadi jangan pernah bilang \u201cMinggu tutup\u201d ke customer sebelum melihat dapur yang melayani dia.",
        ),
        p(
          `Area yang dilayani sekarang: ${areas || "(belum ada dapur aktif)"}.`,
        ),
        rule(
          "Daftar area itu bukan daftar tetap. Setiap dapur punya daftarnya sendiri, dan yang kamu lihat adalah gabungan dapur yang sedang aktif. Ada area yang hanya dilayani satu dapur — menonaktifkan dapur itu menghapus areanya. Jangan pernah menghafal atau menyalin daftar ini.",
        ),
      ],
    },
    {
      title: "Sisa kuota — jebakan yang paling sering",
      blocks: [
        p(
          "Kalau pelanggan bertanya 'sisa berapa?', jangan baca angka sisa porsi di pesanan mentah-mentah. Angka itu artinya porsi yang belum dijadwalkan, bukan porsi yang belum diantar.",
        ),
        p(
          "Pelanggan yang seluruh paketnya sudah masuk kalender akan terbaca 0, padahal makanannya belum diantar sama sekali.",
        ),
        p(
          "Yang benar ada di ledger pelanggan: buka halaman Customers, klik pelanggannya, lihat bagian Riwayat pemakaian. Di situ setiap paket masuk sebagai +N dan setiap penarikan harian sebagai −N, lalu ada Sisa hari ini di baris paling bawah. Itulah angka yang sah.",
        ),
        rule(
          "Bot kadang menyebut sisa kuota yang salah ke pelanggan. Kalau ada pelanggan bertanya atau protes soal sisa porsinya, buka ledger dan cek sendiri sebelum menjawab — ledger yang benar, bukan bot.",
        ),
      ],
    },
    {
      title: "Dapur partner itu rahasia",
      blocks: [
        p(
          `Pelanggan tidak boleh tahu dapur mana yang memasak. Ke pelanggan, dapur hanya disebut dengan nama samaran: ${kitchens || "(belum ada dapur aktif)"}. Di luar itu, sebut saja 'dapur partner kami'.`,
        ),
        p(
          "Yang rahasia adalah dapur yang mana, bukan bahwa kami bekerja dengan dapur partner. Kalau pelanggan menyebut nama sebuah dapur, jangan dibenarkan dan jangan dibantah. Bilang 'kami masak sendiri' adalah kebohongan yang bisa ketahuan.",
        ),
        rule(
          "Jangan pernah menyebut nama asli dapur, harga modal, atau margin ke pelanggan. Kalau ada error teknis, jelaskan seadanya dan umum — jangan tempelkan pesan error sistem.",
        ),
      ],
    },
    {
      title: "Bukti pengiriman dan jendela 24 jam",
      blocks: [
        p(
          "WhatsApp hanya mengizinkan kami mengirim pesan bebas dalam 24 jam setelah pelanggan terakhir mengirim pesan. Lewat dari itu, hanya template resmi yang bisa lewat. Inbox menampilkan sisa waktunya.",
        ),
        p(
          "Saat ini semua pengiriman di luar jendela itu gagal karena ada pembatasan pembayaran di akun WhatsApp Business kami. Artinya: bukti pengiriman ke pelanggan yang sudah lama diam tidak akan sampai, dan itu bukan kesalahanmu.",
        ),
        rule(
          "Kalau sesuatu penting dan jendelanya tertutup, telepon pelanggannya. Jangan anggap pesan terkirim hanya karena tombolnya sudah ditekan.",
        ),
      ],
    },
    {
      title: "Semua tindakan tercatat",
      blocks: [
        p(
          "Setiap perubahan lewat dashboard dicatat: siapa, kapan, dan field apa yang berubah. Bisa dibaca di halaman Activity.",
        ),
        p(
          "Ini bukan pengawasan, ini supaya kesalahan bisa ditelusuri. Kalau kamu salah tekan, bilang saja — jauh lebih cepat diperbaiki kalau kita tahu apa yang berubah.",
        ),
      ],
    },
    {
      title: "Hari pertama",
      blocks: [
        list([
          "Baca Inbox dari atas sampai bawah sekali sehari. Cari pelanggan yang bertanya dan belum dijawab.",
          "Cek halaman Deliveries untuk besok sebelum batas waktu sore. Yang harus ada tapi belum ada, itu yang bikin masalah.",
          "Bukti transfer masuk? Cek nominal dan nama di halaman Payments sebelum menandai lunas.",
          "Ragu soal harga, jadwal, atau keluhan? Tanya Justin. Menebak lebih mahal daripada bertanya.",
        ]),
      ],
    },
  ];
}

function contentEn(f: Facts): Section[] {
  const areas = f.areas.join(", ");
  const kitchens = f.nicknames.join(", ");
  return [
    {
      title: "What this business is",
      blocks: [
        p(
          "Pian Yi Catering sells prepaid daily meal packages in Tangerang Selatan. A customer pays up front for a number of portions and then draws them down day by day. One package can be finished in a week or stretched over months.",
        ),
        p(
          "We do not cook. Partner kitchens cook and deliver; we take the orders, collect the money, build the schedule and answer the customer.",
        ),
        p(
          "Two kinds of user: customers, who only ever use WhatsApp, and admins, who use this dashboard.",
        ),
      ],
    },
    {
      title: "Customers talk to the bot, not to us",
      blocks: [
        p(
          "Every inbound WhatsApp message is answered by an AI chatbot in Indonesian. It explains the menu, quotes prices, records orders and sends payment instructions.",
        ),
        p(
          "An admin's job is not to type the day-to-day replies. It is to watch: read the Inbox, catch the bot misunderstanding something, and handle what it cannot — payments, complaints, awkward schedule changes.",
        ),
        rule(
          "Payment verification is always manual. Transfer proofs land on the Payments page and a human decides whether it is paid.",
        ),
      ],
    },
    {
      title: "Your role: admin, not owner",
      blocks: [
        p(
          "Two roles. Owners (Justin, Annie, Friska) can do everything. Admins can do everything except two things: the Accounting page, and typing directly to a customer.",
        ),
        p(
          "Those limits are enforced on the server, not merely hidden in the UI. Pressing something you should not have runs into a refusal, not a silent success.",
        ),
        list([
          "Yours: Inbox, Customers, Orders, Deliveries, Payments, Broadcasts, Assistant, Activity, Settings.",
          "Not yours: Accounting (COGS, margins, the journal).",
          "Not yours: taking a chat over and hand-typing to the customer.",
        ]),
      ],
    },
    {
      title: "When the bot answers wrong",
      blocks: [
        p(
          "Do not look for a Take over button in the Inbox — for the admin role it is no longer there. Send the correction through the Assistant instead.",
        ),
        p(
          "Open Assistant, name the customer and say what should go out. The Assistant shows you a confirmation card first; you approve it, and only then is the message sent, logged in the Inbox, and attributed to you.",
        ),
        p(
          "The reason is not trust. Taking a thread over silences the bot for that customer, and everything the bot would have done unprompted — above all writing a package's delivery schedule — quietly becomes a human's job to remember. One customer lost three of his five paid days that way.",
        ),
        rule(
          "Bot got it wrong? Send the correction via the Assistant. If it needs a real back-and-forth, or the customer is angry, ask an owner to take the thread.",
        ),
      ],
    },
    {
      title: "The life of an order",
      blocks: [
        p(
          "An order moves through statuses in sequence, and that status is the source of truth — not memory, not what the chat says.",
        ),
        list([
          "pending_payment — order recorded, not paid.",
          "payment_proof_received — transfer proof in, waiting to be checked.",
          "active — paid, portions can be drawn.",
          "paused — customer asked for a break.",
          "completed — every portion delivered.",
          "Plus a few cancellation statuses.",
        ]),
        rule(
          "One purchase, one order. If a customer adds portions before paying, the existing order is amended — never a second order.",
        ),
      ],
    },
    {
      title: "Pricing",
      blocks: [
        p(
          "Price per portion falls as the package gets bigger. This is the ladder the system is using right now:",
        ),
        { kind: "ladder" },
        p(
          "A total that is not on the list but divides by 5 or 6 can still be sold, at the rate of the largest listed size below it. Never add up several smaller packages — that charges more for a bigger order.",
        ),
        p(
          "Corporate customers can carry a contract price that replaces the ladder entirely. An order locks its price at the moment it is created.",
        ),
      ],
    },
    {
      title: "Delivery and the cutoff",
      blocks: [
        p(
          `Working days per kitchen: ${f.schedules.join("; ") || "(no active kitchen)"}. National holidays closed. Orders close at ${String(f.deadlineHour).padStart(2, "0")}:00 WIB the day before — and that same cutoff governs changes and skip requests, not just new orders.`,
        ),
        rule(
          "Working days belong to the kitchen, not to the company. One kitchen cooks Sunday and another rests on Saturday, so never tell a customer Sunday is closed before checking which kitchen serves them.",
        ),
        p(`Areas served right now: ${areas || "(no active kitchen)"}.`),
        rule(
          "That list is not fixed. Each kitchen carries its own areas, and what you see is the union of the kitchens currently active. Some areas rest on a single kitchen, so deactivating it removes the area outright. Never memorise or copy this list.",
        ),
      ],
    },
    {
      title: "Remaining quota — the trap everyone hits",
      blocks: [
        p(
          "When a customer asks how much they have left, do not read the order's remaining-portions number straight out. It means portions not yet scheduled, not portions not yet delivered.",
        ),
        p(
          "A customer whose whole package is already on the calendar reads 0 while still being owed every meal.",
        ),
        p(
          "The real number is in the customer's ledger: Customers page, click the customer, look at Riwayat pemakaian. Every package lands there as +N and every daily draw as −N, with Sisa hari ini on the last line. That is the number that counts.",
        ),
        rule(
          "The bot sometimes quotes a customer the wrong remaining quota. Whenever a customer asks about their balance or disputes it, open the ledger and check for yourself before replying — the ledger is right, the bot is not always.",
        ),
      ],
    },
    {
      title: "Partner kitchens are confidential",
      blocks: [
        p(
          `Customers must never learn which kitchen cooks their food. To a customer, a kitchen only ever has a nickname: ${kitchens || "(no active kitchen)"}. Otherwise say "dapur partner kami".`,
        ),
        p(
          "What is confidential is which kitchens, not that partner kitchens exist. If a customer names a supplier, neither confirm nor deny — claiming we cook it ourselves is a lie they can find out.",
        ),
        rule(
          "Never give a customer a kitchen's real name, our cost, or our margin. If something breaks, keep the explanation plain and generic — never paste a system error.",
        ),
      ],
    },
    {
      title: "Delivery proofs and the 24-hour window",
      blocks: [
        p(
          "WhatsApp only lets us send freely for 24 hours after the customer's last message. After that only approved templates get through. The Inbox shows how long is left.",
        ),
        p(
          "Right now every send outside that window fails, because of a payment restriction on our WhatsApp Business account. So a delivery proof to a customer who has been quiet will not arrive — and that is not your fault.",
        ),
        rule(
          "If something matters and the window is shut, phone the customer. Never assume a message went out just because you pressed send.",
        ),
      ],
    },
    {
      title: "Everything is recorded",
      blocks: [
        p(
          "Every change made through the dashboard records who made it, when, and which fields moved. You can read it on the Activity page.",
        ),
        p(
          "This is not surveillance, it is traceability. If you press the wrong thing, say so — it is far faster to fix when we know what changed.",
        ),
      ],
    },
    {
      title: "Your first day",
      blocks: [
        list([
          "Read the Inbox top to bottom once a day. Look for customers who asked something and got nothing.",
          "Check tomorrow's Deliveries page before the afternoon cutoff. What should be there and isn't is what causes trouble.",
          "A transfer proof arrived? Check the amount and the sender name on the Payments page before marking it paid.",
          "Unsure about a price, a schedule or a complaint? Ask Justin. Guessing costs more than asking.",
        ]),
      ],
    },
  ];
}

export default function HandbookClient(props: Facts) {
  const [lang, setLang] = useState<Lang>("id");
  const sections = lang === "id" ? contentId(props) : contentEn(props);

  return (
    <div className="pb-10">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">
          {lang === "id" ? "Panduan" : "Handbook"}
        </h1>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(["id", "en"] as const).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              className={`px-3 py-1.5 transition-colors ${
                lang === code
                  ? "bg-amber-500 text-white font-medium"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {code === "id" ? "Bahasa" : "English"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        {lang === "id" ? (
          <>
            Untuk admin baru. Sekali baca, lalu kembali ke sini kalau lupa. Cara
            mengklik tiap halaman ada di{" "}
            <Link
              href="/guide"
              className="text-amber-700 underline underline-offset-2"
            >
              Panduan Admin
            </Link>
            .
          </>
        ) : (
          <>
            For a new admin. Read it once, come back when something is unclear.
            The click-by-click for each page is in{" "}
            <Link
              href="/guide"
              className="text-amber-700 underline underline-offset-2"
            >
              Panduan Admin
            </Link>
            .
          </>
        )}
      </p>

      <div className="space-y-4">
        {sections.map((section, i) => (
          <section
            key={section.title}
            className="bg-white border border-gray-100 rounded-xl p-5"
          >
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              <span className="text-gray-300 mr-2">{i + 1}</span>
              {section.title}
            </h2>
            <div className="space-y-3">
              {section.blocks.map((block, j) => (
                <Block
                  // biome-ignore lint/suspicious/noArrayIndexKey: static prose, order never changes
                  key={j}
                  block={block}
                  tiers={props.tiers}
                  lang={lang}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Block({
  block,
  tiers,
  lang,
}: {
  block: Block;
  tiers: Tier[];
  lang: Lang;
}) {
  if (block.kind === "p") {
    return (
      <p className="text-sm text-gray-600 leading-relaxed">{block.text}</p>
    );
  }
  if (block.kind === "list") {
    return (
      <ul className="space-y-1.5">
        {block.items.map((item) => (
          <li
            key={item}
            className="text-sm text-gray-600 leading-relaxed flex gap-2"
          >
            <span className="text-gray-300 select-none">—</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === "rule") {
    return (
      <p className="text-sm text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 leading-relaxed">
        {block.text}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-sm min-w-[16rem]">
        <thead>
          <tr className="text-xs text-gray-400 text-left">
            <th className="pr-6 pb-1 font-medium">
              {lang === "id" ? "Porsi" : "Portions"}
            </th>
            <th className="pb-1 font-medium">
              {lang === "id" ? "Harga per porsi" : "Price per portion"}
            </th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier) => (
            <tr key={tier.portions}>
              <td className="pr-6 py-0.5 text-gray-600 tabular-nums">
                {tier.portions}
              </td>
              <td className="py-0.5 text-gray-900 tabular-nums">
                {rupiah(tier.price_per_portion)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
