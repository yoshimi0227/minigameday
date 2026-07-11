import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-oxc';

// dashboard 専用の Vite 設定。`vp dev dashboard` / `vp build dashboard` はこの
// ディレクトリを root として実行されるため、ここに置く (ルートの vite.config.ts は
// CDK プロジェクト全体の test / lint 設定を持つ)。
export default defineConfig({
  plugins: [react()],
});
