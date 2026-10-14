# Lab acceptance RDP

`rdp-acceptance.json` memuat hasil per baseline. `npm run test:live` mengharuskan setiap baseline memiliki status `lab-passed`, evidence nonkosong, dan seluruh required checks. Fixture atau build tidak memenuhi login/frame/input nyata.

1. Catat versi OS, arsitektur **Electron dan helper**, compiler, commit aplikasi, hash helper, dan versi server. Host/user/password tidak dimasukkan ke evidence publik.
2. Verifikasi fingerprint server melalui jalur lab tepercaya. Login melalui dialog lokal. Catat kegagalan unknown certificate dan pin mismatch secara terpisah; jangan memakai certificate-ignore.
3. Di tab embedded, buka aplikasi teks kosong untuk uji. Ketik `bridge-proof`, pastikan output terlihat, lalu tutup tanpa menyimpan. Jangan memakai spreadsheet/dokumen operasional sebagai sasaran input.
4. Uji resize/reconnect, dua sesi dengan akun terpisah, close/cancel, helper crash, salah password, dan interupsi jaringan **pada sesi disposable**. Host operasional tidak boleh dimatikan jaringannya atau dilockout untuk mengejar checklist.
5. Uji clipboard dengan teks nonsensitif sesudah channel dan kontrol opt-in tersedia. Saat ini belum diimplementasikan; jangan centang check ini.
6. Simpan laporan teredaksi yang membedakan pass/fail/not-run. Screenshot yang berisi aplikasi operasional tidak boleh dimasukkan. Screenshot build/fixture harus berlabel fixture.

Edit status/checks hanya dari hasil yang diobservasi. Stack decision tetap `pending-live-evidence` sampai semua platform dan semua check lulus. Test gate tidak memverifikasi keaslian evidence; review manusia atas evidence tetap diperlukan.

Kredensial, fingerprint/identitas host privat, raw traces, dan salinan dokumentasi operasional tidak termasuk evidence yang dikomit. Folder `lab/private/` diabaikan Git bila pemilik membutuhkan catatan endpoint lokal.
