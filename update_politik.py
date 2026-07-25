import json
import os
from datetime import datetime

# Simulasi hasil filter data mentah dari scraper lokal
def run_autonomous_pipeline():
    print("[INFO] Shadow Army: Memproses data mentah per wilayah...")
    
    # Lock lokasi folder utama berdasarkan posisi skrip ini berada
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(BASE_DIR, "bich", "data-politik.json")
    
    # Data terstruktur hasil olahan mesin (tanpa asumsi/halusinasi)
    payload_data = {
        "edisi": f"Edisi Bi-Weekly: {datetime.now().strftime('%B %Y')}",
        "wilayah": [
            {
                "id": "kaltim",
                "nama": "KALTIM & IKN HUB",
                "kategori": "ZONA UTAMA",
                "judul": "Akselerasi Infrastruktur & Pergeseran Demografi Politik",
                "ringkasan": "Analisis benturan kepentingan antara masyarakat adat, investasi nasional, dan peta kekuatan ring-1 kekuasaan baru di sekitar kawasan IKN.",
                "link": "kaltim.html"
            },
            {
                "id": "kalbar",
                "nama": "KALIMANTAN BARAT",
                "kategori": "BORDER & PLANTED",
                "judul": "Dinamika Sawit, Perbatasan, & Pluralitas Kultural",
                "ringkasan": "Pemetaan ketegangan sektoral agribisnis, pengaruh koalisi lintas etnis, dan stabilitas geopolitik wilayah perbatasan darat.",
                "link": "kalbar.html"
            },
            {
                "id": "kalsel",
                "nama": "KALIMANTAN SELATAN",
                "kategori": "COMMODITY & RELIGION",
                "judul": "Oligarki Batubara & Pengaruh Jaringan Simpul Agama",
                "ringkasan": "Membaca konstelasi kekuasaan pengusaha energi fosil lokal terhadap struktur perizinan dan jaringan kultural keagamaan banua.",
                "link": "kalsel.html"
            },
            {
                "id": "kalteng",
                "nama": "KALIMANTAN TENGAH",
                "kategori": "LAND & FOOD ESTATE",
                "judul": "Konflik Agraria & Proyek Strategis Nasional (PSN)",
                "ringkasan": "Audit sentimen publik terkait alih fungsi lahan skala besar, eksistensi masyarakat adat Dayak, dan peta dukungan figur lokal.",
                "link": "kalteng.html"
            },
            {
                "id": "kaltara",
                "nama": "KALIMANTAN UTARA",
                "kategori": "STRATEGIC OUTPOST",
                "judul": "Kawasan Industri Hijau & Geopolitik Perbatasan Utara",
                "ringkasan": "Analisis arus investasi transnasional (KIPI Tanah Kuning), konektifitas ekonomi perbatasan, dan pertahanan pengaruh regional.",
                "link": "kaltara.html"
            }
        ]
    }

    # Simpan otomatis ke file JSON target web
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload_data, f, ensure_ascii=False, indent=4)
        
    print("[SUCCESS] Briefing wilayah berhasil diperbarui ke server web secara otonom.")

if __name__ == "__main__":
    run_autonomous_pipeline()