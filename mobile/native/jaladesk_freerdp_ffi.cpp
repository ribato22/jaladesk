#include <freerdp/freerdp.h>
#include <freerdp/addin.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/disp.h>
#include <freerdp/channels/drdynvc.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/event.h>
#include <freerdp/codec/color.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/graphics.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/error.h>
#include <winpr/ntlm.h>
#include <winpr/ssl.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>

#include <algorithm>
#include <array>
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

static std::once_flag g_sslInitOnce;

static void ensureWinprSslInitialized() {
  std::call_once(g_sslInitOnce, []() {
    (void)winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT);
    WLog_SetLogLevel(WLog_GetRoot(), WLOG_OFF);
  });
}

struct InputEventItem {
  int kind = 0; // 1 = mouse, 2 = key scancode, 3 = unicode key, 4 = sync, 5 = resize (w, h, scale)
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
  int reqScale = 100;
  std::string configDir;

  std::mutex mtx;
  std::vector<uint8_t> rgbaFrame;
  int frameWidth = 0;
  int frameHeight = 0;
  uint64_t frameSeq = 0;

  std::vector<uint8_t> cursorRgba;
  int cursorWidth = 0;
  int cursorHeight = 0;
  int cursorHotX = 0;
  int cursorHotY = 0;
  bool cursorHidden = false;
  bool cursorIsIBeam = false;
  uint64_t cursorSeq = 0;

  // 0 = connecting, 1 = connected, 2 = closed, -1 = failed
  std::atomic<int> state{0};
  std::string statusText = "Initializing FreeRDP 3.x engine...";
  std::deque<InputEventItem> inputQueue;

  std::atomic<bool> closing{false};
  std::atomic<bool> pendingResizeReconnect{false};
  freerdp* instance = nullptr;
  DispClientContext* dispContext = nullptr;
  std::thread worker;
};

struct JalaRdpContext {
  rdpContext base;
  JalaRdpSession* session;
};

static JalaRdpSession* getSession(rdpContext* ctx) {
  return reinterpret_cast<JalaRdpContext*>(ctx)->session;
}

static bool loadStaticChannel(freerdp* inst, const char* name, void* data) {
  const auto entry = WINPR_FUNC_PTR_CAST(
      freerdp_load_channel_addin_entry(
          name, nullptr, nullptr,
          FREERDP_ADDIN_CHANNEL_STATIC | FREERDP_ADDIN_CHANNEL_ENTRYEX),
      PVIRTUALCHANNELENTRYEX);
  return entry &&
         freerdp_channels_client_load_ex(
             inst->context->channels, inst->context->settings, entry, data) == 0;
}

static BOOL onLoadChannels(freerdp* inst) {
  if (!inst || !inst->context || !inst->context->settings) return FALSE;
  rdpSettings* s = inst->context->settings;
  for (UINT32 n = 0; n < freerdp_settings_get_uint32(s, FreeRDP_StaticChannelCount); ++n) {
    auto* args = static_cast<ADDIN_ARGV*>(
        freerdp_settings_get_pointer_array_writable(s, FreeRDP_StaticChannelArray, n));
    if (args && args->argv && args->argv[0]) {
      (void)loadStaticChannel(inst, args->argv[0], args);
    }
  }
  if (freerdp_settings_get_bool(s, FreeRDP_SupportDynamicChannels)) {
    (void)loadStaticChannel(inst, DRDYNVC_SVC_CHANNEL_NAME, s);
  }
  return TRUE;
}

static void onChannelConnected(void* context, const ChannelConnectedEventArgs* e) {
  if (!context || !e || !e->name) return;
  auto* ctx = static_cast<rdpContext*>(context);
  JalaRdpSession* s = getSession(ctx);
  if (!s) return;
  if (std::strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0 ||
      std::strcmp(e->name, DISP_CHANNEL_NAME) == 0) {
    std::lock_guard<std::mutex> lock(s->mtx);
    s->dispContext = reinterpret_cast<DispClientContext*>(e->pInterface);
  }
}

