#include <freerdp/freerdp.h>
#include <freerdp/addin.h>
#include <freerdp/channels/channels.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/error.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#if !defined(_WIN32)
#include <sys/stat.h>
#endif

#if defined(_WIN32)
#define JALA_EXPORT extern "C" __declspec(dllexport)
#else
#define JALA_EXPORT extern "C" __attribute__((visibility("default"))) __attribute__((used))
#endif

namespace {

struct InputEventItem {
  int kind = 0; // 1 = mouse, 2 = key scancode, 3 = unicode key, 4 = sync
  int a = 0;
  int b = 0;
  int c = 0;
};

struct JalaRdpSession {
  std::string host;
  int port = 3389;
  std::string domain;
  std::string username;
  std::string password;
  int reqWidth = 1280;
  int reqHeight = 800;
  std::string configDir;

  std::mutex mtx;
  std::vector<uint8_t> rgbaFrame;
  int frameWidth = 0;
  int frameHeight = 0;
  uint64_t frameSeq = 0;

  // 0 = connecting, 1 = connected, 2 = closed, -1 = failed
  std::atomic<int> state{0};
  std::string statusText = "Initializing FreeRDP 3.x engine...";
  std::deque<InputEventItem> inputQueue;

  std::atomic<bool> closing{false};
  freerdp* instance = nullptr;
  std::thread worker;
};

struct JalaRdpContext {
  rdpContext base;
  JalaRdpSession* session;
};

static JalaRdpSession* getSession(rdpContext* ctx) {
  return reinterpret_cast<JalaRdpContext*>(ctx)->session;
}

static BOOL onBeginPaint(rdpContext* ctx) {
  if (!ctx || !ctx->gdi || !ctx->gdi->primary || !ctx->gdi->primary->hdc ||
      !ctx->gdi->primary->hdc->hwnd || !ctx->gdi->primary->hdc->hwnd->invalid) {
    return FALSE;
  }
  ctx->gdi->primary->hdc->hwnd->invalid->null = TRUE;
  return TRUE;
}

static BOOL onEndPaint(rdpContext* ctx) {
  JalaRdpSession* s = getSession(ctx);
  if (!s || s->closing.load() || !ctx->gdi || !ctx->gdi->primary_buffer) {
    return FALSE;
  }
  const int w = static_cast<int>(ctx->gdi->width);
  const int h = static_cast<int>(ctx->gdi->height);
  const int stride = static_cast<int>(ctx->gdi->stride);
  if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || stride < w * 4) {
    return FALSE;
  }

  const uint8_t* src = ctx->gdi->primary_buffer;
  std::lock_guard<std::mutex> lock(s->mtx);
  const size_t totalBytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
  if (s->rgbaFrame.size() != totalBytes) {
    s->rgbaFrame.resize(totalBytes);
  }
  // Convert BGRA32 (FreeRDP software GDI native order) to RGBA32 with opaque alpha
  for (int y = 0; y < h; ++y) {
    const uint8_t* row = src + static_cast<size_t>(y) * static_cast<size_t>(stride);
    uint8_t* dst = s->rgbaFrame.data() + static_cast<size_t>(y) * static_cast<size_t>(w) * 4;
    for (int x = 0; x < w; ++x) {
      dst[x * 4 + 0] = row[x * 4 + 2]; // R
      dst[x * 4 + 1] = row[x * 4 + 1]; // G
      dst[x * 4 + 2] = row[x * 4 + 0]; // B
      dst[x * 4 + 3] = 255;            // A
    }
  }
  s->frameWidth = w;
  s->frameHeight = h;
  s->frameSeq++;
  return TRUE;
}

static BOOL onDesktopResize(rdpContext* ctx) {
  if (!ctx || !ctx->gdi || !ctx->settings) return FALSE;
  const uint32_t w = freerdp_settings_get_uint32(ctx->settings, FreeRDP_DesktopWidth);
  const uint32_t h = freerdp_settings_get_uint32(ctx->settings, FreeRDP_DesktopHeight);
  if (w < 64 || h < 64 || w > 8192 || h > 8192) return FALSE;
  return gdi_resize(ctx->gdi, w, h);
}

