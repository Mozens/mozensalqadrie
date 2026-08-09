// supabase/functions/create-payment-layanan/index.ts
//
// Menggantikan alur Midtrans Snap (window.snap.pay) di monetisasi.html,
// pariwisata.html, dan langganan.html (jalur manual) dengan iPaymu redirect.
//
// PRINSIP SAMA seperti create-payment (Mart): harga TIDAK PERNAH dipercaya
// dari klien. Katalog harga di bawah ini adalah SATU-SATUNYA sumber
// kebenaran harga, harus sama persis dengan yang ditampilkan di UI
// (kalau nanti harga di UI diubah, WAJIB diubah juga di sini).
//
// Deploy:
//   supabase functions deploy create-payment-layanan

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const IPAYMU_PAY_URL =
  IPAYMU_ENV === "production" ? "https://my.ipaymu.com/api/v2/payment" : "https://sandbox.ipaymu.com/api/v2/payment";

// ------------------------------------------------------------------
// KATALOG HARGA RESMI — HARUS SAMA dengan yang tampil di UI (kalau
// beda, itu bug, bukan fitur). Ini yang menentukan nominal ditagih,
// bukan apa pun yang dikirim dari browser.
// ------------------------------------------------------------------
const KATALOG: Record<string, { nama: string; harga: number }> = {
  LOKER_STANDARD: { nama: "Loker Premium - Standard (30 hari)", harga: 750_000 },
  LOKER_FEATURED: { nama: "Loker Premium - Featured (30 hari)", harga: 1_500_000 },
  LOKER_URGENT: { nama: "Loker Premium - Urgent Boost (14 hari)", harga: 2_500_000 },
  CV_SINGLE: { nama: "Assessment CV AI - Single Scan", harga: 49_000 },
  CV_BUNDLE: { nama: "Assessment CV AI - Scan + Konsultasi", harga: 149_000 },
  SAWIT_BASIC: { nama: "Alert Harga Sawit - Basic (1 bulan)", harga: 20_000 },
  SAWIT_PLUS: { nama: "Alert Harga Sawit - Plus (1 bulan)", harga: 35_000 },
  IKN_BASIC: { nama: "Briefing IKN Bisnis - Basic (1 bulan)", harga: 300_000 },
  IKN_PRIORITAS: { nama: "Briefing IKN Bisnis - Prioritas (1 bulan)", harga: 500_000 },
};

