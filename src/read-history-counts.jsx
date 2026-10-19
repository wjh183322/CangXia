import React from 'react';
import {normalizeReadSummary} from '../shared/read-summary.mjs';
const number=value=>Number(value||0).toLocaleString('zh-CN');
const recorded=value=>Number.isFinite(value)?number(value):'未区分';
const split=(s,key)=>s.initialAdded>0&&!s.hasPrevious?'—':s[key]===null?'未区分':number(s[key]);

export function ReadCountLine({summary,as:Tag='p'}){
 const s=normalizeReadSummary(summary);
 return <Tag className="read-log-counts">本轮读取 {number(s.checked)} · 前面新增 {split(s,'frontAdded')} · 本轮补齐 {split(s,'filled')} · 本轮新增 {recorded(s.added)} · 已有记录 {recorded(s.existing)}</Tag>;
}
export function ReadCountTiles({summary}){
 const s=normalizeReadSummary(summary);
 return <><div className="read-result-counts">{[['本轮读取',number(s.checked)],['前面新增',split(s,'frontAdded')],['本轮补齐',split(s,'filled')],['本轮新增',recorded(s.added)],['已有记录',recorded(s.existing)]].map(([label,value])=><div key={label}><strong>{value}</strong>{label}</div>)}</div><p className="muted small">本轮读取按作品 ID 去重，包含已有记录与本轮新增。{s.initialAdded>0&&!s.hasPrevious?'首次建库单独记录首次读入，不划分前面新增与补齐。':'本轮新增 = 前面新增 + 本轮补齐，按当前收藏夹或作者列表统计。'}</p></>;
}
export function ReadReturnNote({summary}){
 return summary.reappeared>0?<p className="muted small">其中 {number(summary.reappeared)} 条历史记录本轮再次读到，已计入已有记录，不计入本轮新增或补齐。这不代表作品曾失效或已经恢复播放。</p>:null;
}
