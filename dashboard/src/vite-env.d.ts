// Vite のアセット import (SVG はバンドル時に URL 文字列になる)
declare module '*.svg' {
  const src: string;
  export default src;
}

// Vite が注入する環境フラグ (dev 判定に使う分だけ宣言)
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
