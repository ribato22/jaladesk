#undef NDEBUG
#include <cassert>
#include "control.hpp"
static bool rejects(const json& c){try{validate_control(c);}catch(...){return true;}return false;}
static bool rejects_options(const json& target){try{parse_options(target);}catch(...){return true;}return false;}
int main(){
  auto k=validate_control(json{{"type","key"},{"scanCode",30},{"down",true}});assert(k.at("scanCode")==30);
  for(auto c:std::vector<json>{json{{"type","key"},{"scanCode",30.5},{"down",true}},json{{"type","pointer"},{"x",-1},{"y",0},{"buttons",0}},json{{"type","resize"},{"width",0},{"height",1}},json{{"type","unknown"}}}){
    bool rejected=false;try{validate_control(c);}catch(...){rejected=true;}assert(rejected);
  }
  assert(fingerprint_matches("aa:bb", "aabb")==false);
  assert(fingerprint_matches(std::string(64,'a'),std::string(64,'a')));
  assert(!fingerprint_matches(std::string(64,'a'),std::string(64,'b')));

  // resize stays inside the display-control bounds; clipboard carries exactly one base64 string within the wire limit
  validate_control(json{{"type","resize"},{"width",200},{"height",8192}});
  validate_control(json{{"type","clipboard"},{"b64",""}});validate_control(json{{"type","clipboard"},{"b64","Zm9v"}});
  assert(rejects(json{{"type","resize"},{"width",199},{"height",720}})&&rejects(json{{"type","resize"},{"width",1280},{"height",8193}}));
  assert(rejects(json{{"type","clipboard"}})&&rejects(json{{"type","clipboard"},{"b64",7}}));
  assert(rejects(json{{"type","clipboard"},{"b64",std::string(CLIPBOARD_MAX_BYTES/3*4+8,'A')}}));

  // a pointer that races a desktop resize is clamped into the new desktop instead of ending the session
  auto p=clamp_pointer(1270,700,1000,600);assert(p.x==999&&p.y==599);
  p=clamp_pointer(10,20,1000,600);assert(p.x==10&&p.y==20);
  p=clamp_pointer(5,5,0,0);assert(p.x==0&&p.y==0);

  // the mouse wheel: a position and ONE signed count of 1/120 notches (never zero, never beyond the limit), refused if anything else
  validate_control(json{{"type","wheel"},{"x",10},{"y",20},{"delta",-120}});
  validate_control(json{{"type","wheel"},{"x",8191},{"y",0},{"delta",WHEEL_MAX_DELTA}});
  validate_control(json{{"type","wheel"},{"x",0},{"y",8191},{"delta",-WHEEL_MAX_DELTA}});
  assert(WHEEL_MAX_DELTA==4800);   // src/protocols/rdp/wire.ts WHEEL_LIMIT: both sides must agree
  for(auto c:std::vector<json>{json{{"type","wheel"},{"x",10},{"y",20},{"delta",0}},json{{"type","wheel"},{"x",10},{"y",20},{"delta",WHEEL_MAX_DELTA+1}},
      json{{"type","wheel"},{"x",10},{"y",20},{"delta",-WHEEL_MAX_DELTA-1}},json{{"type","wheel"},{"x",10},{"y",20},{"delta",1.5}},json{{"type","wheel"},{"x",10},{"y",20},{"delta","120"}},
      json{{"type","wheel"},{"x",10},{"y",20}},json{{"type","wheel"},{"x",-1},{"y",20},{"delta",120}},json{{"type","wheel"},{"x",8192},{"y",20},{"delta",120}},
      json{{"type","wheel"},{"x",10},{"y",-1},{"delta",120}},json{{"type","wheel"},{"x",10},{"y",8192},{"delta",120}},json{{"type","wheel"},{"y",20},{"delta",120}}})
    assert(rejects(c));
  // RDP carries at most 255 units per wheel event, as a 9-bit two's complement count under the wheel flag (0x200)
  assert(wheel_steps(0).empty());
  assert((wheel_steps(120)==std::vector<int>{120})&&(wheel_steps(-120)==std::vector<int>{-120}));
  assert((wheel_steps(255)==std::vector<int>{255})&&(wheel_steps(-255)==std::vector<int>{-255}));
  assert((wheel_steps(256)==std::vector<int>{255,1})&&(wheel_steps(-300)==std::vector<int>{-255,-45})&&(wheel_steps(600)==std::vector<int>{255,255,90}));
  for(int d=-WHEEL_MAX_DELTA;d<=WHEEL_MAX_DELTA;d++){   // every wheel count is delivered whole, in steps the protocol can express
    int sum=0;for(const int step:wheel_steps(d)){assert(step!=0&&step>=-255&&step<=255);sum+=step;}assert(sum==d);
  }
  assert(wheel_flags(120)==0x0278&&wheel_flags(-120)==0x0388);   // the values FreeRDP's own clients send for one notch
  assert(wheel_flags(1)==0x0201&&wheel_flags(-1)==0x03FF&&wheel_flags(255)==0x02FF&&wheel_flags(-255)==0x0301);
  for(int step=-255;step<=255;step++)if(step){const auto f=wheel_flags(step);assert((f&0x0200)&&(step<0)==bool(f&0x0100));}

  // the horizontal wheel is the same turn under its own type (positive = right, as WM_MOUSEHWHEEL): same position, same limits, same refusals
  validate_control(json{{"type","hwheel"},{"x",10},{"y",20},{"delta",-120}});
  validate_control(json{{"type","hwheel"},{"x",8191},{"y",0},{"delta",WHEEL_MAX_DELTA}});
  validate_control(json{{"type","hwheel"},{"x",0},{"y",8191},{"delta",-WHEEL_MAX_DELTA}});
  for(auto c:std::vector<json>{json{{"type","hwheel"},{"x",10},{"y",20},{"delta",0}},json{{"type","hwheel"},{"x",10},{"y",20},{"delta",WHEEL_MAX_DELTA+1}},
      json{{"type","hwheel"},{"x",10},{"y",20},{"delta",-WHEEL_MAX_DELTA-1}},json{{"type","hwheel"},{"x",10},{"y",20},{"delta",1.5}},json{{"type","hwheel"},{"x",10},{"y",20},{"delta","120"}},
      json{{"type","hwheel"},{"x",10},{"y",20}},json{{"type","hwheel"},{"x",-1},{"y",20},{"delta",120}},json{{"type","hwheel"},{"x",8192},{"y",20},{"delta",120}},
      json{{"type","hwheel"},{"x",10},{"y",-1},{"delta",120}},json{{"type","hwheel"},{"x",10},{"y",8192},{"delta",120}},json{{"type","hwheel"},{"y",20},{"delta",120}},
      json{{"type","xwheel"},{"x",10},{"y",20},{"delta",120}},json{{"type","wheel2"},{"x",10},{"y",20},{"delta",120}},json{{"type","vwheel"},{"x",10},{"y",20},{"delta",120}}})
    assert(rejects(c));
  // RDP carries it as the horizontal wheel flag (0x400) plus the same 9-bit two's complement count (MS-RDPBCGR 2.2.8.1.1.3.1.1.3); FreeRDP's own Windows client sends
  // 0x400 | WM_MOUSEHWHEEL's delta the same way, so 0x478 is one notch to the right and 0x588 one notch to the left
  assert(wheel_flags(120,true)==0x0478&&wheel_flags(-120,true)==0x0588);
  assert(wheel_flags(1,true)==0x0401&&wheel_flags(-1,true)==0x05FF&&wheel_flags(255,true)==0x04FF&&wheel_flags(-255,true)==0x0501);
  for(int step=-255;step<=255;step++)if(step){
    const auto h=wheel_flags(step,true),v=wheel_flags(step,false);
    assert((h&0x0400)&&!(h&0x0200)&&(step<0)==bool(h&0x0100));       // a horizontal event never carries the vertical flag
    assert(v==wheel_flags(step)&&(v&0x0200)&&!(v&0x0400));            // the vertical default is unchanged
    assert((h&0x01FF)==(v&0x01FF));                                   // the count is the same either way
  }

  // resize requests are normalised the way display control needs them, and checked against the server's area limit
  auto s=display_size(1001,601);assert(s.first==1000&&s.second==601);
  s=display_size(50,50);assert(s.first==200&&s.second==200);
  s=display_size(9000,9000);assert(s.first==5792&&s.second==5792);                       // scaled down to the frame budget
  for(auto big:std::vector<std::pair<uint32_t,uint32_t>>{{8192,8192},{8192,4096},{7680,4320},{8000,5000}}){
    s=display_size(big.first,big.second);assert(uint64_t(s.first)*s.second*4+8<=128ull*1024*1024&&s.first%2==0&&s.first>=200&&s.second>=200);
  }
  s=display_size(5120,2880);assert(s.first==5120&&s.second==2880);
  assert(fits_monitor_area(1920,1080,8192,8192)&&fits_monitor_area(8192,8192,8192,8192)&&!fits_monitor_area(8192,8192,4096,4096)&&!fits_monitor_area(1,1,0,0));

  // connect options: defaults keep every optional channel off
  auto o=parse_options(json::object());assert(o.width==1280&&o.height==720&&!o.toRemote&&!o.fromRemote);
  o=parse_options(json{{"width",1024},{"height",768},{"clipboard",{{"toRemote",true},{"fromRemote",false}}}});
  assert(o.width==1024&&o.height==768&&o.toRemote&&!o.fromRemote);
  for(auto t:std::vector<json>{json{{"width",1024}},json{{"height",768}},json{{"width",199},{"height",768}},json{{"width",4097},{"height",768}},json{{"width",1024},{"height",2049}},json{{"width",1024.5},{"height",768}},
      json{{"clipboard",true}},json{{"clipboard",{{"toRemote","yes"},{"fromRemote",false}}}},json{{"clipboard",{{"toRemote",true}}}},json{{"clipboard",{{"toRemote",true},{"fromRemote",false},{"files",true}}}}})
    assert(rejects_options(t));

  // why a connect failed: a rejected certificate wins; a refused logon under NLA is LOGON_FAILURE (not AUTHENTICATION_FAILED) and its
  // account siblings, all "authentication"; everything else, including other classes of error, stays "connection"
  assert(std::string(failure_reason(true,0x00020014))=="certificate");
  assert(std::string(failure_reason(true,0))=="certificate");
  for(uint32_t code:{0x00020009u,0x0002000Au,0x0002000Eu,0x0002000Fu,0x00020012u,0x00020013u,0x00020014u,0x00020015u,0x00020016u,0x00020017u,0x00020018u,0x00020019u,0x0002001Au,0x0002001Bu})
    assert(std::string(failure_reason(false,code))=="authentication");
  for(uint32_t code:{0u,0x00020006u,0x00020008u,0x0002000Bu,0x0002000Du,0x0002001Cu,0x00010014u,0x00000014u,0x00030014u,0xFFFFFFFFu})
    assert(std::string(failure_reason(false,code))=="connection");

  // why a server ended a session (its error info PDU, MS-RDPBCGR 2.2.5.1.1): the categories the UI has words for, and a plain "server closed"
  // for no code or one that has no category
  auto reason=[](uint32_t code){return std::string(disconnect_reason(code));};
  assert(reason(0x5)=="other-connection");
  assert(reason(0x2)=="logoff"&&reason(0xC)=="logoff");
  assert(reason(0x1)=="admin-disconnect"&&reason(0xB)=="admin-disconnect");
  assert(reason(0x3)=="timeout"&&reason(0x4)=="timeout");
  assert(reason(0x7)=="server-denied"&&reason(0x9)=="server-denied"&&reason(0xA)=="server-denied");
  for(uint32_t code:{0u,0x6u,0x8u,0xFu,0x10u,0x1000u,0x00020014u,0xFFFFFFFFu})assert(reason(code)=="server-closed");

  // An event check aborted by an owned close is successful; setup and input failures remain failures.
  assert(connection_exit_code(true,true,true,false)==0);
  assert(connection_exit_code(true,false,true,false)==0);
  assert(connection_exit_code(true,false,false,false)==0);
  assert(connection_exit_code(true,true,false,false)==1);
  assert(connection_exit_code(false,true,true,false)==1);
  assert(connection_exit_code(false,true,false,false)==1);
  assert(connection_exit_code(true,true,true,true)==1);
  assert(connection_exit_code(true,false,true,true)==1);
}
