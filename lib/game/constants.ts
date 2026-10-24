export const CHUNK_SIZE = 16
export const WORLD_HEIGHT = 64
export const GROUND_LEVEL = 4
export const REACH = 5.5

export const B = {
  AIR: 0,
  ROBOTICS: 1,
  IRON: 2,
  WOOD: 3,
  COMPONENT: 4,
  LED: 5,
  MOTOR: 6,
  BATTERY_BOX: 7,
  ALUMINUM: 8,
  GEAR: 9,
  WHEEL: 10,
  SWITCH: 11,
  PROXIMITY_SENSOR: 12,
  COLOR_BLOCK: 13,
  SERVO: 14,
  ARDUINO_UNO: 15,
} as const

export const ARDUINO_UNO_TERMINAL_IDS = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
  '5V', 'GND', 'GND_2', 'VIN',
] as const
export type ArduinoUnoTerminalId = (typeof ARDUINO_UNO_TERMINAL_IDS)[number]

export const COLOR_VARIANTS = [
  { id: 'red', name: 'Vermelho', color: '#e53935' },
  { id: 'orange', name: 'Laranja', color: '#fb8c00' },
  { id: 'yellow', name: 'Amarelo', color: '#fdd835' },
  { id: 'lime', name: 'Verde-limão', color: '#7cb342' },
  { id: 'green', name: 'Verde', color: '#43a047' },
  { id: 'cyan', name: 'Ciano', color: '#00acc1' },
  { id: 'light_blue', name: 'Azul-claro', color: '#29b6f6' },
  { id: 'blue', name: 'Azul', color: '#1e88e5' },
  { id: 'purple', name: 'Roxo', color: '#8e24aa' },
  { id: 'magenta', name: 'Magenta', color: '#d81b60' },
  { id: 'pink', name: 'Rosa', color: '#f48fb1' },
  { id: 'brown', name: 'Marrom', color: '#6d4c41' },
  { id: 'black', name: 'Preto', color: '#212121' },
  { id: 'gray', name: 'Cinza', color: '#757575' },
  { id: 'light_gray', name: 'Cinza-claro', color: '#bdbdbd' },
  { id: 'white', name: 'Branco', color: '#f5f5f5' },
] as const

export type ColorVariantId = (typeof COLOR_VARIANTS)[number]['id']
export type BlockId = number

/**
 * Relative electrical conductivity (0–1). This is a material property, not a
 * random chance: 0.9 means the material conducts well but introduces losses.
 */
export const BLOCK_CONDUCTIVITY: Readonly<Record<number, number>> = {
  [B.AIR]: 0,
  [B.ROBOTICS]: 0.92,
  [B.IRON]: 0.90,
  [B.WOOD]: 0,
  [B.COMPONENT]: 0.98,
  [B.LED]: 0,
  [B.MOTOR]: 0,
  [B.BATTERY_BOX]: 0,
  [B.ALUMINUM]: 0.95,
  [B.GEAR]: 0.90,
  [B.WHEEL]: 0,
  [B.SWITCH]: 0,
  [B.PROXIMITY_SENSOR]: 0,
  [B.SERVO]: 0,
}

export function blockConductivity(id: number) {
  return BLOCK_CONDUCTIVITY[id] ?? 0
}

/** 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z */
export const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]
export const OPPOSITE = [1, 0, 3, 2, 5, 4]
export const DIR_NAMES = ['Leste', 'Oeste', 'Cima', 'Baixo', 'Sul', 'Norte']

export function isOpaque(id: number) {
  return id !== B.AIR && id !== B.MOTOR && id !== B.BATTERY_BOX && id !== B.WHEEL && id !== B.SWITCH && id !== B.PROXIMITY_SENSOR && id !== B.SERVO && id !== B.ARDUINO_UNO
}

export function isModelBlock(id: number) {
  return id === B.MOTOR || id === B.BATTERY_BOX || id === B.WHEEL || id === B.SWITCH || id === B.PROXIMITY_SENSOR || id === B.SERVO || id === B.ARDUINO_UNO
}

