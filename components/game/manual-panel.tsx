'use client'

import { useMemo, useState } from 'react'
import { BookOpen, Blocks, Cpu, Gamepad2, Search, Wrench, Zap, X } from 'lucide-react'

type ManualSection = {
  id: string
  title: string
  icon: typeof BookOpen
  intro: string
  entries: { title: string; body: string }[]
}

const SECTIONS: ManualSection[] = [
  {
    id: 'software',
    title: 'Sobre o software',
    icon: BookOpen,
    intro: 'O RoboEduccraft é um ambiente educacional 3D para explorar construção, robótica, eletrônica e programação por meio de experimentação.',
    entries: [
      { title: 'O que é o RoboEduccraft?', body: 'É um simulador em estilo sandbox no qual você constrói estruturas, posiciona componentes e testa ideias. O objetivo é aprender fazendo: montar, observar o resultado, identificar problemas e melhorar o projeto.' },
      { title: 'Como funciona o mundo?', body: 'O mundo é formado por blocos. Você pode construir livremente, editar estruturas e combinar peças. Alguns objetos possuem propriedades físicas e outros participam de circuitos elétricos simulados.' },
      { title: 'Modo criativo', body: 'O inventário criativo disponibiliza os materiais e componentes do protótipo para experimentação. Selecione os itens que deseja usar e organize-os na barra de acesso rápido.' },
      { title: 'Simulação', body: 'O jogo representa alguns comportamentos físicos e elétricos de forma simplificada para fins educacionais. Os valores exibidos são parâmetros do simulador e não substituem especificações ou medições de equipamentos reais.' },
    ],
  },
  {
    id: 'controls',
    title: 'Controles',
    icon: Gamepad2,
    intro: 'Os comandos mudam conforme o dispositivo. No computador, use teclado e mouse. Em telas sensíveis ao toque, utilize os controles na tela.',
    entries: [
      { title: 'Movimentação no computador', body: 'W, A, S e D ou as setas movimentam o personagem. Espaço pula. Shift agacha. Ctrl corre.' },
      { title: 'Câmera e interação', body: 'Mova o mouse para olhar ao redor. O botão esquerdo quebra blocos; o botão direito coloca blocos ou interage com componentes. As teclas 1 a 9 selecionam os espaços correspondentes da barra.' },
      { title: 'Inventário', body: 'Pressione E para abrir ou fechar o inventário. Clique em um item para pegá-lo e clique em um espaço da barra para organizá-lo. Shift + clique envia um item para a barra rapidamente.' },
      { title: 'Voo', body: 'Pressione Espaço duas vezes para alternar o voo. No modo de voo, use os comandos de movimento vertical disponíveis no jogo.' },
      { title: 'Controles no celular', body: 'Use o direcional virtual no lado esquerdo para andar. Arraste o lado direito da tela para controlar a câmera. Os botões à direita permitem pular, agachar e alternar o voo. A barra de itens fica na parte inferior.' },
      { title: 'Pintura', body: 'Equipe o pincel. No computador, Shift + botão direito abre a seleção de cor; botão direito sobre um bloco aplica a pintura. A pintura altera a aparência, não as propriedades físicas do material.' },
    ],
  },
  {
    id: 'building',
    title: 'Construção',
    icon: Blocks,
    intro: 'A construção é feita posicionando blocos no mundo e combinando materiais com diferentes funções.',
    entries: [
      { title: 'Colocar e remover blocos', body: 'Selecione um bloco na barra de acesso rápido. Aponte para uma superfície e use o comando de colocar. Para remover, aponte para o bloco e use o comando de quebrar.' },
      { title: 'Materiais estruturais', body: 'Madeira é um material isolante elétrico. Ferro e alumínio são condutivos. O bloco de robótica também conduz eletricidade e pode servir de base para montagens. Escolha o material conforme a função da estrutura.' },
      { title: 'Bloco de componente', body: 'É uma placa de circuito usada como base para montagens eletrônicas e para apoiar componentes.' },
      { title: 'Cola quente', body: 'Aplique cola em uma face para fixar blocos vizinhos e formar uma montagem física única. Use-a quando precisar que as peças permaneçam conectadas.' },
      { title: 'Pintura e resina', body: 'O pincel altera a aparência dos blocos. O aplicador de resina cria um revestimento protetor que reduz danos elétricos causados pela água, conforme a simulação.' },
    ],
  },
  {
    id: 'components',
    title: 'Componentes e ferramentas',
    icon: Wrench,
    intro: 'O inventário reúne peças estruturais, componentes eletrônicos, motores, ferramentas e fontes de energia.',
    entries: [
      { title: 'LED', body: 'O LED é um diodo emissor de luz. Ele possui polaridade: o ânodo deve ficar no lado positivo e o cátodo no lado negativo. Um circuito precisa estar fechado e alimentado para funcionar.' },
      { title: 'Interruptor', body: 'O interruptor abre ou fecha os contatos do circuito. Ele permite controlar manualmente a passagem de corrente.' },
      { title: 'Resistor', body: 'O resistor limita a corrente elétrica. No inventário, é possível configurar seu valor usando as faixas de cores.' },
      { title: 'Motores CC', body: 'O inventário possui motores com características diferentes. Motores sem redução tendem a girar mais rápido e entregar menos torque; motorredutores reduzem a velocidade e aumentam o torque disponível no eixo.' },
      { title: 'Servo motor SG90', body: 'O servo é um atuador posicional: recebe um sinal de controle e posiciona seu eixo em um ângulo. Ele não funciona como um motor de rotação contínua.' },
      { title: 'Arduino UNO', body: 'A placa controladora oferece pinos digitais, alimentação e GND para conectar componentes compatíveis. O comportamento depende das conexões e do programa carregado.' },
      { title: 'Sensor de proximidade', body: 'O sensor frontal mede a distância até um bloco e responde à condição configurada. A orientação do sensor influencia o que ele detecta.' },
      { title: 'Multímetro', body: 'O multímetro oferece modos de tensão contínua, corrente contínua, resistência, continuidade e teste de diodo. Tensão é medida em paralelo; corrente, em série. Resistência e continuidade devem ser verificadas com a fonte desligada.' },
      { title: 'Scanner DWS', body: 'Aponte o scanner para uma montagem colada para analisar o conjunto. O relatório pode apresentar massa, dimensões, centro de massa, inércia estimada e composição.' },
    ],
  },
  {
    id: 'electricity',
    title: 'Eletricidade',
    icon: Zap,
    intro: 'Os circuitos são formados por fontes, condutores e componentes conectados eletricamente.',
    entries: [
      { title: 'Fontes de energia', body: 'A pilha AAA fornece tensão nominal simulada de 1,5 V. Insira as pilhas no compartimento para alimentar o circuito.' },
      { title: 'Fios e terminais', body: 'Use fios para conectar terminais expostos de componentes. Uma conexão só funciona quando os terminais corretos estão ligados e existe um caminho elétrico completo.' },
      { title: 'Polaridade', body: 'Fontes e componentes polarizados possuem lado positivo e negativo. Inverter a polaridade pode impedir o funcionamento do componente.' },
      { title: 'Curto-circuito', body: 'Um curto-circuito ocorre quando se cria um caminho de resistência muito baixa entre os polos de uma fonte. Revise as conexões antes de energizar um circuito.' },
      { title: 'Condução dos materiais', body: 'Ferro, alumínio, bloco de robótica e bloco de componente são condutivos na simulação. Madeira e janela são isolantes. Não confunda uma peça estrutural com um fio ligado a um terminal.' },
    ],
  },
  {
    id: 'programming',
    title: 'Programação e automação',
    icon: Cpu,
    intro: 'O Arduino UNO e o tablet de programação permitem criar comportamentos para componentes compatíveis.',
    entries: [
      { title: 'Tablet de programação', body: 'Equipe o tablet e interaja com um componente compatível para abrir sua interface de programação.' },
      { title: 'Pinos do Arduino', body: 'O Arduino UNO possui pinos digitais D0 a D13, além de 5V, GND e VIN. Conecte os componentes aos terminais apropriados antes de programar.' },
      { title: 'Entradas e saídas', body: 'Uma saída pode controlar um componente, enquanto uma entrada pode receber informações de sensores. A configuração do pino precisa corresponder ao uso no programa.' },
      { title: 'Servo e sensores', body: 'Um programa pode controlar a posição de um servo e utilizar leituras de sensores para tomar decisões. A alimentação, o aterramento e o sinal precisam estar conectados corretamente.' },
    ],
  },
]

