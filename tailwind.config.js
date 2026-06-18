/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  // Scan the server's TS file (all HTML/className strings live there) so JIT
  // generates only the utilities actually used.
  content: ['./src/**/*.{ts,tsx}', './src/server.ts'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      colors: {
        border:     'hsl(var(--border))',
        input:      'hsl(var(--input))',
        ring:       'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary:    { DEFAULT: 'hsl(var(--primary))',    foreground: 'hsl(var(--primary-foreground))' },
        secondary:  { DEFAULT: 'hsl(var(--secondary))',  foreground: 'hsl(var(--secondary-foreground))' },
        muted:      { DEFAULT: 'hsl(var(--muted))',      foreground: 'hsl(var(--muted-foreground))' },
        accent:     { DEFAULT: 'hsl(var(--accent))',     foreground: 'hsl(var(--accent-foreground))' },
        card:       { DEFAULT: 'hsl(var(--card))',       foreground: 'hsl(var(--card-foreground))' },
        destructive:{ DEFAULT: 'hsl(var(--destructive))',foreground: 'hsl(var(--destructive-foreground))' },
        success:    { DEFAULT: 'hsl(var(--success))',    foreground: 'hsl(var(--success-foreground))' },
        warning:    { DEFAULT: 'hsl(var(--warning))',    foreground: 'hsl(var(--warning-foreground))' },
      },
    },
  },
};
