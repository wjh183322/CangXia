import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));process.chdir(root);
const log=path.join(root,'启动记录.log');
fs.writeFileSync(log,`${new Date().toISOString()}\nNode ${process.versions.node}\n正在启动收藏网页翻页工具…\n`,'utf8');
const clean=value=>String(value instanceof Error?value.message:value).replace(/https?:\/\/\S+/g,'[网页地址]').slice(0,1500);
for(const method of ['log','error']){const original=console[method].bind(console);console[method]=(...values)=>{try{fs.appendFileSync(log,values.map(clean).join(' ')+'\n','utf8');}catch{}original(...values);};}
try{await import('./run.mjs');}catch(error){console.error('启动失败：',error);console.error('详细信息已保存在工具目录的“启动记录.log”。');process.exitCode=1;}
