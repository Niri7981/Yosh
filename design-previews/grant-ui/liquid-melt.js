/* Experimental liquid motion for the design preview only. */
(() => {
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  let keyboard=false;
  document.addEventListener('keydown',()=>{keyboard=true},true);
  document.addEventListener('pointerdown',()=>{keyboard=false},true);
  if(!CSS.supports('mask-image','url("#test")'))return;
  const originalCapture=yoshMotion.capture,swaps=new Map();
  const ns='http://www.w3.org/2000/svg';
  let serial=0;
  function makeMask(width,height,direction){
    const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('width','0');svg.setAttribute('height','0');
    svg.setAttribute('aria-hidden','true');svg.style.position='absolute';
    const id='liquid-page-'+(++serial),filter=id+'-merge';
    svg.innerHTML='<defs><filter id="'+filter+'" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="14"/><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/><feGaussianBlur stdDeviation="1.8"/></filter><mask id="'+id+'" maskUnits="userSpaceOnUse" x="0" y="0" width="'+width+'" height="'+height+'" style="mask-type:alpha"><g filter="url(#'+filter+')"></g></mask></defs>';
    const group=svg.querySelector('mask g'),drops=[];
    for(const [x,y,rx,ry]of [[.18,.18,.68,.65],[.8,.47,.55,.64],[.3,.84,.66,.6]]){
      const drop=document.createElementNS(ns,'ellipse');
      const cx=(direction>0?x:1-x)*width,cy=y*height;
      drop.setAttribute('cx',cx);drop.setAttribute('cy',cy);
      drop.setAttribute('rx',rx*width);drop.setAttribute('ry',ry*height);
      drop.setAttribute('fill','white');
      drop.style.transformOrigin=cx+'px '+cy+'px';
      group.append(drop);drops.push(drop);
    }
    document.body.append(svg);
    return{svg,drops,image:'url("#'+id+'")'};
  }
  function finish(parent){
    const s=swaps.get(parent);if(!s)return;swaps.delete(parent);
    s.ghost.remove();s.veil?.remove();s.mask?.svg.remove();
    for(const a of s.animations)a.cancel();parent.style.overflow=s.overflow;
    if(s.to){for(const [key,value]of Object.entries(s.styles))s.to.style[key]=value;}
  }
  yoshMotion.capture=from=>{
    if(!from||!(from.id==='page-main'||from.classList.contains('portfolio-overview')||from.classList.contains('portfolio-detail')))return originalCapture(from);
    const parent=from.parentElement;
    // A repeated command wins immediately; never flash a fully revealed intermediate page.
    const interrupted=swaps.has(parent);
    for(const [container]of swaps)if(container===parent||from.contains(container))finish(container);
    if(interrupted)return()=>{};
    if(preference.matches||keyboard||from.hidden){finish(parent);return()=>{}}
    const height=parent.getBoundingClientRect().height;if(!height)return()=>{};
    const opacity=getComputedStyle(from).opacity;
    finish(parent);
    const ghost=from.cloneNode(true);
    for(const e of [ghost,...ghost.querySelectorAll('[id]')]){if(e.id){e.setAttribute('data-motion-source',e.id);e.removeAttribute('id')}}
    ghost.querySelectorAll('.motion-ghost,.melt-veil').forEach(e=>e.remove());
    ghost.inert=true;ghost.setAttribute('aria-hidden','true');ghost.classList.add('motion-ghost','melt-ghost');
    Object.assign(ghost.style,{position:'absolute',top:from.offsetTop+'px',left:from.offsetLeft+'px',width:from.offsetWidth+'px',margin:'0',opacity,pointerEvents:'none',maskImage:'none',transform:'none',zIndex:'0'});parent.append(ghost);
    const s={ghost,animations:[],overflow:parent.style.overflow,to:null,veil:null};swaps.set(parent,s);
    return(to,{direction=1}={})=>{
      if(swaps.get(parent)!==s)return;
      if(!to||to.hidden||preference.matches||keyboard){finish(parent);return;}
      s.to=to;s.styles={maskImage:to.style.maskImage,background:to.style.background,position:to.style.position,zIndex:to.style.zIndex};parent.style.overflow='clip';
      const h=parent.getBoundingClientRect().height,r=to.getBoundingClientRect();
      const mask=makeMask(r.width,r.height,direction);s.mask=mask;
      const veil=document.createElement('div');veil.className='melt-veil';veil.setAttribute('aria-hidden','true');
      Object.assign(veil.style,{position:'absolute',top:to.offsetTop+'px',left:to.offsetLeft+'px',width:to.offsetWidth+'px',height:to.offsetHeight+'px',pointerEvents:'none',maskImage:mask.image});parent.append(veil);s.veil=veil;
      Object.assign(to.style,{maskImage:mask.image,background:'#191917',position:'relative',zIndex:'1'});
      const ease='cubic-bezier(.22,.65,.28,1)',duration=460;
      // An opaque surface separates the two views; their text never crossfades together.
      s.animations.push(ghost.animate([{opacity:1},{opacity:0}],{duration:200,easing:'ease-out',fill:'both'}));
      mask.drops.forEach((drop,i)=>s.animations.push(drop.animate([{transform:'scale(0)'},{transform:'scale(1.2)'}],{duration:duration-i*25,delay:i*25,easing:ease,fill:'both'})));
      s.animations.push(veil.animate([{opacity:.14},{opacity:.08,offset:.5},{opacity:0}],{duration,easing:'linear',fill:'both'}));
      s.animations.push(parent.animate([{height:height+'px'},{height:h+'px'}],{duration,easing:ease,fill:'both'}));
      Promise.all(s.animations.map(a=>a.finished)).then(()=>{if(swaps.get(parent)===s)finish(parent)},()=>{});
    };
  };
  const cancel=yoshMotion.cancelWithin;
  yoshMotion.cancelWithin=node=>{for(const [parent]of swaps)if(parent===node||node?.contains(parent))finish(parent);cancel(node)};
  // Two masked background shapes merge like drops. Labels remain unfiltered.
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','0');svg.setAttribute('height','0');svg.setAttribute('aria-hidden','true');svg.style.position='absolute';
  svg.innerHTML='<defs><filter id="preview-nav-goo" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="5"/><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/></filter></defs>';document.body.append(svg);
  const nav=element('page-navigation'),layer=document.createElement('span');layer.className='melt-nav';layer.setAttribute('aria-hidden','true');
  const drops=[document.createElement('span'),document.createElement('span')];drops.forEach(d=>{d.className='melt-nav-drop';layer.append(d)});nav.prepend(layer);
  document.body.classList.add('melt-preview');
  const select=yoshMotion.selectTab;let navAnimations=[];
  function move(button,animate){
    if(!button)return;
    const now=drops.map(d=>({transform:getComputedStyle(d).transform,width:getComputedStyle(d).width}));navAnimations.forEach(a=>a.cancel());navAnimations=[];
    drops.forEach((d,i)=>{const target={transform:'translateX('+button.offsetLeft+'px)',width:button.offsetWidth+'px'};d.style.top=button.offsetTop+'px';d.style.height=button.offsetHeight+'px';Object.assign(d.style,target);if(animate&&!keyboard&&!preference.matches)navAnimations.push(d.animate([now[i],target],{duration:i?390:240,easing:'cubic-bezier(.32,.72,0,1)'}))});
  }
  yoshMotion.selectTab=(button,animate=true)=>{select(button,animate);if(button)move(button,animate)};
  move(nav.querySelector('[aria-pressed=true]'),false);
  const observer=new ResizeObserver(()=>move(nav.querySelector('[aria-pressed=true]'),false));observer.observe(nav);
  preference.addEventListener('change',()=>{if(preference.matches){for(const[parent]of swaps)finish(parent);move(nav.querySelector('[aria-pressed=true]'),false)}});
})();
