import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const KODE_POS: Record<string, number> = {
  'Banjarmasin': 70111, 'Banjarbaru': 70711, 'Martapura': 70614,
  'Palangka Raya': 73111, 'Samarinda': 75111, 'Balikpapan': 76111,
  'Pontianak': 78111, 'Tarakan': 77111,
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { kota_tujuan, items } = await req.json()
    if (!kota_tujuan || !items?.length) {
      throw new Error('kota_tujuan dan items wajib diisi.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('MOZENS_SERVICE_ROLE_KEY')!
    )

    const produkIds = items.map((i: { produk_id: number }) => i.produk_id)
    const { data: produkList, error: errProduk } = await supabase
      .from('bich_produk')
      .select('id, lokasi, berat_gram')
      .in('id', produkIds)

    if (errProduk) throw new Error(errProduk.message)

    const qtyMap = new Map<number, number>()
    items.forEach((i: { produk_id: number; qty?: number; kuantitas?: number }) => {
      qtyMap.set(i.produk_id, Number(i.qty || i.kuantitas || 1))
    })

    const totalBeratGram = produkList.reduce((sum, p) => {
      const qty = qtyMap.get(p.id) || 1
      const beratSatuan = p.berat_gram || 500
      return sum + (beratSatuan * qty)
    }, 0)

    const lokasiAsalSet = new Set(produkList.map(p => p.lokasi).filter(Boolean))

    // Keranjang berisi produk dari lebih dari 1 kota asal (penjual beda kota) -
    // JANGAN hitung ongkir dari 1 origin saja, pasti salah. Minta checkout.html
    // pisah jadi transaksi terpisah per kota asal.
    if (lokasiAsalSet.size > 1) {
      return new Response(JSON.stringify({
        opsi: [],
        error: 'MULTI_ORIGIN',
        message: `Keranjangmu berisi produk dari ${lokasiAsalSet.size} kota asal berbeda (${[...lokasiAsalSet].join(', ')}). Selesaikan checkout per kota asal secara terpisah supaya ongkirnya akurat.`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }

    const sekota = lokasiAsalSet.size === 1 && [...lokasiAsalSet][0] === kota_tujuan

    const opsi: Array<{ kode: string; label: string; estimasi: string; harga: number; rekomendasi: boolean }> = []

    if (sekota) {
      const totalBeratKg = totalBeratGram / 1000
      const { data: mitra } = await supabase
        .from('mitra_kurir')
        .select('id')
        .eq('kota_domisili', kota_tujuan)
        .eq('status_verifikasi', 'TERVERIFIKASI')
        .gte('kapasitas_kg', totalBeratKg)
        .limit(1)

      if (mitra && mitra.length > 0) {
        const { data: tarif } = await supabase
          .from('tarif_kurir_zona')
          .select('*')
          .eq('kota', kota_tujuan)
          .eq('aktif', true)
          .maybeSingle()

        if (tarif) {
          const kelebihanKg = Math.max(0, Math.ceil((totalBeratGram - 1000) / 1000))
          const harga = tarif.tarif_dasar + (kelebihanKg * tarif.tarif_per_kg_tambahan)
          opsi.push({
            kode: 'kurir_lokal',
            label: 'Kurir Instan BICH',
            estimasi: tarif.estimasi_durasi || 'Sameday',
            harga,
            rekomendasi: true
          })
        }
      }
    }

    if (opsi.length === 0) {
      const BITESHIP_API_KEY = Deno.env.get('BITESHIP_API_KEY')

      if (!BITESHIP_API_KEY) {
        console.warn('BITESHIP_API_KEY belum dipasang di Supabase Secrets - Tier 2 (ekspedisi reguler) dilewati.')
      }

      if (BITESHIP_API_KEY) {
        const originKota = [...lokasiAsalSet][0] || 'Banjarmasin'
        const originPostal = KODE_POS[originKota] || 70111
        const destPostal = KODE_POS[kota_tujuan]

        if (destPostal) {
          const res = await fetch('https://api.biteship.com/v1/rates/couriers', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${BITESHIP_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              origin_postal_code: originPostal,
              destination_postal_code: destPostal,
              couriers: 'jne,jnt,pos,sicepat',
              items: [{
                name: 'Produk BICH Mart',
                value: 50000,
                length: 10, width: 10, height: 10,
                weight: totalBeratGram
              }]
            }),
          })

          if (res.ok) {
            const biteship = await res.json()
            for (const p of biteship?.pricing || []) {
              opsi.push({
                kode: `ekspedisi_${p.courier_code}_${p.courier_service_code}`,
                label: `${p.courier_name} (${p.courier_service_name.toUpperCase()})`,
                estimasi: p.duration || '2-4 hari',
                harga: p.price,
                rekomendasi: false
              })
            }
            if (opsi.length > 0) opsi[0].rekomendasi = true
          } else {
            console.error('Biteship API Error:', await res.text())
          }
        }
      }
    }

    return new Response(JSON.stringify({ opsi, total_berat_gram: totalBeratGram }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  // ✅ Solusi Type-Safe untuk Deno
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan tidak diketahui'
    return new Response(JSON.stringify({ error: message, opsi: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})