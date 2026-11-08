// Loopback RDP server for the bridge's integration test (scripts/test-native-integration.mjs).
// TLS only, 127.0.0.1 only, any client accepted: it exists to drive the REAL client channel plugins end to end
// (display control resize round trip, text clipboard in both directions, file formats offered and refused).
// Never expose it. It is controlled over stdin/stdout with one line per command/event, binary data as hex.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>
#include <winpr/crt.h>
#include <winpr/ssl.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/winsock.h>
#include <freerdp/freerdp.h>
#include <freerdp/listener.h>
#include <freerdp/peer.h>
#include <freerdp/settings.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <freerdp/channels/wtsvc.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/drdynvc.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/server/cliprdr.h>
#include <freerdp/server/disp.h>

static std::mutex outLock;
static void emit(const char* fmt,...){
  std::lock_guard<std::mutex> lock(outLock);
  va_list ap;va_start(ap,fmt);vprintf(fmt,ap);va_end(ap);putchar('\n');fflush(stdout);
}
static std::string hex(const uint8_t* p,size_t n){static const char* d="0123456789abcdef";std::string s;for(size_t i=0;i<n;i++){s+=d[p[i]>>4];s+=d[p[i]&15];}return s;}
static std::vector<uint8_t> unhex(const std::string& s){
  std::vector<uint8_t> out;auto v=[](char c){return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:0;};
  for(size_t i=0;i+1<s.size();i+=2)out.push_back(uint8_t(v(s[i])<<4|v(s[i+1])));
  return out;
}

struct PeerState{
  HANDLE resizeEvent=nullptr;
  std::atomic<uint32_t> wantW{0},wantH{0};
  std::atomic<int64_t> endInfo{-1};    // end-session <code>: the peer thread sends this error info code and then ends the session
  std::mutex clipLock;                 // cliprdr callbacks run on the channel thread, commands on the stdin thread
  CliprdrServerContext* clip=nullptr;
  DispServerContext* disp=nullptr;
  std::vector<uint8_t> remoteWide;     // CF_UNICODETEXT the "remote user" copied; empty = nothing to paste
  bool dispOpened=false,capsSent=false;
  bool longNames=true;
  bool connected=false;                // peer thread only: set once the channels are joined (PostConnect)
  bool resizing=false;                 // peer thread only: a DesktopResize is waiting for the client's reactivation to finish
  int console=0;                       // 0 = red/blue test screen, 1 = a fake console that echoes typed keys, 2 = a fake console that never echoes
  uint32_t cx=170,cy=40;               // where the next typed character appears
  unsigned capsDelayMs=0;              // how long after the dynamic channel is ready the display caps are announced
  bool readySeen=false;std::chrono::steady_clock::time_point readyAt;
};
struct PeerContext{rdpContext base;HANDLE vcm;PeerState* st;};
static PeerState* current=nullptr;
static std::vector<PeerState*> connectedPeers;   // oldest first: end-session <code> first ends the oldest, as a server does when the account connects again
static std::mutex currentLock;
struct ServerInfo{const char* cert;const char* key;bool longNames;unsigned capsDelayMs;int console;bool hwheel;};   // hwheel: advertise horizontal wheel support in the input capabilities (the default)

