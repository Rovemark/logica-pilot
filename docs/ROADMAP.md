# ROADMAP — Logica Pilot

## ✅ Shipped (desde este roadmap)

Boa parte do que estava listado abaixo como P0/P1 já foi entregue. Feito e no ar:

- **Confiabilidade da camada IA** — timeout + retry/backoff no `llm.js` (429/5xx, honra `retry-after`) + fallback Anthropic em 5xx; detector de loop/no-progress no agent; rastreio de custo/tokens (`usage` retornado por run).
- **Eficiência de token** — prompt caching + poda de mapas antigos = **~77% menos custo de input** por run.
- **Electron 37** + ad-block nativo (EasyList/EasyPrivacy) + extensões (Chrome Web Store/unpacked) + fix de reflow do painel.
- **Human handoff** — detecta login/captcha/Cloudflare e pausa pra resolução humana (tool `handoff`).
- **Memória + histórico de runs** — site-memory (flywheel) + **self-repair** (aprende consertos por site) + **flight recorder** (`runs`, report HTML).
- **Suíte de automação (43 tools)** — crawl/map/index(BM25)/llmstxt, gather/ask, meta/product/images/media, batch, dataset, monitor+daemon, adapter (site→tool), workflow (replay determinístico).
- **Attach ao browser real** (`--attach`), **proxy BYO + geo**, **redação de PII**, **consent-killer** — tudo local, zero-dep.
- **Bug da New Tab** (motor de busca hardcoded) e o `single-instance`/escrita atômica de stores endereçados na linha de trabalho atual.

**Ainda em aberto (bloco de release):** empacotamento (electron-builder/.dmg/.exe), code signing + notarização, auto-update assinado, e o hardening de segurança do Electron (`will-attach-webview`, sandbox, `openExternal`). São o caminho de "beta interno sólido" → "GA público".

---

## 1. VEREDICTO (análise original — histórico)

Logica Pilot é um **protótipo robusto / pre-beta excelente**, não um produto. A casca (abas, omnibox, favoritos, leitor, PDF, extensões Chrome, popovers flutuantes) e o motor de IA (percepção a11y+visão, CDP próprio sem Playwright, loop de tool-calling) estão num nível de engenharia raro para 1 commit / v0.1.0 / 4,1k LOC. **A maior lacuna única não é técnica do core — é que o produto é literalmente inentregável e inseguro para o mundo real**: roda só de fonte (`npm run browser`), com Electron 33 (18 CVEs high, Chromium 130 desatualizado num *browser*), zero testes, e o copiloto-estrela dirige a sessão autenticada do usuário sem nenhum guardrail. Hoje você tem um motor de Ferrari sem carroceria, sem freio e sem placa.

---

## 2. P0 — antes de QUALQUER release real

> Bloqueadores absolutos. Sem estes, não se distribui nem para beta fechado. Segurança de um *browser* (que abre web hostil e guarda senhas) não admite exceção.

