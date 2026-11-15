/* Graphical Grant review — local design preview only. */
(() => {
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const svg=(type)=>{
    const e=document.createElementNS('http://www.w3.org/2000/svg','svg');
    e.setAttribute('viewBox','0 0 24 24');e.setAttribute('fill','none');e.setAttribute('stroke','currentColor');e.setAttribute('stroke-width','1.5');e.setAttribute('stroke-linecap','round');e.setAttribute('stroke-linejoin','round');e.setAttribute('aria-hidden','true');
    const paths={market:'<path d="M4 19h16M6 15v-4m6 4V7m6 8V4"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',api:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',single:'<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6m-6 4h6m-6 4h3"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',shield:'<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z"/><path d="m9 12 2 2 4-4"/>'};
    e.innerHTML=paths[type]||paths.api;return e;
  };
  const amount=(value)=>{const match=/^(.*?) (Test USDC|USDC)$/.exec(value);return match?{number:match[1],unit:match[2]}:{number:value,unit:''};};
  const scroll = node('div','proof-scroll');
  const factsNode=element('facts'),networkDetails=element('details').parentElement;
  factsNode.before(scroll);scroll.append(factsNode,networkDetails);
  const originalFacts=facts;
  facts=rows=>{
    originalFacts(rows);
    const root=element('facts');root.classList.remove('grant-proof');
    if(!reviewed?.binding?.input||reviewed.action)return;
    const values=new Map(rows);
    const total=amount(values.get('授权总额')||'未设置'),single=amount(values.get('单笔上限')||'未设置');
    root.replaceChildren();root.classList.add('grant-proof');
    const party=(label,name,kind)=>{
      const group=node('div','proof-party proof-party-'+kind),term=node('dt','proof-party-label',label),definition=node('dd');
      const icon=node('span','proof-party-icon');icon.setAttribute('aria-hidden','true');
      if(kind==='agent')icon.append(activitySvg(/codex/i.test(name)?'activity-host-codex':'activity-host-generic'));
      else icon.append(svg(/market|价格/i.test(name)?'market':/research|search|搜索/i.test(name)?'search':'api'));
      definition.append(icon,node('span','proof-party-name',name));group.append(term,definition);return group;
    };
    root.append(party('授权给',values.get('Agent')||'Agent','agent'),party('仅限此 API',values.get('API')||'API','api'));
    const hero=node('div','proof-hero');hero.append(node('dt','proof-hero-label','授权总额'));
    const money=node('dd','proof-money'),coin=node('img','proof-token');coin.src='/token-icons/usdc.svg';coin.alt='';coin.width=36;coin.height=36;
    money.append(coin,node('span','proof-money-number',total.number),node('span','proof-money-unit',total.unit));
    hero.append(money,node('dd','proof-money-caption','这份 Grant 有效期内的累计消费上限'));root.append(hero);
    const constraint=(label,icon)=>{const group=node('div','proof-constraint');const term=node('dt');term.append(svg(icon),node('span','',label));group.append(term);root.append(group);return group;};
    const limit=constraint('每笔最多','single'),limitValue=node('dd','proof-limit-value');limitValue.append(node('span','',single.number),node('span','proof-small-unit',single.unit));limit.append(limitValue);
    const expiry=constraint('有效至','clock'),dateValue=reviewed.binding.input.expiresAt,date=new Date(dateValue);
    if(Number.isFinite(date.getTime())){
      const formatter=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZoneName:'short'});
      const parts=formatter.formatToParts(date),part=type=>parts.find(p=>p.type===type)?.value||'';
      const value=node('dd','proof-expiry');value.append(node('span','proof-expiry-date',part('year')+'.'+part('month')+'.'+part('day')),node('span','proof-expiry-time',part('hour')+':'+part('minute')+':'+part('second')+' '+part('timeZoneName')));expiry.append(value);
    }else expiry.append(node('dd','proof-expiry',values.get('有效至')||'未设置'));
    const network=node('div','proof-network');network.append(node('dt','proof-sr-only','环境'));const environment=node('dd');environment.append(activitySvg('activity-network-solana'),node('span','',values.get('环境')||'待核对'));network.append(environment);root.append(network);
  };
  const originalReview=review;
  review=(frozen,prefix,rows,detailText)=>{
    originalReview(frozen,prefix,rows,detailText);
    const graphical=element('facts').classList.contains('grant-proof');
    element('grant-dialog').classList.toggle('graphical-grant-review',graphical);
    if(!graphical)return;
    if(element('dialog-status').textContent==='请核对以下内容，再进行系统确认。')status('');
    const summary=element('details').parentElement.querySelector('summary');
    summary.replaceChildren(svg('shield'),node('span','','网络与收款方'));
    const note=element('review').querySelector('.action-bar .note');note.replaceChildren(node('span','','系统确认后生效 · 不会立即付款'));
    if(paused){note.append(node('br'),node('span','','付款仍保持暂停。'));}
  };
})();
