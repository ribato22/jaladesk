# JalaDesk Mobile — App Store & Google Play Store Publishing Guide (Personal Developer Accounts)

This guide covers building, signing, and submitting **JalaDesk Mobile (`com.jaladesk.app`)** to both the **Google Play Store** and the **Apple App Store** using your personal developer accounts.

---

## 1. Pre-Configured Store Readiness Checklist

All technical requirements for App Store Connect and Google Play Console are already configured in `mobile/`:

- **Official Display Name**: `JalaDesk` (`AndroidManifest.xml` & `ios/Runner/Info.plist`).
- **Application / Bundle ID**: `com.jaladesk.app` (`android/app/build.gradle.kts`).
- **Store-Compliant App Icons**:
  - **iOS (`AppIcon.appiconset`)**: All 15 required sizes (`20pt` through `1024×1024` App Store marketing icon) rendered in **opaque RGB (`noneSkipLast`) without alpha transparency** (prevents Apple error `ITMS-90717`).
  - **Android (`mipmap-mdpi` .. `mipmap-xxxhdpi`)**: All 5 density buckets rendered from the official **Simpul Jala Emas-Safir** icon.
- **Required iOS Privacy & Export Compliance Keys (`ios/Runner/Info.plist`)**:
  - `NSFaceIDUsageDescription`: Explains Face ID usage for unlocking the Zero-Trust vault.
  - `NSLocalNetworkUsageDescription`: Explains local network access for RDP/VNC/SSH and LAN vault sync.
  - `ITSAppUsesNonExemptEncryption = false`: Eliminates manual US Export Compliance prompts on every TestFlight / App Store build.
- **Android Release Permissions & Signing (`android/app/build.gradle.kts`)**:
  - Declares `android.permission.INTERNET` and `android.permission.USE_BIOMETRIC`.
  - Automatically reads `android/key.properties` when present for release `.aab` signing.

---

## 2. Publishing to Google Play Store (Personal Account)

### Step A — Generate Your Personal Upload Keystore (Run Once)

Run this command inside `mobile/android/app/` to create your personal `upload-keystore.jks` (keep this file backed up safely; never commit it to Git):

```bash
cd mobile/android/app
keytool -genkey -v \
  -keystore upload-keystore.jks \
  -storetype JKS \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias jaladesk-upload
```

Then copy `mobile/android/key.properties.example` to `mobile/android/key.properties` and fill in the password you chose:

```ini
storePassword=YOUR_PASSWORD
keyPassword=YOUR_PASSWORD
keyAlias=jaladesk-upload
storeFile=upload-keystore.jks
```

### Step B — Build the Signed Android App Bundle (`.aab`)

```bash
cd mobile
flutter build appbundle --release
```

Your signed Play Store bundle will be generated at:
`mobile/build/app/outputs/bundle/release/app-release.aab`

### Step C — Upload to Google Play Console

1. Open [Google Play Console](https://play.google.com/console) and click **Create app**:
   - **App name**: `JalaDesk`
   - **Default language**: `English (United States)` or `Indonesian`
   - **App or game**: `App`
   - **Free or paid**: `Free`
2. Complete the **App Content** declarations:
   - **Data Safety**: Select *No data shared with third parties*; credentials and `.rtsz` / `.rwdoc` vaults are encrypted locally on-device with `AES-256-GCM`.
   - **Target Audience**: `18 and over` (Enterprise / System Administration tool).
3. Go to **Testing → Closed testing** (or **Production** if your personal Play account was created before Nov 2023) → **Create new release** → Upload `app-release.aab`.
   - *Note for Personal Play Accounts created after Nov 2023*: Google requires a 14-day closed test with 12 testers before enabling the **Apply for Production** button.

---

## 3. Publishing to Apple App Store (Personal Account)

### Step A — Configure Your Personal Apple Team in Xcode

1. Ensure you are enrolled in the **Apple Developer Program** ($99/year Individual account) and signed into **Xcode → Settings (`⌘,`) → Accounts** with your Apple ID.
2. Open the iOS workspace in Xcode:
   ```bash
   open mobile/ios/Runner.xcworkspace
   ```
3. In the left navigator, click **Runner** → select the **Runner** target → open the **Signing & Capabilities** tab:
   - Check **Automatically manage signing**.
   - **Team**: Select your personal Apple Developer Team (`Rizky Bachtiar Irwanto (Personal Team)` / Individual Team).
   - **Bundle Identifier**: Set to `com.jaladesk.app`.

### Step B — Build the Signed iOS Archive (`.ipa`)

```bash
cd mobile
flutter build ipa --release
```

### Step C — Upload to App Store Connect & TestFlight

1. Open the generated archive in Xcode Organizer:
   ```bash
   open mobile/build/ios/archive/Runner.xcarchive
   ```
2. Click **Distribute App** → **App Store Connect** → **Upload**.
3. Log in to [App Store Connect](https://appstoreconnect.apple.com) → **Apps** → **+** (**New App**):
   - **Platforms**: `iOS`
   - **Name**: `JalaDesk`
   - **Primary Language**: `English (U.S.)`
   - **Bundle ID**: `com.jaladesk.app`
   - **SKU**: `JALADESK-MOBILE-001`
   - **Category**: `Developer Tools` (Primary) & `Productivity` (Secondary)
4. Select your uploaded build, attach the screenshots from `docs/assets/mobile-*.png`, and click **Add for Review**.