export type Bounds = readonly [number, number, number, number, number, number]
const FULL: Bounds = [0, 0, 0, 1, 1, 1]
const BOX_BOUNDS: Bounds = [0.04, 0, 0.08, 0.96, 0.36, 0.92]
const SWITCH_BOUNDS: Bounds = [0.01, 0.04, 0.03, 0.99, 0.38, 0.97]
const SENSOR_BOUNDS: Bounds = [0.04, 0.08, 0.04, 0.96, 0.92, 0.96]
const ARDUINO_UNO_BOUNDS: Bounds = [0.08, 0.1, 0.08, 1.92, 0.3, 1.92]

export function blockBounds(id: number): Bounds {
  if (id === B.BATTERY_BOX) return BOX_BOUNDS
  if (id === B.SWITCH) return SWITCH_BOUNDS
  if (id === B.PROXIMITY_SENSOR) return SENSOR_BOUNDS
  if (id === B.ARDUINO_UNO) return ARDUINO_UNO_BOUNDS
  return FULL
}

export type ItemId =
  | 'robotics'
  | 'iron'
  | 'wood'
  | 'component'
  | 'aluminum'
  | 'gear'
  | 'led'
  | 'motor'
  | 'wire'
  | 'glue'
  | 'resin_applicator'
  | 'battery_box'
  | 'battery'
  | 'wheel'
  | 'switch'
  | 'proximity_sensor'
  | 'servo'
  | 'arduino_uno'
  | 'programming_tablet'
  | 'scanner_dws'
  | 'paintbrush'
  | `colored_block_${ColorVariantId}`
  | `wire_${ColorVariantId}`

export type CategoryId = 'all' | 'blocks' | 'components' | 'motors' | 'wiring' | 'tools' | 'power'

export const CATEGORIES: { id: CategoryId; label: string; icon: ItemId }[] = [
  { id: 'all', label: 'Tudo', icon: 'robotics' },
  { id: 'blocks', label: 'Blocos', icon: 'iron' },
  { id: 'components', label: 'Componentes', icon: 'led' },
  { id: 'motors', label: 'Motores', icon: 'motor' },
  { id: 'wiring', label: 'Fiação', icon: 'wire' },
  { id: 'tools', label: 'Ferramentas', icon: 'glue' },
  { id: 'power', label: 'Fontes de Energia', icon: 'battery' },
]

export interface ItemDef {
  name: string
  description: string
  physicalInfo?: string
  category: Exclude<CategoryId, 'all'>
  block?: number
  color?: string
}

