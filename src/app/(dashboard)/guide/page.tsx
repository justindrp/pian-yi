import type { Metadata } from "next";

export const metadata: Metadata = { title: "Panduan Admin — Pian Yi Catering" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-5 space-y-3">
      <h2 className="font-semibold text-gray-900 text-base">{title}</h2>
      {children}
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2 list-decimal list-inside text-sm text-gray-700 leading-relaxed">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">{children}</p>
  );
}

export default function GuidePage() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Panduan Admin</h1>
        <p className="text-sm text-gray-400 mt-1">Pian Yi Catering — Admin Dashboard</p>
      </div>

      {/* PAYMENTS */}
      <Section title="Pembayaran">
        <Steps items={[
          'Buka halaman Payments di menu.',
          'Pesanan yang sudah upload bukti bayar akan muncul dengan status "Proof Received".',
          'Klik foto bukti pembayaran untuk memperbesar.',
          'Jika pembayaran sesuai, klik "Mark as Paid" — status pesanan berubah jadi aktif dan pesan konfirmasi dikirim otomatis ke pelanggan.',
          'Jika bukti tidak valid atau jumlah tidak sesuai, klik "Reject" — pelanggan akan diberitahu lewat WhatsApp.',
        ]} />
        <Note>Jangan konfirmasi pembayaran sebelum mengecek nominal dan rekening tujuan di foto bukti.</Note>
      </Section>

      {/* ORDERS */}
      <Section title="Pesanan">
        <Steps items={[
          'Buka halaman Orders untuk melihat semua pesanan.',
          'Filter berdasarkan status: Pending Payment, Active, Paused, Completed, atau Cancelled.',
          'Klik pesanan untuk melihat detail: pelanggan, alamat, jadwal, dan harga.',
          'Untuk menghentikan sementara pengiriman (misal pelanggan minta jeda), ubah status ke "Paused".',
          'Setelah periode pesanan selesai, ubah status ke "Completed".',
          'Untuk membatalkan pesanan, pilih status pembatalan yang sesuai (Cancelled by Customer, dll).',
        ]} />
        <Note>Status pesanan hanya bisa diubah ke arah yang sesuai — pesanan aktif tidak bisa langsung ke pending.</Note>
      </Section>

      {/* DELIVERIES */}
      <Section title="Pengiriman Harian">
        <Steps items={[
          'Buka halaman Deliveries.',
          'Pilih tanggal pengiriman yang ingin dilihat (default: hari ini).',
          'Daftar pengiriman menampilkan nama pelanggan, alamat, porsi, dan waktu makan.',
          'Centang pengiriman yang sudah selesai dikirim.',
          'Jika ada masalah pengiriman (dapur libur, dll), catat di kolom catatan.',
        ]} />
        <Note>Lembar pengiriman bisa dibuka dari ponsel — pastikan tanda centang disimpan sebelum menutup halaman.</Note>
      </Section>

      {/* SETTINGS */}
      <Section title="Pengaturan">
        <p className="text-sm font-medium text-gray-600">Menu Mingguan</p>
        <Steps items={[
          'Buka halaman Settings, scroll ke bagian "Weekly Menu".',
          'Upload foto menu baru untuk Dapur 1 dan/atau Dapur 2 dengan klik tombol "Upload" atau "Replace".',
          'Upload juga foto daftar harga jika ada perubahan.',
          'Di kolom teks di bawahnya, ketik menu teks yang akan dibagikan chatbot saat pelanggan tanya menu.',
          'Klik "Save" untuk menyimpan teks menu.',
        ]} />
        <p className="text-sm font-medium text-gray-600 pt-2">Harga</p>
        <Steps items={[
          'Scroll ke bagian "Pricing" di Settings.',
          'Untuk mengubah semua harga sekaligus, gunakan tombol +/− di "Adjust all tiers by" lalu klik "Apply to all".',
          'Untuk mengubah satu tier saja, edit langsung di kolom harga tier tersebut.',
        ]} />
        <Note>Perubahan harga tidak mempengaruhi pesanan yang sudah berjalan — hanya berlaku untuk pesanan baru.</Note>
      </Section>

      {/* CUSTOMERS */}
      <Section title="Data Pelanggan">
        <Steps items={[
          'Buka halaman Customers.',
          'Klik nama pelanggan untuk melihat dan mengedit detail: nama, alamat, area, dan subkontraktor.',
          'Pastikan subkontraktor sudah terassign setelah pesanan pertama masuk.',
          'Untuk melihat riwayat percakapan pelanggan, buka halaman Inbox dan cari nomor HP-nya.',
        ]} />
      </Section>
    </div>
  );
}