| # | Item | Esforço | Por quê (1 linha) |
|---|------|:---:|---|
| P0-1 | **Subir Electron 33→41 + libs de extensão** | **L** | 18 CVEs high (ASAR bypass, IPC spoof por service worker, origin errado em permissão de iframe, header injection no `pilot://`) num browser = risco real, não teórico. Bloqueia tudo abaixo (signing/asarIntegrity dependem dele). É épico de migração porque `electron-chrome-extensions@4.2+` exige Electron 35+. |
| P0-2 | **Empacotamento (electron-builder) + ícone + identidade** | **M** | Sem `.dmg/.exe/.AppImage` ninguém instala. Hoje exige Node+clone+terminal. Inclui ícone (some o "Electron" genérico), `setName`, `setAppUserModelId`, entry correto (`app/main.js`, não `src/index.js`). |
| P0-3 | **Code signing + notarização (mac) / assinatura (win)** | **M** | App não-notarizado = Gatekeeper barra ("app danificado"); Windows = SmartScreen. Para um browser que pede senhas, rodar sem assinatura é sinal de não-confiável. Custo: Apple Dev $99/ano + cert Windows. |
| P0-4 | **Auto-update assinado (electron-updater + GitHub Releases)** | **M** | Browser sem auto-update = nunca recebe patch de CVE do Chromium. É segurança contínua, não conveniência. Anda junto com P0-1/P0-3. |
| P0-5 | **Guardrails do copiloto: confirmação humana + anti-prompt-injection + partition isolada por padrão** | **L** | O agente dirige CDP completo na sessão **logada** (banco/email) sem allowlist, sem human-in-the-loop, sem defesa contra injection vindo da própria página. Pode logar e exfiltrar. É o maior risco de **confiança** do produto e o que separa "demo" de "shippável" — ainda mais sendo multi-tenant. |
| P0-6 | **`will-attach-webview` handler** | **S** | ~15 linhas. O renderer controla 100% dos atributos da `<webview>` (nodeintegration, preload, partition) sem o main validar nada. Fecha a porta de escalonamento → RCE mais perigosa do design. ROI absurdo. |
| P0-7 | **Sandbox + validação de `shell.openExternal` + blocklist de esquema no omnibox** | **S/M** | `sandbox:false` em todas as janelas desliga metade da defesa do Electron. `openExternal` aceita qualquer esquema (`file://`, `ms-msdt:`) = vetor RCE clássico. `file://` chega cru na webview. Trio barato de alto impacto. |
| P0-8 | **Copiloto funcionar out-of-the-box: campo de API key na UI + health-check + fallback Anthropic direto** | **M** | Hoje o copiloto depende do LogicaProxy local `:8317` que NENHUM usuário externo tem → primeiro "Pilotar ▸" devolve erro técnico cru. O recurso-estrela está **morto na chegada** para quem clona o repo. |

**Resumo P0:** ~3 itens L + 4 M + 2 S. Realisticamente **3-4 semanas** com 1 dev focado (a migração do Electron domina o cronograma).

---

## 3. P1 — alto valor (o que faz virar produto e diferencial de IA)

> Priorizados por impacto×esforço. Os 3 primeiros são "S" e mudam a percepção do produto inteiro.

**Camada IA (o diferencial — ordem de execução):**

1. **LLM com timeout + retry/backoff + não-fatal em transitório** — **S** · *Maior ROI do projeto inteiro.* Hoje um único 429/529/timeout (rotina na Anthropic) mata a tarefa no passo 7 de 12. Com 25-30 chamadas/tarefa, a falha é quase garantida. Poucas horas, salva a taxa de sucesso percebida.
2. **Detector de loop/no-progress** — **S** · Hoje o único anti-loop é uma frase no prompt. O agente queima 30 passos pagos repetindo o mesmo clique e termina sem entregar. Hash de snapshot + contador de repetição.
3. **Copiloto do dia-a-dia: Resumir / Perguntar à página / Explicar seleção (chat com contexto)** — **M** · *Gap de PRODUTO #1.* O que faz Arc/Dia/Comet serem usados TODO dia não é o agente autônomo (caso raro e arriscado) — é o "resuma esta página", chat lateral com a aba como contexto. A infra já existe (`perception.snapshot()` + `callClaude`). Muda a percepção de "automação de nicho" para "copiloto diário".
4. **Streaming SSE na resposta** — **M** · Pré-requisito de UX do item 3. Sem token-a-token, chat/resumo parece travado (spinner 3-8s vs Dia/ChatGPT).
5. **Human-in-the-loop + pausar/retomar no painel** — **M** · Confiança. Agente que clica "Comprar"/"Confirmar pagamento" sozinho é risco sério, ainda mais multi-tenant. (Sobrepõe a P0-5.)
6. **Memória + histórico de runs (plugar no Logica Mind)** — **M** · Comet/Dia apostam em memória persistente como moat. Você JÁ tem o Logica Mind — não conectar é oportunidade perdida que os concorrentes não têm.
7. **Rastreio de custo/tokens + teto de gasto** — **S** · A resposta já traz `usage`, o código ignora. Sem teto = risco financeiro num proxy compartilhado/cobrado. Plugar no `cost-per-chat` existente.
8. **Fallback de modelo + seletor na UI (Haiku/Sonnet/Opus)** — **S** · Controle de custo/qualidade + resiliência.

**Camada Browser (UX obrigatória que sabota o dia-a-dia):**

