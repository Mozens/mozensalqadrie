// supabase/functions/create-payment/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Secret Key & VA iPaymu dari Supabase Dashboard / CLI
const IPAYMU_VA = Deno.env.get("IPAYMU_VA")!;
const IPAYMU_API_KEY = Deno.env.get("IPAYMU_API_KEY")!;
const IPAYMU_ENV = Deno.env.get("IPAYMU_ENV") || "sandbox"; // 'sandbox' atau 'production'

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper Enkripsi HMAC-SHA256 iPaymu v2
async function generateIPaymuSignature(va: string, apiKey: string, bodyObj: object): Promise<string> {
  const bodyJson = JSON.stringify(bodyObj);
  const encoder = new TextEncoder();
  
  // 1. SHA-256 Body Hash
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(bodyJson));
  const bodyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toLowerCase();

  // 2. Format String to Sign
  const stringToSign = `POST:${va}:${bodyHash}:${apiKey}`;

  // 3. HMAC-SHA256 Sign
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(stringToSign));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toLowerCase();
}

Deno.serve(async (req) => {
  // Preflight CORS
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
      shipping_fee,
    } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return json({ error: "Keranjang kosong atau format tidak valid." }, 400);
    }

    // 1. Ambil harga ASLI dari Database (Garis Pertahanan Utama Security)
    const productIds = items.map((it: { id: string | number }) => it.id);
    const { data: produkAsli, error: errProduk } = await supabaseAdmin
      .from("bich_produk")
      .select("id, nama_produk, harga, stok")
      .in("id", productIds);

    if (errProduk) return json({ error: "Gagal verifikasi produk: " + errProduk.message }, 500);

    const produkMap = new Map(produkAsli.map((p: { id: string | number }) => [p.id, p]));
    let subtotal = 0;
    const itemsTervalidasi = [];

    for (const it of items) {
      const asli = produkMap.get(it.id);
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

    const ongkir = Number(shipping_fee) || 0;
    const feeBich = Math.floor(subtotal * 0.025);
    const totalAmount = subtotal + ongkir + feeBich;
    const nomorPesanan = `BM-${Date.now().toString(36).toUpperCase()}`;

    // 2. Simpan pesanan ke Database Supabase (Status: Pending)
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
        metode_pembayaran: "iPaymu QRIS/VA",
        metode_pengiriman: body.shipping_method ?? "Reguler",
        status: "Pending",
      }])
      .select()
      .single();

    if (errInsert) return json({ error: "Gagal simpan pesanan: " + errInsert.message }, 500);

    // 3. Payload Resmi iPaymu API v2
    const ipaymuBaseUrl = IPAYMU_ENV === "production" 
      ? "https://my.ipaymu.com/api/v2/payment" 
      : "https://sandbox.ipaymu.com/api/v2/payment";

    const ipaymuPayload = {
      name: customer_name,
      phone: customer_phone,
      email: customer_email || "pembeli@bichmart.id",
      amount: totalAmount,
      notifyUrl: `${SUPABASE_URL}/functions/v1/ipaymu-webhook`,
      returnUrl: "https://mozensalqadrie.com/market/success.html",
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

    // 4. Request Sesi Pembayaran ke iPaymu
    const pgResponse = await fetch(ipaymuBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "va": IPAYMU_VA,
        "signature": signature,
      },
      body: JSON.stringify(ipaymuPayload),
    });

    const pgData = await pgResponse.json();

    if (!pgResponse.ok || pgData.Status !== 200) {
      return json({ error: pgData.Message || "Gagal membuat transaksi di iPaymu." }, 502);
    }

    // 5. Update ID Referensi iPaymu ke DB
    await supabaseAdmin
      .from("bich_pesanan")
      .update({ payment_gateway_ref: String(pgData.Data.SessionID || pgData.Data.TransactionId) })
      .eq("id", pesanan.id);

    return json({ checkout_url: pgData.Data.Url, order_id: pesanan.id });

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}