#pragma once
// FreeRDP channel glue for the bridge: display control (client-driven resize) and text-only clipboard.
// Header-only and free of FreeRDP function calls, so channels-test can drive it with stub contexts.
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/disp.h>
#include <winpr/error.h>
#include <winpr/wtsapi.h>
#include <cstdlib>
#include <functional>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include "control.hpp"

// The bridge asks FreeRDP to run every channel callback on the thread that drives the connection (the same one that
// applies input), so these objects need no locks. If that ever stops being true the helper stops here instead of racing.
class ThreadAffine {
 protected:
  void affine() const{if(std::this_thread::get_id()!=owner_)std::abort();}
 private:
  const std::thread::id owner_=std::this_thread::get_id();
};

// The desktop follows the client window through the display control channel: no reconnect, and the
// credentials stay where they already are. Requests made before the server announces support wait for it.
class DisplayChannel : ThreadAffine {
 public:
  using Size=std::pair<uint32_t,uint32_t>;
  void attach(DispClientContext* ctx){affine();detach();ctx_=ctx;ctx->custom=this;ctx->DisplayControlCaps=&DisplayChannel::caps;}
  void detach(){affine();if(ctx_){ctx_->custom=nullptr;ctx_->DisplayControlCaps=nullptr;}ctx_=nullptr;ready_=false;requested_.reset();}
  // The server's real desktop size; it supersedes whatever was asked for earlier.
  void note_desktop(uint32_t width,uint32_t height){affine();current_={width,height};requested_.reset();}
  // false only when the channel reports a failed send.
  bool request(uint32_t width,uint32_t height){
    affine();
    const Size size=display_size(width,height);
    if(!ready_){pending_=size;return true;}
    if(size==(requested_?*requested_:current_))return true;
    return send(size);
  }
 private:
  static UINT caps(DispClientContext* ctx,UINT32 monitors,UINT32 factorA,UINT32 factorB){
    auto* self=static_cast<DisplayChannel*>(ctx->custom);if(!self)return CHANNEL_RC_OK;
    self->affine();
    if(monitors<1)return CHANNEL_RC_OK;   // a server announcing no monitors cannot be resized
    self->factorA_=factorA;self->factorB_=factorB;self->ready_=true;
    if(self->pending_){const Size size=*self->pending_;self->pending_.reset();if(size!=self->current_)(void)self->send(size);}
    return CHANNEL_RC_OK;
  }
  bool send(Size size){
    // A size above the server's monitor area limit is refused here rather than risking a disconnect.
    if(!ctx_||!fits_monitor_area(size.first,size.second,factorA_,factorB_))return true;
    DISPLAY_CONTROL_MONITOR_LAYOUT layout{};
    layout.Flags=DISPLAY_CONTROL_MONITOR_PRIMARY;layout.Width=size.first;layout.Height=size.second;
    layout.Orientation=0;layout.DesktopScaleFactor=100;layout.DeviceScaleFactor=100;   // landscape, no scaling
    if(ctx_->SendMonitorLayout(ctx_,1,&layout)!=CHANNEL_RC_OK)return false;
    requested_=size;return true;
  }
  DispClientContext* ctx_=nullptr;bool ready_=false;uint32_t factorA_=0,factorB_=0;Size current_{0,0};std::optional<Size> pending_,requested_;
};

