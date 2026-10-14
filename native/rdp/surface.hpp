#pragma once
#include <cstdint>
#include <vector>
#include <stdexcept>
inline void validate_surface(uint32_t w,uint32_t h,uint32_t stride) {
  if(!w||!h||w>8192||h>8192||stride<uint64_t(w)*4||uint64_t(w)*h*4+8>128ull*1024*1024)throw std::invalid_argument("surface dimensions");
}
inline std::vector<uint8_t> tightly_packed_rgba(const uint8_t* src,uint32_t w,uint32_t h,uint32_t stride) {
  if(!src)throw std::invalid_argument("missing surface");validate_surface(w,h,stride);
  std::vector<uint8_t> out(size_t(w)*h*4);
  for(uint32_t y=0;y<h;y++)for(uint32_t x=0;x<w;x++) {
    const auto s=src+size_t(y)*stride+size_t(x)*4;auto d=out.data()+(size_t(y)*w+x)*4;
    d[0]=s[2];d[1]=s[1];d[2]=s[0];d[3]=255;
  }
  return out;
}
