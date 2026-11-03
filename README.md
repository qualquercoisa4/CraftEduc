# CraftEduc

Jogo 3D de construção desenvolvido com Next.js, React e Three.js.

## Desenvolvimento

- Instalar dependências: `pnpm install --frozen-lockfile`
- Iniciar ambiente local: `pnpm dev`
- Executar validação automatizada: `pnpm test`
- Gerar build de produção (inclui os testes): `pnpm build`

## Arquitetura

Consulte [docs/architecture.md](docs/architecture.md) para o mapa dos módulos, responsabilidades e limites de alteração.

## Regras de manutenção

- Preserve a separação entre simulação do jogo e componentes de interface.
- Trate `lib/game/engine.ts` como coordenador do ciclo do jogo; evite adicionar novas responsabilidades a ele.
- Mantenha cálculos puros e modelos de domínio em módulos próprios sempre que possível.
- Alterações em física, circuitos, persistência e geração de mundo devem ter testes de regressão correspondentes.
- Não misture refatorações de Single Player com alterações de Multiplayer.
