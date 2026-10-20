// Onboarding de acessos (aba "Colaboradores" na UI, 2026-09-18) — catálogo
// de cargo×sistemas, credenciais por colaborador/sistema (senha sempre
// cifrada, ver src/lib/credenciaisCrypto.js), geração da Ficha de Acessos
// em PDF e envio do e-mail de boas-vindas com os anexos certos conforme o
// cargo. Router inteiro gated em exigirPapel('atendente') no server.js —
// nem Líder nem Gestor têm acesso aqui, decisão explícita do usuário
// (mesmo padrão já usado na Base de Conhecimento).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { gerarPdfFichaAcessos } = require('../lib/termoPdf');
const { criptografar, descriptografar, chaveConfigurada } = require('../lib/credenciaisCrypto');
const { enviarEmail } = require('../lib/email');
const { buscarUsuariosAD, ldapConfigurado } = require('../lib/ldap');

function gerarId() {
  return crypto.randomUUID();
}

// Assinatura embutida no corpo do e-mail de boas-vindas (2026-09-18) —
// modelo tirado dos e-mails reais que o usuário mandou (mesmos ícones que
// ele exportou da própria assinatura da empresa). Logo + ícones ficam em
// src/lib/assets/ e src/lib/assets/assinatura/, mandados como anexo
// "inline" (isInline no Graph, referenciado no HTML via cid:) — não
// aparecem na lista de anexos pro destinatário, só renderizam dentro do
// corpo. "Infraestrutura" e os telefones são fixos de propósito: só quem
// é Atendente (ou tem admin_total) chega nessa rota, e hoje isso é sempre
// alguém da equipe de Infra — não vale a pena um campo novo de cargo/
// telefone por atendente só pra essa única tela.
const PASTA_ASSETS = path.join(__dirname, '..', 'lib', 'assets');
const ICONES_ASSINATURA = {
  logo: path.join(PASTA_ASSETS, 'telehelp-logo.png'),
  instagram: path.join(PASTA_ASSETS, 'assinatura', 'icone-instagram.png'),
  facebook: path.join(PASTA_ASSETS, 'assinatura', 'icone-facebook.png'),
  youtube: path.join(PASTA_ASSETS, 'assinatura', 'icone-youtube.png'),
  linkedin: path.join(PASTA_ASSETS, 'assinatura', 'icone-linkedin.png'),
  telefone0800: path.join(PASTA_ASSETS, 'assinatura', 'icone-telefone-0800.png'),
  telefone: path.join(PASTA_ASSETS, 'assinatura', 'icone-telefone.png'),
  email: path.join(PASTA_ASSETS, 'assinatura', 'icone-email.png'),
  site: path.join(PASTA_ASSETS, 'assinatura', 'icone-site.png'),
};

function anexosInlineAssinatura() {
  return Object.entries(ICONES_ASSINATURA).map(([contentId, caminho]) => ({
    nome: `${contentId}.png`,
    caminho,
    tipo: 'image/png',
    inline: true,
    contentId,
  }));
}

