# Arquitetura do CraftEduc

Este documento descreve a organização atual do código e estabelece limites para futuras alterações. Ele não define novas regras de jogo.

## Visão geral

O projeto é uma aplicação Next.js/React que inicializa um ambiente 3D com Three.js. A lógica do jogo fica principalmente em `lib/game`, enquanto `components/game` contém a interface de interação.

### Mapa de módulos

| Área | Arquivos | Responsabilidade |
| --- | --- | --- |
| Inicialização e ciclo | `app/page.tsx`, `lib/game/engine.ts` | Montar a experiência, coordenar entrada, atualização e renderização |
| Estado da interface | `lib/game/store.ts` | Estado reativo consumido pelos componentes React |
| Mundo voxel | `lib/game/world.ts`, `world-generation.ts`, `mesher.ts` | Dados dos blocos, chunks, geração e geometria |
| Simulação física | `lib/game/rigid-physics.ts` | Integração com Rapier, corpos rígidos e colisores |
| Regras e sistemas | `lib/game/mechanics.ts` | Orquestração das interações entre blocos, máquinas, circuitos e física |
| Eletricidade | `lib/game/electrical.ts` | Solver e operações de análise de circuitos |
| Modelo de motores | `lib/game/motor-model.ts`, `motor-specs.ts` | Parâmetros e cálculos de motores |
| Sensores de proximidade | `lib/game/proximity.ts` | Cálculos puros de leitura por raio e comparação de distância |
| Modelos e apresentação 3D | `lib/game/models.ts`, `textures.ts`, `particles.ts`, `sky.ts`, `audio.ts` | Modelos, materiais e recursos visuais/sonoros |
| Persistência | `lib/game/world-saves.ts` | Serialização e armazenamento local de mundos |
| Interface | `components/game/` | HUD, inventário, configurações e programação |
| Multiplayer | `lib/game/multiplayer.ts`, `multiplayer-types.ts`, `components/game/multiplayer-panel.tsx`, `supabase/functions/crafteduc-multiplayer/` | Transporte, sincronização e interface de rede |

## Fluxo de dependências recomendado

- Componentes React leem e atualizam o estado de interface por meio de `store.ts`.
- A página inicial cria e descarta a instância do motor do jogo.
- O motor coordena o mundo, os sistemas de mecânica, a física e a renderização.
- Sistemas de domínio devem depender de tipos e funções de domínio; evite importar componentes React para dentro de `lib/game`.
- Cálculos determinísticos e sem dependência de cena devem permanecer em módulos puros, como o solver elétrico, o modelo de motores e as leituras de proximidade.
- A persistência deve continuar isolada do ciclo de renderização.

## Limites de segurança para refatorações

1. Não alterar formatos de dados salvos, chaves de armazenamento, IDs de blocos ou contratos de serialização sem uma migração explícita e testes.
2. Não alterar ordem de atualização, frequência de simulação, passos de física, limites numéricos ou critérios de colisão em uma tarefa de organização.
3. Não mover lógica de um módulo para outro se isso exigir alterar a ordem de inicialização ou de descarte.
4. Não alterar APIs públicas entre `Engine`, `World`, `Mechanics` e componentes durante uma refatoração puramente estrutural.
5. Manter Multiplayer fora do escopo de mudanças do Single Player. Os módulos de rede são documentados para tornar a fronteira visível, não para sugerir sua modificação.
6. Fazer extrações pequenas e verificáveis. Cada extração deve preservar entradas, saídas, efeitos colaterais e ordem de execução.

## Validação

- `pnpm test:electrical`: testes determinísticos do solver elétrico e dos modelos associados.
- `pnpm test:regressions`: testes TypeScript de terminais Arduino, múltiplos motores e sensores de proximidade.
- `tests/physics-mass.test.ts` permanece no repositório, mas não integra a validação padrão: seus fixtures e expectativas antigas não correspondem integralmente à API e ao comportamento atuais da física. Deve ser revisado em uma tarefa específica, sem enfraquecer as verificações nem alterar a simulação nesta refatoração.
- `pnpm test`: executa as duas suítes.
- `pnpm build`: executa a suíte completa e depois a build de produção.

Os testes de integração de física dependem de Rapier e devem ser executados em ambiente Node compatível com as dependências do projeto.

## Política para arquivos centrais grandes

`engine.ts` e `mechanics.ts` concentram muitas responsabilidades e são candidatos a extrações graduais. Não os dividir por tamanho apenas. Antes de extrair um módulo:

- Identificar um conjunto coeso de funções e seu estado privado.
- Mapear todos os chamadores e efeitos colaterais.
- Preservar a ordem de atualização e o ciclo de vida dos recursos Three.js/Rapier.
- Extrair sem alterar nomes, parâmetros ou resultados observáveis.
- Executar testes, type-check e build antes de prosseguir para a próxima extração.

Uma extração que exige mudanças simultâneas em física, sincronização, persistência ou interface deve ser dividida em tarefas menores.
