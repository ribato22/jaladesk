import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';

import '../security/vault_security_service.dart';

enum SftpTransferDirection { upload, download }

class SftpTransferProgress {
  final SftpTransferDirection direction;
  final String rootName;
  final String currentItem;
  final bool isDirectory;
  final int filesCompleted;
  final int totalFiles;
  final int bytesTransferred;
  final int totalBytes;
  final bool isDone;
  final String? savedDestination;
  final String? errorMessage;

  const SftpTransferProgress({
    required this.direction,
    required this.rootName,
    required this.currentItem,
    required this.isDirectory,
    required this.filesCompleted,
    required this.totalFiles,
    required this.bytesTransferred,
    required this.totalBytes,
    this.isDone = false,
    this.savedDestination,
    this.errorMessage,
  });

  double? get fraction {
    if (totalBytes > 0) {
      return (bytesTransferred / totalBytes).clamp(0.0, 1.0);
    }
    if (totalFiles > 0) {
      return (filesCompleted / totalFiles).clamp(0.0, 1.0);
    }
    return null;
  }

  static String formatBytes(int bytes) {
    if (bytes >= 1073741824) {
      return '${(bytes / 1073741824).toStringAsFixed(2)} GB';
    }
    if (bytes >= 1048576) {
      return '${(bytes / 1048576).toStringAsFixed(1)} MB';
    }
    if (bytes >= 1024) {
      return '${(bytes / 1024).toStringAsFixed(1)} KB';
    }
    return '$bytes B';
  }
}

/// Enterprise Streaming SFTP File & Recursive Directory Transfer Engine (`dartssh2`).
class SftpTransferService {
  static const int chunkSize = 65536;
  static const int maxRecursionDepth = 16;

  static String joinRemotePath(String parent, String childName) {
    final cleanChild = childName.replaceAll('\\', '/').split('/').where((s) => s.isNotEmpty).join('/');
    if (childName.startsWith('/')) return '/$cleanChild';
    final base = parent.trim();
    if (base.isEmpty || base == '.') return './$cleanChild';
    if (base == '/') return '/$cleanChild';
    return base.endsWith('/') ? '$base$cleanChild' : '$base/$cleanChild';
  }

  static String basenameOf(String path) {
    final norm = path.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
    final idx = norm.lastIndexOf('/');
    return idx < 0 ? norm : norm.substring(idx + 1);
  }

  static Future<void> ensureRemoteDirectory(SftpClient sftp, String remoteDirPath) async {
    try {
      final st = await sftp.stat(remoteDirPath);
      if (st.isDirectory) return;
    } catch (_) {}
    try {
      await sftp.mkdir(remoteDirPath);
    } catch (_) {}
  }

  /// Streams a single local `File` to `remoteFilePath` in 64KB chunks.
  static Future<int> uploadSingleFile({
    required SftpClient sftp,
    required File localFile,
    required String remoteFilePath,
    void Function(int deltaBytes, int fileUploadedBytes, int fileTotalBytes)? onChunk,
  }) async {
    final totalSize = await localFile.length();
    final remoteFile = await sftp.open(
      remoteFilePath,
      mode: SftpFileOpenMode.create | SftpFileOpenMode.truncate | SftpFileOpenMode.write,
    );
    int offset = 0;
    try {
      await for (final List<int> chunk in localFile.openRead()) {
        if (chunk.isEmpty) continue;
        int pos = 0;
        while (pos < chunk.length) {
          final end = (pos + chunkSize < chunk.length) ? (pos + chunkSize) : chunk.length;
          final slice = Uint8List.fromList(chunk.sublist(pos, end));
          await remoteFile.writeBytes(slice, offset: offset);
          offset += slice.length;
          pos = end;
          onChunk?.call(slice.length, offset, totalSize);
        }
      }
      return offset;
    } finally {
      await remoteFile.close();
    }
  }

