const terminal = document.getElementById('terminal');
const input = document.getElementById('command-input');
const form = document.getElementById('command-form');
const agentsEl = document.getElementById('agents');
const executivesEl = document.getElementById('executives');
const delegationsEl = document.getElementById('delegations');
const txlogEl = document.getElementById('txlog');
const stateSummaryEl = document.getElementById('state-summary');
const clockEl = document.getElementById('clock');

const STORAGE_KEY = 'mip014_offchain_lab_state_v1';

const defaultState = {
  agents: [],
  executives: [],
  delegations: [],
  txlog: [],
  history: []
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      agents: parsed.agents || [],
      executives: parsed.executives || [],
      delegations: parsed.delegations || [],
      txlog: parsed.txlog || [],
      history: parsed.history || []
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function nowStamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function fmtShort(str, len = 8) {
  return str.length <= len ? str : `${str.slice(0, len)}...`;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pda(seed) {
  const hash = await sha256(`mip014:${seed}`);
  return `PDA_${hash.slice(0, 8)}_${hash.slice(8, 16)}`;
}

function txHash() {
  const chars = 'abcdef0123456789';
  let out = '0x';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function pushTerminal(text, kind = 'plain') {
  const row = document.createElement('div');
  row.className = `line ${kind}`;
  row.textContent = text;
  terminal.appendChild(row);
  terminal.scrollTop = terminal.scrollHeight;
}

function pushCommand(cmd) {
  const row = document.createElement('div');
  row.className = 'line prompt-line';
  row.textContent = `idolly@mip014:~$ ${cmd}`;
  terminal.appendChild(row);
}

function pushTx(message, status = 'ok') {
  const tx = { time: nowStamp(), message, status, hash: txHash() };
  state.txlog.unshift(tx);
  state.txlog = state.txlog.slice(0, 8);
  saveState();
  render();
}

function seedWelcome() {
  if (terminal.childElementCount > 0) return;
  pushTerminal('MIP 014 offchain lab ready.', 'ok');
  pushTerminal('Type help to inspect the simulated registry.', 'muted');
  pushTerminal('This demo never connects to a wallet or chain.', 'warn');
}

function findAgent(name) {
  return state.agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

function findExecutive(name) {
  return state.executives.find(e => e.wallet.toLowerCase() === name.toLowerCase());
}

async function ensureAgent(name) {
  let agent = findAgent(name);
  if (agent) return agent;
  const identityPDA = await pda(name);
  agent = {
    name,
    identityPDA,
    pluginAttached: false,
    status: 'created',
    executive: null,
    permissions: [],
    balance: 0
  };
  state.agents.unshift(agent);
  return agent;
}

async function runCommand(raw) {
  const cmd = raw.trim();
  if (!cmd) return;
  state.history.unshift(cmd);
  state.history = state.history.slice(0, 12);
  pushCommand(cmd);

  const [name, ...args] = cmd.split(/\s+/);
  const action = name.toLowerCase();

  if (action === 'help') {
    pushTerminal('Commands: help, mint-agent <name>, register-identity <name>, register-executive <wallet>, delegate <agent> <wallet> <perm1,perm2>, execute <agent> <action> [amount], inspect <name>, revoke <agent>, replay, reset', 'muted');
    saveState();
    render();
    return;
  }

  if (action === 'mint-agent') {
    const nameArg = args[0] || `agent_${state.agents.length + 1}`;
    const agent = await ensureAgent(nameArg);
    agent.status = 'minted';
    pushTerminal(`agent minted: ${agent.name}`, 'ok');
    pushTerminal(`identity seed queued for ${agent.identityPDA}`, 'muted');
    pushTx(`minted agent ${agent.name}`);
    saveState();
    render();
    return;
  }

  if (action === 'register-identity') {
    const nameArg = args[0];
    if (!nameArg) return pushTerminal('missing agent name', 'err');
    const agent = await ensureAgent(nameArg);
    agent.pluginAttached = true;
    agent.status = 'identity registered';
    pushTerminal(`identity attached for ${agent.name}`, 'ok');
    pushTerminal(`pda ${agent.identityPDA}`, 'cyan');
    pushTx(`registered identity for ${agent.name}`);
    saveState();
    render();
    return;
  }

  if (action === 'register-executive') {
    const wallet = args[0] || `wallet_${state.executives.length + 1}`;
    if (!findExecutive(wallet)) {
      state.executives.unshift({ wallet, role: 'executor', createdAt: nowStamp() });
      pushTerminal(`executive registered: ${wallet}`, 'ok');
      pushTx(`registered executive ${wallet}`);
    } else {
      pushTerminal(`executive already exists: ${wallet}`, 'warn');
    }
    saveState();
    render();
    return;
  }

  if (action === 'delegate') {
    const agentName = args[0];
    const wallet = args[1];
    const perms = (args[2] || 'execute,transfer').split(',').map(s => s.trim()).filter(Boolean);
    if (!agentName || !wallet) return pushTerminal('usage: delegate <agent> <wallet> <perm1,perm2>', 'err');
    const agent = await ensureAgent(agentName);
    if (!findExecutive(wallet)) state.executives.unshift({ wallet, role: 'executor', createdAt: nowStamp() });
    agent.executive = wallet;
    agent.permissions = perms;
    agent.status = 'delegated';
    state.delegations.unshift({ agent: agent.name, wallet, permissions: perms, time: nowStamp() });
    state.delegations = state.delegations.slice(0, 8);
    pushTerminal(`delegation created for ${agent.name} -> ${wallet}`, 'ok');
    pushTerminal(`permissions: ${perms.join(', ')}`, 'muted');
    pushTx(`delegated ${agent.name} to ${wallet}`);
    saveState();
    render();
    return;
  }

  if (action === 'execute') {
    const agentName = args[0];
    const op = args[1] || 'noop';
    const amount = args[2] || '0';
    if (!agentName) return pushTerminal('usage: execute <agent> <action> [amount]', 'err');
    const agent = findAgent(agentName);
    if (!agent) return pushTerminal(`agent not found: ${agentName}`, 'err');
    if (!agent.executive) return pushTerminal('execution blocked: no delegated executive', 'err');
    if (!agent.permissions.includes('execute') && !agent.permissions.includes(op) && !agent.permissions.includes('all')) {
      return pushTerminal(`execution blocked: missing permission for ${op}`, 'err');
    }
    agent.balance += Number(amount) || 0;
    const hash = txHash();
    pushTerminal(`execution approved for ${agent.name}`, 'ok');
    pushTerminal(`action ${op} amount ${amount}`, 'muted');
    pushTerminal(`tx ${hash}`, 'cyan');
    pushTx(`executed ${op} for ${agent.name}`);
    saveState();
    render();
    return;
  }

  if (action === 'inspect') {
    const nameArg = args[0];
    if (!nameArg) return pushTerminal('usage: inspect <name>', 'err');
    const agent = findAgent(nameArg);
    if (agent) {
      pushTerminal(JSON.stringify(agent, null, 2), 'muted');
      saveState();
      return;
    }
    const exec = findExecutive(nameArg);
    if (exec) {
      pushTerminal(JSON.stringify(exec, null, 2), 'muted');
      saveState();
      return;
    }
    pushTerminal(`nothing found for ${nameArg}`, 'err');
    return;
  }

  if (action === 'revoke') {
    const agentName = args[0];
    if (!agentName) return pushTerminal('usage: revoke <agent>', 'err');
    const agent = findAgent(agentName);
    if (!agent) return pushTerminal(`agent not found: ${agentName}`, 'err');
    agent.executive = null;
    agent.permissions = [];
    agent.status = 'revoked';
    pushTerminal(`delegation revoked for ${agent.name}`, 'warn');
    pushTx(`revoked delegation for ${agent.name}`);
    saveState();
    render();
    return;
  }

  if (action === 'replay') {
    await replayProtocol();
    return;
  }

  if (action === 'reset') {
    state = structuredClone(defaultState);
    localStorage.removeItem(STORAGE_KEY);
    terminal.innerHTML = '';
    seedWelcome();
    pushTerminal('lab reset complete.', 'warn');
    render();
    return;
  }

  pushTerminal(`unknown command: ${action}`, 'err');
}

async function replayProtocol() {
  const agentName = 'idol';
  const wallet = 'wallet_01';
  const agent = await ensureAgent(agentName);
  agent.status = 'minted';
  pushTerminal('replay: mint agent', 'warn');
  pushTx(`replay mint ${agent.name}`);
  agent.pluginAttached = true;
  agent.status = 'identity registered';
  pushTerminal('replay: register identity', 'warn');
  pushTx(`replay register identity ${agent.name}`);
  if (!findExecutive(wallet)) state.executives.unshift({ wallet, role: 'executor', createdAt: nowStamp() });
  agent.executive = wallet;
  agent.permissions = ['execute', 'transfer'];
  state.delegations.unshift({ agent: agent.name, wallet, permissions: ['execute', 'transfer'], time: nowStamp() });
  pushTerminal('replay: delegate execution', 'warn');
  pushTx(`replay delegate ${agent.name}`);
  agent.balance += 25;
  pushTerminal('replay: execute transfer 25', 'warn');
  pushTx(`replay execute ${agent.name}`);
  saveState();
  render();
}

function renderList(el, items, emptyText, renderItem) {
  el.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'record';
    empty.innerHTML = `<div class="meta">${emptyText}</div>`;
    el.appendChild(empty);
    return;
  }
  items.forEach(item => el.appendChild(renderItem(item)));
}

function record(title, meta, badge) {
  const el = document.createElement('div');
  el.className = 'record';
  el.innerHTML = `<div class="title">${title}</div><div class="meta">${meta}</div>${badge ? `<div class="badge">${badge}</div>` : ''}`;
  return el;
}

function render() {
  stateSummaryEl.textContent = `${state.agents.length} agents, ${state.executives.length} executives, ${state.delegations.length} delegations`;

  renderList(agentsEl, state.agents, 'No agent registered yet.', agent => record(
    agent.name,
    `status: ${agent.status}<br>identityPDA: ${agent.identityPDA}<br>balance: ${agent.balance}<br>executive: ${agent.executive || 'none'}`,
    agent.pluginAttached ? 'identity attached' : 'plugin pending'
  ));

  renderList(executivesEl, state.executives, 'No executive registered yet.', exec => record(
    exec.wallet,
    `role: ${exec.role}<br>created: ${exec.createdAt}`,
    'authorized'
  ));

  renderList(delegationsEl, state.delegations, 'No delegation record yet.', d => record(
    `${d.agent} → ${d.wallet}`,
    `permissions: ${d.permissions.join(', ')}<br>time: ${d.time}`,
    'onchain style record'
  ));

  renderList(txlogEl, state.txlog, 'No transactions yet.', tx => record(
    tx.message,
    `time: ${tx.time}<br>hash: ${fmtShort(tx.hash, 18)}`,
    tx.status
  ));
}

function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const value = input.value;
  input.value = '';
  await runCommand(value);
});

document.querySelectorAll('[data-cmd]').forEach(btn => {
  btn.addEventListener('click', async () => {
    await runCommand(btn.dataset.cmd);
    input.focus();
  });
});

seedWelcome();
render();
tickClock();
setInterval(tickClock, 1000);

if (!state.history.length) {
  runCommand('help');
}