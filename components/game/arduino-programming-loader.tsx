'use client'

import dynamic from 'next/dynamic'

export const ArduinoProgramming = dynamic(
  () => import('@/components/game/arduino-programming').then((module) => module.ArduinoProgramming),
  {
    ssr: false,
    loading: () => null,
  },
)
