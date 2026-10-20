// Lê a Lista do SharePoint "ChamadosTeams" (alimentada pelo Fluxo do Power
// Automate que posta o cartão adaptável no Teams — ver README, seção
// "Integração com Teams") e cria um chamado de verdade nesta plataforma
// pra cada item ainda não processado.
//
// Por que sondagem em vez de tempo real: o Power Automate do plano
// gratuito não consegue chamar nossa API direto (ação HTTP é Premium — ver
// decisão em 2026-09-02), então o Fluxo só grava na Lista; é este script
// que efetivamente cria o chamado.
//
// Dois jeitos de rodar:
//   node scripts/importar-chamados-teams.js            (uma vez só, sai)
//   node scripts/importar-chamados-teams.js --daemon    (fica rodando pra
//     sempre, checando a cada TEAMS_SONDAGEM_INTERVALO_MS — padrão 10s;
//     ver deploy/central-infraestrutura-teams.service)
// O modo --daemon existe pra ficar bem mais perto de tempo real do que
// cron permitiria (cron não agenda com menos de 1 minuto de intervalo).
//
// Usa o MESMO App Registration já configurado pro email (GRAPH_TENANT_ID/
// GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET no .env) — precisa da permissão de
// aplicativo adicional Sites.Read.Write.All (consentida separadamente, ver
// README).
//
// Item malformado (categoria/departamento inválido, por exemplo) não é
// marcado como processado — o erro fica só no log, e o script tenta de
// novo na próxima rodada (não trava os outros itens da lista).

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { criarChamado } = require('../src/routes/chamados');

const HOSTNAME = process.env.TEAMS_SHAREPOINT_HOSTNAME;
const SITE_PATH = process.env.TEAMS_SHAREPOINT_SITE_PATH;
const LISTA = process.env.TEAMS_SHAREPOINT_LISTA || 'ChamadosTeams';
const INTERVALO_MS = Number(process.env.TEAMS_SONDAGEM_INTERVALO_MS) || 10_000;

// Cache do token e dos IDs de site/lista entre rodadas do --daemon — evita
// pedir token novo e re-resolver site/lista a cada 10s (Graph API tem
// limite de requisições; token client_credentials já dura ~1h sozinho).
let tokenCache = null; // { valor, expiraEm }
let siteListaCache = null; // { siteId, listaId }

async function obterToken() {
  if (tokenCache && Date.now() < tokenCache.expiraEm) return tokenCache.valor;
  const resp = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error(`Falha ao autenticar no Entra ID: ${dados.error_description || dados.error || resp.status}`);
  // Renova 5 min antes de expirar de verdade, de folga.
  tokenCache = { valor: dados.access_token, expiraEm: Date.now() + (dados.expires_in - 300) * 1000 };
  return dados.access_token;
}

async function graphGet(token, caminho) {
  const resp = await fetch(`https://graph.microsoft.com/v1.0${caminho}`, { headers: { Authorization: `Bearer ${token}` } });
  const dados = await resp.json();
  if (!resp.ok) throw new Error(`Graph API GET ${caminho}: ${dados.error?.message || resp.status}`);
  return dados;
}

async function graphPatch(token, caminho, corpo) {
  const resp = await fetch(`https://graph.microsoft.com/v1.0${caminho}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!resp.ok) {
    const dados = await resp.json().catch(() => ({}));
    throw new Error(`Graph API PATCH ${caminho}: ${dados.error?.message || resp.status}`);
  }
}

async function resolverSiteLista(token) {
  if (siteListaCache) return siteListaCache;
  const site = await graphGet(token, `/sites/${HOSTNAME}:${SITE_PATH}`);
  const listas = await graphGet(token, `/sites/${site.id}/lists?$filter=displayName eq '${LISTA}'`);
  const lista = listas.value[0];
  if (!lista) throw new Error(`Lista "${LISTA}" não encontrada no site.`);
  siteListaCache = { siteId: site.id, listaId: lista.id };
  return siteListaCache;
}

async function importarUmaVez() {
  const token = await obterToken();
  const { siteId, listaId } = await resolverSiteLista(token);

  // Busca tudo e filtra no código (em vez de $filter na consulta) — campo
  // não-indexado no SharePoint dá erro/instabilidade em filtro server-side.
  const itens = await graphGet(token, `/sites/${siteId}/lists/${listaId}/items?expand=fields`);
  const pendentes = itens.value.filter((item) => !item.fields.Processado);

  if (!pendentes.length) return 0;

  let criados = 0;
  for (const item of pendentes) {
    const f = item.fields;
    try {
      const chamado = criarChamado(db, {
        assunto: f.Title,
        descricao: f.Descricao,
        departamentoId: Number(f.DepartamentoId),
        categoriaId: Number(f.CategoriaId),
        prioridade: f.Prioridade,
        solicitante: { nome: f.SolicitanteNome, email: f.SolicitanteEmail },
      });
      await graphPatch(token, `/sites/${siteId}/lists/${listaId}/items/${item.id}/fields`, { Processado: true });
      console.log(`Chamado ${chamado.protocolo} criado a partir do item ${item.id} (Teams).`);
      criados += 1;
    } catch (e) {
      console.error(`Item ${item.id} não processado (fica pra próxima rodada): ${e.message}`);
    }
  }
  return criados;
}

(async () => {
  if (!HOSTNAME || !SITE_PATH) {
    console.error('TEAMS_SHAREPOINT_HOSTNAME/TEAMS_SHAREPOINT_SITE_PATH não configurados no .env — nada a fazer.');
    return;
  }

  const daemon = process.argv.includes('--daemon');

  if (!daemon) {
    try {
      const criados = await importarUmaVez();
      if (!criados) console.log('Nenhum chamado novo pra importar do Teams.');
    } catch (e) {
      console.error('Falha ao importar chamados do Teams:', e.message);
      process.exit(1);
    }
    return;
  }

  console.log(`Modo --daemon: checando a Lista do Teams a cada ${INTERVALO_MS / 1000}s. Ctrl+C ou systemctl stop pra parar.`);
  // Loop com setTimeout recursivo (não setInterval) — evita empilhar
  // rodadas se uma demorar mais que o intervalo (ex.: Graph API lenta).
  const loop = async () => {
    try {
      await importarUmaVez();
    } catch (e) {
      console.error('Falha numa rodada de sondagem (tenta de novo na próxima):', e.message);
    }
    setTimeout(loop, INTERVALO_MS);
  };
  loop();
})();