static void onChannelDisconnected(void* context, const ChannelDisconnectedEventArgs* e) {
  if (!context || !e || !e->name) return;
  auto* ctx = static_cast<rdpContext*>(context);
  JalaRdpSession* s = getSession(ctx);
  if (!s) return;
  if (std::strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0 ||
      std::strcmp(e->name, DISP_CHANNEL_NAME) == 0) {
    std::lock_guard<std::mutex> lock(s->mtx);
    s->dispContext = nullptr;
  }
}

static BOOL onPreConnect(freerdp* inst) {
  if (!inst || !inst->context) return FALSE;
  if (inst->context->pubSub) {
    PubSub_SubscribeChannelConnected(inst->context->pubSub, onChannelConnected);
    PubSub_SubscribeChannelDisconnected(inst->context->pubSub, onChannelDisconnected);
  }
  return TRUE;
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
  if (!gdi_resize(ctx->gdi, w, h)) return FALSE;
  onEndPaint(ctx);
  JalaRdpSession* s = getSession(ctx);
  if (s) {
    std::lock_guard<std::mutex> lock(s->mtx);
    s->statusText = "Connected via FreeRDP 3.x (" + std::to_string(w) + "x" + std::to_string(h) + ")";
  }
  return TRUE;
}

struct JalaPointer {
  rdpPointer base;
  int width;
  int height;
  int hotX;
  int hotY;
  bool isIBeam;
  uint8_t* rgbaData;
  size_t rgbaLen;
};

static bool classifyIBeamPointer(const uint8_t* rgba, int w, int h, int hotX, int hotY) {
  if (!rgba || w < 8 || h < 12) return false;
  if (hotX < w / 4 || hotX > (w * 3) / 4 || hotY < h / 4 || hotY > (h * 3) / 4) {
    return false;
  }
  const int yStart = h / 4;
  const int yEnd = (h * 3) / 4;
  if (yEnd <= yStart) return false;

  int centerOpaqueRows = 0;
  const int xMin = std::max(0, hotX - 1);
  const int xMax = std::min(w - 1, hotX + 1);
  for (int y = yStart; y <= yEnd; ++y) {
    bool rowHasStem = false;
    for (int x = xMin; x <= xMax; ++x) {
      if (rgba[(y * w + x) * 4 + 3] >= 96) {
        rowHasStem = true;
        break;
      }
    }
    if (rowHasStem) ++centerOpaqueRows;
  }
  const int totalMidRows = yEnd - yStart + 1;
  if (static_cast<double>(centerOpaqueRows) / static_cast<double>(totalMidRows) < 0.45) {
    return false;
  }

  const int mid3Start = (h * 35) / 100;
  const int mid3End = (h * 65) / 100;
  int outerChecked = 0;
  int outerOpaque = 0;
  for (int y = mid3Start; y <= mid3End; ++y) {
    int rowOuterChecked = 0;
    int rowOuterOpaque = 0;
    for (int x = 0; x < w; ++x) {
      if (x <= hotX - 4 || x >= hotX + 4) {
        ++outerChecked;
        ++rowOuterChecked;
        if (rgba[(y * w + x) * 4 + 3] >= 96) {
          ++outerOpaque;
          ++rowOuterOpaque;
        }
      }
    }
    if (rowOuterChecked > 0 &&
        static_cast<double>(rowOuterOpaque) / static_cast<double>(rowOuterChecked) >= 0.35) {
      return false;
    }
  }
  if (outerChecked <= 0) return false;
  return (static_cast<double>(outerOpaque) / static_cast<double>(outerChecked)) < 0.15;
}

