// NAS operations consume the same prepared scope and confirmation as local removal.
export class NASRemoval{
 constructor({store,coordinator}){this.store=store;this.coordinator=coordinator;const old=store.getSetting('nasRemovalJob');this.legacy=old?{running:false,phase:'interrupted',processed:old.processed||0,total:old.ids?.length||0,message:'旧版 NAS 操作未自动继续，请按新范围重新确认'}:null;}
 state(){return this.coordinator?.state()||this.legacy;}
 prepare(input){if(!this.coordinator)throw Error('删除与恢复入口尚未就绪');return this.coordinator.prepare({...input,target:'local-nas'});}
 confirm(token){if(!this.coordinator)throw Error('删除与恢复入口尚未就绪');return this.promise=this.coordinator.confirm(token);}
 start(){throw Error('请先选择删除内容和范围并确认，旧版删除入口已停用');}
 cancel(){this.coordinator?.stop();return this.state();}
 retry(operationId){if(!this.coordinator)throw Error('删除与恢复入口尚未就绪');return this.promise=this.coordinator.retry(operationId);}
 async wait(){await this.promise;}
}