static BOOL onPostConnect(freerdp* inst) {
  if (!inst || !inst->context) return FALSE;
  if (!gdi_init(inst, PIXEL_FORMAT_BGRA32)) return FALSE;
  inst->context->update->BeginPaint = onBeginPaint;
  inst->context->update->EndPaint = onEndPaint;
  inst->context->update->DesktopResize = onDesktopResize;

  JalaRdpSession* s = getSession(inst->context);
  if (s) {
    // Capture initial surface immediately
    onEndPaint(inst->context);
    {
      std::lock_guard<std::mutex> lock(s->mtx);
      s->statusText = "Connected via FreeRDP 3.x (" +
                      std::to_string(inst->context->gdi->width) + "x" +
                      std::to_string(inst->context->gdi->height) + ")";
    }
    s->state.store(1);
  }
  return TRUE;
}

static void onPostDisconnect(freerdp* inst) {
  if (inst && inst->context && inst->context->gdi) {
    gdi_free(inst);
  }
}

static DWORD onVerifyCertificateEx(
    freerdp*, const char*, UINT16, const char*, const char*, const char*, const char*, DWORD) {
  // Accept self-signed & enterprise internal AD certificates on mobile
  return 2;
}

static DWORD onVerifyChangedCertificateEx(
    freerdp*, const char*, UINT16, const char*, const char*, const char*, const char*,
    const char*, const char*, const char*, DWORD) {
  return 2;
}

static int onVerifyX509Certificate(
    freerdp*, const BYTE*, size_t, const char*, UINT16, DWORD) {
  return 2;
}

static BOOL onAuthenticateEx(
    freerdp* inst, char** username, char** password, char** domain, rdp_auth_reason) {
  JalaRdpSession* s = inst && inst->context ? getSession(inst->context) : nullptr;
  if (!s) return FALSE;
  if (username && (!*username || !**username) && !s->username.empty()) {
    *username = _strdup(s->username.c_str());
  }
  if (password && (!*password || !**password) && !s->password.empty()) {
    *password = _strdup(s->password.c_str());
  }
  if (domain && (!*domain || !**domain) && !s->domain.empty()) {
    *domain = _strdup(s->domain.c_str());
  }
  return TRUE;
}

static bool configureInstance(freerdp* inst, JalaRdpSession* s, bool enableNla) {
  rdpSettings* settings = inst->context->settings;
  if (!settings) return false;

  if (!s->configDir.empty()) {
    freerdp_settings_set_string(settings, FreeRDP_HomePath, s->configDir.c_str());
    freerdp_settings_set_string(settings, FreeRDP_ConfigPath, s->configDir.c_str());
  }
  freerdp_settings_set_string(settings, FreeRDP_ServerHostname, s->host.c_str());
  freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, static_cast<UINT32>(s->port));

  if (!s->username.empty()) {
    freerdp_settings_set_string(settings, FreeRDP_Username, s->username.c_str());
  }
  if (!s->password.empty()) {
    freerdp_settings_set_string(settings, FreeRDP_Password, s->password.c_str());
  }
  if (!s->domain.empty()) {
    freerdp_settings_set_string(settings, FreeRDP_Domain, s->domain.c_str());
  }

  freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, static_cast<UINT32>(s->reqWidth));
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, static_cast<UINT32>(s->reqHeight));
  freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);
  freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, FALSE);
  freerdp_settings_set_bool(settings, FreeRDP_FastPathOutput, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_FastPathInput, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_FrameMarkerCommandEnabled, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SurfaceFrameMarkerEnabled, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_ExternalCertificateManagement, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_AutoAcceptCertificate, TRUE);
  freerdp_settings_set_uint32(settings, FreeRDP_ThreadingFlags, THREADING_FLAGS_DISABLE_THREADS);
  freerdp_settings_set_uint32(settings, FreeRDP_TcpConnectTimeout, 8000);

  // Security negotiation: NLA (CredSSP) + TLS on primary attempt; TLS + Classic RDP on fallback
  freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, enableNla ? TRUE : FALSE);
  freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, enableNla ? FALSE : TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_ExtSecurity, FALSE);

  return true;
}