// ---- clipboard (static channel cliprdr) ----
static UINT onClientCapabilities(CliprdrServerContext*,const CLIPRDR_CAPABILITIES* caps){
  UINT32 flags=0;
  if(caps&&caps->cCapabilitiesSets>0&&caps->capabilitySets)flags=reinterpret_cast<const CLIPRDR_GENERAL_CAPABILITY_SET*>(caps->capabilitySets)->generalFlags;
  emit("CLIPCAPS %u",flags);return CHANNEL_RC_OK;
}
static UINT onTempDirectory(CliprdrServerContext*,const CLIPRDR_TEMP_DIRECTORY*){return CHANNEL_RC_OK;}
static UINT onClientFormatList(CliprdrServerContext* ctx,const CLIPRDR_FORMAT_LIST* list){
  std::string ids;bool text=false;
  for(UINT32 i=0;i<list->numFormats;i++){if(i)ids+=',';ids+=std::to_string(list->formats[i].formatId);text=text||list->formats[i].formatId==CF_UNICODETEXT;}
  emit("CLIPLIST %s",ids.c_str());
  CLIPRDR_FORMAT_LIST_RESPONSE ack{};ack.common.msgType=CB_FORMAT_LIST_RESPONSE;ack.common.msgFlags=CB_RESPONSE_OK;
  if(const UINT rc=ctx->ServerFormatListResponse(ctx,&ack))return rc;
  if(!text)return CHANNEL_RC_OK;
  CLIPRDR_FORMAT_DATA_REQUEST req{};req.common.msgType=CB_FORMAT_DATA_REQUEST;req.requestedFormatId=CF_UNICODETEXT;
  return ctx->ServerFormatDataRequest(ctx,&req);
}
static UINT onClientFormatListResponse(CliprdrServerContext*,const CLIPRDR_FORMAT_LIST_RESPONSE* r){emit("CLIPACK %u",unsigned(r->common.msgFlags));return CHANNEL_RC_OK;}
static UINT onClientFormatDataRequest(CliprdrServerContext* ctx,const CLIPRDR_FORMAT_DATA_REQUEST* req){
  emit("CLIPREQUEST %u",req->requestedFormatId);
  auto* st=static_cast<PeerState*>(ctx->custom);
  static const BYTE none=0;
  CLIPRDR_FORMAT_DATA_RESPONSE resp{};resp.common.msgType=CB_FORMAT_DATA_RESPONSE;
  if(req->requestedFormatId==CF_UNICODETEXT&&st&&!st->remoteWide.empty()){
    resp.common.msgFlags=CB_RESPONSE_OK;resp.common.dataLen=UINT32(st->remoteWide.size());resp.requestedFormatData=st->remoteWide.data();
  }else{resp.common.msgFlags=CB_RESPONSE_FAIL;resp.requestedFormatData=&none;}
  return ctx->ServerFormatDataResponse(ctx,&resp);
}
static UINT onClientFormatDataResponse(CliprdrServerContext*,const CLIPRDR_FORMAT_DATA_RESPONSE* resp){
  if(!(resp->common.msgFlags&CB_RESPONSE_OK))emit("CLIPFAIL");
  else emit("CLIPTEXT %s",hex(resp->requestedFormatData,resp->common.dataLen).c_str());   // raw UTF-16LE as received
  return CHANNEL_RC_OK;
}
static void initClipboard(PeerContext* ctx){
  auto* st=ctx->st;
  st->clip=cliprdr_server_context_new(ctx->vcm);if(!st->clip)return;
  st->clip->rdpcontext=&ctx->base;st->clip->custom=st;st->clip->useLongFormatNames=st->longNames;
  st->clip->ClientCapabilities=onClientCapabilities;st->clip->TempDirectory=onTempDirectory;
  st->clip->ClientFormatList=onClientFormatList;st->clip->ClientFormatListResponse=onClientFormatListResponse;
  st->clip->ClientFormatDataRequest=onClientFormatDataRequest;st->clip->ClientFormatDataResponse=onClientFormatDataResponse;
  if(st->clip->Start(st->clip)!=CHANNEL_RC_OK)emit("ERROR cliprdr start failed");
}
// Offers formats to the client: text (CF_UNICODETEXT) and/or the two file formats a file copy would announce. `legacy` adds
// the other text formats a Windows application lists around CF_UNICODETEXT (CF_TEXT, CF_OEMTEXT, CF_LOCALE), before it.
static void announce(PeerState* st,bool text,bool files,bool legacy=false){
  std::lock_guard<std::mutex> lock(st->clipLock);
  if(!st->clip)return;
  char fileGroup[]="FileGroupDescriptorW",fileContents[]="FileContents";
  CLIPRDR_FORMAT formats[6]{};UINT32 n=0;
  if(legacy){formats[n++].formatId=CF_TEXT;formats[n++].formatId=CF_OEMTEXT;formats[n++].formatId=CF_LOCALE;}
  if(text){formats[n].formatId=CF_UNICODETEXT;n++;}
  if(files){formats[n].formatId=0xC0F0;formats[n].formatName=fileGroup;n++;formats[n].formatId=0xC0F1;formats[n].formatName=fileContents;n++;}
  CLIPRDR_FORMAT_LIST list{};list.common.msgType=CB_FORMAT_LIST;list.numFormats=n;list.formats=n?formats:nullptr;
  const UINT rc=st->clip->ServerFormatList(st->clip,&list);if(rc)emit("ERROR announce %u",rc);
}

