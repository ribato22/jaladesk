import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
process.env.electron_config_cache=resolve(root,'../../work/electron-cache');
const electron=createRequire(import.meta.url)('electron');
const child=spawn(electron,[root,...process.argv.slice(2)],{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