  /// Uploads 1 or more local files into `remoteDirectoryPath` with live progress reporting.
  static Future<SftpTransferProgress> uploadFilesBatch({
    required SftpClient sftp,
    required List<File> localFiles,
    required String remoteDirectoryPath,
    void Function(SftpTransferProgress progress)? onProgress,
  }) async {
    int totalBytes = 0;
    for (final f in localFiles) {
      if (await f.exists()) {
        totalBytes += await f.length();
      }
    }
    final rootLabel = localFiles.length == 1
        ? basenameOf(localFiles.first.path)
        : '${localFiles.length} files';
    int transferred = 0;
    int completedFiles = 0;

    for (final f in localFiles) {
      final name = basenameOf(f.path);
      final remoteTarget = joinRemotePath(remoteDirectoryPath, name);
      onProgress?.call(
        SftpTransferProgress(
          direction: SftpTransferDirection.upload,
          rootName: rootLabel,
          currentItem: name,
          isDirectory: false,
          filesCompleted: completedFiles,
          totalFiles: localFiles.length,
          bytesTransferred: transferred,
          totalBytes: totalBytes,
        ),
      );
      await uploadSingleFile(
        sftp: sftp,
        localFile: f,
        remoteFilePath: remoteTarget,
        onChunk: (delta, _, __) {
          transferred += delta;
          onProgress?.call(
            SftpTransferProgress(
              direction: SftpTransferDirection.upload,
              rootName: rootLabel,
              currentItem: name,
              isDirectory: false,
              filesCompleted: completedFiles,
              totalFiles: localFiles.length,
              bytesTransferred: transferred,
              totalBytes: totalBytes,
            ),
          );
        },
      );
      completedFiles++;
    }

    final done = SftpTransferProgress(
      direction: SftpTransferDirection.upload,
      rootName: rootLabel,
      currentItem: rootLabel,
      isDirectory: false,
      filesCompleted: completedFiles,
      totalFiles: localFiles.length,
      bytesTransferred: transferred,
      totalBytes: totalBytes,
      isDone: true,
      savedDestination: remoteDirectoryPath,
    );
    onProgress?.call(done);
    return done;
  }

  /// Recursively uploads an entire local `Directory` (including nested subfolders and empty folders)
  /// to `remoteParentPath/<folderName>`.
  static Future<SftpTransferProgress> uploadDirectoryRecursive({
    required SftpClient sftp,
    required Directory localDir,
    required String remoteParentPath,
    String? overrideFolderName,
    void Function(SftpTransferProgress progress)? onProgress,
  }) async {
    final folderName = (overrideFolderName != null && overrideFolderName.trim().isNotEmpty)
        ? overrideFolderName.trim()
        : basenameOf(localDir.path);
    final remoteRoot = joinRemotePath(remoteParentPath, folderName);

    // 1. Pre-scan local directory tree to compute accurate file & byte totals
    final plannedFiles = <({File file, String remotePath, String relName})>[];
    final plannedDirs = <String>[remoteRoot];
    int totalBytes = 0;

    Future<void> scanLocal(Directory dir, String currentRemoteDir, int depth) async {
      if (depth > maxRecursionDepth) return;
      await for (final entity in dir.list(followLinks: false)) {
        final name = basenameOf(entity.path);
        if (name.isEmpty || name == '.' || name == '..') continue;
        final childRemote = joinRemotePath(currentRemoteDir, name);
        if (entity is Directory) {
          plannedDirs.add(childRemote);
          await scanLocal(entity, childRemote, depth + 1);
        } else if (entity is File) {
          final len = await entity.length();
          totalBytes += len;
          plannedFiles.add((file: entity, remotePath: childRemote, relName: name));
        }
      }
    }

    await scanLocal(localDir, remoteRoot, 0);

    // 2. Create remote folder hierarchy top-down
    for (final dirPath in plannedDirs) {
      await ensureRemoteDirectory(sftp, dirPath);
    }

    // 3. Stream every file
    int transferred = 0;
    int completedFiles = 0;
    for (final item in plannedFiles) {
      onProgress?.call(
        SftpTransferProgress(
          direction: SftpTransferDirection.upload,
          rootName: folderName,
          currentItem: item.relName,
          isDirectory: true,
          filesCompleted: completedFiles,
          totalFiles: plannedFiles.length,
          bytesTransferred: transferred,
          totalBytes: totalBytes,
        ),
      );
      await uploadSingleFile(
        sftp: sftp,
        localFile: item.file,
        remoteFilePath: item.remotePath,
        onChunk: (delta, _, __) {
          transferred += delta;
          onProgress?.call(
            SftpTransferProgress(
              direction: SftpTransferDirection.upload,
              rootName: folderName,
              currentItem: item.relName,
              isDirectory: true,
              filesCompleted: completedFiles,
              totalFiles: plannedFiles.length,
              bytesTransferred: transferred,
              totalBytes: totalBytes,
            ),
          );
        },
      );
      completedFiles++;
    }

    final done = SftpTransferProgress(
      direction: SftpTransferDirection.upload,
      rootName: folderName,
      currentItem: folderName,
      isDirectory: true,
      filesCompleted: completedFiles,
      totalFiles: plannedFiles.length,
      bytesTransferred: transferred,
      totalBytes: totalBytes,
      isDone: true,
      savedDestination: remoteRoot,
    );
    onProgress?.call(done);
    return done;
  }

