#pragma once
#include "json.hpp"
using json=nlohmann::json;
inline int bounded_integer(const json& v,const char* key,int min,int max) {
  const auto& x=v.at(key);if(!x.is_number_integer())throw std::invalid_argument("integer");
  auto n=x.get<int64_t>();if(n<min||n>max)throw std::invalid_argument("range");return int(n);
}
inline json validate_control(const json& v){
  if(!v.is_object())throw std::invalid_argument("object");const auto type=v.at("type").get<std::string>();
  if(type=="close")return {{"type",type}};
  if(type=="key"){bounded_integer(v,"scanCode",1,511);if(!v.at("down").is_boolean())throw std::invalid_argument("boolean");}
  else if(type=="pointer"){bounded_integer(v,"x",0,8191);bounded_integer(v,"y",0,8191);bounded_integer(v,"buttons",0,7);}
  else if(type=="resize"){bounded_integer(v,"width",1,8192);bounded_integer(v,"height",1,8192);}
  else throw std::invalid_argument("type");return v;
}
inline bool fingerprint_matches(const std::string& observed,const std::string& expected){
  auto normalize=[](const std::string& in){std::string out;for(unsigned char c:in){if(c==':')continue;if(!std::isxdigit(c))return std::string();out+=char(std::tolower(c));}return out;};
  const auto a=normalize(observed),b=normalize(expected);if(a.size()!=64||b.size()!=64)return false;
  unsigned char mismatch=0;for(size_t i=0;i<64;i++)mismatch|=a[i]^b[i];return mismatch==0;
}
