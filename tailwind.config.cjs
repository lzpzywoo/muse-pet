/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./pet.html",
    "./chat.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        muse: {
          50: '#f0f5ff',
          100: '#e0ecff',
          200: '#c7dcff',
          300: '#9ec4ff',
          400: '#6da0ff',
          500: '#3d72fe',
          600: '#2551f5',
          700: '#1c3ee2',
          800: '#1d34b7',
          900: '#1d308f',
        }
      },
      animation: {
        'breathe': 'breathe 3s ease-in-out infinite',
        'bounce-subtle': 'bounceSubtle 2s ease-in-out infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1) translateY(0)' },
          '50%': { transform: 'scale(1.03) translateY(-4px)' },
        },
        bounceSubtle: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        }
      }
    },
  },
  plugins: [],
}