// Unicode text only, in the directions the user opted into. File formats are never announced or served, and
// FreeRDP's own ClipboardFeatureMask (set by the bridge) filters them again below this layer.
class ClipboardChannel : ThreadAffine {
 public:
  using Emit=std::function<void(const std::string&)>;
  ClipboardChannel(bool toRemote,bool fromRemote,Emit emit):toRemote_(toRemote),fromRemote_(fromRemote),emit_(std::move(emit)){}
  ClipboardChannel(const ClipboardChannel&)=delete;
  ClipboardChannel& operator=(const ClipboardChannel&)=delete;
  ~ClipboardChannel(){wipe();}
  void attach(CliprdrClientContext* ctx){
    affine();detach();ctx_=ctx;ctx->custom=this;
    ctx->MonitorReady=&ClipboardChannel::monitor_ready;ctx->ServerFormatList=&ClipboardChannel::server_format_list;
    ctx->ServerFormatDataRequest=&ClipboardChannel::server_format_data_request;ctx->ServerFormatDataResponse=&ClipboardChannel::server_format_data_response;
  }
  // Drops the callbacks and wipes the offered text: nothing outlives the session that owned the channel.
  void detach(){
    affine();
    if(ctx_){ctx_->custom=nullptr;ctx_->MonitorReady=nullptr;ctx_->ServerFormatList=nullptr;ctx_->ServerFormatDataRequest=nullptr;ctx_->ServerFormatDataResponse=nullptr;}
    ctx_=nullptr;ready_=false;outstanding_=0;wipe();
  }
  // Local text for the remote to paste. A refused offer (direction off, empty, malformed, too large) also clears the previous one.
  bool offer(const std::string& utf8){
    affine();
    wipe();
    if(!toRemote_||utf8.empty())return false;
    auto wire=text_to_cf_unicode(utf8);if(!wire)return false;
    local_=std::move(*wire);
    return !(ready_&&ctx_)||announce()==CHANNEL_RC_OK;
  }
  size_t offered_bytes() const{return local_.size();}
 private:
  static ClipboardChannel* self(CliprdrClientContext* ctx){return static_cast<ClipboardChannel*>(ctx->custom);}
  static UINT monitor_ready(CliprdrClientContext* ctx,const CLIPRDR_MONITOR_READY*){auto* c=self(ctx);if(!c)return CHANNEL_RC_OK;c->affine();return c->on_monitor_ready();}
  static UINT server_format_list(CliprdrClientContext* ctx,const CLIPRDR_FORMAT_LIST* list){auto* c=self(ctx);if(!c)return CHANNEL_RC_OK;c->affine();return c->on_server_format_list(list);}
  static UINT server_format_data_request(CliprdrClientContext* ctx,const CLIPRDR_FORMAT_DATA_REQUEST* request){auto* c=self(ctx);if(!c)return CHANNEL_RC_OK;c->affine();return c->on_server_format_data_request(request);}
  static UINT server_format_data_response(CliprdrClientContext* ctx,const CLIPRDR_FORMAT_DATA_RESPONSE* response){auto* c=self(ctx);if(!c)return CHANNEL_RC_OK;c->affine();return c->on_server_format_data_response(response);}
  void wipe(){volatile uint8_t* p=local_.data();for(size_t i=0;i<local_.size();i++)p[i]=0;local_.clear();}
  UINT announce(){
    CLIPRDR_FORMAT format{};format.formatId=CF_UNICODETEXT_FORMAT;
    CLIPRDR_FORMAT_LIST list{};list.common.msgType=CB_FORMAT_LIST;
    if(toRemote_&&!local_.empty()){list.numFormats=1;list.formats=&format;}
    return ctx_->ClientFormatList(ctx_,&list);
  }
  UINT on_monitor_ready(){
    ready_=true;
    CLIPRDR_GENERAL_CAPABILITY_SET general{};general.capabilitySetType=CB_CAPSTYPE_GENERAL;general.capabilitySetLength=CB_CAPSTYPE_GENERAL_LEN;
    general.version=CB_CAPS_VERSION_2;general.generalFlags=CB_USE_LONG_FORMAT_NAMES;   // no file streaming, no clipboard locking
    CLIPRDR_CAPABILITIES caps{};caps.common.msgType=CB_CLIP_CAPS;caps.cCapabilitiesSets=1;caps.capabilitySets=reinterpret_cast<CLIPRDR_CAPABILITY_SET*>(&general);
    if(const UINT rc=ctx_->ClientCapabilities(ctx_,&caps))return rc;
    return announce();
  }
  UINT on_server_format_list(const CLIPRDR_FORMAT_LIST* list){
    CLIPRDR_FORMAT_LIST_RESPONSE ack{};ack.common.msgType=CB_FORMAT_LIST_RESPONSE;ack.common.msgFlags=CB_RESPONSE_OK;
    if(const UINT rc=ctx_->ClientFormatListResponse(ctx_,&ack))return rc;
    if(!fromRemote_||outstanding_>=kMaxOutstanding||!list)return CHANNEL_RC_OK;
    bool text=false;for(UINT32 i=0;i<list->numFormats&&list->formats;i++)text=text||list->formats[i].formatId==CF_UNICODETEXT_FORMAT;
    if(!text)return CHANNEL_RC_OK;
    CLIPRDR_FORMAT_DATA_REQUEST request{};request.common.msgType=CB_FORMAT_DATA_REQUEST;request.requestedFormatId=CF_UNICODETEXT_FORMAT;
    outstanding_++;
    const UINT rc=ctx_->ClientFormatDataRequest(ctx_,&request);if(rc)outstanding_--;
    return rc;
  }
  UINT on_server_format_data_request(const CLIPRDR_FORMAT_DATA_REQUEST* request){
    // With the direction off FreeRDP already answered the request itself and never gets here; answering again would trip its mask assert.
    if(!toRemote_)return CHANNEL_RC_OK;
    static const BYTE none=0;
    CLIPRDR_FORMAT_DATA_RESPONSE response{};response.common.msgType=CB_FORMAT_DATA_RESPONSE;
    if(request&&request->requestedFormatId==CF_UNICODETEXT_FORMAT&&!local_.empty()){
      response.common.msgFlags=CB_RESPONSE_OK;response.common.dataLen=UINT32(local_.size());response.requestedFormatData=local_.data();
    }else{response.common.msgFlags=CB_RESPONSE_FAIL;response.requestedFormatData=&none;}
    return ctx_->ClientFormatDataResponse(ctx_,&response);
  }
  // Anything unexpected is dropped quietly: a bad clipboard answer must never end the session.
  UINT on_server_format_data_response(const CLIPRDR_FORMAT_DATA_RESPONSE* response){
    if(outstanding_<=0)return CHANNEL_RC_OK;
    outstanding_--;
    if(!fromRemote_||!response||!(response->common.msgFlags&CB_RESPONSE_OK))return CHANNEL_RC_OK;
    auto text=text_from_cf_unicode(response->requestedFormatData,response->common.dataLen);
    if(text&&!text->empty())emit_(*text);
    if(text)std::fill(text->begin(),text->end(),'\0');
    return CHANNEL_RC_OK;
  }
  static constexpr int kMaxOutstanding=8;
  CliprdrClientContext* ctx_=nullptr;bool toRemote_,fromRemote_,ready_=false;int outstanding_=0;std::vector<uint8_t> local_;Emit emit_;
};
