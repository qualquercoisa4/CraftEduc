export type SkinAccessory = 'none' | 'glasses' | 'goggles' | 'antenna' | 'cap' | 'headphones'

export interface SkinConfig {
  skin: string
  hair: string
  shirt: string
  pants: string
  shoes: string
  accessory: SkinAccessory
  accessoryColor: string
}

export interface RemotePlayerState {
  id: string
  name: string
  x: number
  y: number
  z: number
  yaw: number
  pitch?: number
  flying?: boolean
  sneaking?: boolean
  skin: SkinConfig
}
