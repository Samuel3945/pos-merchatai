/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent:   '#9acee1',
        accent2:  '#95d4b3',
        warn:     '#ffd166',
        danger:   '#ef8b8b',
      },
    },
  },
  plugins: [],
};
