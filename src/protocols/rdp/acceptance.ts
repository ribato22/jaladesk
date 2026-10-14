export type Result={platform:string;status:string;evidence:string[];checks?:string[]};
export const requiredChecks=['login','wrong-credentials','certificate-mismatch','embedded-input','resize','two-sessions','cancel','helper-crash','network-interruption','clipboard'];
export function gateReady(results:Result[]):boolean{
  return ['mac-arm64','mac-x86_64','windows-x64'].every(platform=>{
    const rows=results.filter(r=>r.platform===platform);if(rows.length!==1)return false;
    const r=rows[0];return r.status==='lab-passed'&&Array.isArray(r.evidence)&&r.evidence.length>0&&Array.isArray(r.checks)&&requiredChecks.every(c=>r.checks!.includes(c));
  });
}
