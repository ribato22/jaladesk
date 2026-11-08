#undef NDEBUG
#include <cassert>
#include <csignal>
#include <cstdio>
#include <functional>
#include <string>
#include <thread>
#include <vector>
#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif
#include "channels.hpp"

// ---- display control ----
static std::vector<DISPLAY_CONTROL_MONITOR_LAYOUT> sent;
static UINT send_rc=CHANNEL_RC_OK;
static UINT fake_layout(DispClientContext*,UINT32 count,DISPLAY_CONTROL_MONITOR_LAYOUT* monitors){
  for(UINT32 i=0;i<count;i++)sent.push_back(monitors[i]);return send_rc;
}
static void display_tests(){
  DispClientContext ctx{};ctx.SendMonitorLayout=fake_layout;DisplayChannel d;d.attach(&ctx);d.note_desktop(1280,720);
  // not ready yet: only the latest wish is remembered, nothing goes on the wire
  assert(d.request(1500,900)&&d.request(1920,1080)&&sent.empty());
  assert(ctx.DisplayControlCaps(&ctx,1,8192,8192)==CHANNEL_RC_OK&&sent.size()==1);
  assert(sent[0].Width==1920&&sent[0].Height==1080&&sent[0].Flags==DISPLAY_CONTROL_MONITOR_PRIMARY&&sent[0].Left==0&&sent[0].Top==0);
  assert(sent[0].PhysicalWidth==0&&sent[0].PhysicalHeight==0&&sent[0].Orientation==0&&sent[0].DesktopScaleFactor==100&&sent[0].DeviceScaleFactor==100);
  assert(d.request(1920,1080)&&sent.size()==1);                                   // already asked for
  assert(d.request(1001,601)&&sent.size()==2&&sent[1].Width==1000&&sent[1].Height==601);   // width made even
  assert(d.request(1920,1080)&&sent.size()==3);                                   // changing back while a request is in flight is still sent
  d.note_desktop(1920,1080);
  assert(d.request(1920,1080)&&sent.size()==3);                                   // already the real desktop
  send_rc=ERROR_INTERNAL_ERROR;assert(!d.request(1280,720));send_rc=CHANNEL_RC_OK;  // a failing channel is reported
  d.detach();assert(ctx.custom==nullptr&&ctx.DisplayControlCaps==nullptr&&d.request(800,600));   // detached: no crash, nothing sent
  assert(sent.size()==4);

  // a request that returns to the real size before the channel is ready cancels the pending change
  sent.clear();DispClientContext early{};early.SendMonitorLayout=fake_layout;DisplayChannel e;e.attach(&early);e.note_desktop(1280,720);
  assert(e.request(1920,1080)&&e.request(1280,720)&&early.DisplayControlCaps(&early,1,8192,8192)==CHANNEL_RC_OK&&sent.empty());

  // the server's monitor area limit is respected locally
  DispClientContext small{};small.SendMonitorLayout=fake_layout;DisplayChannel s;s.attach(&small);s.note_desktop(1280,720);
  assert(small.DisplayControlCaps(&small,1,4096,4096)==CHANNEL_RC_OK&&s.request(8192,8192)&&sent.empty());
  assert(s.request(4096,4096)&&sent.size()==1);
}

