// supabase/functions/create-payment/index.ts
//
// VERSI FINAL & HARDENED — Zero Trust Architecture
// Seluruh kalkulasi harga, stok, ongkir, dan fee BICH 100% diverifikasi server-side.
// Mendukung jalur Payment Gateway (iPaymu) dan WhatsApp Manual.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("MOZENS_SERVICE_ROLE_KEY")!;

const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox";

const ADMIN_WA_NUMBER = "6282341333313";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

function formatRupiah(angka: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(angka || 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      items,
      customer_name,
      customer_email,
      customer_phone,
      shipping_address,
      kota_tujuan,
      shipping_method,
      payment_method,
      return_url,
    } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return json({ error: "Keranjang kosong atau format tidak valid." }, 400);
    }
    if (!kota_tujuan || !shipping_method) {
      return json({ error: "Kota tujuan & metode pengiriman wajib diisi." }, 400);
    }

    // ------------------------------------------------------------------
    // 1. Ambil harga ASLI dari Database (Garis Pertahanan Utama Security)
    // ------------------------------------------------------------------
    const productIds = items.map((it: { id: string | number }) => it.id);
    const { data: produkAsli, error: errProduk } = await supabaseAdmin
      .from("bich_produk")
      .select("id, nama_produk, harga, stok")
      .in("id", productIds);

    if (errProduk) return json({ error: "Gagal verifikasi produk: " + errProduk.message }, 500);

    type ProdukRow = { id: string | number; nama_produk: string; harga: number; stok: number | null };

    const produkMap = new Map<string, ProdukRow>(
      (produkAsli as ProdukRow[]).map((p) => [String(p.id), p])
    );
    let subtotal = 0;
    const itemsTervalidasi = [];

    for (const it of items) {
      const asli = produkMap.get(String(it.id));
      if (!asli) {
        return json({ error: `Produk ID ${it.id} tidak ditemukan.` }, 400);
      }
      const qty = Math.max(1, parseInt(it.qty) || 1);
      if (asli.stok !== null && asli.stok < qty) {
        return json({ error: `Stok "${asli.nama_produk}" tidak mencukupi.` }, 400);
      }
      subtotal += asli.harga * qty;
      itemsTervalidasi.push({
        id: asli.id,
        nama_produk: asli.nama_produk,
        harga: asli.harga,
        qty,
      });
    }

    // ------------------------------------------------------------------
    // 1b. Validasi ulang ongkir lewat hitung-ongkir (Server-to-Server)
    // ------------------------------------------------------------------
    const ongkirResp = await fetch(`${SUPABASE_URL}/functions/v1/hitung-ongkir`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        kota_tujuan,
        items: itemsTervalidasi.map((i) => ({ produk_id: i.id, qty: i.qty })),
      }),
    });

    if (!ongkirResp.ok) {
      console.error("[create-payment] hitung-ongkir HTTP error:", ongkirResp.status);
      return json({ error: "Layanan hitung ongkir sedang bermasalah. Coba beberapa saat lagi." }, 502);
    }

    const ongkirData = await ongkirResp.json();

    // Kalau hitung-ongkir kasih alasan spesifik (mis. keranjang multi-origin),
    // teruskan pesan itu apa adanya - jangan ditelan jadi pesan generik yang
    // bikin pembeli bingung harus ngapain.
    if (ongkirData?.error) {
      return json({ error: ongkirData.message || ongkirData.error }, 400);
    }

    const opsiSah = (ongkirData.opsi || []).find((o: { kode: string }) => o.kode === shipping_method);

    if (!opsiSah) {
      return json({ error: "Metode pengiriman tidak valid untuk tujuan ini. Muat ulang halaman checkout." }, 400);
    }
    const ongkir = opsiSah.harga;
    const feeBich = Math.floor(subtotal * 0.025);
    const totalAmount = subtotal + ongkir + feeBich;
    const nomorPesanan = `BM-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const metodePembayaranLabel = payment_method === "manual" ? "WhatsApp Manual" : "iPaymu QRIS/VA";

    // ------------------------------------------------------------------
    // 2. Simpan pesanan ke Database Supabase (Status: Pending)
    // ------------------------------------------------------------------
    const { data: pesanan, error: errInsert } = await supabaseAdmin
      .from("bich_pesanan")
      .insert([{
        nomor_pesanan: nomorPesanan,
        nama_pembeli: customer_name,
        wa_pembeli: customer_phone,
        wa_pembeli_email: customer_email,
        alamat_lengkap: shipping_address,
        item_pesanan: itemsTervalidasi,
        total_harga: totalAmount,
        ongkir: ongkir,
        fee_bich: feeBich,
        metode_pembayaran: metodePembayaranLabel,
        // Simpan label yang enak dibaca (mis. "Kurir Instan BICH"), bukan
        // kode mentah (mis. "kurir_lokal") - supaya riwayat pesanan/admin
        // panel tidak menampilkan kode teknis ke pengguna.
        metode_pengiriman: opsiSah.label || shipping_method,
        status: "Pending",
      }])
      .select()
      .single();

    if (errInsert) return json({ error: "Gagal simpan pesanan: " + errInsert.message }, 500);

    // ------------------------------------------------------------------
    // JALUR MANUAL (WhatsApp/transfer manual)
    // ------------------------------------------------------------------
    if (payment_method === "manual") {
      let textWA = `*PESANAN BICH MART*\n`;
      textWA += `No. Pesanan: ${nomorPesanan}\n`;
      textWA += `Nama: ${customer_name}\n`;
      textWA += `WA: ${customer_phone}\n`;
      textWA += `Alamat: ${shipping_address}\n`;
      textWA += `Pengiriman: ${opsiSah.label || shipping_method}\n\n`;
      textWA += `Total Tagihan: ${formatRupiah(totalAmount)}`;

      const whatsappUrl = `https://wa.me/${ADMIN_WA_NUMBER}?text=${encodeURIComponent(textWA)}`;

      return json({
        order_id: pesanan.id,
        nomor_pesanan: nomorPesanan,
        whatsapp_url: whatsappUrl,
        total_validated: totalAmount,
      });
    }

    // ------------------------------------------------------------------
    // JALUR PAYMENT GATEWAY (iPaymu)
    // ------------------------------------------------------------------
    const ipaymuBaseUrl = IPAYMU_ENV === "production"
      ? "https://my.ipaymu.com/api/v2/payment"
      : "https://sandbox.ipaymu.com/api/v2/payment";

    const baseReturnUrl = return_url || "https://mozensalqadrie.com/success.html?service=mart";
    const returnUrlFinal = baseReturnUrl.includes("order_id=")
      ? baseReturnUrl
      : `${baseReturnUrl}${baseReturnUrl.includes("?") ? "&" : "?"}order_id=${encodeURIComponent(nomorPesanan)}&status=pending`;

    const ipaymuPayload = {
      name: customer_name,
      phone: customer_phone,
      email: customer_email || "pembeli@bichmart.id",
      amount: totalAmount,
      notifyUrl: `${SUPABASE_URL}/functions/v1/ipaymu-webhook`,
      returnUrl: returnUrlFinal,
      cancelUrl: "https://mozensalqadrie.com/market/checkout.html",
      expired: 24,
      expiredType: "hours",
      comments: `Pesanan BICH Mart ${nomorPesanan}`,
      referenceId: String(pesanan.id),
      product: itemsTervalidasi.map(i => i.nama_produk),
      qty: itemsTervalidasi.map(i => i.qty),
      price: itemsTervalidasi.map(i => i.harga),
    };

    const signature = await generateIPaymuSignature(IPAYMU_VA, IPAYMU_API_KEY, ipaymuPayload);
    const timestamp = formatTimestampIPaymu(new Date());

    const pgResponse = await fetch(ipaymuBaseUrl, {
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

    const refGateway = String(pgData?.Data?.SessionID || pgData?.Data?.TransactionId || "");
    await supabaseAdmin
      .from("bich_pesanan")
      .update({ payment_gateway_ref: refGateway })
      .eq("id", pesanan.id);

    return json({ checkout_url: pgData.Data.Url, order_id: pesanan.id, nomor_pesanan: nomorPesanan });

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function formatTimestampIPaymu(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}