export const ITEMS: Record<ItemId, ItemDef> = {
  robotics: {
    name: 'Bloco de Robótica',
    description: 'Bloco estrutural condutivo usado como base para circuitos e montagens robóticas.',
    physicalInfo: 'Massa: 0,90 kg • Condutividade: 92% • Atrito: 0,78 • Volume: 1 m³',
    category: 'blocks',
    block: B.ROBOTICS,
  },
  iron: { name: 'Bloco de Ferro', description: 'Bloco de ferro de alta massa, indicado para estruturas rígidas e contrapesos.', physicalInfo: 'Massa: 2,60 kg • Condutividade: 90% • Atrito: 0,58 • Volume: 1 m³', category: 'blocks', block: B.IRON },
  wood: { name: 'Bloco de Madeira', description: 'Bloco leve para chassis e protótipos. Isola circuitos elétricos.', physicalInfo: 'Massa: 1,20 kg • Isolante elétrico • Atrito: 0,68 • Volume: 1 m³', category: 'blocks', block: B.WOOD },
  component: {
    name: 'Bloco de Componente',
    description: 'Placa de circuito para montar conexões e apoiar componentes eletrônicos.',
    physicalInfo: 'Massa: 0,28 kg • Condutividade: 98% • Atrito: 0,62 • Volume: 1 m³',
    category: 'blocks',
    block: B.COMPONENT,
  },
  aluminum: {
    name: 'Perfil de Alumínio',
    description: 'Perfil de alumínio leve para chassis, suportes e estruturas de robôs.',
    physicalInfo: 'Massa: 0,18 kg • Condutividade: 95% • Atrito: 0,45 • Volume equivalente: 1 m³',
    category: 'blocks',
    block: B.ALUMINUM,
  },
  gear: { name: 'Bloco de Engrenagem', description: 'Bloco de engrenagem metálica para montagens mecânicas e transmissão de movimento.', physicalInfo: 'Massa: 0,42 kg • Condutividade: 90% • Atrito: 0,58 • Volume: 1 m³', category: 'blocks', block: B.GEAR },
  wheel: { name: 'Roda de Arduino', description: 'Roda de borracha com aro de cinco raios, feita para tração em veículos robóticos.', physicalInfo: 'Massa: 0,32 kg • Atrito: 1,05 • Peça móvel; aderência depende da carga normal', category: 'motors', block: B.WHEEL },
  led: {
    name: 'LED',
    description: 'Diodo emissor de luz. Respeite a polaridade: ânodo positivo e cátodo negativo.', physicalInfo: 'Massa: 0,12 kg • Consumo e brilho são simplificados • Não é um bloco estrutural',
    category: 'components',
    block: B.LED,
  },
  switch: {
    name: 'Interruptor elétrico',
    description: 'Interruptor de dois polos que abre ou fecha dois pares de contatos independentes.', physicalInfo: 'Massa: 0,22 kg • Condutividade dos contatos: alta • Estado ligado/desligado altera o circuito',
    category: 'components',
    block: B.SWITCH,
  },
  proximity_sensor: {
    name: 'Sensor de proximidade',
    description: 'Sensor frontal que mede a distância até um bloco e responde à condição configurada. Shift + botão direito para girar.', physicalInfo: 'Massa: 0,18 kg • Alcance simulado: até 32 blocos • Leitura por raio em passos de 0,1 bloco',
    category: 'components',
    block: B.PROXIMITY_SENSOR,
  },
  servo: {
    name: 'Servo motor SG90',
    description: 'Servo de posição. Conecte GND (marrom), VCC (vermelho) e sinal (amarelo); configure os ângulos pelo tablet.', physicalInfo: 'Massa: 0,45 kg • Curso configurável: 0°–180° • Torque simulado: até 1,6 N·m',
    category: 'motors',
    block: B.SERVO,
  },
  arduino_uno: {
    name: 'Arduino UNO',
    description: 'Placa controladora com pinos digitais D0–D13, 5V, GND e VIN para conectar componentes.', physicalInfo: 'Massa: 0,08 kg • 14 pinos digitais • Alimentação simulada; comportamento depende do circuito/programa',
    category: 'components',
    block: B.ARDUINO_UNO,
  },
  programming_tablet: {
    name: 'Tablet de Programação',
    description: 'Tablet portátil para abrir e editar programas de componentes compatíveis.', physicalInfo: 'Ferramenta de interface • Não adiciona massa ao robô nem altera a física do conjunto',
    category: 'tools',
  },
  motor: {
    name: 'Motor CC Pequeno',
    description: 'Motor CC com eixo rotativo. A polaridade define o sentido; ele movimenta peças fixadas com cola quente.', physicalInfo: 'Massa: 1,40 kg • Torque máximo simulado: 4,0 N·m por unidade de potência • Pode perder velocidade sob carga',
    category: 'motors',
    block: B.MOTOR,
  },
  wire: {
    name: 'Fio Amarelo',
    description: 'Fio para ligar terminais expostos. A polaridade, a continuidade e as perdas do circuito afetam a alimentação.', physicalInfo: 'Elemento elétrico sem colisão própria • Resistência simplificada pelo modelo de condutividade',
    category: 'wiring',
    color: '#fdd835',
  },
  glue: {
    name: 'Cola Quente',
    description: 'Aplique numa face para fixar blocos vizinhos e formar uma montagem física única.', physicalInfo: 'A cola cria conexões mecânicas rígidas no simulador; não acrescenta massa própria',
    category: 'tools',
  },
  resin_applicator: {
    name: 'Aplicador de Resina',
    description: 'Reveste um bloco com resina protetora amarelada para reduzir danos elétricos causados pela água.', physicalInfo: 'Revestimento visual/protetor • Não altera massa, volume ou atrito do bloco',
    category: 'tools',
  },
  paintbrush: {
    name: 'Pincel',
    description: 'Altera a aparência de um bloco sem substituir seu material físico. Shift + botão direito abre a paleta.', physicalInfo: 'A pintura é cosmética • Massa, atrito e condutividade permanecem os do material original',
    category: 'tools',
  },
  battery_box: {
    name: 'Compartimento de Pilha AAA',
    description: 'Compartimento para até três pilhas AAA. Com pilhas na mão, clique para inserir; mão vazia retira.', physicalInfo: 'Massa base: 0,65 kg • Cada pilha adiciona 0,12 kg • Capacidade: 3 pilhas',
    category: 'power',
    block: B.BATTERY_BOX,
  },
  battery: {
    name: 'Pilha AAA',
    description: 'Pilha AAA de 1,5 V para alimentar circuitos através do compartimento de pilhas.', physicalInfo: 'Tensão nominal simulada: 1,5 V • A massa adicional é contabilizada pelo compartimento',
    category: 'power',
  },
  ...Object.fromEntries(COLOR_VARIANTS.flatMap((variant) => [
    [`colored_block_${variant.id}`, {
      name: `Bloco ${variant.name}`,
      description: `Bloco estrutural decorativo na cor ${variant.name.toLowerCase()}.`,
      physicalInfo: 'Massa: 0,80 kg (valor padrão) • Atrito: 0,72 • A cor não altera as propriedades físicas',
      category: 'blocks',
      block: B.COLOR_BLOCK,
      color: variant.color,
    }],
    [`wire_${variant.id}`, {
      name: `Fio ${variant.name}`,
      description: `Fio elétrico na cor ${variant.name.toLowerCase()} para conectar terminais expostos.`,
      physicalInfo: 'Elemento elétrico sem colisão própria • A cor não altera a condutividade simulada',
      category: 'wiring',
      color: variant.color,
    }],
  ])),
} as Record<ItemId, ItemDef>

