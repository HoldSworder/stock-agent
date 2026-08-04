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
      // 固定端口：dev 启动前已通过 scripts/backend.sh freeport 5373 抢回端口，
      // strictPort 保证始终落在 5373（避免静默跳到 5374 导致地址漂移）。
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        // 大V配图由后端从 data/kol-images 托管，dev 下同样要代理过去才看得到图
        '/media': { target: backend, changeOrigin: true },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    }
  })(),
})
