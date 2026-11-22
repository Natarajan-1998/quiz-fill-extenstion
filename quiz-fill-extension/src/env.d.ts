// Vite turns `import x from "file?url"` into the file's URL inside the build.
declare module "*?url" {
  const url: string;
  export default url;
}