// ---- display control (dynamic channel) ----
static UINT onMonitorLayout(DispServerContext* ctx,const DISPLAY_CONTROL_MONITOR_LAYOUT_PDU* pdu){
  auto* st=static_cast<PeerState*>(ctx->custom);
  if(!st||pdu->NumMonitors<1)return CHANNEL_RC_OK;
  const auto& m=pdu->Monitors[0];
  emit("LAYOUT %u %u",m.Width,m.Height);
  st->wantW=m.Width;st->wantH=m.Height;SetEvent(st->resizeEvent);   // the peer thread performs the resize
  return CHANNEL_RC_OK;
}
static void tryOpenDisplay(PeerContext* ctx){
  auto* st=ctx->st;
  if(!st->disp){
    st->disp=disp_server_context_new(ctx->vcm);if(!st->disp)return;
    st->disp->rdpcontext=&ctx->base;st->disp->custom=st;st->disp->MaxNumMonitors=1;st->disp->MaxMonitorAreaFactorA=8192;st->disp->MaxMonitorAreaFactorB=8192;
    st->disp->DispMonitorLayout=onMonitorLayout;
  }
  if(!st->dispOpened){if(st->disp->Open(st->disp)!=CHANNEL_RC_OK){emit("ERROR disp open failed");return;}st->dispOpened=true;}
  if(st->capsSent)return;
  const auto now=std::chrono::steady_clock::now();
  if(!st->readySeen){st->readySeen=true;st->readyAt=now;}
  if(now-st->readyAt>=std::chrono::milliseconds(st->capsDelayMs)&&st->disp->DisplayControlCaps(st->disp)==CHANNEL_RC_OK){st->capsSent=true;emit("DISPCAPS");}
}

// ---- screen: left half red, right half blue, raw surface bits; redrawn after every (re)activation ----
static bool draw(freerdp_peer* peer){
  rdpSettings* s=peer->context->settings;rdpUpdate* update=peer->context->update;
  const uint32_t w=freerdp_settings_get_uint32(s,FreeRDP_DesktopWidth),h=freerdp_settings_get_uint32(s,FreeRDP_DesktopHeight);
  std::vector<uint8_t> px(size_t(w)*h*4);
  const bool console=reinterpret_cast<PeerContext*>(peer->context)->st->console!=0;
  for(uint32_t y=0;y<h;y++)for(uint32_t x=0;x<w;x++){
    uint8_t* p=&px[(size_t(y)*w+x)*4];const bool left=x<w/2;
    if(console){p[0]=86;p[1]=36;p[2]=1;p[3]=255;}   // the PowerShell console blue 0x012456, B,G,R,X
    else{p[0]=left?0:255;p[1]=0;p[2]=left?255:0;p[3]=255;}   // B,G,R,X
  }
  SURFACE_FRAME_MARKER marker{};marker.frameAction=SURFACECMD_FRAMEACTION_BEGIN;marker.frameId=1;
  if(!update->SurfaceFrameMarker(update->context,&marker))return false;
  SURFACE_BITS_COMMAND cmd{};cmd.cmdType=CMDTYPE_SET_SURFACE_BITS;cmd.destLeft=0;cmd.destTop=0;cmd.destRight=w;cmd.destBottom=h;
  cmd.bmp.bpp=32;cmd.bmp.codecID=0;cmd.bmp.width=UINT16(w);cmd.bmp.height=UINT16(h);cmd.bmp.bitmapDataLength=UINT32(px.size());cmd.bmp.bitmapData=px.data();
  const bool ok=update->SurfaceBits(update->context,&cmd);
  marker.frameAction=SURFACECMD_FRAMEACTION_END;
  return update->SurfaceFrameMarker(update->context,&marker)&&ok;
}

