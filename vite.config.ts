import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        pet: path.resolve(__dirname, 'pet.html'),
        chat: path.resolve(__dirname, 'chat.html'),
      },
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
          },
        },
      },
      preload: {
        input: {
          pet: path.resolve(__dirname, 'src/preload/pet.ts'),
          chat: path.resolve(__dirname, 'src/preload/chat.ts'),
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              output: {
                inlineDynamicImports: false,
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
})
