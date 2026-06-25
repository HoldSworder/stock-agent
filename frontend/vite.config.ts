import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 构建产物输出到 backend/public，由 Fastify 托管
  build: {
    outDir: fileURLToPath(new URL('../backend/public', import.meta.url)),
    emptyOutDir: true,
  },
  // 后端地址：本地默认指向同机 8787；设 VITE_BACKEND=http://<NAS IP>:8787 可把
  // /api、/ws 代理到群晖常驻后端，实现本地仅起前端、与线上共用同一份实时数据。
  server: (() => {
    const backend = process.env.VITE_BACKEND ?? 'http://localhost:8787'
    return {
      port: 5373,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    }
  })(),
})
