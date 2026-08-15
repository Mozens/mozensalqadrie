// Konfigurasi Supabase BICH Engine
const SUPABASE_URL = "https://gehbuhuevfxfjyytmrht.supabase.co";
// Menggunakan Anon/Publishable Key untuk akses publik store — key yang sama
// dengan yang sudah dipakai di berita.html/ekonomi.html/politik.html/index.html.
// PENTING: sebelumnya key ini PATAH (masih ada teks placeholder "YOUR_ACTUAL_ANON_KEY"
// yang belum diganti) sehingga seluruh BICH Mart gagal konek ke database.
const SUPABASE_ANON_KEY = "sb_publishable_7MfD31f6Jpan5GJ_VP5vuw_ZBm_3oHZ";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Alias supaya konsisten dengan penamaan yang dipakai di seller.html (supabaseClient)
const supabaseClient = db;

// Helper Fetch Produk
async function fetchSemuaProduk() {
    const { data, error } = await db
        .from('bich_produk')
        .select(`
            *,
            bich_toko (
                nama_toko,
                wa,
                status_verifikasi,
                is_live,
                live_url
            )
        `)
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Gagal load produk:", error);
        return [];
    }
    return data || [];
}