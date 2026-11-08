#pragma once
#include "json.hpp"
#include "clipboard.hpp"
#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>
using json=nlohmann::json;
inline int bounded_integer(const json& v,const char* key,int min,int max) {
  const auto& x=v.at(key);if(!x.is_number_integer())throw std::invalid_argument("integer");
  auto n=x.get<int64_t>();if(n<min||n>max)throw std::invalid_argument("range");return int(n);
}
// The mouse wheel on the wire is one signed count of 1/120 notches (WHEEL_DELTA); src/protocols/rdp/wire.ts WHEEL_LIMIT is the same limit. The horizontal
// wheel is the same turn under its own control type ("hwheel", positive = to the right as WM_MOUSEHWHEEL): an older helper refuses it instead of scrolling the wrong way.
constexpr int WHEEL_MAX_DELTA=4800;
inline json validate_control(const json& v){
  if(!v.is_object())throw std::invalid_argument("object");const auto type=v.at("type").get<std::string>();
  if(type=="close")return {{"type",type}};
  if(type=="key"){bounded_integer(v,"scanCode",1,511);if(!v.at("down").is_boolean())throw std::invalid_argument("boolean");}
  else if(type=="pointer"){bounded_integer(v,"x",0,8191);bounded_integer(v,"y",0,8191);bounded_integer(v,"buttons",0,7);}
  else if(type=="wheel"||type=="hwheel"){bounded_integer(v,"x",0,8191);bounded_integer(v,"y",0,8191);if(bounded_integer(v,"delta",-WHEEL_MAX_DELTA,WHEEL_MAX_DELTA)==0)throw std::invalid_argument("range");}
  else if(type=="resize"){bounded_integer(v,"width",200,8192);bounded_integer(v,"height",200,8192);}
  else if(type=="clipboard"){const auto& b=v.at("b64");if(!b.is_string()||b.get_ref<const std::string&>().size()>(CLIPBOARD_MAX_BYTES+2)/3*4)throw std::invalid_argument("clipboard");}
  else throw std::invalid_argument("type");return v;
}
inline bool fingerprint_matches(const std::string& observed,const std::string& expected){
  auto normalize=[](const std::string& in){std::string out;for(unsigned char c:in){if(c==':')continue;if(!std::isxdigit(c))return std::string();out+=char(std::tolower(c));}return out;};
  const auto a=normalize(observed),b=normalize(expected);if(a.size()!=64||b.size()!=64)return false;
  unsigned char mismatch=0;for(size_t i=0;i<64;i++)mismatch|=a[i]^b[i];return mismatch==0;
}
struct Point{uint16_t x,y;};
// A pointer event can race a desktop resize; it is clamped into the current desktop instead of failing the session.
inline Point clamp_pointer(uint32_t x,uint32_t y,uint32_t width,uint32_t height){
  return {uint16_t(std::min(x,width?width-1:0u)),uint16_t(std::min(y,height?height-1:0u))};
}
// RDP carries a wheel turn as the wheel flag (0x0200; the horizontal wheel 0x0400) plus a 9-bit two's complement count of at most 255 units per event
// (MS-RDPBCGR 2.2.8.1.1.3.1.1.3), so a larger turn goes out as several events; bridge.cpp static_asserts the flag values against the FreeRDP headers.
inline std::vector<int> wheel_steps(int delta){
  std::vector<int> out;
  for(int rest=delta;rest!=0;){const int step=std::clamp(rest,-255,255);out.push_back(step);rest-=step;}
  return out;
}
inline uint16_t wheel_flags(int step,bool horizontal=false){return uint16_t((horizontal?0x0400u:0x0200u)|(unsigned(step)&0x01FFu));}
// Display control wants an even width inside 200..8192; the desktop must also fit in one frame (see surface.hpp).
inline std::pair<uint32_t,uint32_t> display_size(uint32_t width,uint32_t height){
  width=std::clamp(width,200u,8192u);height=std::clamp(height,200u,8192u);
  constexpr uint64_t maxArea=(128ull*1024*1024-8)/4;
  if(uint64_t(width)*height>maxArea){const double k=std::sqrt(double(maxArea)/(double(width)*height));width=uint32_t(width*k);height=uint32_t(height*k);}
  width-=width%2;return {width,height};
}
inline bool fits_monitor_area(uint32_t width,uint32_t height,uint32_t factorA,uint32_t factorB){return uint64_t(width)*height<=uint64_t(factorA)*factorB;}
// Why a failed connect is reported, in the categories the UI knows. A refused logon under NLA reaches us as LOGON_FAILURE (or one of its
// account siblings), not as AUTHENTICATION_FAILED, so all of those are "authentication". The numbers are FreeRDP's ERRCONNECT_* codes in the
// connect class (0x0002xxxx); bridge.cpp static_asserts them against the FreeRDP headers.
inline const char* failure_reason(bool certificateRejected,uint32_t lastError){
  if(certificateRejected)return "certificate";
  if((lastError&0xFFFF0000u)!=0x00020000u)return "connection";
  switch(lastError&0xFFFFu){
    case 0x09:case 0x0A:                              // authentication failed, insufficient privileges
    case 0x0E:case 0x0F:case 0x13:                    // password expired, certainly expired, must change
    case 0x12:case 0x17:case 0x18:case 0x19:          // account disabled, restricted, locked out, expired
    case 0x14:case 0x15:case 0x16:                    // logon failure, wrong password, access denied
    case 0x1A:case 0x1B:return "authentication";      // logon type not granted, no or missing credentials
    default:return "connection";
  }
}
// Why a server ended a session: the category of its error info code (MS-RDPBCGR 2.2.5.1.1) in the words the UI has, and "server-closed" for
// no code or one without a category. The numbers are FreeRDP's ERRINFO_* values; bridge.cpp static_asserts them against the FreeRDP headers.
inline const char* disconnect_reason(uint32_t errorInfo){
  switch(errorInfo){
    case 0x5:return "other-connection";                 // another connection of the same account took the session over
    case 0x2:case 0xC:return "logoff";                  // logged off by an administrative tool, or by the user on the server
    case 0x1:case 0xB:return "admin-disconnect";        // disconnected on the server by an administrative tool or a user
    case 0x3:case 0x4:return "timeout";                 // the idle or the logon time limit
    case 0x7:case 0x9:case 0xA:return "server-denied";  // the server refused the session, lacks privileges, or wants fresh credentials
    default:return "server-closed";
  }
}
struct Options{uint32_t width=1280,height=720;bool toRemote=false,fromRemote=false;};
// Optional connect settings. Everything defaults to off; unknown clipboard keys are refused so file redirection cannot slip in.
inline Options parse_options(const json& target){
  Options o;
  if(target.contains("width")||target.contains("height")){o.width=bounded_integer(target,"width",200,4096);o.height=bounded_integer(target,"height",200,2048);}
  if(target.contains("clipboard")){
    const auto& c=target.at("clipboard");
    if(!c.is_object()||c.size()!=2||!c.contains("toRemote")||!c.contains("fromRemote")||!c.at("toRemote").is_boolean()||!c.at("fromRemote").is_boolean())throw std::invalid_argument("clipboard");
    o.toRemote=c.at("toRemote").get<bool>();o.fromRemote=c.at("fromRemote").get<bool>();
  }
  return o;
}

inline int connection_exit_code(bool connected,bool connectionFailure,bool requested,bool inputFailure){return !connected||inputFailure||(connectionFailure&&!requested)?1:0;}
