#pragma once
#include <json.hpp>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <set>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#else
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#endif
namespace rdp_profile {
inline void need(bool ok){if(!ok)throw std::runtime_error("private profile unavailable");}
inline bool uuid(const std::string& s){
  if(s.size()!=36)return false;
  for(size_t n=0;n<s.size();n++)if(n==8||n==13||n==18||n==23){if(s[n]!='-')return false;}else if(!((s[n]>='0'&&s[n]<='9')||(s[n]>='a'&&s[n]<='f')))return false;
  return true;
}
#ifdef _WIN32
struct Handle{HANDLE h=INVALID_HANDLE_VALUE;explicit Handle(HANDLE v):h(v){}~Handle(){if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);}Handle(const Handle&)=delete;};
inline unsigned long pid(){return GetCurrentProcessId();}
inline std::wstring wide(const std::string& s){
  need(!s.empty()&&s.size()<32768&&s.find('\0')==std::string::npos);
  int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0);need(n>0);
  std::wstring w(n,0);need(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),w.data(),n)==n);return w;
}
inline std::string utf8(const std::wstring& w){
  int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,w.data(),int(w.size()),nullptr,0,nullptr,nullptr);need(n>0);
  std::string s(n,0);need(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,w.data(),int(w.size()),s.data(),n,nullptr,nullptr)==n);return s;
}
inline std::vector<BYTE> token_user(){
  HANDLE raw=nullptr;need(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&raw));Handle token(raw);DWORD size=0;
  GetTokenInformation(token.h,TokenUser,nullptr,0,&size);need(size>0);std::vector<BYTE> data(size);
  need(GetTokenInformation(token.h,TokenUser,data.data(),size,&size));return data;
}
inline void directory(HANDLE h){
  FILE_ATTRIBUTE_TAG_INFO info{};need(h!=INVALID_HANDLE_VALUE&&GetFileInformationByHandleEx(h,FileAttributeTagInfo,&info,sizeof(info)));
  need((info.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&!(info.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
}
inline std::wstring checked_path(const std::string& s){
  auto w=wide(s);need(w.size()>3&&((w[0]>=L'A'&&w[0]<=L'Z')||(w[0]>=L'a'&&w[0]<=L'z'))&&w[1]==L':'&&w[2]==L'\\');
  const auto drive=GetDriveTypeW(w.substr(0,3).c_str());need(drive==DRIVE_FIXED||drive==DRIVE_RAMDISK);
  need(w.find(L'/',0)==std::wstring::npos&&w.find(L':',2)==std::wstring::npos&&w.back()!=L'\\');
  std::vector<wchar_t> full(32768);auto n=GetFullPathNameW(w.c_str(),DWORD(full.size()),full.data(),nullptr);need(n>0&&n<full.size()&&std::wstring(full.data(),n)==w);
  for(size_t start=3;start<w.size();){auto end=w.find(L'\\',start);auto part=w.substr(start,end==std::wstring::npos?end:end-start);need(!part.empty()&&part.back()!=L'.'&&part.back()!=L' ');if(end==std::wstring::npos)break;start=end+1;}
  for(auto end=w.find(L'\\',3);end!=std::wstring::npos;end=w.find(L'\\',end+1)){
    Handle h(CreateFileW(w.substr(0,end).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));directory(h.h);
  }
  return w;
}
inline void inspect(const std::string& path){
  auto w=checked_path(path);Handle h(CreateFileW(w.c_str(),READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));directory(h.h);
  auto user=token_user();auto sid=reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;BYTE system[SECURITY_MAX_SID_SIZE];DWORD size=sizeof(system);need(CreateWellKnownSid(WinLocalSystemSid,nullptr,system,&size));
  PSECURITY_DESCRIPTOR sd=nullptr;PACL acl=nullptr;PSID owner=nullptr;
  need(GetSecurityInfo(h.h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&sd)==ERROR_SUCCESS&&sd);
  SECURITY_DESCRIPTOR_CONTROL control{};DWORD revision=0;bool okay=owner&&EqualSid(owner,sid)&&acl&&acl->AceCount==2&&GetSecurityDescriptorControl(sd,&control,&revision)&&(control&SE_DACL_PROTECTED),a=false,b=false;
  if(acl)for(DWORD n=0;n<acl->AceCount;n++){
    void* raw=nullptr;if(!GetAce(acl,n,&raw)){okay=false;break;}auto header=static_cast<ACE_HEADER*>(raw);
    if(header->AceType!=ACCESS_ALLOWED_ACE_TYPE||header->AceFlags!=(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE)){okay=false;break;}
    auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);bool u=EqualSid(&ace->SidStart,sid),s=EqualSid(&ace->SidStart,system);
    if((!u&&!s)||ace->Mask!=FILE_ALL_ACCESS){okay=false;break;}a|=u;b|=s;
  }
  LocalFree(sd);need(okay&&a&&b);
}
inline void create(const std::string& path){
  auto w=checked_path(path);auto user=token_user();LPWSTR sid=nullptr;
  need(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&sid));
  std::wstring sddl=L"O:"+std::wstring(sid)+L"D:P(A;OICI;FA;;;"+sid+L")(A;OICI;FA;;;SY)";LocalFree(sid);
  PSECURITY_DESCRIPTOR sd=nullptr;need(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&sd,nullptr));
  SECURITY_ATTRIBUTES sa{sizeof(sa),sd,FALSE};bool made=CreateDirectoryW(w.c_str(),&sa);LocalFree(sd);need(made);inspect(path);
}
inline std::string environment_path(){
  auto n=GetEnvironmentVariableW(L"RW_RDP_CONFIG_PATH",nullptr,0);need(n>1&&n<=32768);std::wstring w(n,0);
  auto read=GetEnvironmentVariableW(L"RW_RDP_CONFIG_PATH",w.data(),n);need(read>0&&read<n);w.resize(read);return utf8(w);
}
#else
inline unsigned long pid(){return static_cast<unsigned long>(getpid());}
inline std::filesystem::path checked_path(const std::string& s){
  need(!s.empty()&&s.size()<4096&&s.find('\0')==std::string::npos);
  (void)nlohmann::json(s).dump(); // Native environment paths bypass the RPC JSON decoder.
  auto p=std::filesystem::u8path(s);need(p.is_absolute()&&p.lexically_normal().u8string()==s&&p.filename()!="");
  std::filesystem::path parent="/";
  for(const auto& part:p.relative_path()){
    parent/=part;if(parent==p)break;struct stat st{};need(lstat(parent.c_str(),&st)==0&&S_ISDIR(st.st_mode)&&!S_ISLNK(st.st_mode));
  }
  return p;
}
inline void inspect(const std::string& s){
  auto path=checked_path(s);int fd=open(path.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);need(fd>=0);struct stat st{};
  bool okay=fstat(fd,&st)==0&&S_ISDIR(st.st_mode)&&st.st_uid==geteuid()&&(st.st_mode&07777)==0700;close(fd);need(okay);
}
inline void create(const std::string& s){auto path=checked_path(s);need(mkdir(path.c_str(),0700)==0);inspect(s);}
inline std::string environment_path(){auto path=getenv("RW_RDP_CONFIG_PATH");need(path&&*path);return path;}
#endif
inline std::string config_path(){auto path=environment_path();inspect(path);return path;}
inline nlohmann::json request(const std::string& text){
  need(!text.empty()&&text.size()<=8192);std::vector<std::set<std::string>> keys;
  auto q=nlohmann::json::parse(text,[&](int,nlohmann::json::parse_event_t event,nlohmann::json& value){
    if(event==nlohmann::json::parse_event_t::object_start)keys.emplace_back();
    if(event==nlohmann::json::parse_event_t::key)need(!keys.empty()&&keys.back().insert(value.get<std::string>()).second);
    if(event==nlohmann::json::parse_event_t::object_end)keys.pop_back();return true;
  });
  need(q.is_object()&&q.size()==4&&q.contains("schema")&&q.contains("op")&&q.contains("path")&&q.contains("requestId"));
  need(q.at("schema").is_number_integer()&&q.at("schema")==1&&q.at("op").is_string()&&q.at("path").is_string()&&q.at("requestId").is_string());
  auto op=q.at("op").get<std::string>(),id=q.at("requestId").get<std::string>(),path=q.at("path").get<std::string>();need(uuid(id));
  if(op=="create")create(path);else{need(op=="inspect");inspect(path);}
  return {{"schema",1},{"op",op},{"requestId",id},{"owner",true},{"private",true}};
}
inline int rpc(std::istream& in,std::ostream& out){
  try{
    std::string text;char c;while(in.get(c)){need(text.size()<8192);text+=c;}
    need(in.eof());auto reply=request(text).dump();need(reply.size()<=4096);out<<reply<<'\n'<<std::flush;return out.good()?0:2;
  }catch(...){return 2;}
}
}