9. **Restauração de sessão/abas** — **M** · Fechou o app = perdeu tudo. Expectativa básica de qualquer browser. Sem isso parece protótipo.
10. **HTML5 fullscreen + Picture-in-Picture** — **M** · Vídeo (YouTube/Netflix) quebra dentro da `<webview>`. Consumo de mídia é caso de uso #1 — isso sozinho manda o usuário de volta pro Chrome.
11. **Gerenciador de senhas / autofill** — **L** · Sem cofre de senha, todo login é fricção. Incoerente num browser que se vende como "a IA pilota seus logins". Reusar Logica Wallet / `safeStorage`.
12. **Bug: busca da New Tab ignora o motor configurado (Google hardcoded)** — **S** · `newtab.js:43`. Bug visível e contraditório com a promessa de privacidade (DDG/Brave).

**Qualidade / engenharia (rede de segurança):**

13. **CI (GitHub Actions matrix) + lint + escrita atômica nos stores** — **S/M** · Sem CI, um PR quebra o boot e ninguém vê. `fs.writeFileSync` não-atômico → crash no meio corrompe e ZERA history/bookmarks silenciosamente (perda de dados do usuário).
14. **Suíte de testes de contrato preload↔renderer** — **M** · Os 29 bugs do review eram TODOS o mesmo padrão de IPC torto que falha silenciosamente. Sem teste, qualquer refactor reintroduz a classe inteira. Crítico para aceitar PRs públicos.
15. **Docs de arquitetura públicos + CONTRIBUTING** — **S** · O projeto é open source GPL para receber PRs, mas os 3 docs de arquitetura estão no `.gitignore`. Contribuidor recebe repo cego.
16. **Onboarding / first-run + New Tab revelando o Pilot** — **M** · O único diferencial (a IA) tem descoberta **zero** na primeira tela. Chips de objetivo clicáveis + overlay de boas-vindas.
17. **Resolver Chromium da CLI headless (puppeteer/browsers ou Electron-as-node)** — **M** · A lib/CLi quebra em máquina sem Chrome. Decisão de produto: interna ao LogicaOS (aceitável) vs pública (resolver bootstrap).
18. **`single-instance lock`** — **S** · 2ª instância corrompe os stores. Vira problema real só depois de empacotado — subir antes do release.

---

## 4. P2 — polish / depois

- **i18n (EN + PT-BR)** — **L** · Browser open-source é global; tudo PT-BR hardcoded trava o alcance. Estratégico mas não urgente para o 1º release.
- **Acessibilidade (aria-labels, role=menu/tablist, foco-trap nos popovers)** — **M** · WCAG básico; browser é ferramenta de acesso universal.
- **Grupos de abas, pin, drag-reorder** — **M** · Polish competitivo (alma do Arc).
- **Settings profundo (pasta de download, DNT, cookies 3rd-party, permissões por-site)** — **M** · Coerência com o posicionamento de privacidade (oferece DDG/Brave).
- **Página de gerenciar extensões + importar favoritos** — **M** · Reduz fricção de migração do Chrome.
- **Reading list, save-page offline, sugestões de busca ao vivo** — **M**.
- **Multi-aba no agente + fill_form estruturado + saída JSON (outputSchema) + BrowserPool** — **M/L** · Transforma o headless em ferramenta de produção pros 57 agentes do LogicaOS.
- **Anti-detecção (jitter, movimento de mouse, patch webdriver)** — **M** · Sites com anti-bot (Cloudflare/DataDome) barram o agente headless.
- **CSP da casca mais apertada, estados de erro/vazio estilizados, cache de janelas flutuantes, limpar overlays HTML mortos, fixes medium/low do review (race de título, `file.pdf` como domínio), truncamento cego (2000/3500 chars)** — **S/M cada** · Papercuts que somam na percepção.
- **Perfis múltiplos + sync cifrado (via Supabase/identidade do LogicaOS)** — **L** · Diferencial estratégico de longo prazo; decisivo para virar browser principal multi-máquina.

---

## 5. A GRANDE DECISÃO TÉCNICA — `<webview>` → `WebContentsView`

**Recomendação: NÃO migrar agora. Documentar a escolha consciente de ficar em `<webview>` e adiar.**

