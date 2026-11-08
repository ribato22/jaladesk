import test from 'node:test';import assert from 'node:assert/strict';
test('development keeps legacy userdata and isolates Chromium cache',async()=>{
  const {runtimePaths}=await import('../src/desktop/runtime-paths.js');
  assert.deepEqual(runtimePaths({platform:'darwin',packaged:false,appRoot:'/project/outputs/app',appData:'/user/Library/Application Support'}),{userData:'/project/work/electron-user-data',sessionData:'/project/work/electron-user-data/chromium'});
});
test('packaged data stays in a per-user namespace after moving either installation',async()=>{
  const {runtimePaths}=await import('../src/desktop/runtime-paths.js');
  for(const appRoot of ['/Applications/RW.app/Contents/Resources/app','/tmp/RW déplacé 中文.app/Contents/Resources/app'])assert.deepEqual(runtimePaths({platform:'darwin',packaged:true,appRoot,appData:'/Users/é/Library/Application Support'}),{userData:'/Users/é/Library/Application Support/RemoteWorkspaceInternal',sessionData:'/Users/é/Library/Application Support/RemoteWorkspaceInternal/chromium'});
  for(const appRoot of ['C:\\Apps\\RW\\resources\\app','D:\\移動\\RW\\resources\\app'])assert.deepEqual(runtimePaths({platform:'win32',packaged:true,appRoot,appData:'C:\\Users\\é\\AppData\\Roaming'}),{userData:'C:\\Users\\é\\AppData\\Roaming\\RemoteWorkspaceInternal',sessionData:'C:\\Users\\é\\AppData\\Roaming\\RemoteWorkspaceInternal\\chromium'});
});
test('explicit synthetic data folder is honored without touching the installation',async()=>{
  const {runtimePaths}=await import('../src/desktop/runtime-paths.js');
  assert.deepEqual(runtimePaths({platform:'darwin',packaged:true,appRoot:'/Applications/RW.app/Contents/Resources/app',appData:'/user/appdata',override:'/tmp/RW synthetic é'}),{userData:'/tmp/RW synthetic é',sessionData:'/tmp/RW synthetic é/chromium'});
});
test('packaged data cannot be placed anywhere inside the bundle, including Windows case variants',async()=>{
  const {runtimePaths}=await import('../src/desktop/runtime-paths.js');
  for(const override of ['/Applications/RW.app','/Applications/RW.app/Contents/work','/Applications/RW.app/Contents/Resources/app/data'])assert.throws(()=>runtimePaths({platform:'darwin',packaged:true,appRoot:'/Applications/RW.app/Contents/Resources/app',appData:'/user/appdata',override}),/Invalid application data path/);
  assert.throws(()=>runtimePaths({platform:'win32',packaged:true,appRoot:'C:\\Apps\\RW\\resources\\app',appData:'C:\\User\\data',override:'c:\\APPS\\rw\\data'}),/Invalid application data path/);
  assert.equal(runtimePaths({platform:'darwin',packaged:true,appRoot:'/Applications/RW.app/Contents/Resources/app',appData:'/user/appdata',override:'/Applications/RW.app-other/data'}).userData,'/Applications/RW.app-other/data');
});
test('malformed paths fail without returning private input in errors',async()=>{
  const {runtimePaths}=await import('../src/desktop/runtime-paths.js');
  for(const appData of ['relative','/bad\0private-canary'])assert.throws(()=>runtimePaths({platform:'darwin',packaged:true,appRoot:'/Applications/RW.app/Contents/Resources/app',appData}),{message:'Invalid application data path'});
});
