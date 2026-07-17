// Vite のアセット import (SVG はバンドル時に URL 文字列になる)
declare module '*.svg' {
  const src: string;
  export default src;
}