// ---- input is only reported ----
static BOOL onMouse(rdpInput*,UINT16 flags,UINT16 x,UINT16 y){emit("MOUSE %u %u %u",unsigned(x),unsigned(y),unsigned(flags));return TRUE;}
static BOOL onExtendedMouse(rdpInput*,UINT16,UINT16,UINT16){return TRUE;}
static BOOL onRelMouse(rdpInput*,UINT16,INT16,INT16){return TRUE;}
// Console modes imitate what a console does with typed keys: a character shows up on the prompt line, Enter moves to the next line.
static void drawBlock(rdpContext* context,uint32_t x,uint32_t y){
  rdpUpdate* update=context->update;const uint32_t w=7,h=12;
  std::vector<uint8_t> px(size_t(w)*h*4,204);
  SURFACE_FRAME_MARKER marker{};marker.frameAction=SURFACECMD_FRAMEACTION_BEGIN;marker.frameId=2;
  if(!update->SurfaceFrameMarker(context,&marker))return;
  SURFACE_BITS_COMMAND cmd{};cmd.cmdType=CMDTYPE_SET_SURFACE_BITS;cmd.destLeft=x;cmd.destTop=y;cmd.destRight=x+w;cmd.destBottom=y+h;
  cmd.bmp.bpp=32;cmd.bmp.codecID=0;cmd.bmp.width=UINT16(w);cmd.bmp.height=UINT16(h);cmd.bmp.bitmapDataLength=UINT32(px.size());cmd.bmp.bitmapData=px.data();
  update->SurfaceBits(context,&cmd);
  marker.frameAction=SURFACECMD_FRAMEACTION_END;update->SurfaceFrameMarker(context,&marker);
}
static BOOL onKeyboard(rdpInput* input,UINT16 flags,UINT8 code){
  emit("KEY %u %u",unsigned(flags),unsigned(code));
  auto* st=reinterpret_cast<PeerContext*>(input->context)->st;
  if(st->console==1&&!(flags&KBD_FLAGS_RELEASE)){
    if(code==0x1C){st->cx=170;st->cy+=14;}
    else{drawBlock(input->context,st->cx,st->cy);st->cx+=8;if(st->cx>800){st->cx=0;st->cy+=14;}}
  }
  return TRUE;
}
static BOOL onUnicode(rdpInput*,UINT16,UINT16){return TRUE;}
static BOOL onSync(rdpInput*,UINT32){return TRUE;}

