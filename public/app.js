// Central de Infraestrutura — front-end do motor de chamados.
// HTML puro + fetch, sem framework/build step (mesmo espírito do app
// antigo). Todo texto/atributo com dado que veio do usuário passa por
// esc()/jsAttr() antes de virar HTML — mesma lição já aprendida no projeto
// anterior (apóstrofo em nome quebrando onclick="...").

const API = '/api';

const STATUS_LABEL = {
  aberto: 'Aberto',
  em_atendimento: 'Em atendimento',
  aguardando_cliente: 'Aguardando cliente',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};
const STATUS_ORDEM = ['aberto', 'em_atendimento', 'aguardando_cliente', 'finalizado', 'cancelado'];
const STATUS_TERMINAIS = ['finalizado', 'cancelado'];

const PRIORIDADE_LABEL = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };

const PAPEL_LABEL = { operador: 'Operador', atendente: 'Atendente', lider: 'Líder', gestor: 'Gestor' };

// 5 níveis nomeados (2026-09-03) — substituiu a estrela 1-5.
const SATISFACAO_LABEL = {
  muito_satisfeito: 'Muito satisfeito',
  satisfeito: 'Satisfeito',
  regular: 'Regular',
  insatisfeito: 'Insatisfeito',
  muito_insatisfeito: 'Muito insatisfeito',
};

const state = {
  view: 'login',
  eu: null, // { id, nome, email } de quem está logado; null = não logado
  chamadoId: null,
  filtros: { status: '', departamentoId: '', categoriaId: '', atendenteId: '', busca: '', page: 1 },
  ref: { departamentos: [], categorias: [], subcategorias: [], atendentes: [] },
  estoque: { subview: 'dashboard', filtros: {}, mostrarDevolvidas: false, colaboradorEditando: null, novoMovTipo: 'ENTRADA', movimentacaoEditando: null }, // filtros: { aba: { coluna: texto } } — filtro por coluna, 100% client-side; colaboradorEditando: id em edição ou null (criando novo); novoMovTipo: tipo selecionado no formulário de Atualizar (ex-Movimentações) (decide quais campos mostrar); movimentacaoEditando: id em edição ou null (criando nova)
  ad: { busca: '', departamento: '', apenasColetados: false },
  // Aba "Colaboradores" (ex-"Usuários & Hosts", 2026-09-18): subview
  // 'usuarios' (dados do AD/LDAP, sempre visível) + 'cargos'/'sistemas'/
  // 'onboarding' (catálogo cargo×sistemas, credenciais, ficha de acessos e
  // e-mail de boas-vindas — só papel='atendente' vê/usa essas 3).
  colaboradores: { subview: 'usuarios', cargoEditandoSistemas: null, colaboradorSelecionado: null, novoCargoTomTicket: false, editandoColaborador: false, usuariosAD: [] },
  cadastros: { atendenteEditando: null }, // id do atendente com o form de editar papel/admin_total aberto, em Cadastros
  firmware: { pollId: null, filtros: {}, detalheId: null, filtroDetalheCriticidade: '' }, // aba "Atualizações" — pollId: id do setInterval de polling enquanto alguma checagem está rodando, ou null; filtros: filtro por coluna da lista-resumo (mesmo padrão de state.estoque.filtros); detalheId: servidor aberto no detalhe, ou null pra ver a lista
  acronis: { subview: 'alertas', filtros: {}, alertaExpandidoId: null, detalheArquivoId: null }, // aba "Segurança" (alertas do Acronis) — subview: 'alertas'|'historico'; alertaExpandidoId: linha com detalhes_json aberto na tabela de alertas; detalheArquivoId: arquivo mensal aberto no detalhe
  cpd: { subview: 'novo', filtros: {}, detalheId: null, mesResumo: new Date().toISOString().slice(0, 7), editandoExecucao: false },
  meusChamadosAba: 'abertos', // 'abertos' | 'fechados' — aba ativa na tela "Meus Chamados" (Operador)
  comentarioEditando: null, // id do comentário com o form de edição aberto em viewDetalhe, ou null
  editandoChamado: false,   // bloco "Editar chamado" (Líder/Gestor) aberto em viewDetalhe
};

