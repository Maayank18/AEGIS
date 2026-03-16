/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: {
          900: '#0a0e1a',
          800: '#0d1224',
          700: '#111827',
          600: '#1a2234',
          500: '#1e2a3a',
        },
        aegis: {
          cyan:   '#00d4ff',
          green:  '#00ff88',
          orange: '#ff6b35',
          red:    '#ff3b5c',
          yellow: '#ffd700',
          purple: '#a855f7',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-fast':  'pulse 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink':       'blink 1s step-end infinite',
        'slide-in':    'slideIn 0.3s ease-out',
        'glow-pulse':  'glowPulse 2s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: 1 },
          '50%':      { opacity: 0 },
        },
        slideIn: {
          from: { transform: 'translateX(-10px)', opacity: 0 },
          to:   { transform: 'translateX(0)',     opacity: 1 },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 5px rgba(0, 212, 255, 0.3)' },
          '50%':      { boxShadow: '0 0 20px rgba(0, 212, 255, 0.8)' },
        },
      },
    },
  },
  plugins: [],
};