export function ManualPanel({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState('software')
  const [query, setQuery] = useState('')
  const active = SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0]
  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR')
  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return SECTIONS
    return SECTIONS.map((section) => ({
      ...section,
      entries: section.entries.filter((entry) =>
        `${section.title} ${section.intro} ${entry.title} ${entry.body}`.toLocaleLowerCase('pt-BR').includes(normalizedQuery),
      ),
    })).filter((section) =>
      section.title.toLocaleLowerCase('pt-BR').includes(normalizedQuery) ||
      section.intro.toLocaleLowerCase('pt-BR').includes(normalizedQuery) ||
      section.entries.length > 0,
    )
  }, [normalizedQuery])

  const selectSection = (id: string) => {
    setActiveSection(id)
    setQuery('')
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-2 backdrop-blur-[3px] sm:p-5"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Manuais do RoboEduccraft"
        className="flex max-h-[min(92dvh,850px)] w-full max-w-5xl flex-col overflow-hidden border-[3px] border-black bg-[#c6c6c6] text-[#292929]"
        style={{ boxShadow: 'inset 3px 3px 0 #fff, inset -3px -3px 0 #555, 0 18px 60px #0009' }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b-2 border-black bg-[#263d52] px-3 py-3 text-white sm:px-5">
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[0.2em] text-[#ffcf4a] sm:text-xs">ROBOEDUCCRAFT • CENTRAL DE AJUDA</p>
            <h2 className="mt-1 font-display text-base sm:text-xl">MANUAIS DO SOFTWARE</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar manuais" className="flex size-10 shrink-0 items-center justify-center border-2 border-white/50 bg-white/10 hover:bg-white/20">
            <X className="size-5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Seções do manual" className="flex shrink-0 gap-1 overflow-x-auto border-b-2 border-black bg-[#a8a8a8] p-2 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r-2">
            {SECTIONS.map((section) => {
              const Icon = section.icon
              const selected = section.id === activeSection
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => selectSection(section.id)}
                  aria-current={selected ? 'page' : undefined}
                  className={`flex min-h-10 shrink-0 items-center gap-2 border-2 px-2 py-2 text-left text-xs sm:w-full sm:text-sm ${selected ? 'border-black bg-[#e8e8e8] font-bold shadow-[inset_2px_2px_0_white,inset_-2px_-2px_0_#777]' : 'border-transparent bg-[#929292] hover:bg-[#bdbdbd]'}`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{section.title}</span>
                </button>
              )
            })}
          </nav>

          <div className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b-2 border-[#777] bg-[#d7d7d7] p-3 sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div>
                  <h3 className="font-display text-sm sm:text-lg">{active.title.toLocaleUpperCase('pt-BR')}</h3>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-[#505050] sm:text-sm">{active.intro}</p>
                </div>
                <label className="flex h-10 w-full shrink-0 items-center gap-2 border-2 border-[#555] bg-white px-2 sm:w-64">
                  <Search className="size-4 shrink-0 text-[#666]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Pesquisar no manual..."
                    aria-label="Pesquisar no manual"
                    className="min-w-0 flex-1 bg-transparent text-xs text-black outline-none sm:text-sm"
                  />
                </label>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5">
              {normalizedQuery ? (
                <div className="space-y-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-[#555]">Resultados da pesquisa</p>
                  {filteredSections.length === 0 ? (
                    <p className="border-2 border-dashed border-[#888] p-4 text-sm text-[#555]">Nenhum resultado encontrado. Tente outro termo.</p>
                  ) : filteredSections.map((section) => (
                    <div key={section.id} className="space-y-2">
                      <h4 className="text-xs font-bold text-[#31536c]">{section.title}</h4>
                      {section.entries.map((entry) => (
                        <article key={entry.title} className="border-2 border-[#888] bg-[#e5e5e5] p-3">
                          <h5 className="text-sm font-bold">{entry.title}</h5>
                          <p className="mt-1 text-xs leading-5 text-[#444] sm:text-sm">{entry.body}</p>
                          <button type="button" onClick={() => selectSection(section.id)} className="mt-2 text-xs font-bold text-[#245d87] underline">Abrir seção</button>
                        </article>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {active.entries.map((entry, index) => (
                    <article key={entry.title} className="border-2 border-[#888] bg-[#e5e5e5] p-3 sm:p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex size-7 shrink-0 items-center justify-center border-2 border-[#555] bg-[#b9cbd7] text-xs font-bold">{index + 1}</span>
                        <div className="min-w-0">
                          <h4 className="text-sm font-bold sm:text-base">{entry.title}</h4>
                          <p className="mt-1 text-xs leading-5 text-[#444] sm:text-sm sm:leading-6">{entry.body}</p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="mt-5 border-t border-[#999] pt-3 text-center text-[10px] leading-4 text-[#666]">
                Manual inicial do protótipo. Algumas funções e comportamentos podem mudar conforme o desenvolvimento do software.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