static BOOL onPointerNew(rdpContext* ctx, rdpPointer* pointer) {
  if (!ctx || !pointer) return FALSE;
  auto* jp = reinterpret_cast<JalaPointer*>(pointer);
  const int w = static_cast<int>(pointer->width);
  const int h = static_cast<int>(pointer->height);
  jp->width = w;
  jp->height = h;
  jp->hotX = std::clamp(static_cast<int>(pointer->xPos), 0, std::max(0, w - 1));
  jp->hotY = std::clamp(static_cast<int>(pointer->yPos), 0, std::max(0, h - 1));
  jp->isIBeam = false;
  jp->rgbaData = nullptr;
  jp->rgbaLen = 0;
  if (w <= 0 || h <= 0 || w > 384 || h > 384) return TRUE;

  const size_t total = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
  auto* buf = static_cast<uint8_t*>(std::calloc(1, total));
  if (!buf) return FALSE;
  const gdiPalette* pal = ctx->gdi ? &ctx->gdi->palette : nullptr;
  const BOOL ok = freerdp_image_copy_from_pointer_data(
      buf, PIXEL_FORMAT_RGBA32, static_cast<UINT32>(w * 4), 0, 0,
      pointer->width, pointer->height,
      pointer->xorMaskData, pointer->lengthXorMask,
      pointer->andMaskData, pointer->lengthAndMask,
      pointer->xorBpp, pal);
  if (!ok) {
    std::free(buf);
    return TRUE;
  }
  jp->rgbaData = buf;
  jp->rgbaLen = total;
  jp->isIBeam = classifyIBeamPointer(buf, w, h, jp->hotX, jp->hotY);
  return TRUE;
}

static void onPointerFree(rdpContext*, rdpPointer* pointer) {
  if (!pointer) return;
  auto* jp = reinterpret_cast<JalaPointer*>(pointer);
  if (jp->rgbaData) {
    std::free(jp->rgbaData);
    jp->rgbaData = nullptr;
    jp->rgbaLen = 0;
  }
}

static BOOL onPointerSet(rdpContext* ctx, rdpPointer* pointer) {
  JalaRdpSession* s = ctx ? getSession(ctx) : nullptr;
  if (!s || !pointer) return TRUE;
  auto* jp = reinterpret_cast<JalaPointer*>(pointer);
  std::lock_guard<std::mutex> lock(s->mtx);
  s->cursorHidden = false;
  if (jp->rgbaData && jp->rgbaLen > 0 && jp->width > 0 && jp->height > 0) {
    s->cursorWidth = jp->width;
    s->cursorHeight = jp->height;
    s->cursorHotX = jp->hotX;
    s->cursorHotY = jp->hotY;
    s->cursorIsIBeam = jp->isIBeam;
    s->cursorRgba.assign(jp->rgbaData, jp->rgbaData + jp->rgbaLen);
  } else {
    s->cursorWidth = 0;
    s->cursorHeight = 0;
    s->cursorHotX = 0;
    s->cursorHotY = 0;
    s->cursorIsIBeam = false;
    s->cursorRgba.clear();
  }
  s->cursorSeq++;
  return TRUE;
}

static BOOL onPointerSetNull(rdpContext* ctx) {
  JalaRdpSession* s = ctx ? getSession(ctx) : nullptr;
  if (!s) return TRUE;
  std::lock_guard<std::mutex> lock(s->mtx);
  s->cursorHidden = true;
  s->cursorIsIBeam = false;
  s->cursorSeq++;
  return TRUE;
}

static BOOL onPointerSetDefault(rdpContext* ctx) {
  JalaRdpSession* s = ctx ? getSession(ctx) : nullptr;
  if (!s) return TRUE;
  std::lock_guard<std::mutex> lock(s->mtx);
  s->cursorHidden = false;
  s->cursorWidth = 0;
  s->cursorHeight = 0;
  s->cursorHotX = 0;
  s->cursorHotY = 0;
  s->cursorIsIBeam = false;
  s->cursorRgba.clear();
  s->cursorSeq++;
  return TRUE;
}

static BOOL onPointerSetPosition(rdpContext*, UINT32, UINT32) {
  return TRUE;
}

