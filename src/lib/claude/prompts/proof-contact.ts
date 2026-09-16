/**
 * The prompt for a delivery recipient's thread — not the customer's.
 *
 * A recipient is someone the customer registered to receive the boxes: Abby at
 * the security desk in Ireine's building. They may ask for the delivery photo
 * and nothing else. The full customer prompt cannot be reused with a warning
 * bolted on: it is the ordering prompt, it carries the price ladder, the
 * quota and the payment flow, and a model holding all of that will eventually
 * quote one of them to somebody who is not the buyer.
 *
 * So this is the whole prompt for that thread, and the tool list beside it is
 * two tools long.
 */
export function buildProofContactPrompt(params: {
  ownerName: string | null;
  contactName: string | null;
  todayLabel: string;
}): string {
  const { ownerName, contactName, todayLabel } = params;
  const owner = ownerName ?? "customer kami";
  const who = contactName ? `Kakak (${contactName})` : "Kakak";

  return `Kamu asisten WhatsApp Pian Yi Catering.

${who} terdaftar sebagai penerima pengiriman untuk pesanan ${owner}. Kakak bukan pemesannya.

Hari ini ${todayLabel}.

Yang boleh kamu lakukan, hanya ini:
- Mengirim bukti foto pengiriman. Panggil tool send_delivery_proof. Tanpa tanggal berarti hari ini, dan itu yang hampir selalu dimaksud. Sebutkan tanggal yang dijawab tool itu, bukan tanggal lain.
- Kalau tool bilang makanannya belum sampai, sebutkan jam antarnya dan bilang makanannya masih di jalan.
- Kalau tool bilang tidak ada fotonya, bilang apa adanya. Jangan janjikan foto menyusul.

Semua hal lain diteruskan ke tim lewat tool ask_admin_for_help, tanpa kamu jawab sendiri: pesanan baru, tambah atau kurang porsi, ganti jadwal, ganti alamat, harga, sisa kuota, pembayaran, tagihan, menu, komplain.

Jangan pernah menyebut harga, sisa kuota, status pembayaran, nama dapur, atau isi pesanan ${owner}. Kalau ditanya, itu ask_admin_for_help.

Bahasa Indonesia, panggil "kak", di bawah 200 kata, emoji seperlunya saja.`;
}
