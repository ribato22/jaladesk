import type {Frame} from './wire.js';
export function makeFrameDelivery(send:(frame:Frame,sequence:number)=>void){
  let pending:Frame|undefined,inflight=0,sequence=0,closed=false;
  function deliver(frame:Frame){inflight=++sequence;send(frame,inflight);}
  return {
    push(frame:Frame){if(closed)return;if(inflight)pending=frame;else deliver(frame);},
    ack(value:number){if(closed||!inflight||value!==inflight)return;inflight=0;if(pending){const frame=pending;pending=undefined;deliver(frame);}},
    close(){closed=true;pending=undefined;}
  };
}