static BOOL onPostConnect(freerdp* inst) {
  if (!inst || !inst->context) return FALSE;
  if (!gdi_init(inst, PIXEL_FORMAT_BGRA32)) return FALSE;
  if (inst->context->graphics) {
    rdpPointer ptrProto{};
    ptrProto.size = sizeof(JalaPointer);
    ptrProto.New = onPointerNew;
    ptrProto.Free = onPointerFree;
    ptrProto.Set = onPointerSet;
    ptrProto.SetNull = onPointerSetNull;
    ptrProto.SetDefault = onPointerSetDefault;
    ptrProto.SetPosition = onPointerSetPosition;
    graphics_register_pointer(inst->context->graphics, &ptrProto);
  }
  inst->context->update->BeginPaint = onBeginPaint;
  inst->context->update->EndPaint = onEndPaint;
  inst->context->update->DesktopResize = onDesktopResize;

  JalaRdpSession* s = getSession(inst->context);
  if (s) {
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
  if (inst && inst->context) {
    JalaRdpSession* s = getSession(inst->context);
    if (s) {
      std::lock_guard<std::mutex> lock(s->mtx);
      s->dispContext = nullptr;
    }
    if (inst->context->pubSub) {
      PubSub_UnsubscribeChannelConnected(inst->context->pubSub, onChannelConnected);
      PubSub_UnsubscribeChannelDisconnected(inst->context->pubSub, onChannelDisconnected);
    }
    if (inst->context->gdi) {
      gdi_free(inst);
    }
  }
}

static DWORD onVerifyCertificateEx(
    freerdp*, const char*, UINT16, const char*, const char*, const char*, const char*, DWORD) {
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
  return !s->username.empty() && !s->password.empty();
}

static bool isAuthenticationFailureCode(UINT32 code) {
  switch (code) {
    case FREERDP_ERROR_AUTHENTICATION_FAILED:
    case FREERDP_ERROR_INSUFFICIENT_PRIVILEGES:
    case FREERDP_ERROR_CONNECT_PASSWORD_EXPIRED:
    case FREERDP_ERROR_CONNECT_PASSWORD_CERTAINLY_EXPIRED:
    case FREERDP_ERROR_CONNECT_ACCOUNT_DISABLED:
    case FREERDP_ERROR_CONNECT_PASSWORD_MUST_CHANGE:
    case FREERDP_ERROR_CONNECT_LOGON_FAILURE:
    case FREERDP_ERROR_CONNECT_WRONG_PASSWORD:
    case FREERDP_ERROR_CONNECT_ACCESS_DENIED:
    case FREERDP_ERROR_CONNECT_ACCOUNT_RESTRICTION:
    case FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT:
    case FREERDP_ERROR_CONNECT_ACCOUNT_EXPIRED:
    case FREERDP_ERROR_CONNECT_LOGON_TYPE_NOT_GRANTED:
    case FREERDP_ERROR_CONNECT_NO_OR_MISSING_CREDENTIALS:
      return true;
    default:
      return false;
  }
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

  int targetW = 1280;
  int targetH = 800;
  int targetScale = 100;
  {
    std::lock_guard<std::mutex> lock(s->mtx);
    targetW = s->reqWidth;
    targetH = s->reqHeight;
    targetScale = s->reqScale;
  }
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, static_cast<UINT32>(targetW));
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, static_cast<UINT32>(targetH));
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopScaleFactor, static_cast<UINT32>(targetScale));
  freerdp_settings_set_uint32(settings, FreeRDP_DeviceScaleFactor, 100);
  freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);
  freerdp_settings_set_uint32(settings, FreeRDP_ColorPointerCacheSize, 32);
  freerdp_settings_set_uint32(settings, FreeRDP_PointerCacheSize, 32);
  freerdp_settings_set_uint32(settings, FreeRDP_LargePointerFlag, LARGE_POINTER_FLAG_96x96);
  freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, FALSE);
  freerdp_settings_set_bool(settings, FreeRDP_FastPathOutput, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_FastPathInput, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_FrameMarkerCommandEnabled, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SurfaceFrameMarkerEnabled, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SupportDynamicChannels, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SynchronousDynamicChannels, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE);
  const char* dispParams[] = {DISP_CHANNEL_NAME};
  (void)freerdp_client_add_dynamic_channel(settings, 1, dispParams);

  freerdp_settings_set_bool(settings, FreeRDP_ExternalCertificateManagement, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
  freerdp_settings_set_bool(settings, FreeRDP_AutoAcceptCertificate, TRUE);
  freerdp_settings_set_uint32(settings, FreeRDP_ThreadingFlags, THREADING_FLAGS_DISABLE_THREADS);
  freerdp_settings_set_uint32(settings, FreeRDP_TcpConnectTimeout, 10000);
  freerdp_settings_set_bool(settings, FreeRDP_NegotiateSecurityLayer, TRUE);

  // Primary attempt: NLA (CredSSP / NTLMv2) + TLS; Fallback: TLS + Classic RDP
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
  ensureWinprSslInitialized();
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
    inst->LoadChannels = onLoadChannels;
    inst->PreConnect = onPreConnect;
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
      s->dispContext = nullptr;
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
        s->dispContext = nullptr;
      }
      freerdp_context_free(inst);
      freerdp_free(inst);
      return nullptr;
    }
    return inst;
  };

  while (!s->closing.load()) {
    s->pendingResizeReconnect.store(false);
    UINT32 primaryErr = 0;
    const bool hasCredentials = !s->username.empty() && !s->password.empty();
    freerdp* inst = createAndConnect(hasCredentials, primaryErr);

    if (!inst && !s->closing.load() && hasCredentials) {
      const bool isAuthWrong = isAuthenticationFailureCode(primaryErr);
      if (!isAuthWrong) {
        UINT32 fallbackErr = 0;
        inst = createAndConnect(false, fallbackErr);
        // Preserve primaryErr if fallback failed only because the server strictly requires NLA/Hybrid
        if (!inst && fallbackErr != 0 &&
            fallbackErr != FREERDP_ERROR_CONNECT_HYBRID_REQUIRED_BY_SERVER) {
          primaryErr = fallbackErr;
        }
      }
    }

    if (!inst) {
      const char* errName = freerdp_get_last_error_name(primaryErr);
      const char* errStr = freerdp_get_last_error_string(primaryErr);
      std::lock_guard<std::mutex> lock(s->mtx);
      if (primaryErr == FREERDP_ERROR_CONNECT_HYBRID_REQUIRED_BY_SERVER && s->password.empty()) {
        s->statusText =
            "RDP Connect Failed: Server requires Network Level Authentication (NLA). "
            "Please provide your Windows / Active Directory password.";
      } else {
        s->statusText = std::string("RDP Connect Failed: ") +
                        (errStr ? errStr : "Unable to establish session") +
                        " (" + (errName ? errName : "ERR") + ")";
      }
      s->state.store(-1);
      return;
    }

    while (!s->closing.load() &&
           !s->pendingResizeReconnect.load() &&
           !freerdp_shall_disconnect_context(inst->context)) {
      HANDLE handles[64];
      const DWORD count = freerdp_get_event_handles(inst->context, handles, 64);
      if (!count || WaitForMultipleObjects(count, handles, FALSE, 16) == WAIT_FAILED) {
        break;
      }
      if (!freerdp_check_event_handles(inst->context)) {
        break;
      }

      std::deque<InputEventItem> pending;
      DispClientContext* activeDisp = nullptr;
      {
        std::lock_guard<std::mutex> lock(s->mtx);
        pending.swap(s->inputQueue);
        activeDisp = s->dispContext;
      }
      for (const auto& ev : pending) {
        if (ev.kind == 5) {
          const int newW = ev.a;
          const int newH = ev.b;
          const int newScale = ev.c;
          if (activeDisp && activeDisp->SendMonitorLayout) {
            DISPLAY_CONTROL_MONITOR_LAYOUT layout{};
            layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
            layout.Left = 0;
            layout.Top = 0;
            layout.Width = static_cast<UINT32>(newW);
            layout.Height = static_cast<UINT32>(newH);
            layout.PhysicalWidth = std::max<UINT32>(10u, (static_cast<UINT32>(newW) * 254u) / 960u);
            layout.PhysicalHeight = std::max<UINT32>(10u, (static_cast<UINT32>(newH) * 254u) / 960u);
            layout.Orientation = 0;
            layout.DesktopScaleFactor = static_cast<UINT32>(newScale);
            layout.DeviceScaleFactor = 100;
            (void)activeDisp->SendMonitorLayout(activeDisp, 1, &layout);
          } else {
            s->pendingResizeReconnect.store(true);
            break;
          }
          continue;
        }
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
      s->dispContext = nullptr;
      if (!s->pendingResizeReconnect.load() && s->state.load() == 1) {
        s->statusText = errInfo
            ? ("Session ended by server (code " + std::to_string(errInfo) + ")")
            : "Session disconnected.";
        s->state.store(2);
      }
    }
    freerdp_disconnect(inst);
    freerdp_context_free(inst);
    freerdp_free(inst);

    if (!s->pendingResizeReconnect.load()) {
      break;
    }
  }
}

} // namespace

