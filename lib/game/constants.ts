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
} as const

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
  return id !== B.AIR && id !== B.MOTOR && id !== B.BATTERY_BOX && id !== B.WHEEL && id !== B.SWITCH && id !== B.PROXIMITY_SENSOR
}

export function isModelBlock(id: number) {
  return id === B.MOTOR || id === B.BATTERY_BOX || id === B.WHEEL || id === B.SWITCH || id === B.PROXIMITY_SENSOR
}

export type Bounds = readonly [number, number, number, number, number, number]
const FULL: Bounds = [0, 0, 0, 1, 1, 1]
const BOX_BOUNDS: Bounds = [0.04, 0, 0.08, 0.96, 0.36, 0.92]
const SWITCH_BOUNDS: Bounds = [0.01, 0.04, 0.03, 0.99, 0.38, 0.97]
const SENSOR_BOUNDS: Bounds = [0.04, 0.08, 0.04, 0.96, 0.92, 0.96]

export function blockBounds(id: number): Bounds {
  if (id === B.BATTERY_BOX) return BOX_BOUNDS
  if (id === B.SWITCH) return SWITCH_BOUNDS
  if (id === B.PROXIMITY_SENSOR) return SENSOR_BOUNDS
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
  | 'battery_box'
  | 'battery'
  | 'wheel'
  | 'switch'
  | 'proximity_sensor'
  | 'programming_tablet'
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
  category: Exclude<CategoryId, 'all'>
  block?: number
  color?: string
}

export const ITEMS: Record<ItemId, ItemDef> = {
  robotics: {
    name: 'Bloco de Robótica',
    description: 'Piso condutivo (92%). Conduz eletricidade entre faces conectadas.',
    category: 'blocks',
    block: B.ROBOTICS,
  },
  iron: { name: 'Bloco de Ferro', description: 'Estrutura metálica resistente. Condutividade: 90%.', category: 'blocks', block: B.IRON },
  wood: { name: 'Bloco de Madeira', description: 'Ótimo para protótipos. Isolante elétrico: 0%; não conduz corrente.', category: 'blocks', block: B.WOOD },
  component: {
    name: 'Bloco de Componente',
    description: 'Placa de circuito. Condutividade: 98%; conecte os fios às faces expostas.',
    category: 'blocks',
    block: B.COMPONENT,
  },
  aluminum: {
    name: 'Perfil de Alumínio',
    description: 'Perfil V-slot para chassis. Condutividade: 95%.',
    category: 'blocks',
    block: B.ALUMINUM,
  },
  gear: { name: 'Bloco de Engrenagem', description: 'Engrenagens de latão. Condutividade: 90%.', category: 'blocks', block: B.GEAR },
  wheel: { name: 'Roda de Arduino', description: 'Roda de borracha com aro amarelo de cinco raios e boa aderência para veículos robóticos.', category: 'motors', block: B.WHEEL },
  led: {
    name: 'LED',
    description: 'LED polarizado: ânodo (+) e cátodo (−). Só acende com a polaridade correta.',
    category: 'components',
    block: B.LED,
  },
  switch: {
    name: 'Interruptor elétrico',
    description: 'Interruptor de dois polos: ligado, fecha dois pares independentes; desligado, interrompe a corrente.',
    category: 'components',
    block: B.SWITCH,
  },
  proximity_sensor: {
    name: 'Sensor de proximidade',
    description: 'Detecta blocos à frente e só conduz energia quando a distância atende à condição programada. Shift + botão direito para girar.',
    category: 'components',
    block: B.PROXIMITY_SENSOR,
  },
  programming_tablet: {
    name: 'Tablet de Programação',
    description: 'Use na mão para abrir e editar a programação de componentes compatíveis.',
    category: 'tools',
  },
  motor: {
    name: 'Motor CC Pequeno',
    description: 'Motor CC polarizado: os dois terminais definem o sentido. Só move peças coladas e pode travar ao colidir.',
    category: 'motors',
    block: B.MOTOR,
  },
  wire: {
    name: 'Fio Amarelo',
    description: 'Conecte terminais expostos. A polaridade e a condutividade do circuito determinam se haverá energia.',
    category: 'wiring',
    color: '#fdd835',
  },
  glue: {
    name: 'Cola Quente',
    description: 'Botão direito numa face para colar blocos vizinhos.',
    category: 'tools',
  },
  paintbrush: {
    name: 'Pincel',
    description: 'Pinte blocos com a cor escolhida. Shift + botão direito abre a paleta; botão direito pinta.',
    category: 'tools',
  },
  battery_box: {
    name: 'Compartimento de Pilha AAA',
    description: '3 slots. Use pilhas nele; mão vazia retira.',
    category: 'power',
    block: B.BATTERY_BOX,
  },
  battery: {
    name: 'Pilha AAA',
    description: 'Botão direito no compartimento para inserir. 1,5 V.',
    category: 'power',
  },
  ...Object.fromEntries(COLOR_VARIANTS.flatMap((variant) => [
    [`colored_block_${variant.id}`, {
      name: `Bloco ${variant.name}`,
      description: `Bloco decorativo na cor ${variant.name.toLowerCase()}.`,
      category: 'blocks',
      block: B.COLOR_BLOCK,
      color: variant.color,
    }],
    [`wire_${variant.id}`, {
      name: `Fio ${variant.name}`,
      description: `Fio elétrico na cor ${variant.name.toLowerCase()}.`,
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
  'motor',
  'wire',
  'glue',
  'programming_tablet',
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
