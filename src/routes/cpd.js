// Checklist do CPD — inspeção física diária (meta: todo dia útil), migrado
// do formulário Microsoft Forms "Checklist CPD" que a equipe já usava.
// Guarda histórico de cada rodada (uma linha por vez que alguém preenche o
// checklist inteiro) — pedido explícito, pra dar pra consultar rodadas
// passadas, diferente do resto do Estoque (que é "estado atual").
//
// Foto é obrigatória (mesmo campo do formulário original). Fica salva em
// dados/cpd-fotos/ com um nome gerado (UUID) — nunca o nome original do
// upload, pra não confiar em input de arquivo vindo do navegador na hora
// de montar um caminho no disco.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { enviarEmail } = require('../lib/email');
const { carregarFeriados } = require('../lib/diasUteis');
const { exigirPapel } = require('../lib/auth');

const FOTOS_DIR = path.join(__dirname, '..', '..', 'dados', 'cpd-fotos');
fs.mkdirSync(FOTOS_DIR, { recursive: true });

// "Abrir chamado na T1" (Targetway) a partir de um problema identificado no
// checklist do CPD — pedido explícito (2026-09-01). Sem API do Targetway
// disponível; a aposta é que o endereço abaixo cria um chamado a partir do
// email recebido (padrão comum em sistema de chamados) — NÃO CONFIRMADO
// ainda que funcione de fato, por isso o botão sempre mostra também o link
// do portal (TARGETWAY_PORTAL_URL) como conferência/alternativa manual.
const TARGETWAY_EMAIL_TO = process.env.TARGETWAY_EMAIL_TO || 'targetway@targetone.net.br';
const TARGETWAY_PORTAL_URL = 'https://targetway.com.br/Chamados/Acompanhamento';

