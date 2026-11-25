import { activityIconDefinitions } from './local-activity-icons';

export const activityPage = `${activityIconDefinitions}
<section id="activity-page" hidden aria-label="购买记录">
  <div id="activity-list-view">
    <div class="activity-toolbar"><p class="note">查看此 Agent 的购买、付款与交付结果。</p><button id="activity-refresh" type="button" class="secondary">刷新</button></div>
    <div id="purchase-list"></div>
  </div>
  <section id="activity-detail" hidden aria-labelledby="activity-detail-title"></section>
</section>`;

export const activityStyle = `
.activity-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0 24px}
.activity-toolbar button,.activity-back{min-width:0;min-height:36px;padding:6px 14px;font-size:12px}
.activity-section-label{color:var(--muted);font-size:10px;font-weight:600;letter-spacing:1.5px;margin:24px 0 12px}
.activity-rows{display:grid;gap:8px}
button.activity-row{display:grid;grid-template-columns:46px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-width:0;min-height:88px;padding:16px 14px;border:1px solid var(--line);border-radius:20px;background:#1e1e1b;color:inherit;text-align:left;white-space:normal}
button.activity-row:hover{background:#272722;border-color:#57564d}
.activity-identity,.activity-trailing{min-width:0;display:grid;gap:6px}
.activity-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.5}
.activity-context{display:block;color:var(--muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.activity-trailing{justify-items:end;max-width:160px;text-align:right}
.activity-amount{font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.4;overflow-wrap:anywhere}
.activity-unit{font-size:11px;color:var(--muted);margin-left:4px;white-space:nowrap}
.activity-badge{display:inline-block;max-width:100%;font-size:10px;font-weight:600;line-height:1.5;padding:4px 8px;border-radius:999px;color:#c1bbb0;background:#35342e;overflow-wrap:anywhere}
.activity-badge[data-tone="positive"]{color:#91cbc0;background:#233530}
.activity-badge[data-tone="pending"]{color:#dec492;background:#393225}
.activity-badge[data-tone="negative"]{color:#e8a0a6;background:#39292b}
.activity-icon{position:relative;display:block;width:46px;height:46px;flex:none}
.activity-icon svg{display:block;width:100%;height:100%}
.activity-host{position:absolute;top:0;left:0;width:40px;height:40px;border-radius:50%;background:#000;color:#fff;padding:1px}
.activity-host.is-generic{padding:8px}
.activity-network{position:absolute;right:0;bottom:0;width:26px;height:26px;border:2px solid #191917;border-radius:50%;background:#000;color:#fff;padding:5px}
.activity-icon-definitions{position:absolute;width:0;height:0;overflow:hidden}
.activity-back{margin:18px 0 24px;background:transparent;color:var(--muted);border-color:transparent;padding-left:0;text-align:left}
.activity-back:hover{background:transparent;color:#f2eee6;border-color:transparent}
.activity-detail-top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
.activity-agent{display:flex;align-items:center;gap:12px;min-width:0}
#activity-detail-title{font-family:inherit;font-size:21px;line-height:1.45;font-weight:500;overflow-wrap:anywhere;white-space:normal;margin:0 0 20px;max-width:100%}
#activity-detail-title:focus{outline:none}
.activity-total{font-family:"Instrument Serif",Georgia,serif;font-size:42px;line-height:1.2;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;margin:0 0 8px}
.activity-total .activity-unit{font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC",sans-serif;font-size:14px;margin-left:10px}
.activity-outcome{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:22px 0;margin:26px 0}
.activity-outcome .activity-section-label{margin-top:0}
.activity-facts{grid-template-columns:90px minmax(0,1fr);gap:14px;font-size:12px;line-height:1.6}
.activity-explanation{font-size:12px;line-height:1.8;color:var(--muted);margin:18px 0 0}
.activity-disclosure{border-bottom:1px solid var(--line);margin:0;padding:4px 0}
.activity-disclosure>summary{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;color:#e3ded4;font-size:13px}
.activity-disclosure>summary::after{margin-left:auto}
.activity-disclosure>summary>svg{width:18px;height:18px;flex:none}
.activity-disclosure .activity-facts{padding:8px 0 20px}
.activity-empty{padding:36px 0;text-align:center;color:var(--muted);line-height:1.8}
@media(max-width:440px){button.activity-row{grid-template-columns:40px minmax(0,1fr);gap:8px 12px;padding:14px 12px}.activity-row>.activity-icon{grid-row:1 / 3;align-self:start}.activity-trailing{grid-column:2;display:flex;align-items:center;justify-content:space-between;gap:10px;max-width:none;text-align:left;flex-wrap:wrap}.activity-detail-top{align-items:flex-start;flex-wrap:wrap}#activity-detail-title{font-size:19px}.activity-total{font-size:36px}}
@media(forced-colors:active){button.activity-row,.activity-badge,.activity-outcome,.activity-disclosure{border-color:CanvasText}.activity-badge{border:1px solid CanvasText}}
`;