static void runSessionThread(JalaRdpSession* s) {
#if !defined(_WIN32)
  if (!s->configDir.empty()) {
    mkdir(s->configDir.c_str(), 0700);
    setenv("HOME", s->configDir.c_str(), 1);
    setenv("XDG_CONFIG_HOME", s->configDir.c_str(), 1);
    setenv("XDG_CACHE_HOME", s->configDir.c_str(), 1);
  }
#endif
  WLog_SetLogLevel(WLog_GetRoot(), WLOG_OFF);
  freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);

  auto createAndConnect = [&](bool useNla, UINT32& outLastErr) -> freerdp* {
    freerdp* inst = freerdp_new();
    if (!inst) return nullptr;
    inst->ContextSize = sizeof(JalaRdpContext);
    if (!freerdp_context_new(inst)) {
      freerdp_free(inst);
      return nullptr;
    }
    reinterpret_cast<JalaRdpContext*>(inst->context)->session = s;
    inst->PostConnect = onPostConnect;
    inst->PostDisconnect = onPostDisconnect;
    inst->AuthenticateEx = onAuthenticateEx;
    inst->VerifyCertificateEx = onVerifyCertificateEx;
    inst->VerifyChangedCertificateEx = onVerifyChangedCertificateEx;
    inst->VerifyX509Certificate = onVerifyX509Certificate;

    configureInstance(inst, s, useNla);
    {
      std::lock_guard<std::mutex> lock(s->mtx);
      s->instance = inst;
      s->statusText = useNla
          ? "Negotiating CredSSP / NLA & TLS with " + s->host + ":" + std::to_string(s->port) + "..."
          : "Negotiating TLS / Standard RDP with " + s->host + ":" + std::to_string(s->port) + "...";
    }

    const BOOL ok = freerdp_connect(inst);
    if (!ok) {
      outLastErr = freerdp_get_last_error(inst->context);
      {
        std::lock_guard<std::mutex> lock(s->mtx);
        s->instance = nullptr;
      }
      freerdp_context_free(inst);
      freerdp_free(inst);
      return nullptr;
    }
    return inst;
  };

  UINT32 lastErr = 0;
  // First attempt: with NLA enabled if username/password are provided, otherwise TLS first
  const bool tryNlaFirst = !s->username.empty() && !s->password.empty();
  freerdp* inst = createAndConnect(tryNlaFirst, lastErr);

  // Automatic fallback: if NLA failed due to server policy / hybrid mismatch (and not explicit wrong password),
  // or if we tried TLS-first and server required NLA, try the alternate security mode!
  if (!inst && !s->closing.load()) {
    const bool isAuthWrong = (lastErr == FREERDP_ERROR_AUTHENTICATION_FAILED ||
                              lastErr == FREERDP_ERROR_CONNECT_LOGON_FAILURE ||
                              lastErr == FREERDP_ERROR_CONNECT_WRONG_PASSWORD ||
                              lastErr == FREERDP_ERROR_CONNECT_ACCESS_DENIED ||
                              lastErr == FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT);
    if (!isAuthWrong) {
      UINT32 fallbackErr = 0;
      inst = createAndConnect(!tryNlaFirst, fallbackErr);
      if (fallbackErr != 0) lastErr = fallbackErr;
    }
  }

  if (!inst) {
    const char* errName = freerdp_get_last_error_name(lastErr);
    const char* errStr = freerdp_get_last_error_string(lastErr);
    std::lock_guard<std::mutex> lock(s->mtx);
    s->statusText = std::string("RDP Connect Failed: ") +
                    (errStr ? errStr : "Unable to establish session") +
                    " (" + (errName ? errName : "ERR") + ")";
    s->state.store(-1);
    return;
  }

  while (!s->closing.load() && !freerdp_shall_disconnect_context(inst->context)) {
    HANDLE handles[64];
    const DWORD count = freerdp_get_event_handles(inst->context, handles, 64);
    if (!count || WaitForMultipleObjects(count, handles, FALSE, 16) == WAIT_FAILED) {
      break;
    }
    if (!freerdp_check_event_handles(inst->context)) {
      break;
    }

    std::deque<InputEventItem> pending;
    {
      std::lock_guard<std::mutex> lock(s->mtx);
      pending.swap(s->inputQueue);
    }
    for (const auto& ev : pending) {
      if (!inst->context->input) continue;
      if (ev.kind == 1) {
        freerdp_input_send_mouse_event(
            inst->context->input,
            static_cast<UINT16>(ev.c),
            static_cast<UINT16>(ev.a),
            static_cast<UINT16>(ev.b));
      } else if (ev.kind == 2) {
        freerdp_input_send_keyboard_event(
            inst->context->input,
            static_cast<UINT16>(ev.a),
            static_cast<UINT8>(ev.b));
      } else if (ev.kind == 3) {
        freerdp_input_send_unicode_keyboard_event(
            inst->context->input,
            static_cast<UINT16>(ev.a),
            static_cast<UINT16>(ev.b));
      } else if (ev.kind == 4) {
        freerdp_input_send_synchronize_event(
            inst->context->input,
            static_cast<UINT32>(ev.a));
      }
    }
  }

  const UINT32 errInfo = freerdp_error_info(inst);
  {
    std::lock_guard<std::mutex> lock(s->mtx);
    s->instance = nullptr;
    if (s->state.load() == 1) {
      s->statusText = errInfo
          ? ("Session ended by server (code " + std::to_string(errInfo) + ")")
          : "Session disconnected.";
      s->state.store(2);
    }
  }
  freerdp_disconnect(inst);
  freerdp_context_free(inst);
  freerdp_free(inst);
}

} // namespace

