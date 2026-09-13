import fs from 'node:fs';
import path from 'node:path';

export function validateAuth(input){
  if(!input||!Array.isArray(input.cookies)||input.cookies.length>300)throw new Error('登录配置格式无效');
  let ignoredCookies=0;const cookies=[];
  for(const c of input.cookies){
    if(!c||!['douyin.com','www.douyin.com'].includes(String(c.domain||'').replace(/^\./,'')))continue;
    const valid=typeof c.name==='string'&&typeof c.value==='string'&&/^[!#$%&'*+.^_`|~\w-]+$/.test(c.name)&&!/[\x00-\x1f\x7f]/.test(c.value)&&c.value.length<=16384;
    if(!valid){if(['sessionid','sessionid_ss'].includes(c.name))throw new Error('关键登录会话字段无效，请重新扫码登录');ignoredCookies++;continue;}
    cookies.push({...c,domain:c.domain,path:typeof c.path==='string'&&c.path.startsWith('/')&&!/[\r\n\0]/.test(c.path)?c.path:'/'});
  }
  if(!cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value))throw new Error('配置文件不含有效登录会话，请使用已登录的参考工具配置');
  if(typeof input.userAgent!=='string'||!input.userAgent||input.userAgent.length>1500||/[\r\n\0]/.test(input.userAgent))throw new Error('配置文件缺少有效浏览器信息');
  return {cookies,userAgent:input.userAgent,source:['chrome','edge','config','popup'].includes(input.source)?input.source:'config',ignoredCookies};
}
export function parseReferenceConfig(text){
  if(text.length>2*1024*1024)throw new Error('配置文件过大');
  let input;try{input=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('所选文件不是有效的 JSON 配置');}
  if(typeof input.cookie!=='string'||input.cookie.length>128000)throw new Error('配置文件缺少 cookie 字段');
  const cookies=input.cookie.split(';').map(pair=>{const i=pair.indexOf('=');return i>0?{name:pair.slice(0,i).trim(),value:pair.slice(i+1).trim(),domain:'.douyin.com',path:'/',secure:true}:null;}).filter(Boolean);
  return validateAuth({cookies,userAgent:input.user_agent,source:'config'});
}
export class AuthVault{
  constructor(file,storage){this.file=file;this.storage=storage;}
  save(auth){if(!this.storage.isEncryptionAvailable())throw new Error('Windows 登录信息加密暂不可用，未保存登录配置');const body=this.storage.encryptString(JSON.stringify(validateAuth(auth)));fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',body);fs.renameSync(this.file+'.tmp',this.file);}
  load(){if(!fs.existsSync(this.file))return null;if(!this.storage.isEncryptionAvailable())return null;try{return validateAuth(JSON.parse(this.storage.decryptString(fs.readFileSync(this.file))));}catch{return null;}}
}