// ---- clipboard ----
struct Log{
  std::vector<std::string> calls;std::vector<uint32_t> formats;UINT32 caps_flags=0;UINT32 requested=0;UINT16 response_flags=0;std::vector<uint8_t> response;
  void reset(){calls.clear();formats.clear();caps_flags=0;requested=0;response_flags=0;response.clear();}
} log_;
static UINT f_caps(CliprdrClientContext*,const CLIPRDR_CAPABILITIES* c){
  log_.calls.push_back("caps");log_.caps_flags=reinterpret_cast<const CLIPRDR_GENERAL_CAPABILITY_SET*>(c->capabilitySets)->generalFlags;return CHANNEL_RC_OK;
}
static UINT f_list(CliprdrClientContext*,const CLIPRDR_FORMAT_LIST* l){
  log_.calls.push_back("list");log_.formats.clear();for(UINT32 i=0;i<l->numFormats;i++)log_.formats.push_back(l->formats[i].formatId);return CHANNEL_RC_OK;
}
static UINT f_list_response(CliprdrClientContext*,const CLIPRDR_FORMAT_LIST_RESPONSE* r){log_.calls.push_back(r->common.msgFlags==CB_RESPONSE_OK?"list-ok":"list-fail");return CHANNEL_RC_OK;}
static UINT f_request(CliprdrClientContext*,const CLIPRDR_FORMAT_DATA_REQUEST* r){log_.calls.push_back("request");log_.requested=r->requestedFormatId;return CHANNEL_RC_OK;}
static UINT f_response(CliprdrClientContext*,const CLIPRDR_FORMAT_DATA_RESPONSE* r){
  log_.calls.push_back("response");log_.response_flags=r->common.msgFlags;log_.response.assign(r->requestedFormatData,r->requestedFormatData+r->common.dataLen);return CHANNEL_RC_OK;
}
static CliprdrClientContext fake(){
  CliprdrClientContext c{};c.ClientCapabilities=f_caps;c.ClientFormatList=f_list;c.ClientFormatListResponse=f_list_response;c.ClientFormatDataRequest=f_request;c.ClientFormatDataResponse=f_response;return c;
}
static std::vector<uint8_t> wide(const std::string& ascii){
  std::vector<uint8_t> out;for(char ch:ascii){out.push_back(uint8_t(ch));out.push_back(0);}out.push_back(0);out.push_back(0);return out;
}
static UINT server_list(CliprdrClientContext& ctx,std::vector<UINT32> ids){
  std::vector<CLIPRDR_FORMAT> formats;for(auto id:ids){CLIPRDR_FORMAT f{};f.formatId=id;formats.push_back(f);}
  CLIPRDR_FORMAT_LIST list{};list.common.msgType=CB_FORMAT_LIST;list.numFormats=UINT32(formats.size());list.formats=formats.data();
  return ctx.ServerFormatList(&ctx,&list);
}
static UINT server_response(CliprdrClientContext& ctx,const std::vector<uint8_t>& data,UINT16 flags=CB_RESPONSE_OK){
  CLIPRDR_FORMAT_DATA_RESPONSE r{};r.common.msgType=CB_FORMAT_DATA_RESPONSE;r.common.msgFlags=flags;r.common.dataLen=UINT32(data.size());r.requestedFormatData=data.data();
  return ctx.ServerFormatDataResponse(&ctx,&r);
}
static UINT server_request(CliprdrClientContext& ctx,UINT32 id){
  CLIPRDR_FORMAT_DATA_REQUEST r{};r.common.msgType=CB_FORMAT_DATA_REQUEST;r.requestedFormatId=id;return ctx.ServerFormatDataRequest(&ctx,&r);
}
static UINT monitor_ready(CliprdrClientContext& ctx){CLIPRDR_MONITOR_READY m{};m.common.msgType=CB_MONITOR_READY;return ctx.MonitorReady(&ctx,&m);}
using Calls=std::vector<std::string>;

