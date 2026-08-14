# Tipografia — Logica Pilot

## Família

**Manrope** é a voz tipográfica principal. Ela mantém o vínculo com Rovemark, mas no Pilot assume um comportamento mais instrumental: títulos compactos, numerais fortes, labels precisos e muito espaço negativo.

Fallback offline recomendado:

```css
font-family: "Manrope", "Avenir Next", "Segoe UI", Arial, sans-serif;
```

Para código, índices e telemetria:

```css
font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

## Hierarquia

| Token | Tamanho / linha | Peso | Tracking | Uso |
|---|---:|---:|---:|---|
| Display XL | `clamp(56px, 8vw, 112px) / 0.92` | 700 | `-0.055em` | Manifesto, capa, hero |
| Display | `clamp(44px, 6vw, 80px) / 0.96` | 700 | `-0.045em` | Títulos principais |
| H1 | `48px / 1.02` | 700 | `-0.035em` | Página de produto |
| H2 | `36px / 1.08` | 700 | `-0.025em` | Seções |
| H3 | `24px / 1.18` | 600 | `-0.015em` | Blocos e cards |
| Lead | `20px / 1.5` | 400 | `-0.01em` | Subtítulo e argumento |
| Body | `16px / 1.65` | 400 | `0` | Texto corrido |
| Small | `14px / 1.5` | 500 | `0` | Ajuda e metadados |
| Label | `12px / 1.2` | 700 | `0.12em` | Categorias, estados, eyebrow |
| Mono | `13px / 1.55` | 500 | `0` | Índices, endpoints, logs |

Em telas abaixo de 720px, H1 reduz para `40px`; H2 para `30px`. Corpo nunca abaixo de `16px` em conteúdo principal.

## Composição

- Títulos em **sentence case**, não Title Case.
- Display pode ocupar duas ou três linhas; controlar a quebra editorialmente.
- Alinhar à esquerda por padrão. Centralização apenas em splash ou ícone/assinatura isolada.
- Usar peso 800 somente em números curtos ou uma palavra de choque. O peso 700 é o ponto de voz da marca.
- Labels em caixa alta precisam de tracking entre `0.10em` e `0.14em`.
- Números de prova devem usar `font-variant-numeric: tabular-nums lining-nums`.
- Nunca usar gradiente dentro de texto, contorno decorativo ou glow em tipografia.

## Ritmo verbal

Os títulos do Pilot trabalham em pares: uma afirmação curta e uma explicação precisa.

> **Não envie pixels.**  
> Envie intenção.

> **Aprende o território.**  
> A rota melhora a cada execução.

## Wordmark

O wordmark é um lettering geométrico proprietário, construído em vetor, e não deve ser recomposto com Manrope. Manrope começa na comunicação ao redor da marca, nunca dentro do arquivo de logo.

