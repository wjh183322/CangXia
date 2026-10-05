// Electron fetch with redirect:'manual' rejects on redirects instead of exposing
// Location. Capture ClientRequest's redirect event before canceling this hop.
// The caller validates every destination before issuing the next request.
export function redirectHeaders(net,profile){
  return (url,{signal}={})=>new Promise((resolve,reject)=>{
    let request,settled=false;
    const finish=(error,result)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);
      if(error)reject(error);else resolve(result);
      request?.abort();
    };
    const cancel=()=>finish(signal.reason?.name==='TimeoutError'?new Error('解析主页分享链接超时，请稍后重试或使用完整主页链接'):signal.reason||new DOMException('读取已停止','AbortError'));
    if(signal?.aborted){cancel();return;}
    try{
      request=net.request({url,method:'GET',session:profile,redirect:'manual',credentials:'omit',cache:'no-store'});
      request.on('error',()=>finish(new Error('主页分享链接连接失败，请检查网络，或复制浏览器地址栏中的完整作者主页链接')));
      // Writable-stream close can arrive before Chromium's redirect event in
      // this Electron runtime. The caller's bounded signal handles no-response.
      request.on('redirect',(status,_method,location)=>finish(null,{status,headers:new Headers({location}),body:null}));
      request.on('response',response=>{
        // No HTML, cookies or media body is needed for share-link resolution.
        response.on('error',()=>{});
        const location=response.headers.location;finish(null,{status:response.statusCode,headers:new Headers(location?{location:Array.isArray(location)?location[0]:location}:{}),body:null});
      });
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){cancel();return;}
      request.end();
    }catch(e){finish(e);}
  });
}
