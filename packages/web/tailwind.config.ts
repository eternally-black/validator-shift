import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        term: {
          bg: '#0A0A0A',
          surface: '#0F0F0F',
          border: '#1A1A1A',
          green: '#00FF41',
          'green-dim': '#00CC34',
          'green-glow': '#00FF4133',
          red: '#FF3B30',
          amber: '#FFB800',
          text: '#E5E5E5',
          'text-dim': '#888',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
      boxShadow: {
        'term-glow': '0 0 12px #00FF4133',
      },
    },
  },
  plugins: [typography],
}

export default config