// --- Utilidades ------------------------------------------------------------

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Pra usar dado livre dentro de onclick="fn('...')" com segurança (aspas
// duplas do atributo, aspas simples do literal JS por dentro).
function jsAttr(s) {
  if (s === null || s === undefined) return '';
  return String(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('"', '&quot;');
}

function fmtDataHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function toast(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (tipo === 'erro' ? ' erro' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(caminho, opts = {}) {
  // FormData (upload de anexo) não passa por JSON.stringify nem ganha
  // Content-Type manual — o navegador monta o multipart/boundary sozinho
  // (2026-09-03, viabiliza anexo em chamado/comentário).
  const isFormData = opts.body instanceof FormData;
  const resp = await fetch(API + caminho, {
    method: opts.method || 'GET',
    headers: opts.body && !isFormData ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? (isFormData ? opts.body : JSON.stringify(opts.body)) : undefined,
    credentials: 'same-origin', // manda o cookie de sessão
  });
  let dados = null;
  try { dados = await resp.json(); } catch (_) { /* resposta sem corpo */ }
  if (!resp.ok) {
    const msg = (dados && dados.erro) || `Erro ${resp.status}`;
    const erro = new Error(msg);
    erro.status = resp.status;
    throw erro;
  }
  return dados;
}

// --- Badges ------------------------------------------------------------

function badgeStatus(status) {
  return `<span class="badge status-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}
function badgePrioridade(prioridade) {
  return `<span class="badge prioridade-${esc(prioridade)}">${esc(PRIORIDADE_LABEL[prioridade] || prioridade)}</span>`;
}
function badgeSla(prazoIso, cumprida) {
  if (!prazoIso) return `<span class="badge sla-pendente">Sem prazo</span>`;
  if (cumprida === 1) return `<span class="badge sla-cumprido">Cumprido</span>`;
  if (cumprida === 0) return `<span class="badge sla-violado">Violado</span>`;
  // ainda não decidido: compara com agora pra avisar se já passou do prazo
  const atrasado = new Date(prazoIso).getTime() < Date.now();
  return atrasado
    ? `<span class="badge sla-violado">Atrasado (${esc(fmtDataHora(prazoIso))})</span>`
    : `<span class="badge sla-pendente">Prazo ${esc(fmtDataHora(prazoIso))}</span>`;
}

// --- Navegação -----------------------------------------------------------

function goTo(view, params = {}) {
  state.view = view;
  if (params.id !== undefined) state.chamadoId = params.id;
  toggleSidebarMobile(false); // navegar fecha o menu-gaveta no celular
  render();
}

// Menu lateral vira gaveta (escondida por padrão, ver @media no index.html)
// em telas estreitas — celular, usado de verdade pra fazer o Checklist do
// CPD andando pela sala. forcar (true/false) define o estado direto; sem
// argumento, alterna.
function toggleSidebarMobile(forcar) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const abrir = forcar !== undefined ? forcar : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', abrir);
  overlay.classList.toggle('open', abrir);
}

async function carregarReferencias() {
  const [departamentos, categorias, subcategorias, atendentes] = await Promise.all([
    api('/departamentos'),
    api('/categorias'),
    api('/subcategorias'),
    api('/atendentes'),
  ]);
  state.ref = { departamentos, categorias, subcategorias, atendentes };
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  document.getElementById('mobileTopbar').style.display = state.eu ? '' : 'none'; // tela de login não tem menu nenhum
  if (!state.eu) { sidebar.innerHTML = ''; toggleSidebarMobile(false); return; }

  // Operador (colaborador comum) só vê a própria visão de chamados — o
  // resto (Estoque, CPD, Usuários & Hosts, Cadastros, a tela de atendimento
  // "Chamados") é só pra quem atende (Atendente/Líder/Gestor). A segurança
  // de verdade já está no backend (rotas gated por papel) — isso aqui é só
  // não oferecer na UI o que a pessoa não pode usar mesmo.
  const itens = state.eu.papel === 'operador'
    ? [{ key: 'meus-chamados', label: 'Meus Chamados', icon: '&#9776;' }]
    : [
        { key: 'chamados', label: 'Chamados', icon: '&#9776;' },
        { key: 'novo', label: 'Abrir chamado', icon: '&#43;' },
        { key: 'estoque', label: 'Estoque', icon: '&#128230;' },
        { key: 'cpd', label: 'Checklist do CPD', icon: '&#9989;' },
        { key: 'firmware', label: 'Atualizações', icon: '&#128260;' },
        { key: 'seguranca', label: 'Segurança', icon: '&#128737;' },
        { key: 'ad', label: 'Colaboradores', icon: '&#128421;' },
        ...(state.eu.papel === 'gestor' || state.eu.adminTotal ? [{ key: 'cadastros', label: 'Cadastros', icon: '&#9881;' }] : []),
      ];
  sidebar.innerHTML = `
    <div class="brand">
      <div class="brand-chip">CI</div>
      <div class="brand-text">Central de Infraestrutura<small>Motor de chamados próprio</small></div>
    </div>
    ${itens.map(i => `
      <button class="nav-item ${state.view === i.key ? 'active' : ''}" onclick="goTo('${i.key}')">
        <span class="nav-icon">${i.icon}</span>${esc(i.label)}
      </button>
    `).join('')}
    <div style="flex:1"></div>
    <div style="padding:10px 8px; border-top:1px solid var(--border); margin-top:8px;">
      <div class="muted" style="font-size:12px; margin-bottom:6px;">Logado como<br><strong style="color:var(--text)">${esc(state.eu.nome)}</strong></div>
      <button class="nav-item" onclick="sair()"><span class="nav-icon">&#8630;</span>Sair</button>
    </div>
  `;
}

// render() é serializado (2026-10-05): cada tecla digitada num filtro chama
// render(), que busca dados da API (assíncrono). Antes, vários renders
// rodavam ao mesmo tempo e o mais antigo, ao terminar, trocava o <input> e
// restaurava o cursor numa posição velha — daí as letras trocadas de lugar
// ao digitar rápido. Agora: no máximo um render em andamento e UM na fila
// (que já enxerga o estado mais recente), e o foco/cursor é lido só na hora
// de trocar o HTML.
let renderEncadeado = Promise.resolve();
let renderNaFila = false;

function render() {
  if (renderNaFila) return renderEncadeado;
  renderNaFila = true;
  renderEncadeado = renderEncadeado.then(async () => {
    renderNaFila = false;
    await renderAgora();
  });
  return renderEncadeado;
}

async function renderAgora() {
  renderSidebar();
  const main = document.getElementById('main');

  let html;
  try {
    if (state.view === 'login') html = viewLogin();
    else if (state.view === 'meus-chamados') html = await viewMeusChamados();
    else if (state.view === 'chamados') html = await viewChamados();
    else if (state.view === 'novo') html = await viewNovoChamado();
    else if (state.view === 'detalhe') html = await viewDetalhe(state.chamadoId);
    else if (state.view === 'estoque') html = await viewEstoque();
    else if (state.view === 'cpd') html = await viewCpd();
    else if (state.view === 'firmware') html = await viewFirmware();
    else if (state.view === 'seguranca') html = await viewAcronis();
    else if (state.view === 'ad') html = await viewColaboradores();
    else if (state.view === 'cadastros') html = await viewCadastros();
  } catch (e) {
    if (e.status === 401) {
      // Sessão expirou (ou nunca existiu) no meio do uso — manda pra tela
      // de login em vez de mostrar um card de erro genérico.
      state.eu = null;
      state.view = 'login';
      renderSidebar();
      main.innerHTML = viewLogin();
      toast('Sua sessão expirou. Faça login de novo.', 'erro');
      return;
    }
    main.innerHTML = `<div class="card"><strong>Erro ao carregar:</strong> ${esc(e.message)}</div>`;
    return;
  }
  if (html === undefined) return;

  // Preserva foco + posição do cursor em campos marcados com
  // data-filtro-key (filtros por coluna e buscas, que re-renderizam a cada
  // tecla) — lido AQUI, imediatamente antes de trocar o HTML, pra refletir
  // o que a pessoa já digitou enquanto os dados chegavam.
  const focoAtivo = document.activeElement;
  const filtroKey = focoAtivo && focoAtivo.matches && focoAtivo.matches('[data-filtro-key]')
    ? focoAtivo.getAttribute('data-filtro-key')
    : null;
  const selecao = filtroKey ? [focoAtivo.selectionStart, focoAtivo.selectionEnd] : null;

  main.innerHTML = html;

  if (filtroKey) {
    const novoEl = main.querySelector(`[data-filtro-key="${CSS.escape(filtroKey)}"]`);
    if (novoEl) {
      novoEl.focus();
      if (selecao) novoEl.setSelectionRange(selecao[0], selecao[1]);
    }
  }
}

// --- View: login ---------------------------------------------------------

function viewLogin() {
  return `
    <div style="min-height:80vh; display:flex; align-items:center; justify-content:center;">
      <div class="card" style="width:100%; max-width:360px; text-align:center;">
        <div class="brand" style="padding:0 0 18px 0; justify-content:center;">
          <div class="brand-chip">CI</div>
          <div class="brand-text">Central de Infraestrutura<small>Motor de chamados próprio</small></div>
        </div>
        <p class="muted" style="margin:0 0 18px 0;">Entre com a sua conta Microsoft da empresa. Primeiro acesso? Sua conta é criada automaticamente pra você abrir e acompanhar os próprios chamados.</p>
        <a href="/api/auth/entra/login" class="btn primary" style="width:100%; display:block; box-sizing:border-box; text-decoration:none;">Entrar com Microsoft</a>
      </div>
    </div>
  `;
}

async function sair() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* mesmo se der erro, limpa localmente */ }
  state.eu = null;
  state.view = 'login';
  render();
}

// --- View: lista de chamados ------------------------------------------

async function viewChamados() {
  const f = state.filtros;
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.departamentoId) params.set('departamentoId', f.departamentoId);
  if (f.categoriaId) params.set('categoriaId', f.categoriaId);
  if (f.atendenteId) params.set('atendenteId', f.atendenteId);
  if (f.busca) params.set('busca', f.busca);
  params.set('page', f.page);
  params.set('pageSize', 20);

  const { total, page, pageSize, chamados } = await api('/chamados?' + params.toString());
  const totalPaginas = Math.max(Math.ceil(total / pageSize), 1);

  const categoriasDoDept = f.departamentoId
    ? state.ref.categorias.filter(c => String(c.departamento_id) === String(f.departamentoId))
    : state.ref.categorias;

  return `
    <div class="section-title">Chamados</div>
    <p class="section-desc">Todos os chamados abertos na plataforma — sem depender do TomTicket, o SLA e a avaliação são calculados aqui mesmo.</p>

    <div class="toolbar">
      <div class="field" style="min-width:220px">
        <label>Buscar (protocolo, assunto, descrição)</label>
        <input id="filtroBusca" type="text" value="${esc(f.busca)}"
          onkeydown="if(event.key==='Enter'){ state.filtros.busca=this.value; state.filtros.page=1; render(); }"
          onblur="state.filtros.busca=this.value; state.filtros.page=1; render();" />
      </div>
      <div class="field">
        <label>Status</label>
        <select onchange="state.filtros.status=this.value; state.filtros.page=1; render();">
          <option value="">Todos</option>
          ${STATUS_ORDEM.map(s => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Departamento</label>
        <select onchange="state.filtros.departamentoId=this.value; state.filtros.categoriaId=''; state.filtros.page=1; render();">
          <option value="">Todos</option>
          ${state.ref.departamentos.map(d => `<option value="${d.id}" ${String(f.departamentoId) === String(d.id) ? 'selected' : ''}>${esc(d.nome)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Categoria</label>
        <select onchange="state.filtros.categoriaId=this.value; state.filtros.page=1; render();">
          <option value="">Todas</option>
          ${categoriasDoDept.map(c => `<option value="${c.id}" ${String(f.categoriaId) === String(c.id) ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Atendente</label>
        <select onchange="state.filtros.atendenteId=this.value; state.filtros.page=1; render();">
          <option value="">Todos</option>
          ${state.ref.atendentes.map(a => `<option value="${a.id}" ${String(f.atendenteId) === String(a.id) ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}
        </select>
      </div>
      ${(f.status || f.departamentoId || f.categoriaId || f.atendenteId || f.busca) ? `<button class="btn small ghost" onclick="state.filtros={status:'',departamentoId:'',categoriaId:'',atendenteId:'',busca:'',page:1}; render();">Limpar filtros</button>` : ''}
      <div style="flex:1"></div>
      <button class="btn primary" onclick="goTo('novo')">+ Abrir chamado</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Protocolo</th><th>Assunto</th><th>Departamento</th><th>Categoria</th>
            <th>Prioridade</th><th>Status</th><th>SLA resolução</th><th>Atendente</th><th>Aberto em</th>
          </tr>
        </thead>
        <tbody>
          ${chamados.length ? chamados.map(c => `
            <tr onclick="goTo('detalhe', {id: ${c.id}})" ${(c.slaResolucaoEstourada || c.slaPrimeiraRespostaEstourada) ? 'style="background: var(--critical-bg)"' : ''}>
              <td>${esc(c.protocolo)}</td>
              <td>${esc(c.assunto)}</td>
              <td>${esc(c.departamento_nome)}</td>
              <td>${esc(c.categoria_nome)}</td>
              <td>${badgePrioridade(c.prioridade)}</td>
              <td>${badgeStatus(c.status)}</td>
              <td>${badgeSla(c.sla_prazo_resolucao, c.sla_resolucao_cumprida)}</td>
              <td>${esc(c.atendente_nome || '—')}</td>
              <td>${esc(fmtDataHora(c.criado_em))}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="9">Nenhum chamado encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="actions-row" style="align-items:center">
      <button class="btn small" ${page <= 1 ? 'disabled' : ''} onclick="state.filtros.page=${page - 1}; render();">&larr; Anterior</button>
      <span class="muted">Página ${page} de ${totalPaginas} — ${total} chamado(s)</span>
      <button class="btn small" ${page >= totalPaginas ? 'disabled' : ''} onclick="state.filtros.page=${page + 1}; render();">Próxima &rarr;</button>
    </div>
  `;
}

// --- View: Meus Chamados (só Operador) -----------------------------------
// Modelada no TomTicket (print de referência do usuário): abas
// Abertos/Fechados, tabela enxuta, botão de abrir novo. O filtro "só os
// meus" é 100% do backend (GET /chamados já vem restrito por papel) — esta
// tela só decide o que mostrar do que já voltou.

async function viewMeusChamados() {
  const aba = state.meusChamadosAba;
  const { chamados } = await api('/chamados?pageSize=200');
  const filtrados = chamados.filter((c) => (aba === 'abertos' ? !STATUS_TERMINAIS.includes(c.status) : STATUS_TERMINAIS.includes(c.status)));
  // avaliacaoPendente só vem preenchido do backend pro papel Operador (ver
  // GET /chamados em src/routes/chamados.js) — sempre o caso nesta tela.
  const pendentes = chamados.filter((c) => c.avaliacaoPendente);

  return `
    <div class="section-title" style="display:flex; justify-content:space-between; align-items:center;">
      Meus Chamados
      <button class="btn primary" ${pendentes.length ? 'disabled title="Avalie o(s) chamado(s) pendente(s) antes de abrir um novo"' : ''} onclick="goTo('novo')">Novo Chamado</button>
    </div>
    ${pendentes.length ? `
    <div class="card" style="background: var(--critical-bg); margin-bottom:14px;">
      <strong>Avalie antes de abrir um novo chamado:</strong>
      <div style="margin-top:8px">
        ${pendentes.map(c => `<button class="btn small" style="margin:2px" onclick="goTo('detalhe', {id: ${c.id}})">${esc(c.protocolo)} — ${esc(c.assunto)}</button>`).join('')}
      </div>
    </div>
    ` : ''}
    <div class="toolbar">
      <button class="btn small ${aba === 'abertos' ? 'primary' : ''}" onclick="state.meusChamadosAba='abertos'; render();">Abertos</button>
      <button class="btn small ${aba === 'fechados' ? 'primary' : ''}" onclick="state.meusChamadosAba='fechados'; render();">Fechados</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Protocolo</th><th>Assunto</th><th>Status</th><th>Data</th></tr></thead>
        <tbody>
          ${filtrados.length ? filtrados.map(c => `
            <tr onclick="goTo('detalhe', {id: ${c.id}})" ${(c.slaResolucaoEstourada || c.slaPrimeiraRespostaEstourada) ? 'style="background: var(--critical-bg)"' : ''}>
              <td>${esc(c.protocolo)}</td>
              <td>${esc(c.assunto)}</td>
              <td>${badgeStatus(c.status)}${c.avaliacaoPendente ? ' <span class="badge sla-violado">Avaliar</span>' : ''}</td>
              <td>${esc(fmtDataHora(c.criado_em))}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="4">Nenhum chamado ${aba === 'abertos' ? 'aberto' : 'fechado'}.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- View: abrir chamado ------------------------------------------------

async function viewNovoChamado() {
  const operador = state.eu.papel === 'operador';
  return `
    <div class="section-title">Abrir chamado</div>
    <p class="section-desc">${operador ? 'Vai ser aberto em seu nome.' : 'Registrado em nome do solicitante — o atendente abre o chamado por ele.'}</p>
    <div class="card" style="max-width:760px">
      <form class="grid-2" onsubmit="criarChamado(event); return false;">
        <div class="field full">
          <label>Assunto</label>
          <input id="campoAssunto" type="text" required maxlength="200" />
        </div>
        <div class="field full">
          <label>Descrição</label>
          <textarea id="campoDescricao" required></textarea>
        </div>
        <div class="field">
          <label>Departamento</label>
          <select id="campoDepartamento" required onchange="atualizarCategoriasDoFormulario();">
            <option value="">Selecione...</option>
            ${state.ref.departamentos.map(d => `<option value="${d.id}">${esc(d.nome)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Categoria</label>
          <select id="campoCategoria" required onchange="atualizarSubcategoriasDoFormulario();"><option value="">Selecione o departamento primeiro</option></select>
        </div>
        <div class="field" id="campoSubcategoriaWrap" hidden>
          <label>Subcategoria</label>
          <select id="campoSubcategoria"></select>
        </div>
        <div class="field">
          <label>Prioridade</label>
          <select id="campoPrioridade">
            ${Object.entries(PRIORIDADE_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'normal' ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="field full">
          <label>Anexo (opcional, até 5 arquivos)</label>
          <input id="campoAnexos" type="file" multiple />
        </div>
        ${operador ? '' : `
        <div class="field">
          <label>Nome do solicitante</label>
          <input id="campoSolicitanteNome" type="text" required />
        </div>
        <div class="field">
          <label>Email do solicitante</label>
          <input id="campoSolicitanteEmail" type="email" required />
        </div>
        `}
        <div class="full actions-row">
          <button type="submit" class="btn primary">Abrir chamado</button>
          <button type="button" class="btn ghost" onclick="goTo('${operador ? 'meus-chamados' : 'chamados'}')">Cancelar</button>
        </div>
      </form>
    </div>
  `;
}

function atualizarCategoriasDoFormulario() {
  const depId = document.getElementById('campoDepartamento').value;
  const select = document.getElementById('campoCategoria');
  const categorias = state.ref.categorias.filter(c => String(c.departamento_id) === String(depId));
  select.innerHTML = categorias.length
    ? categorias.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')
    : `<option value="">Nenhuma categoria cadastrada nesse departamento</option>`;
  atualizarSubcategoriasDoFormulario();
}

// Subcategoria (2026-09-03) — só aparece quando a categoria escolhida tem
// alguma cadastrada (mesma regra do backend em criarChamado, ver
// src/routes/chamados.js) — categoria ainda não detalhada não mostra nada.
function atualizarSubcategoriasDoFormulario() {
  const catId = document.getElementById('campoCategoria').value;
  const wrap = document.getElementById('campoSubcategoriaWrap');
  const select = document.getElementById('campoSubcategoria');
  const subcategorias = state.ref.subcategorias.filter(s => String(s.categoria_id) === String(catId));
  wrap.hidden = !subcategorias.length;
  select.required = !!subcategorias.length;
  select.innerHTML = subcategorias.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('');
}

async function criarChamado(event) {
  const btn = event.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const operador = state.eu.papel === 'operador';
  try {
    const corpo = new FormData();
    corpo.set('assunto', document.getElementById('campoAssunto').value);
    corpo.set('descricao', document.getElementById('campoDescricao').value);
    corpo.set('departamentoId', document.getElementById('campoDepartamento').value);
    corpo.set('categoriaId', document.getElementById('campoCategoria').value);
    corpo.set('prioridade', document.getElementById('campoPrioridade').value);
    const subcategoriaEl = document.getElementById('campoSubcategoria');
    if (!document.getElementById('campoSubcategoriaWrap').hidden && subcategoriaEl.value) {
      corpo.set('subcategoriaId', subcategoriaEl.value);
    }
    // Operador não escolhe solicitante (o backend força ser ele mesmo de
    // qualquer forma) — esses campos nem existem no formulário dele.
    if (!operador) {
      corpo.set('solicitanteNome', document.getElementById('campoSolicitanteNome').value);
      corpo.set('solicitanteEmail', document.getElementById('campoSolicitanteEmail').value);
    }
    for (const file of document.getElementById('campoAnexos').files) corpo.append('anexos', file);

    const criado = await api('/chamados', { method: 'POST', body: corpo });
    toast(`Chamado ${criado.protocolo} aberto.`);
    goTo('detalhe', { id: criado.id });
  } catch (e) {
    toast(e.message, 'erro');
    btn.disabled = false;
  }
}

// --- View: detalhe do chamado --------------------------------------------

function linkAnexo(chamadoId, anexo) {
  return `<a href="${API}/chamados/${chamadoId}/anexos/${anexo.id}" target="_blank" rel="noopener" class="btn small ghost" style="margin:2px 4px 2px 0">&#128206; ${esc(anexo.nome_original)}</a>`;
}

async function viewDetalhe(id) {
  const c = await api(`/chamados/${id}`);
  const proximosStatus = STATUS_ORDEM.filter(s => s !== c.status);
  // Mesma regra de "pendente de avaliar" do backend (temAvaliacaoPendente em
  // src/routes/chamados.js): sem avaliação, ou avaliação mais antiga que a
  // finalização atual (cobre o ciclo reabre→finaliza de novo).
  const podeAvaliar = state.eu.papel === 'operador' && c.status === 'finalizado' && (!c.avaliacao || c.avaliacao.criado_em < c.finalizado_em);
  const operador = state.eu.papel === 'operador';
  const podeGerenciar = ['atendente', 'lider', 'gestor'].includes(state.eu.papel);
  const podeEditar = ['lider', 'gestor'].includes(state.eu.papel);
  const categoriasDoDept = state.ref.categorias.filter(cat => cat.departamento_id === c.departamento_id);

  return `
    <button class="btn ghost small" onclick="goTo('${operador ? 'meus-chamados' : 'chamados'}')">&larr; Voltar pra lista</button>
    <div class="section-title" style="margin-top:10px">${esc(c.protocolo)} — ${esc(c.assunto)}</div>
    <p class="section-desc">${badgeStatus(c.status)} ${badgePrioridade(c.prioridade)} ${c.slaResolucaoEstourada || c.slaPrimeiraRespostaEstourada ? '<span class="badge sla-violado">SLA estourado</span>' : ''}</p>

    <div class="detalhe-grid">
      <div>
        <div class="card">
          ${podeEditar && state.editandoChamado ? `
          <form class="grid-2" onsubmit="salvarEdicaoChamado(event, ${c.id}); return false;">
            <div class="field full">
              <label>Assunto</label>
              <input id="campoEditAssunto" type="text" value="${esc(c.assunto)}" required maxlength="200" />
            </div>
            <div class="field full">
              <label>Descrição</label>
              <textarea id="campoEditDescricao" required>${esc(c.descricao)}</textarea>
            </div>
            <div class="field">
              <label>Categoria</label>
              <select id="campoEditCategoria">
                ${categoriasDoDept.map(cat => `<option value="${cat.id}" ${cat.id === c.categoria_id ? 'selected' : ''}>${esc(cat.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Prioridade</label>
              <select id="campoEditPrioridade">
                ${Object.entries(PRIORIDADE_LABEL).map(([v, l]) => `<option value="${v}" ${v === c.prioridade ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="full actions-row">
              <button type="submit" class="btn small primary">Salvar edição</button>
              <button type="button" class="btn small ghost" onclick="state.editandoChamado=false; render();">Cancelar</button>
            </div>
          </form>
          ` : `
          <dl class="kv">
            <dt>Descrição</dt><dd>${esc(c.descricao)}</dd>
            <dt>Departamento</dt><dd>${esc(c.departamento_nome)}</dd>
            <dt>Categoria</dt><dd>${esc(c.categoria_nome)}${c.subcategoria_nome ? ' / ' + esc(c.subcategoria_nome) : ''}</dd>
            ${operador ? '' : `<dt>Solicitante</dt><dd>${esc(c.solicitante_nome)} &lt;${esc(c.solicitante_email)}&gt;</dd>`}
            <dt>Atendente</dt><dd>${esc(c.atendente_nome || 'Sem atendente atribuído')}</dd>
            <dt>Aberto em</dt><dd>${esc(fmtDataHora(c.criado_em))}</dd>
            <dt>Primeira resposta</dt><dd>${esc(fmtDataHora(c.primeira_resposta_em))}</dd>
            <dt>Finalizado em</dt><dd>${esc(fmtDataHora(c.finalizado_em))}</dd>
          </dl>
          ${podeEditar ? `<button class="btn small ghost" style="margin-top:10px" onclick="state.editandoChamado=true; render();">Editar chamado</button>` : ''}
          `}

          ${c.anexos.length ? `<div style="margin-top:14px"><dt class="muted" style="font-size:13px">Anexos</dt><div style="margin-top:6px">${c.anexos.map(a => linkAnexo(c.id, a)).join('')}</div></div>` : ''}

          ${operador ? '' : !STATUS_TERMINAIS.includes(c.status) ? `
          <div class="actions-row">
            <div class="field">
              <label>Atribuir atendente</label>
              <select id="selectAtendente">
                <option value="">Sem atendente</option>
                ${state.ref.atendentes.map(a => `<option value="${a.id}" ${c.atendente_id === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}
              </select>
            </div>
            <button class="btn small" style="align-self:flex-end" onclick="atribuirAtendente(${c.id})">Salvar atendente</button>
          </div>
          <div class="actions-row">
            <div class="field">
              <label>Mudar status</label>
              <select id="selectStatus">
                ${proximosStatus.map(s => `<option value="${s}">${esc(STATUS_LABEL[s])}</option>`).join('')}
              </select>
            </div>
            <button class="btn small primary" style="align-self:flex-end" onclick="mudarStatus(${c.id})">Aplicar</button>
          </div>
          ` : podeGerenciar ? `
          <p class="muted" style="margin-top:14px">Chamado ${esc(STATUS_LABEL[c.status]).toLowerCase()} — status não pode mais ser alterado por aqui.</p>
          <button class="btn small ghost" style="margin-top:6px" onclick="reabrirChamado(${c.id})">Reabrir chamado</button>
          ` : `<p class="muted" style="margin-top:14px">Chamado ${esc(STATUS_LABEL[c.status]).toLowerCase()} — status não pode mais ser alterado. Abra um novo chamado se precisar continuar o atendimento.</p>`}
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Comentários</strong>
          <div style="margin-top:10px">
            ${c.comentarios.length ? c.comentarios.map(com => `
              <div class="comentario-item ${com.interno ? 'interno' : ''}">
                <div class="quando">${esc(com.autor_nome)} • ${esc(fmtDataHora(com.criado_em))} ${com.interno ? ' • <strong>interno</strong>' : ''}${com.editado_em ? ' • <em>editado</em>' : ''}</div>
                ${state.comentarioEditando === com.id ? `
                <form onsubmit="salvarEdicaoComentario(event, ${c.id}, ${com.id}); return false;">
                  <textarea id="campoEditComentarioTexto" required>${esc(com.texto)}</textarea>
                  <div class="actions-row" style="margin-top:6px">
                    <button type="submit" class="btn small primary">Salvar</button>
                    <button type="button" class="btn small ghost" onclick="state.comentarioEditando=null; render();">Cancelar</button>
                  </div>
                </form>
                ` : `
                <div>${esc(com.texto)}</div>
                ${com.anexos && com.anexos.length ? `<div style="margin-top:6px">${com.anexos.map(a => linkAnexo(c.id, a)).join('')}</div>` : ''}
                ${com.atendente_id === state.eu.id ? `
                <div class="actions-row" style="margin-top:4px">
                  <button class="btn small ghost" onclick="state.comentarioEditando=${com.id}; render();">Editar</button>
                  <button class="btn small ghost" onclick="apagarComentario(${c.id}, ${com.id})">Apagar</button>
                </div>
                ` : ''}
                `}
              </div>
            `).join('') : `<p class="muted">Nenhum comentário ainda.</p>`}
          </div>
          <form style="margin-top:12px" onsubmit="adicionarComentario(event, ${c.id}); return false;">
            <div class="field full">
              <label>Comentário (como ${esc(state.eu.nome)})</label>
              <textarea id="campoComentarioTexto" required></textarea>
            </div>
            <div class="field full">
              <label>Anexo (opcional, até 5 arquivos)</label>
              <input id="campoComentarioAnexos" type="file" multiple />
            </div>
            ${operador ? '' : `
            <div class="field">
              <label><input type="checkbox" id="campoComentarioInterno" style="width:auto" /> Comentário interno (só a equipe vê)</label>
            </div>
            `}
            <div class="full actions-row"><button type="submit" class="btn small">Comentar</button></div>
          </form>
        </div>

        ${podeAvaliar ? `
        <div class="card" style="margin-top:16px">
          <strong>Como você avalia o atendimento deste chamado?</strong>
          <form style="margin-top:10px" onsubmit="enviarAvaliacao(event, ${c.id}); return false;">
            <div class="actions-row" style="flex-wrap:wrap">
              ${Object.entries(SATISFACAO_LABEL).map(([v, l]) => `
                <label class="btn small ghost" style="cursor:pointer">
                  <input type="radio" name="campoSatisfacao" value="${v}" required style="width:auto; margin-right:6px" />${esc(l)}
                </label>
              `).join('')}
            </div>
            <div class="field full" style="margin-top:10px">
              <label>Comentário (opcional)</label>
              <textarea id="campoAvaliacaoComentario"></textarea>
            </div>
            <div class="full actions-row"><button type="submit" class="btn small primary">Registrar avaliação</button></div>
          </form>
        </div>
        ` : c.avaliacao ? `
        <div class="card" style="margin-top:16px">
          <strong>Avaliação</strong>
          <p style="margin:10px 0 0 0">${esc(SATISFACAO_LABEL[c.avaliacao.satisfacao] || c.avaliacao.satisfacao)}${c.avaliacao.comentario ? ' — “' + esc(c.avaliacao.comentario) + '”' : ''}</p>
        </div>
        ` : ''}
      </div>

      <div>
        <div class="card">
          <strong>SLA</strong>
          <dl class="kv" style="grid-template-columns:1fr; margin-top:10px; gap:14px">
            <div>
              <dt>Primeira resposta</dt>
              <dd style="margin-top:4px">${badgeSla(c.sla_prazo_primeira_resposta, c.sla_primeira_resposta_cumprida)}</dd>
            </div>
            <div>
              <dt>Resolução</dt>
              <dd style="margin-top:4px">${badgeSla(c.sla_prazo_resolucao, c.sla_resolucao_cumprida)}</dd>
            </div>
          </dl>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Histórico</strong>
          <div style="margin-top:10px">
            ${c.historico.map(h => `
              <div class="historico-item">
                <div class="quando">${esc(fmtDataHora(h.criado_em))}${h.atendente_nome ? ' • ' + esc(h.atendente_nome) : (h.status_anterior === 'finalizado' && h.status_novo === 'aberto' ? ' • automático (avaliação insatisfeita)' : '')}</div>
                <div>${h.status_anterior ? esc(STATUS_LABEL[h.status_anterior]) + ' &rarr; ' : ''}${esc(STATUS_LABEL[h.status_novo])}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function atribuirAtendente(id) {
  const atendenteId = document.getElementById('selectAtendente').value;
  try {
    await api(`/chamados/${id}/atribuir`, { method: 'PATCH', body: { atendenteId: atendenteId ? Number(atendenteId) : null } });
    toast('Atendente atualizado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function mudarStatus(id) {
  const novoStatus = document.getElementById('selectStatus').value;
  try {
    await api(`/chamados/${id}/status`, { method: 'PATCH', body: { novoStatus } });
    toast('Status atualizado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function adicionarComentario(event, id) {
  try {
    const checkboxInterno = document.getElementById('campoComentarioInterno');
    const corpo = new FormData();
    corpo.set('texto', document.getElementById('campoComentarioTexto').value);
    corpo.set('interno', checkboxInterno ? checkboxInterno.checked : false); // Operador não tem esse campo — backend força false de qualquer forma
    for (const file of document.getElementById('campoComentarioAnexos').files) corpo.append('anexos', file);
    await api(`/chamados/${id}/comentarios`, { method: 'POST', body: corpo });
    toast('Comentário adicionado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarEdicaoComentario(event, id, comentarioId) {
  try {
    const texto = document.getElementById('campoEditComentarioTexto').value;
    await api(`/chamados/${id}/comentarios/${comentarioId}`, { method: 'PATCH', body: { texto } });
    state.comentarioEditando = null;
    toast('Comentário atualizado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function apagarComentario(id, comentarioId) {
  if (!confirm('Apagar este comentário?')) return;
  try {
    await api(`/chamados/${id}/comentarios/${comentarioId}`, { method: 'DELETE' });
    toast('Comentário apagado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function reabrirChamado(id) {
  if (!confirm('Reabrir este chamado?')) return;
  try {
    await api(`/chamados/${id}/reabrir`, { method: 'PATCH' });
    toast('Chamado reaberto.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarEdicaoChamado(event, id) {
  try {
    const corpo = {
      assunto: document.getElementById('campoEditAssunto').value,
      descricao: document.getElementById('campoEditDescricao').value,
      categoriaId: Number(document.getElementById('campoEditCategoria').value),
      prioridade: document.getElementById('campoEditPrioridade').value,
    };
    await api(`/chamados/${id}/editar`, { method: 'PATCH', body: corpo });
    state.editandoChamado = false;
    toast('Chamado atualizado.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

async function enviarAvaliacao(event, id) {
  try {
    const escolhido = document.querySelector('input[name=campoSatisfacao]:checked');
    if (!escolhido) return toast('Escolha uma opção de satisfação.', 'erro');
    const corpo = {
      satisfacao: escolhido.value,
      comentario: document.getElementById('campoAvaliacaoComentario').value || null,
    };
    await api(`/chamados/${id}/avaliacao`, { method: 'POST', body: corpo });
    toast('Avaliação registrada.');
    goTo('detalhe', { id });
  } catch (e) { toast(e.message, 'erro'); }
}

// --- View: cadastros -----------------------------------------------------

async function viewCadastros() {
  const [slaPoliticas, itensEstoque, feriados] = await Promise.all([
    api('/sla-politicas'),
    api('/estoque/itens'),
    api('/feriados'),
  ]);

  return `
    <div class="section-title">Cadastros</div>
    <p class="section-desc">Departamentos, categorias, atendentes e políticas de prazo de SLA. Nada aqui é usado pra excluir — só criar (evita quebrar chamados antigos que já referenciam esses cadastros).</p>

    <div class="detalhe-grid">
      <div>
        <div class="card">
          <strong>Departamentos</strong>
          <div class="table-wrap" style="margin-top:10px">
            <table><tbody>
              ${state.ref.departamentos.map(d => `<tr><td>${esc(d.nome)}</td></tr>`).join('') || '<tr class="empty-row"><td>Nenhum ainda.</td></tr>'}
            </tbody></table>
          </div>
          <form style="margin-top:10px; display:flex; gap:8px" onsubmit="criarDepartamento(event); return false;">
            <input id="novoDepartamentoNome" type="text" placeholder="Nome do departamento" required style="flex:1; border:1px solid var(--border); border-radius:8px; padding:7px 10px;" />
            <button class="btn small primary" type="submit">Adicionar</button>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Categorias</strong>
          <div class="table-wrap" style="margin-top:10px">
            <table><tbody>
              ${state.ref.categorias.map(c => `<tr><td>${esc(c.nome)}</td><td class="muted">${esc(state.ref.departamentos.find(d => d.id === c.departamento_id)?.nome || '')}</td></tr>`).join('') || '<tr class="empty-row"><td>Nenhuma ainda.</td></tr>'}
            </tbody></table>
          </div>
          <form class="grid-2" style="margin-top:10px" onsubmit="criarCategoria(event); return false;">
            <div class="field"><input id="novaCategoriaNome" type="text" placeholder="Nome da categoria" required /></div>
            <div class="field">
              <select id="novaCategoriaDepartamento" required>
                <option value="">Departamento...</option>
                ${state.ref.departamentos.map(d => `<option value="${d.id}">${esc(d.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Subcategorias</strong>
          <p class="section-desc" style="margin-top:6px">Assim que uma categoria tiver ao menos uma subcategoria cadastrada, ela passa a ser obrigatória na abertura de chamado nessa categoria.</p>
          <div class="table-wrap" style="margin-top:10px">
            <table><tbody>
              ${state.ref.subcategorias.map(s => `<tr><td>${esc(s.nome)}</td><td class="muted">${esc(state.ref.categorias.find(c => c.id === s.categoria_id)?.nome || '')}</td></tr>`).join('') || '<tr class="empty-row"><td>Nenhuma ainda.</td></tr>'}
            </tbody></table>
          </div>
          <form class="grid-2" style="margin-top:10px" onsubmit="criarSubcategoria(event); return false;">
            <div class="field"><input id="novaSubcategoriaNome" type="text" placeholder="Nome da subcategoria" required /></div>
            <div class="field">
              <select id="novaSubcategoriaCategoria" required>
                <option value="">Categoria...</option>
                ${state.ref.categorias.map(c => `<option value="${c.id}">${esc(c.nome)} (${esc(state.ref.departamentos.find(d => d.id === c.departamento_id)?.nome || '')})</option>`).join('')}
              </select>
            </div>
            <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Atendentes</strong>
          <p class="section-desc" style="margin-top:6px">Papel é a posição da pessoa (Operador só os próprios chamados; Atendente atende os do departamento dele; Líder supervisiona um ou mais departamentos; Gestor vê tudo) — separado de "Administrador total", que dá acesso a Cadastros/Onboarding de acessos independente do papel. Contas novas entram como Operador sozinhas no primeiro login com Microsoft — aqui é só pra promover alguém.</p>
          <div class="table-wrap" style="margin-top:10px">
            <table>
              <thead><tr><th>Nome</th><th>Email</th><th>Papel</th><th>Admin total</th><th></th></tr></thead>
              <tbody>
                ${state.ref.atendentes.length ? state.ref.atendentes.map(a => `
                  <tr>
                    <td>${esc(a.nome)}</td><td class="muted">${esc(a.email)}</td>
                    <td>${esc(PAPEL_LABEL[a.papel] || a.papel)}</td>
                    <td>${a.admin_total ? '✓' : '—'}</td>
                    <td><button class="btn small ghost" onclick="state.cadastros.atendenteEditando=${state.cadastros.atendenteEditando === a.id ? 'null' : a.id}; render();">Editar</button></td>
                  </tr>
                  ${state.cadastros.atendenteEditando === a.id ? `
                  <tr><td colspan="5">
                    <form class="grid-2" style="margin:6px 0" onsubmit="salvarEdicaoAtendente(event, ${a.id}); return false;">
                      <div class="field">
                        <select id="editAtendentePapel_${a.id}">
                          ${Object.entries(PAPEL_LABEL).map(([v, l]) => `<option value="${v}" ${v === a.papel ? 'selected' : ''}>${esc(l)}</option>`).join('')}
                        </select>
                      </div>
                      <div class="field"><label><input type="checkbox" id="editAtendenteAdminTotal_${a.id}" style="width:auto" ${a.admin_total ? 'checked' : ''} /> Administrador total</label></div>
                      <div class="full actions-row">
                        <button type="submit" class="btn small primary">Salvar</button>
                        <button type="button" class="btn small ghost" onclick="state.cadastros.atendenteEditando=null; render();">Cancelar</button>
                      </div>
                    </form>
                  </td></tr>
                  ` : ''}
                `).join('') : '<tr class="empty-row"><td colspan="5">Nenhum ainda.</td></tr>'}
              </tbody>
            </table>
          </div>
          <form class="grid-2" style="margin-top:10px" onsubmit="criarAtendente(event); return false;">
            <div class="field"><input id="novoAtendenteNome" type="text" placeholder="Nome" required /></div>
            <div class="field"><input id="novoAtendenteEmail" type="email" placeholder="Email" required /></div>
            <div class="field">
              <select id="novoAtendenteDepartamento">
                <option value="">Departamento de casa (opcional)</option>
                ${state.ref.departamentos.map(d => `<option value="${d.id}">${esc(d.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <select id="novoAtendentePapel">
                ${Object.entries(PAPEL_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'atendente' ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label><input type="checkbox" id="novoAtendenteAdminTotal" style="width:auto" /> Administrador total</label></div>
            <div class="field full">
              <label class="muted" style="font-size:12px">Departamentos liderados (só usado se o papel escolhido acima for Líder — segure Ctrl pra marcar mais de um)</label>
              <select id="novoAtendenteDepartamentosLiderados" multiple style="min-height:70px">
                ${state.ref.departamentos.map(d => `<option value="${d.id}">${esc(d.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
          </form>
        </div>
      </div>

      <div>
        <div class="card">
          <strong>Feriados</strong>
          <p class="section-desc" style="margin-top:6px">Feriado não conta como dia útil — evita "falta" incorreta no painel do Checklist do CPD e lembrete disparando nesse dia.</p>
          <div class="table-wrap" style="margin-top:10px">
            <table><tbody>
              ${feriados.length ? feriados.map(f => `<tr><td>${esc(f.data.split('-').reverse().join('/'))}</td><td>${esc(f.nome)}</td><td><button class="btn small ghost" onclick="apagarFeriado(${f.id})">Remover</button></td></tr>`).join('') : '<tr class="empty-row"><td colspan="3">Nenhum ainda.</td></tr>'}
            </tbody></table>
          </div>
          <form class="grid-2" style="margin-top:10px" onsubmit="criarFeriado(event); return false;">
            <div class="field"><input id="novoFeriadoData" type="date" required /></div>
            <div class="field"><input id="novoFeriadoNome" type="text" placeholder="Nome do feriado" required /></div>
            <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Políticas de SLA</strong>
          <p class="muted" style="margin-top:6px">Resolvida por categoria; se não houver, cai pra política do departamento inteiro (sem categoria).</p>
          <div class="table-wrap" style="margin-top:10px">
            <table>
              <thead><tr><th>Departamento</th><th>Categoria</th><th>Prioridade</th><th>1ª resp.</th><th>Resolução</th></tr></thead>
              <tbody>
                ${slaPoliticas.length ? slaPoliticas.map(p => `
                  <tr>
                    <td>${esc(state.ref.departamentos.find(d => d.id === p.departamento_id)?.nome || p.departamento_id)}</td>
                    <td>${esc(state.ref.categorias.find(c => c.id === p.categoria_id)?.nome || 'Todas')}</td>
                    <td>${esc(PRIORIDADE_LABEL[p.prioridade] || p.prioridade)}</td>
                    <td>${p.prazo_primeira_resposta_minutos} min</td>
                    <td>${p.prazo_resolucao_minutos} min</td>
                  </tr>
                `).join('') : '<tr class="empty-row"><td colspan="5">Nenhuma política cadastrada — chamados ficam sem prazo de SLA.</td></tr>'}
              </tbody>
            </table>
          </div>
          <form class="grid-2" style="margin-top:10px" onsubmit="criarSlaPolitica(event); return false;">
            <div class="field">
              <select id="novaSlaDepartamento" required>
                <option value="">Departamento...</option>
                ${state.ref.departamentos.map(d => `<option value="${d.id}">${esc(d.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <select id="novaSlaCategoria">
                <option value="">Todas as categorias do departamento</option>
                ${state.ref.categorias.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <select id="novaSlaPrioridade" required>
                ${Object.entries(PRIORIDADE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><input id="novaSlaPrimeiraResposta" type="number" min="1" placeholder="Prazo 1ª resposta (min)" required /></div>
            <div class="field full"><input id="novaSlaResolucao" type="number" min="1" placeholder="Prazo resolução (min)" required /></div>
            <div class="full"><button class="btn small primary" type="submit">Adicionar política</button></div>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <strong>Itens de estoque — mínimo e status</strong>
          <p class="muted" style="margin-top:6px">A aba Estoque &gt; Itens é só leitura. Itens aparecem lá automaticamente ao serem usados numa movimentação; aqui você ajusta o mínimo (usado pra calcular "Comprar") e um status manual, se precisar.</p>
          <div class="table-wrap" style="margin-top:10px">
            <table>
              <thead><tr><th>Item</th><th>Saldo</th><th>Mínimo</th><th>Status manual</th></tr></thead>
              <tbody>
                ${itensEstoque.length ? itensEstoque.map(i => `
                  <tr>
                    <td>${esc(i.item)}</td>
                    <td>${i.saldo}</td>
                    <td><input type="number" min="0" value="${i.minimo}" style="width:70px" onchange="patchEstoqueItem('${i.id}', {minimo:this.value})" /></td>
                    <td>
                      <select onchange="patchEstoqueItem('${i.id}', {statusManual:this.value})">
                        ${ESTOQUE_STATUS_MANUAL_OPCOES.map(o => `<option value="${esc(o)}" ${((i.status_manual || '') === o) ? 'selected' : ''}>${o ? esc(o) : 'Automático'}</option>`).join('')}
                      </select>
                    </td>
                  </tr>
                `).join('') : '<tr class="empty-row"><td colspan="4">Nenhum item ainda — aparece aqui após a primeira movimentação em Estoque.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function criarDepartamento(event) {
  try {
    await api('/departamentos', { method: 'POST', body: { nome: document.getElementById('novoDepartamentoNome').value } });
    toast('Departamento criado.');
    await carregarReferencias();
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarCategoria(event) {
  try {
    await api('/categorias', {
      method: 'POST',
      body: { nome: document.getElementById('novaCategoriaNome').value, departamentoId: Number(document.getElementById('novaCategoriaDepartamento').value) },
    });
    toast('Categoria criada.');
    await carregarReferencias();
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarFeriado(event) {
  try {
    await api('/feriados', {
      method: 'POST',
      body: { data: document.getElementById('novoFeriadoData').value, nome: document.getElementById('novoFeriadoNome').value },
    });
    toast('Feriado cadastrado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function apagarFeriado(id) {
  if (!confirm('Remover este feriado?')) return;
  try {
    await api(`/feriados/${id}`, { method: 'DELETE' });
    toast('Feriado removido.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarSubcategoria(event) {
  try {
    await api('/subcategorias', {
      method: 'POST',
      body: { nome: document.getElementById('novaSubcategoriaNome').value, categoriaId: Number(document.getElementById('novaSubcategoriaCategoria').value) },
    });
    toast('Subcategoria criada.');
    await carregarReferencias();
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarAtendente(event) {
  try {
    const depId = document.getElementById('novoAtendenteDepartamento').value;
    const papel = document.getElementById('novoAtendentePapel').value;
    const criado = await api('/atendentes', {
      method: 'POST',
      body: {
        nome: document.getElementById('novoAtendenteNome').value,
        email: document.getElementById('novoAtendenteEmail').value,
        departamentoId: depId ? Number(depId) : null,
        papel,
        adminTotal: document.getElementById('novoAtendenteAdminTotal').checked,
      },
    });
    if (papel === 'lider') {
      const select = document.getElementById('novoAtendenteDepartamentosLiderados');
      const departamentoIds = [...select.selectedOptions].map((o) => Number(o.value));
      if (departamentoIds.length) {
        await api(`/atendentes/${criado.id}/departamentos-liderados`, { method: 'PUT', body: { departamentoIds } });
      }
    }
    toast('Atendente criado.');
    await carregarReferencias();
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarEdicaoAtendente(event, atendenteId) {
  try {
    await api(`/atendentes/${atendenteId}`, {
      method: 'PATCH',
      body: {
        papel: document.getElementById(`editAtendentePapel_${atendenteId}`).value,
        adminTotal: document.getElementById(`editAtendenteAdminTotal_${atendenteId}`).checked,
      },
    });
    toast('Atendente atualizado.');
    state.cadastros.atendenteEditando = null;
    await carregarReferencias();
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarSlaPolitica(event) {
  try {
    const catId = document.getElementById('novaSlaCategoria').value;
    await api('/sla-politicas', {
      method: 'POST',
      body: {
        departamentoId: Number(document.getElementById('novaSlaDepartamento').value),
        categoriaId: catId ? Number(catId) : null,
        prioridade: document.getElementById('novaSlaPrioridade').value,
        prazoPrimeiraRespostaMinutos: Number(document.getElementById('novaSlaPrimeiraResposta').value),
        prazoResolucaoMinutos: Number(document.getElementById('novaSlaResolucao').value),
      },
    });
    toast('Política de SLA criada.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- View: estoque --------------------------------------------------------
// Migrado da ferramenta antiga (Central-de-Infraestrutura.html), que
// guardava tudo num arquivo .json local. Aqui os mesmos 7 blocos viram 7
// sub-abas, todas lendo/gravando na API nova (ver src/routes/estoque.js).

const ESTOQUE_ABAS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'usados', label: 'Descarte' },
  { key: 'movimentacoes', label: 'Atualizar' },
  { key: 'termos', label: 'Termos' },
  { key: 'moveis', label: 'Equipamentos móveis' },
];
const ESTOQUE_STATUS_MANUAL_OPCOES = ['', 'Fora de mercado', 'Descontinuado'];
// Movimentações e Entregas foram fundidas numa aba só (pedido do usuário —
// as duas eram conceitualmente a mesma coisa, um evento de movimento de
// equipamento). "DEVOLUÇÃO_COLABORADOR" não entra aqui de propósito: só é
// criada pela ação "Registrar devolução" numa ENTREGA específica (por ID),
// nunca digitando o tipo à mão — ver botão na tabela e
// registrarDevolucaoEntrega() abaixo.
const ESTOQUE_MOV_TIPOS = [
  { valor: 'ENTRADA', label: 'Entrada no estoque' },
  { valor: 'SAIDA', label: 'Saída do estoque' },
  { valor: 'ENTREGA', label: 'Entrega a colaborador' },
  { valor: 'EMPRESTIMO', label: 'Empréstimo (home office)' },
];
const ESTOQUE_MOV_TIPO_BADGE = {
  ENTRADA: { texto: 'Entrada', classe: 'sla-cumprido' },
  SAIDA: { texto: 'Saída', classe: 'sla-pendente' },
  ENTREGA: { texto: 'Entrega', classe: 'prioridade-alta' },
  EMPRESTIMO: { texto: 'Empréstimo (home office)', classe: 'prioridade-normal' },
  DEVOLUCAO_COLABORADOR: { texto: 'Devolução (colaborador)', classe: 'sla-cumprido' },
  'DEVOLUÇÃO': { texto: 'Devolução (estoque)', classe: 'sla-pendente' }, // legado, sem pessoa
};

function badgeTipoMovimentacao(tipo) {
  const info = ESTOQUE_MOV_TIPO_BADGE[tipo] || { texto: tipo, classe: 'muted' };
  return `<span class="badge ${info.classe}">${esc(info.texto)}</span>`;
}

function badgeEstoqueStatus(status) {
  const s = (status || '').toUpperCase();
  if (s === 'OK') return `<span class="badge sla-cumprido">OK</span>`;
  if (s === 'COMPRAR') return `<span class="badge sla-violado">Comprar</span>`;
  return `<span class="badge sla-pendente">${esc(status)}</span>`;
}

// Rotatividade não é mais coluna/badge — a linha inteira do item na aba
// Itens fica colorida de acordo com o nível (ver classe aplicada na <tr> em
// viewEstoqueDashboard). Classes CSS em public/index.html (.row-rotatividade-*).
const ROTATIVIDADE_LABEL = { alta: 'Alta rotatividade (3+ saídas/mês)', media: 'Média rotatividade (2 saídas/mês)', nenhuma: 'Sem rotatividade' };

function classeRotatividade(item) {
  const r = item.rotatividade || 'nenhuma';
  return r === 'nenhuma' ? '' : `row-rotatividade-${r}`;
}

// --- Filtro por coluna (tabelas de Estoque e do Checklist do CPD) --------
// Filtros ficam em state[grupo].filtros[aba][coluna] — "grupo" separa os
// namespaces (ex.: 'estoque', 'cpd') pra duas telas diferentes não pisarem
// no filtro uma da outra. Os dados já vieram da API antes de filtrar, então
// digitar filtra na hora, sem nova chamada de rede — dá pra fazer assim
// porque o volume aqui é de dezenas/centenas de linhas, não milhares.

function filtroColuna(grupo, aba, coluna) {
  const filtros = state[grupo].filtros[aba];
  return (filtros && filtros[coluna]) || '';
}

function setFiltroColuna(grupo, aba, coluna, valor) {
  if (!state[grupo].filtros[aba]) state[grupo].filtros[aba] = {};
  state[grupo].filtros[aba][coluna] = valor;
  render();
}

function aplicarFiltrosColuna(linhas, grupo, aba, colunas) {
  const filtros = state[grupo].filtros[aba] || {};
  return linhas.filter((row) => colunas.every((col) => {
    const f = (filtros[col.key] || '').trim().toLowerCase();
    if (!f) return true;
    const valor = col.valor ? col.valor(row) : row[col.key];
    return String(valor ?? '').toLowerCase().includes(f);
  }));
}

function linhaFiltroColunas(grupo, aba, colunas, temColunaExtra) {
  return `<tr class="filtro-row">
    ${colunas.map((col) => `<th><input type="text" data-filtro-key="${grupo}:${aba}:${col.key}" placeholder="Filtrar..." value="${esc(filtroColuna(grupo, aba, col.key))}" oninput="setFiltroColuna('${grupo}','${aba}','${col.key}', this.value)" /></th>`).join('')}
    ${temColunaExtra ? '<th></th>' : ''}
  </tr>`;
}

async function viewEstoque() {
  const aba = state.estoque.subview;
  const conteudo = await viewEstoqueAba(aba);
  return `
    <div class="section-title">Estoque</div>
    <p class="section-desc">Saldo dos itens (Dashboard), descarte, atualização do estoque (entradas, saídas, entregas e empréstimos), termos de colaboradores e equipamentos móveis.</p>
    <div class="toolbar">
      ${ESTOQUE_ABAS.map(a => `
        <button class="btn small ${aba === a.key ? 'primary' : ''}" onclick="state.estoque.subview='${a.key}'; render();">${esc(a.label)}</button>
      `).join('')}
    </div>
    ${conteudo}
  `;
}

async function viewEstoqueAba(aba) {
  if (aba === 'usados') return viewEstoqueUsados();
  if (aba === 'movimentacoes') return viewEstoqueMovimentacoes();
  if (aba === 'termos') return viewEstoqueTermos();
  if (aba === 'moveis') return viewEstoqueMoveis();
  return viewEstoqueDashboard();
}

// Itens-chave (2026-10-05): são os que entram na tabela "Itens importantes" do Dashboard. Casa
// pelo começo do nome do item (sem acento/maiúscula) — "HEADSET ZONE 300",
// "NOTEBOOK DELL PRO 14", "MOUSES", "TECLADO BLUETOOTH" etc. entram;
// "CAPA DE TABLETS", "CARREGADOR DE CELULAR", "RAM's NOTEBOOK" não.
const ESTOQUE_PREFIXOS_CHAVE = ['HEADSET', 'NOTEBOOK', 'DESKTOP', 'MONITOR', 'TECLADO', 'MOUSE', 'CELULAR', 'TABLET', 'CAMERA 4K'];

function normalizarNomeEstoque(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

function ehItemChaveEstoque(nome) {
  const n = normalizarNomeEstoque(nome);
  return ESTOQUE_PREFIXOS_CHAVE.some((p) => n.startsWith(p));
}

// Uma tabela só com TODOS os itens do catálogo (substitui "Itens importantes",
// "Itens precisando comprar" e a antiga aba Itens). Notebook é caso à parte:
// o mínimo (2) vale pra categoria inteira, não por modelo — então entra uma
// linha "NOTEBOOK (total)" com o status de verdade e os modelos aparecem
// abaixo só com o saldo (mesma regra que o resumo/email já usa).
function montarLinhasDashboardEstoque(itens, itensCriticos) {
  const cat = itensCriticos.find((c) => c.categoria === 'Notebook');
  const agregado = cat && cat.itens[0];
  const linhas = [];
  let agregadoInserido = false;
  for (const i of itens) {
    const ehNotebook = normalizarNomeEstoque(i.item).startsWith('NOTEBOOK');
    if (ehNotebook && agregado && !agregadoInserido) {
      linhas.push({
        item: 'NOTEBOOK (total)', detalhe: `${agregado.modelos} modelo(s)`, saldo: agregado.saldo, minimo: agregado.minimo,
        faltam: Math.max(agregado.minimo - agregado.saldo, 0), status: agregado.status, chave: true, rotatividade: 'nenhuma', agregado: true,
      });
      agregadoInserido = true;
    }
    if (ehNotebook) {
      linhas.push({
        item: i.item, auto: i.auto, modelo: true, saldo: i.saldo, minimo: null, faltam: null,
        status: i.status_manual && i.status_manual.trim() ? i.status_manual.trim() : null, chave: true, rotatividade: i.rotatividade,
      });
      continue;
    }
    linhas.push({
      item: i.item, auto: i.auto, saldo: i.saldo, minimo: i.minimo,
      faltam: i.status === 'COMPRAR' ? Math.max(i.minimo - i.saldo, 0) : 0,
      status: i.status, chave: ehItemChaveEstoque(i.item), rotatividade: i.rotatividade,
    });
  }
  return linhas;
}

// Uma linha da tabela do Dashboard (usada pelas duas tabelas: "Itens
// importantes" e "Todos os itens"). A cor da linha é a rotatividade.
function htmlLinhaDashboardEstoque(l) {
  return `
    <tr class="${classeRotatividade(l)}" title="${esc(ROTATIVIDADE_LABEL[l.rotatividade || 'nenhuma'])}">
      <td>${l.modelo ? '<span class="muted">&nbsp;&nbsp;↳ </span>' : ''}${l.agregado ? `<strong>${esc(l.item)}</strong><span class="muted"> (${esc(l.detalhe)})</span>` : esc(l.item)}${l.auto ? '<span class="muted"> (auto)</span>' : ''}</td>
      <td>${l.saldo}</td>
      <td>${l.minimo === null ? '<span class="muted">—</span>' : l.minimo}</td>
      <td>${l.faltam ? l.faltam : '<span class="muted">—</span>'}</td>
      <td>${l.status ? badgeEstoqueStatus(l.status) : '<span class="muted">—</span>'}</td>
    </tr>
  `;
}

async function viewEstoqueDashboard() {
  const [r, itens] = await Promise.all([api('/estoque/resumo'), api('/estoque/itens')]);
  const cards = [
    { rotulo: 'Itens no catálogo', valor: r.totalItens },
    { rotulo: 'Precisando comprar', valor: r.itensComprar.length, critico: r.itensComprar.length > 0 },
    { rotulo: 'Atualizações no mês', valor: r.totalMovimentacoesMes, destino: 'movimentacoes' },
    { rotulo: 'Equipamentos com colaboradores', valor: r.entregasAbertas, destino: 'termos' },
    { rotulo: 'Descarte', valor: r.totalUsados, destino: 'usados' },
    { rotulo: 'Equipamentos móveis', valor: r.totalConsultores + r.totalCorporativos, destino: 'moveis' },
    { rotulo: 'Sem termo assinado', valor: r.colaboradoresSemTermoAssinado.length, critico: r.colaboradoresSemTermoAssinado.length > 0, destino: 'termos' },
  ];

  const colunas = [
    { key: 'item', label: 'Item' },
    { key: 'saldo', label: 'Saldo' },
    { key: 'minimo', label: 'Mínimo', valor: (l) => (l.minimo === null ? '' : l.minimo) },
    { key: 'faltam', label: 'Faltam', valor: (l) => (l.faltam ? l.faltam : '') },
    { key: 'status', label: 'Status', valor: (l) => l.status || '' },
  ];
  const todas = montarLinhasDashboardEstoque(itens, r.itensCriticos);
  const importantes = todas.filter((l) => l.chave);
  const linhas = aplicarFiltrosColuna(todas, 'estoque', 'dashboard', colunas);

  return `
    <div class="stat-cards">
      ${cards.map(c => `
        <div class="stat-card ${c.destino ? 'clicavel' : ''}" ${c.destino ? `onclick="state.estoque.subview='${c.destino}'; render();" title="Abrir"` : ''}>
          <div class="rotulo">${esc(c.rotulo)}</div>
          <div class="valor ${c.critico ? 'critical' : ''}">${c.valor}</div>
        </div>
      `).join('')}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="actions-row" style="margin-top:0; justify-content:space-between; align-items:center;">
        <strong>Itens importantes</strong>
        <button class="btn small primary" onclick="enviarResumoEstoqueEmail()">Enviar resumo por email agora</button>
      </div>
      <p class="muted" style="margin-top:6px">Headset, notebook, desktop, monitor, teclado, mouse, celular, tablet e câmera 4K — acompanhamento permanente, independente do status. Notebook tem o mínimo (2) na categoria inteira, não por modelo.</p>
      <div class="table-wrap scroll" style="margin-top:10px">
        <table>
          <thead><tr><th>Item</th><th>Saldo</th><th>Mínimo</th><th>Faltam</th><th>Status</th></tr></thead>
          <tbody>
            ${importantes.length ? importantes.map(htmlLinhaDashboardEstoque).join('') : `<tr class="empty-row"><td colspan="5">Nenhum item importante cadastrado ainda.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <strong>Todos os itens</strong>
      <p class="muted" style="margin-top:6px">Saldo calculado pelas movimentações da aba Atualizar. Pra ajustar o mínimo ou um status manual de um item, use Cadastros. A cor da linha indica a rotatividade (saídas de estoque neste mês): <span class="legenda-rot legenda-rot-alta">alta (3+/mês)</span> · <span class="legenda-rot legenda-rot-media">média (2/mês)</span> · sem cor = sem rotatividade (0 ou 1 saída).</p>
      <div class="table-wrap scroll" style="margin-top:10px">
        <table>
          <thead>
            <tr><th>Item</th><th>Saldo</th><th>Mínimo</th><th>Faltam</th><th>Status</th></tr>
            ${linhaFiltroColunas('estoque', 'dashboard', colunas, false)}
          </thead>
          <tbody>
            ${linhas.length ? linhas.map(htmlLinhaDashboardEstoque).join('') : `<tr class="empty-row"><td colspan="5">Nenhum item encontrado com esses filtros.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <p class="muted" style="margin-top:10px">Calculado agora (${esc(fmtDataHora(r.geradoEm))}). Envio semanal automático por email pode ser agendado no servidor — ver README, seção "Email do estoque".</p>
  `;
}

async function enviarResumoEstoqueEmail() {
  try {
    const r = await api('/estoque/resumo/email', { method: 'POST' });
    toast(`Resumo enviado para ${r.enviadoPara.join(', ')}.`);
  } catch (e) { toast(e.message, 'erro'); }
}

async function viewEstoqueUsados() {
  const todas = await api('/estoque/usados');
  const colunas = [
    { key: 'item', label: 'Item' },
    { key: 'quantidade', label: 'Quantidade' },
    { key: 'estado', label: 'Estado' },
    { key: 'detalhes', label: 'Detalhes' },
  ];
  const linhas = aplicarFiltrosColuna(todas, 'estoque', 'usados', colunas);
  return `
    <p class="section-desc" style="margin-top:-8px">Itens usados, danificados ou condenados — ficam fora do saldo do estoque.</p>
    <div class="card" style="margin-bottom:16px">
      <form class="grid-2" onsubmit="criarEstoqueUsado(event); return false;">
        <div class="field"><input id="novoUsadoItem" type="text" placeholder="Item" required /></div>
        <div class="field"><input id="novoUsadoQuantidade" type="number" min="0" placeholder="Quantidade" value="1" /></div>
        <div class="field"><input id="novoUsadoEstado" type="text" placeholder="Estado (ex: USADO)" /></div>
        <div class="field"><input id="novoUsadoDetalhes" type="text" placeholder="Detalhes (ex: CONDENADO)" /></div>
        <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
      </form>
    </div>
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Item</th><th>Quantidade</th><th>Estado</th><th>Detalhes</th><th></th></tr>
          ${linhaFiltroColunas('estoque', 'usados', colunas, true)}
        </thead>
        <tbody>
          ${linhas.length ? linhas.map(u => `
            <tr>
              <td>${esc(u.item)}</td><td>${u.quantidade}</td><td>${esc(u.estado || '—')}</td><td>${esc(u.detalhes || '—')}</td>
              <td class="actions"><button class="btn small ghost" onclick="excluirEstoque('usados','${u.id}','Registro removido.')">Excluir</button></td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="5">Nenhum registro encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// Movimentações e Entregas fundidas numa aba só — a mesma tabela cobre 4
// tipos de evento (Entrada no estoque / Saída do estoque / Entrega a
// colaborador / Devolução de colaborador). Os campos de pessoa (usuário,
// host, departamento, modelo, ST, termo) só aparecem no formulário quando
// o tipo escolhido é "Entrega a colaborador" — guardados em
// state.estoque.novoMovTipo pra saber o que mostrar no próximo render().
// "Devolução de colaborador" não é um tipo escolhível no formulário: só é
// criada pelo botão "Registrar devolução" numa linha de Entrega específica
// (por ID, ver registrarDevolucaoEntrega), pra não reintroduzir o problema
// de casar por nome digitado que esse desenho evita desde o início.
async function viewEstoqueMovimentacoes() {
  const [todas, itensCatalogo] = await Promise.all([
    api('/estoque/movimentacoes'),
    api('/estoque/itens'),
  ]);
  const mostrarDevolvidas = !!state.estoque.mostrarDevolvidas;
  const visiveis = mostrarDevolvidas ? todas : todas.filter((m) => !((m.tipo === 'ENTREGA' || m.tipo === 'EMPRESTIMO') && m.devolvido_em));
  const colunas = [
    { key: 'data', label: 'Data' },
    { key: 'tipo', label: 'Tipo' },
    { key: 'equipamento', label: 'Equipamento' },
    { key: 'modelo', label: 'Modelo' },
    { key: 'usuario', label: 'Usuário' },
    { key: 'quantidade', label: 'Qtd' },
    { key: 'descricao', label: 'Descrição' },
  ];
  const linhas = aplicarFiltrosColuna(visiveis, 'estoque', 'movimentacoes', colunas);
  const editandoId = state.estoque.movimentacaoEditando;
  const editando = editandoId ? todas.find((m) => m.id === editandoId) : null;
  // Editar reaproveita o mesmo formulário de criar (2026-09-08) — pré-
  // preenchido com os dados atuais, submit vai pra PATCH em vez de POST
  // (ver salvarEstoqueMovimentacao). Só pode editar ENTRADA/SAIDA/ENTREGA
  // sem termo/devolvida (mesmo bloqueio do backend — botão "Editar" nem
  // aparece nos outros casos, ver abaixo).
  const tipoAtual = editando ? editando.tipo : (state.estoque.novoMovTipo || 'ENTRADA');
  const pedePessoa = tipoAtual === 'ENTREGA' || tipoAtual === 'EMPRESTIMO';
  const v = (campo, padrao = '') => esc((editando ? editando[campo] : null) ?? padrao);
  const recente = state.estoque.termoRecemGerado;
  return `
    ${recente ? `
    <div class="card" style="margin-bottom:16px; border-color: var(--good)">
      <strong>Termo de responsabilidade gerado</strong>
      <p class="muted" style="margin:4px 0 10px 0">${esc(recente.equipamento)} · ${esc(recente.usuario)} — é um termo pra assinar; depois de assinado, envie o arquivo assinado na ficha do equipamento (aba Termos).</p>
      <div class="actions-row" style="margin-top:0">
        <button class="btn small primary" onclick="baixarEstoqueTermo('${recente.termoId}')">Baixar termo</button>
        <button class="btn small" onclick="abrirFichaDoTermoRecente()">Abrir na ficha do colaborador</button>
        <button class="btn small ghost" onclick="state.estoque.termoRecemGerado = null; render();">Fechar</button>
      </div>
    </div>` : ''}
    <div class="card" style="margin-bottom:16px">
      <strong>${editando ? 'Editando movimentação' : 'Nova movimentação'}</strong>
      <form class="grid-2" style="margin-top:10px" onsubmit="salvarEstoqueMovimentacao(event); return false;">
        <div class="field"><input id="novaMovData" type="date" value="${v('data')}" required /></div>
        <div class="field">
          <select id="novaMovTipo" required onchange="state.estoque.novoMovTipo = this.value; render();">
            ${ESTOQUE_MOV_TIPOS.map(t => `<option value="${t.valor}" ${t.valor === tipoAtual ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <input id="novaMovEquipamento" type="text" placeholder="Equipamento (ex: Notebook)" value="${v('equipamento')}" list="listaItensEstoque" autocomplete="off" required />
          <datalist id="listaItensEstoque">
            ${itensCatalogo.map(i => `<option value="${esc(i.item)}"></option>`).join('')}
          </datalist>
        </div>
        <div class="field"><input id="novaMovQuantidade" type="number" min="1" placeholder="Quantidade" value="${v('quantidade', 1)}" required /></div>
        ${pedePessoa ? `
          <div class="field"><input id="novaMovUsuario" type="text" placeholder="Usuário" value="${v('usuario')}" /></div>
          <div class="field"><input id="novaMovHost" type="text" placeholder="Host" value="${v('host')}" /></div>
          <div class="field"><input id="novaMovDepartamento" type="text" placeholder="Departamento" value="${v('departamento')}" /></div>
          <div class="field"><input id="novaMovModelo" type="text" placeholder="Modelo (ex: Dell Pro 14)" value="${v('modelo')}" /></div>
          <div class="field"><input id="novaMovSt" type="text" placeholder="Service tag / nº de série" value="${v('st')}" /></div>
        ` : ''}
        ${tipoAtual === 'ENTREGA' && !editando ? `
          <div class="field full"><label class="muted"><input id="novaMovTermoJaAssinado" type="checkbox" style="width:auto" /> Equipamento já está com a pessoa e o termo já foi assinado (enviado por nós) — não gera termo novo e não altera o saldo do estoque</label></div>
        ` : ''}
        <div class="field full"><input id="novaMovDescricao" type="text" placeholder="Descrição (opcional)" value="${v('descricao')}" /></div>
        <div class="full">
          <button class="btn small primary" type="submit">${editando ? 'Salvar alterações' : 'Registrar'}</button>
          ${editando ? `<button class="btn small ghost" type="button" onclick="state.estoque.movimentacaoEditando = null; render();">Cancelar</button>` : ''}
        </div>
      </form>
    </div>
    <p class="muted" style="margin:-8px 0 12px 0">Item novo cadastrado automaticamente no catálogo (Dashboard) se ainda não existir. Devolução de colaborador não se cria por aqui — use o botão "Registrar devolução" na própria linha da entrega. Registrar uma entrega já gera o Termo de Responsabilidade sozinho (aba Termos) — o botão "Gerar termo" continua lá pra juntar várias pendências num termo só, se precisar. "Empréstimo (home office)" é pra saída temporária (ex.: notebook que vai pra casa na semana): fica no histórico, mas não altera o saldo do estoque nem pede devolução.</p>
    <div class="actions-row" style="margin-bottom:10px">
      <label class="muted"><input type="checkbox" style="width:auto" ${mostrarDevolvidas ? 'checked' : ''} onchange="state.estoque.mostrarDevolvidas = this.checked; render();" /> Mostrar entregas já devolvidas</label>
    </div>
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Data</th><th>Tipo</th><th>Equipamento</th><th>Modelo</th><th>Usuário</th><th>Qtd</th><th>Descrição</th><th></th></tr>
          ${linhaFiltroColunas('estoque', 'movimentacoes', colunas, true)}
        </thead>
        <tbody>
          ${linhas.length ? linhas.map(m => `
            <tr class="${(m.tipo === 'ENTREGA' || m.tipo === 'EMPRESTIMO') && m.devolvido_em ? 'muted' : ''}">
              <td>${esc(m.data)}</td><td>${badgeTipoMovimentacao(m.tipo)}</td><td>${esc(m.equipamento)}</td>
              <td>${esc(m.modelo || '—')}</td><td>${esc(m.usuario || '—')}</td><td>${m.quantidade}</td><td>${esc(m.descricao || '—')}</td>
              <td class="actions">
                ${m.tipo === 'ENTREGA' || m.tipo === 'EMPRESTIMO'
                  ? (m.devolvido_em
                      ? `<span class="badge sla-cumprido">Devolvido</span>`
                      : `<button class="btn small" onclick="registrarDevolucaoEntrega('${m.id}')">Registrar devolução</button>`)
                  : ''}
                ${m.tipo !== 'DEVOLUCAO_COLABORADOR' && !m.termo && !m.devolvido_em
                  ? `<button class="btn small ghost" onclick="state.estoque.movimentacaoEditando='${m.id}'; state.estoque.novoMovTipo='${m.tipo}'; render();">Editar</button>`
                  : ''}
                <button class="btn small ghost" onclick="excluirEstoque('movimentacoes','${m.id}','Movimentação removida.')">Excluir</button>
              </td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="8">Nenhuma movimentação encontrada com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function registrarDevolucaoEntrega(id) {
  if (!confirm('Confirma a devolução desse equipamento? Isso já registra a devolução correspondente em Atualizar.')) return;
  try {
    await api(`/estoque/movimentacoes/${id}/devolver`, { method: 'POST' });
    toast('Devolução registrada.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- View: Termos --------------------------------------------------------
// Reorganizada em 2026-10-05: (1) nada de listagem geral — só uma busca; o
// colaborador, os equipamentos que ele tem em mãos e os termos dele só
// aparecem depois de escolhê-lo; (2) "Enviar termo assinado" é um botão
// único, que tenta reconhecer o colaborador pelo nome do arquivo; (3)
// "Colaboradores sem termo assinado" mora aqui; (4) "Histórico" (termos de
// quem está em arquivo morto + termos gerados pela plataforma) só mostra o
// que for pesquisado.

const ICONE_LUPA = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>';

function rotuloTipoTermo(tipo) {
  return tipo === 'devolucao' ? 'Termo de devolução' : 'Termo de responsabilidade';
}

function rotuloOrigemTermo(origem) {
  return { gerado: 'gerado pela plataforma', sharepoint: 'importado (assinado)', upload: 'enviado (assinado)' }[origem] || origem;
}

function htmlResultadosBuscaColaborador(resultados, q) {
  if ((q || '').trim().length < 2) return '<p class="muted">Digite pelo menos 2 letras do nome ou do usuário.</p>';
  if (!resultados.length) return '<p class="muted">Nenhum colaborador encontrado.</p>';
  return resultados.map((c) => `
    <button type="button" class="busca-resultado" onclick="selecionarColaboradorTermos('${c.id}')">
      <strong>${esc(c.nome)}</strong> <span class="muted">· ${esc(c.usuario || 'sem usuário')}</span>
    </button>
  `).join('');
}

let termosBuscaTimer = null;
function buscarColaboradorTermos(valor) {
  state.estoque.termosBusca = valor;
  clearTimeout(termosBuscaTimer);
  termosBuscaTimer = setTimeout(async () => {
    const q = valor.trim();
    let resultados = [];
    if (q.length >= 2) {
      try { resultados = await api(`/estoque/colaboradores?q=${encodeURIComponent(q)}`); }
      catch (e) { toast(e.message, 'erro'); return; }
    }
    if (state.estoque.termosBusca !== valor) return; // chegou uma digitação mais nova enquanto buscava
    state.estoque.termosResultados = resultados;
    const el = document.getElementById('termosResultados');
    if (el) el.innerHTML = htmlResultadosBuscaColaborador(resultados, q);
  }, 200);
}

function selecionarColaboradorTermos(id) {
  state.estoque.termosColabId = id;
  state.estoque.fichaEditandoId = null;
  state.estoque.unificar = null;
  state.estoque.equipAbertos = [];
  state.estoque.termosBusca = '';
  state.estoque.termosResultados = [];
  state.estoque.termoSelecao = null;
  state.estoque.termoDevolucaoSelecao = null;
  render();
}

function htmlResultadosHistorico(resultados, q) {
  if ((q || '').trim().length < 2) return '<p class="muted">Digite pelo menos 2 letras do nome ou do usuário.</p>';
  if (!resultados.length) return '<p class="muted">Nenhum termo encontrado no histórico.</p>';
  return `
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th>Colaborador</th><th>Tipo</th><th>Data</th><th>Origem</th><th></th></tr></thead>
        <tbody>
          ${resultados.map((t) => `
            <tr>
              <td>${esc(t.colaborador_nome)}${t.colaborador_ativo === 0 ? ' <span class="badge sla-pendente">arquivo morto</span>' : ''}</td>
              <td>${t.tipo === 'devolucao' ? '<span class="badge sla-pendente">Devolução</span>' : '<span class="badge sla-cumprido">Responsabilidade</span>'}</td>
              <td>${esc(fmtDataHora(t.data_assinatura || t.gerado_em))}</td>
              <td>${esc(rotuloOrigemTermo(t.origem))}</td>
              <td class="actions">
                ${t.arquivo ? `<button class="btn small" onclick="baixarEstoqueTermo('${t.id}')">Baixar</button>` : '<span class="muted">sem arquivo</span>'}
                <button class="btn small ghost" onclick="excluirTermoEstoque('${t.id}', true)">Excluir</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

let historicoBuscaTimer = null;
function buscarHistoricoTermos(valor) {
  state.estoque.historicoBusca = valor;
  clearTimeout(historicoBuscaTimer);
  historicoBuscaTimer = setTimeout(async () => {
    const q = valor.trim();
    let resultados = [];
    if (q.length >= 2) {
      try { resultados = await api(`/estoque/termos/historico?q=${encodeURIComponent(q)}`); }
      catch (e) { toast(e.message, 'erro'); return; }
    }
    if (state.estoque.historicoBusca !== valor) return;
    state.estoque.historicoResultados = resultados;
    const el = document.getElementById('historicoResultados');
    if (el) el.innerHTML = htmlResultadosHistorico(resultados, q);
  }, 200);
}

function alternarHistoricoTermos() {
  state.estoque.historicoAberto = !state.estoque.historicoAberto;
  if (!state.estoque.historicoAberto) { state.estoque.historicoBusca = ''; state.estoque.historicoResultados = []; }
  render().then(() => {
    const el = document.getElementById('historicoBuscaInput');
    if (el) el.focus();
  });
}

async function excluirTermoEstoque(id, doHistorico) {
  if (!confirm('Excluir este termo? Isso não pode ser desfeito.')) return;
  try {
    await api(`/estoque/termos/${id}`, { method: 'DELETE' });
    toast('Termo removido.');
    if (doHistorico) {
      const q = (state.estoque.historicoBusca || '').trim();
      state.estoque.historicoResultados = q.length >= 2 ? await api(`/estoque/termos/historico?q=${encodeURIComponent(q)}`) : [];
    }
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- Ficha do colaborador + equipamentos em mãos (2026-10-09) --------------
// A pessoa aberta em Termos aparece como uma ficha com os dados travados (só
// editam depois do botão "Editar"); embaixo vêm os equipamentos que ela tem
// em mãos — cada linha abre uma ficha do equipamento com os termos dele, a
// situação do termo e os botões (gerar, baixar, enviar assinado). Os botões de
// termo são por equipamento, não gerais.

function badgeSituacaoTermo(situacao) {
  if (situacao === 'assinado') return '<span class="badge sla-cumprido">Assinado</span>';
  if (situacao === 'gerado') return '<span class="badge sla-pendente">Gerado — aguardando assinatura</span>';
  return '<span class="badge sla-violado">Sem termo</span>';
}

function textoSituacaoTermo(situacao) {
  if (situacao === 'assinado') return 'Existe termo de responsabilidade assinado cobrindo este equipamento.';
  if (situacao === 'gerado') return 'O termo foi gerado pela plataforma, mas a versão assinada ainda não foi enviada.';
  return 'Nenhum termo cobre este equipamento ainda.';
}

function alternarEquipamentoFicha(id) {
  const abertos = state.estoque.equipAbertos || [];
  state.estoque.equipAbertos = abertos.includes(id) ? abertos.filter((x) => x !== id) : [...abertos, id];
  render();
}

function editarFichaColaborador(id) {
  state.estoque.fichaEditandoId = id;
  render();
}

function cancelarFichaColaborador() {
  state.estoque.fichaEditandoId = null;
  render();
}

async function salvarFichaColaborador(id) {
  const lido = (campo) => document.getElementById(`ficha${campo}`).value.trim();
  const nome = lido('Nome');
  if (!nome) {
    toast('Informe o nome do colaborador.', 'erro');
    return;
  }
  const corpo = {
    nome,
    usuario: lido('Usuario') || null,
    cpf: lido('Cpf') || null,
    rg: lido('Rg') || null,
    telefone: lido('Telefone') || null,
    nacionalidade: lido('Nacionalidade') || null,
    estadoCivil: lido('EstadoCivil') || null,
    endereco: lido('Endereco') || null,
    cargo: lido('Cargo') || null,
    departamento: lido('Departamento') || null,
  };
  try {
    await api(`/estoque/colaboradores/${id}`, { method: 'PATCH', body: corpo });
    toast('Dados do colaborador atualizados.');
    state.estoque.fichaEditandoId = null;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- Unificar cadastros duplicados (2026-10-16) -----------------------------
// Aberto a partir da ficha do colaborador: o cadastro aberto é o PRINCIPAL; os
// marcados aqui são unidos a ele (termos e equipamentos passam pra cá, e os
// outros cadastros são apagados — o servidor faz backup do banco antes).

async function abrirUnificarCadastros(colaboradorId) {
  try {
    const candidatos = await api(`/estoque/colaboradores/${colaboradorId}/possiveis-duplicados`);
    state.estoque.unificar = { colabId: colaboradorId, candidatos: candidatos.map((c) => ({ ...c, marcado: false })) };
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function fecharUnificarCadastros() {
  state.estoque.unificar = null;
  render();
}

function alternarDuplicadoUnificar(id, marcado) {
  const u = state.estoque.unificar;
  if (!u) return;
  const c = u.candidatos.find((x) => x.id === id);
  if (c) c.marcado = marcado;
  const botao = document.getElementById('botaoConfirmarUnificar');
  if (botao) {
    const n = u.candidatos.filter((x) => x.marcado).length;
    botao.disabled = n === 0;
    botao.textContent = n ? `Unificar ${n} cadastro(s) neste` : 'Marque os cadastros a unificar';
  }
}

function htmlResultadosBuscaUnificar(resultados) {
  const u = state.estoque.unificar;
  const jaNaLista = new Set(u ? u.candidatos.map((c) => c.id) : []);
  const novos = resultados.filter((c) => c.id !== (u && u.colabId) && !jaNaLista.has(c.id));
  if (!novos.length) return '<p class="muted" style="margin:6px 0">Nenhum outro cadastro encontrado.</p>';
  return novos.map((c) => `
    <button type="button" class="busca-resultado" onclick="adicionarCandidatoUnificar('${c.id}')">
      <strong>${esc(c.nome)}</strong> <span class="muted">· ${esc(c.usuario || 'sem usuário')} — adicionar à lista</span>
    </button>`).join('');
}

let unificarBuscaTimer = null;
function buscarOutroCadastroUnificar(valor) {
  clearTimeout(unificarBuscaTimer);
  unificarBuscaTimer = setTimeout(async () => {
    const q = valor.trim();
    const el = document.getElementById('unificarBuscaResultados');
    if (!el) return;
    if (q.length < 2) { el.innerHTML = ''; return; }
    try {
      const resultados = await api(`/estoque/colaboradores?q=${encodeURIComponent(q)}`);
      state.estoque.unificarBuscaUltima = resultados;
      el.innerHTML = htmlResultadosBuscaUnificar(resultados);
    } catch (e) { toast(e.message, 'erro'); }
  }, 200);
}

function adicionarCandidatoUnificar(id) {
  const u = state.estoque.unificar;
  const achado = (state.estoque.unificarBuscaUltima || []).find((c) => c.id === id);
  if (!u || !achado) return;
  u.candidatos.push({ id: achado.id, nome: achado.nome, usuario: achado.usuario, origem: achado.origem, ativo: achado.ativo, termos: null, equipamentosEmMaos: null, marcado: true });
  state.estoque.unificarBuscaUltima = [];
  render();
}

async function confirmarUnificarCadastros(colaboradorId, nomePrincipal) {
  const u = state.estoque.unificar;
  if (!u) return;
  const marcados = u.candidatos.filter((c) => c.marcado);
  if (!marcados.length) return;
  const lista = marcados.map((c) => `• ${c.nome}${c.usuario ? ` (${c.usuario})` : ''}`).join('\n');
  if (!confirm(`Unificar em "${nomePrincipal}" os cadastros abaixo?\n\n${lista}\n\nOs termos e os equipamentos desses cadastros passam pra "${nomePrincipal}" e eles são APAGADOS. O servidor faz um backup do banco antes.`)) return;
  try {
    const r = await api(`/estoque/colaboradores/${colaboradorId}/unificar`, { method: 'POST', body: { duplicadoIds: marcados.map((c) => c.id) } });
    state.estoque.unificar = null;
    toast(`Cadastros unificados: ${r.unificados} cadastro(s), ${r.termosMovidos} termo(s) e ${r.movimentacoesAjustadas} movimentação(ões) ajustados.`);
    if (r.repetidos && r.repetidos.length) {
      alert(`Atenção: depois de unificar, estes equipamentos aparecem repetidos em "Equipamentos em mãos" (provavelmente foram registrados duas vezes). Confira e, se for repetição, exclua a linha extra em Atualizar:\n\n${r.repetidos.map((x) => `• ${x.equipamento}${x.modelo ? ' ' + x.modelo : ''}${x.st ? ' — ST ' + x.st : ''} (${x.n}x)`).join('\n')}`);
    }
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function htmlPainelUnificar(c) {
  const u = state.estoque.unificar;
  const n = u.candidatos.filter((x) => x.marcado).length;
  return `
    <div class="card" style="margin-bottom:16px; border-color: var(--warning)">
      <strong style="font-size:16px">Unificar cadastros duplicados</strong>
      <p class="muted" style="margin:4px 0 10px 0">Este cadastro (<strong>${esc(c.nome)}</strong>) é o que fica. Marque os cadastros da mesma pessoa pra unir a ele: os termos e os equipamentos passam pra cá e os cadastros marcados são apagados (backup do banco antes).</p>
      ${u.candidatos.length ? u.candidatos.map((d) => `
        <label style="display:block; padding:8px 10px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; cursor:pointer">
          <input type="checkbox" style="width:auto" ${d.marcado ? 'checked' : ''} onchange="alternarDuplicadoUnificar('${d.id}', this.checked)" />
          <strong>${esc(d.nome)}</strong> <span class="muted">· ${esc(d.usuario || 'sem usuário')} · origem: ${esc(d.origem)}${d.ativo === 0 ? ' · arquivo morto' : ''}${d.termos === null ? '' : ` — ${d.termos} termo(s), ${d.equipamentosEmMaos} equipamento(s) em mãos`}</span>
        </label>`).join('') : '<p class="muted">Nenhum cadastro parecido encontrado automaticamente — use a busca abaixo.</p>'}
      <div class="field" style="max-width:420px; margin-top:10px">
        <input type="text" placeholder="Buscar outro cadastro pra adicionar (nome ou usuário)..." oninput="buscarOutroCadastroUnificar(this.value)" autocomplete="off" />
      </div>
      <div id="unificarBuscaResultados" style="margin-top:6px"></div>
      <div class="actions-row">
        <button id="botaoConfirmarUnificar" class="btn small primary" ${n ? '' : 'disabled'} onclick="confirmarUnificarCadastros('${c.id}', ${JSON.stringify(c.nome).replace(/"/g, '&quot;')})">${n ? `Unificar ${n} cadastro(s) neste` : 'Marque os cadastros a unificar'}</button>
        <button class="btn small ghost" onclick="fecharUnificarCadastros()">Cancelar</button>
      </div>
    </div>
  `;
}

function itemDaFicha(itemId) {
  return (state.estoque.equipamentosFicha || []).find((i) => i.id === itemId);
}

async function gerarTermoDoEquipamento(colaboradorId, itemId) {
  const item = itemDaFicha(itemId);
  if (!item) return;
  try {
    await api('/estoque/termos', { method: 'POST', body: { colaboradorId, itens: [item] } });
    toast('Termo gerado — baixe na ficha do equipamento.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function gerarDevolucaoDoEquipamento(colaboradorId, itemId) {
  const item = itemDaFicha(itemId);
  if (!item) return;
  const ehDesligamento = confirm('Essa devolução é por desligamento?\n\nOK = Sim (pede a data de desligamento)\nCancelar = Não (outro motivo — o termo sai sem mencionar desligamento)');
  let dataDesligamento = null;
  if (ehDesligamento) {
    dataDesligamento = prompt('Data de desligamento (DD/MM/AAAA):', new Date().toLocaleDateString('pt-BR'));
    if (dataDesligamento === null) return;
  }
  try {
    await api('/estoque/termos/devolucao', {
      method: 'POST',
      body: { colaboradorId, itens: [{ id: item.id }], motivo: ehDesligamento ? 'desligamento' : 'outro', dataDesligamento },
    });
    toast('Termo de devolução gerado — o equipamento foi baixado de "em mãos".');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// Envio de termo assinado a partir da ficha de UM equipamento: o colaborador,
// o equipamento e o tipo (responsabilidade ou devolução) já estão definidos
// pelo botão clicado, então não há pergunta nenhuma — só escolher o arquivo.
let estoqueUploadEquip = null;

function enviarTermoAssinadoDoEquipamento(colaboradorId, itemId, tipo) {
  estoqueUploadEquip = { colaboradorId, itemId, tipo };
  document.getElementById('estoqueTermoEquipInput').click();
}

async function processarUploadEquipamento(event) {
  const arquivo = event.target.files[0];
  event.target.value = '';
  const ctx = estoqueUploadEquip;
  estoqueUploadEquip = null;
  if (!arquivo || !ctx) return;
  const item = itemDaFicha(ctx.itemId);
  if (ctx.tipo === 'devolucao' && !confirm(`Esse termo de devolução assinado dá baixa em "${item ? item.equipamento : 'este equipamento'}" (sai de "Equipamentos em mãos" e volta pro estoque). Confirma?`)) return;
  const dados = new FormData();
  dados.set('colaboradorId', ctx.colaboradorId);
  dados.set('tipo', ctx.tipo);
  dados.set('arquivo', arquivo);
  dados.set('itensIds', JSON.stringify([ctx.itemId]));
  try {
    const resp = await fetch(`${API}/estoque/termos/upload`, { method: 'POST', body: dados, credentials: 'same-origin' });
    const corpo = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((corpo && corpo.erro) || `Erro ${resp.status}`);
    toast(ctx.tipo === 'devolucao' ? 'Termo de devolução assinado enviado — equipamento baixado.' : 'Termo de responsabilidade assinado enviado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function htmlFichaEquipamento(colaborador, i) {
  const origem = i.emprestimo ? 'Empréstimo (home office)' : 'Entrega a colaborador';
  const cid = colaborador.id;
  return `
    <div class="card" style="margin:4px 0">
      <div class="grid-2" style="margin-bottom:10px">
        <div><span class="ficha-rotulo">Equipamento</span><strong>${esc(i.equipamento)}</strong></div>
        <div><span class="ficha-rotulo">Modelo</span>${esc(i.modelo || '—')}</div>
        <div><span class="ficha-rotulo">Service tag / série</span>${esc(i.st || '—')}</div>
        <div><span class="ficha-rotulo">Como está com a pessoa</span>${esc(origem)} · ${i.diasComPessoa} dia(s)</div>
      </div>
      <div style="margin-bottom:10px">
        <span class="ficha-rotulo">Situação do termo</span>
        ${badgeSituacaoTermo(i.situacaoTermo)} <span class="muted">${esc(textoSituacaoTermo(i.situacaoTermo))}</span>
      </div>

      <strong>Termos deste equipamento</strong>
      <div class="table-wrap scroll" style="margin:8px 0 12px 0">
        <table>
          <thead><tr><th>Tipo</th><th>Data</th><th>Origem</th><th></th></tr></thead>
          <tbody>
            ${i.termos.length ? i.termos.map((t) => `
              <tr>
                <td>${t.tipo === 'devolucao' ? '<span class="badge sla-pendente">Devolução</span>' : '<span class="badge sla-cumprido">Responsabilidade</span>'}</td>
                <td>${esc(fmtDataHora(t.data))}</td>
                <td>${esc(rotuloOrigemTermo(t.origem))}</td>
                <td class="actions">
                  ${t.temArquivo ? `<button class="btn small" onclick="baixarEstoqueTermo('${t.id}')">Baixar</button>` : '<span class="muted">sem arquivo</span>'}
                  <button class="btn small ghost" onclick="excluirTermoEstoque('${t.id}', false)">Excluir</button>
                </td>
              </tr>
            `).join('') : `<tr class="empty-row"><td colspan="4">Nenhum termo cobre este equipamento ainda.</td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="actions-row" style="margin-top:0">
        <button class="btn small primary" onclick="gerarTermoDoEquipamento('${cid}', '${i.id}')">Gerar termo de responsabilidade</button>
        <button class="btn small" onclick="gerarDevolucaoDoEquipamento('${cid}', '${i.id}')">Gerar termo de devolução</button>
        <button class="btn small" onclick="enviarTermoAssinadoDoEquipamento('${cid}', '${i.id}', 'responsabilidade')">Enviar termo de responsabilidade assinado</button>
        <button class="btn small" onclick="enviarTermoAssinadoDoEquipamento('${cid}', '${i.id}', 'devolucao')">Enviar termo de devolução assinado</button>
      </div>
    </div>
  `;
}

function htmlFichaColaborador(c, equipamentos, termosSoltos = []) {
  const e = state.estoque;
  const editando = e.fichaEditandoId === c.id;
  const abertos = e.equipAbertos || [];
  const campo = (idCampo, rotulo, valor, largo) => `
    <div class="field ${largo ? 'full' : ''}">
      <label class="ficha-rotulo" for="ficha${idCampo}">${rotulo}</label>
      <input id="ficha${idCampo}" type="text" value="${esc(valor ?? '')}" ${editando ? '' : 'disabled'} />
    </div>`;

  return `
    <div class="card ficha" style="margin-bottom:16px">
      <div class="actions-row" style="margin-top:0; justify-content:space-between; align-items:center;">
        <strong style="font-size:16px">Ficha do colaborador</strong>
        <button class="btn small ghost" onclick="state.estoque.termosColabId = null; state.estoque.fichaEditandoId = null; state.estoque.unificar = null; state.estoque.termoSelecao = null; state.estoque.termoDevolucaoSelecao = null; render();">Fechar</button>
      </div>
      <div class="grid-2" style="margin-top:10px">
        ${campo('Nome', 'Nome completo', c.nome, true)}
        ${campo('Usuario', 'Usuário', c.usuario)}
        ${campo('Cpf', 'CPF', c.cpf)}
        ${campo('Rg', 'RG', c.rg)}
        ${campo('Telefone', 'Telefone', c.telefone)}
        ${campo('Nacionalidade', 'Nacionalidade', c.nacionalidade)}
        ${campo('EstadoCivil', 'Estado civil', c.estado_civil)}
        ${campo('Cargo', 'Cargo', c.cargo)}
        ${campo('Endereco', 'Endereço completo', c.endereco, true)}
        ${campo('Departamento', 'Departamento', c.departamento)}
      </div>
      <div class="actions-row">
        ${editando
          ? `<button class="btn small primary" onclick="salvarFichaColaborador('${c.id}')">Salvar alterações</button>
             <button class="btn small ghost" onclick="cancelarFichaColaborador()">Cancelar</button>`
          : `<button class="btn small" onclick="editarFichaColaborador('${c.id}')">Editar</button>
             <button class="btn small" onclick="abrirUnificarCadastros('${c.id}')">Unificar cadastros duplicados…</button>
             <button class="btn small ghost" onclick="excluirEstoque('colaboradores','${c.id}','Colaborador removido.')">Excluir</button>`}
      </div>
    </div>

    ${e.unificar && e.unificar.colabId === c.id ? htmlPainelUnificar(c) : ''}

    <div class="card" style="margin-bottom:16px">
      <div class="actions-row" style="margin-top:0; justify-content:space-between; align-items:center;">
        <strong style="font-size:16px">Equipamentos em mãos (${equipamentos.length})</strong>
        <button class="btn small" title="Guarda o termo assinado nesta pessoa sem ligar a equipamento e sem mexer no estoque" onclick="enviarTermoAssinadoDaPessoa('${c.id}', true)">Enviar termo assinado (sem mexer no estoque)</button>
      </div>
      <p class="muted" style="margin:4px 0 10px 0">Clique num equipamento pra abrir a ficha dele: termos, situação e botões de termo.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Equipamento</th><th>Modelo</th><th>ST</th><th>Qtd</th><th>Situação do termo</th><th>Com a pessoa há</th></tr></thead>
          <tbody>
            ${equipamentos.length ? equipamentos.map((i) => {
              const aberto = abertos.includes(i.id);
              return `
              <tr class="equip-linha ${aberto ? 'aberta' : ''}" onclick="alternarEquipamentoFicha('${i.id}')" ${i.parado ? 'style="box-shadow: inset 4px 0 0 var(--critical)"' : ''}>
                <td><span class="equip-seta">${aberto ? '▾' : '▸'}</span></td>
                <td>${esc(i.equipamento)}${i.emprestimo ? ' <span class="badge prioridade-normal">home office</span>' : ''}</td>
                <td>${esc(i.modelo || '—')}</td><td>${esc(i.st || '—')}</td><td>${i.quantidade}</td>
                <td>${badgeSituacaoTermo(i.situacaoTermo)}</td>
                <td>${i.diasComPessoa} dia(s)${i.parado ? ' ⚠️' : ''}</td>
              </tr>
              ${aberto ? `<tr class="equip-ficha"><td colspan="7">${htmlFichaEquipamento(c, i)}</td></tr>` : ''}`;
            }).join('') : `<tr class="empty-row"><td colspan="7">Nenhum equipamento em mãos no momento.</td></tr>`}
          </tbody>
        </table>
      </div>
      ${equipamentos.length > 1 ? `
      <div class="actions-row" style="margin-top:12px">
        <button class="btn small ghost" onclick="abrirSelecaoTermo('${c.id}')">Gerar um termo único com vários equipamentos…</button>
        <button class="btn small ghost" onclick="abrirSelecaoTermoDevolucao('${c.id}')">Devolução de vários equipamentos (ex.: desligamento)…</button>
      </div>` : ''}
    </div>

    ${termosSoltos.length ? `
    <div class="card" style="margin-bottom:16px">
      <strong style="font-size:16px">Termos no perfil (fora dos equipamentos em mãos)</strong>
      <p class="muted" style="margin:4px 0 8px 0">Termos guardados nesta pessoa que não estão ligados a um equipamento que ela tem agora — enviados sem vínculo, de equipamentos já devolvidos ou termos de devolução. Os dos equipamentos em mãos ficam dentro de cada equipamento, acima.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tipo</th><th>Data</th><th>Origem</th><th></th></tr></thead>
          <tbody>
            ${termosSoltos.map((t) => `
              <tr>
                <td>${t.tipo === 'devolucao' ? '<span class="badge sla-pendente">Devolução</span>' : '<span class="badge sla-cumprido">Responsabilidade</span>'}</td>
                <td>${esc(fmtDataHora(t.data_assinatura || t.gerado_em))}</td>
                <td>${esc(rotuloOrigemTermo(t.origem))}</td>
                <td class="actions">
                  ${t.arquivo ? `<button class="btn small" onclick="baixarEstoqueTermo('${t.id}')">Baixar</button>` : '<span class="muted">sem arquivo</span>'}
                  <button class="btn small ghost" onclick="excluirTermoEstoque('${t.id}', false)">Excluir</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

async function viewEstoqueTermos() {
  const e = state.estoque;
  const [resumo, colaboradores] = await Promise.all([api('/estoque/resumo'), api('/estoque/colaboradores')]);

  // Edição dos dados mora na ficha do colaborador (htmlFichaColaborador); este
  // formulário do topo é só pra cadastrar gente nova.
  const editando = null;
  const mostrarForm = !!e.colaboradorFormAberto;
  const v = (campo, padrao) => esc(padrao ?? '');

  const selecionado = e.termosColabId ? colaboradores.find((c) => c.id === e.termosColabId) : null;
  if (e.termosColabId && !selecionado) e.termosColabId = null;
  let equipamentos = [];
  let termosSoltos = [];
  if (selecionado) {
    const [itensEmMaos, termosDaPessoa] = await Promise.all([
      api(`/estoque/colaboradores/${selecionado.id}/equipamentos`),
      api(`/estoque/termos?colaboradorId=${selecionado.id}`),
    ]);
    equipamentos = itensEmMaos;
    // Termos do perfil que NÃO aparecem dentro de um equipamento em mãos:
    // enviados sem vínculo, de equipamentos já devolvidos, termos de
    // devolução... (os ligados a equipamento em mãos aparecem na ficha dele).
    const idsNosEquipamentos = new Set(itensEmMaos.flatMap((i) => i.termos.map((t) => t.id)));
    termosSoltos = termosDaPessoa.filter((t) => !idsNosEquipamentos.has(t.id));
  }
  e.equipamentosFicha = equipamentos;

  const semAssinado = resumo.colaboradoresSemTermoAssinado;

  return `
    <p class="section-desc" style="margin-top:-8px">Pesquise um colaborador pra ver os equipamentos que ele tem em mãos e os termos dele, gerar um termo de responsabilidade ou de devolução. Cadastre os dados pessoais uma vez — CPF, endereço etc. não vêm do AD, precisam ser preenchidos aqui. Já tem o termo assinado (escaneado ou foto)? Use "Enviar termo assinado".</p>
    <input type="file" id="estoqueTermoUploadInput" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif" style="display:none" onchange="processarUploadEstoqueTermo(event)" />
    <input type="file" id="estoqueTermoEquipInput" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif" style="display:none" onchange="processarUploadEquipamento(event)" />

    <div class="actions-row" style="margin-bottom:16px">
      <button class="btn small primary" onclick="enviarTermoAssinadoGeral()">Enviar termo assinado</button>
      <button class="btn small" onclick="state.estoque.colaboradorEditando = null; state.estoque.colaboradorFormAberto = !state.estoque.colaboradorFormAberto; render();">Novo colaborador</button>
    </div>

    ${viewUploadTermoPendente()}

    ${mostrarForm ? `
    <div class="card" style="margin-bottom:16px">
      <strong>${editando ? `Editando: ${esc(editando.nome)}` : 'Novo colaborador'}</strong>
      <form class="grid-2" style="margin-top:10px" onsubmit="salvarEstoqueColaborador(event); return false;">
        <div class="field"><input id="novoColabNome" type="text" placeholder="Nome completo" value="${v('nome')}" required /></div>
        <div class="field"><input id="novoColabUsuario" type="text" placeholder="Usuário (ex: aline.amorim) — opcional" value="${v('usuario')}" /></div>
        <div class="field"><input id="novoColabCpf" type="text" placeholder="CPF" value="${v('cpf')}" /></div>
        <div class="field"><input id="novoColabRg" type="text" placeholder="RG" value="${v('rg')}" /></div>
        <div class="field"><input id="novoColabTelefone" type="text" placeholder="Telefone" value="${v('telefone')}" /></div>
        <div class="field"><input id="novoColabNacionalidade" type="text" placeholder="Nacionalidade" value="${v('nacionalidade', editando ? '' : 'Brasileira')}" /></div>
        <div class="field"><input id="novoColabEstadoCivil" type="text" placeholder="Estado civil" value="${v('estado_civil')}" /></div>
        <div class="field full"><input id="novoColabEndereco" type="text" placeholder="Endereço completo" value="${v('endereco')}" /></div>
        <div class="field"><input id="novoColabCargo" type="text" placeholder="Cargo" value="${v('cargo')}" /></div>
        <div class="field"><input id="novoColabDepartamento" type="text" placeholder="Departamento" value="${v('departamento')}" /></div>
        <div class="full">
          <button class="btn small primary" type="submit">${editando ? 'Salvar alterações' : 'Salvar colaborador'}</button>
          <button class="btn small ghost" type="button" onclick="state.estoque.colaboradorEditando = null; state.estoque.colaboradorFormAberto = false; render();">Cancelar</button>
        </div>
      </form>
    </div>` : ''}

    <div class="section-title" style="font-size:16px">Colaboradores</div>
    <div class="field" style="max-width:460px">
      <input id="termosBuscaInput" type="text" placeholder="Pesquisar colaborador (nome ou usuário)..." value="${esc(e.termosBusca || '')}" oninput="buscarColaboradorTermos(this.value)" autocomplete="off" />
    </div>
    <div id="termosResultados" style="margin:10px 0 18px 0">${selecionado ? '' : htmlResultadosBuscaColaborador(e.termosResultados || [], e.termosBusca || '')}</div>

    ${selecionado ? htmlFichaColaborador(selecionado, equipamentos, termosSoltos) : ''}

    ${viewSelecaoTermo()}
    ${viewSelecaoTermoDevolucao()}

    <div class="card" style="margin-bottom:20px">
      <strong>Colaboradores sem termo assinado (${semAssinado.length})</strong>
      <p class="muted" style="margin-top:6px">Inclui quem nunca teve termo, quem só tem um termo gerado e ainda não assinado, e quem só tem termo de devolução (só um termo de responsabilidade assinado conta). Clique no nome pra abrir o colaborador.</p>
      <div class="table-wrap scroll" style="margin-top:10px">
        <table>
          <thead><tr><th>Nome</th><th>Cargo</th><th>Departamento</th><th>Situação</th></tr></thead>
          <tbody>
            ${semAssinado.length ? semAssinado.map(c => `
              <tr>
                <td><a href="#" onclick="selecionarColaboradorTermos('${c.id}'); window.scrollTo(0, 0); return false;">${esc(c.nome)}</a></td><td>${esc(c.cargo || '—')}</td><td>${esc(c.departamento || '—')}</td>
                <td>${c.situacao === 'sem_termo' ? '<span class="badge sla-violado">Sem termo</span>' : c.situacao === 'so_devolucao' ? '<span class="badge sla-pendente">Só termo de devolução</span>' : '<span class="badge sla-pendente">Gerado, não assinado</span>'}</td>
              </tr>
            `).join('') : `<tr class="empty-row"><td colspan="4">Todo mundo ativo tem termo assinado.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="actions-row" style="margin:0 0 10px 0; justify-content:flex-start; align-items:center; gap:10px">
      <div class="section-title" style="font-size:16px; margin:0">Histórico</div>
      <button class="icone-lupa" title="Pesquisar no histórico" aria-label="Pesquisar no histórico" onclick="alternarHistoricoTermos()">${ICONE_LUPA}</button>
    </div>
    ${e.historicoAberto ? `
      <p class="muted" style="margin:0 0 8px 0">Termos de quem está em arquivo morto e termos gerados pela plataforma. Só aparece o que você pesquisar.</p>
      <div class="field" style="max-width:460px">
        <input id="historicoBuscaInput" type="text" placeholder="Pesquisar no histórico (nome ou usuário)..." value="${esc(e.historicoBusca || '')}" oninput="buscarHistoricoTermos(this.value)" autocomplete="off" />
      </div>
      <div id="historicoResultados" style="margin-top:10px">${htmlResultadosHistorico(e.historicoResultados || [], e.historicoBusca || '')}</div>
    ` : ''}
  `;
}

async function salvarEstoqueColaborador(event) {
  const editandoId = state.estoque.colaboradorEditando;
  const corpo = {
    nome: document.getElementById('novoColabNome').value,
    usuario: document.getElementById('novoColabUsuario').value || null,
    cpf: document.getElementById('novoColabCpf').value || null,
    rg: document.getElementById('novoColabRg').value || null,
    telefone: document.getElementById('novoColabTelefone').value || null,
    nacionalidade: document.getElementById('novoColabNacionalidade').value || null,
    estadoCivil: document.getElementById('novoColabEstadoCivil').value || null,
    endereco: document.getElementById('novoColabEndereco').value || null,
    cargo: document.getElementById('novoColabCargo').value || null,
    departamento: document.getElementById('novoColabDepartamento').value || null,
  };
  try {
    if (editandoId) {
      await api(`/estoque/colaboradores/${editandoId}`, { method: 'PATCH', body: corpo });
      toast('Colaborador atualizado.');
      state.estoque.colaboradorEditando = null;
    } else {
      await api('/estoque/colaboradores', { method: 'POST', body: corpo });
      toast('Colaborador cadastrado.');
    }
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// Escolher equipamentos pro termo (em vez de gerar direto com tudo que a
// pessoa tem em mãos — isso reincluiria equipamento já assinado em termo
// anterior toda vez). Pré-marca só o que ainda não tem `termo` (não foi
// coberto por nenhum termo antes); o resto vem desmarcado, mas selecionável
// se precisar reemitir por algum motivo.
async function abrirSelecaoTermo(colaboradorId) {
  try {
    const [colaboradores, itens] = await Promise.all([
      api('/estoque/colaboradores'),
      api(`/estoque/colaboradores/${colaboradorId}/equipamentos`),
    ]);
    const colaborador = colaboradores.find((c) => c.id === colaboradorId);
    state.estoque.termoSelecao = { colaboradorId, colaboradorNome: colaborador ? colaborador.nome : '', itens };
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function cancelarSelecaoTermo() {
  state.estoque.termoSelecao = null;
  render();
}

function viewSelecaoTermo() {
  const sel = state.estoque.termoSelecao;
  if (!sel) return '';
  return `
    <div class="card" style="margin-bottom:16px">
      <strong>Gerar termo — ${esc(sel.colaboradorNome)}</strong>
      <p class="section-desc" style="margin:6px 0 12px 0">Escolha quais equipamentos entram neste termo. Os já marcados com "já em termo" vêm desmarcados de propósito — só selecione de novo se precisar reemitir por algum motivo.</p>
      ${sel.itens.length ? `
        <div class="table-wrap scroll">
          <table>
            <thead><tr><th></th><th>Equipamento</th><th>Modelo</th><th>Nº de série</th><th>Qtd</th><th></th></tr></thead>
            <tbody>
              ${sel.itens.map((i, idx) => `
                <tr>
                  <td><input type="checkbox" class="selecaoTermoItem" data-idx="${idx}" ${i.termo ? '' : 'checked'} /></td>
                  <td>${esc(i.equipamento)}${i.emprestimo ? ' <span class="badge prioridade-normal">home office</span>' : ''}</td>
                  <td>${esc(i.modelo || '—')}</td>
                  <td>${esc(i.st || '—')}</td>
                  <td>${i.quantidade}</td>
                  <td>${i.termo ? '<span class="muted">já em termo</span>' : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="actions-row" style="margin-top:14px">
          <button class="btn small primary" onclick="confirmarSelecaoTermo()">Gerar termo com os selecionados</button>
          <button class="btn small ghost" onclick="cancelarSelecaoTermo()">Cancelar</button>
        </div>
      ` : `
        <p class="muted">Essa pessoa não tem nenhum equipamento em mãos agora.</p>
        <button class="btn small ghost" onclick="cancelarSelecaoTermo()">Fechar</button>
      `}
    </div>
  `;
}

async function confirmarSelecaoTermo() {
  const sel = state.estoque.termoSelecao;
  if (!sel) return;
  const marcados = [...document.querySelectorAll('.selecaoTermoItem:checked')].map((el) => sel.itens[Number(el.dataset.idx)]);
  if (!marcados.length) {
    toast('Selecione pelo menos um equipamento.', 'erro');
    return;
  }
  try {
    await api('/estoque/termos', { method: 'POST', body: { colaboradorId: sel.colaboradorId, itens: marcados } });
    toast('Termo gerado — veja em Termos, na lista de termos desse colaborador.');
    state.estoque.termoSelecao = null;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// Termo de Devolução de Equipamentos — escolhe quais equipamentos em
// aberto dessa pessoa entram na devolução agora (2026-10-01, pedido
// explícito — antes devolvia tudo de uma vez só, sem dar pra escolher;
// ex.: pessoa devolve o notebook mas fica com o monitor). O que não for
// marcado continua em aberto. Nem toda devolução é desligamento
// (2026-09-08) — o motivo escolhido aqui muda o texto do termo gerado e se
// o campo "Data de Desligamento" aparece nele (ver src/lib/termoPdf.js).
async function abrirSelecaoTermoDevolucao(colaboradorId) {
  try {
    const [colaboradores, itens] = await Promise.all([
      api('/estoque/colaboradores'),
      api(`/estoque/colaboradores/${colaboradorId}/equipamentos`),
    ]);
    if (!itens.length) {
      toast('Essa pessoa não tem nenhum equipamento em mãos agora.', 'erro');
      return;
    }
    const colaborador = colaboradores.find((c) => c.id === colaboradorId);
    state.estoque.termoDevolucaoSelecao = { colaboradorId, colaboradorNome: colaborador ? colaborador.nome : '', itens };
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function cancelarSelecaoTermoDevolucao() {
  state.estoque.termoDevolucaoSelecao = null;
  render();
}

function viewSelecaoTermoDevolucao() {
  const sel = state.estoque.termoDevolucaoSelecao;
  if (!sel) return '';
  return `
    <div class="card" style="margin-bottom:16px">
      <strong>Termo de devolução — ${esc(sel.colaboradorNome)}</strong>
      <p class="section-desc" style="margin:6px 0 12px 0">Escolha quais equipamentos estão sendo devolvidos agora — o que não for marcado continua em aberto com essa pessoa.</p>
      <div class="table-wrap scroll">
        <table>
          <thead><tr><th></th><th>Equipamento</th><th>Modelo</th><th>Nº de série</th><th>Qtd</th></tr></thead>
          <tbody>
            ${sel.itens.map((i, idx) => `
              <tr>
                <td><input type="checkbox" class="selecaoDevolucaoItem" data-idx="${idx}" checked /></td>
                <td>${esc(i.equipamento)}${i.emprestimo ? ' <span class="badge prioridade-normal">home office</span>' : ''}</td>
                <td>${esc(i.modelo || '—')}</td>
                <td>${esc(i.st || '—')}</td>
                <td>${i.quantidade}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="actions-row" style="margin-top:14px">
        <button class="btn small primary" onclick="confirmarSelecaoTermoDevolucao()">Gerar termo de devolução com os selecionados</button>
        <button class="btn small ghost" onclick="cancelarSelecaoTermoDevolucao()">Cancelar</button>
      </div>
    </div>
  `;
}

async function confirmarSelecaoTermoDevolucao() {
  const sel = state.estoque.termoDevolucaoSelecao;
  if (!sel) return;
  const marcados = [...document.querySelectorAll('.selecaoDevolucaoItem:checked')].map((el) => sel.itens[Number(el.dataset.idx)]);
  if (!marcados.length) {
    toast('Selecione pelo menos um equipamento.', 'erro');
    return;
  }
  const ehDesligamento = confirm('Essa devolução é por desligamento?\n\nOK = Sim (pede a data de desligamento)\nCancelar = Não (outro motivo — o termo sai sem mencionar desligamento)');
  let dataDesligamento = null;
  if (ehDesligamento) {
    dataDesligamento = prompt('Data de desligamento (DD/MM/AAAA):', new Date().toLocaleDateString('pt-BR'));
    if (dataDesligamento === null) return; // cancelou
  }
  try {
    await api('/estoque/termos/devolucao', {
      method: 'POST',
      body: { colaboradorId: sel.colaboradorId, itens: marcados, motivo: ehDesligamento ? 'desligamento' : 'outro', dataDesligamento },
    });
    toast('Termo de devolução gerado — equipamentos selecionados marcados como devolvidos.');
    state.estoque.termoDevolucaoSelecao = null;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function baixarEstoqueTermo(termoId) {
  window.open(`${API}/estoque/termos/${termoId}/arquivo`, '_blank');
}

// Enviar termo assinado (2026-10-05) — botão único na tela Termos, sem
// precisar escolher o colaborador antes: tenta reconhecer pelo NOME DO
// ARQUIVO (ex.: "Maria Souza - termo.pdf"). O conteúdo do PDF não dá pra ler
// (são escaneados, sem texto — ver importação em massa), então o
// reconhecimento é só pelo nome e SEMPRE pede confirmação antes de enviar.

const PALAVRAS_IGNORADAS_NOME_ARQUIVO = new Set([
  'termo', 'termos', 'responsabilidade', 'devolucao', 'assinado', 'assinada', 'equipamento', 'equipamentos',
  'scan', 'scanner', 'de', 'da', 'do', 'dos', 'das', 'e',
]);

function normalizarTextoBusca(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rotuloColaboradorUpload(c) {
  return `${c.nome}${c.usuario ? ` (${c.usuario})` : ''}${c.ativo === 0 ? ' — arquivo morto' : ''}`;
}

function reconhecerColaboradorPeloArquivo(nomeArquivo, colaboradores) {
  const base = nomeArquivo.replace(/\.[^.]+$/, '');
  const tokensArquivo = new Set(normalizarTextoBusca(base).split(' ').filter((t) => t && !PALAVRAS_IGNORADAS_NOME_ARQUIVO.has(t)));
  const candidatos = [];
  for (const c of colaboradores) {
    const tokensNome = normalizarTextoBusca(c.nome).split(' ').filter((t) => t.length > 2 && !PALAVRAS_IGNORADAS_NOME_ARQUIVO.has(t));
    const tokensUsuario = normalizarTextoBusca(c.usuario || '').split(' ').filter((t) => t.length > 1);
    const acertosNome = tokensNome.filter((t) => tokensArquivo.has(t)).length;
    const usuarioInteiro = tokensUsuario.length >= 2 && tokensUsuario.every((t) => tokensArquivo.has(t));
    let pontos = tokensNome.length ? acertosNome / tokensNome.length : 0;
    if (usuarioInteiro) pontos = Math.max(pontos, 1);
    const acertos = usuarioInteiro ? Math.max(acertosNome, tokensUsuario.length) : acertosNome;
    if (acertos >= 2 || (tokensNome.length === 1 && acertosNome === 1)) candidatos.push({ colaborador: c, pontos, acertos });
  }
  candidatos.sort((a, b) => b.pontos - a.pontos || b.acertos - a.acertos);
  return candidatos.slice(0, 5);
}

// Dois pontos de entrada pro mesmo seletor de arquivo: o botão geral (topo da
// aba Termos — reconhece o colaborador pelo nome do arquivo) e o botão dentro
// do cartão de um colaborador aberto (o colaborador já está escolhido).
let estoqueUploadColaboradorFixoId = null;

function enviarTermoAssinadoGeral() {
  estoqueUploadColaboradorFixoId = null;
  estoqueUploadSemVinculo = false;
  document.getElementById('estoqueTermoUploadInput').click();
}

// semVinculo: envio "solto" (2026-10-16) — guarda o termo na pessoa sem ligar a
// equipamento e sem mexer no estoque (ex.: pessoa sem equipamento registrado,
// ou termo antigo). O quadro de confirmação ainda deixa marcar equipamentos,
// se a pessoa mudar de ideia.
let estoqueUploadSemVinculo = false;

function enviarTermoAssinadoDaPessoa(colaboradorId, semVinculo) {
  estoqueUploadColaboradorFixoId = colaboradorId;
  estoqueUploadSemVinculo = !!semVinculo;
  document.getElementById('estoqueTermoUploadInput').click();
}

async function processarUploadEstoqueTermo(event) {
  const arquivo = event.target.files[0];
  event.target.value = ''; // permite escolher o mesmo arquivo de novo depois, se precisar
  const fixoId = estoqueUploadColaboradorFixoId;
  const semVinculo = estoqueUploadSemVinculo;
  estoqueUploadColaboradorFixoId = null;
  estoqueUploadSemVinculo = false;
  if (!arquivo) return;
  try {
    const [ativos, arquivados] = await Promise.all([api('/estoque/colaboradores'), api('/estoque/colaboradores?arquivados=1')]);
    const todos = [...ativos, ...arquivados].map((c) => ({ ...c, label: rotuloColaboradorUpload(c) }));
    const fixo = fixoId ? todos.find((c) => c.id === fixoId) : null;
    if (fixo) {
      state.estoque.uploadPendente = {
        file: arquivo,
        nome: arquivo.name,
        tipo: /devolu/i.test(arquivo.name) ? 'devolucao' : 'responsabilidade',
        todos,
        sugestoes: [],
        reconhecido: true,
        fixo: true,
        escolhaTexto: fixo.label,
        vincular: !semVinculo, equip: null, equipColabId: null, selecionados: [],
      };
      await carregarEquipamentosUpload();
      render().then(() => {
        const cartao = document.getElementById('uploadPendenteCard');
        if (cartao) cartao.scrollIntoView({ block: 'center' });
      });
      lerDocumentoDoUpload();
      return;
    }
    const candidatos = reconhecerColaboradorPeloArquivo(arquivo.name, todos);
    const melhor = candidatos[0];
    const reconhecido = !!melhor && melhor.pontos >= 0.6 && (candidatos.length === 1 || melhor.pontos > candidatos[1].pontos);
    state.estoque.uploadPendente = {
      file: arquivo,
      nome: arquivo.name,
      tipo: /devolu/i.test(arquivo.name) ? 'devolucao' : 'responsabilidade',
      todos,
      sugestoes: candidatos.map((c) => c.colaborador),
      reconhecido,
      escolhaTexto: reconhecido ? melhor.colaborador.label : '',
      vincular: true, equip: null, equipColabId: null, selecionados: [],
    };
    await carregarEquipamentosUpload();
    render().then(() => {
      const cartao = document.getElementById('uploadPendenteCard');
      if (cartao) cartao.scrollIntoView({ block: 'center' });
    });
    lerDocumentoDoUpload();
  } catch (e) { toast(e.message, 'erro'); }
}

function viewUploadTermoPendente() {
  const p = state.estoque.uploadPendente;
  if (!p) return '';
  const aviso = p.fixo && p.vincular === false
    ? '<p style="margin:8px 0">Termo para o colaborador que está aberto — vai só ser guardado nele, <strong>sem ligar a equipamento e sem mexer no estoque</strong>. Confira o tipo (responsabilidade ou devolução). Se quiser ligar a equipamentos, desmarque "Não vincular" abaixo.</p>'
    : p.fixo
    ? '<p style="margin:8px 0">Termo para o colaborador que está aberto — confira o tipo (responsabilidade ou devolução) antes de enviar.</p>'
    : p.reconhecido
    ? '<p style="margin:8px 0">Colaborador reconhecido pelo nome do arquivo — confira antes de enviar.</p>'
    : p.sugestoes.length
      ? `<p style="margin:8px 0">Não tenho certeza de quem é — possíveis colaboradores (clique pra escolher):</p>
         <div style="margin-bottom:8px">${p.sugestoes.map((c, idx) => `<button type="button" class="btn small ghost" style="margin:0 6px 6px 0" onclick="escolherSugestaoUploadTermo(${idx})">${esc(c.label)}</button>`).join('')}</div>`
      : '<p class="muted" style="margin:8px 0">Não consegui reconhecer o colaborador pelo nome do arquivo — escolha abaixo.</p>';
  return `
    <div class="card" id="uploadPendenteCard" style="margin-bottom:16px">
      <strong>Enviar termo assinado</strong>
      <p class="muted" style="margin:6px 0 0 0">Arquivo: ${esc(p.nome)}</p>
      ${aviso}
      ${statusLeituraUpload(p)}
      <div class="grid-2">
        <div class="field">
          <input id="uploadColaboradorInput" type="text" list="uploadColaboradoresLista" placeholder="Colaborador..." value="${esc(p.escolhaTexto)}" oninput="state.estoque.uploadPendente.escolhaTexto = this.value" onchange="aoMudarColaboradorUpload()" autocomplete="off" />
          <datalist id="uploadColaboradoresLista">${p.todos.map((t) => `<option value="${esc(t.label)}"></option>`).join('')}</datalist>
        </div>
        <div class="field">
          <select onchange="aoMudarTipoUpload(this.value)">
            <option value="responsabilidade" ${p.tipo === 'responsabilidade' ? 'selected' : ''}>Termo de responsabilidade</option>
            <option value="devolucao" ${p.tipo === 'devolucao' ? 'selected' : ''}>Termo de devolução</option>
          </select>
        </div>
      </div>
      ${blocoEquipamentosUpload(p)}
      ${blocoNovosLidosUpload(p)}
      <div class="actions-row">
        <button class="btn small primary" onclick="confirmarUploadEstoqueTermo()">Enviar</button>
        <button class="btn small ghost" onclick="state.estoque.uploadPendente = null; render();">Cancelar</button>
      </div>
    </div>
  `;
}

// Vínculo do termo enviado com os equipamentos da pessoa (2026-10-09): o
// arquivo sozinho não diz de quais equipamentos se trata, então a tela lista
// o que a pessoa tem em mãos e pergunta o que o papel cobre (responsabilidade
// → ganha ✓ de termo; devolução → dá baixa nos equipamentos marcados).
function colaboradorEscolhidoNoUpload(p) {
  const texto = normalizarTextoBusca(p.escolhaTexto);
  return p.todos.find((t) => normalizarTextoBusca(t.label) === texto) || null;
}

function padraoSelecaoUpload(p) {
  if (!p.equip) return [];
  return (p.tipo === 'devolucao' ? p.equip : p.equip.filter((i) => !i.termo)).map((i) => i.id);
}

async function carregarEquipamentosUpload() {
  const p = state.estoque.uploadPendente;
  if (!p) return;
  const alvo = colaboradorEscolhidoNoUpload(p);
  if (!alvo) { p.equip = null; p.equipColabId = null; p.selecionados = []; return; }
  if (p.equipColabId === alvo.id) return;
  try { p.equip = await api(`/estoque/colaboradores/${alvo.id}/equipamentos`); } catch (e) { p.equip = []; }
  p.equipColabId = alvo.id;
  p.selecionados = padraoSelecaoUpload(p);
}

async function aoMudarColaboradorUpload() {
  await carregarEquipamentosUpload();
  await cruzarLeituraComEquipamentos(state.estoque.uploadPendente);
  render();
}

function aoMudarTipoUpload(valor) {
  const p = state.estoque.uploadPendente;
  if (!p) return;
  p.tipo = valor;
  p.selecionados = padraoSelecaoUpload(p);
  if (p.encontrados && Object.keys(p.encontrados).length) p.selecionados = Object.keys(p.encontrados);
  for (const n of p.novos || []) n.registrar = valor === 'responsabilidade';
  render();
}

function alternarItemUpload(id, marcado) {
  const p = state.estoque.uploadPendente;
  if (!p) return;
  p.selecionados = p.selecionados.filter((x) => x !== id);
  if (marcado) p.selecionados.push(id);
}

function blocoEquipamentosUpload(p) {
  if (!p.equipColabId) {
    return '<p class="muted" style="margin:10px 0">Escolha o colaborador pra ver os equipamentos que esse termo pode cobrir.</p>';
  }
  if (!p.equip.length) {
    return `<p class="muted" style="margin:10px 0">Essa pessoa não tem equipamento em mãos registrado — ${p.novos && p.novos.length ? 'veja abaixo o que foi lido no documento.' : 'o termo será só arquivado, sem vincular a equipamento.'}</p>`;
  }
  const devolucao = p.tipo === 'devolucao';
  return `
    <div style="margin:12px 0 6px 0"><strong>${devolucao ? 'Quais equipamentos esse termo de devolução devolve?' : 'Quais equipamentos esse termo de responsabilidade cobre?'}</strong>
      <span class="muted"> ${devolucao ? 'Os marcados serão baixados de "Equipamentos em mãos".' : 'Os marcados ganham o ✓ de termo assinado.'}</span></div>
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th></th><th>Equipamento</th><th>Modelo</th><th>ST</th><th>Termo</th><th>No documento</th></tr></thead>
        <tbody>
          ${p.equip.map((i) => `
            <tr>
              <td><input type="checkbox" ${p.selecionados.includes(i.id) ? 'checked' : ''} ${p.vincular === false ? 'disabled' : ''} onchange="alternarItemUpload('${i.id}', this.checked)" /></td>
              <td>${esc(i.equipamento)}${i.emprestimo ? ' <span class="badge prioridade-normal">home office</span>' : ''}</td>
              <td>${esc(i.modelo || '—')}</td><td>${esc(i.st || '—')}</td><td>${i.termo ? '✓' : '—'}</td>
              <td>${p.encontrados && p.encontrados[i.id] ? `<span class="badge sla-cumprido" title="${esc(p.encontrados[i.id])}">lido</span>` : '<span class="muted">—</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <label class="muted" style="display:block; margin:8px 0 4px 0"><input type="checkbox" style="width:auto" ${p.vincular === false ? 'checked' : ''} onchange="state.estoque.uploadPendente.vincular = !this.checked; render();" /> Não vincular a nenhum equipamento (só arquivar o termo — ex.: termo antigo)</label>
  `;
}

// --- Leitura automática do documento (OCR no servidor, Tesseract) ------------
// Só SUGERE: tipo, colaborador e equipamentos lidos na tabela do termo. Nada é
// gravado até a pessoa confirmar no quadro; as linhas lidas são editáveis
// porque OCR erra letra (nº de série principalmente).

async function lerDocumentoDoUpload() {
  const p = state.estoque.uploadPendente;
  if (!p) return;
  p.lendo = true;
  render();
  try {
    const dados = new FormData();
    dados.set('arquivo', p.file);
    const alvo = colaboradorEscolhidoNoUpload(p);
    if (alvo) dados.set('colaboradorId', alvo.id);
    const resp = await fetch(`${API}/estoque/termos/ler`, { method: 'POST', body: dados, credentials: 'same-origin' });
    const leitura = await resp.json().catch(() => null);
    if (state.estoque.uploadPendente !== p) return; // cancelou ou trocou de arquivo enquanto lia
    if (!resp.ok) throw new Error((leitura && leitura.erro) || `Erro ${resp.status}`);
    p.leitura = leitura;
  } catch (e) {
    if (state.estoque.uploadPendente !== p) return;
    p.leitura = { disponivel: false, motivo: e.message };
  }
  p.lendo = false;
  if (p.leitura.disponivel) await aplicarLeituraNoUpload(p);
  render();
}

async function aplicarLeituraNoUpload(p) {
  const l = p.leitura;
  if (l.tipoSugerido) { p.tipo = l.tipoSugerido; p.tipoPelaLeitura = true; }

  const alvoAntes = colaboradorEscolhidoNoUpload(p);
  const melhor = (l.colaboradoresSugeridos || [])[0];
  const segundo = (l.colaboradoresSugeridos || [])[1];
  const claro = melhor && melhor.pontos >= 0.9 && (!segundo || segundo.pontos < melhor.pontos);
  if (!alvoAntes && claro) {
    const achado = p.todos.find((t) => t.id === melhor.id);
    if (achado) { p.escolhaTexto = achado.label; p.reconhecido = true; p.lidoPorLeitura = true; }
  } else if (alvoAntes && claro && melhor.id !== alvoAntes.id) {
    p.divergencia = `O documento parece ser de ${melhor.nome}, mas o colaborador escolhido é ${alvoAntes.nome}. Confira antes de enviar.`;
  }
  await carregarEquipamentosUpload();
  await cruzarLeituraComEquipamentos(p);
}

async function cruzarLeituraComEquipamentos(p) {
  if (!p || !p.leitura || !p.leitura.disponivel) return;
  const alvo = colaboradorEscolhidoNoUpload(p);
  p.encontrados = {};
  p.novos = [];
  if (!alvo) return;
  try {
    const r = await api(`/estoque/termos/ler/${p.leitura.leituraId}/correspondencias?colaboradorId=${alvo.id}`);
    for (const e of r.encontrados) p.encontrados[e.itemId] = e.motivo;
    p.novos = r.novos.map((n) => ({ ...n, registrar: p.tipo === 'responsabilidade' }));
  } catch (e) { /* leitura expirou: segue sem cruzamento */ }
  const ids = Object.keys(p.encontrados);
  if (ids.length) p.selecionados = ids;
}

function editarNovoLidoUpload(idx, campo, valor) {
  const p = state.estoque.uploadPendente;
  if (p && p.novos && p.novos[idx]) p.novos[idx][campo] = valor;
}

function statusLeituraUpload(p) {
  if (p.lendo) return '<p class="muted" style="margin:8px 0">Lendo o documento (OCR)… pode levar até 30 segundos.</p>';
  const l = p.leitura;
  if (!l) return '';
  if (!l.disponivel) return `<p class="muted" style="margin:8px 0">Leitura automática indisponível — ${esc(l.motivo || 'motivo desconhecido')} Você ainda pode escolher tudo à mão abaixo.</p>`;
  const partes = [];
  if (l.tipoSugerido) partes.push(`tipo: <strong>${l.tipoSugerido === 'devolucao' ? 'termo de devolução' : 'termo de responsabilidade'}</strong>`);
  if (l.nomeLido) partes.push(`nome no documento: <strong>${esc(l.nomeLido)}</strong>`);
  partes.push(`${l.itensLidos.length} equipamento(s) lido(s) na tabela`);
  return `<p style="margin:8px 0; color: var(--good)">Leitura automática: ${partes.join(' · ')}. <span class="muted">Confira — OCR pode errar letras.</span></p>${p.divergencia ? `<p style="margin:4px 0; color: var(--critical)"><strong>${esc(p.divergencia)}</strong></p>` : ''}`;
}

function blocoNovosLidosUpload(p) {
  if (!p.novos || !p.novos.length || p.tipo !== 'responsabilidade' || p.vincular === false) return '';
  return `
    <div style="margin:14px 0 6px 0"><strong>Equipamentos lidos no documento que ainda não estão em mãos dessa pessoa</strong>
      <span class="muted"> Os marcados são registrados nela (sem mexer no saldo do estoque) já com o termo. Corrija o que o OCR leu errado.</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Registrar</th><th>Equipamento</th><th>Modelo</th><th>Nº de série</th><th>Qtd</th></tr></thead>
        <tbody>
          ${p.novos.map((n, idx) => `
            <tr>
              <td><input type="checkbox" style="width:auto" ${n.registrar ? 'checked' : ''} onchange="editarNovoLidoUpload(${idx}, 'registrar', this.checked)" /></td>
              <td><input type="text" value="${esc(n.equipamento)}" oninput="editarNovoLidoUpload(${idx}, 'equipamento', this.value)" /></td>
              <td><input type="text" value="${esc(n.modelo || '')}" oninput="editarNovoLidoUpload(${idx}, 'modelo', this.value)" /></td>
              <td><input type="text" value="${esc(n.st || '')}" oninput="editarNovoLidoUpload(${idx}, 'st', this.value)" /></td>
              <td><input type="number" min="1" style="width:70px" value="${n.quantidade || 1}" oninput="editarNovoLidoUpload(${idx}, 'quantidade', this.value)" /></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function escolherSugestaoUploadTermo(idx) {
  const p = state.estoque.uploadPendente;
  if (!p || !p.sugestoes[idx]) return;
  p.escolhaTexto = p.sugestoes[idx].label;
  carregarEquipamentosUpload().then(() => render());
}

async function confirmarUploadEstoqueTermo() {
  const p = state.estoque.uploadPendente;
  if (!p) return;
  const alvo = colaboradorEscolhidoNoUpload(p);
  if (!alvo) {
    toast('Escolha um colaborador da lista.', 'erro');
    return;
  }
  // Colaborador trocado e a lista de equipamentos dele ainda não foi mostrada
  // (ex.: clicou direto em Enviar depois de digitar o nome) — carrega, mostra
  // e pede pra conferir antes de enviar, em vez de vincular sem ninguém ver.
  if (p.equipColabId !== alvo.id) {
    await carregarEquipamentosUpload();
    render();
    if (p.equip && p.equip.length) toast('Confira os equipamentos desse colaborador e clique em Enviar de novo.');
    if (p.equip && p.equip.length) return;
  }
  const vincular = p.vincular !== false && p.selecionados.length > 0;
  if (vincular && p.tipo === 'devolucao') {
    if (!confirm(`Esse termo de devolução dá baixa em ${p.selecionados.length} equipamento(s) de ${alvo.nome} (saem de "Equipamentos em mãos" e voltam pro estoque). Confirma?`)) return;
  }
  const dados = new FormData();
  dados.set('colaboradorId', alvo.id);
  dados.set('tipo', p.tipo);
  dados.set('arquivo', p.file);
  if (vincular) dados.set('itensIds', JSON.stringify(p.selecionados));
  const novos = (p.tipo === 'responsabilidade' && p.vincular !== false ? (p.novos || []) : []).filter((n) => n.registrar && String(n.equipamento || '').trim());
  if (novos.length) dados.set('itensNovos', JSON.stringify(novos.map((n) => ({ equipamento: n.equipamento, modelo: n.modelo, st: n.st, quantidade: n.quantidade }))));
  try {
    const resp = await fetch(`${API}/estoque/termos/upload`, { method: 'POST', body: dados, credentials: 'same-origin' });
    const corpo = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((corpo && corpo.erro) || `Erro ${resp.status}`);
    const n = corpo && corpo.vinculados ? corpo.vinculados : 0;
    const reg = corpo && corpo.registrados ? corpo.registrados : 0;
    const partes = [];
    if (n) partes.push(`${n} equipamento(s) ${p.tipo === 'devolucao' ? 'baixado(s)' : 'marcado(s) com termo'}`);
    if (reg) partes.push(`${reg} equipamento(s) lido(s) registrado(s) na pessoa`);
    toast(partes.length ? `Termo assinado enviado pra ${alvo.nome} — ${partes.join(', ')}.` : `Termo assinado enviado pra ${alvo.nome}.`);
    state.estoque.uploadPendente = null;
    if (alvo.ativo !== 0) state.estoque.termosColabId = alvo.id;
    render();
  } catch (e) {
    toast(e.message, 'erro');
  }
}

// Equipamentos móveis (2026-10-05) — junta as antigas abas Consultores e
// Corporativos: primeiro os colaboradores (consultores externos), depois os
// equipamentos (linhas/celulares/tablets corporativos).
async function viewEstoqueMoveis() {
  const [consultores, corporativos] = await Promise.all([api('/estoque/consultores'), api('/estoque/corporativos')]);

  const colunasColab = [
    { key: 'usuario', label: 'Nome' },
    { key: 'departamento', label: 'Departamento' },
    { key: 'numero_celular', label: 'Celular' },
    { key: 'numero_tablet', label: 'Tablet' },
    { key: 'gmail', label: 'Gmail' },
    { key: 'imei', label: 'IMEI' },
    { key: 'iccid', label: 'ICCID' },
  ];
  const linhasColab = aplicarFiltrosColuna(consultores, 'estoque', 'consultores', colunasColab);

  const colunasEquip = [
    { key: 'item', label: 'Item' },
    { key: 'departamento', label: 'Departamento' },
    { key: 'numero', label: 'Número' },
    { key: 'st', label: 'ST' },
    { key: 'gmail', label: 'Gmail' },
    { key: 'imei', label: 'IMEI' },
  ];
  const linhasEquip = aplicarFiltrosColuna(corporativos, 'estoque', 'corporativos', colunasEquip);

  return `
    <div class="section-title" style="font-size:16px">Colaboradores</div>
    <p class="section-desc" style="margin-top:-6px">Consultores externos com celular/tablet corporativo emprestado.</p>
    <div class="card" style="margin-bottom:16px">
      <form class="grid-2" onsubmit="criarEstoqueConsultor(event); return false;">
        <div class="field"><input id="novoConsultorUsuario" type="text" placeholder="Nome" required /></div>
        <div class="field"><input id="novoConsultorDepartamento" type="text" placeholder="Departamento" /></div>
        <div class="field"><input id="novoConsultorCelular" type="text" placeholder="Nº celular" /></div>
        <div class="field"><input id="novoConsultorTablet" type="text" placeholder="Nº tablet" /></div>
        <div class="field"><input id="novoConsultorGmail" type="email" placeholder="Gmail" /></div>
        <div class="field"><input id="novoConsultorImei" type="text" placeholder="IMEI" /></div>
        <div class="field"><input id="novoConsultorIccid" type="text" placeholder="ICCID" /></div>
        <div class="full"><button class="btn small primary" type="submit">Adicionar colaborador</button></div>
      </form>
    </div>
    <div class="table-wrap scroll" style="margin-bottom:28px">
      <table>
        <thead>
          <tr><th>Nome</th><th>Departamento</th><th>Celular</th><th>Tablet</th><th>Gmail</th><th>IMEI</th><th>ICCID</th><th></th></tr>
          ${linhaFiltroColunas('estoque', 'consultores', colunasColab, true)}
        </thead>
        <tbody>
          ${linhasColab.length ? linhasColab.map(c => `
            <tr>
              <td>${esc(c.usuario || '—')}</td><td>${esc(c.departamento || '—')}</td>
              <td>${esc(c.numero_celular || '—')}</td><td>${esc(c.numero_tablet || '—')}</td>
              <td>${esc(c.gmail || '—')}</td><td>${esc(c.imei || '—')}</td><td>${esc(c.iccid || '—')}</td>
              <td class="actions"><button class="btn small ghost" onclick="excluirEstoque('consultores','${c.id}','Registro removido.')">Excluir</button></td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="8">Nenhum colaborador encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title" style="font-size:16px">Equipamentos</div>
    <p class="section-desc" style="margin-top:-6px">Celulares, tablets e linhas corporativas.</p>
    <div class="card" style="margin-bottom:16px">
      <form class="grid-2" onsubmit="criarEstoqueCorporativo(event); return false;">
        <div class="field"><input id="novoCorpItem" type="text" placeholder="Item (ex: Celular Corporativo Logística)" required /></div>
        <div class="field"><input id="novoCorpDepartamento" type="text" placeholder="Departamento" /></div>
        <div class="field"><input id="novoCorpNumero" type="text" placeholder="Número" /></div>
        <div class="field"><input id="novoCorpSt" type="text" placeholder="Service tag" /></div>
        <div class="field"><input id="novoCorpGmail" type="email" placeholder="Gmail" /></div>
        <div class="field"><input id="novoCorpImei" type="text" placeholder="IMEI" /></div>
        <div class="full"><button class="btn small primary" type="submit">Adicionar equipamento</button></div>
      </form>
    </div>
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Item</th><th>Departamento</th><th>Número</th><th>ST</th><th>Gmail</th><th>IMEI</th><th></th></tr>
          ${linhaFiltroColunas('estoque', 'corporativos', colunasEquip, true)}
        </thead>
        <tbody>
          ${linhasEquip.length ? linhasEquip.map(c => `
            <tr>
              <td>${esc(c.item)}</td><td>${esc(c.departamento || '—')}</td><td>${esc(c.numero || '—')}</td>
              <td>${esc(c.st || '—')}</td><td>${esc(c.gmail || '—')}</td><td>${esc(c.imei || '—')}</td>
              <td class="actions"><button class="btn small ghost" onclick="excluirEstoque('corporativos','${c.id}','Registro removido.')">Excluir</button></td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="7">Nenhum equipamento encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function excluirEstoque(tabela, id, mensagem) {
  try {
    await api(`/estoque/${tabela}/${id}`, { method: 'DELETE' });
    toast(mensagem || 'Removido.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function patchEstoqueItem(id, corpo) {
  try {
    await api(`/estoque/itens/${id}`, { method: 'PATCH', body: corpo });
    toast('Item atualizado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarEstoqueUsado(event) {
  try {
    await api('/estoque/usados', {
      method: 'POST',
      body: {
        item: document.getElementById('novoUsadoItem').value,
        quantidade: Number(document.getElementById('novoUsadoQuantidade').value) || 0,
        estado: document.getElementById('novoUsadoEstado').value || null,
        detalhes: document.getElementById('novoUsadoDetalhes').value || null,
      },
    });
    toast('Registro adicionado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// Cria ou edita uma movimentação — mesmo formulário, muda só o método/rota
// (2026-09-08, ver state.estoque.movimentacaoEditando em viewEstoqueMovimentacoes).
function abrirFichaDoTermoRecente() {
  const r = state.estoque.termoRecemGerado;
  if (!r) return;
  state.estoque.subview = 'termos';
  selecionarColaboradorTermos(r.colaboradorId);
  state.estoque.equipAbertos = [r.movId];
  state.estoque.termoRecemGerado = null;
}

async function salvarEstoqueMovimentacao(event) {
  const editandoId = state.estoque.movimentacaoEditando;
  const tipo = document.getElementById('novaMovTipo').value;
  const ehEntrega = tipo === 'ENTREGA';
  const pedePessoa = ehEntrega || tipo === 'EMPRESTIMO';
  const corpo = {
    data: document.getElementById('novaMovData').value,
    tipo,
    equipamento: document.getElementById('novaMovEquipamento').value,
    quantidade: Number(document.getElementById('novaMovQuantidade').value) || 0,
    descricao: document.getElementById('novaMovDescricao').value || null,
    usuario: pedePessoa ? (document.getElementById('novaMovUsuario').value || null) : null,
    host: pedePessoa ? (document.getElementById('novaMovHost').value || null) : null,
    departamento: pedePessoa ? (document.getElementById('novaMovDepartamento').value || null) : null,
    modelo: pedePessoa ? (document.getElementById('novaMovModelo').value || null) : null,
    st: pedePessoa ? (document.getElementById('novaMovSt').value || null) : null,
  };
  const marcaJaAssinado = document.getElementById('novaMovTermoJaAssinado');
  if (ehEntrega && marcaJaAssinado && marcaJaAssinado.checked) corpo.termoJaAssinado = true;
  try {
    if (editandoId) {
      await api(`/estoque/movimentacoes/${editandoId}`, { method: 'PATCH', body: corpo });
      toast('Movimentação atualizada.');
      state.estoque.movimentacaoEditando = null;
    } else {
      const resp = await api('/estoque/movimentacoes', { method: 'POST', body: corpo });
      if (resp.termoId) {
        state.estoque.termoRecemGerado = { termoId: resp.termoId, colaboradorId: resp.colaboradorId, movId: resp.id, equipamento: resp.equipamento, usuario: resp.usuario };
        toast('Movimentação registrada. Termo gerado — baixe no quadro acima do formulário.');
      } else {
        toast('Movimentação registrada.');
      }
      if (resp.avisoTermo) toast(resp.avisoTermo, 'erro');
    }
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarEstoqueConsultor(event) {
  try {
    await api('/estoque/consultores', {
      method: 'POST',
      body: {
        usuario: document.getElementById('novoConsultorUsuario').value,
        departamento: document.getElementById('novoConsultorDepartamento').value || null,
        numeroCelular: document.getElementById('novoConsultorCelular').value || null,
        numeroTablet: document.getElementById('novoConsultorTablet').value || null,
        gmail: document.getElementById('novoConsultorGmail').value || null,
        imei: document.getElementById('novoConsultorImei').value || null,
        iccid: document.getElementById('novoConsultorIccid').value || null,
      },
    });
    toast('Consultor adicionado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function criarEstoqueCorporativo(event) {
  try {
    await api('/estoque/corporativos', {
      method: 'POST',
      body: {
        item: document.getElementById('novoCorpItem').value,
        departamento: document.getElementById('novoCorpDepartamento').value || null,
        numero: document.getElementById('novoCorpNumero').value || null,
        st: document.getElementById('novoCorpSt').value || null,
        gmail: document.getElementById('novoCorpGmail').value || null,
        imei: document.getElementById('novoCorpImei').value || null,
      },
    });
    toast('Registro adicionado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- View: Checklist do CPD ------------------------------------------------
// Inspeção física diária do CPD (meta: todo dia útil, ver src/routes/cpd.js).
// Guarda histórico de cada rodada — diferente do Estoque, aqui cada envio
// vira um registro novo, não um "estado atual" que se sobrescreve.

const CPD_ABAS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'novo', label: 'Novo checklist' },
  { key: 'historico', label: 'Histórico' },
];
// Cadastro de servidores/receptoras (2026-09-23) — só líder/gestor, mesmo
// papel que já corrige registro de checklist.
const CPD_ABA_CADASTRO = { key: 'cadastro', label: 'Servidores/Receptoras' };

function badgeSimNao(valor) {
  return valor ? `<span class="badge sla-cumprido">Sim</span>` : `<span class="badge sla-violado">Não</span>`;
}

async function viewCpd() {
  const aba = state.cpd.subview;
  if (aba === 'detalhe') return viewCpdDetalhe(state.cpd.detalheId);

  const podeGerenciarCatalogo = ['lider', 'gestor'].includes(state.eu.papel) || state.eu.adminTotal;
  const conteudo = aba === 'dashboard' ? await viewCpdDashboard()
    : aba === 'novo' ? await viewCpdNovo()
    : aba === 'cadastro' && podeGerenciarCatalogo ? await viewCpdCadastro()
    : await viewCpdHistorico();
  const abas = podeGerenciarCatalogo ? [...CPD_ABAS, CPD_ABA_CADASTRO] : CPD_ABAS;
  return `
    <div class="section-title">Checklist do CPD</div>
    <p class="section-desc">Inspeção física diária do CPD — servidores, receptoras e ar-condicionado, com foto. Meta: todo dia útil.</p>
    <div class="toolbar">
      ${abas.map(a => `
        <button class="btn small ${aba === a.key ? 'primary' : ''}" onclick="state.cpd.subview='${a.key}'; render();">${esc(a.label)}</button>
      `).join('')}
    </div>
    ${conteudo}
  `;
}

// --- View: Cadastro de servidores/receptoras (líder/gestor) --------------
async function viewCpdCadastro() {
  const [servidores, receptoras] = await Promise.all([
    api('/cpd/servidores/todos'),
    api('/cpd/receptoras/todos'),
  ]);
  const listaCatalogo = (itens, tipo, comIdrac = false) => `
    <div class="table-wrap" style="margin-top:10px">
      <table>
        <thead><tr><th>Nome</th>${comIdrac ? '<th>IP da iDRAC</th><th>Host SSH (sem iDRAC)</th>' : ''}<th>Status</th><th></th></tr></thead>
        <tbody>
          ${itens.length ? itens.map(i => `
            <tr>
              <td>${esc(i.nome)}</td>
              ${comIdrac ? `<td><input type="text" value="${esc(i.idrac_host)}" placeholder="ex: 192.168.10.50" style="width:100%" onchange="salvarIdracHostCpd(${i.id}, this.value)" /></td>
              <td><input type="text" value="${esc(i.dcu_host)}" placeholder="ex: 192.168.62.152" style="width:100%" onchange="salvarDcuHostCpd(${i.id}, this.value)" /></td>` : ''}
              <td>${i.ativo ? '<span class="badge sla-cumprido">Ativo</span>' : '<span class="badge sla-pendente">Inativo</span>'}</td>
              <td>${comIdrac ? linkIdrac(i.idrac_host) : ''} <button class="btn small ghost" onclick="alternarAtivoCpdCatalogo('${tipo}', ${i.id}, ${i.ativo ? 'false' : 'true'})">${i.ativo ? 'Desativar' : 'Reativar'}</button></td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="${comIdrac ? 5 : 3}">Nenhum item cadastrado ainda.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  return `
    <p class="section-desc" style="margin-top:-8px">Desativar em vez de excluir — item desativado some do formulário de novo checklist, mas continua aparecendo certinho em registros antigos que já o referenciam.</p>
    <div class="detalhe-grid">
      <div class="card">
        <strong>Servidores</strong>
        <form class="actions-row" style="margin-top:10px" onsubmit="criarCpdCatalogo(event, 'servidores'); return false;">
          <input id="novoCpdServidorNome" type="text" placeholder="Nome do servidor" required style="flex:1" />
          <button class="btn small primary" type="submit">Adicionar</button>
        </form>
        ${listaCatalogo(servidores, 'servidores', true)}
      </div>
      <div class="card">
        <strong>Receptoras</strong>
        <form class="actions-row" style="margin-top:10px" onsubmit="criarCpdCatalogo(event, 'receptoras'); return false;">
          <input id="novoCpdReceptoraNome" type="text" placeholder="Nome da receptora" required style="flex:1" />
          <button class="btn small primary" type="submit">Adicionar</button>
        </form>
        ${listaCatalogo(receptoras, 'receptoras')}
      </div>
    </div>
  `;
}

async function criarCpdCatalogo(event, tipo) {
  const inputId = tipo === 'servidores' ? 'novoCpdServidorNome' : 'novoCpdReceptoraNome';
  const input = document.getElementById(inputId);
  try {
    await api(`/cpd/${tipo}`, { method: 'POST', body: { nome: input.value } });
    input.value = '';
    toast('Cadastrado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function alternarAtivoCpdCatalogo(tipo, id, ativo) {
  try {
    await api(`/cpd/${tipo}/${id}`, { method: 'PATCH', body: { ativo } });
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarIdracHostCpd(id, idracHost) {
  try {
    await api(`/cpd/servidores/${id}`, { method: 'PATCH', body: { idracHost } });
    toast('IP da iDRAC salvo.');
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarDcuHostCpd(id, dcuHost) {
  try {
    await api(`/cpd/servidores/${id}`, { method: 'PATCH', body: { dcuHost } });
    toast('Host de SSH salvo.');
  } catch (e) { toast(e.message, 'erro'); }
}

function abrirCpdDetalhe(id) {
  state.cpd.subview = 'detalhe';
  state.cpd.detalheId = id;
  render();
}

const CPD_SAUDE_INFO = {
  ok: { label: 'Saudável', cor: 'good' },
  atencao: { label: 'Atenção', cor: 'warning' },
  critico: { label: 'Crítico', cor: 'critical' },
};

async function viewCpdDashboard() {
  const mes = state.cpd.mesResumo || new Date().toISOString().slice(0, 7);
  const [r, tendencia] = await Promise.all([
    api(`/cpd/resumo?mes=${mes}`),
    api('/cpd/tendencia?meses=6'),
  ]);
  const saude = CPD_SAUDE_INFO[r.saude];
  const totalAlertas = r.naoServidoresMes + r.naoReceptorasMes + r.naoArCondicionadoMes;

  const cards = [
    { rotulo: 'Saúde do CPD', valorHtml: `<span style="color:var(--${saude.cor})">${esc(saude.label)}</span>` },
    { rotulo: 'Meta cumprida (dias úteis)', valorHtml: `${r.diasComChecklist}/${r.diasUteisAteHoje} (${r.percentual}%)`, critico: r.percentual < 80 },
    { rotulo: 'Checklists no mês', valorHtml: String(r.totalChecklistsMes) },
    { rotulo: 'Alertas "Não" no mês', valorHtml: String(totalAlertas), critico: totalAlertas > 0 },
  ];

  return `
    <div class="field" style="max-width:200px; margin-bottom:14px">
      <label>Mês</label>
      <input type="month" value="${esc(mes)}" max="${esc(new Date().toISOString().slice(0, 7))}" onchange="state.cpd.mesResumo = this.value; render();" />
    </div>
    <div class="stat-cards">
      ${cards.map(c => `
        <div class="stat-card">
          <div class="rotulo">${esc(c.rotulo)}</div>
          <div class="valor ${c.critico ? 'critical' : ''}">${c.valorHtml}</div>
        </div>
      `).join('')}
    </div>

    <div class="card" style="margin-bottom:16px">
      <strong>Tendência (últimos ${tendencia.length} meses)</strong>
      <div style="display:flex; align-items:flex-end; gap:14px; height:140px; margin-top:16px; padding:0 4px;">
        ${tendencia.map(t => {
          const info = CPD_SAUDE_INFO[t.saude];
          const alturaPx = Math.max(Math.round((t.percentual / 100) * 100), 3);
          return `
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%;">
              <div class="muted" style="font-size:12px; margin-bottom:4px;">${t.percentual}%</div>
              <div style="width:100%; max-width:36px; height:${alturaPx}px; background:var(--${info.cor}); border-radius:4px 4px 0 0;" title="${esc(t.mes)} — ${esc(info.label)}, ${t.totalAlertas} alerta(s)"></div>
              <div class="muted" style="font-size:12px; margin-top:6px; white-space:nowrap;">${esc(t.mes.slice(5))}/${esc(t.mes.slice(2, 4))}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    ${r.diasFaltantes.length ? `
      <div class="card" style="margin-bottom:16px; border-color:var(--critical); background:var(--critical-bg);">
        <strong style="color:var(--critical)">Dias úteis sem checklist no mês (${r.diasFaltantes.length})</strong>
        <p style="margin-top:8px">${r.diasFaltantes.map(d => esc(d)).join(', ')}</p>
      </div>
    ` : ''}
    ${(r.diasParciais || []).length ? `
      <div class="card" style="margin-bottom:16px; border-color:var(--warning); background:var(--warning-bg);">
        <strong style="color:var(--warning)">Dias com só 1 dos 2 turnos no mês (${r.diasParciais.length})</strong>
        <p style="margin-top:8px">${r.diasParciais.map(d => esc(d)).join(', ')}</p>
      </div>
    ` : ''}
    ${!r.diasFaltantes.length && !(r.diasParciais || []).length ? `
      <div class="card" style="margin-bottom:16px; border-color:var(--good); background:var(--good-bg);">
        <strong style="color:var(--good)">Nenhum dia útil pulado no mês.</strong>
      </div>
    ` : ''}

    <div class="card">
      <strong>Comentários mais recentes</strong>
      <p class="muted" style="margin-top:6px">O sinal de verdade sobre a saúde do CPD costuma estar aqui, não só no Sim/Não.</p>
      <div style="margin-top:10px">
        ${r.comentarios.length ? r.comentarios.map(c => `
          <div class="historico-item">
            <div class="quando">${esc(c.data)} • ${esc(c.categoria)} • ${esc(c.atendente)} ${badgeSimNao(c.verificado)}</div>
            <div>${esc(c.texto)}</div>
          </div>
        `).join('') : '<p class="muted">Nenhum comentário registrado ainda.</p>'}
      </div>
    </div>
  `;
}

// Lista de checkbox+comentário reaproveitada por servidores e receptoras
// (2026-09-23) — marcar o item revela o textarea dele na hora (puro CSS/DOM,
// sem re-render, pra não perder o que já foi digitado no resto do
// formulário). Comentário vazio = "revisei, tudo normal"; só comentário
// preenchido conta como alerta na saúde do mês (ver calcularMetricasMes).
function listaChecklistItens(itens, prefixoId) {
  return itens.map(i => `
    <div style="margin-bottom:8px;">
      <label><input type="checkbox" class="${prefixoId}Checkbox" value="${i.id}" style="width:auto" onchange="document.getElementById('${prefixoId}Comentario${i.id}').style.display = this.checked ? 'block' : 'none'; if (!this.checked) document.getElementById('${prefixoId}Comentario${i.id}').value='';" /> ${esc(i.nome)}</label>
      <textarea id="${prefixoId}Comentario${i.id}" placeholder="Alguma observação sobre ${esc(i.nome)}? (opcional — deixar em branco = revisado, tudo normal)" style="display:none; margin-top:4px;"></textarea>
    </div>
  `).join('');
}

async function viewCpdNovo() {
  const [servidores, receptoras, statusHoje] = await Promise.all([
    api('/cpd/servidores'),
    api('/cpd/receptoras'),
    api('/cpd/checklist/hoje'),
  ]);
  const cardTurno = (label, feito) => `
    <div class="card" style="flex:1; background:${feito ? 'var(--good-bg)' : 'var(--warning-bg)'}; border-color:${feito ? 'var(--good)' : 'var(--warning)'};">
      <strong style="color:${feito ? 'var(--good)' : 'var(--warning)'}">${label}: ${feito ? 'feito' : 'pendente'}</strong>
    </div>
  `;
  return `
    <p class="muted" style="margin:-8px 0 12px 0">Checklist de hoje (${esc(statusHoje.data)}) — meta: um registro de manhã e outro à noite.</p>
    <div class="actions-row" style="margin-bottom:16px; align-items:stretch;">
      ${cardTurno('Manhã', statusHoje.manha.feito)}
      ${cardTurno('Noite', statusHoje.noite.feito)}
    </div>

    <div class="card" style="max-width:760px">
      <form onsubmit="criarCpdChecklist(event); return false;">
        <div class="field" style="margin-bottom:16px; max-width:220px;">
          <label>Data do registro</label>
          <input id="cpdData" type="date" value="${esc(statusHoje.data)}" required />
        </div>

        <div class="field" style="margin-bottom:16px;">
          <label>Servidores — marque os revisados; se notar algo, escreva no comentário</label>
          <div style="margin-top:8px;">
            ${servidores.length ? listaChecklistItens(servidores, 'cpdServidor') : '<p class="muted">Nenhum servidor cadastrado ainda (aba Servidores/Receptoras).</p>'}
          </div>
        </div>

        <div class="field" style="margin-bottom:16px;">
          <label>Receptoras — marque as revisadas; se notar algo, escreva no comentário</label>
          <div style="margin-top:8px;">
            ${receptoras.length ? listaChecklistItens(receptoras, 'cpdReceptora') : '<p class="muted">Nenhuma receptora cadastrada ainda (aba Servidores/Receptoras).</p>'}
          </div>
        </div>

        <div class="field" style="margin-bottom:8px;">
          <label>Encontrou algum problema no funcionamento dos dois equipamentos de ar-condicionado ou na temperatura (fora de 18°–23°)?</label>
          <div class="actions-row" style="margin-top:6px">
            <label><input type="radio" name="cpdArCondicionadoProblema" value="true" required style="width:auto" onchange="document.getElementById('cpdArComentarioWrap').style.display='block'" /> Sim</label>
            <label><input type="radio" name="cpdArCondicionadoProblema" value="false" style="width:auto" onchange="document.getElementById('cpdArComentarioWrap').style.display='none'; document.getElementById('cpdArCondicionadoComentario').value='';" /> Não</label>
          </div>
        </div>
        <div id="cpdArComentarioWrap" class="field" style="margin-bottom:16px; display:none;">
          <label>Descreva o problema encontrado</label>
          <textarea id="cpdArCondicionadoComentario"></textarea>
        </div>

        <div class="field" style="margin-bottom:16px; max-width:360px;">
          <label>Foto no CPD</label>
          <input id="cpdFoto" type="file" accept="image/*" required />
        </div>

        <div class="actions-row">
          <button type="submit" class="btn primary">Registrar checklist</button>
        </div>
      </form>
    </div>
  `;
}

function coletarItensChecklist(form, prefixoId) {
  return [...form.querySelectorAll(`.${prefixoId}Checkbox:checked`)].map((el) => ({
    id: Number(el.value),
    comentario: document.getElementById(`${prefixoId}Comentario${el.value}`).value || null,
  }));
}

async function criarCpdChecklist(event) {
  const form = event.target;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const arCondicionadoProblema = form.querySelector('input[name=cpdArCondicionadoProblema]:checked');
    const fotoInput = document.getElementById('cpdFoto');

    if (!arCondicionadoProblema) {
      toast('Responda a pergunta do ar-condicionado.', 'erro');
      btn.disabled = false;
      return;
    }
    const arComentario = document.getElementById('cpdArCondicionadoComentario').value;
    if (arCondicionadoProblema.value === 'true' && !arComentario.trim()) {
      toast('Descreva o problema encontrado no ar-condicionado.', 'erro');
      btn.disabled = false;
      return;
    }
    if (!fotoInput.files.length) {
      toast('Envie uma foto do CPD.', 'erro');
      btn.disabled = false;
      return;
    }

    const servidoresItens = coletarItensChecklist(form, 'cpdServidor');
    const receptorasItens = coletarItensChecklist(form, 'cpdReceptora');

    const dados = new FormData();
    dados.set('dataRegistro', document.getElementById('cpdData').value);
    dados.set('servidoresItens', JSON.stringify(servidoresItens));
    dados.set('receptorasItens', JSON.stringify(receptorasItens));
    dados.set('arCondicionadoProblema', arCondicionadoProblema.value);
    dados.set('arCondicionadoProblemaComentario', arComentario);
    dados.set('foto', fotoInput.files[0]);

    const resp = await fetch(API + '/cpd/checklist', { method: 'POST', body: dados, credentials: 'same-origin' });
    const corpo = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((corpo && corpo.erro) || `Erro ${resp.status}`);

    toast('Checklist registrado.');
    state.cpd.subview = 'historico';
    render();
  } catch (e) {
    toast(e.message, 'erro');
    btn.disabled = false;
  }
}

// Badge "Observações" (2026-09-23) — resume os 3 Sim/Não antigos numa coisa
// só: quantos itens tiveram comentário (achado real) naquela rodada.
// Registro antigo (sem essa granularidade) cai no formato Sim/Não legado.
function badgeObservacoesCpd(e) {
  if (e.observacoes === null || e.observacoes === undefined) {
    return `${badgeSimNao(e.servidores_verificado)} ${badgeSimNao(e.receptoras_verificado)} ${badgeSimNao(e.ar_condicionado_verificado)} <span class="muted" style="font-size:11px">(registro antigo)</span>`;
  }
  return e.observacoes > 0
    ? `<span class="badge sla-violado">${e.observacoes} observação(ões)</span>`
    : `<span class="badge sla-cumprido">Tudo OK</span>`;
}

const DIAS_SEMANA_CALENDARIO = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

async function viewCpdHistorico() {
  const mes = state.cpd.mesHistorico || new Date().toISOString().slice(0, 7);
  const [todos, resumoMes] = await Promise.all([
    api('/cpd/checklist'),
    api(`/cpd/resumo?mes=${mes}`),
  ]);

  // Calendário do mês (2026-09-23) — verde = tem checklist, vermelho = dia
  // útil sem checklist (mesma lista diasFaltantes que o Dashboard usa),
  // cinza = fim de semana/feriado/dia futuro (por eliminação — nenhuma das
  // duas listas contém essa data).
  const idPorData = new Map();
  for (const e of todos) {
    if (e.data_registro.startsWith(mes) && !idPorData.has(e.data_registro)) idPorData.set(e.data_registro, e.id);
  }
  const diasFaltantesSet = new Set(resumoMes.diasFaltantes);
  const diasParciaisSet = new Set(resumoMes.diasParciais || []);
  const [anoNum, mesNum] = mes.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anoNum, mesNum, 0)).getUTCDate();
  const primeiroDiaSemana = new Date(Date.UTC(anoNum, mesNum - 1, 1)).getUTCDay();
  const celulas = [];
  for (let i = 0; i < primeiroDiaSemana; i++) celulas.push(null);
  for (let d = 1; d <= ultimoDia; d++) {
    const dataStr = `${mes}-${String(d).padStart(2, '0')}`;
    // Dois turnos por dia (2026-10-01) — "parcial" (só manhã OU noite) vira
    // uma 4ª cor, distinta de completo/faltante/neutro.
    const cor = diasParciaisSet.has(dataStr) ? 'partial' : idPorData.has(dataStr) ? 'good' : diasFaltantesSet.has(dataStr) ? 'critical' : null;
    celulas.push({ dia: d, dataStr, cor, execucaoId: idPorData.get(dataStr) });
  }

  const colunas = [
    { key: 'data_registro', label: 'Data' },
    { key: 'turno', label: 'Turno', valor: (e) => e.turno === 'manha' ? 'Manhã' : e.turno === 'noite' ? 'Noite' : '—' },
    { key: 'atendente_nome', label: 'Feito por' },
  ];
  const linhas = aplicarFiltrosColuna(todos, 'cpd', 'historico', colunas);
  return `
    <div class="card" style="margin-bottom:16px">
      <div class="actions-row" style="margin-top:0; justify-content:space-between; align-items:center;">
        <strong>Calendário do mês</strong>
        <input type="month" value="${esc(mes)}" max="${esc(new Date().toISOString().slice(0, 7))}" onchange="state.cpd.mesHistorico = this.value; render();" style="max-width:160px" />
      </div>
      <div style="display:grid; grid-template-columns:repeat(7,1fr); gap:4px; margin-top:12px; max-width:420px;">
        ${DIAS_SEMANA_CALENDARIO.map(d => `<div class="muted" style="text-align:center; font-size:11px;">${d}</div>`).join('')}
        ${celulas.map(c => c ? `
          <div
            ${c.execucaoId ? `onclick="abrirCpdDetalhe(${c.execucaoId})"` : ''}
            style="aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:6px; font-size:12px;
              ${c.execucaoId ? 'cursor:pointer;' : ''}
              ${c.cor === 'good' ? 'background:var(--good-bg); color:var(--good); font-weight:600;' : c.cor === 'partial' ? 'background:var(--warning-bg); color:var(--warning); font-weight:600;' : c.cor === 'critical' ? 'background:var(--critical-bg); color:var(--critical); font-weight:600;' : 'background:var(--neutral-bg); color:var(--text-secondary);'}"
          >${c.dia}</div>
        ` : '<div></div>').join('')}
      </div>
      <p class="muted" style="margin-top:10px; font-size:12px;"><span style="color:var(--good)">■</span> completo (manhã + noite) &nbsp; <span style="color:var(--warning)">■</span> só 1 turno &nbsp; <span style="color:var(--critical)">■</span> dia útil sem checklist &nbsp; <span style="color:var(--text-secondary)">■</span> fim de semana/feriado</p>
    </div>

    <p class="section-desc" style="margin-top:-8px">Clique numa linha pra ver os comentários, os itens marcados e a foto em tamanho real.</p>
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Data</th><th>Turno</th><th>Feito por</th><th>Observações</th></tr>
          ${linhaFiltroColunas('cpd', 'historico', colunas, false)}
        </thead>
        <tbody>
          ${linhas.length ? linhas.map(e => `
            <tr onclick="abrirCpdDetalhe(${e.id})">
              <td>${esc(e.data_registro)}</td>
              <td>${e.turno === 'manha' ? 'Manhã' : e.turno === 'noite' ? 'Noite' : '—'}</td>
              <td>${esc(e.atendente_nome)}</td>
              <td>${badgeObservacoesCpd(e)}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="4">Nenhum registro encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// Item marcado (servidor/receptora) com comentário, ou fallback pro registro
// antigo (sem detalhe por item — só o Sim/Não de seção de sempre).
function listaItensOuLegado(itens, verificadoLegado, comentarioLegado) {
  if (itens.length) {
    return itens.map(i => `
      <div style="padding:6px 0; border-bottom:1px solid var(--border)">
        <strong>${esc(i.nome)}</strong>
        ${i.comentario ? `<div style="color:var(--critical); font-size:13px; margin-top:2px;">${esc(i.comentario)}</div>` : `<div class="muted" style="font-size:12px; margin-top:2px;">Verificado, sem observação.</div>`}
      </div>
    `).join('');
  }
  return `<p class="muted" style="margin:6px 0 0 0">Registro antigo (sem detalhe por item) — verificado: ${badgeSimNao(verificadoLegado)}${comentarioLegado ? `, comentário: ${esc(comentarioLegado)}` : ''}</p>`;
}

async function viewCpdDetalhe(id) {
  const e = await api(`/cpd/checklist/${id}`);
  const podeCorrigir = ['lider', 'gestor'].includes(state.eu.papel);
  const editando = podeCorrigir && state.cpd.editandoExecucao;
  const ehRegistroNovo = e.ar_condicionado_problema !== null && e.ar_condicionado_problema !== undefined;

  // Texto de partida pro chamado T1 — junta os itens com observação numa
  // linha só (nada de \n aqui: vai dentro de uma string JS de aspas simples
  // no onclick, então quebra de linha quebraria o atributo).
  const textoChamadoServidores = e.servidores.filter(i => i.comentario).map(i => `${i.nome}: ${i.comentario}`).join(' | ') || e.servidores_comentario || '';
  const textoChamadoReceptoras = e.receptoras.filter(i => i.comentario).map(i => `${i.nome}: ${i.comentario}`).join(' | ') || e.receptoras_comentario || '';
  const textoChamadoAr = ehRegistroNovo ? (e.ar_condicionado_problema_comentario || '') : (e.ar_condicionado_comentario || '');

  return `
    <button class="btn ghost small" onclick="state.cpd.subview='historico'; render();">&larr; Voltar pro histórico</button>
    <div class="section-title" style="margin-top:10px">Checklist do CPD — ${esc(e.data_registro)}</div>
    <p class="section-desc">Feito por ${esc(e.atendente_nome)} em ${esc(fmtData(e.criado_em))}.</p>

    ${editando ? `
    <div class="card" style="margin-bottom:16px">
      <strong>Corrigir registro</strong>
      <p class="section-desc" style="margin:6px 0 12px 0">Não mexe na foto — se precisar trocar a foto, me avise. Dá pra editar a data, a resposta do ar-condicionado e o comentário dos itens já marcados; pra mudar QUAIS itens foram verificados, é preciso lançar um novo registro.</p>
      <form class="grid-2" onsubmit="salvarCorrecaoCpd(event, ${e.id}); return false;">
        <div class="field"><label>Data</label><input id="corrigirCpdData" type="date" value="${esc(e.data_registro)}" required /></div>
        <div class="field full"></div>
        ${ehRegistroNovo ? `
        <div class="field"><label>Ar-condicionado — encontrou problema?</label>
          <select id="corrigirCpdArProblema" onchange="document.getElementById('corrigirCpdArComentarioWrap').style.display = this.value === '1' ? '' : 'none';">
            <option value="0" ${!e.ar_condicionado_problema ? 'selected' : ''}>Não, tudo normal</option>
            <option value="1" ${e.ar_condicionado_problema ? 'selected' : ''}>Sim, encontrou problema</option>
          </select>
        </div>
        <div class="field" id="corrigirCpdArComentarioWrap" style="${e.ar_condicionado_problema ? '' : 'display:none'}"><label>Descreva o problema</label><input id="corrigirCpdArComentario" type="text" value="${esc(e.ar_condicionado_problema_comentario || '')}" /></div>
        ` : `
        <div class="field"><label>Ar-condicionado — verificado?</label>
          <select id="corrigirCpdArCondicionadoVerificado">
            <option value="1" ${e.ar_condicionado_verificado ? 'selected' : ''}>Sim</option>
            <option value="0" ${!e.ar_condicionado_verificado ? 'selected' : ''}>Não</option>
          </select>
        </div>
        <div class="field"><label>Comentário</label><input id="corrigirCpdArCondicionadoComentario" type="text" value="${esc(e.ar_condicionado_comentario || '')}" /></div>
        `}
        ${e.servidores.length ? `
        <div class="field full"><label>Comentários — servidores</label>
          ${e.servidores.map(i => `<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;"><span style="min-width:160px">${esc(i.nome)}</span><input id="corrigirCpdServidorComentario${i.id}" type="text" value="${esc(i.comentario || '')}" placeholder="Sem observação" style="flex:1" /></div>`).join('')}
        </div>
        ` : ''}
        ${e.receptoras.length ? `
        <div class="field full"><label>Comentários — receptoras</label>
          ${e.receptoras.map(i => `<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;"><span style="min-width:160px">${esc(i.nome)}</span><input id="corrigirCpdReceptoraComentario${i.id}" type="text" value="${esc(i.comentario || '')}" placeholder="Sem observação" style="flex:1" /></div>`).join('')}
        </div>
        ` : ''}
        <div class="full actions-row">
          <button type="submit" class="btn small primary">Salvar correção</button>
          <button type="button" class="btn small ghost" onclick="state.cpd.editandoExecucao=false; render();">Cancelar</button>
        </div>
      </form>
    </div>
    ` : ''}

    <div class="detalhe-grid">
      <div>
        <div class="card">
          <strong>Servidores</strong>
          ${listaItensOuLegado(e.servidores, e.servidores_verificado, e.servidores_comentario)}
          ${textoChamadoServidores ? `<button class="btn small ghost" style="margin-top:8px" onclick="abrirChamadoT1('Servidores', '${jsAttr(textoChamadoServidores)}')">Abrir chamado na T1</button>` : ''}
        </div>
        <div class="card" style="margin-top:16px">
          <strong>Receptoras</strong>
          ${listaItensOuLegado(e.receptoras, e.receptoras_verificado, e.receptoras_comentario)}
          ${textoChamadoReceptoras ? `<button class="btn small ghost" style="margin-top:8px" onclick="abrirChamadoT1('Receptoras', '${jsAttr(textoChamadoReceptoras)}')">Abrir chamado na T1</button>` : ''}
        </div>
        <div class="card" style="margin-top:16px">
          <strong>Ar-condicionado</strong>
          ${ehRegistroNovo ? `
            <p style="margin:6px 0 0 0">${e.ar_condicionado_problema ? '<span class="badge sla-violado">Problema encontrado</span>' : '<span class="badge sla-cumprido">Normal</span>'}</p>
            ${e.ar_condicionado_problema_comentario ? `<p style="margin:6px 0 0 0">${esc(e.ar_condicionado_problema_comentario)}</p>` : ''}
          ` : `
            <p style="margin:6px 0 0 0">Verificado: ${badgeSimNao(e.ar_condicionado_verificado)}</p>
            ${e.ar_condicionado_comentario ? `<p style="margin:6px 0 0 0">${esc(e.ar_condicionado_comentario)}</p>` : ''}
          `}
          ${textoChamadoAr ? `<button class="btn small ghost" style="margin-top:8px" onclick="abrirChamadoT1('Ar-condicionado', '${jsAttr(textoChamadoAr)}')">Abrir chamado na T1</button>` : ''}
        </div>
        ${podeCorrigir && !editando ? `<button class="btn small ghost" style="margin-top:16px" onclick="state.cpd.editandoExecucao=true; render();">Corrigir este registro</button>` : ''}
      </div>
      <div>
        <div class="card">
          <strong>Foto no CPD</strong>
          ${e.foto_arquivo ? `
            <a href="/api/cpd/checklist/${e.id}/foto" target="_blank" rel="noopener">
              <img src="/api/cpd/checklist/${e.id}/foto" alt="Foto do CPD" style="width:100%; border-radius:8px; margin-top:10px; display:block;" />
            </a>
          ` : e.foto_url_externa ? `
            <p class="muted" style="margin-top:8px">Registro migrado do Forms antigo — a foto ficou num SharePoint que exige login da Microsoft, não deu pra trazer pra cá.</p>
            <a class="btn small" href="${esc(e.foto_url_externa)}" target="_blank" rel="noopener">Abrir foto original no SharePoint</a>
          ` : `<p class="muted" style="margin-top:8px">Sem foto neste registro.</p>`}
        </div>
      </div>
    </div>
  `;
}

async function salvarCorrecaoCpd(event, id) {
  try {
    const body = { dataRegistro: document.getElementById('corrigirCpdData').value };

    const arProblemaEl = document.getElementById('corrigirCpdArProblema');
    if (arProblemaEl) {
      body.arCondicionadoProblema = arProblemaEl.value === '1';
      body.arCondicionadoProblemaComentario = document.getElementById('corrigirCpdArComentario').value || null;
    } else {
      body.arCondicionadoVerificado = document.getElementById('corrigirCpdArCondicionadoVerificado').value === '1';
      body.arCondicionadoComentario = document.getElementById('corrigirCpdArCondicionadoComentario').value || null;
    }

    const servidoresComentarios = {};
    document.querySelectorAll('[id^="corrigirCpdServidorComentario"]').forEach(el => {
      servidoresComentarios[el.id.replace('corrigirCpdServidorComentario', '')] = el.value || null;
    });
    if (Object.keys(servidoresComentarios).length) body.servidoresComentarios = servidoresComentarios;

    const receptorasComentarios = {};
    document.querySelectorAll('[id^="corrigirCpdReceptoraComentario"]').forEach(el => {
      receptorasComentarios[el.id.replace('corrigirCpdReceptoraComentario', '')] = el.value || null;
    });
    if (Object.keys(receptorasComentarios).length) body.receptorasComentarios = receptorasComentarios;

    await api(`/cpd/checklist/${id}`, { method: 'PATCH', body });
    state.cpd.editandoExecucao = false;
    toast('Registro corrigido.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// "Abrir chamado na T1" — manda um email pro Targetway na aposta de que
// isso cria um chamado lá (não confirmado ainda — por isso sempre oferece
// o link do portal em seguida, pra conferir manualmente). Composer simples
// via prompt() mesmo, igual outras ações rápidas desta tela (ex.: gerar
// termo de devolução) — não precisa de formulário próprio pra isso.
async function abrirChamadoT1(categoria, comentario) {
  const assunto = prompt('Assunto do chamado:', `Problema no CPD — ${categoria}`);
  if (assunto === null) return;
  const descricao = prompt('Descrição do problema:', comentario || '');
  if (descricao === null) return;
  if (!assunto.trim() || !descricao.trim()) {
    toast('Informe assunto e descrição.', 'erro');
    return;
  }
  try {
    const r = await api('/cpd/abrir-chamado-t1', { method: 'POST', body: { assunto, descricao } });
    toast(`Email enviado pro Targetway (${r.enviadoPara}).`);
    if (confirm('Enviado. Abrir o portal do Targetway agora pra conferir se o chamado foi criado de verdade?')) {
      window.open(r.portalUrl, '_blank');
    }
  } catch (e) {
    toast(e.message, 'erro');
  }
}

// --- View: Atualizações (firmware via iDRAC, 2026-09-23) ------------------
// Checagem automática, não registro manual — ver src/lib/idrac.js pro que
// é confiável (inventário) vs. best-effort (comparação com catálogo Dell,
// não testada contra hardware real). Reaproveita o catálogo cpd_servidores
// (IP da iDRAC é editado na aba Servidores/Receptoras do CPD).

// Link direto pra interface web da iDRAC (2026-10-01) — mesma regra de
// "host" ou "host:porta" que o backend já aceita em src/lib/idrac.js.
function linkIdrac(idracHost) {
  if (!idracHost) return '';
  return `<a href="https://${esc(idracHost)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="btn small ghost">iDRAC &#8599;</a>`;
}

function badgeCriticidadeFirmware(criticidade) {
  if (!criticidade) return '';
  const chave = criticidade.toLowerCase();
  const classe = /urgent|critic/.test(chave) ? 'prioridade-urgente' : /recommend|recomend/.test(chave) ? 'prioridade-alta' : 'prioridade-baixa';
  return `<span class="badge ${classe}">${esc(criticidade)}</span>`;
}

const FIRMWARE_CRITICIDADES = ['Urgent', 'Recommended', 'Optional'];

function contarCriticidadeFirmware(itens, criticidade) {
  return itens.filter(i => i.versao_disponivel && i.criticidade === criticidade).length;
}

function abrirFirmwareDetalhe(id) {
  state.firmware.detalheId = id;
  state.firmware.filtroDetalheCriticidade = ''; // não carrega o filtro do servidor anterior
  render();
}

// Reformulado (2026-09-23) — pedido explícito do usuário: o layout de card
// por servidor com a tabela inteira de componentes (mesmo os já em dia)
// virava rolagem enorme pra 17 servidores. Agora é uma lista-resumo (um
// servidor por linha, contagem de Urgente/Recomendado/Opcional, filtro por
// coluna igual Movimentações/Histórico do CPD) e só abre o detalhe (com
// filtro de criticidade próprio, só os itens COM atualização) quando a
// pessoa clica no servidor que interessa.
async function viewFirmware() {
  const servidores = await api('/firmware');
  pararPollingFirmware(); // evita empilhar interval se render() foi chamado de outro jeito enquanto um já rodava
  if (servidores.some((s) => s.verificando)) iniciarPollingFirmware();

  if (state.firmware.detalheId) {
    const s = servidores.find(x => x.id === state.firmware.detalheId);
    if (s) return viewFirmwareDetalhe(s);
    state.firmware.detalheId = null; // servidor sumiu (desativado) — volta pra lista
  }

  const semFonte = servidores.filter((s) => !s.idrac_host && !s.dcu_host);
  const colunas = [
    { key: 'nome', label: 'Servidor' },
    { key: 'urgent', label: 'Urgente', valor: (s) => String(contarCriticidadeFirmware(s.itens, 'Urgent')) },
    { key: 'recommended', label: 'Recomendado', valor: (s) => String(contarCriticidadeFirmware(s.itens, 'Recommended')) },
    { key: 'optional', label: 'Opcional', valor: (s) => String(contarCriticidadeFirmware(s.itens, 'Optional')) },
  ];
  const linhas = aplicarFiltrosColuna(servidores, 'firmware', 'resumo', colunas);

  return `
    <p class="section-desc" style="margin-top:-8px">Inventário de firmware/driver dos servidores do CPD — lido direto da iDRAC pra quem tem (comparação automática com o catálogo online da Dell), ou via SSH + Dell Command Update pra quem não tem iDRAC. Os dois se cadastram na aba Checklist do CPD &gt; Servidores/Receptoras.</p>
    <div class="actions-row" style="margin-bottom:16px">
      <button class="btn small primary" onclick="verificarTodosFirmware()">Verificar tudo</button>
    </div>
    ${semFonte.length ? `<p class="muted" style="margin:-8px 0 16px 0">${semFonte.length} servidor(es) sem iDRAC nem host de SSH cadastrado, de fora da checagem: ${semFonte.map(s => esc(s.nome)).join(', ')}.</p>` : ''}
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Servidor</th><th>Urgente</th><th>Recomendado</th><th>Opcional</th><th>Última checagem</th><th></th></tr>
          <tr class="filtro-row">
            ${colunas.map(col => `<th><input type="text" data-filtro-key="firmware:resumo:${col.key}" placeholder="Filtrar..." value="${esc(filtroColuna('firmware', 'resumo', col.key))}" oninput="setFiltroColuna('firmware','resumo','${col.key}', this.value)" /></th>`).join('')}
            <th></th><th></th>
          </tr>
        </thead>
        <tbody>
          ${linhas.length ? linhas.map(s => `
            <tr onclick="abrirFirmwareDetalhe(${s.id})">
              <td>${esc(s.nome)}${s.idrac_ultimo_erro ? ' <span class="badge prioridade-urgente" title="' + esc(s.idrac_ultimo_erro) + '">erro</span>' : ''}${!s.idrac_host && !s.dcu_host ? ' <span class="muted">(sem fonte)</span>' : s.dcu_host ? ' <span class="muted" style="font-size:11px">(via SSH)</span>' : ''}</td>
              <td>${contarCriticidadeFirmware(s.itens, 'Urgent') || '—'}</td>
              <td>${contarCriticidadeFirmware(s.itens, 'Recommended') || '—'}</td>
              <td>${contarCriticidadeFirmware(s.itens, 'Optional') || '—'}</td>
              <td>${s.idrac_ultima_checagem ? esc(fmtRelativo(s.idrac_ultima_checagem)) : 'Nunca verificado'}</td>
              <td class="actions">
                ${linkIdrac(s.idrac_host)}
                <button class="btn small ghost" ${s.verificando || (!s.idrac_host && !s.dcu_host) ? 'disabled' : ''} onclick="event.stopPropagation(); verificarUmFirmware(${s.id})">${s.verificando ? 'Verificando…' : 'Verificar agora'}</button>
              </td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="6">Nenhum servidor encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function viewFirmwareDetalhe(s) {
  const filtro = state.firmware.filtroDetalheCriticidade;
  const itensComAtualizacao = s.itens.filter(i => i.versao_disponivel);
  const itensExibidos = filtro ? itensComAtualizacao.filter(i => i.criticidade === filtro) : itensComAtualizacao;

  return `
    <button class="btn ghost small" onclick="state.firmware.detalheId = null; render();">&larr; Voltar pra lista</button>
    <div class="section-title" style="margin-top:10px">${esc(s.nome)}</div>
    <p class="section-desc">${s.idrac_host ? `${esc(s.idrac_host)} (iDRAC)` : s.dcu_host ? `${esc(s.dcu_host)} (SSH + Dell Command Update)` : 'Sem iDRAC nem host de SSH cadastrado'} — ${s.idrac_ultima_checagem ? `última checagem ${esc(fmtRelativo(s.idrac_ultima_checagem))}` : 'nunca verificado'} ${linkIdrac(s.idrac_host)}</p>
    ${s.idrac_ultimo_erro ? `<div class="card" style="margin-bottom:16px; background:var(--critical-bg); border-color:var(--critical);"><strong style="color:var(--critical)">Erro na última checagem</strong><p style="margin:6px 0 0 0">${esc(s.idrac_ultimo_erro)}</p></div>` : ''}
    <div class="actions-row" style="margin-bottom:16px">
      <button class="btn small ghost" ${s.verificando || (!s.idrac_host && !s.dcu_host) ? 'disabled' : ''} onclick="verificarUmFirmware(${s.id})">${s.verificando ? 'Verificando…' : 'Verificar agora'}</button>
      <select onchange="state.firmware.filtroDetalheCriticidade = this.value; render();" style="max-width:200px">
        <option value="">Todas as criticidades</option>
        ${FIRMWARE_CRITICIDADES.map(c => `<option value="${c}" ${filtro === c ? 'selected' : ''}>${c} (${contarCriticidadeFirmware(s.itens, c)})</option>`).join('')}
      </select>
    </div>
    ${itensExibidos.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Componente</th><th>Versão atual</th><th>Versão disponível</th><th>Criticidade</th></tr></thead>
          <tbody>
            ${itensExibidos.map(i => `
              <tr>
                <td>${esc(i.componente)}</td>
                <td>${esc(i.versao_atual) || '—'}</td>
                <td><strong>${esc(i.versao_disponivel)}</strong></td>
                <td>${badgeCriticidadeFirmware(i.criticidade) || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div class="card empty-row">${itensComAtualizacao.length ? 'Nenhum item com essa criticidade.' : 'Nenhuma atualização pendente pra este servidor.'}</div>`}
  `;
}

function iniciarPollingFirmware() {
  if (state.firmware.pollId) return;
  state.firmware.pollId = setInterval(() => {
    if (state.view !== 'firmware') { pararPollingFirmware(); return; }
    render();
  }, 5000);
}

function pararPollingFirmware() {
  if (state.firmware.pollId) {
    clearInterval(state.firmware.pollId);
    state.firmware.pollId = null;
  }
}

async function verificarUmFirmware(servidorId) {
  try {
    await api(`/firmware/${servidorId}/verificar`, { method: 'POST' });
    toast('Checagem concluída.');
  } catch (e) {
    toast(e.message, 'erro');
  }
  render();
}

async function verificarTodosFirmware() {
  try {
    const r = await api('/firmware/verificar', { method: 'POST' });
    toast(`Checagem iniciada em ${r.total} servidor(es)${r.semIdrac ? ` (${r.semIdrac} sem iDRAC/SSH cadastrado, ficaram de fora)` : ''}.`);
  } catch (e) {
    toast(e.message, 'erro');
  }
  render();
}

// --- View: Segurança (alertas do Acronis Cyber Protect, 2026-09-30) -------
// Meta do time: zerar os alertas ao longo do mês. "Arquivar mês atual"
// substitui o print do portal do Acronis por um registro permanente e
// consultável aqui — ver src/lib/acronis.js pro que é confiável vs
// best-effort na integração (paginação e campo de dispositivo dentro dos
// detalhes ainda não validados contra a API real).

const ACRONIS_ABAS = [
  { key: 'alertas', label: 'Alertas atuais' },
  { key: 'historico', label: 'Histórico mensal' },
];

function badgeSeveridadeAcronis(severidade) {
  if (!severidade) return '—';
  const chave = severidade.toLowerCase();
  const classe = /critical|error/.test(chave) ? 'prioridade-urgente' : /warning/.test(chave) ? 'prioridade-alta' : 'prioridade-baixa';
  return `<span class="badge ${classe}">${esc(severidade)}</span>`;
}

// detalhes_json é details.fields cru da Acronis (livre, varia por tipo de
// alerta) — mostra como veio, sem adivinhar qual chave é "o dispositivo".
function camposDetalhesAcronis(detalhesJson) {
  let campos;
  try { campos = JSON.parse(detalhesJson || '{}'); } catch (e) { campos = {}; }
  const entradas = Object.entries(campos);
  if (!entradas.length) return '';
  return `<dl class="kv">${entradas.map(([chave, valor]) => `<dt>${esc(chave)}</dt><dd>${esc(String(valor))}</dd>`).join('')}</dl>`;
}

async function viewAcronis() {
  if (state.acronis.detalheArquivoId) return viewAcronisArquivoDetalhe(state.acronis.detalheArquivoId);
  const aba = state.acronis.subview;
  const conteudo = aba === 'historico' ? await viewAcronisHistorico() : await viewAcronisAlertas();
  return `
    <div class="section-title">Segurança</div>
    <p class="section-desc">Alertas do Acronis Cyber Protect nos dispositivos corporativos — meta é zerar ao longo do mês. "Arquivar mês atual" registra a situação de agora como prova permanente, no lugar do print do portal.</p>
    <div class="toolbar">
      ${ACRONIS_ABAS.map(a => `
        <button class="btn small ${aba === a.key ? 'primary' : ''}" onclick="state.acronis.subview='${a.key}'; render();">${esc(a.label)}</button>
      `).join('')}
    </div>
    ${conteudo}
  `;
}

async function viewAcronisAlertas() {
  const alertas = await api('/acronis/alertas');
  const colunas = [
    { key: 'severidade', label: 'Severidade' },
    { key: 'titulo', label: 'Título' },
    { key: 'categoria', label: 'Categoria' },
  ];
  const linhas = aplicarFiltrosColuna(alertas, 'acronis', 'alertas', colunas);
  return `
    <div class="actions-row" style="margin:16px 0">
      <button class="btn small primary" onclick="sincronizarAcronis()">Sincronizar agora</button>
    </div>
    <div class="table-wrap scroll">
      <table>
        <thead>
          <tr><th>Severidade</th><th>Título</th><th>Categoria</th><th>Visto pela última vez</th></tr>
          <tr class="filtro-row">
            ${colunas.map(col => `<th><input type="text" data-filtro-key="acronis:alertas:${col.key}" placeholder="Filtrar..." value="${esc(filtroColuna('acronis', 'alertas', col.key))}" oninput="setFiltroColuna('acronis','alertas','${col.key}', this.value)" /></th>`).join('')}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${linhas.length ? linhas.map(a => `
            <tr onclick="state.acronis.alertaExpandidoId = state.acronis.alertaExpandidoId === '${a.id}' ? null : '${a.id}'; render();">
              <td>${badgeSeveridadeAcronis(a.severidade)}</td>
              <td>${esc(a.titulo) || '—'}</td>
              <td>${esc(a.categoria) || '—'}</td>
              <td>${esc(fmtRelativo(a.visto_pela_ultima_vez))}</td>
            </tr>
            ${state.acronis.alertaExpandidoId === a.id ? `
              <tr><td colspan="4">
                ${a.descricao ? `<p style="margin:0 0 8px 0">${esc(a.descricao)}</p>` : ''}
                ${camposDetalhesAcronis(a.detalhes_json)}
              </td></tr>
            ` : ''}
          `).join('') : `<tr class="empty-row"><td colspan="4">Nenhum alerta ativo — zerado!</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function sincronizarAcronis() {
  try {
    const r = await api('/acronis/sincronizar', { method: 'POST' });
    toast(`Sincronizado — ${r.total} alerta(s) ativo(s)${r.resolvidosAgora ? `, ${r.resolvidosAgora} resolvido(s) desde a última checagem` : ''}.`);
  } catch (e) {
    toast(e.message, 'erro');
  }
  render();
}

async function viewAcronisHistorico() {
  const arquivos = await api('/acronis/arquivos');
  return `
    <div class="actions-row" style="margin:16px 0">
      <button class="btn small primary" onclick="arquivarMesAcronis()">Arquivar mês atual</button>
    </div>
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th>Mês</th><th>Total de alertas</th><th>Registrado por</th><th>Quando</th></tr></thead>
        <tbody>
          ${arquivos.length ? arquivos.map(m => `
            <tr onclick="state.acronis.detalheArquivoId=${m.id}; render();">
              <td>${esc(m.mes)}</td>
              <td>${m.total_alertas === 0 ? '<span class="badge sla-cumprido">Zerado</span>' : `<span class="badge sla-violado">${m.total_alertas}</span>`}</td>
              <td>${esc(m.atendente_nome)}</td>
              <td>${esc(fmtDataHora(m.gerado_em))}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="4">Nenhum mês arquivado ainda.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function arquivarMesAcronis() {
  const alertas = await api('/acronis/alertas');
  if (!confirm(`Confirma arquivar o mês com ${alertas.length} alerta(s) ativo(s) agora? Isso registra a situação de hoje como prova permanente — não dá pra desfazer.`)) return;
  try {
    await api('/acronis/arquivos', { method: 'POST' });
    toast('Mês arquivado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function viewAcronisArquivoDetalhe(id) {
  const arquivo = await api(`/acronis/arquivos/${id}`);
  return `
    <button class="btn ghost small" onclick="state.acronis.detalheArquivoId = null; render();">&larr; Voltar pro histórico</button>
    <div class="section-title" style="margin-top:10px">Segurança — ${esc(arquivo.mes)}</div>
    <p class="section-desc">Registrado por ${esc(arquivo.atendente_nome)} em ${esc(fmtDataHora(arquivo.gerado_em))} — ${arquivo.total_alertas} alerta(s) ativo(s) no momento.</p>
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th>Severidade</th><th>Título</th><th>Categoria</th></tr></thead>
        <tbody>
          ${arquivo.alertas.length ? arquivo.alertas.map(a => `
            <tr>
              <td>${badgeSeveridadeAcronis(a.severidade)}</td>
              <td>${esc(a.titulo) || '—'}</td>
              <td>${esc(a.categoria) || '—'}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="3">Zerado — nenhum alerta ativo nesse momento.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- View: Usuários & Hosts (dados do AD, só leitura) ---------------------
// Não escreve nada — quem gera/atualiza esses dados é o projeto separado de
// mapeamento de AD (GPO + script de logon + tarefa agendada a cada 15 min).
// Este site só lê o .json que esse projeto já exporta (ver src/routes/ad.js
// e AD_DADOS_JSON_PATH no .env).

function fmtRelativo(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

// Dispatcher da aba "Colaboradores" (2026-09-18) — sub-aba "Usuários &
// Hosts" (dados do AD/LDAP) sempre visível pra quem chega aqui
// (Atendente/Líder/Gestor); Cargos/Sistemas/Onboarding só pra
// papel='atendente' (decisão explícita do usuário).
async function viewColaboradores() {
  const podeOnboarding = state.eu.papel === 'atendente';
  const aba = state.colaboradores.subview;
  const abas = [
    { key: 'usuarios', label: 'Usuários & Hosts' },
    ...(podeOnboarding
      ? [
          { key: 'cargos', label: 'Cargos' },
          { key: 'sistemas', label: 'Sistemas' },
          { key: 'onboarding', label: 'Onboarding de acessos' },
        ]
      : []),
  ];

  let conteudo;
  if (aba === 'cargos' && podeOnboarding) conteudo = await viewColaboradoresCargos();
  else if (aba === 'sistemas' && podeOnboarding) conteudo = await viewColaboradoresSistemas();
  else if (aba === 'onboarding' && podeOnboarding) conteudo = await viewColaboradoresOnboarding();
  else conteudo = await viewColaboradoresUsuarios();

  return `
    <div class="section-title">Colaboradores</div>
    <div class="toolbar" style="margin-bottom:16px">
      ${abas.map((a) => `<button class="btn small ${aba === a.key ? 'primary' : ''}" onclick="state.colaboradores.subview='${a.key}'; render();">${esc(a.label)}</button>`).join('')}
    </div>
    ${conteudo}
  `;
}

async function viewColaboradoresUsuarios() {
  let resposta;
  try {
    resposta = await api('/ad/usuarios');
  } catch (e) {
    return `<div class="card"><strong>Não consegui carregar os dados do AD.</strong><br>${esc(e.message)}</div>`;
  }
  const f = state.ad;
  const departamentos = [...new Set(resposta.usuarios.map(u => u.departamento).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const termo = f.busca.trim().toLowerCase();
  const filtrados = resposta.usuarios.filter(u => {
    if (f.departamento && u.departamento !== f.departamento) return false;
    if (f.apenasColetados && !u.coletado) return false;
    if (!termo) return true;
    return [u.nome, u.usuario, u.host, u.tag, u.ip].some(v => (v || '').toLowerCase().includes(termo));
  });

  return `
    <p class="section-desc" style="margin-top:-8px">Host, service tag, IP, sistema operacional e último login, gravados no Active Directory pelo script de logon via GPO e lidos direto do AD por consulta LDAP. Dados atualizados ${esc(fmtRelativo(resposta.atualizadoEm))} (${esc(fmtDataHora(resposta.atualizadoEm))}). Só leitura — quem grava esses dados é o mapeamento de AD, não este site.</p>

    <div class="toolbar">
      <div class="field" style="min-width:220px">
        <label>Buscar (nome, usuário, host, tag, IP)</label>
        <input type="text" value="${esc(f.busca)}"
          onkeydown="if(event.key==='Enter'){ state.ad.busca=this.value; render(); }"
          onblur="state.ad.busca=this.value; render();" />
      </div>
      <div class="field">
        <label>Departamento</label>
        <select onchange="state.ad.departamento=this.value; render();">
          <option value="">Todos</option>
          ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label><input type="checkbox" style="width:auto" ${f.apenasColetados ? 'checked' : ''} onchange="state.ad.apenasColetados=this.checked; render();" /> Só com dados coletados</label>
      </div>
      <div style="flex:1"></div>
      <span class="muted">${filtrados.length} de ${resposta.usuarios.length} usuário(s)</span>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Nome</th><th>Usuário</th><th>Departamento</th><th>Host</th><th>Service tag</th><th>IP</th><th>SO</th><th>Último login</th></tr></thead>
        <tbody>
          ${filtrados.length ? filtrados.map(u => `
            <tr>
              <td>${esc(u.nome)}</td>
              <td>${esc(u.usuario)}</td>
              <td>${esc(u.departamento)}</td>
              <td>${u.coletado ? esc(u.host) : '<span class="muted">pendente</span>'}</td>
              <td>${u.coletado ? esc(u.tag) : '—'}</td>
              <td>${u.coletado ? esc(u.ip) : '—'}</td>
              <td>${u.coletado ? esc(u.so) : '—'}</td>
              <td>${u.coletado ? esc(u.login) : '—'}</td>
            </tr>
          `).join('') : `<tr class="empty-row"><td colspan="8">Nenhum usuário encontrado com esses filtros.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- Colaboradores: Cargos ------------------------------------------------

async function viewColaboradoresCargos() {
  const cargos = await api('/onboarding/cargos');
  // Sistema "obrigatório para todos" (ex.: Usuário de rede) não aparece
  // aqui — ele já entra sozinho pra todo colaborador, não precisa marcar
  // cargo por cargo (ver aba Sistemas).
  const sistemas = (await api('/onboarding/sistemas')).filter((s) => !s.obrigatorio_para_todos);
  const editandoId = state.colaboradores.cargoEditandoSistemas;
  let sistemasDoCargoEditando = [];
  if (editandoId) sistemasDoCargoEditando = await api(`/onboarding/cargos/${editandoId}/sistemas`);

  return `
    <p class="section-desc" style="margin-top:-8px">Cargos e quais sistemas cada um precisa — pra não esquecer de liberar nada no onboarding. "Abre chamado no TomTicket direto" muda o e-mail de boas-vindas (inclui ou não o passo a passo do TomTicket). Sistemas marcados "obrigatório para todos" (aba Sistemas) não aparecem na lista abaixo — já entram pra qualquer colaborador automaticamente, exceto cargo marcado "Externo" (consultor externo, técnico externo etc.), que nunca recebe usuário de rede.</p>
    <div class="card" style="margin-bottom:16px">
      <strong>Novo cargo</strong>
      <form class="grid-2" style="margin-top:10px" onsubmit="criarCargoOnboarding(event); return false;">
        <div class="field"><input id="novoCargoNome" type="text" placeholder="Nome do cargo" required /></div>
        <div class="field"><label><input type="checkbox" id="novoCargoTomTicket" style="width:auto" /> Abre chamado no TomTicket direto</label></div>
        <div class="field"><label><input type="checkbox" id="novoCargoExterno" style="width:auto" /> Externo (consultor/técnico externo — sem usuário de rede)</label></div>
        <div class="full"><button class="btn small primary" type="submit">Adicionar</button></div>
      </form>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Cargo</th><th>TomTicket direto?</th><th>Externo?</th><th>Sistemas</th><th></th></tr></thead>
        <tbody>
          ${cargos.length ? cargos.map(c => `
            <tr>
              <td>${esc(c.nome)}</td>
              <td>${c.acesso_tomticket ? '✓' : '—'}</td>
              <td><label><input type="checkbox" ${c.externo ? 'checked' : ''} style="width:auto" onchange="alternarCargoExterno(${c.id}, this.checked)" /></label></td>
              <td><button class="btn small ghost" onclick="state.colaboradores.cargoEditandoSistemas='${c.id}'; render();">Configurar sistemas</button></td>
              <td><button class="btn small ghost" onclick="excluirCargoOnboarding(${c.id}, '${jsAttr(c.nome)}')">Excluir</button></td>
            </tr>
            ${editandoId == c.id ? `
            <tr><td colspan="5">
              <div class="card">
                <strong>Sistemas do cargo "${esc(c.nome)}"</strong>
                <div style="margin-top:10px">
                  ${sistemas.length ? sistemas.map(s => `
                    <label style="display:inline-block; margin:4px 10px 4px 0">
                      <input type="checkbox" class="cargoSistemaCheckbox" value="${s.id}" style="width:auto" ${sistemasDoCargoEditando.includes(s.id) ? 'checked' : ''} /> ${esc(s.nome)}
                    </label>
                  `).join('') : '<p class="muted">Nenhum sistema cadastrado ainda (aba Sistemas).</p>'}
                </div>
                <div class="actions-row" style="margin-top:12px">
                  <button class="btn small primary" onclick="salvarSistemasDoCargo('${c.id}')">Salvar</button>
                  <button class="btn small ghost" onclick="state.colaboradores.cargoEditandoSistemas=null; render();">Fechar</button>
                </div>
              </div>
            </td></tr>
            ` : ''}
          `).join('') : `<tr class="empty-row"><td colspan="5">Nenhum cargo cadastrado ainda.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function criarCargoOnboarding(event) {
  try {
    await api('/onboarding/cargos', {
      method: 'POST',
      body: {
        nome: document.getElementById('novoCargoNome').value,
        acessoTomTicket: document.getElementById('novoCargoTomTicket').checked,
        externo: document.getElementById('novoCargoExterno').checked,
      },
    });
    toast('Cargo criado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function alternarCargoExterno(cargoId, valor) {
  try {
    await api(`/onboarding/cargos/${cargoId}`, { method: 'PATCH', body: { externo: valor } });
    toast(valor ? 'Cargo marcado como externo — não recebe mais usuário de rede.' : 'Cargo deixou de ser externo.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function excluirCargoOnboarding(id, nome) {
  if (!confirm(`Excluir o cargo "${nome}"? Só funciona se ele não tiver sistemas associados nem colaborador cadastrado nele.`)) return;
  try {
    await api(`/onboarding/cargos/${id}`, { method: 'DELETE' });
    toast('Cargo excluído.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarSistemasDoCargo(cargoId) {
  const sistemaIds = [...document.querySelectorAll('.cargoSistemaCheckbox:checked')].map((el) => Number(el.value));
  try {
    await api(`/onboarding/cargos/${cargoId}/sistemas`, { method: 'PUT', body: { sistemaIds } });
    toast('Sistemas do cargo atualizados.');
    state.colaboradores.cargoEditandoSistemas = null;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- Colaboradores: Sistemas -----------------------------------------------

async function viewColaboradoresSistemas() {
  const sistemas = await api('/onboarding/sistemas');
  return `
    <p class="section-desc" style="margin-top:-8px">Catálogo de sistemas usados na empresa (Rede, E-mail, TelehelpSys, etc.) — associados a cargo em "Cargos", e usados na ficha de acessos. Um sistema marcado "obrigatório para todos" (ex.: Usuário de rede) entra na ficha de qualquer colaborador automaticamente, sem precisar marcar cargo por cargo — e sempre aparece primeiro na lista.</p>
    <div class="card" style="margin-bottom:16px">
      <form style="display:flex; gap:8px; align-items:center; flex-wrap:wrap" onsubmit="criarSistemaOnboarding(event); return false;">
        <input id="novoSistemaNome" type="text" placeholder="Nome do sistema" required style="flex:1; border:1px solid var(--border); border-radius:8px; padding:7px 10px;" />
        <label style="white-space:nowrap"><input type="checkbox" id="novoSistemaObrigatorio" style="width:auto" /> Obrigatório para todos</label>
        <button class="btn small primary" type="submit">Adicionar</button>
      </form>
    </div>
    <div class="table-wrap">
      <table><tbody>
        ${sistemas.length ? [...sistemas].sort((a, b) => (b.obrigatorio_para_todos - a.obrigatorio_para_todos) || a.nome.localeCompare(b.nome)).map(s => `<tr><td>${esc(s.nome)}</td><td>${s.obrigatorio_para_todos ? '<span class="badge">Obrigatório para todos</span>' : ''}</td><td><button class="btn small ghost" onclick="excluirSistemaOnboarding(${s.id}, '${jsAttr(s.nome)}')">Excluir</button></td></tr>`).join('') : '<tr class="empty-row"><td colspan="3">Nenhum sistema ainda.</td></tr>'}
      </tbody></table>
    </div>
  `;
}

async function criarSistemaOnboarding(event) {
  try {
    await api('/onboarding/sistemas', {
      method: 'POST',
      body: {
        nome: document.getElementById('novoSistemaNome').value,
        obrigatorioParaTodos: document.getElementById('novoSistemaObrigatorio').checked,
      },
    });
    toast('Sistema criado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function excluirSistemaOnboarding(id, nome) {
  if (!confirm(`Excluir o sistema "${nome}"? Só funciona se ele não estiver associado a nenhum cargo nem colaborador.`)) return;
  try {
    await api(`/onboarding/sistemas/${id}`, { method: 'DELETE' });
    toast('Sistema excluído.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- Colaboradores: Onboarding (credenciais, ficha, e-mail) ----------------

async function viewColaboradoresOnboarding() {
  const [colaboradores, cargos, documentos] = await Promise.all([
    api('/onboarding/colaboradores'),
    api('/onboarding/cargos'),
    api('/onboarding/documentos'),
  ]);
  // Busca do AD (2026-09-18) — evita cadastrar de novo o que já foi
  // preenchido no AD na hora de criar o usuário. Best-effort: se o LDAP
  // não estiver configurado/acessível, só não mostra a busca, sem quebrar
  // o resto da tela.
  let usuariosAD = [];
  try {
    const respAD = await api('/ad/usuarios');
    usuariosAD = respAD.usuarios;
  } catch (_) { /* segue sem a busca do AD */ }
  state.colaboradores.usuariosAD = usuariosAD; // guardado pra preencherOnbDoAD() achar o registro escolhido

  const selecionadoId = state.colaboradores.colaboradorSelecionado;
  const selecionado = selecionadoId ? colaboradores.find((c) => c.id === selecionadoId) : null;
  const editando = state.colaboradores.editandoColaborador;
  const credenciais = selecionado ? await api(`/onboarding/colaboradores/${selecionadoId}/credenciais`) : [];

  return `
    <div class="card" style="margin-bottom:16px">
      <strong>Documentos anexados ao e-mail de boas-vindas</strong>
      <p class="section-desc" style="margin:6px 0 10px 0">Cargo normal: Assinatura (computador) vai sempre, TomTicket só quando o cargo tiver "Abre chamado no TomTicket direto" marcado. Cargo externo (consultor/técnico externo): só Assinatura (celular) e VPN, os dois obrigatórios — esse documento é exclusivo do fluxo externo, não vai pro cargo normal.</p>
      <div class="actions-row">
        <span>Assinatura: ${documentos.assinatura ? '<span class="badge sla-cumprido">Enviado</span>' : '<span class="badge sla-violado">Faltando</span>'}</span>
        <input type="file" id="uploadAssinaturaInput" accept=".docx" style="display:none" onchange="enviarDocumentoOnboarding('assinatura', event)" />
        <button class="btn small ghost" onclick="document.getElementById('uploadAssinaturaInput').click()">Enviar/substituir</button>
      </div>
      <div class="actions-row" style="margin-top:6px">
        <span>Assinatura (celular): ${documentos.assinaturaCelular ? '<span class="badge sla-cumprido">Enviado</span>' : '<span class="badge">Faltando — obrigatório pra cargo externo</span>'}</span>
        <input type="file" id="uploadAssinaturaCelularInput" accept=".docx" style="display:none" onchange="enviarDocumentoOnboarding('assinatura-celular', event)" />
        <button class="btn small ghost" onclick="document.getElementById('uploadAssinaturaCelularInput').click()">Enviar/substituir</button>
      </div>
      <div class="actions-row" style="margin-top:6px">
        <span>VPN (cargo externo): ${documentos.vpn ? '<span class="badge sla-cumprido">Enviado</span>' : '<span class="badge sla-violado">Faltando</span>'}</span>
        <input type="file" id="uploadVpnInput" accept=".docx" style="display:none" onchange="enviarDocumentoOnboarding('vpn', event)" />
        <button class="btn small ghost" onclick="document.getElementById('uploadVpnInput').click()">Enviar/substituir</button>
      </div>
      <div class="actions-row" style="margin-top:6px">
        <span>TomTicket: ${documentos.tomticket ? '<span class="badge sla-cumprido">Enviado</span>' : '<span class="badge sla-violado">Faltando</span>'}</span>
        <input type="file" id="uploadTomTicketInput" accept=".docx" style="display:none" onchange="enviarDocumentoOnboarding('tomticket', event)" />
        <button class="btn small ghost" onclick="document.getElementById('uploadTomTicketInput').click()">Enviar/substituir</button>
      </div>
    </div>

    <div class="detalhe-grid">
      <div>
        <div class="card">
          <strong>Novo colaborador</strong>
          ${usuariosAD.length ? `
          <div class="field full" style="margin-top:10px">
            <label>Buscar no AD (preenche nome/e-mail/departamento/cargo sozinho — confira antes de cadastrar)</label>
            <input type="text" list="listaUsuariosAD" placeholder="Digite o nome..." oninput="preencherOnbDoAD(this.value)" />
            <datalist id="listaUsuariosAD">
              ${usuariosAD.map(u => `<option value="${esc(u.nome)}" data-usuario="${esc(u.usuario)}"></option>`).join('')}
            </datalist>
          </div>
          ` : ''}
          <form class="grid-2" style="margin-top:10px" onsubmit="criarColaboradorOnboarding(event); return false;">
            <div class="field"><input id="novoOnbNome" type="text" placeholder="Nome completo" required oninput="autoDetectarGeneroOnb(this.value)" /></div>
            <div class="field">
              <select id="novoOnbCargo">
                <option value="">Cargo...</option>
                ${cargos.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><input id="novoOnbGestor" type="text" placeholder="Gestor" /></div>
            <div class="field"><input id="novoOnbEmail" type="email" placeholder="E-mail do colaborador" /></div>
            <div class="field">
              <select id="novoOnbGenero" onchange="this.dataset.auto=''">
                <option value="">Gênero (pra "bem-vindo(a)" no e-mail)</option>
                <option value="f">Feminino</option>
                <option value="m">Masculino</option>
              </select>
            </div>
            <div class="field"><input id="novoOnbDepartamento" type="text" placeholder="Área/Departamento (p/ assinatura, ex: Central de Emergência)" /></div>
            <div class="field"><input id="novoOnbUsuarioRede" type="text" placeholder="Usuário de rede (login do AD, ex: ian.alves)" /></div>
            <div class="full"><button class="btn small primary" type="submit">Cadastrar</button></div>
          </form>
        </div>
        <div class="table-wrap scroll" style="margin-top:16px">
          <table>
            <thead><tr><th>Nome</th><th>Cargo</th><th>Gestor</th></tr></thead>
            <tbody>
              ${colaboradores.length ? colaboradores.map(c => `
                <tr onclick="state.colaboradores.colaboradorSelecionado='${c.id}'; render();" style="cursor:pointer; ${selecionadoId === c.id ? 'background:var(--good-bg)' : ''}">
                  <td>${esc(c.nome)}</td><td>${esc(c.cargo_nome || '—')}</td><td>${esc(c.gestor || '—')}</td>
                </tr>
              `).join('') : '<tr class="empty-row"><td colspan="3">Nenhum colaborador cadastrado ainda.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        ${selecionado ? `
        <div class="card">
          <div class="actions-row" style="margin-top:0; justify-content:space-between; align-items:flex-start;">
            <div>
              <strong>${esc(selecionado.nome)}</strong>
              <p class="muted" style="margin-top:4px">${esc(selecionado.cargo_nome || 'Sem cargo definido')} ${selecionado.gestor ? '· Gestor: ' + esc(selecionado.gestor) : ''} ${selecionado.genero ? '· ' + (selecionado.genero === 'f' ? 'Feminino' : 'Masculino') : '· Gênero não definido'}</p>
            </div>
            <div>
              <button class="btn small ghost" onclick="state.colaboradores.editandoColaborador=!state.colaboradores.editandoColaborador; render();">Editar</button>
              <button class="btn small ghost" onclick="excluirColaboradorOnboarding('${selecionado.id}')">Excluir</button>
            </div>
          </div>
          ${editando ? `
          <form class="grid-2" style="margin-top:10px" onsubmit="salvarEdicaoColaboradorOnboarding(event, '${selecionado.id}'); return false;">
            <div class="field"><input id="editOnbNome" type="text" value="${esc(selecionado.nome)}" required /></div>
            <div class="field">
              <select id="editOnbCargo">
                <option value="">Cargo...</option>
                ${cargos.map(c => `<option value="${c.id}" ${c.id === selecionado.cargo_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><input id="editOnbGestor" type="text" placeholder="Gestor" value="${esc(selecionado.gestor)}" /></div>
            <div class="field"><input id="editOnbEmail" type="email" placeholder="E-mail" value="${esc(selecionado.email)}" /></div>
            <div class="field">
              <select id="editOnbGenero">
                <option value="">Gênero...</option>
                <option value="f" ${selecionado.genero === 'f' ? 'selected' : ''}>Feminino</option>
                <option value="m" ${selecionado.genero === 'm' ? 'selected' : ''}>Masculino</option>
              </select>
            </div>
            <div class="field"><input id="editOnbDepartamento" type="text" placeholder="Área/Departamento" value="${esc(selecionado.departamento)}" /></div>
            <div class="field"><input id="editOnbUsuarioRede" type="text" placeholder="Usuário de rede" value="${esc(selecionado.usuario_rede)}" /></div>
            <div class="full actions-row">
              <button type="submit" class="btn small primary">Salvar</button>
              <button type="button" class="btn small ghost" onclick="state.colaboradores.editandoColaborador=false; render();">Cancelar</button>
            </div>
          </form>
          ` : ''}
          ${!selecionado.cargo_id ? '<p class="muted">Defina um cargo pra esse colaborador (edite o cadastro) pra ver os sistemas liberados.</p>' : ''}
          ${credenciais.length ? `
            <form onsubmit="salvarCredenciaisOnboarding(event, '${selecionado.id}'); return false;">
              <div class="table-wrap" style="margin-top:10px">
                <table>
                  <thead><tr><th>Sistema</th><th>Usuário</th><th>Senha</th></tr></thead>
                  <tbody>
                    ${credenciais.map((c, idx) => {
                      const sugestao = sugerirCredencial(selecionado, c);
                      const usuarioValor = c.usuario || sugestao.usuario || '';
                      const senhaValor = !c.temSenha && sugestao.senha ? sugestao.senha : '';
                      return `
                      <tr>
                        <td>${(c.obrigatorioParaTodos || c.obrigatorioExterno) ? `<b>${esc(c.sistemaNome)}</b>` : esc(c.sistemaNome)}</td>
                        <td><input type="text" class="credUsuario" data-sistema-id="${c.sistemaId}" value="${esc(usuarioValor)}" style="width:100%" /></td>
                        <td><input type="text" class="credSenha" data-sistema-id="${c.sistemaId}" value="${esc(senhaValor)}" placeholder="${c.temSenha ? '(mantém a atual)' : ''}" style="width:100%" /></td>
                      </tr>
                    `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
              <div class="full actions-row" style="margin-top:10px"><button type="submit" class="btn small primary">Salvar credenciais</button></div>
            </form>
          ` : selecionado.cargo_id ? '<p class="muted" style="margin-top:10px">Esse cargo ainda não tem sistema nenhum associado (aba Cargos).</p>' : ''}
          <div class="actions-row" style="margin-top:16px">
            <button class="btn small" onclick="baixarFichaAcessos('${selecionado.id}')">Baixar ficha de acessos</button>
            <button class="btn small primary" onclick="enviarBoasVindas('${selecionado.id}')">Enviar e-mail de boas-vindas</button>
          </div>
        </div>
        ` : '<div class="card empty-row">Selecione um colaborador na lista pra ver/editar as credenciais.</div>'}
      </div>
    </div>
  `;
}

async function criarColaboradorOnboarding(event) {
  try {
    const cargoId = document.getElementById('novoOnbCargo').value;
    await api('/onboarding/colaboradores', {
      method: 'POST',
      body: {
        nome: document.getElementById('novoOnbNome').value,
        cargoId: cargoId ? Number(cargoId) : null,
        gestor: document.getElementById('novoOnbGestor').value || null,
        email: document.getElementById('novoOnbEmail').value || null,
        genero: document.getElementById('novoOnbGenero').value || null,
        departamento: document.getElementById('novoOnbDepartamento').value || null,
        usuarioRede: document.getElementById('novoOnbUsuarioRede').value || null,
      },
    });
    toast('Colaborador cadastrado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// Preenche o formulário de novo colaborador a partir de um usuário
// escolhido no <datalist> do AD (2026-09-18) — evita digitar de novo o
// que já foi preenchido no AD na hora de criar o usuário. Não cadastra
// sozinho — só preenche os campos, a pessoa confere e clica "Cadastrar".
function preencherOnbDoAD(nomeEscolhido) {
  const usuario = (state.colaboradores.usuariosAD || []).find((u) => u.nome === nomeEscolhido);
  if (!usuario) return; // ainda digitando, não bateu com nenhuma opção do datalist
  document.getElementById('novoOnbNome').value = usuario.nome;
  if (usuario.email) document.getElementById('novoOnbEmail').value = usuario.email;
  if (usuario.departamento) document.getElementById('novoOnbDepartamento').value = usuario.departamento;
  if (usuario.gestor) document.getElementById('novoOnbGestor').value = usuario.gestor;
  if (usuario.usuario) document.getElementById('novoOnbUsuarioRede').value = usuario.usuario;
  autoDetectarGeneroOnb(usuario.nome);
  // Casa o cargo (título do AD) com o catálogo já importado (mesma
  // normalização de espaço usada em scripts/importar-cargos-ad.js) —
  // se achar, já seleciona; se não achar (cargo novo/grafia diferente),
  // deixa em branco pra escolher/cadastrar na mão.
  if (usuario.cargo) {
    const alvo = usuario.cargo.trim().replace(/\s+/g, ' ').toUpperCase();
    const select = document.getElementById('novoOnbCargo');
    const opcao = [...select.options].find((o) => o.textContent.trim().toUpperCase() === alvo);
    if (opcao) select.value = opcao.value;
  }
}

// Pré-classifica o gênero pelo primeiro nome (2026-09-21) — "melhor
// esforço" de propósito: cobre a maioria dos nomes brasileiros comuns (a
// regra geral "termina em 'a' = feminino" já acerta boa parte), mais uma
// lista curada de exceções comuns que a regra geral erraria. Sempre é só
// um PALPITE inicial — o campo "Gênero" continua um <select> normal,
// editável antes de cadastrar (é exatamente o que foi pedido: prever, mas
// deixar corrigir).
const GENERO_EXCECOES_FEMININO = new Set([
  'yasmin', 'yasmim', 'karen', 'ingrid', 'isabel', 'raquel', 'esther', 'ester', 'noemi',
  'ruth', 'rute', 'miriam', 'myriam', 'eloah', 'nicoly', 'nicolly', 'kauany', 'kauane',
  'evelyn', 'evelin', 'marilyn', 'carmen', 'jaqueline', 'madison', 'jennifer', 'jennyfer',
  'heloisy', 'kamilly', 'emilly', 'nicolle', 'allany', 'thainy', 'sarah', 'hellen', 'helen',
]);
const GENERO_EXCECOES_MASCULINO = new Set(['luca', 'joshua', 'elisha', 'jonata']);

function preverGenero(nomeCompleto) {
  if (!nomeCompleto) return null;
  const primeiro = nomeCompleto
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!primeiro) return null;
  if (GENERO_EXCECOES_FEMININO.has(primeiro)) return 'f';
  if (GENERO_EXCECOES_MASCULINO.has(primeiro)) return 'm';
  return primeiro.endsWith('a') ? 'f' : 'm';
}

// Só pré-preenche se o campo ainda não tiver valor, ou se o valor atual
// também veio dessa mesma previsão (dataset.auto) — assim, se a pessoa já
// corrigiu à mão, digitar mais no nome não sobrescreve a escolha dela.
function autoDetectarGeneroOnb(nome, idSelect = 'novoOnbGenero') {
  const select = document.getElementById(idSelect);
  if (!select) return;
  if (select.value && select.dataset.auto !== 'true') return;
  const genero = preverGenero(nome);
  if (genero) {
    select.value = genero;
    select.dataset.auto = 'true';
  }
}

// Sugestão de usuário/senha por sistema (2026-09-21) — regra passada pelo
// usuário: o usuário normalmente segue o padrão do usuário de rede
// (primeironome.ultimonome, ex. "Ian de Lima Alves" -> "ian.alves"), com 3
// exceções:
// - Telehelp Sys / Telehelp Tools: limite de 15 caracteres — se o padrão
//   normal passar disso, usa a forma curta (1ª letra do primeiro nome +
//   último nome, ex. "ialves").
// - Agent Desktop / Workplace: o "usuário" ali é o ramal telefônico, não
//   dá pra prever a partir do nome — não sugere usuário, só a senha fixa
//   (sempre a mesma pros dois sistemas).
// Só é uma SUGESTÃO pré-preenchida no campo — sempre editável antes de
// salvar, igual o resto do formulário.
function classificarSistemaOnb(nomeSistema) {
  const n = (nomeSistema || '').toLowerCase();
  if (n.includes('agent desktop') || n.includes('agentdesktop')) return 'agent-desktop';
  if (n.includes('workplace')) return 'workplace';
  // Celular/Tablet (2026-09-21): dispositivo físico, não tem usuário, só a
  // senha padrão de desbloqueio (a mesma pra todo mundo).
  if (n.includes('celular') || n.includes('tablet')) return 'dispositivo';
  // Telehelp Web e Conta Microsoft (2026-09-21): a própria conta
  // Microsoft/e-mail corporativo — usuário é o e-mail, senha é a mesma da
  // rede (mesmo login, dois nomes diferentes na lista de sistemas).
  if (n.includes('telehelp web') || n.includes('telehelpweb') || n.includes('conta microsoft') || n.includes('contamicrosoft')) return 'conta-ms';
  // VPN (2026-09-21): usuário normal de rede, senha é a mesma senha de
  // rede/e-mail (mesma fórmula usada pra "Usuário de rede").
  if (n.includes('vpn')) return 'vpn';
  if (n.includes('sys') || n.includes('tools')) return 'sys-tools';
  return 'padrao';
}

function normalizarUsuario(s) {
  return (s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Palavrinhas de ligação que NÃO entram nas iniciais do nome (2026-09-21,
// padrão explicado pelo usuário: "Ian de Lima Alves" -> "ila", pula o
// "de") — mesma convenção comum de abreviar nome em português.
const CONECTORES_NOME = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);

function iniciaisNome(nomeCompleto) {
  return (nomeCompleto || '')
    .trim()
    .split(/\s+/)
    .filter((parte) => parte && !CONECTORES_NOME.has(normalizarUsuario(parte)))
    .map((parte) => normalizarUsuario(parte)[0] || '')
    .join('');
}

// Padrão de senha de rede passado pelo usuário (2026-09-21): "X@" + iniciais
// de todos os nomes (sem as palavrinhas de ligação) + "1234". Sincroniza pra
// Conta Microsoft/Telehelp Web e é a mesma usada na VPN — por isso as 4
// credenciais (rede, conta MS, Telehelp Web, VPN) sugerem a mesma senha.
function senhaRedeSugerida(colaborador) {
  const iniciais = iniciaisNome(colaborador.nome);
  return iniciais ? `X@${iniciais}1234` : '';
}

function sugerirCredencial(colaborador, credencial) {
  const partes = (colaborador.nome || '').trim().split(/\s+/).filter(Boolean);
  const primeiro = normalizarUsuario(partes[0]);
  const ultimo = normalizarUsuario(partes[partes.length - 1]);
  const padrao = primeiro && ultimo ? `${primeiro}.${ultimo}` : '';
  const curto = primeiro && ultimo ? `${primeiro[0]}${ultimo}` : '';
  // Usuário de rede real (vindo do AD, se já cadastrado) é mais confiável
  // que adivinhar pelo nome — usa ele como base quando existir.
  const usuarioRede = colaborador.usuario_rede ? normalizarUsuario(colaborador.usuario_rede) : padrao;
  const senhaRede = senhaRedeSugerida(colaborador);

  // Só o "Usuário de rede" (obrigatorioParaTodos) usa a sugestão genérica —
  // os "obrigatório para cargo externo" (Celular/Tablet/Conta Microsoft/
  // Telehelp Web/VPN) têm cada um sua própria regra abaixo, via
  // classificarSistemaOnb (2026-09-21, corrigido: antes os 5 caíam aqui por
  // engano e todos saíam com usuarioRede/senhaRede, ignorando as regras
  // específicas de cada um).
  if (credencial.obrigatorioParaTodos) return { usuario: usuarioRede, senha: senhaRede };
  const tipo = classificarSistemaOnb(credencial.sistemaNome);
  if (tipo === 'agent-desktop') return { usuario: '', senha: 'Th123456' };
  if (tipo === 'workplace') return { usuario: '', senha: '123456' };
  if (tipo === 'dispositivo') return { usuario: 'somente senha', senha: 'Telehelp@240' };
  if (tipo === 'conta-ms') return { usuario: colaborador.email || '', senha: senhaRede };
  if (tipo === 'vpn') return { usuario: usuarioRede, senha: senhaRede };
  if (tipo === 'sys-tools') return { usuario: usuarioRede.length > 15 ? curto : usuarioRede, senha: '' };
  return { usuario: usuarioRede, senha: '' };
}

async function salvarEdicaoColaboradorOnboarding(event, colaboradorId) {
  try {
    const cargoId = document.getElementById('editOnbCargo').value;
    await api(`/onboarding/colaboradores/${colaboradorId}`, {
      method: 'PATCH',
      body: {
        nome: document.getElementById('editOnbNome').value,
        cargoId: cargoId ? Number(cargoId) : null,
        gestor: document.getElementById('editOnbGestor').value || null,
        email: document.getElementById('editOnbEmail').value || null,
        genero: document.getElementById('editOnbGenero').value || null,
        departamento: document.getElementById('editOnbDepartamento').value || null,
        usuarioRede: document.getElementById('editOnbUsuarioRede').value || null,
      },
    });
    toast('Colaborador atualizado.');
    state.colaboradores.editandoColaborador = false;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function excluirColaboradorOnboarding(colaboradorId) {
  if (!confirm('Excluir esse colaborador e as credenciais dele? Não dá pra desfazer.')) return;
  try {
    await api(`/onboarding/colaboradores/${colaboradorId}`, { method: 'DELETE' });
    toast('Colaborador excluído.');
    state.colaboradores.colaboradorSelecionado = null;
    state.colaboradores.editandoColaborador = false;
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

async function salvarCredenciaisOnboarding(event, colaboradorId) {
  const usuarios = [...document.querySelectorAll('.credUsuario')];
  const itens = usuarios.map((el) => {
    const sistemaId = Number(el.dataset.sistemaId);
    const senhaEl = document.querySelector(`.credSenha[data-sistema-id="${sistemaId}"]`);
    const item = { sistemaId, usuario: el.value };
    if (senhaEl && senhaEl.value) item.senha = senhaEl.value; // vazio = mantém a senha já salva
    return item;
  });
  try {
    await api(`/onboarding/colaboradores/${colaboradorId}/credenciais`, { method: 'PUT', body: { itens } });
    toast('Credenciais salvas.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

function baixarFichaAcessos(colaboradorId) {
  window.open(`${API}/onboarding/colaboradores/${colaboradorId}/ficha`, '_blank');
}

async function enviarBoasVindas(colaboradorId) {
  if (!confirm('Enviar o e-mail de boas-vindas (com a ficha de acessos e os passo a passo em anexo) pra esse colaborador agora?')) return;
  try {
    const resp = await api(`/onboarding/colaboradores/${colaboradorId}/enviar-boas-vindas`, { method: 'POST' });
    toast(`E-mail enviado para: ${resp.enviadoPara.join(', ')}.${resp.copiaOculta && resp.copiaOculta.length ? ` Cópia oculta para: ${resp.copiaOculta.join(', ')}.` : ' ATENÇÃO: nenhuma cópia oculta foi registrada neste envio.'}`);
    if (resp.avisoLider) toast(resp.avisoLider, 'erro');
  } catch (e) { toast(e.message, 'erro'); }
}

async function enviarDocumentoOnboarding(tipo, event) {
  const arquivo = event.target.files[0];
  event.target.value = '';
  if (!arquivo) return;
  try {
    const dados = new FormData();
    dados.set('arquivo', arquivo);
    const resp = await fetch(`${API}/onboarding/documentos/${tipo}`, { method: 'POST', body: dados, credentials: 'same-origin' });
    const corpo = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((corpo && corpo.erro) || `Erro ${resp.status}`);
    toast('Documento enviado.');
    render();
  } catch (e) { toast(e.message, 'erro'); }
}

// --- Start ------------------------------------------------------------

(async function start() {
  let resposta;
  try {
    resposta = await api('/auth/eu'); // sempre 200 — { logado: false } ou { logado: true, id, nome, email }
  } catch (e) {
    document.getElementById('main').innerHTML = `<div class="card"><strong>Não consegui conectar na API.</strong> Confirme que o servidor está rodando (${esc(e.message)}).</div>`;
    return;
  }
  if (!resposta.logado) {
    // Não logado — comportamento normal, mostra a tela de login.
    state.view = 'login';
    render();
    return;
  }
  state.eu = resposta;
  try {
    await carregarReferencias();
  } catch (e) {
    document.getElementById('main').innerHTML = `<div class="card"><strong>Erro ao carregar dados iniciais:</strong> ${esc(e.message)}</div>`;
    return;
  }
  state.view = state.eu.papel === 'operador' ? 'meus-chamados' : 'chamados';
  render();
})();
