/* Design fixture only. Deliberately separate from the shipped authorization UI.
 * No RPC, price API, wallet initialization, signing or payment calls. */
(() => {
  const assets = [
    { id: 'demo-sol', name: 'Solana', symbol: 'SOL', quantity: '2.5 SOL', value: '$363.00', price: '$145.20', change: '+4.96%', tone: 'positive', kind: 'native', icon: 'sol', description: 'Solana 的原生资产，也用于支付链上手续费。' },
    { id: 'demo-usdc', name: 'USD Coin', symbol: 'USDC', quantity: '250 USDC', value: '$250.00', price: '$1.00', change: '0.00%', tone: 'neutral', kind: 'token', icon: 'usdc', description: '此示例中的 API 付款资产。持有余额不等于已授权的消费额度。' },
    { id: 'demo-usdt', name: 'Tether', symbol: 'USDT', quantity: '125 USDT', value: '$125.00', price: '$1.00', change: '0.00%', tone: 'neutral', kind: 'token', icon: 'usdt', description: '钱包中的另一种代币。显示持仓不代表 Yosh 已支持用它付款。' },
  ];
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const coin = asset => {
    const e = node('span', 'asset-coin asset-coin-' + asset.icon);
    e.setAttribute('aria-hidden', 'true');
    const image = node('img');
    image.src = '/token-icons/' + ({ sol: 'solana', usdc: 'usdc', usdt: 'usdt' }[asset.icon]) + '.svg';
    image.alt = ''; image.width = 40; image.height = 40; image.draggable = false;
    e.append(image);
    return e;
  };
  const fact = (parent, label, value, tone) => { const item = node('div', 'asset-fact'); item.append(node('dt', '', label), node('dd', tone ? 'asset-' + tone : '', value)); parent.append(item); };
  function renderPortfolio() {
    const list = element('wallet-list');
    list.replaceChildren();
    element('wallet-context').textContent = '这是资产页设计预览。币种、数量、价格和涨跌均为示例，不是你的真实持仓或实时行情。';
    element('wallet-terms').textContent = '确认设计后再接只读资产查询；钱包余额、资产估值与消费授权额度分别展示。';
    const help = document.querySelector('.wallet-help summary span'); if (help) help.textContent = '关于资产估值';
    element('create-wallet').hidden = true;
    const stage = node('div', 'portfolio-stage');
    const overview = node('section', 'portfolio-overview'); overview.id = 'portfolio-overview';
    const detail = node('section', 'portfolio-detail'); detail.id = 'portfolio-detail'; detail.hidden = true;
    const top = node('div', 'portfolio-identity');
    const identity = node('div', 'portfolio-wallet-name'); const walletIcon=node('span','wallet-heading-icon');walletIcon.setAttribute('aria-hidden','true');walletIcon.append(activitySvg('wallet-outline'));identity.append(walletIcon, node('span', '', 'Solana 钱包'), node('span', 'portfolio-demo-tag', '示例'));
    const refresh = node('button', 'portfolio-refresh', '↻'); refresh.type = 'button'; refresh.setAttribute('aria-label', '刷新示例资产');
    refresh.addEventListener('click', () => { yoshMotion.enter(overview); element('wallet-feedback').textContent = '示例已刷新，未查询真实持仓或行情。'; }); top.append(identity, refresh); overview.append(top);
    const hero = node('div', 'portfolio-hero');
    hero.append(node('p', 'portfolio-eyebrow', '资产总值 · USD'), node('p', 'portfolio-total', '$738.00'));
    const change = node('p', 'portfolio-change'); change.append(node('span', 'asset-positive', '+$17.15  (+2.38%)'), node('span', '', '过去 24 小时 · 示例')); hero.append(change);
    const address = node('details', 'portfolio-address'); const addressSummary = node('summary', '', '钱包地址'); address.append(addressSummary, node('p', '', '设计预览不使用真实钱包地址。接入后，这里可查看和复制完整地址。')); hero.append(address); overview.append(hero);
    const heading = node('div', 'portfolio-list-heading'); const title = node('h2', '', '资产'); title.append(node('span', 'portfolio-count', String(assets.length))); heading.append(title, node('span', '', '持有数量 / 估值')); overview.append(heading);
    const rows = node('div', 'portfolio-rows');
    for (const asset of assets) {
      const row = node('button', 'portfolio-asset'); row.type = 'button'; row.dataset.asset = asset.id;
      row.setAttribute('aria-label', asset.name + '，持有 ' + asset.quantity + '，示例估值 ' + asset.value + '，查看详情');
      const name = node('span', 'asset-name-column'); name.append(node('span', 'asset-name', asset.name), node('span', 'asset-quantity', asset.quantity));
      const value = node('span', 'asset-value-column'); value.append(node('span', 'asset-value', asset.value), node('span', 'asset-day asset-' + asset.tone, asset.change));
      row.append(coin(asset), name, value); row.addEventListener('click', () => openAsset(asset, row)); rows.append(row);
    }
    overview.append(rows, node('p', 'portfolio-footnote', '示例持仓 · 非实时行情'));
    stage.append(overview, detail); list.append(stage);
    function openAsset(asset, origin) {
      detail.replaceChildren();
      const back = node('button', 'asset-back', '‹  所有资产'); back.type = 'button';
      const backToAssets = () => { const reveal = yoshMotion.capture(detail); detail.hidden = true; overview.hidden = false; reveal(overview, { direction: -1, back: true, fluid:true }); origin.focus({ preventScroll: true }); };
      back.addEventListener('click', backToAssets);
      const title = node('div', 'asset-detail-header'); const h = node('h2', '', asset.name); h.tabIndex = -1; title.append(coin(asset), h, node('p', '', asset.symbol + ' · Solana · 示例'));
      const holding = node('div', 'asset-holding'); holding.append(node('p', 'portfolio-eyebrow', '持有数量'), node('p', 'asset-detail-quantity', asset.quantity), node('p', 'asset-detail-value', '≈ ' + asset.value));
      const facts = node('dl', 'asset-facts'); fact(facts, '单价', asset.price); fact(facts, '24 小时涨跌', asset.change, asset.tone); fact(facts, '网络', 'Solana Mainnet'); fact(facts, '资产类型', asset.kind === 'native' ? '原生资产' : '代币');
      const info = node('details', 'asset-info'); info.append(node('summary', '', '资产说明'), node('p', '', asset.description));
      detail.append(back, title, holding, facts, info, node('p', 'portfolio-footnote', '以上持仓和价格均为演示数据'));
      const reveal = yoshMotion.capture(overview); overview.hidden = true; detail.hidden = false; reveal(detail,{fluid:true}); h.focus({ preventScroll: true });
    }
  }
  const sprite=document.createElementNS('http://www.w3.org/2000/svg','svg');sprite.setAttribute('width','0');sprite.setAttribute('height','0');sprite.setAttribute('aria-hidden','true');sprite.style.position='absolute';sprite.innerHTML='<defs><symbol id="wallet-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h15v14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13"/><path d="M15 10h6v6h-6z"/></symbol></defs>';document.body.append(sprite);
  document.body.dataset.walletAssetsPreview = 'true';
  const existingRender = renderWallets;
  renderWallets = state => { existingRender(state); if (currentEnvironment === 'mainnet') renderPortfolio(); };
  if (currentEnvironment === 'mainnet') renderPortfolio();
  showPage('wallets');
})();
