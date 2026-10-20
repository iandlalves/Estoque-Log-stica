// Alertas do Acronis Cyber Protect (segurança dos dispositivos
// corporativos, não backup) — aba "Segurança" (2026-09-30).
//
// Autenticação confirmada na documentação oficial (developer.acronis.com):
// POST {datacenter_url}/api/2/idp/token, Basic base64(client_id:client_secret),
// grant_type=client_credentials (form-urlencoded) — resposta
// { access_token, token_type: "bearer", expires_on (epoch segundos), id_token }.
//
// Listagem de alertas (GET /api/alert_manager/v1/alerts) também confirmada
// na documentação — por padrão só devolve alertas ativos (não dispensados).
// MAS a paginação (nome exato do campo de cursor) e o campo que identifica
// o dispositivo afetado dentro de details.fields NÃO foram testados contra
// a API de verdade ainda (sem credencial disponível até agora) — código
// defensivo: para de paginar se não reconhecer o formato do cursor, em vez
// de arriscar loop infinito. Validar de verdade assim que houver
// ACRONIS_CLIENT_ID/SECRET reais (mesmo processo usado pra achar o fluxo
// certo da comparação de firmware Dell, ver src/lib/idrac.js).

let tokenCache = null; // { accessToken, expiraEm (epoch ms), datacenterUrl }

function credenciaisAcronis() {
  const clientId = process.env.ACRONIS_CLIENT_ID;
  const clientSecret = process.env.ACRONIS_CLIENT_SECRET;
  const datacenterUrl = process.env.ACRONIS_DATACENTER_URL;
  if (!clientId || !clientSecret || !datacenterUrl) {
    throw new Error('ACRONIS_CLIENT_ID/ACRONIS_CLIENT_SECRET/ACRONIS_DATACENTER_URL não configurados (ver .env.example).');
  }
  return { clientId, clientSecret, datacenterUrl: datacenterUrl.replace(/\/$/, '') };
}

async function autenticar() {
  if (tokenCache && tokenCache.expiraEm > Date.now() + 30000) return tokenCache;

  const { clientId, clientSecret, datacenterUrl } = credenciaisAcronis();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(`${datacenterUrl}/api/2/idp/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => '');
    throw new Error(`Acronis recusou a autenticação (status ${resp.status}).${texto ? ` Detalhe: ${texto}` : ''}`);
  }
  const dados = await resp.json();
  tokenCache = { accessToken: dados.access_token, expiraEm: dados.expires_on * 1000, datacenterUrl };
  return tokenCache;
}

async function buscarAlertasAtivos() {
  const { accessToken, datacenterUrl } = await autenticar();
  const alertas = [];
  let caminho = '/api/alert_manager/v1/alerts?limit=100';
  let paginasRestantes = 50; // trava de segurança — nunca gira pra sempre se o cursor vier num formato que eu não reconheço

  while (caminho && paginasRestantes > 0) {
    paginasRestantes--;
    const resp = await fetch(`${datacenterUrl}${caminho}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`Acronis respondeu ${resp.status} ao listar alertas.${texto ? ` Detalhe: ${texto}` : ''}`);
    }
    const dados = await resp.json();
    alertas.push(...(dados.items || []));
    const proximoCursor = dados.paging && dados.paging.cursor && dados.paging.cursor.next;
    caminho = proximoCursor ? `/api/alert_manager/v1/alerts?limit=100&cursor=${encodeURIComponent(proximoCursor)}` : null;
  }
  return alertas;
}

// "resolvido_em" NÃO vem da API (campo exato de "dispensado" não
// confirmado) — é inferido: alerta visto numa sincronização anterior que
// não aparece mais na lista de ativos agora vira resolvido por nós. Ver
// comentário em prisma/schema.sql.
async function sincronizarAlertas(db) {
  const alertas = await buscarAlertasAtivos();
  const agora = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO acronis_alertas (id, tipo, categoria, severidade, titulo, descricao, detalhes_json, criado_em_acronis, visto_pela_ultima_vez, resolvido_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      tipo = excluded.tipo,
      categoria = excluded.categoria,
      severidade = excluded.severidade,
      titulo = excluded.titulo,
      descricao = excluded.descricao,
      detalhes_json = excluded.detalhes_json,
      criado_em_acronis = excluded.criado_em_acronis,
      visto_pela_ultima_vez = excluded.visto_pela_ultima_vez,
      resolvido_em = NULL
  `);

  const idsVistos = new Set();
  for (const a of alertas) {
    idsVistos.add(a.id);
    upsert.run(
      a.id,
      a.type || null,
      a.category || null,
      a.severity || null,
      (a.details && a.details.title) || null,
      (a.details && a.details.description) || null,
      JSON.stringify((a.details && a.details.fields) || {}),
      a.createdAt || null,
      agora
    );
  }

  const naoResolvidos = db.prepare(`SELECT id FROM acronis_alertas WHERE resolvido_em IS NULL`).all();
  const marcarResolvido = db.prepare(`UPDATE acronis_alertas SET resolvido_em = ? WHERE id = ?`);
  let resolvidosAgora = 0;
  for (const row of naoResolvidos) {
    if (!idsVistos.has(row.id)) {
      marcarResolvido.run(agora, row.id);
      resolvidosAgora++;
    }
  }

  return { total: alertas.length, resolvidosAgora };
}

module.exports = { buscarAlertasAtivos, sincronizarAlertas };
