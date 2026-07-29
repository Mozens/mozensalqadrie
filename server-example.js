/**
 * CONTOH BACKEND UNTUK INTEGRASI MIDTRANS YANG AMAN
 * ---------------------------------------------------
 * File ini adalah CONTOH/REFERENSI, bukan plug-and-play produksi. Sesuaikan dengan
 * database & kebutuhan bisnis Anda (mis. ganti tabel tarif, ganti penyimpanan order
 * dari in-memory ke database sungguhan seperti Supabase/PostgreSQL).
 *
 * Jalankan dengan: npm install express midtrans-client dotenv cors
 *                   node server-example.js
 *
 * Environment variables (.env) - JANGAN PERNAH commit file .env ke git:
 *   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxxxxxx   (dari dashboard Midtrans, mode Sandbox dulu)
 *   MIDTRANS_IS_PRODUCTION=false
 *   PORT=3000
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// 1. TABEL TARIF RESMI ADA DI SINI, BUKAN DI FRONTEND.
//    Frontend hanya mengirim origin/destination/serviceType; harga akhir SELALU
//    dihitung ulang di sini agar tidak bisa dimanipulasi lewat DevTools browser.
// ---------------------------------------------------------------------------
const BASE_TARIFF = {
  BPN_IKN: 175000,
  IKN_BPN: 175000,
  BDJ_IKN: 350000,
  IKN_BDJ: 350000,
  AIRPORT: 150000,
  DEFAULT: 250000,
};

function calculateServerSidePrice(origin, destination, serviceType) {
  let base;
  if (origin.includes('AIRPORT') || destination.includes('AIRPORT')) {
    base = BASE_TARIFF.AIRPORT;
  } else {
    const key = `${origin}_${destination}`;
    base = BASE_TARIFF[key] || BASE_TARIFF.DEFAULT;
  }

  if (serviceType === 'charter') base = base * 6;
  else if (serviceType === 'kargo') base = Math.round(base * 0.2);
  else if (serviceType === 'speedboat') base = 300000;

  return base;
}

// Simple in-memory order store untuk contoh ini saja.
// DI PRODUKSI: gunakan database sungguhan (Supabase/PostgreSQL/MySQL, dll).
const orders = new Map();

// Snap client Midtrans - Server Key hanya hidup di sini, tidak pernah dikirim ke browser.
const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
});

const coreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
});

// ---------------------------------------------------------------------------
// 2. ENDPOINT: BUAT TRANSAKSI
//    Frontend memanggil ini, backend menghitung harga & membuat Snap Token.
// ---------------------------------------------------------------------------
app.post('/api/create-transaction', async (req, res) => {
  try {
    const { origin, destination, serviceType } = req.body;

    if (!origin || !destination || !serviceType) {
      return res.status(400).json({ error: 'Data tidak lengkap.' });
    }
    if (origin === destination) {
      return res.status(400).json({ error: 'Rute asal dan tujuan tidak boleh sama.' });
    }

    const finalPrice = calculateServerSidePrice(origin, destination, serviceType);
    const orderId = `BICH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Simpan order dengan status "pending" SEBELUM memanggil Midtrans, agar webhook
    // nanti punya order untuk dicocokkan & diperbarui statusnya.
    orders.set(orderId, {
      orderId,
      origin,
      destination,
      serviceType,
      amount: finalPrice,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: finalPrice,
      },
      // TODO: isi customer_details dari data user yang sudah login/terverifikasi,
      // jangan dari input bebas tanpa validasi.
      credit_card: { secure: true },
    };

    const transaction = await snap.createTransaction(parameter);

    res.json({ token: transaction.token, orderId });
  } catch (err) {
    console.error('create-transaction error:', err);
    res.status(500).json({ error: 'Gagal membuat transaksi.' });
  }
});

// ---------------------------------------------------------------------------
// 3. ENDPOINT: WEBHOOK / NOTIFICATION HANDLER
//    Midtrans akan memanggil URL ini (bukan browser user) untuk memberi tahu
//    status pembayaran final. INI adalah sumber kebenaran status pembayaran -
//    jangan pernah percaya status yang dikirim balik oleh browser saja.
//    Daftarkan URL publik endpoint ini di dashboard Midtrans > Settings > Notification URL.
// ---------------------------------------------------------------------------
app.post('/api/midtrans-webhook', async (req, res) => {
  try {
    const notification = req.body;

    // WAJIB: verifikasi keaslian notifikasi lewat Core API, jangan langsung percaya body request
    // (siapa pun bisa POST palsu ke endpoint ini kalau tidak diverifikasi).
    const statusResponse = await coreApi.transaction.notification(notification);

    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    const order = orders.get(orderId);
    if (!order) {
      console.warn('Order tidak ditemukan untuk notifikasi:', orderId);
      return res.status(404).send('Order not found');
    }

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      if (fraudStatus === 'accept' || !fraudStatus) {
        order.status = 'paid';
        // TODO: trigger email/WA konfirmasi, kurangi kuota kursi, dsb.
      }
    } else if (transactionStatus === 'pending') {
      order.status = 'pending';
    } else if (['deny', 'cancel', 'expire', 'failure'].includes(transactionStatus)) {
      order.status = 'failed';
    }

    orders.set(orderId, order);
    res.status(200).send('OK');
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).send('Webhook error');
  }
});

// ---------------------------------------------------------------------------
// 4. ENDPOINT: LEAD FORM UMRAH (contoh sederhana, bukan transaksi uang)
// ---------------------------------------------------------------------------
app.post('/api/umrah-lead', async (req, res) => {
  try {
    const { nama, whatsapp, paket } = req.body;
    if (!nama || !whatsapp) {
      return res.status(400).json({ error: 'Nama dan WhatsApp wajib diisi.' });
    }
    // TODO: simpan ke database sungguhan, lakukan validasi nomor WA, dan/atau
    // teruskan ke sistem CRM/WhatsApp Business API tim sales.
    console.log('Lead umrah baru:', { nama, whatsapp, paket, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('umrah-lead error:', err);
    res.status(500).json({ error: 'Gagal menyimpan data.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server contoh berjalan di port ${PORT}`));
