#undef NDEBUG
#include <cassert>
#include <string>
#include <vector>
#include "clipboard.hpp"

static std::vector<uint8_t> utf16(std::initializer_list<uint16_t> units) {
  std::vector<uint8_t> out;for(auto u:units){out.push_back(uint8_t(u));out.push_back(uint8_t(u>>8));}return out;
}
static bool rejected_from(const std::vector<uint8_t>& bytes){return !text_from_cf_unicode(bytes.data(),bytes.size()).has_value();}

int main(){
  // base64: RFC 4648 vectors, canonical form only
  assert(base64_encode("")==""&&base64_encode("f")=="Zg=="&&base64_encode("fo")=="Zm8="&&base64_encode("foo")=="Zm9v"&&base64_encode("foob")=="Zm9vYg==");
  assert(base64_decode("Zm9vYg==")==std::optional<std::string>("foob")&&base64_decode("")==std::optional<std::string>(""));
  for(const char* bad:{"Zm9vYg=","Zm9vYg","Zm9v=","Zh==","Zm9=","Zm 9v","Zm9v\n","=m9v","Zg==Zg==","@@@@"})assert(!base64_decode(bad));
  assert(!base64_decode(std::string(CLIPBOARD_MAX_BYTES/3*4+8,'A')));

  // CF_UNICODETEXT -> UTF-8: CRLF becomes LF, text stops at the terminating NUL, surrogate pairs combine
  const auto remote=utf16({'A',0x00e9,0x20ac,0xd83d,0xde00,'\r','\n','B',0,'X'});
  assert(text_from_cf_unicode(remote.data(),remote.size())==std::optional<std::string>("A\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80\nB"));
  assert(text_from_cf_unicode(remote.data(),0)==std::optional<std::string>(""));
  const auto lone_cr=utf16({'a','\r','b'});
  assert(text_from_cf_unicode(lone_cr.data(),lone_cr.size())==std::optional<std::string>("a\rb"));
  assert(rejected_from({'a'}));                                   // odd byte count
  assert(rejected_from(utf16({'a',0xd800,'b'})));                 // high surrogate without a low one
  assert(rejected_from(utf16({'a',0xdc00})));                     // lone low surrogate
  assert(rejected_from(utf16({0xd800})));                         // high surrogate at the very end
  assert(rejected_from(std::vector<uint8_t>(CLIPBOARD_MAX_WIRE+2,'a')));        // beyond what we even inspect
  std::vector<uint8_t> big;for(size_t i=0;i<CLIPBOARD_MAX_BYTES;i++){big.push_back('a');big.push_back(0);}
  assert(text_from_cf_unicode(big.data(),big.size()).has_value());               // exactly at the limit
  big.push_back('a');big.push_back(0);assert(rejected_from(big));                // one byte over

  // UTF-8 -> CF_UNICODETEXT: LF becomes CRLF (existing CRLF kept), NUL terminated
  assert((*text_to_cf_unicode("A\nB")==utf16({'A','\r','\n','B',0})));
  assert((*text_to_cf_unicode("A\r\nB")==utf16({'A','\r','\n','B',0})));
  assert((*text_to_cf_unicode("\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80")==utf16({0x00e9,0x20ac,0xd83d,0xde00,0})));
  assert((*text_to_cf_unicode("")==utf16({0})));
  for(const std::string& bad:{std::string("a\0b",3),std::string("\xC0\x80"),std::string("\xED\xA0\x80"),std::string("\xF4\x90\x80\x80"),std::string("\xE2\x82"),std::string("\x80"),std::string("\xF8\x88\x80\x80\x80"),std::string("\xC1\xBF"),std::string("\xE0\x9F\xBF"),std::string("\xF0\x8F\xBF\xBF"),std::string("a\xC3(")})
    assert(!text_to_cf_unicode(bad).has_value());
  assert(text_to_cf_unicode(std::string(CLIPBOARD_MAX_BYTES,'a')).has_value());
  assert(!text_to_cf_unicode(std::string(CLIPBOARD_MAX_BYTES+1,'a')).has_value());

  // round trip keeps LF text intact
  const std::string sample="halo \xE2\x80\x94 \xE4\xBD\xA0\xE5\xA5\xBD \xF0\x9F\x98\x80\nbaris dua\n";
  const auto wire=text_to_cf_unicode(sample);assert(wire&&text_from_cf_unicode(wire->data(),wire->size())==std::optional<std::string>(sample));
}
