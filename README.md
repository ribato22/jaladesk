# Remote Workspace — RDP spike

Alternatif independen dengan Electron/TypeScript dan bridge FreeRDP C++. Tahap ini menguji framebuffer dan input RDP di canvas aplikasi. Ini belum produk dengan seluruh fitur Royal TSX.

## Menjalankan

Gunakan Node.js 26.x; versi yang diuji 26.10.0. Dari folder `outputs/app`:

```sh
npm ci
npm test
npm run bootstrap:native
npm start
```

`bootstrap:native` memerlukan compiler/SDK native, CMake >=3.22, Perl, tar, serta make di macOS atau nmake di Windows. Windows: gunakan **x64 Native Tools Command Prompt for Visual Studio** dengan compiler yang mendukung source FreeRDP 3.32.2. Bootstrap tidak menginstal toolchain global dan tidak membuat layanan/server. Build dependensi berada di `../../work`; arsip upstream diverifikasi SHA256 sebelum ekstraksi. Mesin ini menggunakan CMake 4.4.4, Apple clang 21.0.0, SDK 27.0, dan macOS 27.0.1 arm64.

Bootstrap membangun OpenSSL 3.6.5 secara static, FreeRDP 3.32.2, kemudian bridge. Windows men-stage DLL runtime yang ditemukan CMake bersama EXE dan menjalankan self-check fixture dengan PATH dibatasi ke System32. Dependency yang hilang membuat build gagal. **Cabang Windows belum diuji pada host Windows.** macOS masih menggunakan dylib FreeRDP/WinPR dari prefix build; artefak ini belum relocatable, signed, notarized, atau installer.

Untuk bridge x86_64 di Mac yang menyediakan SDK dan Rosetta:

```sh
RDP_ARCH=x64 npm run bootstrap:native
```

Ini mengganti `native/bin/rdp-bridge`. Jalankan ulang bootstrap tanpa override untuk kembali ke arsitektur host. Electron yang dipasang `npm ci` mengikuti arsitektur Node/host; menjalankan bridge x64 dari Electron arm64 bukan bukti baseline aplikasi macOS Intel.

Untuk prefix FreeRDP/OpenSSL yang sudah dibangun, gunakan `npm run build:native` dengan `RDP_FREERDP_PREFIX` dan `RDP_OPENSSL_ROOT`. `RDP_CMAKE`, `RDP_CTEST`, dan `RDP_NATIVE_BUILD` dapat memilih tool/build directory. Bootstrap memakai `work/bridge-build-<platform>-<arch>`; jalankan CTest dengan direktori itu:

```sh
RDP_NATIVE_BUILD=../../work/bridge-build-darwin-arm64 npm run test:native
npm start -- --fixture
npm run test:live
```

`--fixture` menghasilkan dua pixel lokal. `test:live` mengevaluasi evidence manual, bukan login otomatis; exit **2** berarti acceptance belum lulus. [Prosedur lab](lab/README.md) memisahkan fixture, build, dan sesi RDP nyata.

## Koneksi lab

Isi host/port/username pada aplikasi. Password/domain hanya melalui dialog lokal dan stdin bridge; tidak disimpan ke source, argv, renderer utama, atau laporan. Unknown certificate ditolak. Pin SHA256 opsional harus dibaca dari sumber lab tepercaya terlebih dahulu; jangan menyalin fingerprint hasil koneksi baru sebagai keputusan trust tanpa verifikasi lain.

UI menerima keyboard fisik US dan pointer. Pergantian tab, blur, atau kehilangan pointer capture melepas tombol ke sesi asal. Main mengirim paling banyak satu frame yang menunggu ACK dan satu pending terbaru per sesi. Remote content dirender sebagai pixel, bukan HTML.

## Batas tahap ini

- Desktop awal 1280×720. Resize dari server didukung; permintaan resize client berhenti dengan alasan reconnect, dan UI reconnect belum diotomatisasi.
- Clipboard, wheel, audio, drive/printer/USB redirection, multi-monitor, gateway, Entra login, vault, dan IME belum diimplementasikan.
- Tes otomatis dapat berjalan tanpa bridge; native integration test ditandai skipped bila helper belum dibangun. Hasil yang dilaporkan harus menyertakan jumlah skip.
- Credential mempunyai beberapa salinan sementara di memory native; zeroization belum dilakukan. Main memvalidasi NUL, tetapi handshake native standalone belum konsisten menolaknya. Exit normal helper masih bisa ditampilkan sebagai `helper-exit`.
- Semua baseline live macOS arm64, macOS x86_64, dan Windows 11 x64 harus dibuktikan terpisah sebelum gate RDP dinyatakan lulus.

## Sumber dan lisensi

[Manifest sumber](native/third-party/SOURCES.json), [lisensi FreeRDP](third-party/FreeRDP-LICENSE), [lisensi OpenSSL](native/third-party/OpenSSL-LICENSE.txt), header JSON dengan lisensi MIT, [panduan kompilasi upstream](https://github.com/FreeRDP/FreeRDP/wiki/Compilation), dan [CMake runtime dependencies](https://cmake.org/cmake/help/latest/command/install.html#installing-runtime-dependencies). Pin dependensi merupakan input build, bukan pernyataan bahwa security review upstream telah selesai.
