import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0' , // Cho phép tất cả các địa chỉ IP truy cập
    port: 8888,
    strictPort: true,

  }
})