// Só imagem, de propósito — o campo é "Foto no CPD", não "arquivo qualquer"
// (o formulário original aceitava Word/PDF/vídeo/áudio também, mas isso é
// superfície de ataque desnecessária pra um campo que na prática sempre
// recebe uma foto tirada na hora).
const TIPOS_ACEITOS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const TAMANHO_MAXIMO_BYTES = 15 * 1024 * 1024; // 15MB — folga confortável pra foto de celular

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FOTOS_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${TIPOS_ACEITOS[file.mimetype] || ''}`),
  }),
  limits: { fileSize: TAMANHO_MAXIMO_BYTES },
  fileFilter: (req, file, cb) => {
    if (!TIPOS_ACEITOS[file.mimetype]) {
      return cb(new Error('Formato de foto não suportado — envie JPEG, PNG, WEBP, GIF ou HEIC.'));
    }
    cb(null, true);
  },
});

// Dois turnos por dia (2026-10-01, pedido explícito) — turno é inferido
// pelo horário de ENVIO (criado_em), convertido pro horário de Brasília
// antes do corte, nunca pela hora UTC crua (senão o corte das 13h cai na
// hora errada dependendo de quando o processo rodar). A exigência de ter
// os 2 turnos pra contar como "dia completo" só vale a partir desta data —
// meses anteriores continuam na regra antiga (1 checklist = dia completo),
// pra não derrubar retroativamente a % de um período em que ninguém foi
// pedido pra fazer 2x por dia.
const CPD_TURNOS_DESDE = '2026-10-01';

function turnoDeExecucao(criadoEmIso) {
  const horaLocal = Number(
    new Date(criadoEmIso).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })
  );
  return horaLocal < 13 ? 'manha' : 'noite';
}

function cpdRouter(db) {
  const router = express.Router();

  router.get('/cpd/servidores', (req, res) => {
    res.json(db.prepare(`SELECT * FROM cpd_servidores WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all());
  });

  router.get('/cpd/receptoras', (req, res) => {
    res.json(db.prepare(`SELECT * FROM cpd_receptoras WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all());
  });

  // Cadastro de servidores/receptoras (2026-09-23) — antes só dava pra
  // mudar direto no banco por SQL. Mesmo padrão de "só cria/desativa, nunca
  // apaga de verdade" já usado em departamentos/categorias — desativar em
  // vez de excluir preserva o histórico de rodadas antigas que já
  // referenciam o item. Líder/Gestor only, mesmo gate de quem já corrige
  // registro de checklist.
  // camposExtras (2026-09-23, usado só por servidores/idracHost — ver aba
  // "Atualizações") mapeia { chaveNoBody: colunaNoBanco } pra campos que só
  // fazem sentido numa das duas tabelas, sem duplicar a rota inteira.
  function catalogoRouter(tabela, campoTabela, camposExtras = {}) {
    router.get(`/cpd/${campoTabela}/todos`, exigirPapel('lider', 'gestor'), (req, res) => {
      res.json(db.prepare(`SELECT * FROM ${tabela} ORDER BY ativo DESC, nome COLLATE NOCASE`).all());
    });
    router.post(`/cpd/${campoTabela}`, exigirPapel('lider', 'gestor'), (req, res) => {
      const { nome } = req.body;
      if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome.' });
      try {
        const info = db.prepare(`INSERT INTO ${tabela} (nome) VALUES (?)`).run(nome.trim());
        res.status(201).json(db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(info.lastInsertRowid));
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe um item com esse nome.' });
        throw e;
      }
    });
    router.patch(`/cpd/${campoTabela}/:id`, exigirPapel('lider', 'gestor'), (req, res) => {
      const existente = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(req.params.id);
      if (!existente) return res.status(404).json({ erro: 'Não encontrado.' });
      const campos = {};
      if (req.body.nome !== undefined) {
        if (!req.body.nome.trim()) return res.status(400).json({ erro: 'Nome não pode ficar vazio.' });
        campos.nome = req.body.nome.trim();
      }
      if (req.body.ativo !== undefined) campos.ativo = req.body.ativo ? 1 : 0;
      for (const [chaveBody, colunaDb] of Object.entries(camposExtras)) {
        if (req.body[chaveBody] !== undefined) campos[colunaDb] = (req.body[chaveBody] || '').trim() || null;
      }
      const colunas = Object.keys(campos);
      if (colunas.length) {
        try {
          db.prepare(`UPDATE ${tabela} SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
            .run(...colunas.map((c) => campos[c]), req.params.id);
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe um item com esse nome.' });
          throw e;
        }
      }
      res.json(db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(req.params.id));
    });
  }
  catalogoRouter('cpd_servidores', 'servidores', { idracHost: 'idrac_host', dcuHost: 'dcu_host' });
  catalogoRouter('cpd_receptoras', 'receptoras');

  // Métricas agregadas de um mês (extraído em 2026-09-17 pra ser
  // reaproveitado também em /cpd/tendencia, sem duplicar a conta de dias
  // úteis/feriados). anoMesStr = "AAAA-MM".
  function calcularMetricasMes(anoMesStr) {
    const hoje = new Date();
    const anoMesCorrente = hoje.toISOString().slice(0, 7);
    const ehMesCorrente = anoMesStr === anoMesCorrente;

    const feriados = carregarFeriados(db); // Set('AAAA-MM-DD') — feriado não conta como dia útil (2026-09-08)
    const [ano, mes] = anoMesStr.split('-').map(Number);
    const diasUteis = [];
    const cursor = new Date(Date.UTC(ano, mes - 1, 1));
    // Mês corrente: só até hoje (ainda não terminou). Mês passado: mês
    // inteiro (já terminou, não faz sentido "dias úteis até hoje" nele).
    const limite = ehMesCorrente
      ? new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()))
      : new Date(Date.UTC(ano, mes, 0)); // último dia do mês pedido
    while (cursor <= limite) {
      const diaSemana = cursor.getUTCDay(); // 0 = domingo, 6 = sábado
      const dataStr = cursor.toISOString().slice(0, 10);
      if (diaSemana !== 0 && diaSemana !== 6 && !feriados.has(dataStr)) diasUteis.push(dataStr);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const execucoesMes = db
      .prepare(
        `SELECT id, data_registro, ar_condicionado_problema, criado_em
         FROM cpd_checklist_execucoes WHERE data_registro LIKE ?`
      )
      .all(`${anoMesStr}%`);

    // Dois turnos por dia (2026-10-01, ver CPD_TURNOS_DESDE) — dia
    // >= CPD_TURNOS_DESDE só é "completo" com manhã E noite; antes disso,
    // qualquer execução no dia já bastava (regra antiga preservada pro
    // histórico, não é justo reavaliar um período em que só se pedia 1x/dia).
    const turnosPorDia = new Map(); // data_registro -> Set('manha'|'noite')
    const diasComChecklistAntigo = new Set(); // só pra dias < CPD_TURNOS_DESDE
    for (const e of execucoesMes) {
      if (e.data_registro >= CPD_TURNOS_DESDE) {
        if (!turnosPorDia.has(e.data_registro)) turnosPorDia.set(e.data_registro, new Set());
        turnosPorDia.get(e.data_registro).add(turnoDeExecucao(e.criado_em));
      } else {
        diasComChecklistAntigo.add(e.data_registro);
      }
    }
    const diasCompletos = diasUteis.filter((d) =>
      d >= CPD_TURNOS_DESDE ? (turnosPorDia.get(d) || new Set()).size === 2 : diasComChecklistAntigo.has(d)
    );
    const diasParciais = diasUteis.filter((d) => d >= CPD_TURNOS_DESDE && (turnosPorDia.get(d) || new Set()).size === 1);
    const diasFaltantes = diasUteis.filter((d) =>
      d >= CPD_TURNOS_DESDE ? !turnosPorDia.has(d) : !diasComChecklistAntigo.has(d)
    );
    const cumpridos = diasCompletos.length;
    const percentual = diasUteis.length ? Math.round((cumpridos / diasUteis.length) * 100) : 100;

    // Saúde (2026-09-23, corrigido): marcar um item sem escrever nada é só
    // "revisei, tudo ok" — não pesa. O que conta como alerta é ter pelo
    // menos um item com COMENTÁRIO preenchido naquela rodada (servidor ou
    // receptora), contado por RODADA (não por comentário individual, pra
    // não pesar mais só porque teve 3 itens comentados no mesmo dia).
    // Registro antigo (migrado, sem linha na tabela de junção com
    // comentário) fica fora dessa conta — não tinha esse dado pra avaliar.
    const idsExecucoes = execucoesMes.map((e) => e.id);
    const contarExecucoesComComentario = (tabela) => {
      if (!idsExecucoes.length) return 0;
      const linhas = db
        .prepare(
          `SELECT DISTINCT execucao_id FROM ${tabela}
           WHERE comentario IS NOT NULL AND TRIM(comentario) != ''
           AND execucao_id IN (${idsExecucoes.map(() => '?').join(',')})`
        )
        .all(...idsExecucoes);
      return linhas.length;
    };
    const naoServidoresMes = contarExecucoesComComentario('cpd_checklist_servidores_verificados');
    const naoReceptorasMes = contarExecucoesComComentario('cpd_checklist_receptoras_verificadas');
    const naoArCondicionadoMes = execucoesMes.filter((e) => e.ar_condicionado_problema === 1).length;
    const totalAlertas = naoServidoresMes + naoReceptorasMes + naoArCondicionadoMes;
    const saude = totalAlertas === 0 ? 'ok' : totalAlertas <= 2 ? 'atencao' : 'critico';

    return {
      mes: anoMesStr,
      diasUteisAteHoje: diasUteis.length,
      diasComChecklist: cumpridos,
      diasFaltantes,
      diasParciais,
      percentual,
      totalChecklistsMes: execucoesMes.length,
      naoServidoresMes,
      naoReceptorasMes,
      naoArCondicionadoMes,
      totalAlertas,
      saude,
    };
  }

  // Tendência de vários meses (2026-09-17) — pro gráfico de "saúde ao longo
  // do tempo" no dashboard, em vez de só um mês por vez. ?meses=N (padrão
  // 6), do mais antigo pro mais recente (ordem que um gráfico espera).
  router.get('/cpd/tendencia', (req, res) => {
    const n = Math.min(Math.max(parseInt(req.query.meses, 10) || 6, 1), 24);
    const hoje = new Date();
    const meses = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1));
      meses.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    res.json(meses.map((m) => calcularMetricasMes(m)));
  });

  // Dashboard: quanto da meta "todo dia útil" foi cumprida no mês (por
  // padrão o corrente, mas aceita ?mes=AAAA-MM pra ver um mês passado — o
  // histórico bruto já dava pra consultar registro a registro, isso aqui é
  // a mesma visão agregada/"saúde" de qualquer mês, não só o de agora), e
  // um retrato de "saúde do CPD" a partir dos comentários mais recentes —
  // os comentários carregam o sinal de verdade (ex.: "temperatura elevada
  // no rack" registrado mesmo com a pergunta respondida "Sim"), não só o
  // Sim/Não em si.
  router.get('/cpd/resumo', (req, res) => {
    const anoMesCorrente = new Date().toISOString().slice(0, 7);
    const mesValido = /^\d{4}-\d{2}$/.test(req.query.mes || '');
    const anoMesStr = mesValido ? req.query.mes : anoMesCorrente; // "AAAA-MM"
    const metricas = calcularMetricasMes(anoMesStr);

    // Comentários mais recentes (não vazios), de qualquer mês — é o feed
    // de observações de verdade, não só o mês corrente. Junta 2 fontes
    // (2026-09-23): comentário legado por seção (registro antigo, migrado
    // do Forms) e comentário por item / ar-condicionado novo (registro
    // atual) — ordenado por data de criação, mais recente primeiro.
    const recentes = db
      .prepare(
        `SELECT e.id, e.data_registro, e.servidores_verificado, e.servidores_comentario,
                e.receptoras_verificado, e.receptoras_comentario,
                e.ar_condicionado_verificado, e.ar_condicionado_comentario,
                e.ar_condicionado_problema, e.ar_condicionado_problema_comentario, e.criado_em,
                a.nome AS atendente_nome
         FROM cpd_checklist_execucoes e
         JOIN atendentes a ON a.id = e.atendente_id
         ORDER BY e.criado_em DESC
         LIMIT 60`
      )
      .all();

    const comentarios = [];
    for (const e of recentes) {
      if (e.servidores_comentario) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: 'Servidores', verificado: !!e.servidores_verificado, texto: e.servidores_comentario, atendente: e.atendente_nome });
      }
      if (e.receptoras_comentario) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: 'Receptoras', verificado: !!e.receptoras_verificado, texto: e.receptoras_comentario, atendente: e.atendente_nome });
      }
      if (e.ar_condicionado_comentario) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: 'Ar-condicionado', verificado: !!e.ar_condicionado_verificado, texto: e.ar_condicionado_comentario, atendente: e.atendente_nome });
      }
      if (e.ar_condicionado_problema_comentario) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: 'Ar-condicionado', verificado: !e.ar_condicionado_problema, texto: e.ar_condicionado_problema_comentario, atendente: e.atendente_nome });
      }
      const itensServidor = db
        .prepare(`SELECT s.nome, v.comentario FROM cpd_checklist_servidores_verificados v JOIN cpd_servidores s ON s.id = v.servidor_id WHERE v.execucao_id = ? AND v.comentario IS NOT NULL AND TRIM(v.comentario) != ''`)
        .all(e.id);
      for (const item of itensServidor) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: `Servidor — ${item.nome}`, verificado: false, texto: item.comentario, atendente: e.atendente_nome });
      }
      const itensReceptora = db
        .prepare(`SELECT r.nome, v.comentario FROM cpd_checklist_receptoras_verificadas v JOIN cpd_receptoras r ON r.id = v.receptora_id WHERE v.execucao_id = ? AND v.comentario IS NOT NULL AND TRIM(v.comentario) != ''`)
        .all(e.id);
      for (const item of itensReceptora) {
        comentarios.push({ data: e.data_registro, criadoEm: e.criado_em, categoria: `Receptora — ${item.nome}`, verificado: false, texto: item.comentario, atendente: e.atendente_nome });
      }
    }
    comentarios.sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));

    res.json({
      geradoEm: new Date().toISOString(),
      ...metricas,
      comentarios: comentarios.slice(0, 15),
    });
  });

  router.get('/cpd/checklist', (req, res) => {
    const linhas = db
      .prepare(
        `SELECT e.*, a.nome AS atendente_nome
         FROM cpd_checklist_execucoes e
         JOIN atendentes a ON a.id = e.atendente_id
         ORDER BY e.data_registro DESC, e.criado_em DESC`
      )
      .all();

    const vinculos = db
      .prepare(
        `SELECT v.execucao_id, s.nome
         FROM cpd_checklist_servidores_verificados v
         JOIN cpd_servidores s ON s.id = v.servidor_id`
      )
      .all();
    const servidoresPorExecucao = new Map();
    for (const v of vinculos) {
      if (!servidoresPorExecucao.has(v.execucao_id)) servidoresPorExecucao.set(v.execucao_id, []);
      servidoresPorExecucao.get(v.execucao_id).push(v.nome);
    }

    // "observacoes" (2026-09-23) = quantos itens (servidor/receptora) com
    // comentário + o ar-condicionado com problema — pra coluna nova do
    // Histórico. Registro antigo (sem nada nas tabelas de junção nem
    // ar_condicionado_problema) fica com observacoes=null, sinal pro front
    // mostrar o formato Sim/Não legado em vez do badge novo.
    const comentariosServidor = db
      .prepare(`SELECT execucao_id, COUNT(*) AS n FROM cpd_checklist_servidores_verificados WHERE comentario IS NOT NULL AND TRIM(comentario) != '' GROUP BY execucao_id`)
      .all();
    const comentariosReceptora = db
      .prepare(`SELECT execucao_id, COUNT(*) AS n FROM cpd_checklist_receptoras_verificadas WHERE comentario IS NOT NULL AND TRIM(comentario) != '' GROUP BY execucao_id`)
      .all();
    const nPorExecucao = new Map();
    for (const r of [...comentariosServidor, ...comentariosReceptora]) {
      nPorExecucao.set(r.execucao_id, (nPorExecucao.get(r.execucao_id) || 0) + r.n);
    }

    res.json(
      linhas.map((e) => {
        const ehRegistroNovo = e.ar_condicionado_problema !== null && e.ar_condicionado_problema !== undefined;
        const observacoes = ehRegistroNovo ? (nPorExecucao.get(e.id) || 0) + (e.ar_condicionado_problema ? 1 : 0) : null;
        const turno = e.data_registro >= CPD_TURNOS_DESDE ? turnoDeExecucao(e.criado_em) : null;
        return { ...e, servidores: servidoresPorExecucao.get(e.id) || [], observacoes, turno };
      })
    );
  });

  // Sondagem pro indicador "checklist de hoje já foi feito?" na tela — tem
  // que vir ANTES de /cpd/checklist/:id, senão "hoje" seria capturado como
  // se fosse um :id.
  router.get('/cpd/checklist/hoje', (req, res) => {
    const hoje = new Date().toISOString().slice(0, 10);
    const execucoesHoje = db.prepare(`SELECT id, criado_em FROM cpd_checklist_execucoes WHERE data_registro = ?`).all(hoje);
    const porTurno = { manha: null, noite: null };
    for (const e of execucoesHoje) {
      const turno = turnoDeExecucao(e.criado_em);
      if (!porTurno[turno]) porTurno[turno] = e.id; // mantém o primeiro — se repetir no mesmo turno, continua "feito"
    }
    res.json({
      data: hoje,
      manha: { feito: !!porTurno.manha, execucaoId: porTurno.manha },
      noite: { feito: !!porTurno.noite, execucaoId: porTurno.noite },
    });
  });

  router.get('/cpd/checklist/:id', (req, res) => {
    const execucao = db
      .prepare(
        `SELECT e.*, a.nome AS atendente_nome
         FROM cpd_checklist_execucoes e
         JOIN atendentes a ON a.id = e.atendente_id
         WHERE e.id = ?`
      )
      .get(req.params.id);
    if (!execucao) return res.status(404).json({ erro: 'Registro não encontrado.' });

    const servidores = db
      .prepare(
        `SELECT s.id, s.nome, v.comentario
         FROM cpd_checklist_servidores_verificados v
         JOIN cpd_servidores s ON s.id = v.servidor_id
         WHERE v.execucao_id = ?
         ORDER BY s.nome COLLATE NOCASE`
      )
      .all(req.params.id);

    const receptoras = db
      .prepare(
        `SELECT r.id, r.nome, v.comentario
         FROM cpd_checklist_receptoras_verificadas v
         JOIN cpd_receptoras r ON r.id = v.receptora_id
         WHERE v.execucao_id = ?
         ORDER BY r.nome COLLATE NOCASE`
      )
      .all(req.params.id);

    res.json({ ...execucao, servidores, receptoras });
  });

  // Corrigir uma rodada já registrada (2026-09-17) — ex.: marcou "Não" sem
  // querer, ou preencheu depois da meia-noite e a data caiu no dia errado.
  // Líder/Gestor only (correção de histórico é ação supervisionada, mesmo
  // espírito do resto da plataforma). Não mexe na foto — reenviar foto
  // continua sendo um caso raro o bastante pra não valer a complexidade
  // aqui; se precisar, é ajuste direto no banco como sempre foi.
  router.patch('/cpd/checklist/:id', exigirPapel('lider', 'gestor'), (req, res) => {
    const existente = db.prepare(`SELECT * FROM cpd_checklist_execucoes WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Registro não encontrado.' });

    const campos = {};
    if (req.body.dataRegistro !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.dataRegistro)) {
        return res.status(400).json({ erro: 'dataRegistro inválida — use AAAA-MM-DD.' });
      }
      campos.data_registro = req.body.dataRegistro;
    }
    // ar_condicionado_problema (2026-09-23) — pergunta nova; registro antigo
    // continua editável pelas colunas legadas (servidoresVerificado etc.)
    // por compatibilidade, embora a tela nova só mande as novas.
    if (req.body.arCondicionadoProblema !== undefined) campos.ar_condicionado_problema = req.body.arCondicionadoProblema ? 1 : 0;
    if (req.body.arCondicionadoProblemaComentario !== undefined) campos.ar_condicionado_problema_comentario = req.body.arCondicionadoProblemaComentario || null;
    for (const prefixo of ['servidores', 'receptoras', 'ar_condicionado']) {
      const chaveVerificado = prefixo === 'ar_condicionado' ? 'arCondicionadoVerificado' : `${prefixo}Verificado`;
      const chaveComentario = prefixo === 'ar_condicionado' ? 'arCondicionadoComentario' : `${prefixo}Comentario`;
      if (req.body[chaveVerificado] !== undefined) campos[`${prefixo}_verificado`] = req.body[chaveVerificado] ? 1 : 0;
      if (req.body[chaveComentario] !== undefined) campos[`${prefixo}_comentario`] = req.body[chaveComentario] || null;
    }

    const colunas = Object.keys(campos);
    if (colunas.length) {
      db.prepare(`UPDATE cpd_checklist_execucoes SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...colunas.map((c) => campos[c]), req.params.id);
    }

    // Edita o comentário de itens JÁ marcados (não adiciona/remove quais
    // itens foram marcados — pra isso, apaga e cadastra de novo, mesma
    // limitação de sempre). Corpo: { servidoresComentarios: {"<id>": "texto"}, receptorasComentarios: {...} }.
    if (req.body.servidoresComentarios && typeof req.body.servidoresComentarios === 'object') {
      const atualizar = db.prepare(`UPDATE cpd_checklist_servidores_verificados SET comentario = ? WHERE execucao_id = ? AND servidor_id = ?`);
      for (const [servidorId, comentario] of Object.entries(req.body.servidoresComentarios)) {
        atualizar.run(comentario || null, req.params.id, Number(servidorId));
      }
    }
    if (req.body.receptorasComentarios && typeof req.body.receptorasComentarios === 'object') {
      const atualizar = db.prepare(`UPDATE cpd_checklist_receptoras_verificadas SET comentario = ? WHERE execucao_id = ? AND receptora_id = ?`);
      for (const [receptoraId, comentario] of Object.entries(req.body.receptorasComentarios)) {
        atualizar.run(comentario || null, req.params.id, Number(receptoraId));
      }
    }

    res.json(db.prepare(`SELECT * FROM cpd_checklist_execucoes WHERE id = ?`).get(req.params.id));
  });

  router.post('/cpd/checklist', (req, res, next) => {
    upload.single('foto')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ erro: `Foto muito grande (máximo ${TAMANHO_MAXIMO_BYTES / 1024 / 1024}MB).` });
      }
      res.status(400).json({ erro: err.message });
    });
  }, (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erro: 'Envie uma foto do CPD.' });
    }

    const limpar = () => fs.unlink(req.file.path, () => {}); // não deixa arquivo órfão se o resto do corpo for inválido

    const { dataRegistro, arCondicionadoProblema, arCondicionadoProblemaComentario } = req.body;

    if (!dataRegistro || arCondicionadoProblema === undefined) {
      limpar();
      return res.status(400).json({ erro: 'Informe a data e responda a pergunta do ar-condicionado.' });
    }
    if (arCondicionadoProblema === 'true' && !(arCondicionadoProblemaComentario || '').trim()) {
      limpar();
      return res.status(400).json({ erro: 'Descreva o problema encontrado no ar-condicionado no comentário.' });
    }

    // servidoresItens/receptorasItens (2026-09-23): [{ id, comentario }],
    // só os itens marcados — sem exigir Sim/Não de seção, o comentário por
    // item é que carrega o sinal de "achei algo" (ver calcularMetricasMes).
    let servidoresItens;
    let receptorasItens;
    try {
      servidoresItens = JSON.parse(req.body.servidoresItens || '[]');
      receptorasItens = JSON.parse(req.body.receptorasItens || '[]');
    } catch (e) {
      limpar();
      return res.status(400).json({ erro: 'Lista de servidores/receptoras inválida.' });
    }

    // servidores_verificado/receptoras_verificado (colunas legadas, NOT
    // NULL) gravam se a seção teve pelo menos um item marcado — ver
    // comentário em prisma/schema.sql.
    const info = db
      .prepare(
        `INSERT INTO cpd_checklist_execucoes
           (atendente_id, data_registro, servidores_verificado, receptoras_verificado,
            ar_condicionado_verificado, ar_condicionado_problema, ar_condicionado_problema_comentario,
            foto_arquivo, foto_nome_original, foto_tipo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.atendente.id,
        dataRegistro,
        servidoresItens.length ? 1 : 0,
        receptorasItens.length ? 1 : 0,
        1, // ar_condicionado_verificado legado: respondeu a pergunta nova = "verificou"
        arCondicionadoProblema === 'true' ? 1 : 0,
        arCondicionadoProblemaComentario || null,
        req.file.filename,
        req.file.originalname,
        req.file.mimetype
      );

    const vincularServidor = db.prepare(
      `INSERT OR IGNORE INTO cpd_checklist_servidores_verificados (execucao_id, servidor_id, comentario) VALUES (?, ?, ?)`
    );
    for (const item of servidoresItens) {
      vincularServidor.run(info.lastInsertRowid, Number(item.id), item.comentario || null);
    }
    const vincularReceptora = db.prepare(
      `INSERT OR IGNORE INTO cpd_checklist_receptoras_verificadas (execucao_id, receptora_id, comentario) VALUES (?, ?, ?)`
    );
    for (const item of receptorasItens) {
      vincularReceptora.run(info.lastInsertRowid, Number(item.id), item.comentario || null);
    }

    res.status(201).json({ id: info.lastInsertRowid });
  });

  // Manda um email pro Targetway (aposta de que isso abre um chamado lá —
  // ver comentário no topo do arquivo) e devolve o link do portal junto,
  // pra quem chamou conferir manualmente se o chamado foi criado de
  // verdade. Não grava nada no banco — é só um disparo, não um registro.
  router.post('/cpd/abrir-chamado-t1', async (req, res) => {
    const { assunto, descricao } = req.body;
    if (!assunto || !descricao) {
      return res.status(400).json({ erro: 'Informe o assunto e a descrição do problema.' });
    }
    try {
      await enviarEmail({
        destinatarios: [TARGETWAY_EMAIL_TO],
        assunto: `[CPD] ${assunto}`,
        texto: descricao,
        html: `<p>${String(descricao).replace(/\n/g, '<br>')}</p>`,
      });
      res.json({ ok: true, enviadoPara: TARGETWAY_EMAIL_TO, portalUrl: TARGETWAY_PORTAL_URL });
    } catch (e) {
      res.status(502).json({ erro: `Não consegui enviar o email pro Targetway: ${e.message}`, portalUrl: TARGETWAY_PORTAL_URL });
    }
  });

  router.get('/cpd/checklist/:id/foto', (req, res) => {
    const execucao = db.prepare(`SELECT foto_arquivo, foto_tipo FROM cpd_checklist_execucoes WHERE id = ?`).get(req.params.id);
    if (!execucao) return res.status(404).json({ erro: 'Registro não encontrado.' });
    if (!execucao.foto_arquivo) {
      // Registro migrado do Forms antigo, sem arquivo local — a foto ficou
      // num SharePoint que exige login (ver foto_url_externa no registro).
      return res.status(404).json({ erro: 'Este registro não tem foto local — veja foto_url_externa.' });
    }
    const caminho = path.join(FOTOS_DIR, execucao.foto_arquivo);
    if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Foto não encontrada no servidor.' });
    res.setHeader('Content-Type', execucao.foto_tipo || 'application/octet-stream');
    res.sendFile(caminho);
  });

  return router;
}

module.exports = { cpdRouter };