  /// Downloads a single remote SFTP file to a local `File` via 64KB chunked streaming.
  static Future<int> downloadSingleFileToLocal({
    required SftpClient sftp,
    required String remoteFilePath,
    required File localDestFile,
    void Function(int deltaBytes, int downloadedBytes)? onChunk,
  }) async {
    await localDestFile.parent.create(recursive: true);
    final remoteFile = await sftp.open(remoteFilePath, mode: SftpFileOpenMode.read);
    final sink = localDestFile.openWrite();
    int received = 0;
    try {
      await for (final Uint8List chunk in remoteFile.read(chunkSize: chunkSize)) {
        if (chunk.isEmpty) continue;
        sink.add(chunk);
        received += chunk.length;
        onChunk?.call(chunk.length, received);
      }
      await sink.flush();
      return received;
    } finally {
      await sink.close();
      await remoteFile.close();
    }
  }

  /// Downloads a single remote SFTP file and exports it to `Downloads/JalaDesk/<fileName>`
  /// (or into `customTargetDirectory` when specified for programmatic/test verification).
  static Future<SftpTransferProgress> downloadRemoteFile({
    required SftpClient sftp,
    required String remoteFilePath,
    required String fileName,
    int knownSizeBytes = 0,
    Directory? customTargetDirectory,
    void Function(SftpTransferProgress progress)? onProgress,
  }) async {
    int totalBytes = knownSizeBytes;
    if (totalBytes <= 0) {
      try {
        final st = await sftp.stat(remoteFilePath);
        totalBytes = st.size ?? 0;
      } catch (_) {}
    }

    int transferred = 0;
    onProgress?.call(
      SftpTransferProgress(
        direction: SftpTransferDirection.download,
        rootName: fileName,
        currentItem: fileName,
        isDirectory: false,
        filesCompleted: 0,
        totalFiles: 1,
        bytesTransferred: 0,
        totalBytes: totalBytes,
      ),
    );

    String savedLocation;
    if (customTargetDirectory != null) {
      final outFile = File('${customTargetDirectory.path}/$fileName');
      transferred = await downloadSingleFileToLocal(
        sftp: sftp,
        remoteFilePath: remoteFilePath,
        localDestFile: outFile,
        onChunk: (delta, totalNow) {
          transferred = totalNow;
          onProgress?.call(
            SftpTransferProgress(
              direction: SftpTransferDirection.download,
              rootName: fileName,
              currentItem: fileName,
              isDirectory: false,
              filesCompleted: 0,
              totalFiles: 1,
              bytesTransferred: transferred,
              totalBytes: totalBytes,
            ),
          );
        },
      );
      savedLocation = outFile.path;
    } else {
      final stageDir = await Directory.systemTemp.createTemp('jaladesk_dl_');
      try {
        final stageFile = File('${stageDir.path}/$fileName');
        transferred = await downloadSingleFileToLocal(
          sftp: sftp,
          remoteFilePath: remoteFilePath,
          localDestFile: stageFile,
          onChunk: (delta, totalNow) {
            transferred = totalNow;
            onProgress?.call(
              SftpTransferProgress(
                direction: SftpTransferDirection.download,
                rootName: fileName,
                currentItem: fileName,
                isDirectory: false,
                filesCompleted: 0,
                totalFiles: 1,
                bytesTransferred: transferred,
                totalBytes: totalBytes,
              ),
            );
          },
        );
        savedLocation = await NativePlatformBridge.exportToDownloads(
          sourcePath: stageFile.path,
          fileName: fileName,
        );
      } finally {
        try {
          await stageDir.delete(recursive: true);
        } catch (_) {}
      }
    }

    final done = SftpTransferProgress(
      direction: SftpTransferDirection.download,
      rootName: fileName,
      currentItem: fileName,
      isDirectory: false,
      filesCompleted: 1,
      totalFiles: 1,
      bytesTransferred: transferred,
      totalBytes: totalBytes > 0 ? totalBytes : transferred,
      isDone: true,
      savedDestination: savedLocation,
    );
    onProgress?.call(done);
    return done;
  }

