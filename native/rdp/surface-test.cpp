#undef NDEBUG
#include <cassert>
#include <stdexcept>
#include "surface.hpp"
int main() {
  const uint8_t bgra[]={0,0,255,255,0,255,0,255,99,99,99,99};
  assert((tightly_packed_rgba(bgra,2,1,12)==std::vector<uint8_t>{255,0,0,255,0,255,0,255}));
  for(auto c:std::vector<std::vector<uint32_t>>{{0,1,4},{8193,1,32772},{2,1,4},{8192,8192,32768}}){
    bool rejected=false;try{tightly_packed_rgba(bgra,c[0],c[1],c[2]);}catch(const std::exception&){rejected=true;}assert(rejected);
  }
  bool rejected=false;try{tightly_packed_rgba(nullptr,1,1,4);}catch(const std::exception&){rejected=true;}assert(rejected);
}
