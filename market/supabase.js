// Konfigurasi Supabase BICH Engine
const SUPABASE_URL = "https://gehbuhuevfxfjyytmrht.supabase.co";
// Menggunakan Anon Key untuk akses publik store
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlaGJ1aHVldmZ4Zmp5eXRtcmh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM2MTg1OTUsImV4cCI6MjA2OTE5NDU5NX0.YOUR_ACTUAL_ANON_KEY"; 

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper Fetch Produk
async function fetchSemuaProduk() {
    const { data, error } = await db
        .from('bich_produk')
        .select(`
            *,
            bich_toko (
                nama_toko,
                wa,
                status_verifikasi
            )
        `)
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Gagal load produk:", error);
        return [];
    }
    return data || [];
}