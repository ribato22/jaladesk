import {posix,win32} from 'node:path';
export function runtimePaths(options:{platform:NodeJS.Platform;packaged:boolean;appRoot:string;appData:string;override?:string}):{userData:string;sessionData:string}{
  const path=options.platform==='win32'?win32:posix;
  const valid=(value:string)=>typeof value==='string'&&value.length>0&&!value.includes('\0')&&path.isAbsolute(value);
  if(!valid(options.appRoot)||!valid(options.appData)||options.override?.includes('\0'))throw new Error('Invalid application data path');
  const userData=options.override?path.resolve(options.override):options.packaged?path.join(options.appData,'RemoteWorkspaceInternal'):path.resolve(options.appRoot,'../../work/electron-user-data');
  if(options.packaged){
    const bundle=path.resolve(options.appRoot,options.platform==='darwin'?'../../..':'../..'),relative=path.relative(bundle,userData);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Invalid application data path');
  }
  return {userData,sessionData:path.join(userData,'chromium')};
}
