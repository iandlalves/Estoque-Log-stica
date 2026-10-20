// Central de Infraestrutura — API do motor de chamados próprio.
//
// Primeira fase: só a equipe de Infra acessa, dentro da rede interna. Login
// com Microsoft/Entra ID (ver src/lib/authEntra.js e src/lib/auth.js)
// protege tudo debaixo de /api, exceto /api/saude e as rotas de início/volta
// do login em /api/auth/entra/*.

require('dotenv').config({ quiet: true }); // quiet: evita poluir o log do serviço com o banner do dotenv
const path = require('node:path');
const express = require('express');
const cors = require('cors');

const { db } = require('./lib/db');
const { exigirLogin, exigirPapel } = require('./lib/auth');
const { authRouter } = require('./routes/auth');
const { referenciaRouter } = require('./routes/referencia');
const { chamadosRouter } = require('./routes/chamados');
const { estoqueRouter } = require('./routes/estoque');
const { adRouter } = require('./routes/ad');
const { cpdRouter } = require('./routes/cpd');
const { firmwareRouter } = require('./routes/firmware');
const { acronisRouter } = require('./routes/acronis');
const { onboardingRouter } = require('./routes/onboarding');
const { integracaoTeamsRouter } = require('./routes/integracaoTeams');

const app = express();
// cors() aqui é mais formalidade que proteção de verdade: o front-end é
// servido pelo mesmo processo/porta (mesma origem), então o navegador nem
// aplica CORS nessas chamadas. Quem protege contra outro site tentando usar
// a sessão de alguém logado é o SameSite=Lax do cookie (ver definirCookieSessao).
app.use(cors());
app.use(express.json());

app.get('/api/saude', (req, res) => {
  res.json({ ok: true, agora: new Date().toISOString() });
});

app.use('/api/auth', authRouter(db));

// Fora do exigirLogin de propósito — quem chama é o Power Automate (Teams),
// sem sessão de navegador; tem chave de API própria (ver
// src/routes/integracaoTeams.js).
app.use('/api', integracaoTeamsRouter(db));

// Tudo debaixo de /api a partir daqui exige login.
app.use('/api', exigirLogin(db));

app.use('/api', referenciaRouter(db));
app.use('/api/chamados', chamadosRouter(db));
// Estoque e CPD (2026-09-17): domínio inteiro é ferramenta de quem atende
// — Operador (colaborador comum, só abre/acompanha os próprios chamados)
// nunca teve isso na sidebar, e agora também não acessa via API direta.
app.use('/api', exigirPapel('atendente', 'lider', 'gestor'), estoqueRouter(db));
app.use('/api', adRouter());
app.use('/api', exigirPapel('atendente', 'lider', 'gestor'), cpdRouter(db));
// Atualizações de firmware via iDRAC (2026-09-23) — mesmo grupo de acesso
// do CPD, reaproveita o catálogo cpd_servidores (ver src/routes/firmware.js).
app.use('/api', exigirPapel('atendente', 'lider', 'gestor'), firmwareRouter(db));
// Alertas do Acronis Cyber Protect (2026-09-30) — mesmo grupo de acesso.
app.use('/api', exigirPapel('atendente', 'lider', 'gestor'), acronisRouter(db));
// Onboarding de acessos (2026-09-18): cargo×sistemas + credenciais é o
// dado mais sensível da plataforma — restrito a papel=atendente só,
// decisão explícita do usuário (nem Líder nem Gestor têm acesso aqui).
app.use('/api/onboarding', exigirPapel('atendente'), onboardingRouter(db));

// Front-end estático (HTML/CSS/JS puro, sem build step) servido pelo mesmo
// processo/porta que a API — um site só, sem precisar de dois servidores
// nem lidar com CORS entre eles. Fica depois das rotas /api pra uma rota
// de API nunca cair aqui por engano.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Handler de erro genérico — evita vazar stack trace pro cliente, mas loga
// no console do servidor pra dar pra investigar.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Veja o log do servidor pra detalhes.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Central de Infraestrutura (API) rodando em http://localhost:${PORT}`);
});