export const ITEM_ORDER: ItemId[] = [
  'robotics',
  'iron',
  'wood',
  'component',
  'aluminum',
  'gear',
  'led',
  'switch',
  'proximity_sensor',
  'servo',
  'arduino_uno',
  'motor',
  'wire',
  'glue',
  'resin_applicator',
  'programming_tablet',
  'scanner_dws',
  'battery_box',
  'battery',
  'wheel',
  'paintbrush',
  ...COLOR_VARIANTS.flatMap((variant) => [
    `colored_block_${variant.id}` as ItemId,
    `wire_${variant.id}` as ItemId,
  ]),
]

export const BLOCK_TO_ITEM: Record<number, ItemId> = {
  [B.ROBOTICS]: 'robotics',
  [B.IRON]: 'iron',
  [B.WOOD]: 'wood',
  [B.COMPONENT]: 'component',
  [B.ALUMINUM]: 'aluminum',
  [B.GEAR]: 'gear',
  [B.LED]: 'led',
  [B.SWITCH]: 'switch',
  [B.PROXIMITY_SENSOR]: 'proximity_sensor',
  [B.SERVO]: 'servo',
  [B.ARDUINO_UNO]: 'arduino_uno',
  [B.COLOR_BLOCK]: 'colored_block_red',
  [B.MOTOR]: 'motor',
  [B.BATTERY_BOX]: 'battery_box',
  [B.WHEEL]: 'wheel',
}

export function isWireItem(item: ItemId | null | undefined): item is 'wire' | `wire_${ColorVariantId}` {
  return item === 'wire' || Boolean(item?.startsWith('wire_'))
}

export const DEFAULT_HOTBAR: (ItemId | null)[] = [
  'iron',
  'wood',
  'component',
  'led',
  'motor',
  'wire',
  'glue',
  'battery_box',
  'wheel',
]

export const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`
export const parseKey = (k: string): [number, number, number] => {
  const p = k.split(',')
  return [Number(p[0]), Number(p[1]), Number(p[2])]
}