| | |
|---|---|
| **Prós da migração** | `<webview>` é oficialmente desencorajada pela Electron; `WebContentsView` move o ownership pro main (mais seguro, sem o hack de esconder a webview sob overlays, sem o flash da página ao abrir omnibox). |
| **Contras agora** | TODA a arquitetura assume "renderer é dono das webviews": `tabs.js`, `webview-manager`, a ponte inteira de extensões (`ext:createTab`), e os 7 overlays flutuantes existem JUSTAMENTE para conviver com `<webview>`. Migrar = reescrever tudo isso = **semanas + nova safra de bugs de race**, num projeto que acabou de estabilizar 29 bugs e tem **ZERO testes** para proteger o refactor. Risco/retorno péssimo. |
| **Quando reconsiderar** | (1) Só depois da suíte de testes de contrato IPC (P1-14) estar verde — sem ela o refactor é cego. (2) Atrás de uma flag, uma aba por vez. (3) Quando o ganho concreto (ex.: matar o flash da omnibox) doer mais que o custo. |

**A dívida real aqui não é a `<webview>` — é a ausência de testes que tornaria a migração segura.** Investir nos testes primeiro tem ROI maior e desbloqueia a migração no futuro, se ela se justificar.

---

## 6. SE EU TIVESSE 1 SEMANA

Foco em **máximo impacto por esforço** — corrigir o que está quebrado/inseguro e barato, sem entrar nos épicos L (Electron upgrade, signing, password manager ficam para o sprint seguinte). Ordem:

1. **(Dia 1, manhã) LLM: timeout + AbortController + retry/backoff; erro transitório não-fatal** (P1-1, S) — maior ROI do projeto, salva a confiabilidade na hora.
2. **(Dia 1, tarde) `will-attach-webview` + validação de `shell.openExternal` + blocklist de esquema** (P0-6, P0-7, S) — fecha os vetores de RCE mais perigosos em ~30 linhas.
3. **(Dia 2) Escrita atômica nos 3 stores + single-instance lock** (P1-13, P1-18, S) — elimina perda silenciosa de dados do usuário.
4. **(Dia 2-3) Detector de loop/no-progress + rastreio de custo/tokens + teto** (P1-2, P1-7, S) — para de queimar dinheiro e aumenta taxa de sucesso real.
5. **(Dia 3-4) Modo "Perguntar / Resumir página" no painel (chat com contexto, sem tools)** (P1-3, M) — o item que muda a percepção de "automação" para "copiloto diário". Aproveita infra existente.
6. **(Dia 4) UI de API key + health-check do cérebro + fallback Anthropic direto** (P0-8, M) — faz o produto funcionar out-of-the-box para qualquer um.
7. **(Dia 5, manhã) CI mínimo (Actions matrix + smoke headless) + lint + tirar docs do `.gitignore` + CONTRIBUTING** (P1-13, P1-15, S) — rede de segurança e abre o repo para contribuição de verdade.
8. **(Dia 5, tarde) Bug New Tab (motor de busca) + chips de exemplo na New Tab/painel revelando o Pilot** (P1-12, P1-16, S) — corrige bug visível e dá descoberta ao diferencial.

**Resultado da semana:** um copiloto confiável (não morre em 429, não entra em loop, não estoura custo), um produto que **funciona out-of-the-box**, os buracos de RCE mais críticos tapados, perda de dados eliminada, e — pela primeira vez — uma feature de IA que justifica abrir o browser todo dia ("resuma esta página"). **Não fica shippável ao público** (faltam os épicos L: Electron 41, signing, packaging, guardrails completos do agente) — mas vira um **beta interno sólido e demonstrável**, e o caminho para GA fica claro: o sprint seguinte é o bloco Electron-upgrade → packaging → signing → auto-update (P0-1 a P0-4), que são L/M e exigem conta Apple/cert Windows.

> **Nota honesta de sequência:** P0-1 (Electron 41) é pré-requisito de P0-3/P0-4 e é o item de maior risco/prazo. Sugiro iniciá-lo **em paralelo**, numa branch, já na semana 1 — não porque cabe na semana, mas porque é o caminho crítico de tudo que vem depois e não pode esperar.