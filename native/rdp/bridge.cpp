#include "surface.hpp"
#include "control.hpp"
#include "channels.hpp"
#include "private-profile.hpp"
#include <freerdp/freerdp.h>
#include <freerdp/addin.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/drdynvc.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/event.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/error.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <atomic>
#include <chrono>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <memory>
#include <optional>
#ifdef _WIN32
#include <winpr/winsock.h>
#include <io.h>
#include <fcntl.h>
struct Winsock {
  WSADATA data{};
  bool started=WSAStartup(MAKEWORD(2,2),&data)==0;
  Winsock()=default;
  Winsock(const Winsock&)=delete;
  Winsock& operator=(const Winsock&)=delete;
  ~Winsock(){if(started)WSACleanup();}
  bool ready()const{return started&&data.wVersion==MAKEWORD(2,2);}
};
#endif

struct Bridge {
  freerdp* instance=nullptr;
  std::mutex mutex;
  std::deque<json> controls;
  std::atomic<bool> closing{false};
  std::atomic<bool> inputFailure{false};
  std::atomic<bool> certRejected{false};
  std::string host,pin;
  uint16_t port=3389;
  unsigned buttons=0;
  Options options;
  DisplayChannel display;
  std::unique_ptr<ClipboardChannel> clipboard;   // only exists when the user opted into a direction
};
struct Context {rdpContext base;Bridge* bridge;};
static Bridge& state(rdpContext* c){return *reinterpret_cast<Context*>(c)->bridge;}
static void write_status(const json& j){static std::mutex mutex;std::lock_guard<std::mutex> lock(mutex);std::cerr<<j.dump()<<'\n'<<std::flush;}
// failure_reason() (control.hpp) sorts connect errors by number; these keep its list equal to FreeRDP's own codes.
// wheel_flags() (control.hpp) builds the wheel events from these.
static_assert(PTR_FLAGS_WHEEL==0x0200&&PTR_FLAGS_HWHEEL==0x0400&&PTR_FLAGS_WHEEL_NEGATIVE==0x0100&&WheelRotationMask==0x01FF,"wheel flags");
static_assert(FREERDP_ERROR_AUTHENTICATION_FAILED==0x00020009&&FREERDP_ERROR_INSUFFICIENT_PRIVILEGES==0x0002000A&&FREERDP_ERROR_CONNECT_PASSWORD_EXPIRED==0x0002000E&&FREERDP_ERROR_CONNECT_PASSWORD_CERTAINLY_EXPIRED==0x0002000F,"authentication codes");
static_assert(FREERDP_ERROR_CONNECT_ACCOUNT_DISABLED==0x00020012&&FREERDP_ERROR_CONNECT_PASSWORD_MUST_CHANGE==0x00020013&&FREERDP_ERROR_CONNECT_LOGON_FAILURE==0x00020014&&FREERDP_ERROR_CONNECT_WRONG_PASSWORD==0x00020015,"authentication codes");
static_assert(FREERDP_ERROR_CONNECT_ACCESS_DENIED==0x00020016&&FREERDP_ERROR_CONNECT_ACCOUNT_RESTRICTION==0x00020017&&FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT==0x00020018&&FREERDP_ERROR_CONNECT_ACCOUNT_EXPIRED==0x00020019,"authentication codes");
static_assert(FREERDP_ERROR_CONNECT_LOGON_TYPE_NOT_GRANTED==0x0002001A&&FREERDP_ERROR_CONNECT_NO_OR_MISSING_CREDENTIALS==0x0002001B,"authentication codes");
// disconnect_reason() (control.hpp) sorts the server's error info codes by number; these keep its list equal to FreeRDP's own.
static_assert(ERRINFO_RPC_INITIATED_DISCONNECT==0x1&&ERRINFO_RPC_INITIATED_LOGOFF==0x2&&ERRINFO_IDLE_TIMEOUT==0x3&&ERRINFO_LOGON_TIMEOUT==0x4&&ERRINFO_DISCONNECTED_BY_OTHER_CONNECTION==0x5,"error info codes");
static_assert(ERRINFO_SERVER_DENIED_CONNECTION==0x7&&ERRINFO_SERVER_INSUFFICIENT_PRIVILEGES==0x9&&ERRINFO_SERVER_FRESH_CREDENTIALS_REQUIRED==0xA&&ERRINFO_RPC_INITIATED_DISCONNECT_BY_USER==0xB&&ERRINFO_LOGOFF_BY_USER==0xC,"error info codes");
static void status(const char* s,const char* reason=nullptr,std::optional<UINT32> lastError=std::nullopt){json j={{"state",s}};if(reason)j["reason"]=reason;if(lastError&&(std::string(s)=="failed"||std::string(s)=="closed"))j["lastError"]=*lastError;write_status(j);}
// Remote clipboard text for the owning process; base64 keeps the line short and free of escaping surprises.
static void emit_clipboard(const std::string& text){write_status(json{{"event","clipboard"},{"b64",base64_encode(text)}});}
static std::string line(){
  std::string out;char c;
  while(std::cin.get(c)){if(c=='\n')return out;if(out.size()>=65536)throw std::invalid_argument("control length");out+=c;}
  if(!out.empty())throw std::invalid_argument("truncated control");return {};
}
static void u32(uint32_t n){char b[4]={char(n),char(n>>8),char(n>>16),char(n>>24)};std::cout.write(b,4);}
static BOOL frame(rdpContext* c){
  if(state(c).closing)return FALSE;
  try{
    auto g=c->gdi;auto pixels=tightly_packed_rgba(g->primary_buffer,g->width,g->height,g->stride);
    // shortcut: full-frame copies in this spike; use dirty rectangles before production multi-monitor.
    u32(uint32_t(pixels.size()+8));u32(g->width);u32(g->height);
    std::cout.write(reinterpret_cast<const char*>(pixels.data()),std::streamsize(pixels.size()));std::cout.flush();return std::cout.good();
  }catch(...){status("failed","surface");return FALSE;}
}
static BOOL beginPaint(rdpContext* c){c->gdi->primary->hdc->hwnd->invalid->null=TRUE;return TRUE;}
static BOOL desktopResize(rdpContext* c){
  const auto w=freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopWidth),h=freerdp_settings_get_uint32(c->settings,FreeRDP_DesktopHeight);
  try{validate_surface(w,h,w*4);}catch(...){return FALSE;}
  if(!gdi_resize(c->gdi,w,h))return FALSE;
  state(c).display.note_desktop(w,h);return TRUE;
}
static BOOL postConnect(freerdp* i){
  if(!gdi_init(i,PIXEL_FORMAT_BGRA32))return FALSE;
  i->context->update->BeginPaint=beginPaint;i->context->update->EndPaint=frame;i->context->update->DesktopResize=desktopResize;
  state(i->context).display.note_desktop(i->context->gdi->width,i->context->gdi->height);
  status("connected");return TRUE;
}
// Loads exactly the channels configured below: clipboard (opt-in) and drdynvc for display control. The stock client
// loader would also bring in rdpdr, rdpsnd and ainput, which this session neither needs nor wants announced.
static bool loadStaticChannel(freerdp* i,const char* name,void* data){
  const auto entry=WINPR_FUNC_PTR_CAST(freerdp_load_channel_addin_entry(name,nullptr,nullptr,FREERDP_ADDIN_CHANNEL_STATIC|FREERDP_ADDIN_CHANNEL_ENTRYEX),PVIRTUALCHANNELENTRYEX);
  return entry&&freerdp_channels_client_load_ex(i->context->channels,i->context->settings,entry,data)==0;
}
static BOOL loadChannels(freerdp* i){
  auto* s=i->context->settings;
  for(UINT32 n=0;n<freerdp_settings_get_uint32(s,FreeRDP_StaticChannelCount);n++){
    auto* args=static_cast<ADDIN_ARGV*>(freerdp_settings_get_pointer_array_writable(s,FreeRDP_StaticChannelArray,n));
    if(!args||!args->argv||!loadStaticChannel(i,args->argv[0],args))return FALSE;
  }
  return !freerdp_settings_get_bool(s,FreeRDP_SupportDynamicChannels)||loadStaticChannel(i,DRDYNVC_SVC_CHANNEL_NAME,s);
}
static void onChannelConnected(void* context,const ChannelConnectedEventArgs* e){
  auto& b=state(static_cast<rdpContext*>(context));
  if(strcmp(e->name,DISP_DVC_CHANNEL_NAME)==0)b.display.attach(static_cast<DispClientContext*>(e->pInterface));
  else if(strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)==0&&b.clipboard)b.clipboard->attach(static_cast<CliprdrClientContext*>(e->pInterface));
}
static void onChannelDisconnected(void* context,const ChannelDisconnectedEventArgs* e){
  auto& b=state(static_cast<rdpContext*>(context));
  if(strcmp(e->name,DISP_DVC_CHANNEL_NAME)==0)b.display.detach();
  else if(strcmp(e->name,CLIPRDR_SVC_CHANNEL_NAME)==0&&b.clipboard)b.clipboard->detach();
}
static void postDisconnect(freerdp* i){if(i->context->gdi)gdi_free(i);}
static std::string digest(const BYTE* pem,size_t size){
  if(!pem||size>1024*1024)return {};
  auto bio=BIO_new_mem_buf(pem,int(size));if(!bio)return {};
  auto cert=PEM_read_bio_X509(bio,nullptr,nullptr,nullptr);BIO_free(bio);if(!cert)return {};
  unsigned char hash[EVP_MAX_MD_SIZE];unsigned n=0;const auto ok=X509_digest(cert,EVP_sha256(),hash,&n);X509_free(cert);
  if(!ok||n!=32)return {};std::string out;const char* hex="0123456789abcdef";
  for(unsigned x=0;x<n;x++){out+=hex[hash[x]>>4];out+=hex[hash[x]&15];}return out;
}
static int verifyPem(freerdp* i,const BYTE* pem,size_t n,const char* host,UINT16 port,DWORD){
  auto& b=state(i->context);const bool ok=host&&b.host==host&&b.port==port&&fingerprint_matches(digest(pem,n),b.pin);
  if(!ok)b.certRejected=true;return ok?2:0;
}
static DWORD rejectUnknown(freerdp* i,const char*,UINT16,const char*,const char*,const char*,const char*,DWORD){state(i->context).certRejected=true;return 0;}
static BOOL authenticate(freerdp*,char** u,char** p,char**,rdp_auth_reason){return u&&p&&*u&&*p&&**u;}
// FreeRDP retries a connection once after a transport failure and that retry clears the abort flag, which would silently
// undo a cancel that arrived just before. So the abort is asserted again until the connection attempt has really ended.
static void stop(const std::shared_ptr<Bridge>& b){
  b->closing=true;
  for(int i=0;i<250;i++){
    {std::lock_guard<std::mutex> lock(b->mutex);if(!b->instance)return;freerdp_abort_connect_context(b->instance->context);}
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
}
static void controls(const std::shared_ptr<Bridge>& b){
  try{while(true){const auto raw=line();if(raw.empty()){stop(b);return;}const auto v=validate_control(json::parse(raw));
    if(v.at("type")=="close"){stop(b);return;}
    std::lock_guard<std::mutex> lock(b->mutex);if(b->closing)return;
    if(b->controls.size()>=4096)throw std::invalid_argument("input budget");b->controls.push_back(v);
  }}catch(...){b->inputFailure=true;status("failed","control-protocol");stop(b);}
}
static bool sendInput(rdpContext* c,const json& v){
  const auto type=v.at("type").get<std::string>();auto& b=state(c);
  if(type=="key")return freerdp_input_send_keyboard_event_ex(c->input,v.at("down").get<bool>(),FALSE,v.at("scanCode").get<UINT32>());
  if(type=="pointer"){
    const auto x=v.at("x").get<UINT16>(),y=v.at("y").get<UINT16>();const auto next=v.at("buttons").get<unsigned>();
    // A pointer can race a desktop resize: clamp it into the current desktop instead of ending the session.
    const auto at=clamp_pointer(x,y,uint32_t(c->gdi->width),uint32_t(c->gdi->height));
    if(!freerdp_input_send_mouse_event(c->input,PTR_FLAGS_MOVE,at.x,at.y))return false;
    const UINT16 flags[]={PTR_FLAGS_BUTTON1,PTR_FLAGS_BUTTON2,PTR_FLAGS_BUTTON3};
    for(unsigned bit=0;bit<3;bit++)if((next^b.buttons)&(1u<<bit))if(!freerdp_input_send_mouse_event(c->input,flags[bit]|((next&(1u<<bit))?PTR_FLAGS_DOWN:0),at.x,at.y))return false;
    b.buttons=next;return true;
  }
  // A wheel turn (vertical, or horizontal under its own type) goes out at the pointer's position (moved there first, so that the remote scrolls what the user is over), as several events when it is large.
  // FreeRDP drops a horizontal event, silently, when the server did not announce horizontal wheel support.
  if(type=="wheel"||type=="hwheel"){
    const bool horizontal=type=="hwheel";
    const auto at=clamp_pointer(v.at("x").get<UINT16>(),v.at("y").get<UINT16>(),uint32_t(c->gdi->width),uint32_t(c->gdi->height));
    if(!freerdp_input_send_mouse_event(c->input,PTR_FLAGS_MOVE,at.x,at.y))return false;
    for(const int step:wheel_steps(v.at("delta").get<int>()))if(!freerdp_input_send_mouse_event(c->input,wheel_flags(step,horizontal),at.x,at.y))return false;
    return true;
  }
  // Display control resizes the live desktop; no reconnect and no credentials involved.
  if(type=="resize")return b.display.request(v.at("width").get<uint32_t>(),v.at("height").get<uint32_t>());
  if(type=="clipboard"){
    // Best effort: text that cannot be offered is dropped, never fatal.
    if(b.clipboard){if(auto text=base64_decode(v.at("b64").get<std::string>())){(void)b.clipboard->offer(*text);std::fill(text->begin(),text->end(),'\0');}}
    return true;
  }
  return false;
}
static void environment(const char* name,const char* value){
#ifdef _WIN32
  _putenv_s(name,value);
#else
  setenv(name,value,1);
#endif
}
// Local stand-in for a remote desktop: alternating red/green pixels at the requested size.
static void fixtureFrame(uint32_t w,uint32_t h){
  std::vector<uint8_t> bgra(size_t(w)*h*4);
  for(size_t n=0;n<size_t(w)*h;n++){const uint8_t px[4]={0,uint8_t(n%2?255:0),uint8_t(n%2?0:255),255};std::copy(px,px+4,bgra.begin()+n*4);}
  const auto p=tightly_packed_rgba(bgra.data(),w,h,w*4);
  u32(uint32_t(p.size()+8));u32(w);u32(h);std::cout.write(reinterpret_cast<const char*>(p.data()),std::streamsize(p.size()));std::cout.flush();
}
static int fixture(){
  const auto raw=line();if(raw.empty())return 1;const auto handshake=json::parse(raw);if(handshake.at("type")!="connect")return 2;
  const auto options=parse_options(handshake.contains("target")?handshake.at("target"):json::object());
  status("connected");fixtureFrame(2,1);
  if(options.fromRemote)emit_clipboard("fixture-remote-text");
  while(true){
    const auto rawControl=line();if(rawControl.empty())break;const auto v=validate_control(json::parse(rawControl));
    if(v.at("type")=="close")break;
    if(v.at("type")=="resize")try{fixtureFrame(v.at("width").get<uint32_t>(),v.at("height").get<uint32_t>());}catch(...){status("failed","surface");return 1;}
    // A stand-in remote that mirrors what it is offered, so the whole local-to-remote path can be seen end to end.
    if(v.at("type")=="clipboard"&&options.toRemote&&options.fromRemote)
      if(const auto text=base64_decode(v.at("b64").get<std::string>()))if(!text->empty())emit_clipboard("fixture-echo:"+*text);
  }
  status("closed");return 0;
}
int main(int argc,char** argv){
#ifdef _WIN32
  _setmode(_fileno(stdout),_O_BINARY);
  _setmode(_fileno(stdin),_O_BINARY);
#endif
  environment("WLOG_LEVEL","OFF");environment("WLOG_FILTER","*:OFF");WLog_SetLogLevel(WLog_GetRoot(),WLOG_OFF);
  if(argc==2&&std::string(argv[1])=="--profile-policy")return rdp_profile::rpc(std::cin,std::cout);
  if(argc!=2||(std::string(argv[1])!="--bridge-v1"&&std::string(argv[1])!="--fixture"))return 2;
  try{
    if(std::string(argv[1])=="--fixture")return fixture();
#ifdef _WIN32
    // FreeRDP resolves hosts before creating its TLS BIO; the helper owns Winsock startup.
    Winsock sockets;if(!sockets.ready()){status("failed","connection");return 1;}
#endif
    const auto raw=line();const auto request=json::parse(raw);if(request.at("type")!="connect")throw std::invalid_argument("connect");
    const auto& target=request.at("target");const auto& secret=request.at("secret");
    auto b=std::make_shared<Bridge>();b->host=target.at("host").get<std::string>();b->port=uint16_t(bounded_integer(target,"port",1,65535));
    const auto username=target.at("username").get<std::string>(),password=secret.at("password").get<std::string>(),domain=secret.at("domain").get<std::string>();
    b->pin=target.value("certificateSha256",std::string());
    if(b->host.empty()||b->host.size()>253||b->host.find_first_of("\r\n\t ")!=std::string::npos||username.empty()||username.size()>256||password.size()>4096||domain.size()>256)throw std::invalid_argument("target");
    if(!b->pin.empty()&&!fingerprint_matches(b->pin,b->pin))throw std::invalid_argument("pin");
    b->options=parse_options(target);
    const auto configPath=rdp_profile::config_path();
    if(b->options.toRemote||b->options.fromRemote)b->clipboard=std::make_unique<ClipboardChannel>(b->options.toRemote,b->options.fromRemote,[](const std::string& text){emit_clipboard(text);});
    auto i=freerdp_new();if(!i)throw std::runtime_error("instance");i->ContextSize=sizeof(Context);
    if(!freerdp_context_new(i)){freerdp_free(i);throw std::runtime_error("context");}
    reinterpret_cast<Context*>(i->context)->bridge=b.get();b->instance=i;
    // The client library resolves built-in channels through this provider; a bare freerdp instance never registers it.
    if(freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry,0)!=CHANNEL_RC_OK)throw std::runtime_error("channels");
    i->LoadChannels=loadChannels;
    if(PubSub_SubscribeChannelConnected(i->context->pubSub,onChannelConnected)<0||PubSub_SubscribeChannelDisconnected(i->context->pubSub,onChannelDisconnected)<0)throw std::runtime_error("channels");
    i->PostConnect=postConnect;i->PostDisconnect=postDisconnect;i->AuthenticateEx=authenticate;i->VerifyCertificateEx=rejectUnknown;i->VerifyX509Certificate=verifyPem;
    auto s=i->context->settings;
    bool ok=freerdp_settings_set_string(s,FreeRDP_ConfigPath,configPath.c_str())
      &&freerdp_settings_set_string(s,FreeRDP_ServerHostname,b->host.c_str())&&freerdp_settings_set_uint32(s,FreeRDP_ServerPort,b->port)
      &&freerdp_settings_set_string(s,FreeRDP_Username,username.c_str())&&freerdp_settings_set_string(s,FreeRDP_Password,password.c_str())&&freerdp_settings_set_string(s,FreeRDP_Domain,domain.c_str())
      &&freerdp_settings_set_uint32(s,FreeRDP_DesktopWidth,b->options.width)&&freerdp_settings_set_uint32(s,FreeRDP_DesktopHeight,b->options.height)
      &&freerdp_settings_set_bool(s,FreeRDP_SupportDisplayControl,TRUE)&&freerdp_settings_set_bool(s,FreeRDP_SupportDynamicChannels,TRUE)
      // Channel callbacks must run on this thread, the one that applies input (channels.hpp keeps no locks and aborts otherwise).
      &&freerdp_settings_set_uint32(s,FreeRDP_ThreadingFlags,THREADING_FLAGS_DISABLE_THREADS)&&freerdp_settings_set_bool(s,FreeRDP_SynchronousDynamicChannels,TRUE)
      // Text only, per opted-in direction: FreeRDP drops file formats and refuses the other direction below our own checks.
      &&freerdp_settings_set_bool(s,FreeRDP_RedirectClipboard,b->clipboard!=nullptr)
      &&freerdp_settings_set_uint32(s,FreeRDP_ClipboardFeatureMask,(b->options.toRemote?CLIPRDR_FLAG_LOCAL_TO_REMOTE:0)|(b->options.fromRemote?CLIPRDR_FLAG_REMOTE_TO_LOCAL:0))
      &&freerdp_settings_set_uint32(s,FreeRDP_ColorDepth,32)&&freerdp_settings_set_bool(s,FreeRDP_SoftwareGdi,TRUE)
      &&freerdp_settings_set_bool(s,FreeRDP_SupportGraphicsPipeline,FALSE)&&freerdp_settings_set_bool(s,FreeRDP_ExternalCertificateManagement,!b->pin.empty())
      &&freerdp_settings_set_bool(s,FreeRDP_IgnoreCertificate,FALSE)&&freerdp_settings_set_bool(s,FreeRDP_NlaSecurity,TRUE)&&freerdp_settings_set_bool(s,FreeRDP_RdpSecurity,FALSE)
      &&freerdp_settings_set_uint32(s,FreeRDP_TcpConnectTimeout,10000);
    if(ok){const char* display[]={DISP_CHANNEL_NAME};ok=freerdp_client_add_dynamic_channel(s,1,display);}
    if(ok&&b->clipboard){const char* clipboard[]={CLIPRDR_SVC_CHANNEL_NAME};ok=freerdp_client_add_static_channel(s,1,clipboard);}
    if(!ok)throw std::runtime_error("settings");
    std::thread(controls,b).detach();status("connecting");const bool connected=freerdp_connect(i);
    if(!connected){
      const UINT32 lastError=freerdp_get_last_error(i->context);
      if(!b->closing)status("failed",failure_reason(b->certRejected,lastError),lastError);
    }
    bool connectionFailure=!connected;
    while(connected&&!b->closing&&!freerdp_shall_disconnect_context(i->context)){
      HANDLE handles[64];const auto n=freerdp_get_event_handles(i->context,handles,64);
      if(!n||WaitForMultipleObjects(n,handles,FALSE,20)==WAIT_FAILED){connectionFailure=true;break;}
      if(!freerdp_check_event_handles(i->context)){connectionFailure=true;break;}
      std::deque<json> pending;{std::lock_guard<std::mutex> lock(b->mutex);pending.swap(b->controls);}
      for(const auto& v:pending)if(!sendInput(i->context,v)){b->inputFailure=true;connectionFailure=true;b->closing=true;break;}
    }
    const bool requested=b->closing,inputFailure=b->inputFailure;{std::lock_guard<std::mutex> lock(b->mutex);b->closing=true;b->instance=nullptr;}
    const UINT32 errorInfo=connected?freerdp_error_info(i):0;   // why the server ended the session, if it said; gone once the context is freed
    freerdp_disconnect(i);freerdp_context_free(i);freerdp_free(i);
    if(connected&&!requested&&errorInfo&&!inputFailure){status("closed",disconnect_reason(errorInfo),errorInfo);return 0;}   // the server ended it and said why, however the connection then dropped
    if(connected&&connectionFailure&&!requested)status("failed","connection");else if(connected)status("closed");
    return connection_exit_code(connected,connectionFailure,requested,inputFailure);
  }catch(...){status("failed","control-protocol");return 2;}
}