JALA_EXPORT int jaladesk_rdp_selftest_ntlm() {
  ensureWinprSslInitialized();
  std::array<unsigned char, 16> nt{};
  if (!NTOWFv1A("password", 8, nt.data())) {
    return 0;
  }
  static constexpr unsigned char expected[16] = {
      0x88, 0x46, 0xf7, 0xea, 0xee, 0x8f, 0xb1, 0x17,
      0xad, 0x06, 0xbd, 0xd8, 0x30, 0xb7, 0x58, 0x6c,
  };
  return std::memcmp(nt.data(), expected, 16) == 0 ? 1 : 0;
}

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
  const int alignedW = ((std::clamp(width, 320, 4096) + 3) / 4) * 4;
  const int alignedH = ((std::clamp(height, 240, 4096) + 1) / 2) * 2;
  s->reqWidth = alignedW;
  s->reqHeight = alignedH;
  s->configDir = config_dir ? config_dir : "";

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

JALA_EXPORT void jaladesk_rdp_request_resolution(
    void* handle,
    int width,
    int height,
    int desktop_scale_factor) {
  if (!handle) return;
  auto* s = static_cast<JalaRdpSession*>(handle);
  const int alignedW = ((std::clamp(width, 320, 4096) + 3) / 4) * 4;
  const int alignedH = ((std::clamp(height, 240, 4096) + 1) / 2) * 2;
  const int clampedScale = std::clamp(desktop_scale_factor, 100, 500);

  std::lock_guard<std::mutex> lock(s->mtx);
  if (alignedW == s->frameWidth && alignedH == s->frameHeight && clampedScale == s->reqScale) {
    return;
  }
  s->reqWidth = alignedW;
  s->reqHeight = alignedH;
  s->reqScale = clampedScale;
  s->inputQueue.erase(
      std::remove_if(s->inputQueue.begin(), s->inputQueue.end(),
                     [](const InputEventItem& item) { return item.kind == 5; }),
      s->inputQueue.end());
  s->inputQueue.push_back({5, alignedW, alignedH, clampedScale});
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

JALA_EXPORT int32_t jala_rdp_poll_cursor(
    void* handle,
    uint64_t last_seq,
    uint8_t* out_rgba,
    int32_t max_bytes,
    int32_t* out_w,
    int32_t* out_h,
    int32_t* out_hot_x,
    int32_t* out_hot_y,
    int32_t* out_flags,
    uint64_t* out_seq) {
  if (!handle) return -1;
  auto* s = static_cast<JalaRdpSession*>(handle);
  std::lock_guard<std::mutex> lock(s->mtx);
  if (out_seq) *out_seq = s->cursorSeq;
  if (s->cursorSeq == 0 || s->cursorSeq == last_seq) {
    return 0;
  }
  const bool hasBitmap = !s->cursorHidden && !s->cursorRgba.empty() &&
                         s->cursorWidth > 0 && s->cursorHeight > 0;
  int32_t flags = 0;
  if (s->cursorHidden) flags |= 1;
  if (s->cursorIsIBeam) flags |= 2;
  if (hasBitmap) flags |= 4;
  if (out_w) *out_w = s->cursorWidth;
  if (out_h) *out_h = s->cursorHeight;
  if (out_hot_x) *out_hot_x = s->cursorHotX;
  if (out_hot_y) *out_hot_y = s->cursorHotY;
  if (out_flags) *out_flags = flags;

  if (hasBitmap) {
    const int32_t needed = s->cursorWidth * s->cursorHeight * 4;
    if (out_rgba && max_bytes >= needed) {
      std::memcpy(out_rgba, s->cursorRgba.data(), static_cast<size_t>(needed));
    }
  }
  return 1;
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
  for (int attempt = 0; attempt < 50; ++attempt) {
    {
      std::lock_guard<std::mutex> lock(s->mtx);
      if (!s->instance || !s->instance->context) break;
      freerdp_abort_connect_context(s->instance->context);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (s->worker.joinable()) {
    s->worker.join();
  }
  delete s;
}
