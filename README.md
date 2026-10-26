# Cardume

> A interface do app esta em ingles. O nome do app fica em um unico lugar (`BRAND` em `public/app.js`, mais `public/index.html` e a mensagem de `src/server.js`).

Terminal de estrategias para tokens da Solana. Voce escolhe um token, define regras que consegue ler
(*when / if / then*) e o motor **simula** a estrategia com precos reais, registrando cada decisao.

**Nenhuma ordem real e enviada. Nao ha carteira, chave ou login.**

## Rodar

```
node src/server.js
```

Abra http://127.0.0.1:3000. Precisa so do Node (testado no 12). Sem dependencias, sem build.

Testes do motor: `node test/run.js`

## Variaveis (opcionais)

| Variavel | Para que serve |
|---|---|
| `GEMINI_API_KEY` | IA **gratuita** (plano gratuito do Google Gemini) para entender frases livres. Chave em https://aistudio.google.com/apikey. O modelo "flash" e descoberto sozinho; fixe com `GEMINI_MODEL` se quiser. Se o limite gratuito acabar ou a IA falhar, cai no modo simples. |
| `AI_PROVIDER` | `gemini` ou `anthropic`, se houver as duas chaves (padrao: usa a que existir). |
| `ANTHROPIC_API_KEY` | Alternativa paga: usa o Claude para entender frases livres. Sem ela, "Gerar regras" funciona em **modo simples**: reconhece padroes de frase (compra recorrente, compra na queda, stop desde o pico, realizar lucro, pico de volume), sem IA. |
| `ANTHROPIC_MODEL` | Modelo usado na geracao (padrao `claude-sonnet-5-5`). |
| `SOLANA_RPC` | RPC com mais limite que a publica (para ler "top 10 contas" sem erro 429). |
| `PORT`, `HOST`, `TICK_MS` | Porta (3000), endereco (127.0.0.1) e intervalo do motor (15000 ms). |

Sem login, entao o servidor escuta so em `127.0.0.1`. Nao exponha na internet sem criar autenticacao.

## Carteira (somente conexao)

O botao **Conectar carteira** usa a carteira instalada no navegador (Phantom, Solflare ou Backpack) e mostra o
endereco, o saldo de SOL e os tokens (`#/wallet`). O servidor le o saldo pela RPC (`/api/wallet/<endereco>`).

- **Nao pede assinatura**, nao envia transacao e nunca ve a chave privada.
- Reconecta em silencio se a pessoa ja autorizou o site (`onlyIfTrusted`).
- Proximo passo (nao feito): ao disparar uma regra, mostrar "aprovar ordem?" e assinar com a carteira conectada.

## Modo real com aprovacao (dinheiro de verdade, voce assina cada ordem)

Ao criar uma estrategia com a carteira conectada, aparece **Operar de verdade**. Nesse modo a regra **nao compra
sozinha**: ela cria uma *ordem pendente*. Voce clica em **Revisar e assinar**, confere o resumo e assina na carteira.

```
regra dispara -> ordem pendente (3 min) -> [Revisar] servidor pede cotacao e monta a transacao na Jupiter
  -> resumo (valor, diferenca para o mercado, slippage) -> [Assinar] a carteira assina e envia
  -> servidor confirma na rede (ate 90 s) -> livro da estrategia atualizado
```

Travas: uma ordem aberta por vez; expira em 3 min; a cotacao e bloqueada se ficar mais de 3% pior que o preco de
mercado; a transacao e simulada antes (se falhar, nada e enviado); exige SOL para taxas; so a carteira que criou a
estrategia aprova; perda maxima obrigatoria; tetos opcionais por variavel (abaixo).

| Variavel | Padrao | Para que serve |
|---|---|---|
| `LIVE_MAX_USD_PER_ORDER` | (sem teto) | teto opcional por ordem real; so vale se voce definir |
| `LIVE_MAX_BUDGET_USD` | (sem teto) | teto opcional de orcamento de uma estrategia real |
| `JUP_API_KEY` | (vazio) | chave da Jupiter (portal.jup.ag); sem ela o limite e ~0,5 req/s |
| `JUP_MAX_PRIORITY_LAMPORTS` | 200000 | teto da taxa de prioridade da rede |

Limites conhecidos: valores confirmados sao **estimados pela cotacao** (nao le o resultado exato na rede); a Jupiter
esta migrando da API v1 para a v2 (ajuste so em `src/jupiter.js`); so funciona com a aba aberta; a aprovacao nao
cobra taxa do Cardume.

## Como funciona

```
public/        interface (3 telas: mercado, token, estrategias)
src/market.js  DexScreener (preco), GeckoTerminal (candles), RPC Solana (autoridades do token)
src/risk.js    nota de risco 0-100, com o motivo de cada ponto
src/rules.js   biblioteca fechada de regras + validacao + modelos prontos
src/engine.js  motor: a cada tick avalia regras, simula ordens (taxa 0,5% + impacto de preco)
src/compiler.js  frase -> regras JSON (so escreve regras; tudo passa por validate())
src/store.js   persistencia em data/state.json
```

### Regras

- **Triggers:** `interval`, `price_change`, `drawdown_from_peak`, `price_cross`, `volume_spike`
- **Condicoes:** `price_max`, `price_min`, `cooldown`, `max_fires`, `position`, `budget_left`, `rule_state`, `liquidity_min`, `jev`
- **Acoes:** `buy`, `sell`, `exit_all`, `disable_rule`, `pause_rule`, `resume_rule`, `deploy_remaining`, `notify`

Triggers de estado (`price_change`, `drawdown`, `volume_spike`) disparam na *borda* (quando a condicao passa a
valer), nao a cada tick. Limites da estrategia (orcamento, maximo por ordem, perda maxima, impacto de preco
de 1,5%) valem sempre e as regras nao conseguem ultrapassar.

### O "juiz" (condicao `jev`)

E uma **heuristica simples**: compara a queda de liquidez do token e a variacao mediana do mercado em alta
para estimar `market_drawdown`, `token_specific_dump` ou `liquidity_pull`. Nao usa IA. Da para trocar por
uma chamada de LLM em `engine.judge`, mantendo a mesma saida (3 probabilidades).

## Limites conhecidos

- Simulacao: preco de execucao e aproximado (preco do ultimo tick + impacto estimado pela liquidez).
- A nota de risco usa so dados publicos; sem holders detalhados (snipers, insiders, bundlers).
- Os dados vem de APIs gratuitas com limite de uso; em falha, o tick e pulado e registrado no log.

## Para ir ao modo real (nao implementado)

1. Carteira nao custodial (ex.: Privy) com politica de assinatura restrita a Jupiter e programas de token.
2. Execucao pela Jupiter (cotacao -> transacao -> assinatura) respeitando os mesmos limites do motor.
3. Autenticacao de usuarios e um banco no lugar de `state.json`.
4. Revisao juridica: executar ordens e cobrar taxa pode exigir enquadramento regulatorio.