// Tarif travel SEKARANG diambil dari tabel tarif_travel_rute &
// tarif_travel_layanan (admin-editable lewat redaksi.html), BUKAN
// hardcode di sini. Ini memastikan harga yang ditagihkan ke pembeli
// selalu mengikuti tarif terbaru yang di-set admin, tanpa perlu
// deploy ulang function ini tiap kali harga berubah.
async function hitungHargaTravel(origin: string, destination: string, serviceType: string): Promise<{ harga: number; unit: string }> {
  const { data: rows, error } = await supabaseAdmin
    .from("tarif_travel_rute")
    .select("route_key, harga")
    .in("route_key", [`${origin}_${destination}`, "AIRPORT", "DEFAULT"]);

  if (error) throw new Error("Gagal mengambil tarif rute: " + error.message);

  const rateMap = new Map((rows ?? []).map((r) => [r.route_key, r.harga]));
  let harga: number;
  let unit = "/ kursi (Door-to-Door)";

  if (origin.includes("AIRPORT") || destination.includes("AIRPORT")) {
    harga = rateMap.get("AIRPORT") ?? 150_000;
    unit = "/ penjemputan airport";
  } else {
    harga = rateMap.get(`${origin}_${destination}`) ?? rateMap.get("DEFAULT") ?? 250_000;
  }

  const { data: layanan, error: errLayanan } = await supabaseAdmin
    .from("tarif_travel_layanan")
    .select("tipe, nilai, unit_label")
    .eq("service_type", serviceType)
    .maybeSingle();

  if (errLayanan) throw new Error("Gagal mengambil tarif layanan: " + errLayanan.message);

  if (layanan) {
    unit = layanan.unit_label;
    if (layanan.tipe === "flat") {
      harga = Number(layanan.nilai);
    } else {
      harga = Math.round(harga * Number(layanan.nilai));
    }
  }

  return { harga, unit };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { service, planCode, customer, origin, destination, serviceType, billingMode, manualSubId } = body;

    if (!service || !customer) {
      return json({ error: "Data tidak lengkap." }, 400);
    }

    let nama_produk: string;
    let harga: number;

    if (service === "travel") {
      if (!origin || !destination || !serviceType) {
        return json({ error: "Rute/layanan travel tidak lengkap." }, 400);
      }
      const hasil = await hitungHargaTravel(origin, destination, serviceType);
      harga = hasil.harga;
      nama_produk = `Travel/Shuttle: ${origin} -> ${destination} (${serviceType})`;
    } else {
      const item = KATALOG[planCode];
      if (!item) return json({ error: `Kode paket "${planCode}" tidak dikenal.` }, 400);
      harga = item.harga;
      nama_produk = item.nama;
    }

    // 'sawit' dan 'ikn' -> masuk tabel user_subscriptions (recurring, tapi
    // untuk sekarang billing_mode dipaksa 'manual' - lihat catatan di atas).
    const isLangganan = service === "sawit" || service === "ikn";

    let refId: string;

    if (isLangganan) {
      if (billingMode === "auto") {
        // Jalur kartu/auto-debit BELUM didukung integrasi iPaymu saat ini.
        return json({
          error: "Langganan otomatis via kartu belum tersedia saat ini. Silakan pilih metode QRIS/Transfer manual.",
        }, 400);
      }

      const subId = manualSubId || `SUB-${service.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      if (manualSubId) {
        // DIPERBAIKI: sebelumnya di sini cuma dicek apakah manualSubId itu
        // ADA, tidak dicek APAKAH ORANG YANG SUBMIT FORM INI BENERAN PEMILIK
        // langganan itu. Karena subId punya pola yang bisa ditebak
        // (SUB-{SERVICE}-{timestamp base36}), siapa pun yang menebak/tahu ID
        // ini bisa memicu "perpanjangan" atas nama orang lain dan mengganti
        // rujukan pembayarannya. Sekarang wajib email cocok dengan pemilik
        // asli sebelum perpanjangan diizinkan - sama seperti proteksi yang
        // sudah lebih dulu ada di server Express (Server_bich_payment.js).
        const { data: existing, error: errExisting } = await supabaseAdmin
          .from("user_subscriptions")
          .select("sub_id, customer_email")
          .eq("sub_id", manualSubId)
          .maybeSingle();

        if (errExisting) return json({ error: "Gagal memeriksa langganan: " + errExisting.message }, 500);
        if (!existing) return json({ error: "Langganan yang mau diperpanjang tidak ditemukan." }, 404);

        const emailCocok =
          typeof customer.email === "string" &&
          typeof existing.customer_email === "string" &&
          customer.email.trim().toLowerCase() === existing.customer_email.trim().toLowerCase();

        if (!emailCocok) {
          return json({ error: "Email tidak cocok dengan pemilik langganan ini." }, 403);
        }

        await supabaseAdmin.from("user_subscriptions")
          .update({ status: "pending" }).eq("sub_id", manualSubId);
      } else {
        const { error: errSub } = await supabaseAdmin.from("user_subscriptions").insert([{
          sub_id: subId,
          service,
          plan_code: planCode,
          billing_mode: "manual",
          customer_name: customer.nama,
          customer_email: customer.email,
          customer_whatsapp: customer.whatsapp,
          status: "pending",
          expires_at: expiresAt.toISOString(),
        }]);
        if (errSub) return json({ error: "Gagal membuat langganan: " + errSub.message }, 500);
      }
      refId = subId;
    } else {
      // loker, cv, travel -> masuk tabel transaksi_atm (sekali bayar)
      const prefix = service === "loker" ? "LK" : service === "cv" ? "CV" : "TR";
      const idTransaksi = `${prefix}-${Date.now().toString(36).toUpperCase()}`;

      const namaPelanggan = customer.perusahaan || customer.nama || "-";
      const kontak = customer.whatsapp || customer.email || "-";

      const { error: errTx } = await supabaseAdmin.from("transaksi_atm").insert([{
        id_transaksi: idTransaksi,
        nama_pelanggan: namaPelanggan,
        kontak_pelanggan: kontak,
        nama_produk,
        total_harga: harga,
        status_pembayaran: "PENDING",
        meta_data: { service, planCode, customer, origin, destination, serviceType },
      }]);

      if (errTx) return json({ error: "Gagal membuat transaksi: " + errTx.message }, 500);
      refId = idTransaksi;
    }

    // ------------------------------------------------------------------
    // Buat sesi bayar iPaymu
    // ------------------------------------------------------------------
    const namaPembeli = customer.perusahaan || customer.nama || "Pelanggan BICH";
    const emailPembeli = customer.email || "pelanggan@bichmart.id";
    const teleponPembeli = customer.whatsapp || "-";

    const ipaymuPayload = {
      name: namaPembeli,
      phone: teleponPembeli,
      email: emailPembeli,
      amount: harga,
      notifyUrl: `${SUPABASE_URL}/functions/v1/ipaymu-webhook`,
      returnUrl: `https://mozensalqadrie.com/success.html?order_id=${encodeURIComponent(refId)}&service=${encodeURIComponent(service)}&status=pending`,
      cancelUrl: `https://mozensalqadrie.com/bich/${service === "travel" ? "pariwisata" : isLangganan ? "langganan" : "monetisasi"}.html`,
      expired: 24,
      expiredType: "hours",
      comments: `${nama_produk} - Ref ${refId}`,
      referenceId: refId,
      product: [nama_produk],
      qty: [1],
      price: [harga],
    };

    const signature = await generateIPaymuSignature(IPAYMU_VA, IPAYMU_API_KEY, ipaymuPayload);
    const timestamp = formatTimestampIPaymu(new Date());

    const pgResponse = await fetch(IPAYMU_PAY_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "va": IPAYMU_VA,
        "signature": signature,
        "timestamp": timestamp,
      },
      body: JSON.stringify(ipaymuPayload),
    });

    const pgData = await pgResponse.json();

    if (!pgResponse.ok || pgData.Status !== 200) {
      return json({ error: pgData.Message || "Gagal membuat transaksi di iPaymu." }, 502);
    }

    // Simpan referensi sesi iPaymu
    const sessionRef = String(pgData.Data?.SessionID || pgData.Data?.TransactionId || "");
    if (isLangganan) {
      await supabaseAdmin.from("user_subscriptions").update({ payment_gateway_ref: sessionRef }).eq("sub_id", refId);
    } else {
      await supabaseAdmin.from("transaksi_atm")
        .update({ meta_data: { service, planCode, customer, origin, destination, serviceType, payment_gateway_ref: sessionRef } })
        .eq("id_transaksi", refId);
    }

    return json({ checkout_url: pgData.Data?.Url, order_id: refId });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

async function generateIPaymuSignature(va: string, apiKey: string, bodyObj: object): Promise<string> {
  const bodyJson = JSON.stringify(bodyObj);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(bodyJson));
  const bodyHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").toLowerCase();
  const stringToSign = `POST:${va}:${bodyHash}:${apiKey}`;
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(stringToSign));
  return Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").toLowerCase();
}

function formatTimestampIPaymu(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}