/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0D0B2E',
        navy2: '#1A1660',
        blue: '#2B2FD9',
        pink: '#FF2D78',
        bg: '#F7F8FF',
        muted: '#6B6B8A',
      },
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
