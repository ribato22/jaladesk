# Server RDP uji (loopback)

`rdp-test-server` adalah server RDP kecil berbasis FreeRDP 3.32.2 yang hanya dipakai oleh `scripts/test-native-integration.mjs`. Tujuannya menjalankan plugin klien **asli** (`disp` dan `cliprdr`) end-to-end terhadap helper yang sebenarnya, sesuatu yang tidak bisa dilakukan listener tiruan di `test-native-network.mjs` dan `test-native-pin.mjs`.

**Jangan pernah diekspos.** Server hanya mendengarkan `127.0.0.1`, hanya TLS (tanpa NLA/CredSSP), menerima klien mana pun, dan tidak memeriksa kredensial. Sertifikat yang dipakai adalah sertifikat sekali pakai yang dibuat uji pada setiap run. Biner ini tidak boleh masuk ke paket aplikasi dan tidak ditaruh di `native/bin/` (direktori helper produk); build default berada di `native/test-server/build/` yang diabaikan Git.

## Build

Perlu prefix FreeRDP yang dibangun **dengan sisi server** dan channel server `drdynvc`, `disp`, `cliprdr`; prefix klien yang dipakai helper tidak cukup. Di workspace ini skripnya `work/integration-server-20261016/build-freerdp-server.sh` (FreeRDP 3.32.2, arm64, direktori baru, `-DWITH_SERVER=ON -DWITH_SERVER_CHANNELS=ON -DCHANNEL_CLIPRDR=ON -DCHANNEL_DISP=ON -DCHANNEL_DRDYNVC=ON`, tanpa X11/SDL/FFmpeg/proxy/shadow). Lalu:

```sh
cmake -S native/test-server -B native/test-server/build -DCMAKE_PREFIX_PATH=<prefix-freerdp-server>
cmake --build native/test-server/build
npm run test:native-integration
```

Biner server dapat diberikan ke uji sebagai argumen kedua atau lewat `RDP_TEST_SERVER`; tanpa biner (atau tanpa CLI `openssl`) uji keluar dengan kode 3 = dilewati, bukan lulus. Server hanya POSIX.

## Protokol kendali

Argumen: `--port=N --cert=FILE --key=FILE [--short-names] [--caps-delay=MS] [--console|--console-no-echo] [--no-hwheel]`. `--no-hwheel` membuat server tidak mengumumkan dukungan roda horizontal (`FreeRDP_HasHorizontalWheel` mati): klien FreeRDP lalu membuang peristiwa `PTR_FLAGS_HWHEEL` dan tidak mengirimnya, seperti terhadap server lama. `--caps-delay` menunda pengumuman caps display control agar permintaan resize yang datang lebih dulu dapat dilatih; `--short-names` mematikan format list nama panjang. `--console` mengganti layar merah/biru dengan konsol palsu (biru 0x012456) yang menggambar satu blok per tombol yang diketik dan pindah baris pada Enter; `--console-no-echo` sama tetapi tidak pernah menggambar. Keduanya hanya dipakai oleh uji pengaman input pengendali lab (`work/ui-live-20261016/selftest-guard.mjs`), bukan oleh `test-native-integration.mjs`.

Perintah di stdin (satu baris): `announce <hex UTF-16LE termasuk NUL>`, `announce-mixed <hex>` (daftar format campuran seperti aplikasi Windows: CF_TEXT, CF_OEMTEXT, CF_LOCALE, CF_UNICODETEXT, lalu dua format file), `announce-files` (mengumumkan `FileGroupDescriptorW` dan `FileContents`), `clear`, `request-text` (meminta teks klien tanpa diminta, seperti server jahat), `resize <w> <h>` (resize yang dimulai server), `end-session <kode>` (mengirim PDU error info dengan kode desimal itu, mis. 5 = koneksi lain mengambil alih dan 12 = logoff oleh pengguna, lalu memutus sambungan seperti server yang mengakhiri sesi; dipakai skenario “a session the server ends reports why”; dengan kata `first` sesudah kode, mis. `end-session 1 first`, yang diakhiri adalah koneksi tertua yang masih hidup dan bukan yang terbaru, seperti server yang memutus koneksi lama bila akun yang sama menyambung lagi; dipakai suite GUI loopback untuk petunjuk pengambilalihan), `quit`.

Event di stdout (satu baris; baris log FreeRDP diawali `[`): `READY`, `CONNECTED w h`, `CHANNEL drdynvc|cliprdr`, `DRDYNVC state`, `DISPCAPS`, `LAYOUT w h` (layout monitor yang dikirim klien), `DESKTOP w h drawn` (setiap aktivasi, setelah layar digambar), `CLIPCAPS flags`, `CLIPLIST ids`, `CLIPACK`, `CLIPREQUEST id`, `CLIPFAIL`, `CLIPTEXT hex` (UTF-16LE apa adanya), `MOUSE x y flags`, `KEY flags code`, `ERRINFO n` (error info yang baru dikirim oleh `end-session`), `ERROR ...`, `DISCONNECTED`.

Layar: setengah kiri merah, setengah kanan biru, surface bits mentah; digambar ulang pada setiap (re)aktivasi.

## Batas yang disengaja

Server memproses satu reaktivasi pada satu waktu (permintaan layout yang datang selama itu digabung ke ukuran terakhir), seperti server nyata. Jika tidak, klien menjawab setiap Demand Active dan server menolak Confirm Active kedua. Ini juga bukan pengganti uji terhadap Windows RDS: perilaku server Windows (caps, urutan format list, ukuran maksimum) tetap harus dibuktikan di lab.
