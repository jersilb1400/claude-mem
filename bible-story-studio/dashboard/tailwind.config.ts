import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          900: "#0f0f14",
          800: "#1a1a24",
          700: "#242432",
          600: "#2e2e40",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
