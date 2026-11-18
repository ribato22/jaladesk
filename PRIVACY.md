# JalaDesk Privacy Policy

**Effective Date:** November 18, 2026  
**Application Name:** JalaDesk (`com.jaladesk.app`)  
**Supported Platforms:** macOS, Windows, Android, iOS, and iPadOS  
**Data Controller / Developer:** Rizky Bachtiar Irwanto (`@ribato22`)  
**Contact Email:** `rizkybachtiar7@gmail.com`  
**Official Website:** [https://ribato22.github.io/jaladesk/](https://ribato22.github.io/jaladesk/)

---

## Zero-Knowledge & Local-First Privacy Architecture

**JalaDesk** is engineered with a strict **Zero-Knowledge, Local-First security architecture**. JalaDesk operates completely on your device without requiring an account. Rizky Bachtiar Irwanto operates **zero backend, telemetry, or proxy servers** that collect, inspect, store, rent, or sell your personal information, server IP addresses, SSH private keys, passwords, or RFC 6238 TOTP 2FA secrets.

---

## Data Stored Locally on Your Device

All connection profiles, jump-host topologies, credentials, and 2FA secrets are stored locally on your device inside an authenticated **`AES-256-GCM`** encrypted container (`.rwdoc`, `.rtsz`, `.jaladesk`, or `.jvault`) protected by:

- **Cryptographic Key Derivation:** Hardened `scrypt` and `PBKDF2-HMAC-SHA256` (`100,000` iterations with unique random salts) derived locally from your master passphrase.
- **OS Keychain & Hardware Biometrics:** Optional local unlock via macOS Keychain, Windows DPAPI, Android Keystore / `BiometricPrompt` (`USE_BIOMETRIC`), or Apple Secure Enclave (`Face ID` / `Touch ID`). Biometric templates never leave your device's hardware enclave.
- **Automatic Clipboard Scrubber:** Passwords, private keys, and RFC 6238 TOTP codes copied within JalaDesk are automatically cleared from the system clipboard after the configured TTL window (default: 30 seconds).

---

## Optional Google Sign-In & Google User Data Disclosures

JalaDesk provides an **optional, user-initiated Cloud Vault Sync** feature that lets you synchronize your client-side encrypted vault across your own devices using your own Google Account. If you never enable Google Drive Cloud Sync, JalaDesk makes zero requests to Google APIs.

### Google OAuth 2.0 Scopes Requested

When you explicitly click **Sign in with Google** inside JalaDesk, the application requests only the following non- personal-file OAuth 2.0 scopes via PKCE:

| OAuth Scope | Google User Data Accessed | Exact Purpose & On-Device Use |
| :--- | :--- | :--- |
| `openid` | OpenID Connect subject identifier | Authenticates your Google Sign-In session directly between your device and Google's OAuth 2.0 endpoints (`accounts.google.com` and `oauth2.googleapis.com`). |
| `userinfo.email` (`email`) | Primary Google account email address | Displayed locally inside JalaDesk's Cloud Sync settings panel so you can verify which Google account is currently paired on your device. |
| `userinfo.profile` (`profile`) | Basic Google profile display name and avatar metadata | Displayed locally inside JalaDesk's Cloud Sync status header to identify the active sync session on your device. |
| `https://www.googleapis.com/auth/drive.appdata` | Hidden, app-specific Google Drive `appDataFolder` container (`jaladesk-vault-v1.jvault` / `jaladesk_vault_sync_v1.jdesk`) | Reads, creates, updates, and deletes **only** JalaDesk's own encrypted vault file inside your private Google Drive Application Data folder. JalaDesk **cannot** view, list, read, modify, or delete any personal files, folders, documents, or photos in your Google Drive. |

### Client-Side Encryption Before Upload

Before any vault payload is uploaded to Google Drive `appDataFolder`, JalaDesk derives an encryption key locally on your device from your Vault Master Passphrase using **`PBKDF2-HMAC-SHA256` (`100,000` iterations)** and seals the payload using authenticated **`AES-256-GCM`** encryption with a random initialization vector and authentication tag.

- Plaintext hostnames, usernames, passwords, SSH keys, and 2FA secrets **never** leave your device unencrypted.
- Your Vault Master Passphrase is never transmitted to Google or to the developer.
- OAuth 2.0 access and refresh tokens are stored exclusively on your local device and are used solely to communicate directly over HTTPS (`TLS 1.2+`) with Google's official APIs (`www.googleapis.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`).

### Data Sharing, Transfers, Advertising & AI/ML Prohibitions

- **No Developer Servers:** Google user data (`openid`, email, profile metadata, OAuth tokens, and `drive.appdata` files) is never transmitted to any server operated by Rizky Bachtiar Irwanto.
- **No Third-Party Sharing or Sale:** JalaDesk never sells, rents, brokers, or transfers Google user data to any third party, analytics provider, or data broker.
- **No Advertising:** Google user data is never used for targeted, personalized, or retargeted advertising.
- **No AI / ML Model Training:** Google user data and synced encrypted vault files are never used to train, fine-tune, or improve any generalized artificial intelligence (AI) or machine learning (ML) models.

### Google API Services User Data Policy — Limited Use Compliance

JalaDesk's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.

Official policy reference: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

---

## Network & Operating System Permissions

JalaDesk requests only the minimum operating system capabilities required for user-initiated infrastructure connections:

- **Network Access (`INTERNET` / Local Network):** Used strictly to open direct `RDP`, `VNC`, `SSH`, `SFTP`, `Jump Host` bastion, WebDAV, GitHub Gist, or Google Drive `appDataFolder` HTTPS connections explicitly initiated or configured by the user, or local-network (`LAN mDNS`) encrypted vault pairing between JalaDesk Desktop and JalaDesk Mobile.
- **Biometric Authentication (`USE_BIOMETRIC` / `Face ID` / `Touch ID`):** Used strictly on-device through OS APIs to unlock local encrypted vaults or App Lock PIN protections.

---

## Data Retention, Deletion & Revoking Google OAuth Access

You retain full ownership and control over your local vault and any synced cloud data at all times:

1. **Disconnect Cloud Sync in JalaDesk:** Open **Cloud Sync** inside JalaDesk and select **Disconnect Google Account**. JalaDesk immediately deletes the locally stored Google OAuth tokens and cached account email/profile metadata from your device.
2. **Delete Synced Vault Data in Google Drive:** You can delete the encrypted `jaladesk-vault-v1.jvault` container directly from JalaDesk's Cloud Sync controls, or at any time in Google Drive on the web via **Settings -> Manage apps -> JalaDesk -> Options -> Delete hidden app data**.
3. **Revoke Google OAuth Permissions:** You can revoke JalaDesk's OAuth 2.0 access to your Google Account at any time by visiting [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions), selecting **JalaDesk**, and clicking **Remove Access**.
4. **Delete Local Device Data:** Uninstalling JalaDesk or deleting your local `.rwdoc` / `.jaladesk` / `.jvault` files permanently removes all locally stored connection data and credentials from your device.

---

## Contact Information

For questions, security inquiries, or privacy requests regarding JalaDesk (`com.jaladesk.app`), contact the Data Controller directly:

- **Data Controller / Developer:** Rizky Bachtiar Irwanto
- **Email:** [rizkybachtiar7@gmail.com](mailto:rizkybachtiar7@gmail.com)
- **Official Home Page:** [https://ribato22.github.io/jaladesk/](https://ribato22.github.io/jaladesk/)
- **Terms of Service:** [https://ribato22.github.io/jaladesk/terms.html](https://ribato22.github.io/jaladesk/terms.html)
- **Source Repository:** [https://github.com/ribato22/jaladesk](https://github.com/ribato22/jaladesk)
