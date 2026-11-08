#pragma once
// Text-only clipboard codecs. No FreeRDP dependency, so the unit test builds without the engine.
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

constexpr size_t CLIPBOARD_MAX_BYTES=32*1024;   // UTF-8 bytes per direction; the TypeScript side enforces the same value
constexpr size_t CLIPBOARD_MAX_WIRE=256*1024;   // longest CF_UNICODETEXT payload that is even inspected
constexpr uint32_t CF_UNICODETEXT_FORMAT=13;

inline std::string base64_encode(const std::string& in){
  static const char* table="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;out.reserve((in.size()+2)/3*4);
  for(size_t i=0;i<in.size();i+=3){
    const uint32_t a=uint8_t(in[i]),b=i+1<in.size()?uint8_t(in[i+1]):0,c=i+2<in.size()?uint8_t(in[i+2]):0,n=(a<<16)|(b<<8)|c;
    out+=table[n>>18];out+=table[(n>>12)&63];out+=i+1<in.size()?table[(n>>6)&63]:'=';out+=i+2<in.size()?table[n&63]:'=';
  }
  return out;
}
inline int base64_value(char c){
  if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;
  return c=='+'?62:c=='/'?63:-1;
}
// Canonical padded base64 only: anything the encoder would not have produced is rejected.
inline std::optional<std::string> base64_decode(const std::string& in){
  if(in.size()%4||in.size()>(CLIPBOARD_MAX_BYTES+2)/3*4)return std::nullopt;
  std::string out;out.reserve(in.size()/4*3);
  for(size_t i=0;i<in.size();i+=4){
    const int a=base64_value(in[i]),b=base64_value(in[i+1]);if(a<0||b<0)return std::nullopt;
    const bool last=i+4==in.size();
    if(in[i+2]=='='){
      if(!last||in[i+3]!='='||(b&15))return std::nullopt;
      out+=char((a<<2)|(b>>4));
    }else{
      const int c=base64_value(in[i+2]);if(c<0)return std::nullopt;
      if(in[i+3]=='='){
        if(!last||(c&3))return std::nullopt;
        out+=char((a<<2)|(b>>4));out+=char(((b&15)<<4)|(c>>2));
      }else{
        const int d=base64_value(in[i+3]);if(d<0)return std::nullopt;
        out+=char((a<<2)|(b>>4));out+=char(((b&15)<<4)|(c>>2));out+=char(((c&3)<<6)|d);
      }
    }
  }
  return out;
}
inline void append_utf8(std::string& out,uint32_t cp){
  if(cp<0x80)out+=char(cp);
  else if(cp<0x800){out+=char(0xC0|(cp>>6));out+=char(0x80|(cp&63));}
  else if(cp<0x10000){out+=char(0xE0|(cp>>12));out+=char(0x80|((cp>>6)&63));out+=char(0x80|(cp&63));}
  else{out+=char(0xF0|(cp>>18));out+=char(0x80|((cp>>12)&63));out+=char(0x80|((cp>>6)&63));out+=char(0x80|(cp&63));}
}
// CF_UNICODETEXT (UTF-16LE, CRLF, NUL terminated) -> UTF-8 with LF. nullopt for malformed or oversized text; never truncates.
inline std::optional<std::string> text_from_cf_unicode(const uint8_t* data,size_t size){
  if(size>CLIPBOARD_MAX_WIRE||size%2||(size&&!data))return std::nullopt;
  std::string out;
  for(size_t i=0;i<size;){
    const uint32_t unit=data[i]|(uint32_t(data[i+1])<<8);i+=2;
    if(unit==0)break;
    uint32_t cp=unit;
    if(unit>=0xD800&&unit<=0xDBFF){
      if(i+2>size)return std::nullopt;
      const uint32_t low=data[i]|(uint32_t(data[i+1])<<8);
      if(low<0xDC00||low>0xDFFF)return std::nullopt;
      i+=2;cp=0x10000+((unit-0xD800)<<10)+(low-0xDC00);
    }else if(unit>=0xDC00&&unit<=0xDFFF)return std::nullopt;
    if(cp=='\r'&&i+2<=size&&data[i]=='\n'&&data[i+1]==0)continue;
    append_utf8(out,cp);
    if(out.size()>CLIPBOARD_MAX_BYTES)return std::nullopt;
  }
  return out;
}
// UTF-8 with LF -> CF_UNICODETEXT. Strict: overlong forms, surrogates, NUL and oversized text are rejected.
inline std::optional<std::vector<uint8_t>> text_to_cf_unicode(const std::string& in){
  if(in.size()>CLIPBOARD_MAX_BYTES)return std::nullopt;
  std::vector<uint8_t> out;
  const auto put=[&](uint32_t unit){out.push_back(uint8_t(unit));out.push_back(uint8_t(unit>>8));};
  const auto* s=reinterpret_cast<const uint8_t*>(in.data());const size_t n=in.size();
  bool afterCr=false;
  for(size_t i=0;i<n;){
    const uint8_t lead=s[i];uint32_t cp;size_t len;
    if(lead<0x80){cp=lead;len=1;}
    else if(lead>=0xC2&&lead<=0xDF){cp=lead&0x1F;len=2;}
    else if(lead>=0xE0&&lead<=0xEF){cp=lead&0x0F;len=3;}
    else if(lead>=0xF0&&lead<=0xF4){cp=lead&0x07;len=4;}
    else return std::nullopt;
    if(i+len>n)return std::nullopt;
    for(size_t k=1;k<len;k++){if((s[i+k]&0xC0)!=0x80)return std::nullopt;cp=(cp<<6)|(s[i+k]&0x3F);}
    if((len==3&&cp<0x800)||(len==4&&(cp<0x10000||cp>0x10FFFF))||(cp>=0xD800&&cp<=0xDFFF)||cp==0)return std::nullopt;
    i+=len;
    if(cp=='\n'&&!afterCr)put('\r');
    afterCr=cp=='\r';
    if(cp>=0x10000){cp-=0x10000;put(0xD800+(cp>>10));put(0xDC00+(cp&0x3FF));}
    else put(cp);
  }
  put(0);
  return out;
}