JALA_EXPORT void* jaladesk_rdp_create(
    const char* host,
    int port,
    const char* domain,
    const char* username,
    const char* password,
    int width,
    int height,
    const char* config_dir) {
  auto* s = new JalaRdpSession();
  s->host = host ? host : "";
  s->port = (port > 0 && port <= 65535) ? port : 3389;
  s->domain = domain ? domain : "";
  s->username = username ? username : "";
  s->password = password ? password : "";
  s->reqWidth = (width >= 320 && width <= 4096) ? width : 1280;
  s->reqHeight = (height >= 240 && height <= 4096) ? height : 800;
  s->configDir = config_dir ? config_dir : "";

  // Automatically split DOMAIN\username or username@domain if domain wasn't passed separately
  if (s->domain.empty()) {
    const auto backslashPos = s->username.find('\\');
    if (backslashPos != std::string::npos) {
      s->domain = s->username.substr(0, backslashPos);
      s->username = s->username.substr(backslashPos + 1);
    } else {
      const auto atPos = s->username.find('@');
      if (atPos != std::string::npos) {
        s->domain = s->username.substr(atPos + 1);
        s->username = s->username.substr(0, atPos);
      }
    }
  }

  s->worker = std::thread(runSessionThread, s);
  return s;
}

JALA_EXPORT int jaladesk_rdp_get_state(
    void* handle,
    int* out_width,
    int* out_height,
    uint64_t* out_frame_seq,
    char* out_status,
    int status_cap) {
  if (!handle) return -1;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (out_width) *out_width = s->frameWidth;
  if (out_height) *out_height = s->frameHeight;
  if (out_frame_seq) *out_frame_seq = s->frameSeq;
  if (out_status && status_cap > 0) {
    const size_t n = std::min(static_cast<size_t>(status_cap - 1), s->statusText.size());
    std::memcpy(out_status, s->statusText.data(), n);
    out_status[n] = '\0';
  }
  return s->state.load();
}

JALA_EXPORT int jaladesk_rdp_copy_frame(
    void* handle,
    uint8_t* dst_rgba,
    int max_bytes,
    int* out_w,
    int* out_h) {
  if (!handle || !dst_rgba || max_bytes <= 0) return 0;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (s->rgbaFrame.empty() || s->frameWidth <= 0 || s->frameHeight <= 0) return 0;
  const int needed = s->frameWidth * s->frameHeight * 4;
  if (max_bytes < needed) return 0;
  std::memcpy(dst_rgba, s->rgbaFrame.data(), static_cast<size_t>(needed));
  if (out_w) *out_w = s->frameWidth;
  if (out_h) *out_h = s->frameHeight;
  return needed;
}

JALA_EXPORT void jaladesk_rdp_send_mouse(void* handle, int x, int y, int flags) {
  if (!handle) return;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (s->inputQueue.size() < 2048) {
    s->inputQueue.push_back({1, x, y, flags});
  }
}

JALA_EXPORT void jaladesk_rdp_send_key_scancode(void* handle, int flags, int scancode) {
  if (!handle) return;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (s->inputQueue.size() < 2048) {
    s->inputQueue.push_back({2, flags, scancode, 0});
  }
}

JALA_EXPORT void jaladesk_rdp_send_unicode(void* handle, int flags, int utf16_code) {
  if (!handle) return;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (s->inputQueue.size() < 2048) {
    s->inputQueue.push_back({3, flags, utf16_code, 0});
  }
}

JALA_EXPORT void jaladesk_rdp_destroy(void* handle) {
  if (!handle) return;
  auto* s = static_cast<JalaRdpSession*>(handle);
  s->closing.store(true);
  {
    std::lock_guard<std::mutex> lock(s->mtx);
    if (s->instance && s->instance->context) {
      freerdp_abort_connect_context(s->instance->context);
    }
  }
  if (s->worker.joinable()) {
    s->worker.join();
  }
  delete s;
}