static BOOL peerPostConnect(freerdp_peer* peer){
  auto* ctx=reinterpret_cast<PeerContext*>(peer->context);
  rdpSettings* s=peer->context->settings;
  emit("CONNECTED %u %u",freerdp_settings_get_uint32(s,FreeRDP_DesktopWidth),freerdp_settings_get_uint32(s,FreeRDP_DesktopHeight));
  {std::lock_guard<std::mutex> lock(currentLock);current=ctx->st;connectedPeers.push_back(ctx->st);}
  ctx->st->connected=true;
  if(WTSVirtualChannelManagerIsChannelJoined(ctx->vcm,DRDYNVC_SVC_CHANNEL_NAME))emit("CHANNEL drdynvc");
  if(WTSVirtualChannelManagerIsChannelJoined(ctx->vcm,CLIPRDR_SVC_CHANNEL_NAME)){emit("CHANNEL cliprdr");initClipboard(ctx);}
  return TRUE;
}
static BOOL peerActivate(freerdp_peer* peer){
  reinterpret_cast<PeerContext*>(peer->context)->st->resizing=false;
  rdpSettings* s=peer->context->settings;
  const bool ok=draw(peer);
  emit("DESKTOP %u %u %s",freerdp_settings_get_uint32(s,FreeRDP_DesktopWidth),freerdp_settings_get_uint32(s,FreeRDP_DesktopHeight),ok?"drawn":"draw-failed");
  return ok;
}
static BOOL peerContextNew(freerdp_peer* peer,rdpContext* base){
  auto* ctx=reinterpret_cast<PeerContext*>(base);
  ctx->st=new PeerState();ctx->st->resizeEvent=CreateEvent(nullptr,TRUE,FALSE,nullptr);
  ctx->st->longNames=static_cast<ServerInfo*>(peer->ContextExtra)->longNames;
  ctx->st->capsDelayMs=static_cast<ServerInfo*>(peer->ContextExtra)->capsDelayMs;
  ctx->st->console=static_cast<ServerInfo*>(peer->ContextExtra)->console;
  ctx->vcm=WTSOpenServerA(reinterpret_cast<LPSTR>(peer->context));
  return ctx->st->resizeEvent&&ctx->vcm&&ctx->vcm!=INVALID_HANDLE_VALUE;
}
static void peerContextFree(freerdp_peer*,rdpContext* base){
  auto* ctx=reinterpret_cast<PeerContext*>(base);
  if(!ctx||!ctx->st)return;
  {std::lock_guard<std::mutex> lock(currentLock);if(current==ctx->st)current=nullptr;connectedPeers.erase(std::remove(connectedPeers.begin(),connectedPeers.end(),ctx->st),connectedPeers.end());}
  if(ctx->st->clip){ctx->st->clip->Stop(ctx->st->clip);cliprdr_server_context_free(ctx->st->clip);}
  if(ctx->st->disp){ctx->st->disp->Close(ctx->st->disp);disp_server_context_free(ctx->st->disp);}
  if(ctx->vcm)WTSCloseServer(ctx->vcm);
  if(ctx->st->resizeEvent)CloseHandle(ctx->st->resizeEvent);
  delete ctx->st;ctx->st=nullptr;
}

