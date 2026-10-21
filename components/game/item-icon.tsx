'use client'

import { ITEMS, type ItemId } from '@/lib/game/constants'
import { getItemIcon } from '@/lib/game/textures'

export function ItemIcon({ item, size }: { item: ItemId; size: string }) {
  return (
    // biome-ignore lint/performance/noImgElement: data-URL pixel icons generated at runtime
    <img
      src={getItemIcon(item) || '/placeholder.svg'}
      alt={ITEMS[item].name}
      draggable={false}
      className="pixelated pointer-events-none select-none"
      style={{ width: size, height: size }}
    />
  )
}
