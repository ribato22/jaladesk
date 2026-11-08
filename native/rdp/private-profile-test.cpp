#undef NDEBUG
#include "private-profile.hpp"
#include <cassert>
#include <filesystem>
#include <iostream>
template<class F>void rejects(F f){bool failed=false;try{f();}catch(...){failed=true;}assert(failed);}
int main(){
  namespace fs=std::filesystem;namespace p=rdp_profile;
  const auto root=fs::canonical(fs::temp_directory_path())/("rdp-policy-native-"+std::to_string(p::pid()));
  assert(fs::create_directory(root));
  try{
    const auto path=root/ fs::u8path("profil-é-你好");
    p::create(path.u8string());p::inspect(path.u8string());
    rejects([&]{p::create(path.u8string());});rejects([&]{p::inspect("relative");});
    const std::string id="00000000-0000-4000-8000-000000000001";
    auto q=nlohmann::json{{"schema",1},{"op","inspect"},{"path",path.u8string()},{"requestId",id}};
    auto reply=p::request(q.dump());assert(reply.at("private")==true&&reply.at("owner")==true&&reply.at("requestId")==id&&reply.size()==5);
    q["unknown"]=true;rejects([&]{p::request(q.dump());});
    rejects([&]{p::request(std::string(8193,'x'));});rejects([&]{p::request(std::string(1,char(0xff)));});
#ifndef _WIN32
    rejects([&]{p::checked_path(root.u8string()+"/invalid-"+char(0xff));});
    ::setenv("RW_RDP_CONFIG_PATH",path.c_str(),1);assert(p::config_path()==path.u8string());
    ::chmod(path.c_str(),0755);rejects([&]{p::config_path();});
    assert(::symlink(path.c_str(),(root/"link").c_str())==0);rejects([&]{p::inspect((root/"link").u8string());});
    ::unsetenv("RW_RDP_CONFIG_PATH");rejects([&]{p::config_path();});
#else
    SetEnvironmentVariableW(L"RW_RDP_CONFIG_PATH",path.c_str());assert(p::config_path()==path.u8string());
    SetEnvironmentVariableW(L"RW_RDP_CONFIG_PATH",nullptr);rejects([&]{p::config_path();});
#endif
    fs::remove_all(root);std::cout<<"private profile assertions passed\n";return 0;
  }catch(...){fs::remove_all(root);throw;}
}
