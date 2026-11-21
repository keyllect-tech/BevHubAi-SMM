/** @type {import('tailwindcss').Config} */
export default {
  content: {
    relative: true,
    files: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  },
  theme: {
    extend: {
      colors: {
        bg: '#0B0D0C',
        'bg-card': '#121614',
        'bg-elevated': '#1A1F1D',
        'border-default': '#232A27',
        accent: {
          DEFAULT: '#A3E635',
          dim: '#84CC16',
          dark: '#4D7C0F',
        },
        muted: '#9CA3A0',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.5rem',
      },
    },
  },
  plugins: [],
};
