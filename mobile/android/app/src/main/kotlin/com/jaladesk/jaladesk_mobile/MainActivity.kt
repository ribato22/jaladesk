package com.jaladesk.jaladesk_mobile

import android.app.Activity
import android.app.KeyguardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : FlutterActivity() {
    companion object {
        private const val CHANNEL_NAME = "com.jaladesk.app/native"
        private const val KEK_ALIAS = "jaladesk_enclave_kek_v1"
        private const val AKS_PREFIX = "aks:v1:"
        private const val REQ_PICK_FILES = 4101
        private const val REQ_PICK_DIRECTORY = 4102
    }

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var pendingPickResult: MethodChannel.Result? = null
    private var biometricCancelSignal: CancellationSignal? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyEdgeToEdgeCutoutMode()
        // Enterprise Zero-Trust default: shield live sessions, passwords, and 2FA codes from Recents/Screen-Capture
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            applyEdgeToEdgeCutoutMode()
        }
    }

    private fun applyEdgeToEdgeCutoutMode() {
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        }
        @Suppress("DEPRECATION")
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        window.attributes = window.attributes.apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL_NAME)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "setSecureScreen" -> {
                        val enable = call.argument<Boolean>("enable") ?: true
                        if (enable) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        }
                        result.success(enable)
                    }
                    "pickFiles" -> {
                        if (pendingPickResult != null) {
                            result.error("BUSY", "Another file picker request is active.", null)
                            return@setMethodCallHandler
                        }
                        val allowMultiple = call.argument<Boolean>("allowMultiple") ?: true
                        pendingPickResult = result
                        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                        }
                        @Suppress("DEPRECATION")
                        startActivityForResult(intent, REQ_PICK_FILES)
                    }
                    "pickDirectory" -> {
                        if (pendingPickResult != null) {
                            result.error("BUSY", "Another folder picker request is active.", null)
                            return@setMethodCallHandler
                        }
                        pendingPickResult = result
                        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        @Suppress("DEPRECATION")
                        startActivityForResult(intent, REQ_PICK_DIRECTORY)
                    }
                    "exportToDownloads" -> {
                        val sourcePath = call.argument<String>("sourcePath") ?: ""
                        val subDir = call.argument<String>("subDir") ?: ""
                        val fileName = call.argument<String>("fileName") ?: File(sourcePath).name
                        if (sourcePath.isEmpty() || !File(sourcePath).exists()) {
                            result.error("MISSING_SOURCE", "Source file not found: $sourcePath", null)
                            return@setMethodCallHandler
                        }
                        ioExecutor.execute {
                            try {
                                val savedDisplayPath = saveFileToDownloads(
                                    sourceFile = File(sourcePath),
                                    subDir = subDir,
                                    fileName = sanitizeSegment(fileName.ifEmpty { "download.bin" })
                                )
                                runOnUiThread {
                                    result.success(mapOf("savedPath" to savedDisplayPath))
                                }
                            } catch (e: Exception) {
                                runOnUiThread {
                                    result.error("EXPORT_FAILED", e.message ?: "Failed to export file", null)
                                }
                            }
                        }
                    }
                    "getAppStoragePaths" -> {
                        val docsDir = File(filesDir, "sftp_workspace").apply { mkdirs() }
                        result.success(
                            mapOf(
                                "workspacePath" to docsDir.absolutePath,
                                "cachePath" to cacheDir.absolutePath
                            )
                        )
                    }
                    "wrapMasterSecret" -> {
                        val plainBase64 = call.argument<String>("plainBase64") ?: ""
                        if (plainBase64.isEmpty()) {
                            result.error("INVALID_ARG", "plainBase64 is required", null)
                            return@setMethodCallHandler
                        }
                        try {
                            result.success(wrapMasterSecretInHardware(plainBase64))
                        } catch (e: Exception) {
                            result.error("KEYSTORE_WRAP_FAILED", e.message ?: "Hardware Keystore wrap failed", null)
                        }
                    }
                    "unwrapMasterSecret" -> {
                        val wrapped = call.argument<String>("wrapped") ?: ""
                        if (!wrapped.startsWith(AKS_PREFIX)) {
                            result.error("INVALID_ARG", "Unsupported Hardware Keystore envelope", null)
                            return@setMethodCallHandler
                        }
                        try {
                            result.success(unwrapMasterSecretInHardware(wrapped))
                        } catch (e: Exception) {
                            result.error("KEYSTORE_UNWRAP_FAILED", e.message ?: "Hardware Keystore unwrap failed", null)
                        }
                    }
                    "getSecurityHardwareStatus" -> {
                        val strongBoxSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                            packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
                        result.success(
                            mapOf(
                                "keystoreAvailable" to true,
                                "strongBoxBacked" to strongBoxSupported,
                                "biometricAvailable" to checkBiometricAvailable()
                            )
                        )
                    }
                    "isBiometricAvailable" -> {
                        result.success(checkBiometricAvailable())
                    }
                    "authenticateBiometric" -> {
                        val title = call.argument<String>("title") ?: "Unlock JalaDesk Vault"
                        val subtitle = call.argument<String>("subtitle")
                            ?: "Verify your identity to unseal encrypted credentials & 2FA"
                        promptHardwareBiometric(title, subtitle, result)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    @Deprecated("Deprecated in Android Activity API; retained for zero-dependency FlutterActivity compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode != REQ_PICK_FILES && requestCode != REQ_PICK_DIRECTORY) {
            return
        }

        val callback = pendingPickResult
        pendingPickResult = null
        if (callback == null) return

        if (resultCode != Activity.RESULT_OK || data == null) {
            callback.success(null)
            return
        }

        if (requestCode == REQ_PICK_FILES) {
            val uris = mutableListOf<Uri>()
            val clip = data.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) {
                    clip.getItemAt(i)?.uri?.let { uris.add(it) }
                }
            } else {
                data.data?.let { uris.add(it) }
            }
            if (uris.isEmpty()) {
                callback.success(null)
                return
            }
            ioExecutor.execute {
                try {
                    val stageRoot = File(cacheDir, "sftp_stage_${System.currentTimeMillis()}").apply { mkdirs() }
                    val stagedList = mutableListOf<Map<String, Any>>()
                    for ((idx, uri) in uris.withIndex()) {
                        val displayName = sanitizeSegment(queryDisplayName(uri) ?: "file_$idx")
                        val destFile = uniqueChildFile(stageRoot, displayName)
                        contentResolver.openInputStream(uri)?.use { input ->
                            FileOutputStream(destFile).use { output ->
                                input.copyTo(output, bufferSize = 65536)
                            }
                        } ?: continue
                        stagedList.add(
                            mapOf(
                                "path" to destFile.absolutePath,
                                "name" to destFile.name,
                                "size" to destFile.length()
                            )
                        )
                    }
                    runOnUiThread { callback.success(stagedList) }
                } catch (e: Exception) {
                    runOnUiThread {
                        callback.error("STAGE_FILE_ERROR", e.message ?: "Unable to read selected file", null)
                    }
                }
            }
        } else if (requestCode == REQ_PICK_DIRECTORY) {
            val treeUri = data.data
            if (treeUri == null) {
                callback.success(null)
                return
            }
            ioExecutor.execute {
                try {
                    val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
                    val rootDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)
                    val rawFolderName = queryDisplayName(rootDocUri)
                        ?: rootDocId.substringAfterLast(':').substringAfterLast('/').ifEmpty { "uploaded_folder" }
                    val cleanFolderName = sanitizeSegment(rawFolderName)
                    val stageBase = File(cacheDir, "sftp_tree_${System.currentTimeMillis()}").apply { mkdirs() }
                    val localFolder = File(stageBase, cleanFolderName).apply { mkdirs() }
                    val copiedFiles = copyDocumentTreeRecursive(treeUri, rootDocId, localFolder, depth = 0)
                    runOnUiThread {
                        callback.success(
                            mapOf(
                                "path" to localFolder.absolutePath,
                                "name" to cleanFolderName,
                                "fileCount" to copiedFiles
                            )
                        )
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        callback.error("STAGE_DIR_ERROR", e.message ?: "Unable to stage selected directory", null)
                    }
                }
            }
        }
    }

    private fun copyDocumentTreeRecursive(treeUri: Uri, parentDocId: String, targetDir: File, depth: Int): Int {
        if (depth > 16) return 0
        targetDir.mkdirs()
        var totalFiles = 0
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        )
        contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
            val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
            while (cursor.moveToNext()) {
                val docId = if (idIdx >= 0) cursor.getString(idIdx) else continue
                val rawName = if (nameIdx >= 0) cursor.getString(nameIdx) else "item"
                val mime = if (mimeIdx >= 0) cursor.getString(mimeIdx) else ""
                val safeName = sanitizeSegment(rawName ?: "item")
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val subDir = File(targetDir, safeName)
                    totalFiles += copyDocumentTreeRecursive(treeUri, docId, subDir, depth + 1)
                } else {
                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                    val destFile = uniqueChildFile(targetDir, safeName)
                    contentResolver.openInputStream(docUri)?.use { input ->
                        FileOutputStream(destFile).use { output ->
                            input.copyTo(output, bufferSize = 65536)
                        }
                        totalFiles++
                    }
                }
            }
        }
        return totalFiles
    }

    private fun saveFileToDownloads(sourceFile: File, subDir: String, fileName: String): String {
        val cleanSub = subDir.split('/')
            .map { sanitizeSegment(it) }
            .filter { it.isNotEmpty() && it != "." && it != ".." }
            .joinToString("/")
        val relativeFolder = if (cleanSub.isEmpty()) {
            "${Environment.DIRECTORY_DOWNLOADS}/JalaDesk"
        } else {
            "${Environment.DIRECTORY_DOWNLOADS}/JalaDesk/$cleanSub"
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
                put(MediaStore.Downloads.RELATIVE_PATH, "$relativeFolder/")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore Downloads rejected $fileName")
            try {
                resolver.openOutputStream(itemUri)?.use { out ->
                    FileInputStream(sourceFile).use { input ->
                        input.copyTo(out, bufferSize = 65536)
                    }
                } ?: throw IllegalStateException("Cannot open MediaStore stream for $fileName")
                val ready = ContentValues().apply {
                    put(MediaStore.Downloads.IS_PENDING, 0)
                }
                resolver.update(itemUri, ready, null, null)
            } catch (e: Exception) {
                resolver.delete(itemUri, null, null)
                throw e
            }
            return "$relativeFolder/$fileName"
        } else {
            @Suppress("DEPRECATION")
            val baseDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val targetFolder = if (cleanSub.isEmpty()) {
                File(baseDownloads, "JalaDesk")
            } else {
                File(baseDownloads, "JalaDesk/$cleanSub")
            }
            targetFolder.mkdirs()
            val outFile = uniqueChildFile(targetFolder, fileName)
            FileInputStream(sourceFile).use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output, bufferSize = 65536)
                }
            }
            return outFile.absolutePath
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) return c.getString(idx)
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')
    }

    private fun sanitizeSegment(raw: String): String {
        val cleaned = raw.trim().replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_")
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "item" else cleaned
    }

    private fun uniqueChildFile(dir: File, preferredName: String): File {
        var candidate = File(dir, preferredName)
        if (!candidate.exists()) return candidate
        val dot = preferredName.lastIndexOf('.')
        val stem = if (dot > 0) preferredName.substring(0, dot) else preferredName
        val ext = if (dot > 0) preferredName.substring(dot) else ""
        var counter = 1
        while (candidate.exists() && counter < 1000) {
            candidate = File(dir, "${stem}_$counter$ext")
            counter++
        }
        return candidate
    }

    private fun getOrCreateHardwareKek(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(KEK_ALIAS)) {
            val existing = (keyStore.getEntry(KEK_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
            if (existing != null) return existing
        }

        val buildSpec = { useStrongBox: Boolean ->
            val builder = KeyGenParameterSpec.Builder(
                KEK_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
            if (useStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                builder.setIsStrongBoxBacked(true)
            }
            builder.build()
        }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        ) {
            try {
                keyGen.init(buildSpec(true))
                return keyGen.generateKey()
            } catch (_: Exception) {
                // Automatic fallback to standard TEE AndroidKeyStore when StrongBox chip rejects GCM or is full
            }
        }
        keyGen.init(buildSpec(false))
        return keyGen.generateKey()
    }

    private fun wrapMasterSecretInHardware(plainBase64: String): String {
        val plainBytes = Base64.decode(plainBase64, Base64.DEFAULT)
        val secretKey = getOrCreateHardwareKek()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plainBytes)
        val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)
        val ctB64 = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
        return "$AKS_PREFIX$ivB64:$ctB64"
    }

    private fun unwrapMasterSecretInHardware(wrapped: String): String {
        val body = wrapped.removePrefix(AKS_PREFIX)
        val sep = body.indexOf(':')
        require(sep > 0) { "Malformed AndroidKeyStore envelope" }
        val iv = Base64.decode(body.substring(0, sep), Base64.DEFAULT)
        val ciphertext = Base64.decode(body.substring(sep + 1), Base64.DEFAULT)
        val secretKey = getOrCreateHardwareKek()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
        val plainBytes = cipher.doFinal(ciphertext)
        return Base64.encodeToString(plainBytes, Base64.NO_WRAP)
    }

    private fun checkBiometricAvailable(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (km?.isKeyguardSecure != true) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val bm = getSystemService(BiometricManager::class.java)
            if (bm != null) {
                val res = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    bm.canAuthenticate(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.BIOMETRIC_WEAK
                    )
                } else {
                    @Suppress("DEPRECATION")
                    bm.canAuthenticate()
                }
                return res == BiometricManager.BIOMETRIC_SUCCESS
            }
        }
        @Suppress("DEPRECATION")
        return packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                (packageManager.hasSystemFeature(PackageManager.FEATURE_FACE) ||
                    packageManager.hasSystemFeature(PackageManager.FEATURE_IRIS)))
    }

    private fun promptHardwareBiometric(
        title: String,
        subtitle: String,
        result: MethodChannel.Result
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || !checkBiometricAvailable()) {
            result.success(false)
            return
        }
        biometricCancelSignal?.cancel()
        val cancelSignal = CancellationSignal()
        biometricCancelSignal = cancelSignal
        val completed = AtomicBoolean(false)

        try {
            val prompt = BiometricPrompt.Builder(this)
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButton("Use PIN", mainExecutor) { _, _ ->
                    if (completed.compareAndSet(false, true)) {
                        runOnUiThread { result.success(false) }
                    }
                }
                .build()

            prompt.authenticate(
                cancelSignal,
                mainExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(authResult: BiometricPrompt.AuthenticationResult?) {
                        if (completed.compareAndSet(false, true)) {
                            runOnUiThread { result.success(true) }
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                        if (completed.compareAndSet(false, true)) {
                            runOnUiThread { result.success(false) }
                        }
                    }
                }
            )
        } catch (_: Exception) {
            if (completed.compareAndSet(false, true)) {
                result.success(false)
            }
        }
    }

    override fun onDestroy() {
        biometricCancelSignal?.cancel()
        biometricCancelSignal = null
        ioExecutor.shutdownNow()
        super.onDestroy()
    }
}
