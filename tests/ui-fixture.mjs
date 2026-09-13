import fs from 'node:fs';
import path from 'node:path';
export function fixturePlugin(){
  return {name:'local-ui-test-only',apply:'serve',configureServer(server){
    server.middlewares.use((req,res,next)=>{
      if(!req.url?.startsWith('/__test__/'))return next();
      const source=path.resolve('.test-output/sample-result.json');
      if(!fs.existsSync(source)){res.statusCode=404;return res.end('Sample test has not run');}
      const result=JSON.parse(fs.readFileSync(source,'utf8'));if(!result.work){res.statusCode=404;return res.end('No verified sample');}
      const sample=result.work;
      if(req.url==='/__test__/snapshot'){
        const works=Array.from({length:30},(_,i)=>({...sample,id:String(1000+i),name:`界面测试作品 ${i+1}`,type:i%3===0?'images':'video',images:i%3===0?[{index:0}]:[],author:{...sample.author,nickname:i%2?'测试作者乙':'测试作者甲',uid:String(i%2+1)},tags:i%2?['摄影']:['cos','fgo'],localTags:i%4===0?['待整理']:[],thumbnail:'/__test__/asset/cover',downloaded:i<4,local:i<4,localRecord:i<4?{...sample.localRecord,collectionId:'9',coverWarning:'原始单图仅 360×640，尚未取得更高清版本',assets:sample.localRecord.assets.map(a=>({...a,url:'/__test__/asset/'+a.key,width:a.kind==='image'?360:undefined,height:a.kind==='image'?640:undefined}))}:null}));
        const snapshot={works,collections:[{id:'__all__',name:'收藏',added:true,count:30,complete:true},{id:'9',name:'界面测试收藏夹',added:true,count:30,complete:true},{id:'10',name:'尚未添加（测试）',added:false,count:0}],members:{__all__:works.map(w=>w.id),'9':works.map(w=>w.id)},root:'界面测试目录（非账号数据）',account:null,version:'0.1.0',collector:{phase:'done',message:'界面测试数据 · 30 个虚构条目'},queue:{jobs:[],paused:false}};
        res.setHeader('content-type','application/json');return res.end(JSON.stringify(snapshot));
      }
      const key=req.url.slice('/__test__/asset/'.length);const asset=sample.localRecord.assets.find(a=>a.key===key);
      if(!asset||!['video','cover'].includes(key)){res.statusCode=404;return res.end();}
      const file=path.join(sample.localRecord.path,asset.file);
      if(!file.startsWith(path.resolve('.test-output')+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
      const bytes=fs.statSync(file).size;res.setHeader('content-type',key==='video'?'video/mp4':'image/jpeg');res.setHeader('accept-ranges','bytes');
      let start=0,end=bytes-1;const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if(range){start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),bytes-1):bytes-1;if(start>end){res.statusCode=416;return res.end();}res.statusCode=206;res.setHeader('content-range',`bytes ${start}-${end}/${bytes}`);}
      res.setHeader('content-length',end-start+1);fs.createReadStream(file,{start,end}).pipe(res);
    });
  }};
}