// This is the browser presentation boundary. It only reads the already scoped
// /state response; opening a row never executes or recovers a payment.
export const activityScript = String.raw`
let activityState=null,activitySelection=null,activityReturn=null,activityScroll=null;
function activityNode(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function activitySvg(symbol){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#'+symbol);svg.append(use);return svg;}
function activityIcon(agent,environment,network){
  const icon=activityNode('span','activity-icon'),known=['codex','openai','openai codex'].includes(agent.trim().toLowerCase());
  icon.setAttribute('aria-hidden','true');
  const host=activityNode('span','activity-host'+(known?'':' is-generic'));
  host.append(activitySvg(known?'activity-host-codex':'activity-host-generic'));
  const badge=activityNode('span','activity-network');
  const solana=network?['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1','solana:devnet'].includes(network):['mainnet','devnet'].includes(environment);
  badge.append(activitySvg(solana?'activity-network-solana':'activity-network-generic'));icon.append(host,badge);return icon;
}
function activityOutcome(p,environment){
  const status=p.status||p.paymentStatus;
  if(p.deliveryStatus==='COMPLETE'&&['PAYING','PAYMENT_UNKNOWN'].includes(p.paymentStatus))return {label:'已交付 · 付款核对中',tone:'pending',note:'API 结果已保存，可以用原购买编号读取。Yosh 正在核对链上付款。'};
  if(p.deliveryStatus==='COMPLETE'&&p.paymentStatus==='FAILED')return {label:'已交付 · 付款失败',tone:'negative',note:'API 结果已保存。链上核对显示原付款失败。'};
  if(p.paymentStatus==='PAYMENT_UNKNOWN')return {label:'核对原付款',tone:'pending',note:'付款结果尚未确定。保留原购买记录与预占额度，勿新建替代付款。'};
  if(p.paymentStatus==='PAID'){
    if(environment==='offline')return {label:p.deliveryStatus==='COMPLETE'?'模拟完成':'模拟付款',tone:'neutral',note:'离线测试记录，不代表真实资金付款。'};
    if(p.deliveryStatus==='COMPLETE')return {label:'已交付',tone:'positive',note:'付款已确认，API 结果已交付。'};
    if(['PENDING','DELIVERING'].includes(p.deliveryStatus))return {label:'已付款 · 交付中',tone:'pending',note:'付款已确认，正在获取 API 结果。'};
    if(p.deliveryStatus==='EXHAUSTED')return {label:'已付款 · 未取回结果',tone:'pending',note:'付款已确认，但结果尚未取回。'};
    if(p.deliveryStatus==='UNSUPPORTED')return {label:'已付款 · 无自动恢复',tone:'pending',note:'付款已确认，此 API 不支持自动恢复结果。'};
    return {label:'已付款',tone:'positive',note:'付款已确认；交付状态请以下方记录为准。'};
  }
  const labels={DENIED:['已拒绝','negative'],REQUIRES_APPROVAL:['待批准','pending'],EXPIRED:['已过期','neutral'],PAYING:['付款中','pending'],FAILED:['付款失败','negative'],APPROVED:['已允许','neutral'],NOT_STARTED:['尚未付款','neutral']};
  const [label,tone]=labels[status]||['状态待核对','neutral'];return {label,tone,note:status==='APPROVED'?'策略已允许，不代表已经付款。':status==='PAYING'?'正在处理这笔付款，请保留原购买标识。':''};
}
function activityBadge(outcome){const badge=activityNode('span','activity-badge',outcome.label);badge.setAttribute('data-tone',outcome.tone);return badge;}
function activityName(p,state){return state.resources.find(resource=>resource.resourceId===p.resourceId)?.displayName||p.resourceId||'购买记录';}
function activityContext(state){return state.member.label+' · '+({mainnet:'Mainnet',devnet:'Devnet · 测试资产',offline:'Offline · 无真实资金'}[state.environment]||'环境待核对');}
function activityAmount(p,state,className){
  // The legacy Mainnet web response is scoped to USDC and omits asset metadata.
  // Newer/read-only records with explicit metadata must not be relabeled USDC.
  const explicit=p.assetDecimals!==undefined;
  const decimals=explicit?p.assetDecimals:6;
  const digits=String(p.amount);
  if(!/^\d+$/.test(digits)||!Number.isInteger(decimals)||decimals<0||decimals>18)return activityNode('span',className,'金额待核对');
  const padded=digits.padStart(decimals+1,'0'),whole=decimals?padded.slice(0,-decimals):padded;
  const fraction=decimals?padded.slice(-decimals).replace(/0+$/,'').padEnd(Math.min(2,decimals),'0'):'';
  const amount=activityNode('span',className,whole+(fraction?'.'+fraction:''));
  const mainnet=p.network==='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'&&p.assetId==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const devnet=p.network==='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'&&p.assetId==='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const unit=explicit?(decimals===6&&(mainnet||devnet)?(mainnet&&state.environment==='mainnet'?'USDC':'Test USDC'):'资产单位'):(state.environment==='mainnet'?'USDC':'Test USDC');
  amount.append(activityNode('span','activity-unit',unit));return amount;
}
function activityFacts(rows){const list=activityNode('dl','activity-facts');for(const [name,value] of rows)list.append(activityNode('dt','',name),activityNode('dd','',value));return list;}
function activityDisclosure(label,rows,symbol){const details=activityNode('details','activity-disclosure'),summary=activityNode('summary');summary.append(activitySvg(symbol),activityNode('span','',label));details.append(summary,activityFacts(rows));return details;}
function closeActivityDetail(focus=false){
  activitySelection=null;yoshMotion.cancelWithin(element('activity-detail'));element('activity-detail').hidden=true;element('activity-list-view').hidden=false;
  if(focus){yoshMotion.restoreScroll(activityScroll);activityReturn?.focus({preventScroll:true});yoshMotion.enter(element('activity-list-view'),{direction:-1,back:true});}
}
function openActivityDetail(p,focus=true){
  const state=activityState;if(!state)return;activitySelection=p.purchaseId;
  if(focus)activityScroll=yoshMotion.rememberScroll();
  yoshMotion.cancelWithin(element('activity-list-view'));const detail=element('activity-detail');yoshMotion.cancelWithin(detail);detail.replaceChildren();
  const back=activityNode('button','activity-back','‹ 返回购买记录');back.type='button';back.addEventListener('click',()=>closeActivityDetail(true));
  const top=activityNode('div','activity-detail-top'),agent=activityNode('div','activity-agent'),outcome=activityOutcome(p,state.environment);
  agent.append(activityIcon(state.member.label,state.environment,p.network),activityNode('span','activity-context',activityContext(state)));top.append(agent,activityBadge(outcome));
  const title=activityNode('h2','',activityName(p,state));title.id='activity-detail-title';title.tabIndex=-1;
  const payment=p.paymentStatus==='PAID'&&state.environment==='offline'?'模拟付款':({PAID:'已付款',PAYING:'付款中',PAYMENT_UNKNOWN:'结果未知',FAILED:'失败'}[p.paymentStatus]||'尚未付款');
  const delivery=state.environment==='offline'&&p.deliveryStatus==='COMPLETE'?'模拟交付':({NOT_PAID:'尚未交付',PENDING:'等待获取结果',DELIVERING:'正在获取结果',COMPLETE:'已交付',EXHAUSTED:'结果未取回',UNSUPPORTED:'不支持自动恢复'}[p.deliveryStatus]||'状态待核对');
  const result=activityNode('section','activity-outcome');result.append(activityNode('h3','activity-section-label','付款与交付'),activityFacts([['付款',payment],['交付',delivery]]));
  if(outcome.note)result.append(activityNode('p','activity-explanation',outcome.note));
  const transaction=[['购买 ID',p.purchaseId],['网络',p.network||({mainnet:'Solana Mainnet',devnet:'Solana Devnet',offline:'Offline · 测试环境'}[state.environment]||'未提供')]];
  if(p.operationId)transaction.push(['操作 ID',p.operationId]);if(p.transaction)transaction.push(['链上交易',p.transaction]);if(p.policyCode)transaction.push(['策略结果',p.policyCode]);if(p.assetId)transaction.push(['资产标识',p.assetId]);
  detail.append(back,top,title,activityAmount(p,state,'activity-total'),activityNode('p','note','购买金额'),result,activityDisclosure('交易详情',transaction,'activity-document'),activityDisclosure('API 与资源',[['API',activityName(p,state)],['资源 ID',p.resourceId]],'activity-resource'));
  element('activity-list-view').hidden=true;detail.hidden=false;if(focus){title.focus({preventScroll:true});title.scrollIntoView?.({block:'nearest',behavior:'instant'});yoshMotion.enter(detail);}
}
function renderActivity(state){
  const sameScope=activityState?.environment===state.environment&&activityState?.member.id===state.member.id;
  if(!sameScope)closeActivityDetail();activityState=state;
  const list=element('purchase-list');list.replaceChildren();
  if(!state.purchases.length){list.append(activityNode('p','activity-empty','此网络暂无购买记录。'));closeActivityDetail();return;}
  // The current web contract omits timestamps; do not invent dates from IDs or
  // group historical purchases under today's date. Preserve backend ordering.
  list.append(activityNode('h2','activity-section-label','最近购买'));
  const rows=activityNode('div','activity-rows');
  for(const p of state.purchases){
    const row=activityNode('button','activity-row');row.type='button';
    const identity=activityNode('span','activity-identity'),name=activityNode('span','activity-name',activityName(p,state));name.title=activityName(p,state);
    identity.append(name,activityNode('span','activity-context',activityContext(state)));
    const trailing=activityNode('span','activity-trailing');trailing.append(activityAmount(p,state,'activity-amount'),activityBadge(activityOutcome(p,state.environment)));
    row.append(activityIcon(state.member.label,state.environment,p.network),identity,trailing);
    row.addEventListener('click',()=>{activityReturn=row;openActivityDetail(p);});rows.append(row);
    if(p.purchaseId===activitySelection)activityReturn=row;
  }
  list.append(rows);
  if(activitySelection){const selected=state.purchases.find(p=>p.purchaseId===activitySelection);if(selected)openActivityDetail(selected,false);else closeActivityDetail();}
}
element('activity-refresh').addEventListener('click',async()=>{if(awaiting||preparing)return;const button=element('activity-refresh');button.disabled=true;try{await refresh(false);status('');}catch(error){status(error.message);}finally{button.disabled=false;}});
`;
