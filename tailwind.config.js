/** @type {import('tailwindcss').Config} */
const ch = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:             ch('--tc-bg'),
        surface:        ch('--tc-surface'),
        'surface-2':    ch('--tc-surface-2'),
        'surface-3':    ch('--tc-surface-3'),
        line:           ch('--tc-line'),
        'line-strong':  ch('--tc-line-strong'),
        ink:            ch('--tc-ink'),
        'ink-2':        ch('--tc-ink-2'),
        'ink-3':        ch('--tc-ink-3'),
        'ink-4':        ch('--tc-ink-4'),
        primary:        ch('--tc-primary'),
        'primary-ink':  ch('--tc-primary-ink'),
        'primary-soft': ch('--tc-primary-soft'),
        accent:         ch('--tc-accent'),
        success:        ch('--tc-success'),
        'success-soft': ch('--tc-success-soft'),
        warn:           ch('--tc-warn'),
        'warn-soft':    ch('--tc-warn-soft'),
        danger:         ch('--tc-danger'),
        'danger-soft':  ch('--tc-danger-soft'),
        info:           ch('--tc-info'),
        'info-soft':    ch('--tc-info-soft'),
      },
      fontFamily: {
        sans:    ['"Inter Tight"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['"Fraunces"', '"Inter Tight"', 'Georgia', 'serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
      },
      boxShadow: {
        token2: 'var(--tc-shadow-2)',
        token3: 'var(--tc-shadow-3)',
      },
    },
  },
  plugins: [],
};
