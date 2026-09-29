import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 与 /health 代理到本机后端；生产构建后由 nginx 反代
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