static DWORD WINAPI peerMain(LPVOID arg){
  auto* peer=static_cast<freerdp_peer*>(arg);
  auto* info=static_cast<ServerInfo*>(peer->ContextExtra);
  peer->ContextSize=sizeof(PeerContext);peer->ContextNew=peerContextNew;peer->ContextFree=peerContextFree;
  if(!freerdp_peer_context_new(peer)){freerdp_peer_free(peer);return 0;}
  rdpSettings* s=peer->context->settings;
  rdpPrivateKey* key=freerdp_key_new_from_file_enc(info->key,nullptr);
  rdpCertificate* cert=freerdp_certificate_new_from_file(info->cert);
  if(!key||!cert||!freerdp_settings_set_pointer_len(s,FreeRDP_RdpServerRsaKey,key,1)||!freerdp_settings_set_pointer_len(s,FreeRDP_RdpServerCertificate,cert,1))goto fail;
  if(!freerdp_settings_set_bool(s,FreeRDP_RdpSecurity,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_TlsSecurity,TRUE)||!freerdp_settings_set_bool(s,FreeRDP_NlaSecurity,FALSE)||!freerdp_settings_set_bool(s,FreeRDP_ExtSecurity,FALSE))goto fail;
  if(!freerdp_settings_set_uint32(s,FreeRDP_ColorDepth,32)||!freerdp_settings_set_uint32(s,FreeRDP_MultifragMaxRequestSize,0xFFFFFF))goto fail;
  // A server that does not announce the horizontal wheel makes the FreeRDP client drop such events instead of sending them (libfreerdp/core/input.c).
  if(!info->hwheel&&!freerdp_settings_set_bool(s,FreeRDP_HasHorizontalWheel,FALSE))goto fail;
  if(!freerdp_settings_set_bool(s,FreeRDP_SuppressOutput,TRUE)||!freerdp_settings_set_bool(s,FreeRDP_RefreshRect,TRUE))goto fail;
  peer->PostConnect=peerPostConnect;peer->Activate=peerActivate;
  {
    rdpInput* input=peer->context->input;
    input->MouseEvent=onMouse;input->ExtendedMouseEvent=onExtendedMouse;input->RelMouseEvent=onRelMouse;
    input->KeyboardEvent=onKeyboard;input->UnicodeKeyboardEvent=onUnicode;input->SynchronizeEvent=onSync;
  }
  if(!peer->Initialize(peer))goto fail;
  {
    auto* ctx=reinterpret_cast<PeerContext*>(peer->context);
    HANDLE handles[32];int lastState=-1;
    while(true){
      DWORD count=peer->GetEventHandles(peer,handles,30);
      if(!count)break;
      handles[count++]=WTSVirtualChannelManagerGetEventHandle(ctx->vcm);
      if(!ctx->st->resizing)handles[count++]=ctx->st->resizeEvent;   // one reactivation at a time: the client answers each demand
      const DWORD status=WaitForMultipleObjects(count,handles,FALSE,100);
      if(status==WAIT_FAILED){emit("ERROR wait failed");break;}
      if(!peer->CheckFileDescriptor(peer)){emit("ERROR peer ended: %s",freerdp_get_last_error_name(freerdp_get_last_error(peer->context)));break;}
      if(const auto end=ctx->st->endInfo.load();end>=0){   // the way a real server says why it ends a session: an error info PDU, then the disconnect
        freerdp_set_error_info(peer->context->rdp,UINT32(end));
        if(freerdp_send_error_info(peer->context->rdp))emit("ERRINFO %u",unsigned(end));else emit("ERROR error info not sent");
        break;
      }
      // drdynvc is opened "once and only once" by the first auto-open call; before the MCS channels are joined that open
      // fails silently and the dynamic channel never starts, so auto-open only after PostConnect.
      if(!WTSVirtualChannelManagerCheckFileDescriptorEx(ctx->vcm,ctx->st->connected)){emit("ERROR channel manager failed");break;}
      if(WTSVirtualChannelManagerIsChannelJoined(ctx->vcm,DRDYNVC_SVC_CHANNEL_NAME)){
        const auto state=WTSVirtualChannelManagerGetDrdynvcState(ctx->vcm);
        if(state!=lastState){lastState=state;emit("DRDYNVC %d",int(state));}
        if(state==DRDYNVC_STATE_READY)tryOpenDisplay(ctx);
      }
      if(!ctx->st->resizing&&WaitForSingleObject(ctx->st->resizeEvent,0)==WAIT_OBJECT_0){
        ResetEvent(ctx->st->resizeEvent);ctx->st->resizing=true;
        if(!freerdp_settings_set_uint32(s,FreeRDP_DesktopWidth,ctx->st->wantW)||!freerdp_settings_set_uint32(s,FreeRDP_DesktopHeight,ctx->st->wantH)||!peer->context->update->DesktopResize(peer->context))emit("ERROR resize failed");
      }
    }
    emit("DISCONNECTED");
    peer->Disconnect(peer);
  }
fail:
  freerdp_peer_context_free(peer);
  freerdp_peer_free(peer);
  return 0;
}
static BOOL peerAccepted(freerdp_listener* listener,freerdp_peer* peer){
  peer->ContextExtra=listener->info;
  HANDLE thread=CreateThread(nullptr,0,peerMain,peer,0,nullptr);
  if(!thread)return FALSE;
  CloseHandle(thread);return TRUE;
}

