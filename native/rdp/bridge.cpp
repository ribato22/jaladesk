#include "surface.hpp"
#include "control.hpp"
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/error.h>
#include <winpr/synch.h>
#include <winpr/wlog.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <atomic>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <memory>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

struct Bridge {
  freerdp* instance=nullptr;
  std::mutex mutex;
  std::deque<json> controls;
  std::atomic<bool> closing{false};
  std::atomic<bool> certRejected{false};
  std::string host,pin;
  uint16_t port=3389;
  unsigned buttons=0;
};
struct Context {rdpContext base;Bridge* bridge;};
static Bridge& state(rdpContext* c){return *reinterpret_cast<Context*>(c)->bridge;}
static void status(const char* s,const char* reason=nullptr){static std::mutex mutex;std::lock_guard<std::mutex> lock(mutex);json j={{"state",s}};if(reason)j["reason"]=reason;std::cerr<<j.dump()<<'\n'<<std::flush;}
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
  return gdi_resize(c->gdi,w,h);
}
static BOOL postConnect(freerdp* i){
  if(!gdi_init(i,PIXEL_FORMAT_BGRA32))return FALSE;
  i->context->update->BeginPaint=beginPaint;i->context->update->EndPaint=frame;i->context->update->DesktopResize=desktopResize;
  status("connected");return TRUE;
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
static void stop(const std::shared_ptr<Bridge>& b){
  b->closing=true;std::lock_guard<std::mutex> lock(b->mutex);if(b->instance)freerdp_abort_connect_context(b->instance->context);
}
static void controls(const std::shared_ptr<Bridge>& b){
  try{while(true){const auto raw=line();if(raw.empty()){stop(b);return;}const auto v=validate_control(json::parse(raw));
    if(v.at("type")=="close"){stop(b);return;}
    std::lock_guard<std::mutex> lock(b->mutex);if(b->closing)return;
    if(b->controls.size()>=4096)throw std::invalid_argument("input budget");b->controls.push_back(v);
  }}catch(...){status("failed","control-protocol");stop(b);}
}
static bool sendInput(rdpContext* c,const json& v){
  const auto type=v.at("type").get<std::string>();auto& b=state(c);
  if(type=="key")return freerdp_input_send_keyboard_event_ex(c->input,v.at("down").get<bool>(),FALSE,v.at("scanCode").get<UINT32>());
  if(type=="pointer"){
    const auto x=v.at("x").get<UINT16>(),y=v.at("y").get<UINT16>();const auto next=v.at("buttons").get<unsigned>();
    if(x>=c->gdi->width||y>=c->gdi->height)return false;
    if(!freerdp_input_send_mouse_event(c->input,PTR_FLAGS_MOVE,x,y))return false;
    const UINT16 flags[]={PTR_FLAGS_BUTTON1,PTR_FLAGS_BUTTON2,PTR_FLAGS_BUTTON3};
    for(unsigned bit=0;bit<3;bit++)if((next^b.buttons)&(1u<<bit))if(!freerdp_input_send_mouse_event(c->input,flags[bit]|((next&(1u<<bit))?PTR_FLAGS_DOWN:0),x,y))return false;
    b.buttons=next;return true;
  }
  if(type=="resize"){status("failed","resize-reconnect");b.closing=true;return false;}return false;
}
static void environment(const char* name,const char* value){
#ifdef _WIN32
  _putenv_s(name,value);
#else
  setenv(name,value,1);
#endif
}
static int fixture(){
  const auto raw=line();if(raw.empty())return 1;const auto handshake=json::parse(raw);if(handshake.at("type")!="connect")return 2;
  const uint8_t bgra[]={0,0,255,255,0,255,0,255};const auto p=tightly_packed_rgba(bgra,2,1,8);
  status("connected");u32(16);u32(2);u32(1);std::cout.write(reinterpret_cast<const char*>(p.data()),p.size());std::cout.flush();
  while(true){const auto rawControl=line();if(rawControl.empty())break;const auto v=validate_control(json::parse(rawControl));if(v.at("type")=="close")break;}status("closed");return 0;
}
int main(int argc,char** argv){
#ifdef _WIN32
  _setmode(_fileno(stdout),_O_BINARY);
#endif
  environment("WLOG_LEVEL","OFF");environment("WLOG_FILTER","*:OFF");WLog_SetLogLevel(WLog_GetRoot(),WLOG_OFF);
  if(argc!=2||(std::string(argv[1])!="--bridge-v1"&&std::string(argv[1])!="--fixture"))return 2;
  try{
    if(std::string(argv[1])=="--fixture")return fixture();
    const auto raw=line();const auto request=json::parse(raw);if(request.at("type")!="connect")throw std::invalid_argument("connect");
    const auto& target=request.at("target");const auto& secret=request.at("secret");
    auto b=std::make_shared<Bridge>();b->host=target.at("host").get<std::string>();b->port=uint16_t(bounded_integer(target,"port",1,65535));
    const auto username=target.at("username").get<std::string>(),password=secret.at("password").get<std::string>(),domain=secret.at("domain").get<std::string>();
    b->pin=target.value("certificateSha256",std::string());
    if(b->host.empty()||b->host.size()>253||b->host.find_first_of("\r\n\t ")!=std::string::npos||username.empty()||username.size()>256||password.size()>4096||domain.size()>256)throw std::invalid_argument("target");
    if(!b->pin.empty()&&!fingerprint_matches(b->pin,b->pin))throw std::invalid_argument("pin");
    auto i=freerdp_new();if(!i)throw std::runtime_error("instance");i->ContextSize=sizeof(Context);
    if(!freerdp_context_new(i)){freerdp_free(i);throw std::runtime_error("context");}
    reinterpret_cast<Context*>(i->context)->bridge=b.get();b->instance=i;
    i->PostConnect=postConnect;i->PostDisconnect=postDisconnect;i->AuthenticateEx=authenticate;i->VerifyCertificateEx=rejectUnknown;i->VerifyX509Certificate=verifyPem;
    auto s=i->context->settings;
    bool ok=freerdp_settings_set_string(s,FreeRDP_ServerHostname,b->host.c_str())&&freerdp_settings_set_uint32(s,FreeRDP_ServerPort,b->port)
      &&freerdp_settings_set_string(s,FreeRDP_Username,username.c_str())&&freerdp_settings_set_string(s,FreeRDP_Password,password.c_str())&&freerdp_settings_set_string(s,FreeRDP_Domain,domain.c_str())
      &&freerdp_settings_set_uint32(s,FreeRDP_DesktopWidth,1280)&&freerdp_settings_set_uint32(s,FreeRDP_DesktopHeight,720)
      &&freerdp_settings_set_uint32(s,FreeRDP_ColorDepth,32)&&freerdp_settings_set_bool(s,FreeRDP_SoftwareGdi,TRUE)
      &&freerdp_settings_set_bool(s,FreeRDP_SupportGraphicsPipeline,FALSE)&&freerdp_settings_set_bool(s,FreeRDP_ExternalCertificateManagement,!b->pin.empty())
      &&freerdp_settings_set_bool(s,FreeRDP_IgnoreCertificate,FALSE)&&freerdp_settings_set_bool(s,FreeRDP_NlaSecurity,TRUE)&&freerdp_settings_set_bool(s,FreeRDP_RdpSecurity,FALSE)
      &&freerdp_settings_set_uint32(s,FreeRDP_TcpConnectTimeout,10000);
    if(!ok)throw std::runtime_error("settings");
    std::thread(controls,b).detach();status("connecting");const bool connected=freerdp_connect(i);
    bool connectionFailure=!connected;
    if(!connected&&!b->closing)status("failed",b->certRejected?"certificate":(freerdp_get_last_error(i->context)==FREERDP_ERROR_AUTHENTICATION_FAILED?"authentication":"connection"));
    while(connected&&!b->closing&&!freerdp_shall_disconnect_context(i->context)){
      HANDLE handles[64];const auto n=freerdp_get_event_handles(i->context,handles,64);
      if(!n||WaitForMultipleObjects(n,handles,FALSE,20)==WAIT_FAILED){connectionFailure=true;break;}
      if(!freerdp_check_event_handles(i->context)){connectionFailure=true;break;}
      std::deque<json> pending;{std::lock_guard<std::mutex> lock(b->mutex);pending.swap(b->controls);}
      for(const auto& v:pending)if(!sendInput(i->context,v)){connectionFailure=true;b->closing=true;break;}
    }
    const bool requested=b->closing;{std::lock_guard<std::mutex> lock(b->mutex);b->closing=true;b->instance=nullptr;}
    freerdp_disconnect(i);freerdp_context_free(i);freerdp_free(i);
    if(connected&&connectionFailure&&!requested)status("failed","connection");else if(connected)status("closed");
    return connectionFailure?1:0;
  }catch(...){status("failed","control-protocol");return 2;}
}
