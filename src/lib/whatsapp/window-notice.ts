// What we tell customers about WhatsApp's 24-hour customer service window.
//
// Meta blocks a business from writing first once 24 hours have passed since the
// customer's last inbound message, and nothing we send reopens it — only they
// can. Customers do not know this, so our enforced silence reads as being
// ignored. On 2026-08-18 a customer whose delivery had been missed asked "masa
// harus saya yang follow up tiap hari??" and threatened a refund; he had no way
// to know we were locked out. The rule is Meta's and cannot be worked around,
// so the only honest fix is to say it up front and ask them plainly to write.
//
// Two lengths, both ending on the same ask. The long one is its own bubble at
// the end of the welcome sequence, where a new customer has the attention for
// it. The short one rides along on order confirmations — the moment a customer
// has just paid and has no reason to message again for days, which is exactly
// how a window closes unnoticed.

export const WINDOW_NOTICE_WELCOME = [
  "*Penting — cara menghubungi kami* 📱",
  "",
  "WhatsApp punya aturan kak: bisnis cuma boleh mengirim pesan dalam 24 jam sejak pesan terakhir dari kakak. Lewat dari itu jalurnya otomatis terkunci dari WhatsApp-nya, jadi kami nggak bisa memulai chat duluan walaupun kami mau.",
  "",
  "Jadi kalau chat kami terlihat berhenti, bukan kami diamkan ya kak 🙏",
  "",
  "*Kalau sudah lewat 24 jam dari chat terakhir, kakak chat kami duluan ya kak* — mau pesan, ganti jadwal, ganti alamat, atau ada yang kurang pas. Kirim satu pesan apa aja, jalurnya langsung kebuka dan kami bisa balas lagi 😊",
].join("\n");

// One clause, for messages that already ask the customer to reply — the daily
// delivery-proof "balas ok" above all. Those go out every delivery, so the full
// notice would turn into wallpaper; what they were missing is only the *reason*
// the reply matters.
export const WINDOW_NOTICE_CLAUSE =
  "biar jalur chat kita tetap kebuka ya kak — WhatsApp mengunci chat kalau lewat 24 jam tanpa balasan dari kakak";

export const WINDOW_NOTICE_SHORT =
  "Oh iya kak, WhatsApp cuma mengizinkan kami mengirim pesan dalam 24 jam sejak pesan terakhir kakak — lewat dari itu jalurnya terkunci dan kami nggak bisa chat duluan. Jadi kalau sudah lewat 24 jam dan ada apa-apa, kakak chat kami duluan ya kak, langsung kami balas 😊";

/**
 * Approved Meta template carrying the same notice (WABA 1603294840784079,
 * language `id`, one body param: the customer's name). A template is the only
 * way to reach a customer whose 24h window has already closed — free-form text
 * is rejected with error 131047.
 */
export const WINDOW_NOTICE_TEMPLATE = "jendela_24_jam";