function montarAssinaturaHtml({ nome, email, departamento }) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin-top:18px; font-family:Calibri,Arial,sans-serif;">
      <tr>
        <td style="border-right:1px solid #B1B1B0; padding-right:14px; vertical-align:top;">
          <img src="cid:logo" width="80" alt="Telehelp" style="display:block; margin-bottom:8px;" />
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:4px;"><img src="cid:instagram" width="18" height="18" alt="Instagram" /></td>
            <td style="padding-right:4px;"><img src="cid:facebook" width="18" height="18" alt="Facebook" /></td>
            <td style="padding-right:4px;"><img src="cid:youtube" width="18" height="18" alt="YouTube" /></td>
            <td><img src="cid:linkedin" width="18" height="18" alt="LinkedIn" /></td>
          </tr></table>
        </td>
        <td style="padding-left:14px; vertical-align:top; font-size:8.5pt; color:#4D4C4C;">
          <div style="font-weight:bold;">${escHtml(nome)}</div>
          <div style="margin-bottom:6px;">${escHtml(departamento || 'Infraestrutura')}</div>
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td><img src="cid:telefone0800" width="14" height="14" alt="" /> 0800 014 2001</td>
            <td style="padding-left:14px;"><img src="cid:telefone" width="14" height="14" alt="" /> 55 11 3585 2000</td>
          </tr></table>
          <table cellpadding="0" cellspacing="0" border="0" style="margin-top:2px;"><tr>
            <td><img src="cid:email" width="14" height="14" alt="" /> <a href="mailto:${escHtml(email)}" style="color:#3A52A0; text-decoration:none;">${escHtml(email)}</a></td>
            <td style="padding-left:14px;"><img src="cid:site" width="14" height="14" alt="" /> <a href="https://telehelp.com.br/" style="color:#3A52A0; text-decoration:none;">www.telehelp.com.br</a></td>
          </tr></table>
        </td>
      </tr>
    </table>
  `;
}

// Os dois documentos estáticos ficam com nome fixo em dados/onboarding-docs/
// — dá pra trocar via upload (rotas no fim deste arquivo), sem precisar de
// redeploy. Pasta criada na inicialização, mesmo padrão de dados/termos/.
const PASTA_DOCS = path.join(__dirname, '..', '..', 'dados', 'onboarding-docs');
fs.mkdirSync(PASTA_DOCS, { recursive: true });
const ARQUIVO_ASSINATURA = path.join(PASTA_DOCS, 'assinatura.docx');
const ARQUIVO_TOMTICKET = path.join(PASTA_DOCS, 'tomticket.docx');
// Versão do passo a passo de assinatura pro app Outlook Mobile (2026-09-21)
// — opcional: diferente de assinatura/tomticket, não bloqueia o envio do
// e-mail se não tiver sido enviada ainda (só entra como anexo extra quando existir).
const ARQUIVO_ASSINATURA_CELULAR = path.join(PASTA_DOCS, 'assinatura-celular.docx');
// Passo a passo de conexão na VPN (2026-09-21) — só entra no e-mail de
// colaborador de cargo EXTERNO (ver cargos.externo), que recebe um celular
// já configurado com a VPN e não passa pelo fluxo normal de assinatura no
// computador/TomTicket. Obrigatório pra esse caso (bloqueia o envio se não
// tiver sido enviado ainda), igual assinatura/tomticket pro fluxo normal.
const ARQUIVO_VPN = path.join(PASTA_DOCS, 'vpn.docx');

const uploadDocumento = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return cb(new Error('Envie um arquivo .docx.'));
    }
    cb(null, true);
  },
});

// Cópia do e-mail de boas-vindas (2026-09-21, pedido explícito do usuário):
// líder da pessoa sempre em cópia (visível), RH + Rodrigo + Lauan sempre em
// cópia oculta. Central de Emergência é exceção — em vez do líder de
// verdade (segundo o AD), usa uma caixa de liderança compartilhada.
const EMAILS_BCC_BOAS_VINDAS = ['rh@telehelp.com.br', 'rodrigo.orsoni@telehelp.com.br', 'lauan.silva@telehelp.com.br', 'ian.alves@telehelp.com.br'];
const EMAIL_LIDERANCA_CENTRAL_EMERGENCIA = 'liderancacentral@telehelp.com.br';

function normalizarNome(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function ehCentralDeEmergencia(departamento) {
  return normalizarNome(departamento).includes('central de emergencia');
}

// Considera "a mesma pessoa" quando todas as palavras do nome MAIS CURTO
// aparecem no nome mais longo (2026-09-21, achado testando: campo "Gestor"
// tinha "Luciana Vanzo", mas o displayName real no AD é "Luciana Alves
// Vanzo" — nome do meio ausente faz o match exato falhar, e digitar/copiar
// sem o nome do meio é comum o bastante pra valer tolerar).
function nomesCompativeis(nomeA, nomeB) {
  const a = normalizarNome(nomeA);
  const b = normalizarNome(nomeB);
  if (!a || !b) return false;
  if (a === b) return true;
  const palavrasA = a.split(/\s+/);
  const palavrasB = b.split(/\s+/);
  const [menor, maior] = palavrasA.length <= palavrasB.length ? [palavrasA, palavrasB] : [palavrasB, palavrasA];
  return menor.every((p) => maior.includes(p));
}

// Acha o e-mail do líder pelo nome cadastrado no colaborador (campo
// "gestor" — texto livre, vem do AD quando cadastrado via busca, ou digitado
// à mão) batendo contra o displayName de todo mundo no AD. Não depende do
// PRÓPRIO colaborador estar no AD (importante pra cargo externo, que pode
// nem ter conta de domínio) — só depende do LÍDER (sempre um funcionário de
// verdade) estar lá. Prefere match exato; se não achar, tenta um match
// tolerante a nome do meio faltando, mas só aceita se for o ÚNICO candidato
// — em caso de ambiguidade (mais de uma pessoa combina), não arrisca mandar
// pro líder errado. Retorna '' se não achar (ou achar mais de um) ou se o
// LDAP não estiver configurado — quem chama decide o que fazer nesse caso
// (não trava o envio).
async function resolverEmailLider(nomeLider) {
  if (!nomeLider || !ldapConfigurado()) return '';
  try {
    const { usuarios } = await buscarUsuariosAD();
    const alvo = normalizarNome(nomeLider);
    const exatos = usuarios.filter((u) => normalizarNome(u.nome) === alvo);
    if (exatos.length === 1) return exatos[0].email;
    if (exatos.length > 1) return '';
    const tolerantes = usuarios.filter((u) => nomesCompativeis(u.nome, nomeLider));
    return tolerantes.length === 1 ? tolerantes[0].email : '';
  } catch (_) {
    return '';
  }
}

// Textos dos dois e-mails de boas-vindas (conferidos com os exemplos reais
// que o usuário mandou, "RES_ Boas vindas!.msg" e "RES_ Boas vindas! 2.msg")
// — a única diferença entre os dois é se o cargo tem acesso direto ao
// TomTicket ou não (mais o anexo correspondente). genero ('m'/'f'/null,
// 2026-09-18) escolhe "bem-vindo"/"bem-vinda"/"bem-vindo(a)" — pra soar
// pessoal em vez de genérico. remetenteNome/remetenteEmail: quem CLICOU
// em enviar. O e-mail real mostra DUAS assinaturas (achado revisando o
// modelo de novo, 2026-09-18): um PREVIEW de como a assinatura do próprio
// colaborador que está entrando deve ficar (logo depois da lista de
// documentos, sob o título "Assinatura" — ele ainda não configurou a
// dele, esse preview é o exemplo/alvo) e a assinatura de quem enviou, no
// fechamento ("Atenciosamente,").
function montarCorpoEmail({ nomeColaborador, acessoTomTicket, cargoExterno, genero, colaboradorEmail, colaboradorDepartamento, remetenteNome, remetenteEmail }) {
  const boasVindas = genero === 'f' ? 'bem-vinda' : genero === 'm' ? 'bem-vindo' : 'bem-vindo(a)';
  // Primeiro nome só na saudação/apresentação (2026-09-21) — mais pessoal;
  // o resto do e-mail (ficha, assinatura no fechamento, etc.) continua com
  // o nome completo de cada um.
  const primeiroNome = (s) => (s || '').trim().split(/\s+/)[0] || s;
  const introducao = `
    <p>Olá, ${escHtml(primeiroNome(nomeColaborador))},</p>
    <p>Seja ${boasVindas} à Telehelp!</p>
    <p>Meu nome é ${escHtml(primeiroNome(remetenteNome))}, faço parte da equipe de Infraestrutura/TI, e este e-mail tem como objetivo reunir as principais orientações iniciais para que você consiga acessar os recursos corporativos necessários para o início das suas atividades.</p>
    <p>Em anexo, você encontrará os seguintes documentos:</p>
  `;
  // Cargo externo (consultor/técnico externo, 2026-09-21) tem um kit de
  // documentos totalmente diferente: só ficha + assinatura no celular + VPN
  // (o celular já vem configurado pela empresa, sem PC/rede corporativa nem
  // TomTicket direto) — não é o mesmo fluxo condicional de TomTicket/
  // assinatura de computador usado pro resto dos cargos.
  const itensDocumentos = [
    '<li><b>Ficha de acessos</b><br>Documento com os sistemas, usuários e acessos liberados para o seu cargo e área de atuação.</li>',
  ];
  if (cargoExterno) {
    itensDocumentos.push(
      '<li><b>Passo a passo para configuração da assinatura de e-mail no celular</b><br>Orientação para configurar sua assinatura de e-mail corporativa no aplicativo Outlook do smartphone.</li>',
      '<li><b>Passo a passo para conectar na VPN</b><br>Orientação para conectar o celular corporativo na VPN da Telehelp.</li>'
    );
  } else {
    if (acessoTomTicket) {
      itensDocumentos.push(
        '<li><b>Passo a passo para acesso à plataforma de chamados e abertura das solicitações.</b><br>Orientação sobre como acessar a plataforma utilizada para registrar solicitações, incidentes e dúvidas relacionadas à TI/Infraestrutura e instruções sobre como abrir chamados corretamente, incluindo as informações importantes que devem ser preenchidas para agilizar o atendimento.</li>'
      );
    }
    itensDocumentos.push(
      '<li><b>Passo a passo para configuração da assinatura de e-mail</b><br>Orientação para configurar sua assinatura de e-mail corporativa conforme o padrão da empresa.</li>'
    );
  }
  const listaDocumentos = `<ol>${itensDocumentos.join('')}</ol>`;
  // Cargo externo não recebe acesso direto ao TomTicket junto com o kit de
  // boas-vindas — usa sempre a variante "peça à liderança", independente do
  // flag acesso_tomticket do cargo.
  const acessoTomTicketEfetivo = cargoExterno ? false : acessoTomTicket;
  const suporte = acessoTomTicketEfetivo
    ? `<p>Sempre que precisar de suporte relacionado a acessos, sistemas, equipamentos, rede, e-mail ou demais recursos de tecnologia, pedimos que registre um chamado na plataforma indicada no material anexo. Dessa forma, conseguimos acompanhar melhor as solicitações, manter o histórico de atendimento e garantir que cada demanda seja tratada da maneira adequada.</p>
       <p>Caso tenha alguma dificuldade no primeiro acesso ou não consiga abrir um chamado, entre em contato com a equipe de Infraestrutura/TI para que possamos auxiliá-la.</p>`
    : `<p>Sempre que precisar de suporte relacionado a acessos, sistemas, equipamentos, rede, e-mail ou demais recursos de tecnologia, pedimos que peça à sua liderança que abra um chamado na plataforma Tom Ticket. Dessa forma, conseguimos acompanhar melhor as solicitações, manter o histórico de atendimento e garantir que cada demanda seja tratada da maneira adequada.</p>`;
  const fechamento = `<p>Mais uma vez, seja ${boasVindas}!</p><p>Atenciosamente,</p>`;

  const previewAssinaturaColaborador = colaboradorEmail
    ? `<p style="font-size:14pt; font-weight:bold; margin-bottom:0;">Assinatura</p>` +
      montarAssinaturaHtml({ nome: nomeColaborador, email: colaboradorEmail, departamento: colaboradorDepartamento })
    : '';
  const assinaturaRemetente = montarAssinaturaHtml({ nome: remetenteNome, email: remetenteEmail });

  return introducao + listaDocumentos + previewAssinaturaColaborador + suporte + fechamento + assinaturaRemetente;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onboardingRouter(db) {
  const router = express.Router();

  // --- Cargos --------------------------------------------------------------
  router.get('/cargos', (req, res) => {
    res.json(db.prepare(`SELECT * FROM cargos WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all());
  });

  router.post('/cargos', (req, res) => {
    const { nome, acessoTomTicket = false, externo = false } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome do cargo.' });
    try {
      const info = db.prepare(`INSERT INTO cargos (nome, acesso_tomticket, externo) VALUES (?, ?, ?)`).run(nome.trim(), acessoTomTicket ? 1 : 0, externo ? 1 : 0);
      res.status(201).json(db.prepare(`SELECT * FROM cargos WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe um cargo com esse nome.' });
      throw e;
    }
  });

  // Edição pontual de cargo (2026-09-21) — hoje só usado pra marcar/desmarcar
  // "externo" em cargos que já existem (ex.: os 111 importados do AD), sem
  // precisar apagar e recriar (perderia os sistemas já associados em
  // cargo_sistemas).
  router.patch('/cargos/:id', (req, res) => {
    const cargo = db.prepare(`SELECT * FROM cargos WHERE id = ?`).get(req.params.id);
    if (!cargo) return res.status(404).json({ erro: 'Cargo não encontrado.' });
    const campos = {};
    if (req.body.nome !== undefined) {
      if (!req.body.nome.trim()) return res.status(400).json({ erro: 'Nome não pode ficar vazio.' });
      campos.nome = req.body.nome.trim();
    }
    if (req.body.acessoTomTicket !== undefined) campos.acesso_tomticket = req.body.acessoTomTicket ? 1 : 0;
    if (req.body.externo !== undefined) campos.externo = req.body.externo ? 1 : 0;
    const colunas = Object.keys(campos);
    if (colunas.length) {
      try {
        db.prepare(`UPDATE cargos SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...colunas.map((c) => campos[c]), req.params.id);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe um cargo com esse nome.' });
        throw e;
      }
    }
    res.json(db.prepare(`SELECT * FROM cargos WHERE id = ?`).get(req.params.id));
  });

  // Exclusão de verdade (2026-10-02, mesmo pedido/padrão de /sistemas) —
  // cargo_sistemas e onboarding_colaboradores.cargo_id referenciam cargos
  // sem ON DELETE CASCADE de propósito: se o cargo já tiver sistemas
  // associados ou algum colaborador cadastrado nele, o banco recusa a
  // exclusão com erro de FK, devolvido aqui como mensagem clara.
  router.delete('/cargos/:id', (req, res) => {
    try {
      const info = db.prepare(`DELETE FROM cargos WHERE id = ?`).run(req.params.id);
      if (info.changes === 0) return res.status(404).json({ erro: 'Cargo não encontrado.' });
      res.json({ ok: true });
    } catch (e) {
      if (String(e.message).includes('FOREIGN KEY')) {
        return res.status(409).json({ erro: 'Esse cargo está associado a sistemas ou a algum colaborador cadastrado — não dá pra excluir enquanto estiver em uso.' });
      }
      throw e;
    }
  });

  router.get('/cargos/:id/sistemas', (req, res) => {
    const linhas = db
      .prepare(`SELECT sistema_id FROM cargo_sistemas WHERE cargo_id = ?`)
      .all(req.params.id)
      .map((r) => r.sistema_id);
    res.json(linhas);
  });

  // Substitui a lista completa de sistemas do cargo — mesmo padrão de
  // PUT /atendentes/:id/departamentos-liderados em referencia.js.
  router.put('/cargos/:id/sistemas', (req, res) => {
    const cargo = db.prepare(`SELECT * FROM cargos WHERE id = ?`).get(req.params.id);
    if (!cargo) return res.status(404).json({ erro: 'Cargo não encontrado.' });
    const sistemaIds = Array.isArray(req.body.sistemaIds) ? req.body.sistemaIds : [];

    db.prepare(`DELETE FROM cargo_sistemas WHERE cargo_id = ?`).run(req.params.id);
    const inserir = db.prepare(`INSERT INTO cargo_sistemas (cargo_id, sistema_id) VALUES (?, ?)`);
    for (const sid of sistemaIds) inserir.run(req.params.id, sid);

    res.json({ cargoId: Number(req.params.id), sistemaIds });
  });

  // --- Sistemas --------------------------------------------------------------
  router.get('/sistemas', (req, res) => {
    res.json(db.prepare(`SELECT * FROM sistemas WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all());
  });

  router.post('/sistemas', (req, res) => {
    const { nome, obrigatorioParaTodos = false } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome do sistema.' });
    try {
      const info = db.prepare(`INSERT INTO sistemas (nome, obrigatorio_para_todos) VALUES (?, ?)`).run(nome.trim(), obrigatorioParaTodos ? 1 : 0);
      res.status(201).json(db.prepare(`SELECT * FROM sistemas WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Já existe um sistema com esse nome.' });
      throw e;
    }
  });

  // Exclusão de verdade (2026-10-02, pedido explícito) — diferente do
  // padrão "só desativa" usado em departamentos/categorias/cargos, porque
  // sistema cadastrado errado (nome duplicado, digitado errado) tende a
  // ser corrigido na hora, não precisa virar lixo inativo na lista pra
  // sempre. cargo_sistemas e onboarding_credenciais referenciam sistemas
  // sem ON DELETE CASCADE de propósito — se o sistema já estiver em uso
  // (associado a algum cargo, ou já tiver credencial de colaborador
  // registrada), o banco recusa a exclusão com erro de FK, e devolvemos
  // isso como mensagem clara em vez de deixar vazar o erro cru do SQLite.
  router.delete('/sistemas/:id', (req, res) => {
    try {
      const info = db.prepare(`DELETE FROM sistemas WHERE id = ?`).run(req.params.id);
      if (info.changes === 0) return res.status(404).json({ erro: 'Sistema não encontrado.' });
      res.json({ ok: true });
    } catch (e) {
      if (String(e.message).includes('FOREIGN KEY')) {
        return res.status(409).json({ erro: 'Esse sistema está associado a algum cargo ou colaborador — não dá pra excluir enquanto estiver em uso.' });
      }
      throw e;
    }
  });

  // --- Colaboradores (onboarding) -------------------------------------------
  router.get('/colaboradores', (req, res) => {
    const linhas = db
      .prepare(
        `SELECT oc.*, c.nome AS cargo_nome, c.acesso_tomticket
         FROM onboarding_colaboradores oc
         LEFT JOIN cargos c ON c.id = oc.cargo_id
         ORDER BY oc.criado_em DESC`
      )
      .all();
    res.json(linhas);
  });

  router.post('/colaboradores', (req, res) => {
    const { nome, cargoId, gestor, email, genero, departamento, usuarioRede } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome do colaborador.' });
    if (genero !== undefined && genero !== null && !['m', 'f'].includes(genero)) {
      return res.status(400).json({ erro: `Gênero inválido. Use "m", "f" ou não informe.` });
    }
    const id = gerarId();
    db.prepare(`INSERT INTO onboarding_colaboradores (id, nome, cargo_id, gestor, email, genero, departamento, usuario_rede) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, nome.trim(), cargoId || null, gestor || null, email || null, genero || null, departamento || null, usuarioRede || null);
    res.status(201).json(db.prepare(`SELECT * FROM onboarding_colaboradores WHERE id = ?`).get(id));
  });

  // Editar cadastro de colaborador já existente (2026-09-18) — antes só
  // dava pra criar, sem jeito de corrigir gênero/departamento/e-mail sem
  // apagar e recriar (e recriar perderia as credenciais já digitadas).
  router.patch('/colaboradores/:id', (req, res) => {
    const existente = db.prepare(`SELECT * FROM onboarding_colaboradores WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Colaborador não encontrado.' });

    const campos = {};
    if (req.body.nome !== undefined) {
      if (!req.body.nome.trim()) return res.status(400).json({ erro: 'Nome não pode ficar vazio.' });
      campos.nome = req.body.nome.trim();
    }
    if (req.body.cargoId !== undefined) campos.cargo_id = req.body.cargoId || null;
    if (req.body.gestor !== undefined) campos.gestor = req.body.gestor || null;
    if (req.body.email !== undefined) campos.email = req.body.email || null;
    if (req.body.departamento !== undefined) campos.departamento = req.body.departamento || null;
    if (req.body.usuarioRede !== undefined) campos.usuario_rede = req.body.usuarioRede || null;
    if (req.body.genero !== undefined) {
      if (req.body.genero !== null && !['m', 'f'].includes(req.body.genero)) {
        return res.status(400).json({ erro: `Gênero inválido. Use "m", "f" ou null.` });
      }
      campos.genero = req.body.genero;
    }

    const colunas = Object.keys(campos);
    if (colunas.length) {
      db.prepare(`UPDATE onboarding_colaboradores SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...colunas.map((c) => campos[c]), req.params.id);
    }
    res.json(db.prepare(`SELECT * FROM onboarding_colaboradores WHERE id = ?`).get(req.params.id));
  });

  // Exclui de verdade (2026-09-18) — diferente do padrão "só ativo=0" do
  // resto da plataforma: aqui não tem chamado/movimentação antiga
  // referenciando o colaborador, e o dado é sensível o bastante (senha
  // cifrada junto) pra fazer sentido remover mesmo, não só esconder.
  router.delete('/colaboradores/:id', (req, res) => {
    db.prepare(`DELETE FROM onboarding_credenciais WHERE colaborador_id = ?`).run(req.params.id);
    const info = db.prepare(`DELETE FROM onboarding_colaboradores WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    res.json({ ok: true });
  });

  function buscarColaboradorCompleto(id) {
    const colaborador = db
      .prepare(
        `SELECT oc.*, c.nome AS cargo_nome, c.acesso_tomticket, c.externo AS cargo_externo
         FROM onboarding_colaboradores oc
         LEFT JOIN cargos c ON c.id = oc.cargo_id
         WHERE oc.id = ?`
      )
      .get(id);
    return colaborador;
  }

  // Sistemas do cargo do colaborador + a credencial já cadastrada (se
  // houver) pra cada um — não devolve a senha em texto puro, só se já tem
  // uma cadastrada (temSenha) — evita a senha trafegar por um GET/listagem.
  router.get('/colaboradores/:id/credenciais', (req, res) => {
    const colaborador = buscarColaboradorCompleto(req.params.id);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });

    // Sistemas "obrigatório para todos" (ex.: Usuário de rede) entram pra
    // TODO colaborador, mesmo sem cargo definido ou sem estarem marcados em
    // cargo_sistemas — e vêm primeiro na lista (2026-09-21, sem eles a
    // pessoa nem entra no PC) — EXCETO cargo externo (consultor/técnico
    // externo), que não recebe usuário de rede (pedido explícito do usuário).
    // Cargo externo, por sua vez, ganha os "obrigatório para cargo externo"
    // (ex.: Celular, Conta Microsoft, Tablet, Telehelp Web, VPN) sozinhos,
    // sem precisar marcar em cargo_sistemas cargo por cargo — não faz
    // sentido repetir isso nas 10+ variações de cargo externo importadas do AD.
    const obrigatorios = colaborador.cargo_externo
      ? db.prepare(`SELECT * FROM sistemas WHERE obrigatorio_externo = 1 AND ativo = 1 ORDER BY nome COLLATE NOCASE`).all()
      : db.prepare(`SELECT * FROM sistemas WHERE obrigatorio_para_todos = 1 AND ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
    let sistemasDoCargo = colaborador.cargo_id
      ? db
          .prepare(
            `SELECT s.* FROM sistemas s
             JOIN cargo_sistemas cs ON cs.sistema_id = s.id
             WHERE cs.cargo_id = ? AND s.ativo = 1 AND s.obrigatorio_para_todos = 0
             ORDER BY s.nome COLLATE NOCASE`
          )
          .all(colaborador.cargo_id)
      : [];
    // Evita listar duas vezes um sistema que já veio pelos "obrigatórios"
    // acima mas também está marcado à mão em cargo_sistemas desse cargo
    // (podia acontecer com cargo que já tinha Celular/Tablet/etc. configurado
    // manualmente antes dessa automação existir).
    if (colaborador.cargo_externo) {
      sistemasDoCargo = sistemasDoCargo.filter((s) => !s.obrigatorio_externo);
    }

    const credenciais = db.prepare(`SELECT * FROM onboarding_credenciais WHERE colaborador_id = ?`).all(req.params.id);
    const porSistema = new Map(credenciais.map((c) => [c.sistema_id, c]));

    res.json(
      [...obrigatorios, ...sistemasDoCargo].map((s) => {
        const cred = porSistema.get(s.id);
        return {
          sistemaId: s.id,
          sistemaNome: s.nome,
          // Flags separadas (2026-09-21) — "obrigatorioParaTodos" é só o
          // "Usuário de rede" (usa a sugestão genérica usuarioRede+senhaRede
          // no front); "obrigatorioExterno" cobre Celular/Tablet/Conta
          // Microsoft/Telehelp Web/VPN, que têm CADA UM sua própria regra de
          // sugestão — por isso não dá pra misturar num único "obrigatorio",
          // senão os 5 caem todos na sugestão genérica por engano.
          obrigatorioParaTodos: !!s.obrigatorio_para_todos,
          obrigatorioExterno: !!s.obrigatorio_externo,
          usuario: cred ? cred.usuario : '',
          temSenha: !!(cred && cred.senha_cifrada),
        };
      })
    );
  });

  // Substitui as credenciais informadas — body: { itens: [{ sistemaId, usuario, senha }] }.
  // "senha" vazia/undefined mantém a que já existia (pra não forçar
  // redigitar toda vez que só o usuário mudar) — manda string vazia
  // explícita se quiser apagar a senha guardada.
  router.put('/colaboradores/:id/credenciais', (req, res) => {
    if (!chaveConfigurada()) {
      return res.status(501).json({ erro: 'CREDENCIAIS_ENC_KEY não configurada no .env — ver comentário em src/lib/credenciaisCrypto.js.' });
    }
    const colaborador = buscarColaboradorCompleto(req.params.id);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    let itens = Array.isArray(req.body.itens) ? req.body.itens : [];

    // Cargo externo não pode ter credencial de sistema "obrigatório para
    // todos" salva (2026-09-21) — o formulário já não mostra essa linha
    // pra esse cargo, isso aqui é só a garantia do lado do servidor.
    if (colaborador.cargo_externo) {
      const idsObrigatorios = new Set(
        db.prepare(`SELECT id FROM sistemas WHERE obrigatorio_para_todos = 1`).all().map((s) => s.id)
      );
      itens = itens.filter((item) => !idsObrigatorios.has(Number(item.sistemaId)));
    }

    for (const item of itens) {
      const existente = db
        .prepare(`SELECT * FROM onboarding_credenciais WHERE colaborador_id = ? AND sistema_id = ?`)
        .get(req.params.id, item.sistemaId);
      const senhaCifrada =
        item.senha === undefined
          ? existente
            ? existente.senha_cifrada
            : null
          : criptografar(item.senha);

      db.prepare(
        `INSERT INTO onboarding_credenciais (colaborador_id, sistema_id, usuario, senha_cifrada)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(colaborador_id, sistema_id) DO UPDATE SET usuario = excluded.usuario, senha_cifrada = excluded.senha_cifrada`
      ).run(req.params.id, item.sistemaId, item.usuario || null, senhaCifrada);
    }

    res.json({ ok: true });
  });

  // Monta os itens da ficha (sistema/usuário/senha em texto claro — só
  // aqui, dentro do PDF, nunca por um GET de JSON) a partir das
  // credenciais cifradas.
  function montarItensFicha(colaboradorId, cargoExterno) {
    const linhas = db
      .prepare(
        `SELECT s.nome AS sistema, s.obrigatorio_para_todos, cr.usuario, cr.senha_cifrada
         FROM onboarding_credenciais cr
         JOIN sistemas s ON s.id = cr.sistema_id
         WHERE cr.colaborador_id = ?
         ORDER BY s.obrigatorio_para_todos DESC, s.nome COLLATE NOCASE`
      )
      .all(colaboradorId)
      // Cargo externo não pode ter usuário de rede na ficha, nem que tenha
      // sobrado credencial salva de antes de o cargo virar externo
      // (2026-09-21) — filtro de segurança, além de já não aparecer mais no
      // formulário de credenciais pra esse cargo.
      .filter((l) => !(cargoExterno && l.obrigatorio_para_todos));
    return linhas.map((l) => ({ sistema: l.sistema, usuario: l.usuario, senha: l.senha_cifrada ? descriptografar(l.senha_cifrada) : '' }));
  }

  router.get('/colaboradores/:id/ficha', async (req, res) => {
    const colaborador = buscarColaboradorCompleto(req.params.id);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    try {
      const itens = montarItensFicha(req.params.id, colaborador.cargo_externo);
      const buffer = await gerarPdfFichaAcessos({
        dados: { nome: colaborador.nome, cargo: colaborador.cargo_nome, gestor: colaborador.gestor, genero: colaborador.genero },
        itens,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="ficha-acessos-${colaborador.nome.replace(/[^a-z0-9]/gi, '-')}.pdf"`);
      res.send(buffer);
    } catch (e) {
      res.status(500).json({ erro: `Não consegui gerar a ficha: ${e.message}` });
    }
  });

  // --- E-mail de boas-vindas -------------------------------------------------
  router.post('/colaboradores/:id/enviar-boas-vindas', async (req, res) => {
    const colaborador = buscarColaboradorCompleto(req.params.id);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    if (!colaborador.email) return res.status(400).json({ erro: 'Esse colaborador não tem e-mail cadastrado.' });

    try {
      const itens = montarItensFicha(req.params.id, colaborador.cargo_externo);

      // Ficha em branco (2026-10-13): o e-mail já saiu uma vez com a ficha de
      // acessos vazia porque as credenciais não tinham sido salvas antes do
      // envio — e e-mail entregue não tem como ser recolhido pela plataforma.
      // Agora o envio é recusado enquanto não houver ao menos uma credencial
      // (usuário ou senha) salva pra esse colaborador.
      const fichaVazia = !itens.some((i) => (i.usuario && String(i.usuario).trim()) || (i.senha && String(i.senha).trim()));
      if (fichaVazia) {
        return res.status(400).json({
          erro: 'A ficha de acessos desse colaborador está em branco — salve as credenciais (botão "Salvar credenciais" no cadastro dele) antes de enviar o e-mail de boas-vindas.',
        });
      }

      const fichaBuffer = await gerarPdfFichaAcessos({
        dados: { nome: colaborador.nome, cargo: colaborador.cargo_nome, gestor: colaborador.gestor, genero: colaborador.genero },
        itens,
      });

      const acessoTomTicket = !!colaborador.acesso_tomticket;
      const cargoExterno = !!colaborador.cargo_externo;
      const anexos = [
        { nome: 'Ficha de acessos.pdf', buffer: fichaBuffer, tipo: 'application/pdf' },
      ];
      // Assinatura no celular (2026-09-22, corrigido): só entra pro cargo
      // externo, que exige ela. NÃO é mais incluída automaticamente pro
      // fluxo normal só porque o arquivo existe (estava vazando pra todo
      // mundo — o documento foi enviado pensando no externo, mas ficava
      // "disponível" e por isso saía pra qualquer cargo).
      if (cargoExterno) {
        // Kit de cargo externo (2026-09-21): só ficha + assinatura no
        // celular + VPN — sem assinatura de computador nem TomTicket (o
        // celular já vem configurado, sem PC/rede corporativa).
        if (!fs.existsSync(ARQUIVO_ASSINATURA_CELULAR)) {
          return res.status(400).json({ erro: 'Documento de assinatura para celular ainda não foi enviado (Colaboradores → Documentos) — obrigatório para cargo externo.' });
        }
        anexos.push({ nome: 'Passo a passo - Configuração da assinatura de e-mail no celular.docx', caminho: ARQUIVO_ASSINATURA_CELULAR, tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        if (!fs.existsSync(ARQUIVO_VPN)) {
          return res.status(400).json({ erro: 'Documento de conexão na VPN ainda não foi enviado (Colaboradores → Documentos) — obrigatório para cargo externo.' });
        }
        anexos.push({ nome: 'Passo a passo - Como conectar na VPN.docx', caminho: ARQUIVO_VPN, tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      } else {
        if (acessoTomTicket) {
          if (!fs.existsSync(ARQUIVO_TOMTICKET)) {
            return res.status(400).json({ erro: 'Documento do TomTicket ainda não foi enviado (Colaboradores → Documentos).' });
          }
          anexos.push({ nome: 'Passo a passo - Acesso e abertura de chamados no TomTicket.docx', caminho: ARQUIVO_TOMTICKET, tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        }
        if (!fs.existsSync(ARQUIVO_ASSINATURA)) {
          return res.status(400).json({ erro: 'Documento de configuração de assinatura ainda não foi enviado (Colaboradores → Documentos).' });
        }
        anexos.push({ nome: 'Passo a passo - Configuração da assinatura de e-mail.docx', caminho: ARQUIVO_ASSINATURA, tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
      anexos.push(...anexosInlineAssinatura());

      // Remetente é sempre quem clicou (2026-09-18) — não um endereço fixo
      // no .env. Precisa do App Registration permitir Mail.Send pra
      // qualquer caixa do tenant (não só uma); se o Graph recusar, o erro
      // abaixo já indica isso.
      const html = montarCorpoEmail({
        nomeColaborador: colaborador.nome,
        acessoTomTicket,
        cargoExterno,
        genero: colaborador.genero,
        colaboradorEmail: colaborador.email,
        colaboradorDepartamento: colaborador.departamento,
        remetenteNome: req.atendente.nome,
        remetenteEmail: req.atendente.email,
      });

      // Líder em cópia (2026-09-21) — Central de Emergência usa a caixa de
      // liderança compartilhada em vez do líder de verdade; resto dos
      // cargos busca o e-mail do líder (campo "gestor") no AD. Se não achar
      // (líder não está no AD, ou LDAP fora do ar), segue o envio mesmo
      // assim sem travar o onboarding — só avisa o atendente na resposta.
      let emailLider = '';
      let avisoLider = '';
      if (ehCentralDeEmergencia(colaborador.departamento)) {
        emailLider = EMAIL_LIDERANCA_CENTRAL_EMERGENCIA;
      } else if (colaborador.gestor) {
        emailLider = await resolverEmailLider(colaborador.gestor);
        if (!emailLider) {
          avisoLider = `Não encontrei o e-mail de "${colaborador.gestor}" no AD para colocar em cópia — envie a ficha pra ele(a) manualmente, se necessário.`;
        }
      } else {
        // Sem "gestor" cadastrado — sem isso não tem como saber quem é o
        // líder pra colocar em cópia (2026-09-21, achado testando: antes
        // isso ficava em silêncio total, sem CC e sem aviso nenhum).
        avisoLider = 'Colaborador sem "Gestor" cadastrado — ninguém foi colocado em cópia como líder. Edite o cadastro e reenvie, se necessário.';
      }

      const enviadoPara = await enviarEmail({
        assunto: 'Boas vindas!',
        texto: html.replace(/<[^>]+>/g, ' '),
        html,
        destinatarios: [colaborador.email],
        cc: emailLider ? [emailLider] : [],
        bcc: EMAILS_BCC_BOAS_VINDAS,
        anexos,
        remetente: req.atendente.email,
      });
      // Registro do que saiu de verdade (journalctl -u central-infraestrutura) — a
      // cópia oculta não aparece pra ninguém no e-mail, então este log e a
      // resposta abaixo são a prova de quem foi copiado.
      console.log(`[boas-vindas] ${new Date().toISOString()} remetente=${req.atendente.email} para=${enviadoPara.join(',')} cco=${EMAILS_BCC_BOAS_VINDAS.join(',')}`);
      res.json({ ok: true, enviadoPara, copiaOculta: EMAILS_BCC_BOAS_VINDAS, avisoLider: avisoLider || undefined });
    } catch (e) {
      res.status(500).json({ erro: `Não consegui enviar o e-mail: ${e.message}` });
    }
  });

  // --- Documentos estáticos (assinatura / TomTicket) ------------------------
  router.get('/documentos', (req, res) => {
    res.json({
      assinatura: fs.existsSync(ARQUIVO_ASSINATURA),
      tomticket: fs.existsSync(ARQUIVO_TOMTICKET),
      assinaturaCelular: fs.existsSync(ARQUIVO_ASSINATURA_CELULAR),
      vpn: fs.existsSync(ARQUIVO_VPN),
    });
  });

  function receberDocumento(destino) {
    return (req, res) => {
      uploadDocumento.single('arquivo')(req, res, (err) => {
        if (err) return res.status(400).json({ erro: err.message });
        if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .docx.' });
        fs.writeFileSync(destino, req.file.buffer);
        res.json({ ok: true });
      });
    };
  }

  router.post('/documentos/assinatura', receberDocumento(ARQUIVO_ASSINATURA));
  router.post('/documentos/tomticket', receberDocumento(ARQUIVO_TOMTICKET));
  router.post('/documentos/assinatura-celular', receberDocumento(ARQUIVO_ASSINATURA_CELULAR));
  router.post('/documentos/vpn', receberDocumento(ARQUIVO_VPN));

  return router;
}

module.exports = { onboardingRouter };
