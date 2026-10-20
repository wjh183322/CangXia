/** Lazily renew on a monotonic clock; no idle timer and no dependence on NAS clock skew. */
export class RestoreGrantSession{
 constructor(backup,command,initial,{signal,clock=()=>performance.now()}={}){Object.assign(this,{backup,command,signal,clock});this.install(initial);}
 install(value){if(value?.receipt){this.receipt=value.receipt;return;}if(!value?.grantId)throw Error('NAS 未提供恢复授权');const fallback=Date.parse(value.expiresAt)-Date.now(),ttl=Number.isFinite(value.ttlMs)?value.ttlMs:fallback;this.grantId=value.grantId;this.deadline=this.clock()+Math.min(30*60*1000,Math.max(0,ttl));}
 async ensure(){this.signal?.throwIfAborted();if(this.receipt)return this; if(this.deadline-this.clock()>5*60*1000)return this;if(!this.renewing)this.renewing=this.backup.prepareScopeRestore(this.command,{signal:this.signal}).then(value=>this.install(value)).finally(()=>this.renewing=null);await this.renewing;this.signal?.throwIfAborted();return this;}
 async context(value){await this.ensure();if(this.receipt)throw Object.assign(Error('NAS 已确认本次恢复'),{code:'RESTORE_ALREADY_DONE'});return {...value,grantId:this.grantId};}
}