static void remote_to_local_tests(){
  std::vector<std::string> texts;auto ctx=fake();ClipboardChannel c(false,true,[&](const std::string& t){texts.push_back(t);});c.attach(&ctx);log_.reset();
  assert(monitor_ready(ctx)==CHANNEL_RC_OK&&log_.calls==Calls({"caps","list"})&&log_.formats.empty());
  assert((log_.caps_flags&CB_USE_LONG_FORMAT_NAMES)&&!(log_.caps_flags&(CB_STREAM_FILECLIP_ENABLED|CB_FILECLIP_NO_FILE_PATHS|CB_CAN_LOCK_CLIPDATA|CB_HUGE_FILE_SUPPORT_ENABLED)));   // text only: no file or lock capabilities
  log_.reset();assert(server_list(ctx,{1,CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&log_.calls==Calls({"list-ok","request"})&&log_.requested==CF_UNICODETEXT_FORMAT);
  assert(server_response(ctx,wide("halo\r\nbaris"))==CHANNEL_RC_OK&&texts==std::vector<std::string>({"halo\nbaris"}));
  assert(server_response(ctx,wide("tak diminta"))==CHANNEL_RC_OK&&texts.size()==1);                       // unsolicited data is dropped
  log_.reset();assert(server_list(ctx,{15})==CHANNEL_RC_OK&&log_.calls==Calls({"list-ok"}));              // no text on offer: acknowledged, nothing requested
  assert(server_list(ctx,{})==CHANNEL_RC_OK&&log_.calls==Calls({"list-ok","list-ok"}));
  // bad answers never reach the sink and never end the session
  assert(server_list(ctx,{CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&server_response(ctx,wide("gagal"),CB_RESPONSE_FAIL)==CHANNEL_RC_OK);
  assert(server_list(ctx,{CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&server_response(ctx,{'a',0,'b'})==CHANNEL_RC_OK);
  assert(server_list(ctx,{CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&server_response(ctx,std::vector<uint8_t>(CLIPBOARD_MAX_WIRE+2,'a'))==CHANNEL_RC_OK);
  assert(server_list(ctx,{CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&server_response(ctx,{0x3d,0xd8})==CHANNEL_RC_OK);   // a lone high surrogate
  assert(texts.size()==1);
  // the other direction is off: no offer is accepted and a paste request is never answered by us
  assert(!c.offer("rahasia")&&c.offered_bytes()==0);
  log_.reset();assert(server_request(ctx,CF_UNICODETEXT_FORMAT)==CHANNEL_RC_OK&&log_.calls.empty());   // FreeRDP refuses it before our callback; answering here would trip its mask assert
  // a flood of announcements cannot queue unlimited requests
  log_.reset();for(int i=0;i<20;i++)(void)server_list(ctx,{CF_UNICODETEXT_FORMAT});
  size_t requests=0;for(auto& call:log_.calls)requests+=call=="request";assert(requests<=8);
}
static void local_to_remote_tests(){
  std::vector<std::string> texts;auto ctx=fake();ClipboardChannel c(true,false,[&](const std::string& t){texts.push_back(t);});c.attach(&ctx);log_.reset();
  assert(c.offer("sebelum siap")&&log_.calls.empty());                                                     // remembered until the monitor is ready
  assert(monitor_ready(ctx)==CHANNEL_RC_OK&&log_.calls==Calls({"caps","list"})&&log_.formats==std::vector<uint32_t>({CF_UNICODETEXT_FORMAT}));
  log_.reset();assert(c.offer("baris satu\nbaris dua")&&log_.calls==Calls({"list"})&&log_.formats==std::vector<uint32_t>({CF_UNICODETEXT_FORMAT}));
  log_.reset();assert(server_request(ctx,CF_UNICODETEXT_FORMAT)==CHANNEL_RC_OK&&log_.calls==Calls({"response"})&&log_.response_flags==CB_RESPONSE_OK);
  assert(log_.response==wide("baris satu\r\nbaris dua"));
  log_.reset();assert(server_request(ctx,1)==CHANNEL_RC_OK&&log_.response_flags==CB_RESPONSE_FAIL&&log_.response.empty());   // only Unicode text is served
  log_.reset();assert(server_list(ctx,{CF_UNICODETEXT_FORMAT})==CHANNEL_RC_OK&&log_.calls==Calls({"list-ok"})&&texts.empty());   // remote text is not requested
  assert(!c.offer(std::string(CLIPBOARD_MAX_BYTES+1,'a'))&&c.offered_bytes()==0);                          // refusing clears the previous offer
  log_.reset();assert(server_request(ctx,CF_UNICODETEXT_FORMAT)==CHANNEL_RC_OK&&log_.response_flags==CB_RESPONSE_FAIL);
  assert(!c.offer(std::string("a\0b",3))&&!c.offer(""));
  assert(c.offer("terakhir")&&c.offered_bytes()>0);
  c.detach();assert(c.offered_bytes()==0&&ctx.MonitorReady==nullptr&&ctx.ServerFormatList==nullptr&&ctx.ServerFormatDataRequest==nullptr&&ctx.ServerFormatDataResponse==nullptr&&ctx.custom==nullptr);
  assert(c.offer("sesudah putus"));c.detach();assert(c.offered_bytes()==0);                                   // detached: no crash, and a late offer is wiped again
}
static void display_edge_tests(){
  // a server announcing no monitors at all is treated as "no display control": requests stay queued, nothing is sent
  sent.clear();DispClientContext none{};none.SendMonitorLayout=fake_layout;DisplayChannel z;z.attach(&none);z.note_desktop(1280,720);
  assert(none.DisplayControlCaps(&none,0,8192,8192)==CHANNEL_RC_OK&&z.request(1920,1080)&&sent.empty());
}
// FreeRDP is told to run every channel callback on the thread that drives the connection (bridge.cpp). If that ever
// stops being true, any access from another thread stops the helper instead of racing the state. POSIX only: the check
// forks a child that touches the object from a second thread and expects SIGABRT.
#ifndef _WIN32
static bool aborts_on_other_thread(const std::function<void()>& body){
  std::fflush(nullptr);const pid_t pid=fork();
  if(pid==0){std::thread t(body);t.join();_exit(0);}
  int st=0;waitpid(pid,&st,0);return WIFSIGNALED(st)&&WTERMSIG(st)==SIGABRT;
}
#endif
static void thread_affinity_tests(){
  sent.clear();DispClientContext disp{};disp.SendMonitorLayout=fake_layout;DisplayChannel d;d.attach(&disp);d.note_desktop(1280,720);
  auto ctx=fake();ClipboardChannel c(true,true,[](const std::string&){});c.attach(&ctx);log_.reset();
  assert(disp.DisplayControlCaps(&disp,1,8192,8192)==CHANNEL_RC_OK&&d.request(1920,1080)&&sent.size()==1);   // the owning thread works
  assert(monitor_ready(ctx)==CHANNEL_RC_OK&&c.offer("x"));
#ifndef _WIN32
  assert(aborts_on_other_thread([&]{(void)d.request(800,600);}));
  assert(aborts_on_other_thread([&]{d.note_desktop(800,600);}));
  assert(aborts_on_other_thread([&]{d.detach();}));
  assert(aborts_on_other_thread([&]{(void)disp.DisplayControlCaps(&disp,1,8192,8192);}));
  assert(aborts_on_other_thread([&]{(void)c.offer("y");}));
  assert(aborts_on_other_thread([&]{c.detach();}));
  assert(aborts_on_other_thread([&]{(void)monitor_ready(ctx);}));
  assert(aborts_on_other_thread([&]{(void)server_list(ctx,{CF_UNICODETEXT_FORMAT});}));
  assert(aborts_on_other_thread([&]{(void)server_request(ctx,CF_UNICODETEXT_FORMAT);}));
  assert(aborts_on_other_thread([&]{(void)server_response(ctx,wide("x"));}));
#endif
}
int main(){display_tests();display_edge_tests();remote_to_local_tests();local_to_remote_tests();thread_affinity_tests();}
