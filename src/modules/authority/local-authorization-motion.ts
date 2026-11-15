/** Motion only: current controls, colors, labels, and layout remain unchanged.
 * Reference: https://60fps.design/shots/phantom-bottom-tabs-icon-animation
 * The public clip informs continuity and contact feedback. These timings and
 * spring coefficients are Yosh's adaptation, not extracted proprietary specs.
 */
export const motionStyle = `
#page-navigation{position:relative;isolation:isolate}
#navigation-highlight{position:absolute;top:0;left:0;pointer-events:none;border:1px solid #414139;border-radius:999px;background:#30302a;transform-origin:0 50%}
#page-navigation button{position:relative;z-index:1;transform:none}
#page-navigation[data-motion="ready"] button[aria-pressed="true"]{background:transparent;border-color:transparent}
.navigation-label{display:inline-block;transform-origin:50% 70%;transition:transform 180ms cubic-bezier(.23,1,.32,1)}
#page-navigation button:active:not(:disabled) .navigation-label{transform:scale(.94,.9);transition-duration:65ms}
button{transition:transform 180ms cubic-bezier(.23,1,.32,1),background-color 140ms var(--ease),border-color 140ms var(--ease),opacity 140ms var(--ease)}
button:active:not(:disabled){transform:scale(.975);transition-duration:65ms}
button.activity-row:active:not(:disabled){transform:translateY(1px)}
.activity-disclosure>summary>svg{transition:transform 280ms cubic-bezier(.2,1.2,.35,1)}
.activity-disclosure>summary:active>svg{transform:scale(.93)}
summary::after{transition:transform 260ms cubic-bezier(.2,1.25,.35,1)}
#editor:not([hidden]),#review:not([hidden]){animation:none}
@media(prefers-reduced-motion:reduce){.navigation-label{transition:none!important;transform:none!important}}
@media(forced-colors:active){#navigation-highlight{border-color:CanvasText;background:Canvas}}
`;