// stdin commands: announce <hex utf-16le incl. NUL> | announce-mixed <hex> | announce-files | clear | request-text | resize <w> <h> | end-session <error info code> [first] | quit
static void commands(){
  char line[200000];
  while(fgets(line,sizeof line,stdin)){
    std::string text(line);while(!text.empty()&&(text.back()=='\n'||text.back()=='\r'))text.pop_back();
    PeerState* st;{std::lock_guard<std::mutex> lock(currentLock);st=current;}
    if(text=="quit")break;
    if(!st){emit("ERROR no peer");continue;}
    if(text.rfind("announce ",0)==0){{std::lock_guard<std::mutex> lock(st->clipLock);st->remoteWide=unhex(text.substr(9));}announce(st,true,false);}
    else if(text.rfind("announce-mixed ",0)==0){{std::lock_guard<std::mutex> lock(st->clipLock);st->remoteWide=unhex(text.substr(15));}announce(st,true,true,true);}
    else if(text=="announce-files")announce(st,false,true);
    else if(text=="clear"){{std::lock_guard<std::mutex> lock(st->clipLock);st->remoteWide.clear();}announce(st,false,false);}
    else if(text=="request-text"){   // asks the client for its text unprompted, as a hostile server could
      std::lock_guard<std::mutex> lock(st->clipLock);
      if(st->clip){CLIPRDR_FORMAT_DATA_REQUEST req{};req.common.msgType=CB_FORMAT_DATA_REQUEST;req.requestedFormatId=CF_UNICODETEXT;if(const UINT rc=st->clip->ServerFormatDataRequest(st->clip,&req))emit("ERROR request-text %u",rc);}
    }
    else if(text.rfind("end-session ",0)==0){
      unsigned code=0;char which[16]={0};const int n=sscanf(text.c_str()+12,"%u %15s",&code,which);
      if(n>=1){PeerState* target=st;if(n==2&&!strcmp(which,"first")){std::lock_guard<std::mutex> lock(currentLock);target=connectedPeers.empty()?nullptr:connectedPeers.front();}if(target)target->endInfo=code;else emit("ERROR no peer");}
    }
    else if(text.rfind("resize ",0)==0){unsigned w=0,h=0;if(sscanf(text.c_str()+7,"%u %u",&w,&h)==2){st->wantW=w;st->wantH=h;SetEvent(st->resizeEvent);}}
    else emit("ERROR unknown command");
  }
  _exit(0);   // the controlling test is gone: never linger
}

int main(int argc,char** argv){
  ServerInfo info{nullptr,nullptr,true,0,0,true};long port=0;
  for(int i=1;i<argc;i++){
    if(!strncmp(argv[i],"--port=",7))port=strtol(argv[i]+7,nullptr,10);
    else if(!strncmp(argv[i],"--cert=",7))info.cert=argv[i]+7;
    else if(!strncmp(argv[i],"--key=",6))info.key=argv[i]+6;
    else if(!strcmp(argv[i],"--short-names"))info.longNames=false;
    else if(!strncmp(argv[i],"--caps-delay=",13))info.capsDelayMs=unsigned(strtoul(argv[i]+13,nullptr,10));
    else if(!strcmp(argv[i],"--console"))info.console=1;
    else if(!strcmp(argv[i],"--console-no-echo"))info.console=2;
    else if(!strcmp(argv[i],"--no-hwheel"))info.hwheel=false;
    else{fprintf(stderr,"usage: rdp-test-server --port=N --cert=FILE --key=FILE [--short-names] [--caps-delay=MS] [--console|--console-no-echo] [--no-hwheel]\n");return 2;}
  }
  if(port<1||port>65535||!info.cert||!info.key){fprintf(stderr,"port, cert and key are required\n");return 2;}
  WSADATA wsa{};if(WSAStartup(MAKEWORD(2,2),&wsa)!=0)return 1;
  if(!WTSRegisterWtsApiFunctionTable(FreeRDP_InitWtsApi())||!winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT))return 1;
  freerdp_listener* listener=freerdp_listener_new();if(!listener)return 1;
  listener->info=&info;listener->PeerAccepted=peerAccepted;
  if(!listener->Open(listener,"127.0.0.1",UINT16(port))){fprintf(stderr,"cannot listen on 127.0.0.1:%ld\n",port);return 1;}
  emit("READY %ld",port);
  std::thread(commands).detach();
  HANDLE handles[32];
  while(true){
    const DWORD count=listener->GetEventHandles(listener,handles,32);
    if(!count||WaitForMultipleObjects(count,handles,FALSE,INFINITE)==WAIT_FAILED||!listener->CheckFileDescriptor(listener))break;
  }
  listener->Close(listener);freerdp_listener_free(listener);WSACleanup();
  return 0;
}
