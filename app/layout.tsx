import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Pixelify_Sans, Press_Start_2P } from 'next/font/google'
import './globals.css'

const pixel = Pixelify_Sans({ subsets: ['latin'], variable: '--font-pixel', weight: ['400', '500', '600', '700'] })
const title = Press_Start_2P({ subsets: ['latin'], variable: '--font-title', weight: '400' })

export const metadata: Metadata = {
  title: 'CRAFTEDUC — ROBÓTICA',
  description:
    'Um jogo de blocos inspirado em Minecraft para aprender robótica: motores, LEDs, fios, cola quente e pilhas AAA num mundo plano infinito.',
  generator: 'v0.app',
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0b1a3a',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="pt-BR" className={`${pixel.variable} ${title.variable}`}>
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