export const motionScript = String.raw`
const yoshMotion=(()=>{
  const preference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduced=preference?.matches??true;
  const animations=new Map(),disclosures=new Map(),swaps=new Map();
  let keyboard=false;
  document.addEventListener?.('keydown',()=>{keyboard=true;},true);
  document.addEventListener?.('pointerdown',()=>{keyboard=false;},true);
  const nav=document.getElementById('page-navigation'),highlight=document.getElementById('navigation-highlight');
  const buttons=Array.from(document.querySelectorAll('[data-page]'));
  let activeButton=null,frame=0,lastTime=null,initialized=false,baseWidth=1,y=0;
  const position={value:0,velocity:0,target:0},width={value:0,velocity:0,target:0};
  function draw(){const stretch=Math.min(Math.abs(position.velocity)*.012,8),left=position.value-(position.velocity<0?stretch:0);highlight.style.transform='translate3d('+left+'px,'+y+'px,0) scaleX('+((width.value+stretch)/baseWidth)+')';}
  function stopFrame(){if(frame)globalThis.cancelAnimationFrame(frame);frame=0;lastTime=null;}
  function settleIndicator(){stopFrame();for(const axis of [position,width]){axis.value=axis.target;axis.velocity=0;}if(initialized)draw();}
  function tick(now){
    frame=0;const elapsed=lastTime===null?1/60:Math.min((now-lastTime)/1000,.032);lastTime=now;
    // Substeps keep the spring stable at slower refresh rates. A new selection
    // changes targets only, retaining the current position and velocity.
    const steps=Math.max(1,Math.ceil(elapsed*120)),dt=elapsed/steps;
    for(let i=0;i<steps;i++)for(const axis of [position,width]){axis.velocity+=(680*(axis.target-axis.value)-42*axis.velocity)*dt;axis.value+=axis.velocity*dt;}
    draw();
    if([position,width].every(axis=>Math.abs(axis.target-axis.value)<.1&&Math.abs(axis.velocity)<.8)){settleIndicator();return;}
    frame=globalThis.requestAnimationFrame(tick);
  }
  function selectTab(button,animate=true){
    if(!nav||!highlight||!button||!button.offsetWidth)return;
    activeButton=button;position.target=button.offsetLeft;width.target=button.offsetWidth;y=button.offsetTop;
    if(!initialized){baseWidth=button.offsetWidth;highlight.style.width=baseWidth+'px';initialized=true;}
    highlight.style.height=button.offsetHeight+'px';highlight.hidden=false;nav.setAttribute('data-motion','ready');
    if(reduced||keyboard||!animate||typeof globalThis.requestAnimationFrame!=='function'){settleIndicator();return;}
    if(!frame){lastTime=null;frame=globalThis.requestAnimationFrame(tick);}
  }
  function cancelAnimation(node){const animation=animations.get(node);if(animation){animations.delete(node);animation.cancel();}}
  function enter(node,{direction=1,back=false}={}){
    if(!node)return;cancelAnimation(node);
    if(reduced||keyboard||node.hidden||typeof node.animate!=='function')return;
    const animation=node.animate([
      {opacity:.35,transform:'translate3d('+(direction*(back?6:10))+'px,0,0)'},
      {opacity:1,transform:'translate3d(0,0,0)'}
    ],{duration:back?180:260,easing:'cubic-bezier(.16,1,.3,1)'});
    animations.set(node,animation);
    animation.finished.then(()=>{if(animations.get(node)===animation)animations.delete(node);},()=>{});
  }
  function finishSwap(parent){
    const state=swaps.get(parent);if(!state)return;
    swaps.delete(parent);state.ghost.remove();for(const animation of state.animations)animation.cancel();
    parent.style.overflow=state.overflow;
  }
  // Only an inert visual copy exits. Real controls change state synchronously,
  // so presentation never delays cancellation or replays a management request.
  function capture(from){
    const parent=from?.parentElement;
    if(reduced||keyboard||!parent||from.hidden||typeof from.cloneNode!=='function'||typeof parent.animate!=='function'){if(parent)finishSwap(parent);return ()=>{};}
    const height=parent.getBoundingClientRect().height;
    if(!height)return ()=>{};
    const previous=swaps.get(parent),continuing=Boolean(previous);
    const visible=Number(globalThis.getComputedStyle(from).opacity);
    const opacity=String(previous?Math.min(1,visible+Number(globalThis.getComputedStyle(previous.ghost).opacity)):visible);
    const transform=globalThis.getComputedStyle(from).transform;
    finishSwap(parent);
    const ghost=from.cloneNode(true);
    for(const node of [ghost,...ghost.querySelectorAll('[id]')]){if(node.id){node.setAttribute('data-motion-source',node.id);node.removeAttribute('id');}}
    ghost.inert=true;ghost.setAttribute('aria-hidden','true');ghost.classList.add('motion-ghost');
    Object.assign(ghost.style,{position:'absolute',top:from.offsetTop+'px',left:from.offsetLeft+'px',width:from.offsetWidth+'px',margin:'0',opacity,transform,pointerEvents:'none'});
    parent.append(ghost);
    const state={ghost,animations:[],overflow:parent.style.overflow};swaps.set(parent,state);
    return (to,{direction=1,back=false,fluid=false}={})=>{
      if(swaps.get(parent)!==state)return;
      if(!to||to.hidden||reduced||keyboard){finishSwap(parent);return;}
      cancelAnimation(to);parent.style.overflow='clip';
      const duration=fluid?280:back?180:240,easing='cubic-bezier(.23,1,.32,1)';
      try{
        state.animations.push(ghost.animate([{opacity,transform},{opacity:0,transform:'translateX('+(-direction*6)+'px)'}],{duration:fluid?140:90,easing,fill:'forwards'}));
        const entry=fluid?[{opacity:continuing?Math.max(0,1-Number(opacity)):0,transform:'translateX('+(direction*6)+'px)'},{opacity:1,transform:'translateX(0)'}]:[{opacity:0,transform:'translateX('+(direction*6)+'px)',offset:0},{opacity:0,transform:'translateX('+(direction*4)+'px)',offset:.12},{opacity:1,transform:'translateX(0)',offset:1}];
        state.animations.push(to.animate(entry,{duration,easing}));
        // One bounded container resize avoids a page jump between differently
        // sized steps. Text itself is never stretched or scaled.
        const targetHeight=parent.getBoundingClientRect().height;
        // Critically damp the shared surface using the tab spring's stiffness.
        // Text stays unscaled, and normalization lands exactly at the target.
        const omega=Math.sqrt(680),response=t=>1-(1+omega*t)*Math.exp(-omega*t),end=response(duration/1000);
        const heights=fluid?Array.from({length:37},(_,i)=>({height:(height+(targetHeight-height)*response(duration*i/36000)/end)+'px',offset:i/36})):[{height:height+'px'},{height:targetHeight+'px'}];
        state.animations.push(parent.animate(heights,{duration,easing:fluid?'linear':easing}));
        Promise.all(state.animations.map(animation=>animation.finished)).then(()=>{if(swaps.get(parent)===state)finishSwap(parent);},()=>{});
      }catch{finishSwap(parent);}
    };
  }
  function finishDisclosure(details,state){
    if(disclosures.get(details)!==state)return;
    disclosures.delete(details);details.open=state.open;state.animation?.cancel();
    details.style.overflow=state.overflow;
    for(const [child,inert] of state.children)child.inert=inert;
  }
  function toggleDisclosure(details,summary){
    const previous=disclosures.get(details),open=!(previous?.open??details.open);
    const from=details.getBoundingClientRect().height;
    previous?.animation?.cancel();
    const children=previous?.children||Array.from(details.children).filter(child=>child!==summary).map(child=>[child,child.inert]);
    const state={open,children,overflow:previous?.overflow??details.style.overflow,animation:null};
    disclosures.set(details,state);
    // Native details still owns expansion and keyboard semantics. While a
    // close settles, its contents cannot receive focus or submit an action.
    for(const [child,inert] of children)child.inert=open?inert:true;
    if(!open&&children.some(([child])=>child.contains(document.activeElement)))summary.focus({preventScroll:true});
    details.open=open;
    const to=details.getBoundingClientRect().height;
    details.open=true;details.style.overflow='clip';
    try{
      state.animation=details.animate([{height:from+'px'},{height:to+'px'}],{duration:open?240:170,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});
      state.animation.finished.then(()=>finishDisclosure(details,state),()=>{});
    }catch{finishDisclosure(details,state);}
  }
  let dialogMorph=null;
  function morphDialog(open,done=()=>{},origin=null){
    const dialog=document.getElementById('grant-dialog'),surface=document.getElementById('grant-surface'),body=document.getElementById('grant-body'),trigger=origin?.isConnected?origin:document.getElementById('open-grant');
    dialog.setAttribute('data-closing',String(!open));
    const previous=dialogMorph;
    const current=previous&&surface?getComputedStyle(surface).transform:null;
    const opacity=previous&&body?getComputedStyle(body).opacity:null;
    if(previous){dialogMorph=null;for(const animation of previous.animations)animation.cancel();}
    if(body)body.inert=!open;
    if(reduced||keyboard||typeof surface?.animate!=='function'||!trigger?.getBoundingClientRect){if(body)body.inert=false;done();return;}
    const destination=dialog.getBoundingClientRect(),source=trigger.getBoundingClientRect();
    if(!destination.width||!destination.height){if(body)body.inert=false;done();return;}
    // Only the empty surface scales. Form text keeps its final size and enters
    // once there is room to read it, rather than stretching with the container.
    const compact='translate('+(source.left-destination.left)+'px,'+(source.top-destination.top)+'px) scale('+(source.width/destination.width)+','+(source.height/destination.height)+')';
    const state={animations:[],finish:()=>{if(dialogMorph!==state)return;dialogMorph=null;for(const animation of state.animations)animation.cancel();body.inert=false;done();}};
    dialogMorph=state;
    state.animations.push(surface.animate([{transform:current||(open?compact:'none')},{transform:open?'none':compact}],{duration:open?280:220,easing:'cubic-bezier(.23,1,.32,1)',fill:'both'}));
    state.animations.push(body.animate([{opacity:opacity||(open?0:1),transform:open?'translateY(6px)':'none'},{opacity:open?1:0,transform:open?'none':'translateY(4px)'}],{duration:open?180:100,delay:open&&!previous?70:0,easing:'cubic-bezier(.23,1,.32,1)',fill:'both'}));
    Promise.all(state.animations.map(animation=>animation.finished)).then(state.finish,()=>{});
  }
  function cancelWithin(node){
    for(const [parent] of swaps)if(parent===node||node?.contains?.(parent))finishSwap(parent);
    for(const [child] of animations)if(child===node||node?.contains?.(child))cancelAnimation(child);
    for(const [details,state] of disclosures)if(details===node||node?.contains?.(details))finishDisclosure(details,state);
  }
  document.addEventListener?.('click',event=>{
    const summary=event.target.closest?.('summary'),details=summary?.parentElement;
    if(reduced||event.defaultPrevented||event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||details?.tagName!=='DETAILS'||typeof details.animate!=='function')return;
    event.preventDefault();toggleDisclosure(details,summary);
  });
  preference?.addEventListener('change',event=>{
    reduced=event.matches;
    if(reduced){dialogMorph?.finish();for(const [parent] of swaps)finishSwap(parent);settleIndicator();for(const [node] of animations)cancelAnimation(node);for(const [details,state] of disclosures)finishDisclosure(details,state);}
  });
  if(buttons.length){
    selectTab(buttons.find(button=>button.getAttribute('aria-pressed')==='true')||buttons[0],false);
    if(typeof globalThis.ResizeObserver==='function'){
      const resize=new ResizeObserver(()=>selectTab(activeButton,false));resize.observe(nav);for(const button of buttons)resize.observe(button);
    }
  }
  return {selectTab,enter,capture,cancelWithin,morphDialog,
    rememberScroll:()=>({left:globalThis.scrollX||0,top:globalThis.scrollY||0}),
    restoreScroll:position=>{if(position)globalThis.scrollTo?.({...position,behavior:'instant'});}
  };
})();
`;
