/* Design fixture only: no management, wallet or payment requests. */
(() => {
  const details = element('budget').closest('details');
  details.classList.add('shared-budget-preview');
  details.id = 'shared-budget-preview';
  const body = document.createElement('div');
  body.className = 'shared-budget-body';
  details.append(body);
  const node = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const agents = [
    { name: 'Codex', icon: 'codex', current: true, remaining: null, scope: '尚未创建授权' },
    { name: 'Claude Code', icon: 'claude', current: false, remaining: '6.00', scope: '市场价格 API' },
    { name: 'Gemini CLI', icon: 'gemini', current: false, remaining: '4.00', scope: '搜索 API' },
  ];
  function renderSharedBudget() {
    const preview = currentEnvironment === 'mainnet';
    body.hidden = !preview;
    element('budget').hidden = preview;
    element('grant').hidden = preview;
    if (!preview) return;
    body.replaceChildren();
    const pool = node('div', 'shared-pool');
    const heading = node('div', 'shared-pool-heading');
    heading.append(node('span', 'shared-pool-label', '今日共享剩余'), node('span', 'shared-example', '示例'));
    const total = node('p', 'shared-pool-total');
    total.append(node('span', '', '9.00'), node('span', 'shared-unit', 'USDC'));
    const state = node('p', 'shared-pool-status', '付款已暂停');
    pool.append(heading, total, state);
    body.append(pool);
    const listHeading = node('div', 'shared-agents-heading');
    listHeading.append(node('h2', '', '各 Agent 授权剩余'), node('span', '', '3 个 Agent · 示例'));
    body.append(listHeading);
    const list = node('ul', 'shared-agent-list');
    for (const agent of agents) {
      const row = node('li', 'shared-agent-row');
      row.dataset.agent = agent.icon;
      const icon = node('span', 'shared-agent-icon shared-agent-icon-' + agent.icon);
      icon.setAttribute('aria-hidden', 'true');
      if (agent.icon === 'codex') icon.append(activitySvg('activity-host-codex'));
      else {
        const image = node('img');
        image.src = '/agent-icons/' + agent.icon + '.svg';
        image.alt = ''; image.width = 24; image.height = 24; image.draggable = false;
        icon.append(image);
      }
      const identity = node('div', 'shared-agent-identity');
      const name = node('div', 'shared-agent-name');
      name.append(node('span', '', agent.name));
      if (agent.current) name.append(node('span', 'shared-agent-current', '当前'));
      identity.append(name, node('p', 'shared-agent-scope', agent.scope));
      const value = node('div', 'shared-agent-value');
      if (agent.remaining === null) {
        value.append(node('span', 'shared-agent-unset', '—'), node('span', 'shared-agent-value-label', '未授权'));
      } else {
        const amount = node('span', 'shared-agent-amount');
        amount.append(node('span', '', agent.remaining), node('span', 'shared-agent-unit', 'USDC'));
        value.append(amount, node('span', 'shared-agent-value-label', '授权剩余'));
      }
      row.append(icon, identity, value); list.append(row);
    }
    body.append(list, node('p', 'shared-budget-explainer', '各 Agent 的授权共同使用上方今日额度，不能相加作为可用余额。付款暂停期间均不可消费。'));
  }
  // Reuse the preview's existing render pass; never query another Agent's real state.
  const previousRender = renderWallets;
  renderWallets = state => { previousRender(state); renderSharedBudget(); };
  renderSharedBudget();
  showPage('authorization');
  details.open = true;
})();
