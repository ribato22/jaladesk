# JalaDesk Privacy Policy

**Effective Date:** November 9, 2026  
**Developer / Data Controller:** Rizky Bachtiar Irwanto (`@ribato22`)  
**Application:** JalaDesk (`com.jaladesk.app`) for Android, iOS, iPadOS, macOS, and Windows  
**Contact Email:** `rizkybachtiar7@gmail.com`

---

## 1. Zero-Knowledge & Local-First Privacy Architecture

**JalaDesk** is designed with a strict **Zero-Trust, Local-First architecture**. We do **not** collect, transmit, rent, or sell your personal data, server IP addresses, SSH keys, passwords, or RFC 6238 TOTP 2FA secrets to any third-party analytics or advertising servers.

## 2. Data Stored on Your Device

All connection configurations, host addresses, credentials, and 2FA tokens are stored locally on your device inside an authenticated **`AES-256-GCM`** encrypted container (`.rwdoc` / `.rtsz` / `.jaladesk`) protected by:
- **Key Derivation**: Hardened `scrypt` / `PBKDF2-HMAC-SHA256` key derivation from your master passphrase.
- **Hardware Keystore & Biometrics**: Optional hardware-backed unlock via Android Keystore / BiometricPrompt (`USE_BIOMETRIC`) or Apple Secure Enclave (`Face ID` / `Touch ID`).
- **Automatic Clipboard Scrubber**: Copied secrets and TOTP tokens are automatically purged from the device clipboard after the configured TTL window (default: 30 seconds).

## 3. Network & Permissions Usage

JalaDesk requests only the minimum OS permissions necessary to operate:
- **`android.permission.INTERNET` / Local Network**: Used solely to establish direct, user-initiated remote connections (`RDP`, `VNC`, `SSH`, `SFTP`) to the servers you configure, or to synchronize encrypted vault files directly with your paired JalaDesk Desktop client over your local network (`LAN mDNS`).
- **`android.permission.USE_BIOMETRIC` / `Face ID`**: Used locally on-device through the operating system's standard biometric API to unlock your encrypted credential vault. Biometric templates never leave your device's hardware enclave.

## 4. Third-Party Data Sharing & Analytics

- **Zero Third-Party Trackers**: JalaDesk contains no advertising SDKs, no behavioral trackers, and no third-party telemetry brokers.
- **Data Retention & Deletion**: Because all vault data resides locally on your device, uninstalling JalaDesk or deleting your vault file immediately and permanently removes all stored data.

## 5. Contact Us

If you have any questions regarding this Privacy Policy or JalaDesk's security practices, please contact:
- **Developer**: Rizky Bachtiar Irwanto
- **Email**: `rizkybachtiar7@gmail.com`
- **GitHub Repository**: [https://github.com/ribato22/jaladesk](https://github.com/ribato22/jaladesk)
