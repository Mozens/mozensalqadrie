// supabase/functions/send-otp-whatsapp/index.ts
//
// Ini implementasi Supabase "Send SMS Hook" (fitur RESMI Supabase Auth,
// dikonfirmasi masih berlaku per dokumentasi terbaru) - hook ini
// MENGGANTIKAN pengirim SMS bawaan Supabase (Twilio dkk) dengan pengirim
// custom, yang di sini kita arahkan ke WhatsApp lewat Fonnte.
//
// KENAPA INI (bukan bikin sistem auth sendiri dari nol): dengan cara ini,
// seller.html TETAP memakai db.auth.signInWithOtp({ phone }) /
// db.auth.verifyOtp({ phone, ... }) bawaan Supabase - artinya auth.uid()
// yang dihasilkan tetap SAH dan semua RLS policy yang sudah kita susun
// (owner_id = auth.uid() di bich_toko/bich_produk) TIDAK PERLU diubah
// SAMA SEKALI. Yang berubah cuma "kurir" pengiriman kodenya.
//
// ALUR:
//   1. Penjual isi nomor WA di seller.html -> signInWithOtp({ phone })
//   2. Supabase Auth generate kode OTP, lalu (bukan kirim SMS sendiri)
//      memanggil HTTP endpoint ini dengan payload { user, sms: { otp } }
//   3. Function ini verifikasi request itu BENAR dari Supabase (bukan
//      orang random yang nemu URL-nya), lalu kirim kode itu ke nomor WA
//      penjual lewat Fonnte.
//   4. Penjual masukkan kode itu -> verifyOtp({ phone, token, type: 'sms' })
//      -> sesi Supabase Auth normal terbentuk, auth.uid() terisi seperti biasa.
//
// SETUP DI DASHBOARD SUPABASE (wajib, tidak bisa dilakukan lewat kode):
//   1. Authentication > Providers > Phone -> aktifkan "Enable Phone Provider".
//      (Kalau dashboard tetap minta isi kredensial Twilio/provider SMS
//      walau kita mau full lewat hook, isi saja dengan nilai apa pun yang
//      valid formatnya - permintaan akan DICEGAT hook ini sebelum sampai
//      ke provider itu, jadi kredensial itu tidak akan pernah benar-benar
//      dipakai. Screen dashboard bisa berubah - cek langsung UI project Anda.)
//   2. Authentication > Hooks > Send SMS Hook -> pilih "HTTP" -> isi URL
//      ke function ini setelah dideploy, dan Supabase akan generate
//      SIGNING SECRET (format "v1,whsec_....") - salin ke .env sebagai
//      SEND_SMS_HOOK_SECRET.
//   3. Set secrets:
//        supabase secrets set SEND_SMS_HOOK_SECRET=v1,whsec_xxxxxxxx
//        supabase secrets set FONNTE_TOKEN=xxxxxxxx
//
// Deploy:
//   supabase functions deploy send-otp-whatsapp --no-verify-jwt
//   (--no-verify-jwt WAJIB - yang manggil endpoint ini Supabase Auth
//   sendiri via signature khusus di bawah, bukan user dengan sesi JWT biasa)

const SEND_SMS_HOOK_SECRET = Deno.env.get("SEND_SMS_HOOK_SECRET") || "";
const FONNTE_TOKEN = Deno.env.get("FONNTE_TOKEN") || "";

// ---------------------------------------------------------------------------
// VERIFIKASI SIGNATURE - mengikuti spesifikasi Standard Webhooks yang dipakai
// Supabase HTTP Auth Hooks. TANPA verifikasi ini, SIAPA SAJA yang tahu/
// menebak URL function ini bisa memicu pengiriman WA "OTP palsu" ke nomor
// mana pun sesuka mereka (nguras kuota Fonnte / dipakai spam), makanya ini
// bukan langkah opsional.
// ---------------------------------------------------------------------------
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySupabaseWebhook(rawBody: string, headers: Headers): Promise<{ ok: boolean; reason?: string }> {
  if (!SEND_SMS_HOOK_SECRET) return { ok: false, reason: "SEND_SMS_HOOK_SECRET belum diisi di server." };

  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "Header webhook signature tidak lengkap - request kemungkinan bukan dari Supabase." };
  }

  // Cegah replay request lama yang berhasil disadap - tolak kalau timestamp
  // sudah lebih dari 5 menit dari sekarang (baik terlalu lama maupun aneh di masa depan).
  const tsSeconds = parseInt(webhookTimestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > 300) {
    return { ok: false, reason: "Timestamp webhook kedaluwarsa/tidak valid (kemungkinan replay attack)." };
  }

  const secretB64 = SEND_SMS_HOOK_SECRET.replace(/^v1,/, "").replace(/^whsec_/, "");
  const secretBytes = base64ToBytes(secretB64);

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signedContent));
  const expectedSig = bytesToBase64(new Uint8Array(sigBuffer));

  // Header bisa berisi beberapa signature dipisah spasi (mis. saat rotasi
  // secret): "v1,<sigA> v1,<sigB>" - cukup salah satu yang cocok.
  const candidates = webhookSignature
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter(Boolean);

  const match = candidates.some((sig) => constantTimeEqual(sig, expectedSig));
  return match ? { ok: true } : { ok: false, reason: "Signature tidak cocok." };
}

// ---------------------------------------------------------------------------
// KIRIM WA VIA FONNTE
// ---------------------------------------------------------------------------
async function kirimOtpViaFonnte(phone: string, otp: string): Promise<void> {
  if (!FONNTE_TOKEN) {
    throw new Error("FONNTE_TOKEN belum diisi di server.");
  }

  const pesan = `Kode verifikasi Lapak BICH Mart Anda: *${otp}*\n\nJangan bagikan kode ini ke siapa pun, termasuk yang mengaku admin BICH. Kode berlaku beberapa menit.`;

  const res = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: { Authorization: FONNTE_TOKEN },
    body: new URLSearchParams({ target: phone.replace(/^\+/, ""), message: pesan }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Fonnte gagal kirim (${res.status}): ${errText.slice(0, 200)}`);
  }
}

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    const verif = await verifySupabaseWebhook(rawBody, req.headers);
    if (!verif.ok) {
      console.error("[send-otp-whatsapp] Verifikasi signature GAGAL:", verif.reason);
      return jsonError(401, "Signature tidak valid.");
    }

    const payload = JSON.parse(rawBody);
    const phone: string | undefined = payload?.user?.phone;
    const otp: string | undefined = payload?.sms?.otp;

    if (!phone || !otp) {
      console.error("[send-otp-whatsapp] Payload tidak lengkap:", payload);
      return jsonError(400, "Payload tidak lengkap (phone/otp tidak ada).");
    }

    await kirimOtpViaFonnte(phone.startsWith("+") ? phone : `+${phone}`, otp);

    // DIBERSIHKAN: Wajib kembalikan JSON {} & Header Content-Type agar Supabase Auth tidak Error 400
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[send-otp-whatsapp] Error:", err);
    return jsonError(500, "Gagal mengirim kode OTP via WhatsApp: " + String(err));
  }
});

// Format error sesuai kontrak Auth Hook Supabase - lihat dokumentasi
// "Error handling": { error: { http_code, message } }.
function jsonError(httpCode: number, message: string) {
  return new Response(
    JSON.stringify({ error: { http_code: httpCode, message } }),
    { status: httpCode, headers: { "Content-Type": "application/json" } }
  );
}