import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const [index,total]=process.argv.slice(2,4).map(Number);
if(!Number.isSafeInteger(index)||!Number.isSafeInteger(total)||total<1||index<0||index>=total)throw Error('Usage: node scripts/test-shard.mjs INDEX TOTAL [--list]');
const all=fs.readdirSync('tests').filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name),selected=all.filter((_,n)=>n%total===index);
if(process.argv.includes('--list'))console.log(JSON.stringify(selected));
else{if(!selected.length)throw Error('Empty test shard');console.log('Full suite shard '+(index+1)+'/'+total+': '+selected.length+'/'+all.length+' files');const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...selected],{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;process.exit(result.status??1);}
