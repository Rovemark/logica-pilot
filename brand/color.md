# Cor — Logica Pilot

## Princípio

A cor encena o produto: **Sovereign Blue é a infraestrutura; Beacon Lime é o sinal que a atravessa.** O azul liga o Pilot à Rovemark. O lime marca intenção, alvo encontrado, rota ativa e aprendizado. Graphite e Ivory mantêm a interface técnica, humana e legível.

O lime nunca substitui o azul como cor institucional. Ele é um pulso: pequeno, raro e impossível de ignorar.

## Paleta principal

| Nome | Hex | Papel |
|---|---:|---|
| Sovereign Blue | `#3455E8` | Marca-mãe, ação principal, rota |
| Beacon Lime | `#C7FF4A` | Intenção, estado ativo, ponto aprendido |
| Graphite 950 | `#10131A` | Texto principal e fundo profundo |
| Ivory | `#F8F7F2` | Fundo claro, calor editorial |
| White | `#FFFFFF` | Superfícies elevadas |
| Pilot Sky | `#89A7FF` | Dados auxiliares e temas escuros |

## Escala Graphite

`950 #10131A` · `900 #171B24` · `800 #252A35` · `700 #373D49` · `600 #505866` · `500 #6A7280` · `400 #9299A4` · `300 #BBC0C8` · `200 #D9DCE1` · `100 #ECEEF1`

## Cores de estado

| Estado | Hex | Uso |
|---|---:|---|
| Success | `#147A50` | Execução concluída, rota válida |
| Warning | `#8A5700` | Degradação, espera, atenção |
| Danger | `#C5393F` | Falha, bloqueio, remoção |
| Info | `#2853CC` | Informação operacional |

Estados devem carregar também texto ou ícone. Nunca comunicar condição apenas por cor.

## Proporção recomendada

- **70% neutros:** fundos, superfícies e tipografia.
- **25% Sovereign Blue:** marca, navegação, ações e estruturas.
- **5% Beacon Lime:** beacon, foco narrativo, estado aprendido.

Em interfaces densas, reduzir Beacon Lime para 2–3%. Ele perde função se tudo parecer “ativo”.

## Contraste e acessibilidade

Combinações aprovadas para texto normal (WCAG AA, 4.5:1 ou mais):

| Frente | Fundo | Razão aproximada | Uso |
|---|---|---:|---|
| `#10131A` | `#F8F7F2` | 17.3:1 | Texto principal claro |
| `#505866` | `#F8F7F2` | 6.7:1 | Texto secundário claro |
| `#FFFFFF` | `#3455E8` | 5.8:1 | Botões e campos azuis |
| `#F8F7F2` | `#0D1016` | 17.8:1 | Texto principal escuro |
| `#B8BEC8` | `#0D1016` | 10.2:1 | Texto secundário escuro |
| `#10131A` | `#C7FF4A` | 15.8:1 | Labels sobre Beacon Lime |
| `#2F6500` | `#F8F7F2` | 6.6:1 | Lime semântico em texto |

Não usar `#C7FF4A` como texto sobre Ivory/White. Para texto “lime” em tema claro, usar **Beacon Ink `#2F6500`**. No tema escuro, Beacon Lime pode ser usado em texto curto, ícones e indicadores.

## Temas

O tema claro usa Ivory em vez de branco puro para ganhar caráter editorial. O tema escuro não é uma inversão matemática: fundo `#0D1016`, superfícies azuladas e acento azul mais claro (`#8098FF`) preservam contraste e profundidade.

Os papéis prontos para implementação estão em [`tokens.css`](./tokens.css): `--pilot-bg`, `--pilot-surface`, `--pilot-fg`, `--pilot-fg-muted`, `--pilot-border`, `--pilot-accent` e `--pilot-signal`.
