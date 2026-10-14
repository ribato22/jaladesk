#undef NDEBUG
#include <cassert>
#include "control.hpp"
int main(){
  auto k=validate_control(json{{"type","key"},{"scanCode",30},{"down",true}});assert(k.at("scanCode")==30);
  for(auto c:std::vector<json>{json{{"type","key"},{"scanCode",30.5},{"down",true}},json{{"type","pointer"},{"x",-1},{"y",0},{"buttons",0}},json{{"type","resize"},{"width",0},{"height",1}},json{{"type","unknown"}}}){
    bool rejected=false;try{validate_control(c);}catch(...){rejected=true;}assert(rejected);
  }
  assert(fingerprint_matches("aa:bb", "aabb")==false);
  assert(fingerprint_matches(std::string(64,'a'),std::string(64,'a')));
  assert(!fingerprint_matches(std::string(64,'a'),std::string(64,'b')));
}
