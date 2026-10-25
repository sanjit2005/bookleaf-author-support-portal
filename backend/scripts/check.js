import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):e.name.endsWith('.js')?[`${dir}/${e.name}`]:[]);}
for(const file of [...walk('src'),...walk('test'),...walk('scripts'),...walk('integration')]){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
console.log('All backend JavaScript syntax checks passed');
