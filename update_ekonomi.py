import json
import os
import datetime

def jalankan_shadow_army_ekonomi():
    # 1. Tentukan lokasi folder utama dan target file di dalam folder bich/
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    target_json = os.path.join(BASE_DIR, "bich", "data-ekonomi.json")
    
    # 2. Struktur Data Ekonomi & Pasar Modal (Hasil analisis / scraping)
    database_ekonomi = {
        "last_updated": datetime.datetime.now().strftime("%A, %d %B %Y - 16:30 WITA"),
        "komoditas": [
            {"nama": "CPO PALM OIL", "harga": "Rp 14.250 /kg", "change": "▲ +1.2%", "status": "up"},
            {"nama": "BATUBARA (ICI4)", "harga": "$62.5 /Ton", "change": "▲ +0.5%", "status": "up"},
            {"nama": "NIKEL (LME)", "harga": "$16.400 /Ton", "change": "▼ -0.8%", "status": "down"},
            {"nama": "EMAS DUNIA", "harga": "$2.350 /oz", "change": "▲ +2.1%", "status": "up"}
        ],
        "ruang_makro": {
            "judul": "Proyeksi Rantai Pasok Kalimantan Pasca-Penyesuaian Tarif Logistik",
            "ringkasan": "Stabilitas harga CPO dan penguatan permintaan ekspor batubara ICI4 menjadi penyokong utama penerimaan daerah Kalsel dan Kaltim. Penataan kembali koridor transportasi sungai menjadi kunci utama efisiensi biaya logistik hingga akhir kuartal."
        },
        "ruang_pasar_modal": {
            "capital_flow": "+Rp 2.3 Triliun",
            "pintu_ipo": "3 Emiten (Q4)",
            "watchlist": ["TINS", "TLKM", "BRIS", "ADRO"],
            "judul_briefing": "Peta Akumulasi Bandarmology & Pintu Transaksi Blok",
            "ringkasan": "Pergerakan modal asing terkonsentrasi pada emiten tambang dengan rasio dividen tinggi. Terdapat indikasi transaksi blok skala besar di sektor infrastruktur telekomunikasi."
        }
    }

    # 3. Simpan data langsung ke bich/data-ekonomi.json
    with open(target_json, "w", encoding="utf-8") as f:
        json.dump(database_ekonomi, f, indent=2, ensure_ascii=False)
        
    print(f"🔥 [BICH SHADOW ARMY] Berhasil update data ekonomi ke: {target_json}")

if __name__ == "__main__":
    jalankan_shadow_army_ekonomi()