  /// Recursively downloads an entire remote SFTP directory into `Downloads/JalaDesk/<dirName>/...`
  /// (or `customTargetDirectory/<dirName>/...`).
  static Future<SftpTransferProgress> downloadDirectoryRecursive({
    required SftpClient sftp,
    required String remoteDirPath,
    required String dirName,
    Directory? customTargetDirectory,
    void Function(SftpTransferProgress progress)? onProgress,
  }) async {
    final plannedFiles = <({String remotePath, String relSubDir, String fileName, int size})>[];
    final emptyOrAllRelDirs = <String>[''];
    int totalBytes = 0;

    Future<void> walkRemote(String rPath, String relDir, int depth) async {
      if (depth > maxRecursionDepth) return;
      final items = await sftp.listdir(rPath);
      for (final item in items) {
        if (item.filename == '.' || item.filename == '..') continue;
        final childRemote = joinRemotePath(rPath, item.filename);
        if (item.attr.isDirectory) {
          final nextRel = relDir.isEmpty ? item.filename : '$relDir/${item.filename}';
          emptyOrAllRelDirs.add(nextRel);
          await walkRemote(childRemote, nextRel, depth + 1);
        } else if (!item.attr.isSymbolicLink) {
          final sz = item.attr.size ?? 0;
          totalBytes += sz;
          plannedFiles.add((
            remotePath: childRemote,
            relSubDir: relDir,
            fileName: item.filename,
            size: sz,
          ));
        }
      }
    }

    await walkRemote(remoteDirPath, '', 0);

    if (customTargetDirectory != null) {
      for (final rel in emptyOrAllRelDirs) {
        final sub = rel.isEmpty ? '${customTargetDirectory.path}/$dirName' : '${customTargetDirectory.path}/$dirName/$rel';
        await Directory(sub).create(recursive: true);
      }
    }

    int transferred = 0;
    int completedFiles = 0;
    String savedRootDisplay = customTargetDirectory != null
        ? '${customTargetDirectory.path}/$dirName'
        : 'Download/JalaDesk/$dirName';

    final stageDir = customTargetDirectory == null
        ? await Directory.systemTemp.createTemp('jaladesk_dldir_')
        : null;

    try {
      for (final item in plannedFiles) {
        onProgress?.call(
          SftpTransferProgress(
            direction: SftpTransferDirection.download,
            rootName: dirName,
            currentItem: item.fileName,
            isDirectory: true,
            filesCompleted: completedFiles,
            totalFiles: plannedFiles.length,
            bytesTransferred: transferred,
            totalBytes: totalBytes,
          ),
        );

        if (customTargetDirectory != null) {
          final subPath = item.relSubDir.isEmpty
              ? '${customTargetDirectory.path}/$dirName/${item.fileName}'
              : '${customTargetDirectory.path}/$dirName/${item.relSubDir}/${item.fileName}';
          await downloadSingleFileToLocal(
            sftp: sftp,
            remoteFilePath: item.remotePath,
            localDestFile: File(subPath),
            onChunk: (delta, _) {
              transferred += delta;
              onProgress?.call(
                SftpTransferProgress(
                  direction: SftpTransferDirection.download,
                  rootName: dirName,
                  currentItem: item.fileName,
                  isDirectory: true,
                  filesCompleted: completedFiles,
                  totalFiles: plannedFiles.length,
                  bytesTransferred: transferred,
                  totalBytes: totalBytes,
                ),
              );
            },
          );
        } else {
          final tempFile = File('${stageDir!.path}/item_$completedFiles.bin');
          await downloadSingleFileToLocal(
            sftp: sftp,
            remoteFilePath: item.remotePath,
            localDestFile: tempFile,
            onChunk: (delta, _) {
              transferred += delta;
              onProgress?.call(
                SftpTransferProgress(
                  direction: SftpTransferDirection.download,
                  rootName: dirName,
                  currentItem: item.fileName,
                  isDirectory: true,
                  filesCompleted: completedFiles,
                  totalFiles: plannedFiles.length,
                  bytesTransferred: transferred,
                  totalBytes: totalBytes,
                ),
              );
            },
          );
          final exportSub = item.relSubDir.isEmpty ? dirName : '$dirName/${item.relSubDir}';
          await NativePlatformBridge.exportToDownloads(
            sourcePath: tempFile.path,
            subDir: exportSub,
            fileName: item.fileName,
          );
          try {
            await tempFile.delete();
          } catch (_) {}
        }
        completedFiles++;
      }
    } finally {
      if (stageDir != null) {
        try {
          await stageDir.delete(recursive: true);
        } catch (_) {}
      }
    }

    final done = SftpTransferProgress(
      direction: SftpTransferDirection.download,
      rootName: dirName,
      currentItem: dirName,
      isDirectory: true,
      filesCompleted: completedFiles,
      totalFiles: plannedFiles.length,
      bytesTransferred: transferred,
      totalBytes: totalBytes > 0 ? totalBytes : transferred,
      isDone: true,
      savedDestination: savedRootDisplay,
    );
    onProgress?.call(done);
    return done;
  }

  /// Recursively deletes a non-empty remote directory over SFTP.
  static Future<void> deleteDirectoryRecursive(
    SftpClient sftp,
    String remoteDirPath, {
    int depth = 0,
  }) async {
    if (depth > maxRecursionDepth) return;
    final items = await sftp.listdir(remoteDirPath);
    for (final item in items) {
      if (item.filename == '.' || item.filename == '..') continue;
      final child = joinRemotePath(remoteDirPath, item.filename);
      if (item.attr.isDirectory && !item.attr.isSymbolicLink) {
        await deleteDirectoryRecursive(sftp, child, depth: depth + 1);
      } else {
        await sftp.remove(child);
      }
    }
    await sftp.rmdir(remoteDirPath);
  }
}
